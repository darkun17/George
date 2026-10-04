import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolves George's per-user application data directory. Never inside the
 * repository and never shared across users; callers join their own file name.
 */
export function getAppDataDir(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment["LOCALAPPDATA"]) return join(environment["LOCALAPPDATA"], "George");
  if (environment["XDG_DATA_HOME"]) return join(environment["XDG_DATA_HOME"], "george");
  return join(homedir(), ".local", "share", "george");
}
