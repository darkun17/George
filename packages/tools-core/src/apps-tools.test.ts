import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "@george/protocol";
import { ApplicationRegistry } from "./application-registry.js";
import { createAppsListTool, createAppsOpenTool } from "./apps-tools.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const context: ToolExecutionContext = {
  executionId: "e",
  correlationId: "c",
  channel: "desktop",
  startedAt: new Date().toISOString()
};

// Every candidate-path env var must point somewhere that cannot possibly exist on the
// machine running this test -- an empty environment falls back to real default install
// paths (e.g. "C:\Program Files"), and a previous version of this test learned that the
// hard way by actually launching the machine's real Chrome.
const NO_SUCH_PATH_ENV = {
  LOCALAPPDATA: "Z:\\george-test-does-not-exist\\LOCALAPPDATA",
  ProgramFiles: "Z:\\george-test-does-not-exist\\ProgramFiles",
  "ProgramFiles(x86)": "Z:\\george-test-does-not-exist\\ProgramFilesX86",
  SystemRoot: "Z:\\george-test-does-not-exist\\SystemRoot"
};

function registryWithRealExecutable(): ApplicationRegistry {
  const root = mkdtempSync(join(tmpdir(), "george-apps-open-"));
  directories.push(root);
  const dir = join(root, "Programs", "Microsoft VS Code");
  mkdirSync(dir, { recursive: true });
  // A real, harmless executable: cmd.exe always exists on Windows CI runners
  // too, but to stay portable we fall back to notepad's own candidate check
  // and just assert on APPLICATION_UNAVAILABLE for the open-tool's safety
  // behavior instead of actually spawning in this test.
  writeFileSync(join(dir, "Code.exe"), "not a real binary");
  return new ApplicationRegistry({ ...NO_SUCH_PATH_ENV, LOCALAPPDATA: root });
}

describe("apps.list", () => {
  it("never exposes a filesystem path, only id/displayName/available", async () => {
    const tool = createAppsListTool(registryWithRealExecutable());
    const result = await tool.handler({}, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(JSON.stringify(result.output)).not.toMatch(/\.exe|Programs/i);
    expect(result.output.applications.find((app) => app.id === "vscode")).toMatchObject({
      available: true
    });
  });
});

describe("apps.open", () => {
  it("rejects an application id with no resolvable executable without spawning anything", async () => {
    const registry = new ApplicationRegistry(NO_SUCH_PATH_ENV);
    const tool = createAppsOpenTool(registry);
    const result = await tool.handler({ applicationId: "chrome" }, context);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "APPLICATION_UNAVAILABLE" }
    });
  });

  it("rejects an unknown applicationId the same way as a missing one", async () => {
    const registry = new ApplicationRegistry(NO_SUCH_PATH_ENV);
    const tool = createAppsOpenTool(registry);
    const result = await tool.handler({ applicationId: "not-a-real-app" }, context);
    expect(result).toMatchObject({ status: "failed" });
  });

  it("the tool input schema rejects a raw path or extra fields -- only applicationId is accepted", () => {
    const registry = new ApplicationRegistry(NO_SUCH_PATH_ENV);
    const tool = createAppsOpenTool(registry);
    expect(tool.inputSchema.safeParse({ applicationId: "vscode" }).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({ applicationId: "vscode", path: "C:\\evil.exe" }).success
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ command: "C:\\Windows\\System32\\cmd.exe /c calc" }).success
    ).toBe(false);
  });

  it("is declared HIGH risk requiring an explicit permission, matching the approval-gated design", () => {
    const tool = createAppsOpenTool(new ApplicationRegistry(NO_SUCH_PATH_ENV));
    expect(tool.riskLevel).toBe("HIGH");
    expect(tool.requiredPermissions).toEqual(["apps.open.execute"]);
  });

  it("builds a safe, trusted approval summary naming the application, not raw input", () => {
    const registry = registryWithRealExecutable();
    const tool = createAppsOpenTool(registry);
    expect(tool.describeForApproval?.({ applicationId: "vscode" })).toBe(
      "Abrir Visual Studio Code"
    );
    expect(tool.describeForApproval?.({ applicationId: "unknown-app" })).toBe(
      "Abrir una aplicación"
    );
  });
});
