import { spawn } from "node:child_process";
import type { ToolExecutionResult } from "@george/protocol";
import type { ToolDefinition } from "@george/tools-sdk";
import { z } from "zod";
import type { ApplicationRegistry } from "./application-registry.js";

/**
 * Spawns a resolved, trusted executable with a structured, internally-constructed argument
 * list. Shared by apps.open and project.open so there is exactly one place that ever calls
 * `spawn` for a desktop action -- never shell:true, never a caller-supplied path or argv.
 */
export function launchExecutable(
  resolvedPath: string,
  args: readonly string[] = []
): { readonly ok: true } | { readonly ok: false } {
  try {
    const child = spawn(resolvedPath, [...args], { shell: false, detached: true, stdio: "ignore" });
    child.on("error", () => {
      // Surfaces asynchronously after this function has already returned; detached + ignored
      // stdio means a launch failure here cannot affect the Agent response.
    });
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

const appsListInputSchema = z.object({}).strict();
interface AppsListOutput {
  readonly applications: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly available: boolean;
  }[];
}

export function createAppsListTool(
  registry: ApplicationRegistry
): ToolDefinition<typeof appsListInputSchema, AppsListOutput> {
  return {
    id: "apps.list",
    name: "List applications",
    description:
      "List the applications George is configured to open, and whether each is installed.",
    inputSchema: appsListInputSchema,
    requiredPermissions: ["apps.list.read"],
    riskLevel: "SAFE",
    timeoutMs: 2_000,
    async handler(): Promise<ToolExecutionResult<AppsListOutput>> {
      return { status: "succeeded", output: { applications: registry.list() } };
    }
  };
}

const appsOpenInputSchema = z.object({ applicationId: z.string().trim().min(1) }).strict();
type AppsOpenOutput = { readonly applicationId: string; readonly launched: true };

export function createAppsOpenTool(
  registry: ApplicationRegistry
): ToolDefinition<typeof appsOpenInputSchema, AppsOpenOutput> {
  return {
    id: "apps.open",
    name: "Open application",
    description:
      "Open one of George's known, pre-approved applications by its trusted applicationId. " +
      "Never accepts a raw executable path or command string.",
    inputSchema: appsOpenInputSchema,
    requiredPermissions: ["apps.open.execute"],
    riskLevel: "HIGH",
    timeoutMs: 10_000,
    async handler({ applicationId }): Promise<ToolExecutionResult<AppsOpenOutput>> {
      const resolvedPath = registry.resolve(applicationId);
      if (!resolvedPath) {
        return {
          status: "failed",
          error: {
            code: "APPLICATION_UNAVAILABLE",
            message: "The requested application is not available."
          }
        };
      }
      if (!launchExecutable(resolvedPath).ok) {
        return {
          status: "failed",
          error: {
            code: "APPLICATION_LAUNCH_FAILED",
            message: "The application could not be started."
          }
        };
      }
      return { status: "succeeded", output: { applicationId, launched: true } };
    },
    /** A safe, pre-approved label shown to the human before they approve the launch. */
    describeForApproval({ applicationId }: { readonly applicationId: string }): string {
      const app = registry.get(applicationId);
      return app ? `Abrir ${app.displayName}` : "Abrir una aplicación";
    }
  };
}
