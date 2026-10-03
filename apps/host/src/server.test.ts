import { afterEach, describe, expect, it } from "vitest";
import { AIProviderError, type ManagedAIProvider } from "@george/ai";
import type { AIMessage, AIProviderResult } from "@george/protocol";
import type { FastifyInstance } from "fastify";
import { buildHostServer } from "./server.js";

const ORIGIN = "http://127.0.0.1:4200";
const servers: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

async function createServer(
  aiProvider?: ManagedAIProvider,
  grantedPermissions?: readonly string[]
) {
  const server = await buildHostServer({
    environment: { NODE_ENV: "test" },
    origins: [ORIGIN],
    serveWeb: false,
    ...(aiProvider ? { aiProvider } : {}),
    ...(grantedPermissions ? { grantedPermissions } : {})
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
    expect(response.json()).toEqual({
      tools: [
        {
          id: "system.info",
          name: "System information",
          description: "Read basic operating system and hardware information.",
          riskLevel: "SAFE",
          requiredPermissions: ["system.info.read"],
          timeoutMs: 2000,
          availability: "AVAILABLE"
        }
      ]
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
      payload: { input: {} }
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
});
