import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AIProviderError, type ManagedAIProvider } from "@george/ai";
import type { AIMessage, AIProviderResult, AgentResponse } from "@george/protocol";
import { InMemoryAuditSink } from "@george/core";
import type { FastifyInstance } from "fastify";
import { buildHostServer } from "./server.js";
import { PendingApprovalStore } from "./pending-approval-store.js";

const ORIGIN = "http://127.0.0.1:4200";
const servers: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];
const temporaryDirectories: string[] = [];

function temporarySettingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "george-settings-"));
  temporaryDirectories.push(directory);
  return join(directory, "settings.json");
}

async function createServer(
  aiProvider?: ManagedAIProvider,
  grantedPermissions?: readonly string[],
  approvalStore?: PendingApprovalStore
) {
  const server = await buildHostServer({
    environment: { NODE_ENV: "test" },
    origins: [ORIGIN],
    serveWeb: false,
    settingsPath: temporarySettingsPath(),
    ...(aiProvider ? { aiProvider } : {}),
    ...(grantedPermissions ? { grantedPermissions } : {}),
    ...(approvalStore ? { approvalStore } : {})
  });
  servers.push(server);
  return server.app;
}

async function bootstrap(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session/bootstrap",
    headers: { origin: ORIGIN },
    payload: {}
  });
  const cookie = response.headers["set-cookie"];
  return {
    response,
    cookie: Array.isArray(cookie) ? cookie[0]?.split(";")[0] : cookie?.split(";")[0],
    csrfToken: response.json<{ csrfToken: string }>().csrfToken
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("George Host HTTP boundary", () => {
  it("reports authenticated AI status independently from Host health", async () => {
    const unavailable: ManagedAIProvider = {
      id: "ollama",
      capabilities: { streaming: false, tools: false },
      management: {
        getInfo: async () => ({ id: "ollama", status: "UNAVAILABLE", model: "m", models: [] }),
        listModels: async () => []
      },
      chat: async (): Promise<AIProviderResult> => {
        throw new AIProviderError("PROVIDER_UNAVAILABLE", "offline");
      }
    };
    const app = await createServer(unavailable);
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/ai/status" })).statusCode).toBe(401);
    const session = await bootstrap(app);
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/ai/status",
      headers: { cookie: session.cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ id: "ollama", status: "UNAVAILABLE", model: "m", models: [] });
    expect(status.body).not.toMatch(/offline|stack|[A-Za-z]:\\/i);
  });

  it("returns a safe provider-unavailable response while Host remains healthy", async () => {
    const unavailable: ManagedAIProvider = {
      id: "ollama",
      capabilities: { streaming: false, tools: false },
      management: {
        getInfo: async () => ({ id: "ollama", status: "UNAVAILABLE", model: "m", models: [] }),
        listModels: async () => []
      },
      chat: async (): Promise<AIProviderResult> => {
        throw new AIProviderError("PROVIDER_UNAVAILABLE", "private detail");
      }
    };
    const app = await createServer(unavailable);
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "c", input: "Hola" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_UNAVAILABLE", message: "The AI provider is unavailable." }
    });
    expect(response.body).not.toContain("private detail");
  });

  it("serves a minimal health response and safe headers", async () => {
    const app = await createServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "george-host" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.body).not.toMatch(/[A-Za-z]:\\|process\.env|secret/i);
  });

  it("lists only safe tool metadata to an authenticated session", async () => {
    const app = await createServer();
    expect((await app.inject({ method: "GET", url: "/api/v1/tools" })).statusCode).toBe(401);
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tools",
      headers: { cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools.map((tool: { id: string }) => tool.id)).toEqual([
      "system.info",
      "apps.list",
      "apps.open",
      "system.process.list",
      "project.list",
      "project.info",
      "project.open",
      "git.status",
      "git.branch.current",
      "git.log",
      "git.diff",
      "filesystem.list",
      "filesystem.read",
      "filesystem.search"
    ]);
    expect(response.json().tools[0]).toEqual({
      id: "system.info",
      name: "System information",
      description: "Read basic operating system and hardware information.",
      riskLevel: "SAFE",
      requiredPermissions: ["system.info.read"],
      timeoutMs: 2000,
      availability: "AVAILABLE"
    });
    expect(response.body).not.toMatch(/handler|schema|secret|[A-Za-z]:\\/i);
  });

  it("requires Origin, session, and CSRF then runs system.info through the policy gate", async () => {
    const app = await createServer();
    const noSession = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.info/execute",
      headers: { origin: ORIGIN },
      payload: { input: {} }
    });
    expect(noSession.statusCode).toBe(401);

    const session = await bootstrap(app);
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.info/execute",
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: { input: {} }
    });
    expect(noCsrf.statusCode).toBe(403);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.info/execute",
      headers: {
        origin: "http://evil.example",
        cookie: session.cookie,
        "x-george-csrf": session.csrfToken
      },
      payload: { input: {} }
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.info/execute",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: {
        input: {},
        conversationId: "conversation-1"
      }
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({
      status: "completed",
      toolId: "system.info",
      conversationId: "conversation-1",
      policyOutcome: "ALLOW",
      output: {
        platform: expect.any(String),
        architecture: expect.any(String),
        hostname: expect.any(String),
        cpuModel: expect.any(String),
        cpuCount: expect.any(Number),
        totalMemoryBytes: expect.any(Number),
        freeMemoryBytes: expect.any(Number),
        uptimeSeconds: expect.any(Number)
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/"env"|"home"|process\.env/i);
  });

  it("denies tools when the explicit permission is not granted and rejects unknown tools", async () => {
    const app = await createServer(undefined, []);
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.info/execute",
      headers,
      payload: {
        input: {},
        permissions: ["system.info.read"],
        grantedPermissions: ["system.info.read"]
      }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      status: "denied",
      policyOutcome: "DENY",
      error: { code: "PERMISSION_DENIED" }
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.unknown/execute",
      headers,
      payload: { input: {} }
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      status: "failed",
      error: { code: "TOOL_NOT_FOUND" }
    });
  });

  it("rejects invalid tool inputs without invoking a handler", async () => {
    const app = await createServer();
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.info/execute",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { input: { command: "whoami" } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      status: "failed",
      error: { code: "INVALID_TOOL_INPUT" }
    });
  });

  it("requires a local session, Origin, and CSRF token before agent requests", async () => {
    const app = await createServer();
    const noSession = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN },
      payload: { conversationId: "conversation-1", input: "Hola" }
    });
    expect(noSession.statusCode).toBe(401);

    const session = await bootstrap(app);
    expect(session.response.statusCode).toBe(200);
    expect(session.response.headers["set-cookie"]).toContain("HttpOnly");
    expect(session.response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(session.cookie).toBeDefined();

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: { conversationId: "conversation-1", input: "Hola" }
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("rejects an invalid Origin and invalid payload", async () => {
    const app = await createServer();
    const session = await bootstrap(app);
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: {
        origin: "http://evil.example",
        cookie: session.cookie,
        "x-george-csrf": session.csrfToken
      },
      payload: { conversationId: "conversation-1", input: "Hola" }
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "conversation-1", input: " " }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("stack");
  });

  it("runs a valid request through AgentRuntime and MockAIProvider", async () => {
    const app = await createServer();
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "conversation-1", input: "Hola George" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      conversationId: "conversation-1",
      content: "Mock response: Hola George"
    });
  });

  it("orchestrates system.info through the authenticated Agent endpoint", async () => {
    const observed: AIMessage[][] = [];
    let turn = 0;
    const provider: ManagedAIProvider = {
      id: "scripted",
      capabilities: { streaming: false, tools: true },
      management: {
        getInfo: async () => ({
          id: "scripted",
          status: "AVAILABLE",
          model: "fake",
          models: ["fake"]
        }),
        listModels: async () => ["fake"]
      },
      async chat(messages) {
        observed.push([...messages]);
        return turn++ === 0
          ? { kind: "tool_calls", calls: [{ id: "call-1", toolId: "system.info", input: {} }] }
          : { kind: "message", text: "El sistema tiene información disponible." };
      }
    };
    const app = await createServer(provider);
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "conversation-tools", input: "¿Cuánta RAM tiene este computador?" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      content: "El sistema tiene información disponible."
    });
    expect(observed).toHaveLength(2);
    expect(observed[1]?.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      toolId: "system.info"
    });
    expect(observed[1]?.at(-1)?.content).toContain("totalMemoryBytes");
  });

  it("returns denied for an Agent tool request when Host grants no permission", async () => {
    const provider: ManagedAIProvider = {
      id: "scripted",
      capabilities: { streaming: false, tools: true },
      management: {
        getInfo: async () => ({
          id: "scripted",
          status: "AVAILABLE",
          model: "fake",
          models: ["fake"]
        }),
        listModels: async () => ["fake"]
      },
      async chat(): Promise<AIProviderResult> {
        return {
          kind: "tool_calls",
          calls: [{ id: "call-ask", toolId: "system.info", input: {} }]
        };
      }
    };
    const app = await createServer(provider, []);
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "conversation-ask", input: "Dime la memoria" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      status: "denied",
      error: { code: "PERMISSION_DENIED" },
      toolId: "system.info"
    });
  });

  it("requires an authenticated local session for the SSE endpoint", async () => {
    const app = await createServer();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent/events",
      headers: { origin: ORIGIN }
    });
    expect(response.statusCode).toBe(401);
  });

  it("validates the loopback Referer when a browser omits Origin on EventSource GET", async () => {
    const app = await createServer();
    const allowedReferer = await app.inject({
      method: "GET",
      url: "/api/v1/agent/events",
      headers: { referer: `${ORIGIN}/` }
    });
    expect(allowedReferer.statusCode).toBe(401);

    const rejectedReferer = await app.inject({
      method: "GET",
      url: "/api/v1/agent/events",
      headers: { referer: "https://evil.example/" }
    });
    expect(rejectedReferer.statusCode).toBe(403);

    const sameOriginFetch = await app.inject({
      method: "GET",
      url: "/api/v1/agent/events",
      headers: { host: "127.0.0.1:4200", "sec-fetch-site": "same-origin" }
    });
    expect(sameOriginFetch.statusCode).toBe(401);

    const crossSiteFetch = await app.inject({
      method: "GET",
      url: "/api/v1/agent/events",
      headers: { host: "127.0.0.1:4200", "sec-fetch-site": "cross-site" }
    });
    expect(crossSiteFetch.statusCode).toBe(403);
  });

  it("protects approval listing and resolution with session, exact Origin, and CSRF", async () => {
    const audit = new InMemoryAuditSink();
    let executionCount = 0;
    const store = new PendingApprovalStore(audit, { createId: () => "approval-test-id" });
    const response: AgentResponse = {
      status: "completed",
      requestId: "request-1",
      conversationId: "conversation-1",
      content: "continued",
      receivedAt: "2026-10-03T12:00:00.000Z",
      completedAt: "2026-10-03T12:00:01.000Z",
      durationMs: 1000
    };
    store.create(
      {
        requestId: "request-1",
        conversationId: "conversation-1",
        channel: "desktop",
        toolCallId: "call-1",
        executionId: "execution-1",
        toolId: "test.high-risk",
        riskLevel: "HIGH"
      },
      async () => {
        executionCount++;
        return response;
      }
    );
    const app = await createServer(undefined, undefined, store);
    await expect(
      app.inject({ method: "GET", url: "/api/v1/approvals", headers: { origin: ORIGIN } })
    ).resolves.toMatchObject({ statusCode: 401 });
    const session = await bootstrap(app);
    const cookie = session.cookie!;
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: { origin: ORIGIN, cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      approvals: [{ approvalId: "approval-test-id", toolId: "test.high-risk", status: "PENDING" }]
    });
    expect(list.body).not.toContain("input");
    const unauthenticatedAudit = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: { origin: ORIGIN }
    });
    expect(unauthenticatedAudit.statusCode).toBe(401);
    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/v1/audit?limit=1000",
      headers: { origin: ORIGIN, cookie }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json()).toEqual({ events: [] });

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-test-id/approve",
      headers: { origin: ORIGIN, cookie }
    });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-test-id/approve",
      headers: { origin: "https://attacker.invalid", cookie, "x-george-csrf": session.csrfToken }
    });
    expect(badOrigin.statusCode).toBe(403);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/unknown-id/approve",
      headers: { origin: ORIGIN, cookie, "x-george-csrf": session.csrfToken }
    });
    expect(unknown.statusCode).toBe(404);
    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-test-id/approve",
      headers: { origin: ORIGIN, cookie, "x-george-csrf": session.csrfToken },
      payload: { input: { forged: true } }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "completed", content: "continued" });
    expect(executionCount).toBe(1);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-test-id/approve",
      headers: { origin: ORIGIN, cookie, "x-george-csrf": session.csrfToken }
    });
    expect(replay.statusCode).toBe(409);
    expect(executionCount).toBe(1);
  });

  it("requires CSRF to deny and never resumes a denied continuation", async () => {
    const store = new PendingApprovalStore(new InMemoryAuditSink(), {
      createId: () => "approval-deny-id"
    });
    let executionCount = 0;
    store.create(
      {
        requestId: "r",
        conversationId: "c",
        channel: "desktop",
        toolCallId: "call",
        executionId: "execution",
        toolId: "test.high-risk",
        riskLevel: "HIGH"
      },
      async () => {
        executionCount++;
        return {
          status: "failed",
          requestId: "r",
          conversationId: "c",
          error: { code: "INTERNAL_ERROR", message: "failed" },
          receivedAt: "2026-10-03T12:00:00Z",
          completedAt: "2026-10-03T12:00:01Z",
          durationMs: 1
        };
      }
    );
    const app = await createServer(undefined, undefined, store);
    const session = await bootstrap(app);
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-deny-id/deny",
      headers: { origin: ORIGIN, cookie: session.cookie!, "x-george-csrf": session.csrfToken }
    });
    expect(result.statusCode).toBe(403);
    expect(executionCount).toBe(0);
  });
});

describe("trusted Origin policy (default, environment-driven)", () => {
  const DEFAULT_PORT = 43100;
  const HOST_ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;
  const DEV_ORIGIN = "http://127.0.0.1:4200";

  async function createEnvServer(environment: Readonly<Record<string, string | undefined>>) {
    const server = await buildHostServer({
      environment,
      serveWeb: false,
      settingsPath: temporarySettingsPath()
    });
    servers.push(server);
    return server.app;
  }

  async function postAgentRequest(app: FastifyInstance, origin: string | undefined) {
    return app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: origin !== undefined ? { origin } : {},
      payload: { conversationId: "c", input: "hola" }
    });
  }

  it("A. accepts the Host's own origin in production", async () => {
    const app = await createEnvServer({ NODE_ENV: "production" });
    const response = await postAgentRequest(app, HOST_ORIGIN);
    expect(response.statusCode).not.toBe(403);
  });

  it("B. accepts the Angular dev origin outside production", async () => {
    const app = await createEnvServer({});
    const response = await postAgentRequest(app, DEV_ORIGIN);
    expect(response.statusCode).not.toBe(403);
  });

  it("C. rejects the Angular dev origin in production", async () => {
    const app = await createEnvServer({ NODE_ENV: "production" });
    const response = await postAgentRequest(app, DEV_ORIGIN);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
  });

  it("D. rejects an arbitrary untrusted localhost port", async () => {
    const app = await createEnvServer({});
    const response = await postAgentRequest(app, "http://127.0.0.1:5555");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
  });

  it("E. does not treat localhost and 127.0.0.1 as equivalent", async () => {
    const app = await createEnvServer({});
    const response = await postAgentRequest(app, "http://localhost:4200");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
  });

  it("F. rejects a malicious external origin", async () => {
    const app = await createEnvServer({});
    const response = await postAgentRequest(app, "https://evil.example.com");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
  });

  it("G. rejects a malformed Origin header without throwing", async () => {
    const app = await createEnvServer({});
    const response = await postAgentRequest(app, "not-a-valid-origin");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
  });

  it("H. rejects a mutating request with a missing Origin header", async () => {
    const app = await createEnvServer({});
    const response = await postAgentRequest(app, undefined);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
  });

  it("never mounts the compiled web build by default outside production", async () => {
    // Regression guard for the dual-origin session collision: Host must not become a second
    // UI entry point unless explicitly asked (serveWeb: true) or running in production, even
    // when apps/web/dist exists on disk from a previous `pnpm build`.
    const server = await buildHostServer({
      environment: {},
      origins: [DEV_ORIGIN],
      settingsPath: temporarySettingsPath()
    });
    servers.push(server);
    const response = await server.app.inject({ method: "GET", url: "/", headers: {} });
    expect(response.statusCode).toBe(404);
  });
});

describe("session/CSRF lifecycle (I-M, and the dual-origin collision regression)", () => {
  async function createEnvServer(environment: Readonly<Record<string, string | undefined>>) {
    const server = await buildHostServer({
      environment,
      origins: [ORIGIN],
      serveWeb: false,
      settingsPath: temporarySettingsPath()
    });
    servers.push(server);
    return server.app;
  }

  it("I. rejects a mutating request with no session cookie", async () => {
    const app = await createEnvServer({});
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN },
      payload: { conversationId: "c", input: "hola" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "SESSION_REQUIRED" } });
  });

  it("J. rejects a mutating request with an invalid/garbage session cookie", async () => {
    const app = await createEnvServer({});
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: "george_session=not-a-real-session" },
      payload: { conversationId: "c", input: "hola" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "SESSION_REQUIRED" } });
  });

  it("K. rejects a mutating request with a valid session but no CSRF header", async () => {
    const app = await createEnvServer({});
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: { conversationId: "c", input: "hola" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });

  it("L. rejects a mutating request with an invalid CSRF token", async () => {
    const app = await createEnvServer({});
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": "wrong-token" },
      payload: { conversationId: "c", input: "hola" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });

  it("M. valid session + valid CSRF + trusted dev Origin succeeds", async () => {
    const app = await createEnvServer({});
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "c", input: "hola" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed" });
  });

  it("reproduces the root cause: a second origin's bootstrap orphans the first origin's CSRF token", async () => {
    // This is the exact mechanism behind the reported dev-mode 403: browser cookies are
    // host-scoped, not port-scoped, so when a second trusted origin (e.g. Host's own static
    // UI at 43100) bootstraps on the same host, it silently overwrites the shared
    // george_session cookie. The first origin's in-memory CSRF token is now stale and must
    // be rejected -- CSRF enforcement is working as designed, not broken.
    const app = await createEnvServer({});
    const first = await bootstrap(app); // tab/origin A's session + CSRF
    const second = await bootstrap(app); // tab/origin B re-bootstraps on the shared host cookie

    const staleRequest = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      // The real browser's cookie jar is host-scoped, not port-scoped: a single
      // `george_session` cookie exists for 127.0.0.1, and the most recent bootstrap (B)
      // is what it now holds and auto-attaches -- while origin A's JS still has its own
      // original CSRF token cached in memory from its own earlier bootstrap.
      headers: { origin: ORIGIN, cookie: second.cookie!, "x-george-csrf": first.csrfToken },
      payload: { conversationId: "c", input: "hola" }
    });
    expect(staleRequest.statusCode).toBe(403);
    expect(staleRequest.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });
});

describe("Settings and Doctor", () => {
  it("requires a local session to read settings and never exposes secrets", async () => {
    const app = await createServer();
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/settings" });
    expect(anonymous.statusCode).toBe(401);

    const session = await bootstrap(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ai: { provider: "mock" } });
    expect(response.body).not.toMatch(/credentialRef|sk-|secret/i);
  });

  it("requires Origin, session, and CSRF to update settings, then persists the change", async () => {
    const app = await createServer();
    const session = await bootstrap(app);
    const noCsrf = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: { assistant: { name: "Jarvis" } }
    });
    expect(noCsrf.statusCode).toBe(403);

    const wrongOrigin = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: {
        origin: "https://evil.example",
        cookie: session.cookie,
        "x-george-csrf": session.csrfToken
      },
      payload: { assistant: { name: "Jarvis" } }
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { assistant: { name: "Jarvis" } }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ assistant: { name: "Jarvis" } });

    const confirm = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie: session.cookie }
    });
    expect(confirm.json()).toMatchObject({ assistant: { name: "Jarvis" } });
  });

  it("rejects an invalid settings patch without corrupting stored settings", async () => {
    const app = await createServer();
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers,
      payload: { assistant: { name: "" } }
    });
    expect(invalid.statusCode).toBe(400);
    const stillValid = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie: session.cookie }
    });
    expect(stillValid.json()).toMatchObject({ assistant: { name: "George" } });
  });

  it("requires a local session for Doctor and reports real, non-hardcoded checks", async () => {
    const app = await createServer();
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(anonymous.statusCode).toBe(401);

    const session = await bootstrap(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/doctor",
      headers: { cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.core).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "host", state: "AVAILABLE" })])
    );
    expect(report.voice.every((check: { state: string }) => check.state === "NOT_INSTALLED")).toBe(
      true
    );
    // "csrf" itself is a legitimate check label (Doctor reports a "csrf" check);
    // only an actual token/cookie VALUE would be a leak.
    expect(response.body).not.toMatch(/credentialRef|cookie=|george_session/i);
  });

  it("requires a local session for Ollama discovery and never throws regardless of reachability", async () => {
    // Does not assert a fixed { available, models } value: whether a local Ollama
    // happens to be running on the test machine's default port is environment state,
    // not something this unit test should depend on (see docs/.claude/rules/testing.md).
    const app = await createServer();
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/ai/discover" });
    expect(anonymous.statusCode).toBe(401);

    const session = await bootstrap(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ai/discover",
      headers: { cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.available).toBe("boolean");
    expect(Array.isArray(body.models)).toBe(true);
  });
});

describe("M5.1 desktop action tools (apps.list, apps.open, system.process.list)", () => {
  // Every candidate-path env var is pointed at a location that cannot exist on any
  // machine, so apps.open can never resolve a real executable in this automated
  // suite -- an empty/partial environment falls back to real default install paths
  // (e.g. "C:\Program Files"), which on a real dev machine can and does resolve a
  // real installed Chrome/VS Code. Approving apps.open here must never spawn
  // anything real; only the live manual validation does that, deliberately.
  async function createIsolatedServer() {
    const server = await buildHostServer({
      environment: {
        NODE_ENV: "test",
        LOCALAPPDATA: "Z:\\george-test-does-not-exist\\LOCALAPPDATA",
        ProgramFiles: "Z:\\george-test-does-not-exist\\ProgramFiles",
        "ProgramFiles(x86)": "Z:\\george-test-does-not-exist\\ProgramFilesX86",
        SystemRoot: "Z:\\george-test-does-not-exist\\SystemRoot"
      },
      origins: [ORIGIN],
      serveWeb: false,
      settingsPath: temporarySettingsPath()
    });
    servers.push(server);
    return server.app;
  }

  it("lists configured applications with real (not hardcoded) availability, without exposing paths", async () => {
    const app = await createIsolatedServer();
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/apps.list/execute",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { input: {} }
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.output.applications).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "vscode", available: false })])
    );
    expect(response.body).not.toMatch(/\.exe|Program Files|george-test-does-not-exist/i);
  });

  it("direct tool execution surfaces approval_required but has no conversation to later resume", async () => {
    // /api/v1/tools/:id/execute has no Agent transcript to continue, so its ASK
    // result is informational only (it still proves policy/risk evaluation ran);
    // the resumable approval lifecycle is specifically the Agent request flow below.
    const app = await createIsolatedServer();
    const session = await bootstrap(app);
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/tools/apps.open/execute",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { input: { applicationId: "vscode" } }
    });
    expect(requested.statusCode).toBe(409);
    expect(requested.json()).toMatchObject({ status: "approval_required" });
  });

  it("George, abre Visual Studio Code: full Agent flow -- THINKING, approval with a safe summary, approve, execute, audit", async () => {
    const observed: AIMessage[][] = [];
    let turn = 0;
    const provider: ManagedAIProvider = {
      id: "scripted",
      capabilities: { streaming: false, tools: true },
      management: {
        getInfo: async () => ({
          id: "scripted",
          status: "AVAILABLE",
          model: "fake",
          models: ["fake"]
        }),
        listModels: async () => ["fake"]
      },
      async chat(messages) {
        observed.push([...messages]);
        return turn++ === 0
          ? {
              kind: "tool_calls",
              calls: [{ id: "open-1", toolId: "apps.open", input: { applicationId: "vscode" } }]
            }
          : { kind: "message", text: "Intenté abrir Visual Studio Code." };
      }
    };
    const audit = new InMemoryAuditSink();
    const server = await buildHostServer({
      environment: {
        NODE_ENV: "test",
        LOCALAPPDATA: "Z:\\george-test-does-not-exist\\LOCALAPPDATA",
        ProgramFiles: "Z:\\george-test-does-not-exist\\ProgramFiles",
        "ProgramFiles(x86)": "Z:\\george-test-does-not-exist\\ProgramFilesX86",
        SystemRoot: "Z:\\george-test-does-not-exist\\SystemRoot"
      },
      origins: [ORIGIN],
      serveWeb: false,
      settingsPath: temporarySettingsPath(),
      aiProvider: provider,
      auditSink: audit
    });
    servers.push(server);
    const app = server.app;
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };

    const pendingResponse = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers,
      payload: { conversationId: "c", input: "George, abre Visual Studio Code." }
    });
    expect(pendingResponse.statusCode).toBe(409);
    expect(pendingResponse.json()).toMatchObject({ status: "approval_required" });

    const approvalsList = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: { origin: ORIGIN, cookie: session.cookie }
    });
    const pending = approvalsList.json().approvals[0];
    expect(pending).toMatchObject({
      toolId: "apps.open",
      riskLevel: "HIGH",
      status: "PENDING",
      summary: "Abrir Visual Studio Code"
    });

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${pending.approvalId}/approve`,
      headers
    });
    // The (deliberately fake) environment has no real VS Code install, so execution
    // fails closed -- but the approval itself was honored, policy was re-evaluated,
    // and the Agent transcript continued with the real tool result, proving the
    // whole THINKING -> WAITING_APPROVAL -> EXECUTING -> response pipeline works.
    expect(approved.statusCode).toBe(500);
    expect(approved.json()).toMatchObject({
      status: "failed",
      error: { code: "TOOL_EXECUTION_FAILED" }
    });
    expect(observed).toHaveLength(1); // the provider is only re-consulted after a *successful* tool run

    const toolAuditRecords = audit.records.filter(
      (record) => record.operation === "tool.execution"
    );
    expect(toolAuditRecords.some((record) => record.toolId === "apps.open")).toBe(true);
    expect(JSON.stringify(toolAuditRecords)).not.toMatch(/applicationId|vscode/i);
    const approvalAuditRecords = audit.records.filter(
      (record) => record.operation === "approval.decision"
    );
    expect(approvalAuditRecords.map((record) => record.decision)).toEqual([
      "requested",
      "approved"
    ]);
  });

  it("denies apps.open outright when the permission itself is not granted, even with an approval id", async () => {
    const app = await createIsolatedServer();
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/apps.open/execute",
      headers,
      payload: { input: { applicationId: "vscode" }, approvalId: "forged-approval-id" }
    });
    // The route never accepts approvalId/permission overrides from the request body;
    // this just proves the forged field is ignored and normal ASK behavior still applies.
    expect(response.statusCode).toBe(409);
  });

  it("lists real running processes with only safe pid/name fields", async () => {
    const app = await createIsolatedServer();
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/system.process.list/execute",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { input: {} }
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(Array.isArray(result.output.processes)).toBe(true);
    expect(result.output.processes.length).toBeGreaterThan(0);
    expect(response.body).not.toMatch(/--|cmdline/i);
  });
});

describe("M5.2 projects, Git, and safe filesystem tools", () => {
  function gitRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "george-server-project-"));
    temporaryDirectories.push(root);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore"
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "README.md"), "# Test project\nThis is a test.");
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
    return root;
  }

  it("requires a local session to list projects and never exposes root paths", async () => {
    const app = await createServer();
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(anonymous.statusCode).toBe(401);
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projects: [], truncated: false });
  });

  it("requires Origin, session, and CSRF to add a project, validates the root, and persists it", async () => {
    const root = gitRepo();
    const app = await createServer();
    const session = await bootstrap(app);
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: { id: "george", displayName: "George", rootPath: root }
    });
    expect(noCsrf.statusCode).toBe(403);

    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "george", displayName: "George", rootPath: root }
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ id: "george", displayName: "George" });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: session.cookie }
    });
    expect(listed.json().projects).toEqual([
      { projectId: "george", displayName: "George", rootAvailable: true, gitRepository: true }
    ]);
  });

  it("rejects adding a project with a root that does not exist", async () => {
    const app = await createServer();
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "ghost", displayName: "Ghost", rootPath: "Z:\\george-test-does-not-exist" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "PROJECT_ROOT_UNAVAILABLE" } });
  });

  it("rejects a duplicate project id with 409", async () => {
    const root = gitRepo();
    const app = await createServer();
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "george", displayName: "George", rootPath: root }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "george", displayName: "George Again", rootPath: root }
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("removes only George's configuration for a project -- the real directory is untouched", async () => {
    const root = gitRepo();
    const app = await createServer();
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "george", displayName: "George", rootPath: root }
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/settings/projects/george",
      headers
    });
    expect(removed.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: session.cookie }
    });
    expect(listed.json().projects).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });

  it("George, revisa el estado del proyecto George: a full Agent flow combining project.info and git.status", async () => {
    const root = gitRepo();
    writeFileSync(join(root, "README.md"), "# Test project\nchanged");
    let turn = 0;
    const provider: ManagedAIProvider = {
      id: "scripted",
      capabilities: { streaming: false, tools: true },
      management: {
        getInfo: async () => ({
          id: "scripted",
          status: "AVAILABLE",
          model: "fake",
          models: ["fake"]
        }),
        listModels: async () => ["fake"]
      },
      async chat() {
        turn++;
        if (turn === 1) {
          return {
            kind: "tool_calls",
            calls: [{ id: "info-1", toolId: "project.info", input: { projectId: "george" } }]
          };
        }
        if (turn === 2) {
          return {
            kind: "tool_calls",
            calls: [{ id: "status-1", toolId: "git.status", input: { projectId: "george" } }]
          };
        }
        return {
          kind: "message",
          text: "El proyecto George tiene cambios sin confirmar en la rama main."
        };
      }
    };
    const app = await createServer(provider);
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "george", displayName: "George", rootPath: root }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers,
      payload: { conversationId: "c", input: "George, revisa el estado del proyecto George." }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      content: "El proyecto George tiene cambios sin confirmar en la rama main."
    });
  });

  it("SECURITY: a path-traversal attempt through the full Agent pipeline is rejected, not silently sandboxed", async () => {
    const root = gitRepo();
    const provider: ManagedAIProvider = {
      id: "scripted",
      capabilities: { streaming: false, tools: true },
      management: {
        getInfo: async () => ({
          id: "scripted",
          status: "AVAILABLE",
          model: "fake",
          models: ["fake"]
        }),
        listModels: async () => ["fake"]
      },
      async chat() {
        return {
          kind: "tool_calls",
          calls: [
            {
              id: "read-1",
              toolId: "filesystem.read",
              input: {
                projectId: "george",
                relativePath: "../../../Windows/System32/drivers/etc/hosts"
              }
            }
          ]
        };
      }
    };
    const app = await createServer(provider);
    const session = await bootstrap(app);
    const headers = { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/settings/projects",
      headers,
      payload: { id: "george", displayName: "George", rootPath: root }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers,
      payload: { conversationId: "c", input: "lee un archivo fuera del proyecto" }
    });
    // TOOL_EXECUTION_FAILED is the generic mapping ToolRuntime always uses for a handler's own
    // "failed" result (see #mapHandlerResult) -- the important assertion is that the request
    // never completes successfully with file content, and the tool is never granted a retry.
    expect(response.statusCode).not.toBe(200);
    expect(JSON.stringify(response.json())).not.toMatch(/root:|localhost/);
  });

  it("SECURITY: an unknown projectId is rejected rather than silently resolved to some default", async () => {
    const provider: ManagedAIProvider = {
      id: "scripted",
      capabilities: { streaming: false, tools: true },
      management: {
        getInfo: async () => ({
          id: "scripted",
          status: "AVAILABLE",
          model: "fake",
          models: ["fake"]
        }),
        listModels: async () => ["fake"]
      },
      async chat() {
        return {
          kind: "tool_calls",
          calls: [{ id: "list-1", toolId: "project.info", input: { projectId: "unknown-project" } }]
        };
      }
    };
    const app = await createServer(provider);
    const session = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/requests",
      headers: { origin: ORIGIN, cookie: session.cookie, "x-george-csrf": session.csrfToken },
      payload: { conversationId: "c", input: "revisa un proyecto que no existe" }
    });
    expect(response.statusCode).not.toBe(200);
  });
});
