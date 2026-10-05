import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ToolExecutionResult } from "@george/protocol";
import type { ToolDefinition } from "@george/tools-sdk";
import { z } from "zod";
import {
  DIRECTORY_LIST_MAX,
  FILE_READ_MAX_BYTES,
  SEARCH_EXCLUDED_DIRECTORY_NAMES,
  SEARCH_MAX_FILES_SCANNED,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_SNIPPET_MAX_CHARS,
  SEARCH_TIMEOUT_MS
} from "./output-limits.js";
import { assertRealPathContained, resolveProjectPath } from "./project-path.js";
import type { ProjectRegistry } from "./project-registry.js";
import { isSensitivePath } from "./sensitive-files.js";

type SafeError = { readonly code: string; readonly message: string };

function resolveReadableRoot(
  registry: ProjectRegistry,
  projectId: string
):
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly error: SafeError } {
  if (!registry.get(projectId)) {
    return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: "Unknown project." } };
  }
  const rootStatus = registry.resolveRoot(projectId);
  if (!rootStatus.available) {
    return {
      ok: false,
      error: { code: "PROJECT_ROOT_UNAVAILABLE", message: "The project root is not available." }
    };
  }
  return { ok: true, root: rootStatus.canonicalRoot };
}

function isBinaryContent(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8_000);
  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

// --- filesystem.list ---------------------------------------------------------------------

const filesystemListInputSchema = z
  .object({ projectId: z.string().trim().min(1), relativePath: z.string().max(4096).optional() })
  .strict();
interface DirectoryEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly type: "file" | "directory" | "other";
  readonly size?: number;
}
interface FilesystemListOutput {
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

export function createFilesystemListTool(
  registry: ProjectRegistry
): ToolDefinition<typeof filesystemListInputSchema, FilesystemListOutput> {
  return {
    id: "filesystem.list",
    name: "List project files",
    description:
      "List files and directories inside a configured project, by trusted projectId and relativePath.",
    inputSchema: filesystemListInputSchema,
    requiredPermissions: ["filesystem.list.read"],
    riskLevel: "LOW",
    timeoutMs: 5_000,
    async handler({ projectId, relativePath }): Promise<ToolExecutionResult<FilesystemListOutput>> {
      const rootResult = resolveReadableRoot(registry, projectId);
      if (!rootResult.ok) return { status: "failed", error: rootResult.error };
      const resolved = resolveProjectPath(rootResult.root, relativePath ?? "");
      if (!resolved.ok) {
        return {
          status: "failed",
          error: {
            code: "PATH_OUTSIDE_PROJECT",
            message: "The requested path is not inside the project."
          }
        };
      }
      let dirents;
      try {
        dirents = readdirSync(resolved.absolutePath, { withFileTypes: true });
      } catch {
        return {
          status: "failed",
          error: { code: "FILE_NOT_FOUND", message: "The requested path was not found." }
        };
      }
      const bounded = dirents.slice(0, DIRECTORY_LIST_MAX);
      const entries: DirectoryEntry[] = bounded.map((entry) => {
        const entryAbsolutePath = join(resolved.absolutePath, entry.name);
        const entryRelativePath = relative(rootResult.root, entryAbsolutePath).replace(/\\/g, "/");
        const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
        let size: number | undefined;
        if (type === "file") {
          try {
            size = statSync(entryAbsolutePath).size;
          } catch {
            size = undefined;
          }
        }
        return {
          name: entry.name,
          relativePath: entryRelativePath,
          type,
          ...(size !== undefined ? { size } : {})
        };
      });
      return {
        status: "succeeded",
        output: { entries, truncated: dirents.length > DIRECTORY_LIST_MAX }
      };
    }
  };
}

// --- filesystem.read ----------------------------------------------------------------------

const filesystemReadInputSchema = z
  .object({ projectId: z.string().trim().min(1), relativePath: z.string().min(1).max(4096) })
  .strict();
interface FilesystemReadOutput {
  readonly relativePath: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly encoding: "utf-8";
  readonly size: number;
}

export function createFilesystemReadTool(
  registry: ProjectRegistry
): ToolDefinition<typeof filesystemReadInputSchema, FilesystemReadOutput> {
  return {
    id: "filesystem.read",
    name: "Read project file",
    description:
      "Read a text file inside a configured project, by trusted projectId and relativePath. " +
      "Denies sensitive files (.env, keys, credentials) by policy before any read.",
    inputSchema: filesystemReadInputSchema,
    requiredPermissions: ["filesystem.read"],
    riskLevel: "LOW",
    timeoutMs: 5_000,
    async handler({ projectId, relativePath }): Promise<ToolExecutionResult<FilesystemReadOutput>> {
      const rootResult = resolveReadableRoot(registry, projectId);
      if (!rootResult.ok) return { status: "failed", error: rootResult.error };
      const resolved = resolveProjectPath(rootResult.root, relativePath);
      if (!resolved.ok) {
        return {
          status: "failed",
          error: {
            code: "PATH_OUTSIDE_PROJECT",
            message: "The requested path is not inside the project."
          }
        };
      }
      // Sensitive-file policy runs on the normalized relative path before any filesystem
      // access, so a denial never depends on -- or leaks -- whether the file actually exists.
      if (isSensitivePath(relativePath)) {
        return {
          status: "failed",
          error: {
            code: "SENSITIVE_FILE_DENIED",
            message: "This file is protected and cannot be read."
          }
        };
      }
      let fileStat;
      try {
        fileStat = statSync(resolved.absolutePath);
      } catch {
        return {
          status: "failed",
          error: { code: "FILE_NOT_FOUND", message: "The requested file was not found." }
        };
      }
      if (!fileStat.isFile()) {
        return {
          status: "failed",
          error: { code: "FILE_NOT_FOUND", message: "The requested file was not found." }
        };
      }
      const contained = assertRealPathContained(rootResult.root, resolved.absolutePath);
      if (!contained.ok) {
        return {
          status: "failed",
          error: {
            code: "PATH_OUTSIDE_PROJECT",
            message: "The requested path is not inside the project."
          }
        };
      }
      if (fileStat.size > FILE_READ_MAX_BYTES) {
        return {
          status: "failed",
          error: { code: "FILE_TOO_LARGE", message: "The file exceeds the maximum readable size." }
        };
      }
      const buffer = readFileSync(resolved.absolutePath);
      if (isBinaryContent(buffer)) {
        return {
          status: "failed",
          error: { code: "BINARY_FILE_UNSUPPORTED", message: "Binary files are not supported." }
        };
      }
      return {
        status: "succeeded",
        output: {
          relativePath: relativePath.replace(/\\/g, "/"),
          content: buffer.toString("utf8"),
          truncated: false,
          encoding: "utf-8",
          size: fileStat.size
        }
      };
    }
  };
}

// --- filesystem.search --------------------------------------------------------------------

const filesystemSearchInputSchema = z
  .object({
    projectId: z.string().trim().min(1),
    query: z.string().trim().min(1).max(200),
    fileExtension: z.string().trim().min(1).max(20).optional(),
    maxResults: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional()
  })
  .strict();
interface SearchMatch {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly snippet: string;
}
interface FilesystemSearchOutput {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
  readonly filesScanned: number;
}

export function createFilesystemSearchTool(
  registry: ProjectRegistry
): ToolDefinition<typeof filesystemSearchInputSchema, FilesystemSearchOutput> {
  return {
    id: "filesystem.search",
    name: "Search project files",
    description:
      "Search for a plain-text query inside a configured project's files. Skips generated " +
      "directories, binary files, and sensitive files. Bounded by file count, result count, and time.",
    inputSchema: filesystemSearchInputSchema,
    requiredPermissions: ["filesystem.search.read"],
    riskLevel: "LOW",
    timeoutMs: SEARCH_TIMEOUT_MS + 2_000,
    async handler({
      projectId,
      query,
      fileExtension,
      maxResults
    }): Promise<ToolExecutionResult<FilesystemSearchOutput>> {
      const rootResult = resolveReadableRoot(registry, projectId);
      if (!rootResult.ok) return { status: "failed", error: rootResult.error };

      const resultLimit = maxResults ?? SEARCH_MAX_RESULTS;
      const needle = query.toLowerCase();
      const matches: SearchMatch[] = [];
      let filesScanned = 0;
      let truncated = false;
      const deadline = Date.now() + SEARCH_TIMEOUT_MS;
      const queue: string[] = [rootResult.root];

      while (
        queue.length > 0 &&
        filesScanned < SEARCH_MAX_FILES_SCANNED &&
        matches.length < resultLimit
      ) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        const currentDir = queue.shift();
        if (currentDir === undefined) break;
        let dirents;
        try {
          dirents = readdirSync(currentDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of dirents) {
          if (entry.isDirectory()) {
            if (SEARCH_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
            queue.push(join(currentDir, entry.name));
            continue;
          }
          if (!entry.isFile()) continue;
          if (filesScanned >= SEARCH_MAX_FILES_SCANNED) {
            truncated = true;
            break;
          }
          const entryAbsolutePath = join(currentDir, entry.name);
          const entryRelativePath = relative(rootResult.root, entryAbsolutePath).replace(
            /\\/g,
            "/"
          );
          if (fileExtension && !entry.name.toLowerCase().endsWith(fileExtension.toLowerCase()))
            continue;
          if (isSensitivePath(entryRelativePath)) continue;
          filesScanned++;
          let fileStat;
          try {
            fileStat = statSync(entryAbsolutePath);
          } catch {
            continue;
          }
          if (fileStat.size > SEARCH_MAX_FILE_BYTES) continue;
          let buffer: Buffer;
          try {
            buffer = readFileSync(entryAbsolutePath);
          } catch {
            continue;
          }
          if (isBinaryContent(buffer)) continue;
          const lines = buffer.toString("utf8").split("\n");
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex] ?? "";
            if (!line.toLowerCase().includes(needle)) continue;
            matches.push({
              relativePath: entryRelativePath,
              lineNumber: lineIndex + 1,
              snippet: line.slice(0, SEARCH_SNIPPET_MAX_CHARS)
            });
            if (matches.length >= resultLimit) {
              truncated = true;
              break;
            }
          }
          if (matches.length >= resultLimit) break;
        }
      }
      if (queue.length > 0 && matches.length >= resultLimit) truncated = true;
      return { status: "succeeded", output: { matches, truncated, filesScanned } };
    }
  };
}
