import type { RiskLevel, ToolExecutionContext, ToolExecutionResult } from "@george/protocol";
import type { z } from "zod";

export interface ToolDefinition<TInput extends z.ZodType, TOutput> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly requiredPermissions: readonly string[];
  readonly riskLevel: RiskLevel;
  readonly timeoutMs?: number;
  readonly handler: (
    input: z.output<TInput>,
    context: ToolExecutionContext
  ) => Promise<ToolExecutionResult<TOutput>>;
  /**
   * Builds a short, safe label shown to the human before they approve a pending
   * invocation (e.g. "Abrir Visual Studio Code"). Authored by trusted tool code,
   * never a passthrough of raw model input -- this is the only way validated
   * input may reach the approval UI.
   */
  readonly describeForApproval?: (input: z.output<TInput>) => string;
}

export type AnyToolDefinition = ToolDefinition<z.ZodType, unknown>;
