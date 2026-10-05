import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationRegistry } from "./application-registry.js";
import {
  createProjectInfoTool,
  createProjectListTool,
  createProjectOpenTool
} from "./project-tools.js";
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

function plainDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "george-ptools-"));
  directories.push(root);
  return root;
}

function gitRepo(): string {
  const root = plainDirectory();
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "hello");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  return root;
}

const NO_SUCH_PATH_ENV = {
  LOCALAPPDATA: "Z:\\george-test-does-not-exist\\LOCALAPPDATA",
  ProgramFiles: "Z:\\george-test-does-not-exist\\ProgramFiles",
  "ProgramFiles(x86)": "Z:\\george-test-does-not-exist\\ProgramFilesX86",
  SystemRoot: "Z:\\george-test-does-not-exist\\SystemRoot"
};

describe("project.list", () => {
  it("summarizes configured projects without exposing root paths", async () => {
    const root = gitRepo();
    const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
    const tool = createProjectListTool(
      new ProjectRegistry(() => projects),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({}, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.projects).toEqual([
      { projectId: "george", displayName: "George", rootAvailable: true, gitRepository: true }
    ]);
    expect(JSON.stringify(result.output)).not.toContain(root);
  });

  it("reports an unavailable root truthfully instead of hiding it", async () => {
    const projects: ProjectDefinition[] = [
      { id: "ghost", displayName: "Ghost", rootPath: "Z:\\george-test-does-not-exist" }
    ];
    const tool = createProjectListTool(
      new ProjectRegistry(() => projects),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({}, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.projects[0]).toMatchObject({ rootAvailable: false, gitRepository: false });
  });
});

describe("project.info", () => {
  it("includes branch information for a Git project", async () => {
    const root = gitRepo();
    const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
    const tool = createProjectInfoTool(
      new ProjectRegistry(() => projects),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({ projectId: "george" }, context);
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output).toMatchObject({ branch: "main", detached: false, gitRepository: true });
  });

  it("fails closed with PROJECT_NOT_FOUND for an unknown project id", async () => {
    const tool = createProjectInfoTool(
      new ProjectRegistry(() => []),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({ projectId: "unknown" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "PROJECT_NOT_FOUND" } });
  });
});

describe("project.open", () => {
  it("fails closed when the project has no default application and none was requested", async () => {
    const root = plainDirectory();
    const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
    const tool = createProjectOpenTool(
      new ProjectRegistry(() => projects),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({ projectId: "george" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "APPLICATION_UNAVAILABLE" } });
  });

  it("fails closed when the requested application is not in the trusted registry", async () => {
    const root = plainDirectory();
    const projects: ProjectDefinition[] = [{ id: "george", displayName: "George", rootPath: root }];
    const tool = createProjectOpenTool(
      new ProjectRegistry(() => projects),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({ projectId: "george", applicationId: "vscode" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "APPLICATION_UNAVAILABLE" } });
  });

  it("fails closed for an unknown project before touching the ApplicationRegistry", async () => {
    const tool = createProjectOpenTool(
      new ProjectRegistry(() => []),
      new ApplicationRegistry(NO_SUCH_PATH_ENV)
    );
    const result = await tool.handler({ projectId: "unknown", applicationId: "vscode" }, context);
    expect(result).toMatchObject({ status: "failed", error: { code: "PROJECT_NOT_FOUND" } });
  });

  it("is declared HIGH risk requiring an explicit permission, matching apps.open's approval gate", () => {
    const tool = createProjectOpenTool(new ProjectRegistry(() => []), new ApplicationRegistry({}));
    expect(tool.riskLevel).toBe("HIGH");
    expect(tool.requiredPermissions).toEqual(["projects.open.execute"]);
  });

  it("the input schema accepts only projectId and an optional known applicationId, never a path", () => {
    const tool = createProjectOpenTool(new ProjectRegistry(() => []), new ApplicationRegistry({}));
    expect(tool.inputSchema.safeParse({ projectId: "george" }).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({ projectId: "george", applicationId: "vscode" }).success
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({ projectId: "george", rootPath: "C:\\anything" }).success
    ).toBe(false);
  });

  it("builds a safe, trusted approval summary naming the project", () => {
    const projects: ProjectDefinition[] = [
      { id: "george", displayName: "George", rootPath: plainDirectory() }
    ];
    const tool = createProjectOpenTool(
      new ProjectRegistry(() => projects),
      new ApplicationRegistry({})
    );
    expect(tool.describeForApproval?.({ projectId: "george" })).toBe("Abrir proyecto George");
    expect(tool.describeForApproval?.({ projectId: "unknown" })).toBe("Abrir un proyecto");
  });
});
