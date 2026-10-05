/** Centralized output/scan budgets for the M5.2 project/filesystem tools. */
export const PROJECT_LIST_MAX = 100;
export const DIRECTORY_LIST_MAX = 500;
export const FILE_READ_MAX_BYTES = 256 * 1024;
export const SEARCH_MAX_FILES_SCANNED = 2_000;
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
export const SEARCH_MAX_RESULTS = 100;
export const SEARCH_SNIPPET_MAX_CHARS = 200;
export const SEARCH_TIMEOUT_MS = 10_000;

export const SEARCH_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".angular",
  "vendor"
]);
