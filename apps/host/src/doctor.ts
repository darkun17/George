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
  readonly git: readonly DoctorCheck[];
  readonly projects: readonly DoctorCheck[];
}

export interface ProjectDoctorStatus {
  readonly id: string;
  readonly displayName: string;
  readonly rootAvailable: boolean;
  readonly gitRepository: boolean;
  readonly defaultApplicationAvailable?: boolean;
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
  /** Bounded, timed-out probe -- never shells out without a timeout. */
  readonly gitAvailable: () => Promise<{ readonly available: boolean; readonly version?: string }>;
  /** Per-project status without any recursive filesystem scan. */
  readonly projectStatuses: () => Promise<readonly ProjectDoctorStatus[]>;
  readonly clock?: () => Date;
}

export async function buildDoctorReport(deps: DoctorDependencies): Promise<DoctorReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const aiInfo = await deps.aiProvider.management.getInfo().catch(() => undefined);
  const git = await deps.gitAvailable().catch(() => ({ available: false }));
  const projects = await deps.projectStatuses().catch(() => []);
  const invalidProjectCount = projects.filter((project) => !project.rootAvailable).length;

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
    ],
    git: [
      {
        id: "executable",
        state: git.available ? "AVAILABLE" : "UNAVAILABLE",
        ...("version" in git && git.version ? { detail: git.version } : {})
      }
    ],
    projects: [
      {
        id: "registry",
        state: "AVAILABLE",
        detail: `${projects.length} configured, ${invalidProjectCount} with an unavailable root`
      },
      ...projects.map((project) => ({
        id: `project:${project.id}`,
        state: (project.rootAvailable ? "AVAILABLE" : "UNAVAILABLE") as DoctorState,
        detail: project.displayName
      }))
    ]
  };
}
