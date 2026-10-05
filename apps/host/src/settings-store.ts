import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  InvalidConfigurationError,
  parseAssistantProfile,
  type AssistantProfileConfig,
  type ProjectDefinition
} from "@george/config";
import { canonicalizeRoot } from "@george/tools-core";

export type SettingsPatch = {
  readonly assistant?: Partial<AssistantProfileConfig["assistant"]>;
  readonly user?: Partial<AssistantProfileConfig["user"]>;
  readonly ai?: {
    readonly provider?: AssistantProfileConfig["ai"]["provider"];
    readonly credentialRef?: string;
    readonly ollama?: { readonly model?: string };
  };
};

export type ProjectInput = {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly rootPath: string;
  readonly defaultApplicationId?: string;
};
export type ProjectPatch = Partial<Omit<ProjectInput, "id">>;

export class ProjectValidationError extends Error {
  readonly code:
    | "PROJECT_ALREADY_EXISTS"
    | "PROJECT_NOT_FOUND"
    | "PROJECT_ROOT_UNAVAILABLE"
    | "PROJECT_CONFIGURATION_INVALID";
  constructor(code: ProjectValidationError["code"], message: string) {
    super(message);
    this.name = "ProjectValidationError";
    this.code = code;
  }
}

/** Trims, resolves, and proves a project root exists and is a directory. Never trusted blindly. */
function validateRootPath(rootPath: string): string {
  const trimmed = rootPath.trim();
  const canonical = canonicalizeRoot(trimmed);
  if (!canonical) {
    throw new ProjectValidationError(
      "PROJECT_ROOT_UNAVAILABLE",
      "The project root does not exist or is not accessible."
    );
  }
  try {
    if (!statSync(canonical).isDirectory()) {
      throw new ProjectValidationError(
        "PROJECT_ROOT_UNAVAILABLE",
        "The project root must be a directory."
      );
    }
  } catch (error) {
    if (error instanceof ProjectValidationError) throw error;
    throw new ProjectValidationError(
      "PROJECT_ROOT_UNAVAILABLE",
      "The project root does not exist or is not accessible."
    );
  }
  return canonical;
}

/**
 * Persists the installation-owned assistant profile (name, language, AI provider
 * and model selection) outside the repository. Never stores secrets or
 * credential values -- only a future SecretStore resolves those by reference.
 */
export class SettingsStore {
  #current: AssistantProfileConfig;

  constructor(
    private readonly path: string,
    defaults: AssistantProfileConfig
  ) {
    this.#current = this.#readFromDisk() ?? defaults;
  }

  get(): AssistantProfileConfig {
    return this.#current;
  }

  update(patch: SettingsPatch): AssistantProfileConfig {
    return this.#writeProjects(this.#current.projects, patch);
  }

  listProjects(): readonly ProjectDefinition[] {
    return this.#current.projects;
  }

  addProject(input: ProjectInput): ProjectDefinition {
    if (this.#current.projects.some((project) => project.id === input.id)) {
      throw new ProjectValidationError(
        "PROJECT_ALREADY_EXISTS",
        `A project with id "${input.id}" is already configured.`
      );
    }
    // Validated and canonicalized now, but every tool call re-resolves the root again at call
    // time (see ProjectRegistry.resolveRoot) -- this check only rejects an obviously bad save.
    validateRootPath(input.rootPath);
    const next: ProjectDefinition = {
      id: input.id,
      displayName: input.displayName,
      rootPath: input.rootPath.trim(),
      ...(input.description ? { description: input.description } : {}),
      ...(input.defaultApplicationId ? { defaultApplicationId: input.defaultApplicationId } : {})
    };
    this.#writeProjectsOrThrowValidation([...this.#current.projects, next]);
    return next;
  }

  updateProject(id: string, patch: ProjectPatch): ProjectDefinition {
    const existing = this.#current.projects.find((project) => project.id === id);
    if (!existing) {
      throw new ProjectValidationError(
        "PROJECT_NOT_FOUND",
        `No project with id "${id}" is configured.`
      );
    }
    const rootPath = patch.rootPath !== undefined ? patch.rootPath.trim() : existing.rootPath;
    if (patch.rootPath !== undefined) validateRootPath(rootPath);
    const updated: ProjectDefinition = {
      id: existing.id,
      displayName: patch.displayName ?? existing.displayName,
      rootPath,
      ...((patch.description ?? existing.description)
        ? { description: patch.description ?? existing.description }
        : {}),
      ...((patch.defaultApplicationId ?? existing.defaultApplicationId)
        ? { defaultApplicationId: patch.defaultApplicationId ?? existing.defaultApplicationId }
        : {})
    };
    this.#writeProjectsOrThrowValidation(
      this.#current.projects.map((project) => (project.id === id ? updated : project))
    );
    return updated;
  }

  /** Removes only George's configuration for this project. Never touches the filesystem. */
  removeProject(id: string): void {
    if (!this.#current.projects.some((project) => project.id === id)) {
      throw new ProjectValidationError(
        "PROJECT_NOT_FOUND",
        `No project with id "${id}" is configured.`
      );
    }
    this.#writeProjects(
      this.#current.projects.filter((project) => project.id !== id),
      {}
    );
  }

  #writeProjectsOrThrowValidation(projects: readonly ProjectDefinition[]): AssistantProfileConfig {
    try {
      return this.#writeProjects(projects, {});
    } catch (error) {
      if (error instanceof InvalidConfigurationError) {
        throw new ProjectValidationError("PROJECT_CONFIGURATION_INVALID", error.message);
      }
      throw error;
    }
  }

  #writeProjects(
    projects: readonly ProjectDefinition[],
    patch: SettingsPatch
  ): AssistantProfileConfig {
    const merged: unknown = {
      assistant: { ...this.#current.assistant, ...patch.assistant },
      user: { ...this.#current.user, ...patch.user },
      ai: {
        ...this.#current.ai,
        ...patch.ai,
        ...(patch.ai?.ollama || this.#current.ai.ollama
          ? { ollama: { ...this.#current.ai.ollama, ...patch.ai?.ollama } }
          : {})
      },
      projects
    };
    const validated = parseAssistantProfile(merged);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(validated, null, 2), "utf8");
    this.#current = validated;
    return validated;
  }

  #readFromDisk(): AssistantProfileConfig | undefined {
    try {
      const raw = readFileSync(this.path, "utf8");
      return parseAssistantProfile(JSON.parse(raw));
    } catch (error) {
      if (error instanceof InvalidConfigurationError) {
        throw new InvalidConfigurationError(
          `The settings file at ${this.path} is invalid: ${error.message}`
        );
      }
      return undefined;
    }
  }
}
