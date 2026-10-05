import { Component, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import {
  SettingsApiService,
  type ApplicationSummary,
  type AssistantSettings,
  type DoctorCheck,
  type DoctorReport,
  type ProjectSummary
} from "./settings-api.service.js";

/** Safe, user-facing label for a Doctor check state. Never implies a hardcoded "always green" result. */
export function doctorStateLabel(state: DoctorCheck["state"]): string {
  switch (state) {
    case "AVAILABLE":
      return "Disponible";
    case "UNAVAILABLE":
      return "No disponible";
    case "MISCONFIGURED":
      return "Mal configurado";
    case "DISABLED":
      return "Deshabilitado";
    case "NOT_INSTALLED":
      return "No instalado";
  }
}

const DOCTOR_CHECK_LABELS: Readonly<Record<string, string>> = {
  host: "Host",
  agentRuntime: "AgentRuntime",
  toolRuntime: "ToolRuntime",
  policyEngine: "PolicyEngine",
  provider: "Proveedor de IA",
  selectedModel: "Modelo seleccionado",
  toolCalling: "Llamadas a herramientas",
  session: "Sesión local",
  csrf: "Protección CSRF",
  originPolicy: "Política de Origin",
  auditDatabase: "Base de auditoría",
  pendingApprovals: "Aprobaciones pendientes",
  operatingSystem: "Sistema operativo",
  architecture: "Arquitectura",
  version: "Versión",
  dataDirectory: "Directorio de datos",
  voiceService: "Servicio de voz",
  microphone: "Micrófono",
  speechToText: "Reconocimiento de voz",
  textToSpeech: "Síntesis de voz"
};

export function doctorCheckLabel(id: string): string {
  return DOCTOR_CHECK_LABELS[id] ?? id;
}

@Component({
  selector: "george-settings",
  standalone: true,
  templateUrl: "./settings.component.html"
})
export class SettingsComponent implements OnInit {
  readonly #api = inject(SettingsApiService);
  readonly doctorStateLabel = doctorStateLabel;
  readonly doctorCheckLabel = doctorCheckLabel;

  readonly settings = signal<AssistantSettings | null>(null);
  readonly doctor = signal<DoctorReport | null>(null);
  readonly ollamaModels = signal<readonly string[]>([]);
  readonly ollamaAvailable = signal(false);
  readonly saving = signal(false);
  readonly statusMessage = signal<string | null>(null);

  readonly assistantName = signal("");
  readonly assistantLanguage = signal("");
  readonly displayName = signal("");
  readonly provider = signal<"mock" | "ollama">("mock");
  readonly ollamaModel = signal("");

  readonly projects = signal<readonly ProjectSummary[]>([]);
  readonly applications = signal<readonly ApplicationSummary[]>([]);
  readonly editingProjectId = signal<string | null>(null);
  readonly projectFormId = signal("");
  readonly projectFormDisplayName = signal("");
  readonly projectFormDescription = signal("");
  readonly projectFormRootPath = signal("");
  readonly projectFormDefaultApplicationId = signal("");
  readonly projectFormOpen = signal(false);
  readonly projectFormError = signal<string | null>(null);
  readonly savingProject = signal(false);
  readonly confirmingRemoveProjectId = signal<string | null>(null);
  readonly projectStatusMessage = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.#loadSettings(),
      this.#loadDoctor(),
      this.#loadProjects(),
      this.#loadApplications()
    ]);
  }

  async #loadSettings(): Promise<void> {
    try {
      const settings = await this.#api.getSettings();
      this.settings.set(settings);
      this.assistantName.set(settings.assistant.name);
      this.assistantLanguage.set(settings.assistant.language);
      this.displayName.set(settings.user.displayName ?? "");
      this.provider.set(settings.ai.provider);
      this.ollamaModel.set(settings.ai.ollama?.model ?? "");
    } catch {
      this.statusMessage.set("No se pudo cargar la configuración.");
    }
  }

  async #loadDoctor(): Promise<void> {
    try {
      this.doctor.set(await this.#api.getDoctorReport());
    } catch {
      this.doctor.set(null);
    }
  }

  async #loadProjects(): Promise<void> {
    try {
      const result = await this.#api.getProjects();
      this.projects.set(result.projects);
    } catch {
      this.projects.set([]);
    }
  }

  async #loadApplications(): Promise<void> {
    try {
      const result = await this.#api.getApplications();
      this.applications.set(result.applications);
    } catch {
      this.applications.set([]);
    }
  }

  onAssistantNameInput(event: Event): void {
    this.assistantName.set((event.target as HTMLInputElement).value);
  }

  onAssistantLanguageInput(event: Event): void {
    this.assistantLanguage.set((event.target as HTMLInputElement).value);
  }

  onDisplayNameInput(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  async onProviderChange(value: string): Promise<void> {
    this.provider.set(value === "ollama" ? "ollama" : "mock");
    if (value === "ollama" && this.ollamaModels().length === 0) {
      await this.discoverModels();
    }
  }

  async onProviderSelectChange(event: Event): Promise<void> {
    await this.onProviderChange((event.target as HTMLSelectElement).value);
  }

  onModelSelectChange(event: Event): void {
    this.ollamaModel.set((event.target as HTMLSelectElement).value);
  }

  async discoverModels(): Promise<void> {
    try {
      const result = await this.#api.discoverOllamaModels();
      this.ollamaAvailable.set(result.available);
      this.ollamaModels.set(result.models);
    } catch {
      this.ollamaAvailable.set(false);
      this.ollamaModels.set([]);
    }
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.statusMessage.set(null);
    try {
      const updated = await this.#api.updateSettings({
        assistant: { name: this.assistantName(), language: this.assistantLanguage() },
        user: this.displayName() ? { displayName: this.displayName() } : {},
        ai:
          this.provider() === "ollama"
            ? { provider: "ollama", ollama: { model: this.ollamaModel() } }
            : { provider: "mock" }
      });
      this.settings.set(updated);
      this.statusMessage.set("Configuración guardada.");
      await this.#loadDoctor();
    } catch {
      this.statusMessage.set("No se pudo guardar la configuración.");
    } finally {
      this.saving.set(false);
    }
  }

  startAddProject(): void {
    this.editingProjectId.set(null);
    this.projectFormId.set("");
    this.projectFormDisplayName.set("");
    this.projectFormDescription.set("");
    this.projectFormRootPath.set("");
    this.projectFormDefaultApplicationId.set("");
    this.projectFormError.set(null);
    this.projectFormOpen.set(true);
  }

  startEditProject(project: ProjectSummary): void {
    this.editingProjectId.set(project.projectId);
    this.projectFormId.set(project.projectId);
    this.projectFormDisplayName.set(project.displayName);
    this.projectFormDescription.set(project.description ?? "");
    this.projectFormRootPath.set("");
    this.projectFormDefaultApplicationId.set("");
    this.projectFormError.set(null);
    this.projectFormOpen.set(true);
  }

  cancelProjectForm(): void {
    this.projectFormOpen.set(false);
    this.projectFormError.set(null);
  }

  onProjectFormIdInput(event: Event): void {
    this.projectFormId.set((event.target as HTMLInputElement).value);
  }

  onProjectFormDisplayNameInput(event: Event): void {
    this.projectFormDisplayName.set((event.target as HTMLInputElement).value);
  }

  onProjectFormDescriptionInput(event: Event): void {
    this.projectFormDescription.set((event.target as HTMLInputElement).value);
  }

  onProjectFormRootPathInput(event: Event): void {
    this.projectFormRootPath.set((event.target as HTMLInputElement).value);
  }

  onProjectFormDefaultApplicationChange(event: Event): void {
    this.projectFormDefaultApplicationId.set((event.target as HTMLSelectElement).value);
  }

  async saveProject(): Promise<void> {
    this.savingProject.set(true);
    this.projectFormError.set(null);
    try {
      const editingId = this.editingProjectId();
      const defaultApplicationId = this.projectFormDefaultApplicationId();
      const description = this.projectFormDescription();
      if (editingId) {
        await this.#api.updateProject(editingId, {
          displayName: this.projectFormDisplayName(),
          ...(description ? { description } : {}),
          ...(this.projectFormRootPath() ? { rootPath: this.projectFormRootPath() } : {}),
          ...(defaultApplicationId ? { defaultApplicationId } : {})
        });
      } else {
        await this.#api.addProject({
          id: this.projectFormId(),
          displayName: this.projectFormDisplayName(),
          ...(description ? { description } : {}),
          rootPath: this.projectFormRootPath(),
          ...(defaultApplicationId ? { defaultApplicationId } : {})
        });
      }
      this.projectFormOpen.set(false);
      await Promise.all([this.#loadProjects(), this.#loadDoctor()]);
    } catch {
      this.projectFormError.set(
        "No se pudo guardar el proyecto. Verifica la ruta y que el identificador no esté en uso."
      );
    } finally {
      this.savingProject.set(false);
    }
  }

  askRemoveProject(projectId: string): void {
    this.confirmingRemoveProjectId.set(projectId);
  }

  cancelRemoveProject(): void {
    this.confirmingRemoveProjectId.set(null);
  }

  async confirmRemoveProject(projectId: string): Promise<void> {
    this.projectStatusMessage.set(null);
    try {
      await this.#api.removeProject(projectId);
      this.confirmingRemoveProjectId.set(null);
      await Promise.all([this.#loadProjects(), this.#loadDoctor()]);
    } catch {
      this.projectStatusMessage.set("No se pudo quitar el proyecto.");
    }
  }
}
