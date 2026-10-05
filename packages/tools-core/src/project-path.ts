import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type PathRejectionReason =
  | "ABSOLUTE_PATH"
  | "UNC_PATH"
  | "TRAVERSAL"
  | "OUTSIDE_ROOT"
  | "SYMLINK_ESCAPE";

export type PathResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: PathRejectionReason };

const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;
const UNC_OR_DEVICE_PREFIX = /^[\\/]{2}/; // \\server\share or //server/share

/**
 * Resolves a model/caller-supplied relative path against a trusted, already-canonicalized
 * project root, and proves containment. This is deliberately NOT a `startsWith` check --
 * `startsWith` alone would let "C:\Projects\foo" authorize "C:\Projects\foobar". Containment
 * is proven by resolving to an absolute path and requiring it to equal the root or start with
 * `root + path.sep`.
 *
 * Only handles the lexical/canonical-root half of containment. Callers that will perform real
 * I/O (read/list/search) must additionally call `assertRealPathContained` once the target is
 * known to exist, to catch a symlink/junction inside the root that points outside it.
 */
export function resolveProjectPath(canonicalRoot: string, relativePath: string): PathResolution {
  const input = relativePath.trim();
  if (input.length === 0) return { ok: true, absolutePath: canonicalRoot };

  if (UNC_OR_DEVICE_PREFIX.test(input)) return { ok: false, reason: "UNC_PATH" };
  if (isAbsolute(input) || WINDOWS_DRIVE_PREFIX.test(input)) {
    return { ok: false, reason: "ABSOLUTE_PATH" };
  }

  // Reject any ".." segment outright rather than trusting path.resolve's normalization alone --
  // this keeps the rejection reason precise ("TRAVERSAL") instead of a generic "OUTSIDE_ROOT".
  const segments = input.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, reason: "TRAVERSAL" };
  }

  const resolved = resolve(canonicalRoot, input);
  const rootWithSep = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  if (resolved !== canonicalRoot && !resolved.startsWith(rootWithSep)) {
    return { ok: false, reason: "OUTSIDE_ROOT" };
  }
  return { ok: true, absolutePath: resolved };
}

/**
 * Final defense-in-depth check once the target is known to exist: resolves symlinks/junctions
 * on both the root and the target and re-proves containment on the *real* paths. A reparse
 * point inside an otherwise-valid root can point anywhere on disk; this catches that case.
 * Throws if either path cannot be stat'd (caller should treat that as NOT_FOUND).
 */
export function assertRealPathContained(
  canonicalRoot: string,
  absolutePath: string
): PathResolution {
  const realRoot = realpathSync.native(canonicalRoot);
  const realTarget = realpathSync.native(absolutePath);
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    return { ok: false, reason: "SYMLINK_ESCAPE" };
  }
  return { ok: true, absolutePath: realTarget };
}

/** Canonicalizes a configured project root once; returns undefined if it cannot be resolved. */
export function canonicalizeRoot(rootPath: string): string | undefined {
  try {
    return realpathSync.native(rootPath);
  } catch {
    return undefined;
  }
}
