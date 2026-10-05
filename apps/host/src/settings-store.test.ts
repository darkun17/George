import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidConfigurationError } from "@george/config";
import { ProjectValidationError, SettingsStore } from "./settings-store.js";

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
  ai: { provider: "mock" as const },
  projects: []
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
      ai: { provider: "ollama", ollama: { model: "llama3.2:latest" } },
      projects: []
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

describe("SettingsStore project management", () => {
  function realDirectory(): string {
    const root = mkdtempSync(join(tmpdir(), "george-settings-project-"));
    directories.push(root);
    return root;
  }

  it("adds a valid project with a real, existing directory root", () => {
    const root = realDirectory();
    const store = new SettingsStore(temporaryPath(), defaults);
    const added = store.addProject({ id: "george", displayName: "George", rootPath: root });
    expect(added).toMatchObject({ id: "george", displayName: "George" });
    expect(store.listProjects()).toEqual([added]);
  });

  it("rejects a duplicate project id", () => {
    const root = realDirectory();
    const store = new SettingsStore(temporaryPath(), defaults);
    store.addProject({ id: "george", displayName: "George", rootPath: root });
    expect(() => store.addProject({ id: "george", displayName: "Again", rootPath: root })).toThrow(
      ProjectValidationError
    );
  });

  it("rejects a project whose root does not exist", () => {
    const store = new SettingsStore(temporaryPath(), defaults);
    expect(() =>
      store.addProject({
        id: "ghost",
        displayName: "Ghost",
        rootPath: "Z:\\george-test-does-not-exist"
      })
    ).toThrow(ProjectValidationError);
  });

  it("rejects a project whose root is a file, not a directory", () => {
    const root = realDirectory();
    const filePath = join(root, "not-a-directory.txt");
    writeFileSync(filePath, "hello");
    const store = new SettingsStore(temporaryPath(), defaults);
    expect(() =>
      store.addProject({ id: "george", displayName: "George", rootPath: filePath })
    ).toThrow(ProjectValidationError);
  });

  it("rejects an unsafe, non-machine-readable project id", () => {
    const root = realDirectory();
    const store = new SettingsStore(temporaryPath(), defaults);
    expect(() =>
      store.addProject({ id: "My Project!", displayName: "George", rootPath: root })
    ).toThrow(ProjectValidationError);
  });

  it("updates a project's display name without requiring the root again", () => {
    const root = realDirectory();
    const store = new SettingsStore(temporaryPath(), defaults);
    store.addProject({ id: "george", displayName: "George", rootPath: root });
    const updated = store.updateProject("george", { displayName: "George (renamed)" });
    expect(updated.displayName).toBe("George (renamed)");
    expect(updated.rootPath).toBe(root);
  });

  it("fails closed when updating an unknown project", () => {
    const store = new SettingsStore(temporaryPath(), defaults);
    expect(() => store.updateProject("unknown", { displayName: "x" })).toThrow(
      ProjectValidationError
    );
  });

  it("removes only George's configuration -- never touches the real directory on disk", () => {
    const root = realDirectory();
    const store = new SettingsStore(temporaryPath(), defaults);
    store.addProject({ id: "george", displayName: "George", rootPath: root });
    store.removeProject("george");
    expect(store.listProjects()).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });

  it("fails closed when removing an unknown project", () => {
    const store = new SettingsStore(temporaryPath(), defaults);
    expect(() => store.removeProject("unknown")).toThrow(ProjectValidationError);
  });

  it("CRITICAL: updating unrelated settings (assistant/ai) never silently wipes configured projects", () => {
    const root = realDirectory();
    const path = temporaryPath();
    const store = new SettingsStore(path, defaults);
    store.addProject({ id: "george", displayName: "George", rootPath: root });
    store.update({ assistant: { name: "Jarvis" } });
    expect(store.listProjects()).toHaveLength(1);
    const reopened = new SettingsStore(path, defaults);
    expect(reopened.listProjects()).toHaveLength(1);
  });

  it("persists project configuration across reopening the store", () => {
    const root = realDirectory();
    const path = temporaryPath();
    const store = new SettingsStore(path, defaults);
    store.addProject({ id: "george", displayName: "George", rootPath: root });
    const reopened = new SettingsStore(path, defaults);
    expect(reopened.listProjects()).toEqual(store.listProjects());
  });
});
