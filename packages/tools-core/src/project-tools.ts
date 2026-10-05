import type { ToolExecutionResult } from "@george/protocol";
import type { ToolDefinition } from "@george/tools-sdk";
import { z } from "zod";
import type { ApplicationRegistry } from "./application-registry.js";
import { launchExecutable } from "./apps-tools.js";
import { GitAdapter } from "./git-adapter.js";
import type { ProjectDefinition, ProjectRegistry } from "./project-registry.js";
import { PROJECT_LIST_MAX } from "./output-limits.js";

const projectListInputSchema = z.object({}).strict();
interface ProjectSummary {
  readonly projectId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly rootAvailable: boolean;
  readonly gitRepository: boolean;
  readonly defaultApplicationAvailable?: boolean;
}
interface ProjectListOutput {
  readonly projects: readonly ProjectSummary[];
  readonly truncated: boolean;
}

const git = new GitAdapter();

async function summarizeProject(
  registry: ProjectRegistry,
  applications: ApplicationRegistry,
  project: ProjectDefinition
): Promise<ProjectSummary> {
  const rootStatus = registry.resolveRoot(project.id);
  const gitRepository = rootStatus.available && (await git.isRepository(rootStatus.canonicalRoot));
  return {
    projectId: project.id,
    displayName: project.displayName,
    ...(project.description ? { description: project.description } : {}),
    rootAvailable: rootStatus.available,
    gitRepository,
    ...(project.defaultApplicationId
      ? {
          defaultApplicationAvailable:
            applications.resolve(project.defaultApplicationId) !== undefined
        }
      : {})
  };
}

export function createProjectListTool(
  registry: ProjectRegistry,
  applications: ApplicationRegistry
): ToolDefinition<typeof projectListInputSchema, ProjectListOutput> {
  return {
    id: "project.list",
    name: "List projects",
    description: "List George's configured software projects and their basic availability.",
    inputSchema: projectListInputSchema,
    requiredPermissions: ["projects.list.read"],
    riskLevel: "SAFE",
    timeoutMs: 5_000,
    async handler(): Promise<ToolExecutionResult<ProjectListOutput>> {
      const all = registry.list();
      const bounded = all.slice(0, PROJECT_LIST_MAX);
      const projects = await Promise.all(
        bounded.map((project) => summarizeProject(registry, applications, project))
      );
      return {
        status: "succeeded",
        output: { projects, truncated: all.length > PROJECT_LIST_MAX }
      };
    }
  };
}

const projectInfoInputSchema = z.object({ projectId: z.string().trim().min(1) }).strict();
interface ProjectInfoOutput extends ProjectSummary {
  readonly branch?: string | null;
  readonly detached?: boolean;
}

export function createProjectInfoTool(
  registry: ProjectRegistry,
  applications: ApplicationRegistry
): ToolDefinition<typeof projectInfoInputSchema, ProjectInfoOutput> {
  return {
    id: "project.info",
    name: "Project info",
    description: "Show safe metadata for one configured project, by its trusted projectId.",
    inputSchema: projectInfoInputSchema,
    requiredPermissions: ["projects.read"],
    riskLevel: "SAFE",
    timeoutMs: 8_000,
    async handler({ projectId }): Promise<ToolExecutionResult<ProjectInfoOutput>> {
      const project = registry.get(projectId);
      if (!project) {
        return {
          status: "failed",
          error: { code: "PROJECT_NOT_FOUND", message: "Unknown project." }
        };
      }
      const summary = await summarizeProject(registry, applications, project);
      const rootStatus = registry.resolveRoot(projectId);
      if (!summary.gitRepository || !rootStatus.available) {
        return { status: "succeeded", output: summary };
      }
      try {
        const branch = await git.currentBranch(rootStatus.canonicalRoot);
        return {
          status: "succeeded",
          output: { ...summary, branch: branch.branch, detached: branch.detached }
        };
      } catch {
        return { status: "succeeded", output: summary };
      }
    }
  };
}

const projectOpenInputSchema = z
  .object({
    projectId: z.string().trim().min(1),
    applicationId: z.string().trim().min(1).optional()
  })
  .strict();
type ProjectOpenOutput = { readonly projectId: string; readonly launched: true };

export function createProjectOpenTool(
  registry: ProjectRegistry,
  applications: ApplicationRegistry
): ToolDefinition<typeof projectOpenInputSchema, ProjectOpenOutput> {
  return {
    id: "project.open",
    name: "Open project",
    description:
      "Open a configured project's folder in a trusted, pre-approved application. Accepts only " +
      "a trusted projectId and, optionally, a trusted applicationId already known to George -- " +
      "never a raw path or command.",
    inputSchema: projectOpenInputSchema,
    requiredPermissions: ["projects.open.execute"],
    riskLevel: "HIGH",
    timeoutMs: 10_000,
    async handler({ projectId, applicationId }): Promise<ToolExecutionResult<ProjectOpenOutput>> {
      const project = registry.get(projectId);
      if (!project) {
        return {
          status: "failed",
          error: { code: "PROJECT_NOT_FOUND", message: "Unknown project." }
        };
      }
      const rootStatus = registry.resolveRoot(projectId);
      if (!rootStatus.available) {
        return {
          status: "failed",
          error: { code: "PROJECT_ROOT_UNAVAILABLE", message: "The project root is not available." }
        };
      }
      const effectiveApplicationId = applicationId ?? project.defaultApplicationId;
      if (!effectiveApplicationId) {
        return {
          status: "failed",
          error: {
            code: "APPLICATION_UNAVAILABLE",
            message: "No application is configured for this project."
          }
        };
      }
      const resolvedExecutable = applications.resolve(effectiveApplicationId);
      if (!resolvedExecutable) {
        return {
          status: "failed",
          error: {
            code: "APPLICATION_UNAVAILABLE",
            message: "The requested application is not available."
          }
        };
      }
      if (!launchExecutable(resolvedExecutable, [rootStatus.canonicalRoot]).ok) {
        return {
          status: "failed",
          error: {
            code: "APPLICATION_LAUNCH_FAILED",
            message: "The application could not be started."
          }
        };
      }
      return { status: "succeeded", output: { projectId, launched: true } };
    },
    describeForApproval({ projectId }: { readonly projectId: string }): string {
      const project = registry.get(projectId);
      return project ? `Abrir proyecto ${project.displayName}` : "Abrir un proyecto";
    }
  };
}
