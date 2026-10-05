import { spawn } from "node:child_process";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // hard cap before any tool-level truncation
const DEFAULT_TIMEOUT_MS = 8_000;

export interface GitRunResult {
  readonly stdout: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

export class GitUnavailableError extends Error {}
export class GitOperationError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

/**
 * Runs a fixed git executable with a structured, internally-constructed argument array.
 * Never accepts caller-supplied argv; shell:false always; cwd must already be a trusted,
 * canonicalized project root resolved by ProjectRegistry before this is called.
 */
function runGit(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    let child;
    try {
      child = spawn("git", [...args], { cwd, shell: false, windowsHide: true });
    } catch (error) {
      reject(new GitUnavailableError(error instanceof Error ? error.message : "git unavailable"));
      return;
    }
    let stdout = "";
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new Error("Aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      if (stdout.length + chunk.length > MAX_BUFFER_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ENOENT") reject(new GitUnavailableError("git executable not found"));
        else reject(error);
      });
    });
    child.once("close", (code) => {
      finish(() => resolve({ stdout, code, timedOut }));
    });
  });
}

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
}
export interface GitStatusResult {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: readonly GitStatusEntry[];
  readonly modified: readonly GitStatusEntry[];
  readonly deleted: readonly GitStatusEntry[];
  readonly renamed: readonly GitStatusEntry[];
  readonly untracked: readonly GitStatusEntry[];
  readonly conflicted: readonly GitStatusEntry[];
  readonly clean: boolean;
  readonly truncated: boolean;
}

const STATUS_LIST_MAX = 200;

function parsePorcelainV2(stdout: string): GitStatusResult {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const staged: GitStatusEntry[] = [];
  const modified: GitStatusEntry[] = [];
  const deleted: GitStatusEntry[] = [];
  const renamed: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  const conflicted: GitStatusEntry[] = [];
  let truncated = false;
  const push = (list: GitStatusEntry[], entry: GitStatusEntry): void => {
    if (list.length >= STATUS_LIST_MAX) {
      truncated = true;
      return;
    }
    list.push(entry);
  };

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") detached = true;
      else branch = value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const x = xy[0];
      const y = xy[1];
      const pathPart = line.slice(line.indexOf("\t") >= 0 ? line.indexOf("\t") : 0);
      const rawPath = line.startsWith("2 ")
        ? parts.slice(9).join(" ").split("\t")[0]
        : parts.slice(8).join(" ");
      const path = rawPath || pathPart.trim();
      if (!path) continue;
      if (x === "D" || y === "D") push(deleted, { path });
      else if (line.startsWith("2 ")) push(renamed, { path });
      else if (y === "M") push(modified, { path });
      if (x !== "." && x !== "?") push(staged, { path });
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      if (path) push(conflicted, { path });
    } else if (line.startsWith("? ")) {
      const path = line.slice(2);
      if (path) push(untracked, { path });
    }
  }

  const clean =
    staged.length === 0 &&
    modified.length === 0 &&
    deleted.length === 0 &&
    renamed.length === 0 &&
    untracked.length === 0 &&
    conflicted.length === 0;

  return {
    branch,
    detached,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    staged,
    modified,
    deleted,
    renamed,
    untracked,
    conflicted,
    clean,
    truncated
  };
}

export interface GitLogEntry {
  readonly hash: string;
  readonly subject: string;
  readonly authorName: string;
  readonly timestamp: string;
}
export interface GitDiffResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly filesIncluded: number;
}

const GIT_LOG_DEFAULT_LIMIT = 10;
const GIT_LOG_MAX_LIMIT = 50;
const GIT_DIFF_MAX_BYTES = 32 * 1024;

export class GitAdapter {
  /** Bounded Doctor probe: is a git executable reachable at all, run from a neutral cwd. */
  async version(): Promise<{ readonly available: boolean; readonly version?: string }> {
    try {
      const result = await runGit(["--version"], process.cwd(), undefined, 3_000);
      if (result.code !== 0) return { available: false };
      const match = /git version (\S+)/.exec(result.stdout);
      return { available: true, ...(match?.[1] ? { version: match[1] } : {}) };
    } catch {
      return { available: false };
    }
  }

  async isRepository(cwd: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, signal);
      return result.code === 0 && result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async status(cwd: string, signal?: AbortSignal): Promise<GitStatusResult> {
    const result = await runGit(["status", "--porcelain=v2", "--branch"], cwd, signal);
    if (result.code !== 0) throw new GitOperationError("git status failed", result.code);
    return parsePorcelainV2(result.stdout);
  }

  async currentBranch(
    cwd: string,
    signal?: AbortSignal
  ): Promise<{
    readonly branch: string | null;
    readonly detached: boolean;
    readonly shortCommit?: string;
  }> {
    const branchResult = await runGit(["branch", "--show-current"], cwd, signal);
    if (branchResult.code !== 0)
      throw new GitOperationError("git branch failed", branchResult.code);
    const branch = branchResult.stdout.trim();
    if (branch) return { branch, detached: false };
    const commitResult = await runGit(["rev-parse", "--short", "HEAD"], cwd, signal);
    return {
      branch: null,
      detached: true,
      ...(commitResult.code === 0 && commitResult.stdout.trim()
        ? { shortCommit: commitResult.stdout.trim() }
        : {})
    };
  }

  async log(
    cwd: string,
    limit: number = GIT_LOG_DEFAULT_LIMIT,
    signal?: AbortSignal
  ): Promise<{ readonly entries: readonly GitLogEntry[]; readonly truncated: boolean }> {
    const boundedLimit = Math.max(1, Math.min(limit, GIT_LOG_MAX_LIMIT));
    const result = await runGit(
      ["log", `-n`, String(boundedLimit + 1), "--pretty=format:%h%x1f%s%x1f%an%x1f%aI"],
      cwd,
      signal
    );
    if (result.code !== 0) throw new GitOperationError("git log failed", result.code);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    const truncated = lines.length > boundedLimit;
    const entries = lines.slice(0, boundedLimit).map((line) => {
      const [hash, subject, authorName, timestamp] = line.split("\x1f");
      return {
        hash: hash ?? "",
        subject: subject ?? "",
        authorName: authorName ?? "",
        timestamp: timestamp ?? ""
      };
    });
    return { entries, truncated };
  }

  async diff(
    cwd: string,
    scope: "working" | "staged" = "working",
    signal?: AbortSignal
  ): Promise<GitDiffResult> {
    const args =
      scope === "staged" ? ["diff", "--staged", "--stat", "-p"] : ["diff", "--stat", "-p"];
    const result = await runGit(args, cwd, signal);
    if (result.code !== 0) throw new GitOperationError("git diff failed", result.code);
    const filesIncluded = (result.stdout.match(/^diff --git /gm) ?? []).length;
    const truncatedByBytes = Buffer.byteLength(result.stdout, "utf8") > GIT_DIFF_MAX_BYTES;
    const content = truncatedByBytes
      ? Buffer.from(result.stdout, "utf8").subarray(0, GIT_DIFF_MAX_BYTES).toString("utf8")
      : result.stdout;
    return { content, truncated: truncatedByBytes, filesIncluded };
  }
}
