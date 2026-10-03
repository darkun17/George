import { Injectable } from "@angular/core";
import type { AgentResponse } from "@george/protocol";
import type { AIProviderInfo } from "@george/protocol";

export interface AgentRequestPayload {
  readonly conversationId: string;
  readonly input: string;
}

@Injectable({ providedIn: "root" })
export class AgentApiService {
  #csrfToken: string | undefined;

  async bootstrapSession(): Promise<void> {
    const response = await fetch("/api/v1/session/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const result: unknown = await response.json();
    if (!response.ok || typeof result !== "object" || result === null) {
      throw new Error("No fue posible iniciar una sesión local.");
    }
    const token = (result as Record<string, unknown>)["csrfToken"];
    if (typeof token !== "string" || token.length < 32) {
      throw new Error("El Host devolvió una sesión no válida.");
    }
    this.#csrfToken = token;
  }

  async getAIStatus(): Promise<AIProviderInfo> {
    const response = await fetch("/api/v1/ai/status", { credentials: "same-origin" });
    const result: unknown = await response.json();
    if (!response.ok || typeof result !== "object" || result === null)
      throw new Error("AI_STATUS_UNAVAILABLE");
    const value = result as Record<string, unknown>;
    if (
      typeof value["id"] !== "string" ||
      !["AVAILABLE", "UNAVAILABLE", "MISCONFIGURED"].includes(String(value["status"]))
    ) {
      throw new Error("AI_STATUS_UNAVAILABLE");
    }
    return value as unknown as AIProviderInfo;
  }

  async send(payload: AgentRequestPayload): Promise<AgentResponse> {
    if (!this.#csrfToken) throw new Error("La sesión local no está iniciada.");
    const response = await fetch("/api/v1/agent/requests", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-George-CSRF": this.#csrfToken
      },
      body: JSON.stringify(payload)
    });
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null) {
      throw new Error("El Host devolvió una respuesta no válida.");
    }
    const record = result as Record<string, unknown>;
    if (record["status"] === "completed" && typeof record["content"] === "string") {
      return record as unknown as AgentResponse;
    }
    if (
      record["status"] === "failed" ||
      record["status"] === "cancelled" ||
      record["status"] === "approval_required" ||
      record["status"] === "denied"
    ) {
      return record as unknown as AgentResponse;
    }
    const error = record["error"];
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") throw new Error(message);
    }
    throw new Error("George no pudo completar la solicitud.");
  }
}
