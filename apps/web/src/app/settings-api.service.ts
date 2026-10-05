import { Injectable, inject } from "@angular/core";
import { AgentApiError, AgentApiService, requireFetch } from "./agent-api.service.js";

export interface AssistantSettings {
  readonly assistant: { readonly name: string; readonly language: string };
  readonly user: { readonly displayName?: string };
  readonly ai: {
    readonly provider: "mock" | "ollama";
    readonly credentialRef?: string;
    readonly ollama?: { readonly model: string };
  };
}

export interface SettingsPatch {
  readonly assistant?: { readonly name?: string; readonly language?: string };
  readonly user?: { readonly displayName?: string };
  readonly ai?: {
    readonly provider?: "mock" | "ollama";
    readonly ollama?: { readonly model?: string };
  };
}

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

export interface ProjectSummary {
  readonly projectId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly rootAvailable: boolean;
  readonly gitRepository: boolean;
  readonly defaultApplicationAvailable?: boolean;
}

export interface ProjectInfo extends ProjectSummary {
  readonly branch?: string | null;
  readonly detached?: boolean;
}

export interface ProjectFormInput {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly rootPath: string;
  readonly defaultApplicationId?: string;
}
export type ProjectFormPatch = Partial<Omit<ProjectFormInput, "id">>;

export interface ApplicationSummary {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
}

@Injectable({ providedIn: "root" })
export class SettingsApiService {
  readonly #agentApi = inject(AgentApiService);

  async getSettings(): Promise<AssistantSettings> {
    const response = await requireFetch(
      "/api/v1/settings",
      { credentials: "same-origin" },
      "SETTINGS_UNAVAILABLE"
    );
    return (await response.json()) as AssistantSettings;
  }

  async updateSettings(patch: SettingsPatch): Promise<AssistantSettings> {
    const csrfToken = this.#agentApi.getCsrfToken();
    if (!csrfToken) throw new AgentApiError("HTTP", "La sesión local no está iniciada.");
    const response = await requireFetch(
      "/api/v1/settings",
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-George-CSRF": csrfToken },
        body: JSON.stringify(patch)
      },
      "La configuración enviada no es válida."
    );
    return (await response.json()) as AssistantSettings;
  }

  async discoverOllamaModels(): Promise<{
    readonly available: boolean;
    readonly models: readonly string[];
  }> {
    const response = await requireFetch(
      "/api/v1/ai/discover",
      { credentials: "same-origin" },
      "AI_DISCOVERY_UNAVAILABLE"
    );
    return (await response.json()) as { available: boolean; models: readonly string[] };
  }

  async getDoctorReport(): Promise<DoctorReport> {
    const response = await requireFetch(
      "/api/v1/doctor",
      { credentials: "same-origin" },
      "DOCTOR_UNAVAILABLE"
    );
    return (await response.json()) as DoctorReport;
  }

  async getProjects(): Promise<{
    readonly projects: readonly ProjectSummary[];
    readonly truncated: boolean;
  }> {
    const response = await requireFetch(
      "/api/v1/projects",
      { credentials: "same-origin" },
      "PROJECTS_UNAVAILABLE"
    );
    return (await response.json()) as { projects: readonly ProjectSummary[]; truncated: boolean };
  }

  #csrfOrThrow(): string {
    const csrfToken = this.#agentApi.getCsrfToken();
    if (!csrfToken) throw new AgentApiError("HTTP", "La sesión local no está iniciada.");
    return csrfToken;
  }

  async addProject(input: ProjectFormInput): Promise<ProjectSummary> {
    const response = await requireFetch(
      "/api/v1/settings/projects",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-George-CSRF": this.#csrfOrThrow() },
        body: JSON.stringify(input)
      },
      "No se pudo agregar el proyecto."
    );
    return (await response.json()) as ProjectSummary;
  }

  async updateProject(id: string, patch: ProjectFormPatch): Promise<ProjectSummary> {
    const response = await requireFetch(
      `/api/v1/settings/projects/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-George-CSRF": this.#csrfOrThrow() },
        body: JSON.stringify(patch)
      },
      "No se pudo actualizar el proyecto."
    );
    return (await response.json()) as ProjectSummary;
  }

  async removeProject(id: string): Promise<void> {
    await requireFetch(
      `/api/v1/settings/projects/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-George-CSRF": this.#csrfOrThrow() }
      },
      "No se pudo quitar el proyecto."
    );
  }

  async getApplications(): Promise<{ readonly applications: readonly ApplicationSummary[] }> {
    const response = await requireFetch(
      "/api/v1/applications",
      { credentials: "same-origin" },
      "APPLICATIONS_UNAVAILABLE"
    );
    return (await response.json()) as { applications: readonly ApplicationSummary[] };
  }

  async getProject(id: string): Promise<ProjectInfo & { readonly gitStatus?: unknown }> {
    const response = await requireFetch(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      { credentials: "same-origin" },
      "PROJECT_UNAVAILABLE"
    );
    return (await response.json()) as ProjectInfo & { readonly gitStatus?: unknown };
  }

  async openProject(
    id: string
  ): Promise<{ readonly status: string; readonly approvalId?: string }> {
    let response: Response;
    try {
      response = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/open`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-George-CSRF": this.#csrfOrThrow() }
      });
    } catch {
      throw new AgentApiError("NETWORK", "George Host no está disponible.");
    }
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null) {
      throw new AgentApiError("HTTP", "No se pudo abrir el proyecto.", response.status);
    }
    return result as { status: string; approvalId?: string };
  }
}
