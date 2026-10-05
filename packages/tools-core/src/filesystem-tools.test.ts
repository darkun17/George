import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemListTool,
  createFilesystemReadTool,
  createFilesystemSearchTool
} from "./filesystem-tools.js";
import { ProjectRegistry, type ProjectDefinition } from "./project-registry.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixtureProject(): { readonly registry: ProjectRegistry; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "george-fs-"));
  directories.push(root);
  const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
  return { registry: new ProjectRegistry(() => projects), root };
}

const context = {
  executionId: "e",
  correlationId: "c",
  channel: "desktop" as const,
  startedAt: new Date().toISOString()
};

describe("filesystem.list", () => {
  it("lists entries of the project root by default", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, "README.md"), "hello");
    mkdirSync(join(root, "src"));
    const tool = createFilesystemListTool(registry);
    const result = await tool.handler({ projectId: "george" }, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    const names = result.output.entries.map((entry) => entry.name).sort();
    expect(names).toEqual(["README.md", "src"]);
  });

  it("lists a nested relative path", async () => {
    const { registry, root } = fixtureProject();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export {};");
    const tool = createFilesystemListTool(registry);
    const result = await tool.handler({ projectId: "george", relativePath: "src" }, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.entries.map((entry) => entry.name)).toEqual(["index.ts"]);
  });

  it("rejects a traversal attempt", async () => {
    const { registry } = fixtureProject();
    const tool = createFilesystemListTool(registry);
    const result = await tool.handler({ projectId: "george", relativePath: "../" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "PATH_OUTSIDE_PROJECT" } });
  });

  it("fails closed for an unknown project", async () => {
    const { registry } = fixtureProject();
    const tool = createFilesystemListTool(registry);
    const result = await tool.handler({ projectId: "unknown" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "PROJECT_NOT_FOUND" } });
  });
});

describe("filesystem.read", () => {
  it("reads a normal UTF-8 text file", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, "README.md"), "# Hello\nWorld", "utf8");
    const tool = createFilesystemReadTool(registry);
    const result = await tool.handler({ projectId: "george", relativePath: "README.md" }, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.content).toBe("# Hello\nWorld");
    expect(result.output.encoding).toBe("utf-8");
  });

  it("reports FILE_NOT_FOUND for a missing file", async () => {
    const { registry } = fixtureProject();
    const tool = createFilesystemReadTool(registry);
    const result = await tool.handler(
      { projectId: "george", relativePath: "missing.txt" },
      context
    );
    expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
  });

  it("reports FILE_NOT_FOUND (not a crash) when a directory is passed instead of a file", async () => {
    const { registry, root } = fixtureProject();
    mkdirSync(join(root, "src"));
    const tool = createFilesystemReadTool(registry);
    const result = await tool.handler({ projectId: "george", relativePath: "src" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
  });

  it("rejects a file larger than the maximum readable size", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));
    const tool = createFilesystemReadTool(registry);
    const result = await tool.handler({ projectId: "george", relativePath: "big.txt" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "FILE_TOO_LARGE" } });
  });

  it("rejects a binary file", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const tool = createFilesystemReadTool(registry);
    const result = await tool.handler({ projectId: "george", relativePath: "image.png" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "BINARY_FILE_UNSUPPORTED" } });
  });

  it("denies a sensitive file by policy, before checking existence", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, ".env"), "SECRET=1");
    const tool = createFilesystemReadTool(registry);
    const existing = await tool.handler({ projectId: "george", relativePath: ".env" }, context);
    expect(existing).toMatchObject({ status: "failed", error: { code: "SENSITIVE_FILE_DENIED" } });
    const nonExisting = await tool.handler(
      { projectId: "george", relativePath: "nested/.env.production" },
      context
    );
    expect(nonExisting).toMatchObject({
      status: "failed",
      error: { code: "SENSITIVE_FILE_DENIED" }
    });
  });

  it("rejects a traversal attempt rather than reading outside the root", async () => {
    const { registry, root } = fixtureProject();
    const outside = mkdtempSync(join(tmpdir(), "george-fs-outside-"));
    directories.push(outside);
    writeFileSync(join(outside, "secret.txt"), "top secret");
    const tool = createFilesystemReadTool(registry);
    const result = await tool.handler(
      { projectId: "george", relativePath: `../${basename(outside)}/secret.txt` },
      context
    );
    expect(result).toMatchObject({ status: "failed", error: { code: "PATH_OUTSIDE_PROJECT" } });
    void root;
  });
});

describe("filesystem.search", () => {
  it("finds a plain-text match across multiple files with line number and snippet", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, "a.ts"), "const needle = 1;\nconst other = 2;");
    writeFileSync(join(root, "b.ts"), "// no match here");
    const tool = createFilesystemSearchTool(registry);
    const result = await tool.handler({ projectId: "george", query: "needle" }, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.matches).toEqual([
      { relativePath: "a.ts", lineNumber: 1, snippet: "const needle = 1;" }
    ]);
  });

  it("ignores node_modules and other generated directories", async () => {
    const { registry, root } = fixtureProject();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "needle");
    writeFileSync(join(root, "app.ts"), "needle");
    const tool = createFilesystemSearchTool(registry);
    const result = await tool.handler({ projectId: "george", query: "needle" }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.matches.map((match) => match.relativePath)).toEqual(["app.ts"]);
  });

  it("skips a binary file without crashing", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(
      join(root, "image.bin"),
      Buffer.from([0, 1, 2, 3, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65])
    );
    writeFileSync(join(root, "app.ts"), "needle");
    const tool = createFilesystemSearchTool(registry);
    const result = await tool.handler({ projectId: "george", query: "needle" }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.matches.map((match) => match.relativePath)).toEqual(["app.ts"]);
  });

  it("caps the number of results and reports truncation", async () => {
    const { registry, root } = fixtureProject();
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(root, `f${index}.ts`), "needle\nneedle\nneedle");
    }
    const tool = createFilesystemSearchTool(registry);
    const result = await tool.handler(
      { projectId: "george", query: "needle", maxResults: 3 },
      context
    );
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.matches).toHaveLength(3);
    expect(result.output.truncated).toBe(true);
  });

  it("maintains path containment and never scans outside the project root", async () => {
    const { registry, root } = fixtureProject();
    const outside = mkdtempSync(join(tmpdir(), "george-fs-search-outside-"));
    directories.push(outside);
    writeFileSync(join(outside, "secret.txt"), "needle-outside");
    writeFileSync(join(root, "app.ts"), "needle-inside");
    const tool = createFilesystemSearchTool(registry);
    const result = await tool.handler({ projectId: "george", query: "needle" }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.matches.every((match) => !match.relativePath.includes(".."))).toBe(true);
    expect(result.output.matches.map((match) => match.relativePath)).toEqual(["app.ts"]);
  });

  it("excludes sensitive files from search results and snippets", async () => {
    const { registry, root } = fixtureProject();
    writeFileSync(join(root, ".env"), "SECRET_NEEDLE=1");
    writeFileSync(join(root, "app.ts"), "needle");
    const tool = createFilesystemSearchTool(registry);
    const result = await tool.handler({ projectId: "george", query: "needle" }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.matches.map((match) => match.relativePath)).toEqual(["app.ts"]);
  });
});
