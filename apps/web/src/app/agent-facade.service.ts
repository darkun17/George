import { Injectable, inject, signal } from "@angular/core";
import type { AgentEvent } from "@george/protocol";
import type {
  AIProviderInfo,
  AIProviderStatus,
  ApprovalRequest,
  AgentResponse
} from "@george/protocol";
import { AgentApiError, AgentApiService } from "./agent-api.service.js";

export type HostConnectionState = "CONNECTING" | "ONLINE" | "OFFLINE";
export type AgentDisplayState = "READY" | "THINKING" | "EXECUTING" | "WAITING_APPROVAL" | "ERROR";
export function isApprovalActionDisabled(
  status: ApprovalRequest["status"],
  resolving: boolean
): boolean {
  return status !== "PENDING" || resolving;
}
export function mapAIStatus(info: AIProviderInfo | null): AIProviderStatus | "UNKNOWN" {
  return info?.status ?? "UNKNOWN";
}
/**
 * Classifies an AgentApiService failure into a safe, user-facing message.
 * A network failure (Host unreachable) and a Host-issued security rejection
 * (401/403) are different situations and must never collapse into the same
 * "cannot connect" message.
 */
export function describeApiFailure(error: unknown): string {
  if (error instanceof AgentApiError) {
    if (error.kind === "NETWORK") return "George Host no está disponible.";
    switch (error.status) {
      case 401:
        return "La sesión local no es válida.";
      case 403:
        return "George rechazó la solicitud por seguridad.";
      case 503:
        return "El proveedor de IA no está disponible.";
      default:
        return "George no pudo procesar la solicitud.";
    }
  }
  return "George no pudo procesar la solicitud.";
}

export function safeAgentError(code: string): string {
  switch (code) {
    case "PROVIDER_UNAVAILABLE":
      return "No se pudo conectar con el proveedor de IA configurado.";
    case "PROVIDER_ERROR":
      return "El proveedor de IA no pudo completar la respuesta.";
    case "CANCELLED":
      return "La solicitud fue cancelada.";
    case "APPROVAL_REQUIRED":
      return "Esta acción requiere aprobación antes de ejecutarse.";
    case "PERMISSION_DENIED":
      return "George no tiene permiso para ejecutar esta acción.";
    case "TOOL_CALLING_UNAVAILABLE":
      return "El modelo configurado no puede solicitar herramientas.";
    case "TOOL_RESULT_TOO_LARGE":
      return "El resultado de la herramienta excedió el límite permitido.";
    case "AUDIT_WRITE_FAILED":
      return "La acción pudo ejecutarse, pero George no pudo guardarla en la auditoría.";
    default:
      return "George no pudo completar la solicitud.";
  }
}
export type ChatMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
};

export interface ActivityItem {
  readonly id: string;
  readonly event: AgentEvent;
  readonly label: string;
}

export function activityLabel(event: AgentEvent): string {
  switch (event.type) {
    case "request.received":
      return "Solicitud recibida";
    case "request.processing":
      return "Procesando solicitud";
    case "provider.started":
      return "Consultando proveedor";
    case "provider.completed":
      return "Respuesta del proveedor recibida";
    case "tool.requested":
      return `Consultando ${event.metadata.toolId}`;
    case "tool.completed":
      return `${event.metadata.toolId} completado · ${event.metadata.durationMs} ms`;
    case "tool.failed":
      return `${event.metadata.toolId} no pudo completarse`;
    case "tool.denied":
      return `${event.metadata.toolId} denegado`;
    case "tool.approval_required":
      return `Aprobación requerida · ${event.metadata.toolId}`;
    case "request.completed":
      return "Respuesta completada";
    case "request.failed":
      return "No se pudo completar la solicitud";
  }
}

export function reduceAgentState(current: AgentDisplayState, event: AgentEvent): AgentDisplayState {
  switch (event.type) {
    case "request.received":
    case "request.processing":
    case "provider.started":
      return "THINKING";
    case "tool.requested":
      return "EXECUTING";
    case "tool.completed":
      return "THINKING";
    case "tool.failed":
    case "tool.denied":
      return "ERROR";
    case "tool.approval_required":
      return "WAITING_APPROVAL";
    case "request.completed":
      return "READY";
    case "request.failed":
      return "ERROR";
    case "provider.completed":
      return current;
  }
}

@Injectable({ providedIn: "root" })
export class AgentFacade {
  readonly #api = inject(AgentApiService);
  readonly connection = signal<HostConnectionState>("CONNECTING");
  readonly aiInfo = signal<AIProviderInfo | null>(null);
  readonly agentState = signal<AgentDisplayState>("READY");
  readonly busy = signal(false);
  readonly messages = signal<readonly ChatMessage[]>([]);
  readonly activity = signal<readonly ActivityItem[]>([]);
  readonly approvals = signal<readonly ApprovalRequest[]>([]);
  readonly resolvingApprovals = signal<readonly string[]>([]);
  readonly conversationId = crypto.randomUUID();
  #eventSource: EventSource | undefined;

  async connect(): Promise<void> {
    try {
      await this.#api.bootstrapSession();
      await this.refreshApprovals();
      const source = new EventSource("/api/v1/agent/events");
      this.#eventSource = source;
      source.onopen = () => this.connection.set("ONLINE");
      source.onerror = () => this.connection.set("OFFLINE");
      void this.refreshAIStatus();
      source.addEventListener("agent", (message: MessageEvent<string>) => {
        try {
          const event = JSON.parse(message.data) as AgentEvent;
          this.#receive(event);
        } catch {
          // Ignore malformed event data; the stream is not an authority for agent decisions.
        }
      });
    } catch {
      this.connection.set("OFFLINE");
    }
  }

  async send(input: string): Promise<void> {
    const content = input.trim();
    if (!content || this.connection() !== "ONLINE" || this.busy()) return;
    this.messages.update((messages) => [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content }
    ]);
    this.agentState.set("THINKING");
    this.busy.set(true);
    try {
      const response = await this.#api.send({
        conversationId: this.conversationId,
        input: content
      });
      if (response.status === "completed") {
        this.messages.update((messages) => [
          ...messages,
          { id: response.requestId, role: "assistant", content: response.content }
        ]);
        this.agentState.set("READY");
      } else if (response.status === "approval_required") {
        this.agentState.set("WAITING_APPROVAL");
        await this.refreshApprovals();
        this.messages.update((messages) => [
          ...messages,
          {
            id: response.requestId,
            role: "assistant",
            content: safeAgentError(response.error.code)
          }
        ]);
      } else {
        this.agentState.set("ERROR");
        this.messages.update((messages) => [
          ...messages,
          {
            id: response.requestId,
            role: "assistant",
            content: safeAgentError(response.error.code)
          }
        ]);
      }
    } catch (error) {
      this.agentState.set("ERROR");
      this.messages.update((messages) => [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: describeApiFailure(error)
        }
      ]);
    } finally {
      this.busy.set(false);
    }
  }

  async refreshApprovals(): Promise<void> {
    try {
      this.approvals.set(await this.#api.getApprovals());
    } catch {
      this.approvals.set([]);
    }
  }

  async resolveApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    if (this.resolvingApprovals().includes(approvalId)) return;
    this.agentState.set(decision === "approve" ? "EXECUTING" : "READY");
    this.resolvingApprovals.update((ids) => [...ids, approvalId]);
    try {
      const response = await this.#api.resolveApproval(approvalId, decision);
      this.#applyApprovalResponse(response);
      await this.refreshApprovals();
    } catch (error) {
      if (error instanceof Error && error.message === "APPROVAL_EXPIRED") {
        this.approvals.update((items) =>
          items.map((item) =>
            item.approvalId === approvalId ? { ...item, status: "EXPIRED" } : item
          )
        );
      }
      if (
        error instanceof Error &&
        ["APPROVAL_RESOLVED", "APPROVAL_NOT_FOUND"].includes(error.message)
      )
        await this.refreshApprovals();
    } finally {
      this.resolvingApprovals.update((ids) => ids.filter((id) => id !== approvalId));
    }
  }

  close(): void {
    this.#eventSource?.close();
    this.#eventSource = undefined;
  }

  async refreshAIStatus(): Promise<void> {
    try {
      this.aiInfo.set(await this.#api.getAIStatus());
    } catch {
      this.aiInfo.set(null);
    }
  }

  #receive(event: AgentEvent): void {
    this.agentState.update((current) => reduceAgentState(current, event));
    this.activity.update((items) =>
      [
        ...items,
        {
          id: `${event.requestId}:${event.type}:${event.occurredAt}`,
          event,
          label: activityLabel(event)
        }
      ].slice(-40)
    );
  }

  #applyApprovalResponse(response: AgentResponse): void {
    if (response.status === "approval_required") {
      this.agentState.set("WAITING_APPROVAL");
      return;
    }
    if (response.status === "completed") {
      this.messages.update((items) => [
        ...items,
        { id: response.requestId, role: "assistant", content: response.content }
      ]);
      this.agentState.set("READY");
      return;
    }
    this.messages.update((items) => [
      ...items,
      { id: response.requestId, role: "assistant", content: safeAgentError(response.error.code) }
    ]);
    this.agentState.set(response.status === "denied" ? "READY" : "ERROR");
  }
}
