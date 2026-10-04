import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, InMemoryAuditSink } from "@george/core";
import type { AuditSink } from "@george/protocol";
import { createAIProvider, OllamaProvider, type ManagedAIProvider } from "@george/ai";
import {
  aiConfigurationSchema,
  loadAIConfiguration,
  loadDefaultAssistantProfile,
  loadHostConfiguration,
  PermissionResolver,
  type AIConfiguration
} from "@george/config";
import { DefaultPolicyEngine } from "@george/policy";
import {
  ApplicationRegistry,
  InMemoryToolRegistry,
  ToolRuntime,
  createAppsListTool,
  createAppsOpenTool,
  systemInfoTool,
  systemProcessListTool
} from "@george/tools-core";
import { SessionStore, readSessionCookie } from "./session-store.js";
import { SseAgentEventSink } from "./sse-event-sink.js";
import { PendingApprovalStore } from "./pending-approval-store.js";
import { getAuditDatabasePath, SqliteAuditSink } from "./sqlite-audit-sink.js";
import { getAppDataDir } from "./app-data.js";
import { SettingsStore, type SettingsPatch } from "./settings-store.js";
import { buildDoctorReport } from "./doctor.js";

const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const MAX_AGENT_INPUT_LENGTH = 4000;

export interface HostServerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly origins?: readonly string[];
  readonly webRoot?: string;
  readonly serveWeb?: boolean;
  readonly aiProvider?: ManagedAIProvider;
  readonly grantedPermissions?: readonly string[];
  readonly deniedPermissions?: readonly string[];
  readonly auditSink?: AuditSink;
  readonly auditDatabasePath?: string;
  readonly approvalStore?: PendingApprovalStore;
  readonly settingsStore?: SettingsStore;
  readonly settingsPath?: string;
}

/**
 * Builds the effective AI provider configuration: persisted settings (if any)
 * take priority over environment variables, but fall back to the env-derived
 * configuration whenever the persisted selection is incomplete or invalid --
 * a stale settings file must never stop Host from starting.
 */
function resolveEffectiveAIConfig(
  envConfig: AIConfiguration,
  settingsAi: {
    readonly provider: "mock" | "ollama";
    readonly ollama?: { readonly model: string } | undefined;
  }
): AIConfiguration {
  if (settingsAi.provider === "mock") return { provider: "mock" };
  const baseUrl = envConfig.provider === "ollama" ? envConfig.ollama.baseUrl : undefined;
  const candidate = {
    provider: "ollama" as const,
    ollama: { model: settingsAi.ollama?.model ?? "", ...(baseUrl ? { baseUrl } : {}) }
  };
  const parsed = aiConfigurationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : envConfig;
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

/**
 * Logs the safe rejection reason for a protected request without ever logging the
 * cookie, session token, CSRF token, or any header/body value that produced the
 * rejection. The HTTP response body already carries the same safe code to the caller.
 */
function rejectRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: "ORIGIN_REJECTED" | "SESSION_REQUIRED" | "CSRF_REJECTED",
  message: string
): FastifyReply {
  request.log.warn({ requestId: request.id, code }, "George rejected a protected request");
  return reply.code(statusCode).send({ error: { code, message } });
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
  const envAiConfig = loadAIConfiguration(environment);
  const settingsStore =
    options.settingsStore ??
    new SettingsStore(
      options.settingsPath ?? join(getAppDataDir(environment), "settings.json"),
      loadDefaultAssistantProfile(environment)
    );
  const settings = settingsStore.get();
  const aiConfig = resolveEffectiveAIConfig(envAiConfig, settings.ai);
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
  const ownsAuditSink = options.auditSink === undefined;
  const auditSink =
    options.auditSink ??
    (environment["NODE_ENV"] === "test"
      ? new InMemoryAuditSink()
      : new SqliteAuditSink(options.auditDatabasePath ?? getAuditDatabasePath(environment)));
  const approvalStore = options.approvalStore ?? new PendingApprovalStore(auditSink);
  const applicationRegistry = new ApplicationRegistry(environment);
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.register(systemInfoTool);
  toolRegistry.register(createAppsListTool(applicationRegistry));
  toolRegistry.register(createAppsOpenTool(applicationRegistry));
  toolRegistry.register(systemProcessListTool);
  const toolRuntime = new ToolRuntime({
    registry: toolRegistry,
    policyEngine: new DefaultPolicyEngine(),
    auditSink
  });
  const permissionResolver = new PermissionResolver(
    options.grantedPermissions ?? config.tools.grantedPermissions,
    options.deniedPermissions ?? config.tools.deniedPermissions
  );
  const environmentName = environment["NODE_ENV"] === "production" ? "production" : "development";
  const permissions = permissionResolver.resolve("desktop", environmentName);
  const grantedPermissions = permissions.grantedPermissions;
  const runtime = new AgentRuntime({
    aiProvider,
    eventSink,
    auditSink,
    toolRuntime,
    grantedPermissions,
    deniedPermissions: permissions.deniedPermissions,
    permissionResolver: (channel) => permissionResolver.resolve(channel, environmentName),
    approvalCoordinator: approvalStore
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
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    reply.header("Cache-Control", "no-store");
    return aiProvider.management.getInfo();
  });

  app.get("/api/v1/ai/models", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
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

  app.get("/api/v1/ai/discover", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    reply.header("Cache-Control", "no-store");
    const baseUrl =
      envAiConfig.provider === "ollama" ? envAiConfig.ollama.baseUrl : "http://127.0.0.1:11434";
    try {
      const models = await new OllamaProvider({ baseUrl, model: "discovery-only" }).listModels();
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  });

  app.get("/api/v1/settings", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    reply.header("Cache-Control", "no-store");
    return settingsStore.get();
  });

  app.patch<{ Body: unknown }>("/api/v1/settings", async (request, reply) => {
    if (!validateOrigin(request.headers.origin)) {
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
    }
    const cookieHeader = request.headers.cookie;
    const session = getSession(
      Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader
    );
    if (!session) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    const csrfHeader = request.headers["x-george-csrf"];
    if (!sessions.validateCsrf(session, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader)) {
      return rejectRequest(
        request,
        reply,
        403,
        "CSRF_REJECTED",
        "La solicitud no superó la validación CSRF."
      );
    }
    reply.header("Cache-Control", "no-store");
    try {
      const updated = settingsStore.update((request.body ?? {}) as SettingsPatch);
      return updated;
    } catch {
      return reply.code(400).send({
        error: { code: "INVALID_SETTINGS", message: "La configuración enviada no es válida." }
      });
    }
  });

  app.get("/api/v1/doctor", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    reply.header("Cache-Control", "no-store");
    return buildDoctorReport({
      aiProvider,
      settings: settingsStore.get(),
      sessionCount: () => sessions.count(),
      pendingApprovalCount: () => approvalStore.list().length,
      auditHealthy: () => {
        if (!(auditSink instanceof SqliteAuditSink)) return true;
        try {
          auditSink.recent(1);
          return true;
        } catch {
          return false;
        }
      },
      trustedOriginCount: () => origins.size,
      appVersion: "0.1.0",
      dataDirectory: getAppDataDir(environment)
    });
  });

  app.get("/api/v1/tools", async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    reply.header("Cache-Control", "no-store");
    return { tools: toolRegistry.listMetadata() };
  });

  app.get("/api/v1/approvals", async (request, reply) => {
    if (
      !validateStreamOrigin(
        request.headers.origin,
        request.headers.referer,
        request.headers["sec-fetch-site"],
        request.headers.host
      )
    ) {
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
    }
    const cookie = request.headers.cookie;
    if (!getSession(Array.isArray(cookie) ? cookie.join("; ") : cookie)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    reply.header("Cache-Control", "no-store");
    return { approvals: approvalStore.list() };
  });

  app.get("/api/v1/audit", async (request, reply) => {
    if (
      !validateStreamOrigin(
        request.headers.origin,
        request.headers.referer,
        request.headers["sec-fetch-site"],
        request.headers.host
      )
    ) {
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
    }
    const cookie = request.headers.cookie;
    if (!getSession(Array.isArray(cookie) ? cookie.join("; ") : cookie)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    const query =
      request.query && typeof request.query === "object"
        ? (request.query as Record<string, unknown>)
        : {};
    const value = query["limit"];
    const limit = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : 50;
    reply.header("Cache-Control", "no-store");
    return { events: auditSink instanceof SqliteAuditSink ? auditSink.recent(limit) : [] };
  });

  const resolveApproval = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    decision: "approve" | "deny"
  ) => {
    if (!validateOrigin(request.headers.origin))
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
    const cookie = request.headers.cookie;
    const session = getSession(Array.isArray(cookie) ? cookie.join("; ") : cookie);
    if (!session)
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    const csrf = request.headers["x-george-csrf"];
    if (!sessions.validateCsrf(session, Array.isArray(csrf) ? csrf[0] : csrf))
      return rejectRequest(
        request,
        reply,
        403,
        "CSRF_REJECTED",
        "La solicitud no superó la validación CSRF."
      );
    reply.header("Cache-Control", "no-store");
    const result =
      decision === "approve"
        ? await approvalStore.approve(request.params.id)
        : approvalStore.deny(request.params.id);
    if (result.status === "not_found")
      return reply.code(404).send({
        error: { code: "APPROVAL_NOT_FOUND", message: "La aprobación ya no está disponible." }
      });
    if (result.status === "expired")
      return reply
        .code(410)
        .send({ error: { code: "APPROVAL_EXPIRED", message: "La aprobación expiró." } });
    if (result.status === "already_resolved")
      return reply
        .code(409)
        .send({ error: { code: "APPROVAL_RESOLVED", message: "La aprobación ya fue resuelta." } });
    if (result.status !== "resolved")
      return reply.code(503).send({
        error: { code: "APPROVAL_UNAVAILABLE", message: "La aprobación no pudo resolverse." }
      });
    const response = result.response;
    return reply
      .code(
        response.status === "approval_required"
          ? 202
          : response.status === "denied"
            ? 403
            : response.status === "failed"
              ? 500
              : 200
      )
      .send(response);
  };

  app.post<{ Params: { id: string } }>("/api/v1/approvals/:id/approve", (request, reply) =>
    resolveApproval(request, reply, "approve")
  );
  app.post<{ Params: { id: string } }>("/api/v1/approvals/:id/deny", (request, reply) =>
    resolveApproval(request, reply, "deny")
  );

  app.post<{
    Params: { id: string };
    Body: { input?: unknown; conversationId?: unknown };
  }>("/api/v1/tools/:id/execute", async (request, reply) => {
    if (!validateOrigin(request.headers.origin)) {
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
    }
    const cookieHeader = request.headers.cookie;
    const session = getSession(
      Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader
    );
    if (!session) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
    }
    const csrfHeader = request.headers["x-george-csrf"];
    if (!sessions.validateCsrf(session, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader)) {
      return rejectRequest(
        request,
        reply,
        403,
        "CSRF_REJECTED",
        "La solicitud no superó la validación CSRF."
      );
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
        deniedPermissions: permissions.deniedPermissions,
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
      const { approvalHandle: _privateApprovalHandle, ...safeResult } = result;
      void _privateApprovalHandle;
      return reply.code(statusCode).send(safeResult);
    } finally {
      clearTimeout(timeout);
      reply.raw.off("close", cancelWhenDisconnected);
    }
  });

  app.post("/api/v1/session/bootstrap", async (request, reply) => {
    if (!validateOrigin(request.headers.origin)) {
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
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
        return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
      }
      const cookieHeader = request.headers.cookie;
      const session = getSession(
        Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader
      );
      if (!session) {
        return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
      }
      const csrfHeader = request.headers["x-george-csrf"];
      if (!sessions.validateCsrf(session, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader)) {
        return rejectRequest(
          request,
          reply,
          403,
          "CSRF_REJECTED",
          "La solicitud no superó la validación CSRF."
        );
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
      return rejectRequest(request, reply, 403, "ORIGIN_REJECTED", "Origen no permitido.");
    }
    const cookieHeader = request.headers.cookie;
    if (!getSession(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader)) {
      return rejectRequest(request, reply, 401, "SESSION_REQUIRED", "Inicia una sesión local.");
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
  // A compiled apps/web/dist left over from `pnpm build` must not turn Host into a second,
  // concurrently-reachable UI origin while the Angular dev server is also running: browser
  // cookies are host-scoped, not port-scoped, so bootstrapping a session on each origin would
  // silently overwrite the other's session and orphan its cached CSRF token (CSRF_REJECTED).
  // Outside production this static mount is opt-in only.
  const serveWeb = options.serveWeb ?? environment["NODE_ENV"] === "production";
  if (serveWeb && existsSync(resolvedWebRoot)) {
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
    approvalStore.clear();
    for (const response of sseResponses) response.end();
    sseResponses.clear();
    await app.close();
    if (ownsAuditSink && auditSink instanceof SqliteAuditSink) auditSink.close();
  };

  return { app, close };
}

export function createConversationId(): string {
  return randomUUID();
}
