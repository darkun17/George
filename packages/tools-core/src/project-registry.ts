import { statSync } from "node:fs";
import { canonicalizeRoot } from "./project-path.js";

/** Structurally compatible with @george/config's ProjectDefinition; tools-core stays dependency-free of config. */
export interface ProjectDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly rootPath: string;
  readonly defaultApplicationId?: string | undefined;
}

export type ProjectRootStatus =
  | { readonly available: true; readonly canonicalRoot: string }
  | { readonly available: false };

/**
 * The only source of project identity the AI may reference. Reads the current project list via
 * a getter (rather than a frozen snapshot) so that adding/editing/removing a project in Settings
 * takes effect immediately, without requiring a Host restart. Every root is re-validated on each
 * resolution -- a configured root can disappear or change after it was first saved (TOCTOU), so
 * nothing is cached long-term.
 */
export class ProjectRegistry {
  constructor(private readonly getProjects: () => readonly ProjectDefinition[]) {}

  list(): readonly ProjectDefinition[] {
    return this.getProjects();
  }

  get(projectId: string): ProjectDefinition | undefined {
    return this.getProjects().find((project) => project.id === projectId);
  }

  /** Re-resolves the project's root right now; never trusts a value cached from Settings-save time. */
  resolveRoot(projectId: string): ProjectRootStatus {
    const project = this.get(projectId);
    if (!project) return { available: false };
    const canonicalRoot = canonicalizeRoot(project.rootPath);
    if (!canonicalRoot) return { available: false };
    try {
      if (!statSync(canonicalRoot).isDirectory()) return { available: false };
    } catch {
      return { available: false };
    }
    return { available: true, canonicalRoot };
  }
}
