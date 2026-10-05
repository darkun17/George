import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitAdapter, GitOperationError, GitUnavailableError } from "./git-adapter.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A prior test that timed out may still hold the directory open briefly; best-effort cleanup.
    }
  }
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "george-git-"));
  directories.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
}

const adapter = new GitAdapter();

describe("GitAdapter.isRepository", () => {
  it("returns true for a real git repository", async () => {
    const root = initRepo();
    expect(await adapter.isRepository(root)).toBe(true);
  });

  it("returns false for a plain directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "george-not-git-"));
    directories.push(root);
    expect(await adapter.isRepository(root)).toBe(false);
  });
});

describe("GitAdapter.status", () => {
  it("reports a clean tree after a commit", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello");
    commitAll(root, "initial");
    const status = await adapter.status(root);
    expect(status.clean).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.detached).toBe(false);
  });

  it("reports an untracked file", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello");
    commitAll(root, "initial");
    writeFileSync(join(root, "new.txt"), "new");
    const status = await adapter.status(root);
    expect(status.clean).toBe(false);
    expect(status.untracked.map((entry) => entry.path)).toContain("new.txt");
  });

  it("reports a modified tracked file", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello");
    commitAll(root, "initial");
    writeFileSync(join(root, "a.txt"), "changed");
    const status = await adapter.status(root);
    expect(status.modified.map((entry) => entry.path)).toContain("a.txt");
  });

  it("reports a staged file", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello");
    commitAll(root, "initial");
    writeFileSync(join(root, "a.txt"), "changed");
    git(root, ["add", "a.txt"]);
    const status = await adapter.status(root);
    expect(status.staged.map((entry) => entry.path)).toContain("a.txt");
  });

  it("throws GitOperationError (not a raw error) for a non-git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "george-not-git-"));
    directories.push(root);
    await expect(adapter.status(root)).rejects.toBeInstanceOf(GitOperationError);
  });
});

describe("GitAdapter.currentBranch", () => {
  it("returns the current branch name", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello");
    commitAll(root, "initial");
    expect(await adapter.currentBranch(root)).toEqual({ branch: "main", detached: false });
  });

  it("reports detached HEAD with a short commit", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello");
    commitAll(root, "initial");
    git(root, ["checkout", "--detach", "HEAD"]);
    const result = await adapter.currentBranch(root);
    expect(result.detached).toBe(true);
    expect(result.branch).toBeNull();
    expect(result.shortCommit).toBeTruthy();
  });
});

describe("GitAdapter.log", () => {
  it("returns bounded structured entries", async () => {
    const root = initRepo();
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(root, "a.txt"), `v${index}`);
      commitAll(root, `commit ${index}`);
    }
    const result = await adapter.log(root, 10);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ subject: "commit 2", authorName: "Test" });
    expect(result.truncated).toBe(false);
  }, 15_000);

  it("truncates when more commits exist than the requested limit", async () => {
    const root = initRepo();
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(root, "a.txt"), `v${index}`);
      commitAll(root, `commit ${index}`);
    }
    const result = await adapter.log(root, 2);
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  }, 20_000);
});

describe("GitAdapter.diff", () => {
  it("returns the working-tree diff", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello\n");
    commitAll(root, "initial");
    writeFileSync(join(root, "a.txt"), "changed\n");
    const result = await adapter.diff(root, "working");
    expect(result.content).toContain("a.txt");
    expect(result.filesIncluded).toBe(1);
  });

  it("returns the staged diff separately from the working diff", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "hello\n");
    commitAll(root, "initial");
    writeFileSync(join(root, "a.txt"), "staged-change\n");
    git(root, ["add", "a.txt"]);
    writeFileSync(join(root, "a.txt"), "staged-change\nplus unstaged\n");
    const staged = await adapter.diff(root, "staged");
    const working = await adapter.diff(root, "working");
    expect(staged.content).toContain("staged-change");
    expect(working.content).not.toContain("-hello");
  });

  it("truncates an oversized diff and reports it", async () => {
    const root = initRepo();
    writeFileSync(join(root, "a.txt"), "x");
    commitAll(root, "initial");
    writeFileSync(join(root, "a.txt"), "y".repeat(100_000));
    const result = await adapter.diff(root, "working");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });
});

describe("GitAdapter failure modes", () => {
  it("rejects with GitUnavailableError when the git executable cannot be found", async () => {
    const root = mkdtempSync(join(tmpdir(), "george-git-missing-"));
    directories.push(root);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      await expect(adapter.isRepository(root)).resolves.toBe(false);
      await expect(adapter.status(root)).rejects.toBeInstanceOf(GitUnavailableError);
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});
