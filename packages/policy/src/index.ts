import type { PolicyDecision, RiskLevel } from "@george/protocol";

export interface PolicyRequest {
  readonly toolId: string;
  readonly riskLevel: RiskLevel;
  readonly requiredPermissions: readonly string[];
  readonly grantedPermissions: readonly string[];
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision;
}

export class DefaultPolicyEngine implements PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision {
    if (request.riskLevel === "CRITICAL") {
      return { outcome: "DENY", reason: "Critical-risk tools are denied by default." };
    }

    const missing = request.requiredPermissions.filter(
      (permission) => !request.grantedPermissions.includes(permission)
    );
    if (missing.length > 0) {
      return {
        outcome: "DENY",
        reason: `Required permissions are not granted: ${missing.join(", ")}.`
      };
    }

    if (request.riskLevel === "HIGH") {
      return { outcome: "ASK", reason: "High-risk tool execution requires approval." };
    }

    return { outcome: "ALLOW", reason: "Risk and required permissions are within policy." };
  }
}
