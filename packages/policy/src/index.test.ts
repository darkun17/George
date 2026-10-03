import { describe, expect, it } from "vitest";
import { DefaultPolicyEngine } from "./index.js";

describe("DefaultPolicyEngine", () => {
  const engine = new DefaultPolicyEngine();
  const request = {
    toolId: "system.info",
    riskLevel: "SAFE" as const,
    requiredPermissions: [] as string[],
    grantedPermissions: [] as string[]
  };

  it("allows safe tools when required permissions are present", () => {
    expect(engine.evaluate(request).outcome).toBe("ALLOW");
  });

  it("denies requests missing a required permission", () => {
    expect(engine.evaluate({ ...request, requiredPermissions: ["filesystem.read"] }).outcome).toBe(
      "DENY"
    );
  });

  it("asks for approval before high-risk execution", () => {
    expect(engine.evaluate({ ...request, riskLevel: "HIGH" }).outcome).toBe("ASK");
  });

  it("denies critical-risk execution by default", () => {
    expect(engine.evaluate({ ...request, riskLevel: "CRITICAL" }).outcome).toBe("DENY");
  });
});
