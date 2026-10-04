import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  InvalidConfigurationError,
  parseAssistantProfile,
  type AssistantProfileConfig
} from "@george/config";

export type SettingsPatch = {
  readonly assistant?: Partial<AssistantProfileConfig["assistant"]>;
  readonly user?: Partial<AssistantProfileConfig["user"]>;
  readonly ai?: {
    readonly provider?: AssistantProfileConfig["ai"]["provider"];
    readonly credentialRef?: string;
    readonly ollama?: { readonly model?: string };
  };
};

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
    const merged: unknown = {
      assistant: { ...this.#current.assistant, ...patch.assistant },
      user: { ...this.#current.user, ...patch.user },
      ai: {
        ...this.#current.ai,
        ...patch.ai,
        ...(patch.ai?.ollama || this.#current.ai.ollama
          ? { ollama: { ...this.#current.ai.ollama, ...patch.ai?.ollama } }
          : {})
      }
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
