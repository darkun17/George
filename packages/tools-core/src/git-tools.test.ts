import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitBranchCurrentTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool
} from "./git-tools.js";
import { ProjectRegistry, type ProjectDefinition } from "./project-registry.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const context = {
  executionId: "e",
  correlationId: "c",
  channel: "desktop" as const,
  startedAt: new Date().toISOString()
};

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "george-gtools-"));
  directories.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "hello");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function plainDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "george-gtools-plain-"));
  directories.push(root);
  return root;
}

function registryFor(root: string): ProjectRegistry {
  const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
  return new ProjectRegistry(() => projects);
}

describe("git.status", () => {
  it("reports a clean tree for a configured project", async () => {
    const tool = createGitStatusTool(registryFor(gitRepo()));
    const result = await tool.handler({ projectId: "george" }, context);
    expect(result).toMatchObject({ status: "succeeded", output: { clean: true, branch: "main" } });
  });

  it("returns NOT_A_GIT_REPOSITORY for a non-git project, not a raw error", async () => {
    const tool = createGitStatusTool(registryFor(plainDirectory()));
    const result = await tool.handler({ projectId: "george" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "NOT_A_GIT_REPOSITORY" } });
  });

  it("fails closed for an unknown project", async () => {
    const tool = createGitStatusTool(new ProjectRegistry(() => []));
    const result = await tool.handler({ projectId: "unknown" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "PROJECT_NOT_FOUND" } });
  });

  it("is read-only: declared permissions and risk never imply a write capability", () => {
    const tool = createGitStatusTool(new ProjectRegistry(() => []));
    expect(tool.riskLevel).toBe("LOW");
    expect(tool.requiredPermissions).toEqual(["git.read"]);
  });
});

describe("git.branch.current", () => {
  it("returns the current branch", async () => {
    const tool = createGitBranchCurrentTool(registryFor(gitRepo()));
    const result = await tool.handler({ projectId: "george" }, context);
    expect(result).toMatchObject({
      status: "succeeded",
      output: { branch: "main", detached: false }
    });
  });
});

describe("git.log", () => {
  it("returns bounded commit entries", async () => {
    const tool = createGitLogTool(registryFor(gitRepo()));
    const result = await tool.handler({ projectId: "george", limit: 5 }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect((result.output as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("the input schema bounds limit to a safe maximum, never raw git args", () => {
    const tool = createGitLogTool(new ProjectRegistry(() => []));
    expect(tool.inputSchema.safeParse({ projectId: "george", limit: 50 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ projectId: "george", limit: 51 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ projectId: "george", gitArgs: ["--help"] }).success).toBe(
      false
    );
  });
});

describe("git.diff", () => {
  it("returns the working diff for an uncommitted change", async () => {
    const root = gitRepo();
    writeFileSync(join(root, "README.md"), "hello changed\n");
    const tool = createGitDiffTool(registryFor(root));
    const result = await tool.handler({ projectId: "george" }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect((result.output as { scope: string }).scope).toBe("working");
    expect((result.output as { content: string }).content).toContain("README.md");
  });

  it("the input schema never accepts raw refs, revision ranges, or flags", () => {
    const tool = createGitDiffTool(new ProjectRegistry(() => []));
    expect(tool.inputSchema.safeParse({ projectId: "george", scope: "staged" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ projectId: "george", scope: "HEAD~5..HEAD" }).success).toBe(
      false
    );
    expect(tool.inputSchema.safeParse({ projectId: "george", flags: ["-U999"] }).success).toBe(
      false
    );
  });
});
