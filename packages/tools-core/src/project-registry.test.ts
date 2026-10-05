import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRegistry, type ProjectDefinition } from "./project-registry.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function realDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "george-project-"));
  directories.push(root);
  return root;
}

describe("ProjectRegistry", () => {
  it("lists and looks up a configured project by id", () => {
    const root = realDirectory();
    const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
    const registry = new ProjectRegistry(() => projects);
    expect(registry.list()).toEqual(projects);
    expect(registry.get("george")).toEqual(projects[0]);
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("resolves an available root for a valid, existing directory", () => {
    const root = realDirectory();
    const registry = new ProjectRegistry(() => [
      { id: "george", displayName: "George", rootPath: root }
    ]);
    const resolved = registry.resolveRoot("george");
    expect(resolved.available).toBe(true);
    if (resolved.available) expect(resolved.canonicalRoot).toBeTruthy();
  });

  it("reports an unavailable root when the configured path does not exist", () => {
    const registry = new ProjectRegistry(() => [
      { id: "george", displayName: "George", rootPath: "Z:\\george-test-does-not-exist" }
    ]);
    expect(registry.resolveRoot("george")).toEqual({ available: false });
  });

  it("reports an unavailable root when the configured path is a file, not a directory", () => {
    const root = realDirectory();
    const filePath = join(root, "not-a-directory.txt");
    writeFileSync(filePath, "hello");
    const registry = new ProjectRegistry(() => [
      { id: "george", displayName: "George", rootPath: filePath }
    ]);
    expect(registry.resolveRoot("george")).toEqual({ available: false });
  });

  it("returns unavailable for an unknown project id rather than throwing", () => {
    const registry = new ProjectRegistry(() => []);
    expect(registry.resolveRoot("unknown")).toEqual({ available: false });
  });

  it("always reads the live project list, so edits apply without reconstructing the registry", () => {
    let projects: ProjectDefinition[] = [];
    const registry = new ProjectRegistry(() => projects);
    expect(registry.list()).toEqual([]);
    const root = realDirectory();
    projects = [{ id: "george", displayName: "George", rootPath: root }];
    expect(registry.list()).toEqual(projects);
  });
});
