import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationRegistry } from "./application-registry.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeInstall(): {
  readonly environment: Record<string, string>;
  readonly vscodePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "george-apps-"));
  directories.push(root);
  const vscodeDir = join(root, "Programs", "Microsoft VS Code");
  mkdirSync(vscodeDir, { recursive: true });
  const vscodePath = join(vscodeDir, "Code.exe");
  writeFileSync(vscodePath, "not a real binary");
  return {
    environment: {
      LOCALAPPDATA: root,
      ProgramFiles: join(root, "pf-missing"),
      "ProgramFiles(x86)": join(root, "pf-x86-missing"),
      SystemRoot: join(root, "system-root-missing")
    },
    vscodePath
  };
}

describe("ApplicationRegistry", () => {
  it("resolves a known application only when a candidate path actually exists", () => {
    const { environment, vscodePath } = fakeInstall();
    const registry = new ApplicationRegistry(environment);
    expect(registry.resolve("vscode")).toBe(vscodePath);
    expect(registry.resolve("chrome")).toBeUndefined();
  });

  it("returns undefined for an unknown application id, never guessing a path", () => {
    const registry = new ApplicationRegistry({});
    expect(registry.resolve("totally-unknown-app")).toBeUndefined();
    expect(registry.get("totally-unknown-app")).toBeUndefined();
  });

  it("lists every known application with a real availability flag, never raw paths", () => {
    const { environment } = fakeInstall();
    const registry = new ApplicationRegistry(environment);
    const list = registry.list();
    expect(list.find((app) => app.id === "vscode")).toMatchObject({ available: true });
    expect(list.find((app) => app.id === "chrome")).toMatchObject({ available: false });
    expect(JSON.stringify(list)).not.toMatch(/\.exe|Programs|Program Files/i);
  });

  it("never searches recursively or accepts an arbitrary path as an application id", () => {
    const { environment, vscodePath } = fakeInstall();
    const registry = new ApplicationRegistry(environment);
    expect(registry.resolve(vscodePath)).toBeUndefined();
    expect(registry.resolve("../../etc")).toBeUndefined();
  });
});
