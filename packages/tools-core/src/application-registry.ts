import { existsSync } from "node:fs";
import { join } from "node:path";

export interface TrustedApplication {
  readonly id: string;
  readonly displayName: string;
  /** Absolute candidate paths checked in order; the first that exists is used. */
  readonly candidatePaths: readonly string[];
}

function windowsCandidates(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, TrustedApplication> {
  const programFiles = environment["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = environment["LOCALAPPDATA"] ?? "";
  const systemRoot = environment["SystemRoot"] ?? environment["windir"] ?? "C:\\Windows";

  return {
    vscode: {
      id: "vscode",
      displayName: "Visual Studio Code",
      candidatePaths: [
        join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
        join(programFiles, "Microsoft VS Code", "Code.exe")
      ]
    },
    chrome: {
      id: "chrome",
      displayName: "Google Chrome",
      candidatePaths: [
        join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
      ]
    },
    edge: {
      id: "edge",
      displayName: "Microsoft Edge",
      candidatePaths: [
        join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
      ]
    },
    notepad: {
      id: "notepad",
      displayName: "Notepad",
      candidatePaths: [join(systemRoot, "System32", "notepad.exe")]
    },
    explorer: {
      id: "explorer",
      displayName: "File Explorer",
      candidatePaths: [join(systemRoot, "explorer.exe")]
    }
  };
}

/**
 * The only source of application identity the AI may reference. The model sends
 * a trusted `applicationId`; it never supplies or influences an executable path.
 * Discovery checks only a short, curated list of well-known install locations --
 * never an arbitrary or recursive filesystem search.
 */
export class ApplicationRegistry {
  readonly #applications: ReadonlyMap<string, TrustedApplication>;

  constructor(environment: Readonly<Record<string, string | undefined>> = process.env) {
    this.#applications = new Map(Object.entries(windowsCandidates(environment)));
  }

  list(): readonly {
    readonly id: string;
    readonly displayName: string;
    readonly available: boolean;
  }[] {
    return [...this.#applications.values()].map((app) => ({
      id: app.id,
      displayName: app.displayName,
      available: this.resolve(app.id) !== undefined
    }));
  }

  /** Returns the first existing candidate path for a known application id, or undefined. */
  resolve(applicationId: string): string | undefined {
    const app = this.#applications.get(applicationId);
    if (!app) return undefined;
    return app.candidatePaths.find((path) => existsSync(path));
  }

  get(applicationId: string): TrustedApplication | undefined {
    return this.#applications.get(applicationId);
  }
}
