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
}

export type AnyToolDefinition = ToolDefinition<z.ZodType, unknown>;
