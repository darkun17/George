import "@angular/compiler";
import { describe, expect, it } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";
import type { AgentEvent } from "@george/protocol";
import {
  AgentFacade,
  activityLabel,
  describeApiFailure,
  isApprovalActionDisabled,
  mapAIStatus,
  reduceAgentState,
  safeAgentError
} from "./agent-facade.service.js";
import { AgentApiError, AgentApiService } from "./agent-api.service.js";

const event = (type: AgentEvent["type"]): AgentEvent =>
  ({
    type,
    occurredAt: "2026-10-02T12:00:00.000Z",
    requestId: "request-1",
    conversationId: "conversation-1",
    channel: "desktop",
    metadata: type === "request.failed" ? { errorCode: "PROVIDER_ERROR" } : {}
  }) as AgentEvent;

describe("agent activity presentation", () => {
  it("maps provider health independently from Host connection and Agent state", () => {
    expect(mapAIStatus({ id: "ollama", status: "AVAILABLE", model: "m", models: ["m"] })).toBe(
      "AVAILABLE"
    );
    expect(mapAIStatus({ id: "ollama", status: "UNAVAILABLE", model: "m", models: [] })).toBe(
      "UNAVAILABLE"
    );
    expect(mapAIStatus(null)).toBe("UNKNOWN");
    expect(reduceAgentState("READY", event("request.completed"))).toBe("READY");
  });

  it("maps typed provider failures to safe Spanish user messages", () => {
    expect(safeAgentError("PROVIDER_UNAVAILABLE")).toBe(
      "No se pudo conectar con el proveedor de IA configurado."
    );
    expect(safeAgentError("PROVIDER_ERROR")).toBe(
      "El proveedor de IA no pudo completar la respuesta."
    );
    expect(safeAgentError("SOMETHING_INTERNAL")).toBe("George no pudo completar la solicitud.");
  });
  it("derives agent state from actual lifecycle events", () => {
    expect(reduceAgentState("READY", event("request.received"))).toBe("THINKING");
    expect(reduceAgentState("THINKING", event("provider.completed"))).toBe("THINKING");
    expect(reduceAgentState("THINKING", event("request.completed"))).toBe("READY");
    expect(reduceAgentState("THINKING", event("request.failed"))).toBe("ERROR");
  });

  it("translates structured provider events for the activity panel", () => {
    expect(activityLabel(event("provider.started"))).toBe("Consultando proveedor");
  });

  it("shows tool execution and approval states without exposing tool payloads", () => {
    const requested: AgentEvent = {
      type: "tool.requested",
      occurredAt: "2026-10-02T12:00:00.000Z",
      requestId: "request-1",
      conversationId: "conversation-1",
      channel: "desktop",
      metadata: { toolId: "system.info", executionId: "execution-1", toolCallId: "call-1" }
    };
    const completed: AgentEvent = {
      ...requested,
      type: "tool.completed",
      metadata: {
        toolId: "system.info",
        executionId: "execution-1",
        toolCallId: "call-1",
        durationMs: 42
      }
    };
    const approval: AgentEvent = {
      ...completed,
      type: "tool.approval_required"
    };
    expect(reduceAgentState("THINKING", requested)).toBe("EXECUTING");
    expect(activityLabel(requested)).toBe("Consultando system.info");
    expect(reduceAgentState("EXECUTING", completed)).toBe("THINKING");
    expect(activityLabel(completed)).toBe("system.info completado · 42 ms");
    expect(reduceAgentState("EXECUTING", approval)).toBe("WAITING_APPROVAL");
    expect(activityLabel(approval)).toBe("Aprobación requerida · system.info");
    expect(JSON.stringify([requested, completed, approval])).not.toMatch(
      /hostname|totalMemory|output/
    );
  });

  it("keeps approval actions one-time and disabled while resolving or after expiration", () => {
    expect(isApprovalActionDisabled("PENDING", false)).toBe(false);
    expect(isApprovalActionDisabled("PENDING", true)).toBe(true);
    expect(isApprovalActionDisabled("EXPIRED", false)).toBe(true);
    expect(isApprovalActionDisabled("APPROVED", false)).toBe(true);
    expect(isApprovalActionDisabled("DENIED", false)).toBe(true);
    expect(reduceAgentState("WAITING_APPROVAL", event("request.completed"))).toBe("READY");
  });
});

describe("describeApiFailure", () => {
  it("maps a network failure to a Host-unreachable message, distinct from a security rejection", () => {
    expect(describeApiFailure(new AgentApiError("NETWORK", "boom"))).toBe(
      "George Host no está disponible."
    );
    expect(describeApiFailure(new AgentApiError("HTTP", "x", 401))).toBe(
      "La sesión local no es válida."
    );
    expect(describeApiFailure(new AgentApiError("HTTP", "x", 403))).toBe(
      "George rechazó la solicitud por seguridad."
    );
    expect(describeApiFailure(new AgentApiError("HTTP", "x", 503))).toBe(
      "El proveedor de IA no está disponible."
    );
    expect(describeApiFailure(new AgentApiError("HTTP", "x", 500))).toBe(
      "George no pudo procesar la solicitud."
    );
    expect(describeApiFailure(new Error("unrelated"))).toBe(
      "George no pudo procesar la solicitud."
    );
  });
});

function createFacade(api: Partial<AgentApiService>): AgentFacade {
  const injector = Injector.create({
    providers: [AgentFacade, { provide: AgentApiService, useValue: api }]
  });
  return runInInjectionContext(injector, () => injector.get(AgentFacade));
}

describe("AgentFacade.send error classification (N, O, P)", () => {
  it("N. a 403 security rejection surfaces as a security message, not a connectivity failure", async () => {
    const facade = createFacade({
      send: async () => {
        throw new AgentApiError("HTTP", "La solicitud no superó la validación CSRF.", 403);
      }
    });
    facade.connection.set("ONLINE");
    await facade.send("hola");
    expect(facade.messages().at(-1)?.content).toBe("George rechazó la solicitud por seguridad.");
    expect(facade.agentState()).toBe("ERROR");
  });

  it("O. an actual network failure surfaces as Host-unavailable", async () => {
    const facade = createFacade({
      send: async () => {
        throw new AgentApiError("NETWORK", "fetch failed");
      }
    });
    facade.connection.set("ONLINE");
    await facade.send("hola");
    expect(facade.messages().at(-1)?.content).toBe("George Host no está disponible.");
  });

  it("P. Host ONLINE remains ONLINE after an Agent 403 (connection and agent state stay separate)", async () => {
    const facade = createFacade({
      send: async () => {
        throw new AgentApiError("HTTP", "denied", 403);
      }
    });
    facade.connection.set("ONLINE");
    await facade.send("hola");
    expect(facade.connection()).toBe("ONLINE");
    expect(facade.agentState()).toBe("ERROR");
  });
});
