import { describe, expect, it, vi } from "vitest";
import type {
  AuditRecord,
  PolicyDecision,
  ToolExecutionContext,
  ToolExecutionResult
} from "@george/protocol";
import { DefaultPolicyEngine, type PolicyEngine, type PolicyRequest } from "@george/policy";
import type { ToolDefinition } from "@george/tools-sdk";
import { z } from "zod";
import {
  InMemoryToolRegistry,
  ToolRuntime,
  systemInfoTool,
  type ToolExecutionRequest
} from "./index.js";

const schema = z.object({ value: z.string() }).strict();
type ToolOutput = { readonly echoed: string };

function createTool(
  overrides: Partial<ToolDefinition<typeof schema, ToolOutput>> = {}
): ToolDefinition<typeof schema, ToolOutput> {
  return {
    id: "test.echo",
    name: "Echo",
    description: "Echo a test value.",
    inputSchema: schema,
    requiredPermissions: ["test.echo.read"],
    riskLevel: "SAFE",
    timeoutMs: 100,
    async handler(input): Promise<ToolExecutionResult<ToolOutput>> {
      return { status: "succeeded", output: { echoed: input.value } };
    },
    ...overrides
  };
}

function setup(
  options: {
    readonly decision?: PolicyDecision;
    readonly policyEngine?: PolicyEngine;
    readonly tool?: ToolDefinition<typeof schema, ToolOutput>;
    readonly timeoutMs?: number;
  } = {}
) {
  const registry = new InMemoryToolRegistry();
  const tool = options.tool ?? createTool();
  registry.register(tool);
  const auditRecords: AuditRecord[] = [];
  const defaultPolicy = new DefaultPolicyEngine();
  const evaluate = vi.fn<PolicyEngine["evaluate"]>(
    (request: PolicyRequest) => options.decision ?? defaultPolicy.evaluate(request)
  );
  const policyEngine: PolicyEngine = options.policyEngine ?? { evaluate };
  const runtime = new ToolRuntime({
    registry,
    policyEngine,
    auditSink: {
      record: (record) => {
        auditRecords.push(record);
      }
    },
    ...(options.timeoutMs ? { defaultTimeoutMs: options.timeoutMs } : {}),
    createId: () => "generated-id"
  });
  const request: ToolExecutionRequest = {
    executionId: "execution-fixed",
    toolId: tool.id,
    input: { value: "hello" },
    channel: "desktop",
    grantedPermissions: ["test.echo.read"],
    requestId: "request-fixed",
    conversationId: "conversation-fixed"
  };
  return { registry, runtime, request, tool, evaluate, auditRecords };
}

describe("InMemoryToolRegistry", () => {
  it("registers, resolves, and lists only safe metadata", () => {
    const registry = new InMemoryToolRegistry();
    const tool = createTool();
    registry.register(tool);
    expect(registry.get(tool.id)).toBe(tool);
    expect(registry.listMetadata()).toEqual([
      {
        id: "test.echo",
        name: "Echo",
        description: "Echo a test value.",
        riskLevel: "SAFE",
        requiredPermissions: ["test.echo.read"],
        timeoutMs: 100,
        availability: "AVAILABLE"
      }
    ]);
    expect(registry.listMetadata()[0]).not.toHaveProperty("handler");
    expect(registry.listMetadata()[0]).not.toHaveProperty("inputSchema");
    expect(registry.get("missing.tool")).toBeUndefined();
    const aiTools = registry.listAITools();
    expect(aiTools).toMatchObject([
      {
        id: "test.echo",
        description: "Echo a test value.",
        inputSchema: { type: "object", required: ["value"] }
      }
    ]);
    expect(aiTools[0]).not.toHaveProperty("handler");
    expect(aiTools[0]).not.toHaveProperty("riskLevel");
    expect(aiTools[0]).not.toHaveProperty("requiredPermissions");
  });

  it("rejects duplicate and malformed machine ids", () => {
    const registry = new InMemoryToolRegistry();
    registry.register(createTool());
    expect(() => registry.register(createTool())).toThrow(/already registered/);
    expect(() => registry.register(createTool({ id: "test" }))).toThrow(/machine identifier/);
    expect(() => registry.register(createTool({ id: "test.timeout", timeoutMs: 0 }))).toThrow(
      /positive finite/
    );
  });
});

describe("ToolRuntime policy gate", () => {
  it("evaluates policy and runs an allowed handler exactly once", async () => {
    const handler = vi.fn(createTool().handler);
    const { runtime, request, evaluate } = setup({ tool: createTool({ handler }) });
    await expect(runtime.execute(request)).resolves.toMatchObject({
      status: "completed",
      executionId: "execution-fixed",
      requestId: "request-fixed",
      conversationId: "conversation-fixed",
      policyOutcome: "ALLOW",
      output: { echoed: "hello" }
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("evaluates policy before invoking the handler", async () => {
    const order: string[] = [];
    const tool = createTool({
      async handler(input): Promise<ToolExecutionResult<ToolOutput>> {
        order.push("handler");
        return { status: "succeeded", output: { echoed: input.value } };
      }
    });
    const policyEngine: PolicyEngine = {
      evaluate(request) {
        order.push("policy");
        return new DefaultPolicyEngine().evaluate(request);
      }
    };
    const { runtime, request } = setup({ tool, policyEngine });
    await runtime.execute(request);
    expect(order).toEqual(["policy", "handler"]);
  });

  it.each([
    [{ outcome: "ASK", reason: "approval" }, "approval_required", "APPROVAL_REQUIRED"],
    [{ outcome: "DENY", reason: "denied" }, "denied", "PERMISSION_DENIED"]
  ] as const)("never calls a handler for %s", async (decision, status, code) => {
    const handler = vi.fn(createTool().handler);
    const { runtime, request, evaluate } = setup({
      decision,
      tool: createTool({ handler })
    });
    await expect(runtime.execute(request)).resolves.toMatchObject({
      status,
      policyOutcome: decision.outcome,
      error: { code }
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies a missing permission and does not run the handler", async () => {
    const handler = vi.fn(createTool().handler);
    const { runtime, request } = setup({ tool: createTool({ handler }) });
    await expect(runtime.execute({ ...request, grantedPermissions: [] })).resolves.toMatchObject({
      status: "denied",
      error: { code: "PERMISSION_DENIED" }
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed if a policy implementation returns an unknown decision", async () => {
    const handler = vi.fn(createTool().handler);
    const invalidPolicy = {
      evaluate: () => ({ outcome: "UNRECOGNIZED", reason: "invalid" })
    } as unknown as PolicyEngine;
    const { runtime, request } = setup({
      policyEngine: invalidPolicy,
      tool: createTool({ handler })
    });
    await expect(runtime.execute(request)).resolves.toMatchObject({
      status: "failed",
      error: { code: "POLICY_EVALUATION_FAILED" }
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed if policy evaluation throws", async () => {
    const handler = vi.fn(createTool().handler);
    const policyEngine: PolicyEngine = {
      evaluate: () => {
        throw new Error("private policy detail");
      }
    };
    const { runtime, request } = setup({ policyEngine, tool: createTool({ handler }) });
    await expect(runtime.execute(request)).resolves.toMatchObject({
      status: "failed",
      error: { code: "TOOL_EXECUTION_FAILED" }
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not run a handler for invalid input", async () => {
    const handler = vi.fn(createTool().handler);
    const { runtime, request, evaluate } = setup({ tool: createTool({ handler }) });
    await expect(runtime.execute({ ...request, input: { value: 42 } })).resolves.toMatchObject({
      status: "failed",
      error: { code: "INVALID_TOOL_INPUT" }
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects unknown ids without resolving a handler", async () => {
    const { runtime, request, auditRecords } = setup();
    await expect(runtime.execute({ ...request, toolId: "system.missing" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "TOOL_NOT_FOUND" }
    });
    expect(auditRecords).toHaveLength(1);
  });
});

describe("ToolRuntime execution boundary", () => {
  it("maps handler failures to a safe error and audits without input/output", async () => {
    const tool = createTool({
      async handler(): Promise<ToolExecutionResult<ToolOutput>> {
        return {
          status: "failed",
          error: { code: "PRIVATE", message: "password=super-secret" }
        };
      }
    });
    const { runtime, request, auditRecords } = setup({ tool });
    const result = await runtime.execute(request);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "TOOL_EXECUTION_FAILED", message: "The tool could not be completed." }
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(auditRecords).toHaveLength(2);
    expect(auditRecords.at(-1)).toMatchObject({
      operation: "tool.execution",
      executionId: "execution-fixed",
      toolId: "test.echo",
      requestId: "request-fixed",
      conversationId: "conversation-fixed",
      status: "failed",
      policyOutcome: "ALLOW"
    });
    expect(JSON.stringify(auditRecords)).not.toContain("hello");
  });

  it("times out a handler and passes its AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    const tool = createTool({
      timeoutMs: 5,
      async handler(_input, context): Promise<ToolExecutionResult<ToolOutput>> {
        signal = context.signal;
        return await new Promise<ToolExecutionResult<ToolOutput>>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("raw timeout")), {
            once: true
          });
        });
      }
    });
    const { runtime, request, auditRecords } = setup({ tool });
    await expect(runtime.execute(request)).resolves.toMatchObject({
      status: "timed_out",
      error: { code: "TOOL_TIMEOUT" }
    });
    expect(signal?.aborted).toBe(true);
    expect(auditRecords.at(-1)).toMatchObject({ status: "timed_out", errorCode: "TOOL_TIMEOUT" });
  });

  it("cancels an allowed handler when the caller signal aborts", async () => {
    const tool = createTool({
      async handler(_input, context): Promise<ToolExecutionResult<ToolOutput>> {
        return await new Promise<ToolExecutionResult<ToolOutput>>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true
          });
        });
      }
    });
    const { runtime, request, auditRecords } = setup({ tool });
    const controller = new AbortController();
    const pending = runtime.execute({ ...request, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "TOOL_CANCELLED" }
    });
    expect(auditRecords.at(-1)).toMatchObject({ status: "cancelled" });
  });

  it("returns cancellation without invoking the handler for a pre-aborted signal", async () => {
    const handler = vi.fn(createTool().handler);
    const { runtime, request } = setup({ tool: createTool({ handler }) });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.execute({ ...request, signal: controller.signal })).resolves.toMatchObject(
      {
        status: "cancelled"
      }
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when the mandatory pre-execution audit write fails", async () => {
    const registry = new InMemoryToolRegistry();
    const handler = vi.fn(createTool().handler);
    registry.register(createTool({ handler }));
    const runtime = new ToolRuntime({
      registry,
      policyEngine: { evaluate: () => ({ outcome: "ALLOW", reason: "ok" }) },
      auditSink: { record: () => Promise.reject(new Error("audit detail")) }
    });
    await expect(
      runtime.execute({
        executionId: "e",
        toolId: "test.echo",
        input: { value: "safe" },
        channel: "desktop",
        grantedPermissions: ["test.echo.read"]
      })
    ).resolves.toMatchObject({ status: "failed", error: { code: "AUDIT_WRITE_FAILED" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("re-evaluates policy on approval and consumes the exact operation once", async () => {
    const handler = vi.fn(createTool().handler);
    const evaluate = vi
      .fn<PolicyEngine["evaluate"]>()
      .mockReturnValueOnce({ outcome: "ASK", reason: "approval" })
      .mockReturnValueOnce({ outcome: "ALLOW", reason: "approved" });
    const { runtime, request } = setup({
      tool: createTool({ handler }),
      policyEngine: { evaluate }
    });
    const pending = await runtime.execute({ ...request, toolCallId: "provider-call" });
    expect(pending.status).toBe("approval_required");
    if (pending.status !== "approval_required" || !pending.approvalHandle)
      throw new Error("Expected approval handle");
    await expect(
      runtime.executeApproved(
        pending.approvalHandle,
        { grantedPermissions: ["test.echo.read"], deniedPermissions: [] },
        "approval-id"
      )
    ).resolves.toMatchObject({ status: "completed" });
    await expect(runtime.executeApproved(pending.approvalHandle)).resolves.toMatchObject({
      status: "denied"
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not let approval override a newly denied permission", async () => {
    const handler = vi.fn(createTool().handler);
    const evaluate = vi
      .fn<PolicyEngine["evaluate"]>()
      .mockReturnValueOnce({ outcome: "ASK", reason: "approval" })
      .mockReturnValueOnce({ outcome: "DENY", reason: "permission revoked" });
    const { runtime, request } = setup({
      tool: createTool({ handler }),
      policyEngine: { evaluate }
    });
    const pending = await runtime.execute({ ...request, toolCallId: "provider-call" });
    if (pending.status !== "approval_required" || !pending.approvalHandle)
      throw new Error("Expected approval handle");
    await expect(runtime.executeApproved(pending.approvalHandle)).resolves.toMatchObject({
      status: "denied"
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("system.info", () => {
  it("returns the bounded safe information shape without user paths or environment", async () => {
    const context: ToolExecutionContext = {
      executionId: "e",
      correlationId: "c",
      channel: "desktop",
      startedAt: new Date().toISOString()
    };
    const result = await systemInfoTool.handler({}, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("Expected system information");
    expect(result.output).toEqual({
      platform: expect.any(String),
      architecture: expect.any(String),
      hostname: expect.any(String),
      cpuModel: expect.any(String),
      cpuCount: expect.any(Number),
      totalMemoryBytes: expect.any(Number),
      freeMemoryBytes: expect.any(Number),
      uptimeSeconds: expect.any(Number)
    });
    expect(result.output).not.toHaveProperty("home");
    expect(result.output).not.toHaveProperty("env");
  });
});
