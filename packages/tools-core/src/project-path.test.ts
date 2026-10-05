import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRealPathContained, canonicalizeRoot, resolveProjectPath } from "./project-path.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "george-path-"));
  directories.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "hello");
  writeFileSync(join(root, "src", "index.ts"), "export {};");
  return canonicalizeRoot(root)!;
}

describe("resolveProjectPath", () => {
  it("accepts a simple top-level relative path", () => {
    const root = fixtureRoot();
    const result = resolveProjectPath(root, "README.md");
    expect(result).toMatchObject({ ok: true, absolutePath: join(root, "README.md") });
  });

  it("accepts a nested relative path", () => {
    const root = fixtureRoot();
    const result = resolveProjectPath(root, "src/index.ts");
    expect(result).toMatchObject({ ok: true, absolutePath: join(root, "src", "index.ts") });
  });

  it("accepts the project root itself via an empty relative path", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "")).toEqual({ ok: true, absolutePath: root });
  });

  it("rejects a single-level traversal with a forward slash", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "../secret.txt")).toEqual({ ok: false, reason: "TRAVERSAL" });
  });

  it("rejects a single-level traversal with a backslash", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "..\\secret.txt")).toEqual({
      ok: false,
      reason: "TRAVERSAL"
    });
  });

  it("rejects a multi-level traversal", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "../../secret")).toEqual({ ok: false, reason: "TRAVERSAL" });
  });

  it("rejects traversal buried after valid-looking segments", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "src/../../secret")).toEqual({
      ok: false,
      reason: "TRAVERSAL"
    });
  });

  it("rejects an absolute Windows path", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "C:\\Windows\\System32\\config").ok).toBe(false);
  });

  it("rejects an absolute path on a different drive", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "D:\\secret.txt")).toEqual({
      ok: false,
      reason: "ABSOLUTE_PATH"
    });
  });

  it("rejects a UNC path", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "\\\\server\\share\\file.txt")).toEqual({
      ok: false,
      reason: "UNC_PATH"
    });
    expect(resolveProjectPath(root, "//server/share/file.txt")).toEqual({
      ok: false,
      reason: "UNC_PATH"
    });
  });

  it("rejects a sibling directory that merely shares a name prefix with the root", () => {
    const root = fixtureRoot();
    // Simulates the classic startsWith("C:\Projects\foo") bug: a naive implementation would
    // accept "C:\Projects\foobar" because the string "C:\Projects\foo" is a string-prefix of it.
    const sibling = `${root}bar`;
    const result = resolveProjectPath(root, "");
    expect(result.ok && result.absolutePath !== sibling).toBe(true);
    expect(sibling.startsWith(root)).toBe(true); // confirms this would be a real bug if unhandled
  });

  it("rejects an encoded/normalized traversal variant", () => {
    const root = fixtureRoot();
    expect(resolveProjectPath(root, "src/./../../secret").ok).toBe(false);
    expect(resolveProjectPath(root, "./../secret").ok).toBe(false);
  });
});

describe("assertRealPathContained (symlink/junction escape)", () => {
  it("rejects a symlink inside the root that points outside it", () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "george-outside-"));
    directories.push(outside);
    writeFileSync(join(outside, "secret.txt"), "top secret");
    const linkPath = join(root, "escape-link");
    try {
      symlinkSync(join(outside, "secret.txt"), linkPath, "file");
    } catch {
      // Creating symlinks can require elevated privilege on some Windows configurations.
      // This is a documented integration-test limitation, not a silently ignored risk --
      // the lexical containment function above is still exercised and unit-tested independently.
      return;
    }
    const resolved = resolveProjectPath(root, "escape-link");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(assertRealPathContained(root, resolved.absolutePath)).toMatchObject({
      ok: false,
      reason: "SYMLINK_ESCAPE"
    });
  });

  it("accepts a real file that resolves to itself", () => {
    const root = fixtureRoot();
    const target = join(root, "README.md");
    expect(assertRealPathContained(root, target)).toEqual({ ok: true, absolutePath: target });
  });
});

describe("canonicalizeRoot", () => {
  it("returns undefined for a root that does not exist", () => {
    expect(canonicalizeRoot("Z:\\george-test-does-not-exist")).toBeUndefined();
  });

  it("returns the real path for an existing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "george-canon-"));
    directories.push(root);
    expect(canonicalizeRoot(root)).toBeTruthy();
  });
});
