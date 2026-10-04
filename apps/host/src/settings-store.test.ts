import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidConfigurationError } from "@george/config";
import { SettingsStore } from "./settings-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "george-settings-test-"));
  directories.push(directory);
  return join(directory, "settings.json");
}

const defaults = {
  assistant: { name: "George", language: "es" },
  user: {},
  ai: { provider: "mock" as const }
};

describe("SettingsStore", () => {
  it("falls back to the provided defaults when no file exists yet", () => {
    const store = new SettingsStore(temporaryPath(), defaults);
    expect(store.get()).toEqual(defaults);
  });

  it("persists updates, merges partial patches, and survives reopening", () => {
    const path = temporaryPath();
    const first = new SettingsStore(path, defaults);
    const updated = first.update({
      assistant: { name: "George" },
      user: { displayName: "Dark" },
      ai: { provider: "ollama", ollama: { model: "llama3.2:latest" } }
    });
    expect(updated).toEqual({
      assistant: { name: "George", language: "es" },
      user: { displayName: "Dark" },
      ai: { provider: "ollama", ollama: { model: "llama3.2:latest" } }
    });

    const reopened = new SettingsStore(path, defaults);
    expect(reopened.get()).toEqual(updated);
  });

  it("switching back to mock drops the stale Ollama model selection", () => {
    const path = temporaryPath();
    const store = new SettingsStore(path, defaults);
    store.update({ ai: { provider: "ollama", ollama: { model: "qwen2.5-coder:14b" } } });
    const backToMock = store.update({ ai: { provider: "mock" } });
    expect(backToMock.ai).toEqual({ provider: "mock", ollama: { model: "qwen2.5-coder:14b" } });
  });

  it("rejects an invalid patch without corrupting the stored file", () => {
    const path = temporaryPath();
    const store = new SettingsStore(path, defaults);
    expect(() => store.update({ assistant: { name: "" } })).toThrow(InvalidConfigurationError);
    expect(store.get()).toEqual(defaults);
  });

  it("never persists a credentialRef-looking secret implicitly", () => {
    const path = temporaryPath();
    const store = new SettingsStore(path, defaults);
    store.update({ assistant: { name: "George" } });
    expect(JSON.stringify(store.get())).not.toMatch(/sk-|password|secret/i);
  });

  it("falls back to defaults if the settings file on disk is corrupted JSON", () => {
    const path = temporaryPath();
    writeFileSync(path, "{not json", "utf8");
    const store = new SettingsStore(path, defaults);
    expect(store.get()).toEqual(defaults);
  });

  it("throws when the settings file on disk fails schema validation", () => {
    const path = temporaryPath();
    writeFileSync(path, JSON.stringify({ assistant: { name: "" } }), "utf8");
    expect(() => new SettingsStore(path, defaults)).toThrow(InvalidConfigurationError);
  });
});
