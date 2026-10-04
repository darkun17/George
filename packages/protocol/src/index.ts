export type Channel = "desktop" | "cli" | "voice" | "api";

export type RiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PolicyDecision =
  | { readonly outcome: "ALLOW"; readonly reason: string }
  | { readonly outcome: "ASK"; readonly reason: string }
  | { readonly outcome: "DENY"; readonly reason: string };

export interface ToolExecutionContext {
  readonly executionId: string;
  readonly correlationId: string;
  readonly channel: Channel;
  readonly startedAt: string;
  readonly signal?: AbortSignal;
}

export type ToolExecutionResult<TOutput> =
  | { readonly status: "succeeded"; readonly output: TOutput }
  | {
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly status: "cancelled"; readonly reason: string };

export interface AuditEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly actor: "user" | "assistant" | "system";
  readonly action: string;
  readonly outcome: "allowed" | "approval_required" | "denied" | "succeeded" | "failed";
  readonly resource?: string;
  readonly reason?: string;
}

export interface AIToolCallRequest {
  readonly id: string;
  readonly toolId: string;
  readonly input: unknown;
}

export interface AIToolDescriptor {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type AIMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly AIToolCallRequest[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly toolCallId: string;
      readonly toolId: string;
    };

export type AIProviderResult =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "tool_calls"; readonly calls: readonly AIToolCallRequest[] };

export interface AIProviderCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
}

export interface AIProvider {
  readonly id: string;
  readonly capabilities: AIProviderCapabilities;
  chat(
    messages: readonly AIMessage[],
    options?: { readonly signal?: AbortSignal; readonly tools?: readonly AIToolDescriptor[] }
  ): Promise<AIProviderResult>;
}

export type AIProviderStatus = "AVAILABLE" | "UNAVAILABLE" | "MISCONFIGURED";

export interface AIProviderInfo {
  readonly id: string;
  readonly status: AIProviderStatus;
  readonly model: string | null;
  readonly models: readonly string[];
}

export interface AgentRequest {
  readonly conversationId: string;
  readonly channel: Channel;
  readonly input: string;
  readonly receivedAt: string;
}

export type AgentErrorCode =
  | "INVALID_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "TOOL_CALLING_UNAVAILABLE"
  | "MAX_TOOL_ITERATIONS"
  | "TOOL_RESULT_TOO_LARGE"
  | "TOOL_NOT_FOUND"
  | "INVALID_TOOL_INPUT"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_TIMEOUT"
  | "AUDIT_WRITE_FAILED"
  | "APPROVAL_REQUIRED"
  | "PERMISSION_DENIED"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type AgentResponse =
  | {
      readonly status: "completed";
      readonly requestId: string;
      readonly conversationId: string;
      readonly content: string;
      readonly receivedAt: string;
      readonly completedAt: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "failed" | "cancelled";
      readonly requestId: string;
      readonly conversationId: string;
      readonly error: AgentError;
      readonly receivedAt: string;
      readonly completedAt: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "approval_required" | "denied";
      readonly requestId: string;
      readonly conversationId: string;
      readonly toolId: string;
      readonly executionId: string;
      readonly toolCallId: string;
      readonly approvalId?: string;
      readonly error: AgentError;
      readonly receivedAt: string;
      readonly completedAt: string;
      readonly durationMs: number;
    };

export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

/** Safe approval metadata exposed to the local browser client. */
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly requestId: string;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly riskLevel: RiskLevel;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
}

export type AgentEvent =
  | AgentEventBase<"request.received">
  | AgentEventBase<"request.processing">
  | AgentEventBase<"provider.started">
  | AgentEventBase<"provider.completed">
  | AgentEventBase<
      "tool.requested",
      { readonly toolId: string; readonly executionId: string; readonly toolCallId: string }
    >
  | AgentEventBase<
      "tool.completed",
      {
        readonly toolId: string;
        readonly executionId: string;
        readonly toolCallId: string;
        readonly durationMs: number;
      }
    >
  | AgentEventBase<
      "tool.failed",
      {
        readonly toolId: string;
        readonly executionId: string;
        readonly toolCallId: string;
        readonly errorCode: AgentErrorCode;
        readonly durationMs: number;
      }
    >
  | AgentEventBase<
      "tool.denied",
      {
        readonly toolId: string;
        readonly executionId: string;
        readonly toolCallId: string;
        readonly durationMs: number;
      }
    >
  | AgentEventBase<
      "tool.approval_required",
      {
        readonly toolId: string;
        readonly executionId: string;
        readonly toolCallId: string;
        readonly durationMs: number;
      }
    >
  | AgentEventBase<"request.completed">
  | AgentEventBase<"request.failed", { readonly errorCode: AgentErrorCode }>;

export interface AgentEventBase<
  TType extends string,
  TMetadata extends Readonly<Record<string, string | number | boolean>> = Readonly<
    Record<string, never>
  >
> {
  readonly type: TType;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly conversationId: string;
  readonly channel: Channel;
  readonly metadata: TMetadata;
}

export interface AgentAuditRecord {
  readonly requestId: string;
  readonly conversationId: string;
  readonly channel: Channel;
  readonly operation: "agent.request";
  readonly status:
    | "started"
    | "completed"
    | "failed"
    | "cancelled"
    | "denied"
    | "approval_required";
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly errorCode?: AgentErrorCode;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface ToolAuditRecord {
  readonly executionId: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly approvalStatus?: "approved" | "denied" | "expired";
  readonly toolId: string;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly channel: Channel;
  readonly operation: "tool.execution";
  readonly status:
    | "requested"
    | "completed"
    | "failed"
    | "denied"
    | "approval_required"
    | "cancelled"
    | "timed_out";
  readonly occurredAt: string;
  readonly durationMs: number;
  readonly riskLevel?: RiskLevel;
  readonly policyOutcome?: PolicyDecision["outcome"];
  readonly errorCode?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface ApprovalAuditRecord {
  readonly status?: never;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly operation: "approval.decision";
  readonly requestId: string;
  readonly conversationId: string;
  readonly channel: Channel;
  readonly toolId: string;
  readonly toolCallId: string;
  readonly executionId: string;
  readonly approvalId: string;
  readonly riskLevel: RiskLevel;
  readonly decision: "requested" | "approved" | "denied" | "expired";
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export type AuditRecord = AgentAuditRecord | ToolAuditRecord | ApprovalAuditRecord;

export interface AuditSink {
  record(record: AuditRecord): void | Promise<void>;
}

export interface AssistantProfile {
  readonly assistant: { readonly name: string; readonly language: string };
  readonly user: { readonly displayName?: string };
  readonly ai: { readonly provider: string; readonly credentialRef?: string };
}

export interface ProjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
}
