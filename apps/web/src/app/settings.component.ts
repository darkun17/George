import { Component, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import {
  SettingsApiService,
  type AssistantSettings,
  type DoctorCheck,
  type DoctorReport
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

  async ngOnInit(): Promise<void> {
    await Promise.all([this.#loadSettings(), this.#loadDoctor()]);
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
}
