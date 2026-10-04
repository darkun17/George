import { randomUUID } from "node:crypto";
import type {
  AIToolDescriptor,
  AuditSink,
  Channel,
  PolicyDecision,
  ToolExecutionContext,
  ToolExecutionResult,
  RiskLevel
} from "@george/protocol";
import type { PolicyEngine, PolicyRequest } from "@george/policy";
import type { AnyToolDefinition } from "@george/tools-sdk";
import { z } from "zod";

export interface ToolMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly riskLevel: AnyToolDefinition["riskLevel"];
  readonly requiredPermissions: readonly string[];
  readonly timeoutMs: number;
  readonly availability: "AVAILABLE";
}

export interface ToolRegistry {
  get(toolId: string): AnyToolDefinition | undefined;
  listMetadata(): readonly ToolMetadata[];
  listAITools(): readonly AIToolDescriptor[];
}

const TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): void {
    if (!TOOL_ID_PATTERN.test(tool.id)) {
      throw new Error("Tool id must be a dot-separated machine identifier.");
    }
    if (this.#tools.has(tool.id)) throw new Error("Tool id is already registered.");
    if (tool.timeoutMs !== undefined && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0)) {
      throw new Error("Tool timeout must be a positive finite number.");
    }
    this.#tools.set(tool.id, tool);
  }

  get(toolId: string): AnyToolDefinition | undefined {
    return this.#tools.get(toolId);
  }

  listMetadata(): readonly ToolMetadata[] {
    return [...this.#tools.values()].map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      riskLevel: tool.riskLevel,
      requiredPermissions: [...tool.requiredPermissions],
      timeoutMs: tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      availability: "AVAILABLE"
    }));
  }

  listAITools(): readonly AIToolDescriptor[] {
    return [...this.#tools.values()].map((tool) => ({
      id: tool.id,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Readonly<Record<string, unknown>>
    }));
  }
}

export interface ToolExecutionRequest {
  readonly executionId: string;
  readonly toolCallId?: string;
  readonly toolId: string;
  readonly input: unknown;
  readonly channel: Channel;
  readonly grantedPermissions: readonly string[];
  readonly deniedPermissions?: readonly string[];
  readonly approvalId?: string;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
}

/** An opaque in-process handle; it is never part of an HTTP response. */
export interface ToolApprovalHandle {
  readonly toolId: string;
  readonly toolCallId: string;
}

interface ToolResultBase {
  readonly executionId: string;
  readonly toolId: string;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly policyOutcome?: PolicyDecision["outcome"];
  readonly riskLevel?: RiskLevel;
  readonly approvalHandle?: ToolApprovalHandle;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export type ToolRuntimeResult<TOutput = unknown> =
  | (ToolResultBase & { readonly status: "completed"; readonly output: TOutput })
  | (ToolResultBase & {
      readonly status: "failed" | "denied" | "approval_required" | "cancelled" | "timed_out";
      readonly error: { readonly code: string; readonly message: string };
      readonly approvalHandle?: ToolApprovalHandle;
    });

type ToolOutcome<TOutput> =
  | { readonly status: "completed"; readonly output: TOutput }
  | {
      readonly status: Exclude<ToolRuntimeResult["status"], "completed">;
      readonly code: string;
      readonly message: string;
    };

export interface ToolRuntimeOptions {
  readonly registry: ToolRegistry;
  readonly policyEngine: PolicyEngine;
  readonly auditSink: AuditSink;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly createId?: () => string;
  readonly clock?: () => Date;
}

export class ToolRuntime {
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #createId: () => string;
  readonly #clock: () => Date;
  readonly #pendingApprovals = new Map<
    ToolApprovalHandle,
    { readonly request: ToolExecutionRequest; readonly input: unknown }
  >();

  constructor(private readonly options: ToolRuntimeOptions) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxTimeoutMs = options.maxTimeoutMs ?? 120_000;
    this.#createId = options.createId ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
    if (
      !Number.isFinite(this.#defaultTimeoutMs) ||
      this.#defaultTimeoutMs <= 0 ||
      !Number.isFinite(this.#maxTimeoutMs) ||
      this.#maxTimeoutMs < this.#defaultTimeoutMs
    ) {
      throw new Error("Tool runtime timeout limits are invalid.");
    }
  }

  listAITools(): readonly AIToolDescriptor[] {
    return this.options.registry.listAITools();
  }

  execute(request: ToolExecutionRequest): Promise<ToolRuntimeResult> {
    return this.#execute(request);
  }

  async executeApproved(
    handle: ToolApprovalHandle,
    permissions?: {
      readonly grantedPermissions: readonly string[];
      readonly deniedPermissions: readonly string[];
    },
    approvalId?: string
  ): Promise<ToolRuntimeResult> {
    const pending = this.#pendingApprovals.get(handle);
    if (!pending) {
      return this.#finish(
        {
          executionId: "unknown",
          toolId: handle.toolId,
          input: null,
          channel: "desktop",
          grantedPermissions: []
        },
        "unknown",
        this.#clock(),
        { status: "denied", code: "APPROVAL_INVALID", message: "The approval is no longer valid." }
      );
    }
    this.#pendingApprovals.delete(handle);
    const request: ToolExecutionRequest = {
      ...pending.request,
      input: pending.input,
      ...(permissions ?? {
        grantedPermissions: pending.request.grantedPermissions,
        deniedPermissions: pending.request.deniedPermissions ?? []
      }),
      ...(approvalId ? { approvalId } : {})
    };
    return this.#execute(request, handle);
  }

  revokeApproval(handle: ToolApprovalHandle): void {
    this.#pendingApprovals.delete(handle);
  }

  async #execute(
    request: ToolExecutionRequest,
    approval?: ToolApprovalHandle
  ): Promise<ToolRuntimeResult> {
    const executionId = request.executionId || this.#createId();
    const started = this.#clock();
    const tool = this.options.registry.get(request.toolId);
    if (!tool) {
      return this.#finish(request, executionId, started, {
        status: "failed",
        code: "TOOL_NOT_FOUND",
        message: "The requested tool is not available."
      });
    }

    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "failed",
          code: "INVALID_TOOL_INPUT",
          message: "The tool input is invalid."
        },
        tool
      );
    }

    let decision: PolicyDecision;
    try {
      const policyRequest: PolicyRequest = {
        toolId: tool.id,
        riskLevel: tool.riskLevel,
        requiredPermissions: tool.requiredPermissions,
        grantedPermissions: request.grantedPermissions,
        deniedPermissions: request.deniedPermissions ?? []
      };
      decision = this.options.policyEngine.evaluate(policyRequest);
    } catch {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "failed",
          code: "TOOL_EXECUTION_FAILED",
          message: "The tool could not be completed."
        },
        tool
      );
    }

    if (decision.outcome === "DENY") {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "denied",
          code: "PERMISSION_DENIED",
          message: "Policy denied this tool request."
        },
        tool,
        decision
      );
    }
    if (decision.outcome === "ASK" && !approval) {
      const toolCallId = request.toolCallId ?? "";
      const handle: ToolApprovalHandle = Object.freeze({ toolId: tool.id, toolCallId });
      this.#pendingApprovals.set(handle, { request, input: parsed.data });
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "approval_required",
          code: "APPROVAL_REQUIRED",
          message: "This tool request requires approval."
        },
        tool,
        decision,
        handle
      );
    }
    if (approval && (approval.toolId !== tool.id || approval.toolCallId !== request.toolCallId)) {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "denied",
          code: "APPROVAL_MISMATCH",
          message: "The approval does not match this operation."
        },
        tool,
        decision
      );
    }
    if (decision.outcome !== "ALLOW" && !(decision.outcome === "ASK" && approval)) {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "failed",
          code: "POLICY_EVALUATION_FAILED",
          message: "The tool policy could not authorize this request."
        },
        tool
      );
    }
    if (request.signal?.aborted) {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "cancelled",
          code: "TOOL_CANCELLED",
          message: "The tool request was cancelled."
        },
        tool,
        decision
      );
    }

    try {
      await this.options.auditSink.record({
        executionId,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        ...(request.approvalId
          ? { approvalId: request.approvalId, approvalStatus: "approved" as const }
          : {}),
        ...(request.approvalId
          ? { approvalId: request.approvalId, approvalStatus: "approved" as const }
          : {}),
        toolId: request.toolId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        channel: request.channel,
        operation: "tool.execution",
        status: "requested",
        occurredAt: started.toISOString(),
        durationMs: 0,
        riskLevel: tool.riskLevel,
        policyOutcome: decision.outcome,
        metadata: {}
      });
    } catch {
      return this.#finish(
        request,
        executionId,
        started,
        {
          status: "failed",
          code: "AUDIT_WRITE_FAILED",
          message: "Audit storage is unavailable; the tool was not executed."
        },
        tool,
        decision
      );
    }

    const timeoutMs = Math.min(tool.timeoutMs ?? this.#defaultTimeoutMs, this.#maxTimeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Tool timed out.", "TimeoutError"));
    }, timeoutMs);
    const context: ToolExecutionContext = {
      executionId,
      correlationId: request.requestId ?? request.conversationId ?? executionId,
      channel: request.channel,
      startedAt: started.toISOString(),
      signal: controller.signal
    };

    let removeAbortListener = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = (): void => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", rejectOnAbort);
    });

    try {
      const handlerResult = await Promise.race([
        Promise.resolve().then(() => tool.handler(parsed.data, context)),
        aborted
      ]);
      return this.#finish(
        request,
        executionId,
        started,
        this.#mapHandlerResult(handlerResult),
        tool,
        decision
      );
    } catch {
      return this.#finish(
        request,
        executionId,
        started,
        timedOut
          ? {
              status: "timed_out",
              code: "TOOL_TIMEOUT",
              message: "The tool exceeded its time limit."
            }
          : request.signal?.aborted
            ? {
                status: "cancelled",
                code: "TOOL_CANCELLED",
                message: "The tool request was cancelled."
              }
            : {
                status: "failed",
                code: "TOOL_EXECUTION_FAILED",
                message: "The tool could not be completed."
              },
        tool,
        decision
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", cancel);
      removeAbortListener();
    }
  }

  #mapHandlerResult<TOutput>(result: ToolExecutionResult<TOutput>): ToolOutcome<TOutput> {
    switch (result.status) {
      case "succeeded":
        return { status: "completed", output: result.output };
      case "cancelled":
        return {
          status: "cancelled",
          code: "TOOL_CANCELLED",
          message: "The tool request was cancelled."
        };
      case "failed":
        return {
          status: "failed",
          code: "TOOL_EXECUTION_FAILED",
          message: "The tool could not be completed."
        };
    }
  }

  async #finish(
    request: ToolExecutionRequest,
    executionId: string,
    started: Date,
    outcome: ToolOutcome<unknown>,
    tool?: AnyToolDefinition,
    decision?: PolicyDecision,
    approvalHandle?: ToolApprovalHandle
  ): Promise<ToolRuntimeResult> {
    const completed = this.#clock();
    const durationMs = Math.max(0, completed.getTime() - started.getTime());
    const base: ToolResultBase = {
      executionId,
      toolId: request.toolId,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(decision ? { policyOutcome: decision.outcome } : {}),
      ...(tool ? { riskLevel: tool.riskLevel } : {}),
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs
    };
    const result: ToolRuntimeResult =
      outcome.status === "completed"
        ? { ...base, status: "completed", output: outcome.output }
        : {
            ...base,
            status: outcome.status,
            error: { code: outcome.code, message: outcome.message }
          };

    let auditFailed = false;
    try {
      await this.options.auditSink.record({
        executionId,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        toolId: request.toolId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        channel: request.channel,
        operation: "tool.execution",
        status: outcome.status,
        occurredAt: completed.toISOString(),
        durationMs,
        ...(tool ? { riskLevel: tool.riskLevel } : {}),
        ...(decision ? { policyOutcome: decision.outcome } : {}),
        ...(outcome.status !== "completed" ? { errorCode: outcome.code } : {}),
        metadata: {}
      });
    } catch {
      auditFailed = true;
    }
    if (auditFailed && result.status === "completed") {
      return {
        ...base,
        status: "failed",
        error: {
          code: "AUDIT_WRITE_FAILED",
          message: "The tool may have completed, but its result could not be audited."
        }
      };
    }
    return approvalHandle && result.status === "approval_required"
      ? { ...result, approvalHandle }
      : result;
  }
}

export { systemInfoTool } from "./system-info.js";
export type { SystemInfo } from "./system-info.js";
