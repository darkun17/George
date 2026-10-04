import { Injectable } from "@angular/core";
import type { AgentResponse, ApprovalRequest } from "@george/protocol";
import type { AIProviderInfo } from "@george/protocol";

export interface AgentRequestPayload {
  readonly conversationId: string;
  readonly input: string;
}

/**
 * Distinguishes an unreachable Host (network/fetch failure) from a Host
 * response that rejected the request (HTTP status + safe error code), so
 * the UI never conflates "Host is down" with "Host is up and said no".
 */
export class AgentApiError extends Error {
  readonly kind: "NETWORK" | "HTTP";
  readonly status?: number;
  readonly code?: string;

  constructor(kind: "NETWORK" | "HTTP", message: string, status?: number, code?: string) {
    super(message);
    this.name = "AgentApiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body !== "object" || body === null) return undefined;
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as Record<string, unknown>)["code"];
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

async function requireFetch(
  url: string,
  init: RequestInit,
  fallbackMessage: string
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new AgentApiError("NETWORK", "George Host no está disponible.");
  }
  if (!response.ok) {
    const code = await readErrorCode(response);
    throw new AgentApiError("HTTP", fallbackMessage, response.status, code);
  }
  return response;
}

/** True for a parsed body matching the AgentResponse discriminated union's known statuses. */
function isAgentResponseShape(value: Record<string, unknown>): value is Record<string, unknown> {
  return (
    value["status"] === "completed" ||
    value["status"] === "failed" ||
    value["status"] === "cancelled" ||
    value["status"] === "approval_required" ||
    value["status"] === "denied"
  );
}

@Injectable({ providedIn: "root" })
export class AgentApiService {
  #csrfToken: string | undefined;

  async bootstrapSession(): Promise<void> {
    const response = await requireFetch(
      "/api/v1/session/bootstrap",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      },
      "No fue posible iniciar una sesión local."
    );
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null) {
      throw new AgentApiError("HTTP", "El Host devolvió una sesión no válida.", response.status);
    }
    const token = (result as Record<string, unknown>)["csrfToken"];
    if (typeof token !== "string" || token.length < 32) {
      throw new AgentApiError("HTTP", "El Host devolvió una sesión no válida.", response.status);
    }
    this.#csrfToken = token;
  }

  async getAIStatus(): Promise<AIProviderInfo> {
    const response = await requireFetch(
      "/api/v1/ai/status",
      { credentials: "same-origin" },
      "AI_STATUS_UNAVAILABLE"
    );
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null)
      throw new AgentApiError("HTTP", "AI_STATUS_UNAVAILABLE", response.status);
    const value = result as Record<string, unknown>;
    if (
      typeof value["id"] !== "string" ||
      !["AVAILABLE", "UNAVAILABLE", "MISCONFIGURED"].includes(String(value["status"]))
    ) {
      throw new AgentApiError("HTTP", "AI_STATUS_UNAVAILABLE", response.status);
    }
    return value as unknown as AIProviderInfo;
  }

  async send(payload: AgentRequestPayload): Promise<AgentResponse> {
    if (!this.#csrfToken) throw new AgentApiError("HTTP", "La sesión local no está iniciada.");
    let response: Response;
    try {
      response = await fetch("/api/v1/agent/requests", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-George-CSRF": this.#csrfToken
        },
        body: JSON.stringify(payload)
      });
    } catch {
      throw new AgentApiError("NETWORK", "George Host no está disponible.");
    }
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null) {
      throw new AgentApiError("HTTP", "El Host devolvió una respuesta no válida.", response.status);
    }
    const record = result as Record<string, unknown>;
    if (isAgentResponseShape(record)) return record as unknown as AgentResponse;
    const error = record["error"];
    const message =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)["message"]
        : undefined;
    const code =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)["code"]
        : undefined;
    throw new AgentApiError(
      "HTTP",
      typeof message === "string" ? message : "George no pudo completar la solicitud.",
      response.status,
      typeof code === "string" ? code : undefined
    );
  }

  async getApprovals(): Promise<readonly ApprovalRequest[]> {
    const response = await requireFetch(
      "/api/v1/approvals",
      { credentials: "same-origin" },
      "APPROVALS_UNAVAILABLE"
    );
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null)
      throw new AgentApiError("HTTP", "APPROVALS_UNAVAILABLE", response.status);
    const approvals = (result as Record<string, unknown>)["approvals"];
    if (!Array.isArray(approvals))
      throw new AgentApiError("HTTP", "APPROVALS_UNAVAILABLE", response.status);
    return approvals.filter((value): value is ApprovalRequest => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Record<string, unknown>;
      return (
        typeof item["approvalId"] === "string" &&
        typeof item["toolId"] === "string" &&
        ["PENDING", "APPROVED", "DENIED", "EXPIRED"].includes(String(item["status"]))
      );
    });
  }

  async resolveApproval(approvalId: string, decision: "approve" | "deny"): Promise<AgentResponse> {
    if (!this.#csrfToken) throw new AgentApiError("HTTP", "La sesión local no está iniciada.");
    let response: Response;
    try {
      response = await fetch(`/api/v1/approvals/${encodeURIComponent(approvalId)}/${decision}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-George-CSRF": this.#csrfToken }
      });
    } catch {
      throw new AgentApiError("NETWORK", "George Host no está disponible.");
    }
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null)
      throw new AgentApiError("HTTP", "APPROVAL_RESOLUTION_FAILED", response.status);
    const item = result as Record<string, unknown>;
    if (isAgentResponseShape(item)) return item as unknown as AgentResponse;
    const error = item["error"];
    const code =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)["code"]
        : undefined;
    throw new AgentApiError(
      "HTTP",
      typeof code === "string" ? code : "APPROVAL_RESOLUTION_FAILED",
      response.status,
      typeof code === "string" ? code : undefined
    );
  }
}
