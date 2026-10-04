import { arch, platform } from "node:os";
import type { AssistantProfileConfig } from "@george/config";
import type { ManagedAIProvider } from "@george/ai";

export type DoctorState =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "MISCONFIGURED"
  | "DISABLED"
  | "NOT_INSTALLED";

export interface DoctorCheck {
  readonly id: string;
  readonly state: DoctorState;
  readonly detail?: string;
}

export interface DoctorReport {
  readonly generatedAt: string;
  readonly core: readonly DoctorCheck[];
  readonly ai: readonly DoctorCheck[];
  readonly security: readonly DoctorCheck[];
  readonly system: readonly DoctorCheck[];
  readonly voice: readonly DoctorCheck[];
}

export interface DoctorDependencies {
  readonly aiProvider: ManagedAIProvider;
  readonly settings: AssistantProfileConfig;
  readonly sessionCount: () => number;
  readonly pendingApprovalCount: () => number;
  readonly auditHealthy: () => boolean;
  readonly trustedOriginCount: () => number;
  readonly appVersion: string;
  readonly dataDirectory: string;
  readonly clock?: () => Date;
}

export async function buildDoctorReport(deps: DoctorDependencies): Promise<DoctorReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const aiInfo = await deps.aiProvider.management.getInfo().catch(() => undefined);

  return {
    generatedAt: now.toISOString(),
    core: [
      { id: "host", state: "AVAILABLE" },
      { id: "agentRuntime", state: "AVAILABLE" },
      { id: "toolRuntime", state: "AVAILABLE" },
      { id: "policyEngine", state: "AVAILABLE" }
    ],
    ai: [
      {
        id: "provider",
        state: aiInfo?.status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
        detail: aiInfo?.id ?? deps.settings.ai.provider
      },
      {
        id: "selectedModel",
        state: aiInfo?.model ? "AVAILABLE" : "NOT_INSTALLED",
        ...(aiInfo?.model ? { detail: aiInfo.model } : {})
      },
      {
        id: "toolCalling",
        state: deps.aiProvider.capabilities.tools ? "AVAILABLE" : "UNAVAILABLE"
      }
    ],
    security: [
      { id: "session", state: deps.sessionCount() >= 0 ? "AVAILABLE" : "UNAVAILABLE" },
      { id: "csrf", state: "AVAILABLE" },
      {
        id: "originPolicy",
        state: deps.trustedOriginCount() > 0 ? "AVAILABLE" : "MISCONFIGURED",
        detail: `${deps.trustedOriginCount()} trusted origin(s)`
      },
      { id: "auditDatabase", state: deps.auditHealthy() ? "AVAILABLE" : "UNAVAILABLE" },
      {
        id: "pendingApprovals",
        state: "AVAILABLE",
        detail: String(deps.pendingApprovalCount())
      }
    ],
    system: [
      { id: "operatingSystem", state: "AVAILABLE", detail: platform() },
      { id: "architecture", state: "AVAILABLE", detail: arch() },
      { id: "version", state: "AVAILABLE", detail: deps.appVersion },
      { id: "dataDirectory", state: "AVAILABLE", detail: deps.dataDirectory }
    ],
    voice: [
      { id: "voiceService", state: "NOT_INSTALLED" },
      { id: "microphone", state: "NOT_INSTALLED" },
      { id: "speechToText", state: "NOT_INSTALLED" },
      { id: "textToSpeech", state: "NOT_INSTALLED" }
    ]
  };
}
