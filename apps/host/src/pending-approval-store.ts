import { randomUUID } from "node:crypto";
import type {
  AgentResponse,
  ApprovalAuditRecord,
  ApprovalRequest,
  AuditSink
} from "@george/protocol";

export interface PendingApprovalInput {
  readonly requestId: string;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly executionId: string;
  readonly toolId: string;
  readonly riskLevel: ApprovalRequest["riskLevel"];
  readonly channel: ApprovalAuditRecord["channel"];
  readonly summary?: string;
}

interface StoredApproval {
  request: ApprovalRequest;
  readonly executionId: string;
  readonly channel: ApprovalAuditRecord["channel"];
  continuation: (() => Promise<AgentResponse>) | undefined;
  dispose: (() => void) | undefined;
  timer?: ReturnType<typeof setTimeout>;
}

export type ApprovalResolution =
  | { readonly status: "resolved"; readonly response: AgentResponse }
  | { readonly status: "not_found" | "expired" | "already_resolved" | "capacity" };

export class PendingApprovalStore {
  readonly #entries = new Map<string, StoredApproval>();
  readonly #ttlMs: number;
  readonly #maxPending: number;

  constructor(
    private readonly auditSink: AuditSink,
    private readonly options: {
      readonly ttlMs?: number;
      readonly maxPending?: number;
      readonly createId?: () => string;
      readonly clock?: () => Date;
    } = {}
  ) {
    this.#ttlMs = Math.min(5 * 60_000, Math.max(1_000, options.ttlMs ?? 5 * 60_000));
    this.#maxPending = Math.max(1, Math.min(128, options.maxPending ?? 32));
  }

  create(
    input: PendingApprovalInput,
    continuation: () => Promise<AgentResponse>,
    dispose?: () => void
  ): ApprovalRequest | undefined {
    this.#expireDue();
    if (
      [...this.#entries.values()].filter(({ request }) => request.status === "PENDING").length >=
      this.#maxPending
    )
      return undefined;
    const now = this.#now();
    const request: ApprovalRequest = {
      approvalId: (this.options.createId ?? randomUUID)(),
      requestId: input.requestId,
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      riskLevel: input.riskLevel,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      status: "PENDING",
      ...(input.summary ? { summary: input.summary } : {})
    };
    const entry: StoredApproval = {
      request,
      executionId: input.executionId,
      channel: input.channel,
      continuation,
      dispose: dispose ?? undefined
    };
    entry.timer = setTimeout(() => this.#expire(request.approvalId), this.#ttlMs);
    entry.timer.unref?.();
    this.#entries.set(request.approvalId, entry);
    if (!this.#audit(entry, "requested")) {
      clearTimeout(entry.timer);
      this.#entries.delete(request.approvalId);
      entry.dispose?.();
      return undefined;
    }
    this.#trimHistory();
    return request;
  }

  list(): readonly ApprovalRequest[] {
    this.#expireDue();
    return [...this.#entries.values()]
      .map(({ request }) => request)
      .filter((request) => request.status === "PENDING" || request.status === "EXPIRED");
  }

  async approve(approvalId: string): Promise<ApprovalResolution> {
    const entry = this.#claim(approvalId, "APPROVED");
    if (!entry) return this.#missingResolution(approvalId);
    const continuation = entry.continuation;
    const dispose = entry.dispose;
    entry.continuation = undefined;
    entry.dispose = undefined;
    if (!continuation) return { status: "already_resolved" };
    if (!this.#audit(entry, "approved")) {
      dispose?.();
      return {
        status: "resolved",
        response: {
          status: "failed",
          requestId: entry.request.requestId,
          conversationId: entry.request.conversationId,
          error: {
            code: "INTERNAL_ERROR",
            message: "No se pudo registrar la aprobación; la acción no se ejecutó."
          },
          receivedAt: entry.request.createdAt,
          completedAt: this.#now().toISOString(),
          durationMs: 0
        }
      };
    }
    return { status: "resolved", response: await continuation() };
  }

  deny(approvalId: string): ApprovalResolution {
    const entry = this.#claim(approvalId, "DENIED");
    if (!entry) return this.#missingResolution(approvalId);
    entry.continuation = undefined;
    entry.dispose?.();
    entry.dispose = undefined;
    this.#audit(entry, "denied");
    const now = this.#now().toISOString();
    return {
      status: "resolved",
      response: {
        status: "denied",
        requestId: entry.request.requestId,
        conversationId: entry.request.conversationId,
        toolId: entry.request.toolId,
        executionId: entry.executionId,
        toolCallId: entry.request.toolCallId,
        error: { code: "PERMISSION_DENIED", message: "La acción fue denegada." },
        receivedAt: entry.request.createdAt,
        completedAt: now,
        durationMs: 0
      }
    };
  }

  clear(): void {
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
      entry.dispose?.();
    }
    this.#entries.clear();
  }

  #claim(approvalId: string, status: "APPROVED" | "DENIED"): StoredApproval | undefined {
    this.#expireDue();
    const entry = this.#entries.get(approvalId);
    if (!entry || entry.request.status !== "PENDING") return undefined;
    entry.request = { ...entry.request, status };
    clearTimeout(entry.timer);
    return entry;
  }

  #missingResolution(approvalId: string): ApprovalResolution {
    const entry = this.#entries.get(approvalId);
    return entry?.request.status === "EXPIRED"
      ? { status: "expired" }
      : { status: entry ? "already_resolved" : "not_found" };
  }

  #expireDue(): void {
    const now = this.#now().getTime();
    for (const [approvalId, entry] of this.#entries) {
      if (entry.request.status === "PENDING" && Date.parse(entry.request.expiresAt) <= now)
        this.#expire(approvalId);
    }
  }

  #expire(approvalId: string): void {
    const entry = this.#entries.get(approvalId);
    if (!entry || entry.request.status !== "PENDING") return;
    entry.request = { ...entry.request, status: "EXPIRED" };
    entry.continuation = undefined;
    entry.dispose?.();
    entry.dispose = undefined;
    clearTimeout(entry.timer);
    this.#audit(entry, "expired");
  }

  #audit(entry: StoredApproval, decision: ApprovalAuditRecord["decision"]): boolean {
    try {
      this.auditSink.record({
        eventId: (this.options.createId ?? randomUUID)(),
        occurredAt: this.#now().toISOString(),
        operation: "approval.decision",
        requestId: entry.request.requestId,
        conversationId: entry.request.conversationId,
        channel: entry.channel,
        toolId: entry.request.toolId,
        toolCallId: entry.request.toolCallId,
        executionId: entry.executionId,
        approvalId: entry.request.approvalId,
        riskLevel: entry.request.riskLevel,
        decision,
        metadata: {}
      });
      return true;
    } catch {
      // Approval state transitions are fail-closed; the original audit request remains visible as pending.
      return false;
    }
  }

  #now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  #trimHistory(): void {
    while (this.#entries.size > 128) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) return;
      const entry = this.#entries.get(oldest);
      if (entry?.request.status === "PENDING") return;
      this.#entries.delete(oldest);
    }
  }
}
