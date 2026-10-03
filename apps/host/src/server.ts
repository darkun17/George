import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { AgentRuntime, InMemoryAuditSink } from "@george/core";
import { createAIProvider, type ManagedAIProvider } from "@george/ai";
import { loadAIConfiguration, loadHostConfiguration } from "@george/config";
import { DefaultPolicyEngine } from "@george/policy";
import { InMemoryToolRegistry, ToolRuntime, systemInfoTool } from "@george/tools-core";
import { SessionStore, readSessionCookie } from "./session-store.js";
import { SseAgentEventSink } from "./sse-event-sink.js";

const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const MAX_AGENT_INPUT_LENGTH = 4000;

export interface HostServerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly origins?: readonly string[];
  readonly webRoot?: string;
  readonly serveWeb?: boolean;
  readonly aiProvider?: ManagedAIProvider;
  readonly grantedPermissions?: readonly string[];
}

function expectedOrigins(
  port: number,
  environment: Readonly<Record<string, string | undefined>>
): Set<string> {
  const origins = new Set([`http://127.0.0.1:${port}`]);
  const configured = environment["GEORGE_WEB_ORIGIN"];
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error("GEORGE_WEB_ORIGIN must be a local HTTP origin.");
    }
    if (
      url.origin !== configured ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("GEORGE_WEB_ORIGIN must be an exact loopback HTTP origin.");
    }
    origins.add(configured);
  } else if (environment["NODE_ENV"] !== "production") origins.add("http://127.0.0.1:4200");
  return origins;
}

function setSecurityHeaders(reply: { header: (name: string, value: string) => unknown }): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
}

export async function buildHostServer(options: HostServerOptions = {}): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  const environment = options.environment ?? process.env;
  const config = loadHostConfiguration(environment);
  const aiConfig = loadAIConfiguration(environment);
  const aiProvider = options.aiProvider ?? createAIProvider(aiConfig);
  const origins = new Set(options.origins ?? expectedOrigins(config.host.port, environment));
  for (const origin of origins) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error("Allowed Host origins must be exact loopback HTTP origins.");
    }
    if (
      parsedOrigin.origin !== origin ||
      parsedOrigin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsedOrigin.hostname)
    ) {
      throw new Error("Allowed Host origins must be exact loopback HTTP origins.");
    }
  }
  const sessions = new SessionStore();
  const eventSink = new SseAgentEventSink();
  const auditSink = new InMemoryAuditSink();
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.register(systemInfoTool);
  const toolRuntime = new ToolRuntime({
    registry: toolRegistry,
    policyEngine: new DefaultPolicyEngine(),
    auditSink
  });
  const grantedPermissions = options.grantedPermissions ?? config.tools.grantedPermissions;
  const runtime = new AgentRuntime({
    aiProvider,
    eventSink,
    auditSink,
    toolRuntime,
    grantedPermissions
  });
  const sseResponses = new Set<ServerResponse>();

  const app = fastify({
    logger: environment["NODE_ENV"] !== "test",
    bodyLimit: 16 * 1024,
    routerOptions: { maxParamLength: 100 },
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
    serverFactory: (handler, serverOptions) =>
      createServer({ ...serverOptions, maxHeaderSize: 8192, headersTimeout: 10_000 }, handler)
  });

  app.setErrorHandler((error, request, reply) => {
    const rawStatusCode = (error as { readonly statusCode?: unknown }).statusCode;
    const statusCode =
      typeof rawStatusCode === "number" && rawStatusCode >= 400 && rawStatusCode < 500
        ? rawStatusCode
        : 500;
    request.log.error(
      { requestId: request.id, code: statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "HOST_ERROR" },
      "Host request failed"
    );
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "HOST_ERROR",
        message:
          statusCode === 413
            ? "La solicitud es demasiado grande."
            : "George Host no pudo completar la solicitud."
      }
    });
  });

  app.addHook("onRequest", async (_request, reply) => setSecurityHeaders(reply));

  const validateOrigin = (origin: string | undefined): boolean =>
    origin !== undefined && origins.has(origin);
  const validateStreamOrigin = (
    origin: string | undefined,
    referer: string | undefined,
    fetchSite: string | undefined,
    host: string | undefined
  ): boolean => {
    if (origin !== undefined) return validateOrigin(origin);
    if (referer) {
      try {
        return origins.has(new URL(referer).origin);
      } catch {
        return false;
      }
    }
    if (fetchSite !== "same-origin" || !host) return false;
    try {
      return origins.has(new URL(`http://${host}`).origin);
    } catch {
      return false;
    }
  };
  const getSession = (cookie: string | undefined) => sessions.validate(readSessionCookie(cookie));

  app.get("/api/v1/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { status: "ok", service: "george-host", version: "0.1.0" };
  });

  app.get("/api/v1/ai/status", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return reply
        .code(401)
        .send({ error: { code: "SESSION_REQUIRED", message: "Inicia una sesión local." } });
    }
    reply.header("Cache-Control", "no-store");
    return aiProvider.management.getInfo();
  });

  app.get("/api/v1/ai/models", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return reply
        .code(401)
        .send({ error: { code: "SESSION_REQUIRED", message: "Inicia una sesión local." } });
    }
    reply.header("Cache-Control", "no-store");
    try {
      return { models: await aiProvider.management.listModels() };
    } catch {
      return reply.code(503).send({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "No se pudo consultar el catálogo de modelos."
        }
      });
    }
  });

  app.get("/api/v1/tools", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return reply
        .code(401)
        .send({ error: { code: "SESSION_REQUIRED", message: "Inicia una sesión local." } });
    }
    reply.header("Cache-Control", "no-store");
    return { tools: toolRegistry.listMetadata() };
  });

  app.post<{
    Params: { id: string };
    Body: { input?: unknown; conversationId?: unknown };
  }>("/api/v1/tools/:id/execute", async (request, reply) => {
    if (!validateOrigin(request.headers.origin)) {
      return reply
        .code(403)
        .send({ error: { code: "ORIGIN_REJECTED", message: "Origen no permitido." } });
    }
    const cookieHeader = request.headers.cookie;
    const session = getSession(
      Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader
    );
    if (!session) {
      return reply
        .code(401)
        .send({ error: { code: "SESSION_REQUIRED", message: "Inicia una sesión local." } });
    }
    const csrfHeader = request.headers["x-george-csrf"];
    if (!sessions.validateCsrf(session, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader)) {
      return reply.code(403).send({
        error: { code: "CSRF_REJECTED", message: "La solicitud no superó la validación CSRF." }
      });
    }
    const body = request.body;
    const validOptionalId = (value: unknown): value is string | undefined =>
      value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 128);
    if (typeof body !== "object" || body === null || !validOptionalId(body.conversationId)) {
      return reply.code(400).send({
        error: { code: "INVALID_TOOL_INPUT", message: "La solicitud de herramienta no es válida." }
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 125_000);
    request.raw.once("aborted", () => controller.abort());
    const cancelWhenDisconnected = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once("close", cancelWhenDisconnected);
    try {
      reply.header("Cache-Control", "no-store");
      const result = await toolRuntime.execute({
        executionId: randomUUID(),
        toolId: request.params.id,
        input: body.input,
        channel: "desktop",
        grantedPermissions,
        signal: controller.signal,
        ...(body.conversationId ? { conversationId: body.conversationId } : {})
      });
      const statusCode =
        result.status === "completed"
          ? 200
          : result.status === "denied"
            ? 403
            : result.status === "approval_required"
              ? 409
              : result.status === "timed_out" || result.status === "cancelled"
                ? 408
                : result.error.code === "TOOL_NOT_FOUND"
                  ? 404
                  : result.error.code === "INVALID_TOOL_INPUT"
                    ? 400
                    : 500;
      return reply.code(statusCode).send(result);
    } finally {
      clearTimeout(timeout);
      reply.raw.off("close", cancelWhenDisconnected);
    }
  });

  app.post("/api/v1/session/bootstrap", async (request, reply) => {
    if (!validateOrigin(request.headers.origin)) {
      return reply
        .code(403)
        .send({ error: { code: "ORIGIN_REJECTED", message: "Origen no permitido." } });
    }
    const session = sessions.create(request.ip);
    if (!session) {
      return reply.code(429).send({
        error: { code: "SESSION_LIMIT", message: "No se pudo iniciar una sesión local." }
      });
    }
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Set-Cookie",
      `george_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`
    );
    return { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  app.post<{ Body: { conversationId?: unknown; input?: unknown } }>(
    "/api/v1/agent/requests",
    async (request, reply) => {
      if (!validateOrigin(request.headers.origin)) {
        return reply
          .code(403)
          .send({ error: { code: "ORIGIN_REJECTED", message: "Origen no permitido." } });
      }
      const cookieHeader = request.headers.cookie;
      const session = getSession(
        Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader
      );
      if (!session) {
        return reply
          .code(401)
          .send({ error: { code: "SESSION_REQUIRED", message: "Inicia una sesión local." } });
      }
      const csrfHeader = request.headers["x-george-csrf"];
      if (!sessions.validateCsrf(session, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader)) {
        return reply.code(403).send({
          error: { code: "CSRF_REJECTED", message: "La solicitud no superó la validación CSRF." }
        });
      }
      const body = request.body;
      if (
        typeof body !== "object" ||
        body === null ||
        typeof body.input !== "string" ||
        body.input.trim().length === 0 ||
        body.input.length > MAX_AGENT_INPUT_LENGTH ||
        typeof body.conversationId !== "string" ||
        body.conversationId.trim().length === 0 ||
        body.conversationId.length > 128
      ) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_REQUEST", message: "La solicitud no es válida." } });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 130_000);
      request.raw.once("aborted", () => controller.abort());
      const cancelWhenDisconnected = (): void => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once("close", cancelWhenDisconnected);
      try {
        reply.header("Cache-Control", "no-store");
        const result = await runtime.run(
          {
            conversationId: body.conversationId,
            channel: "desktop",
            input: body.input,
            receivedAt: new Date().toISOString()
          },
          { signal: controller.signal }
        );
        if (result.status === "completed") return reply.send(result);
        if (result.status === "approval_required") return reply.code(409).send(result);
        if (result.status === "denied") return reply.code(403).send(result);
        const statusCode =
          result.error.code === "CANCELLED"
            ? 408
            : result.error.code === "PROVIDER_UNAVAILABLE"
              ? 503
              : result.error.code === "PROVIDER_ERROR"
                ? 502
                : result.error.code === "INVALID_REQUEST"
                  ? 400
                  : 500;
        return reply.code(statusCode).send(result);
      } finally {
        clearTimeout(timeout);
        reply.raw.off("close", cancelWhenDisconnected);
      }
    }
  );

  app.get("/api/v1/agent/events", async (request, reply) => {
    if (
      !validateStreamOrigin(
        request.headers.origin,
        request.headers.referer,
        request.headers["sec-fetch-site"],
        request.headers.host
      )
    ) {
      return reply
        .code(403)
        .send({ error: { code: "ORIGIN_REJECTED", message: "Origen no permitido." } });
    }
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return reply
        .code(401)
        .send({ error: { code: "SESSION_REQUIRED", message: "Inicia una sesión local." } });
    }
    if (sseResponses.size >= 8) {
      return reply.code(429).send({
        error: { code: "STREAM_LIMIT", message: "Se alcanzó el límite de sesiones de actividad." }
      });
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
    });
    response.write(": George event stream connected\n\n");
    sseResponses.add(response);
    const unsubscribe = eventSink.subscribe((event) => {
      if (!response.destroyed) response.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": keep-alive\n\n");
    }, 20_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      sseResponses.delete(response);
    };
    response.once("close", cleanup);
  });

  const webRoot = options.webRoot ?? new URL("../../web/dist/browser/", import.meta.url);
  const resolvedWebRoot = webRoot instanceof URL ? fileURLToPath(webRoot) : webRoot;
  if (options.serveWeb !== false && existsSync(resolvedWebRoot)) {
    await app.register(fastifyStatic, {
      root: resolvedWebRoot,
      prefix: "/",
      wildcard: false,
      decorateReply: true
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        reply.header("Cache-Control", "no-cache");
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No encontrado." } });
    });
  }

  const close = async (): Promise<void> => {
    for (const response of sseResponses) response.end();
    sseResponses.clear();
    await app.close();
  };

  return { app, close };
}

export function createConversationId(): string {
  return randomUUID();
}
