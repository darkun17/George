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
}
