import { basename } from "node:path";

/**
 * Deny-by-default sensitive-file patterns, matched case-insensitively against the file's
 * basename. This runs after path containment/traversal checks and before any read, so a
 * traversal attempt combined with a sensitive name is still rejected as traversal first, and a
 * contained sensitive file is still denied regardless of which project it lives in.
 */
const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_rsa(\.pub)?$/i,
  /^id_ed25519(\.pub)?$/i,
  /^id_ecdsa(\.pub)?$/i,
  /^credentials?(\..+)?$/i,
  /^secrets?(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i
];

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const name = basename(normalized);
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}
