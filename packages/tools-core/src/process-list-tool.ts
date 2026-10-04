import { spawn } from "node:child_process";
import type { ToolExecutionContext, ToolExecutionResult } from "@george/protocol";
import type { ToolDefinition } from "@george/tools-sdk";
import { z } from "zod";

const processListInputSchema = z.object({}).strict();

export interface ProcessInfo {
  readonly pid: number;
  readonly name: string;
}
interface ProcessListOutput {
  readonly processes: readonly ProcessInfo[];
  readonly truncated: boolean;
}

const MAX_PROCESSES = 200;

/**
 * Parses `tasklist /fo csv /nh` output into safe {pid, name} pairs. Command-line
 * arguments and other potentially sensitive columns are never requested or parsed.
 */
export function parseTasklistCsv(csv: string): readonly ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const columns = trimmed.match(/"([^"]*)"/g)?.map((value) => value.slice(1, -1));
    if (!columns || columns.length < 2) continue;
    const [name, pidText] = columns;
    const pid = Number(pidText);
    if (!name || !Number.isInteger(pid)) continue;
    processes.push({ pid, name });
  }
  return processes;
}

function runTasklist(timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const child = spawn("tasklist.exe", ["/fo", "csv", "/nh"], {
      shell: false,
      windowsHide: true
    });
    let stdout = "";
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
      child.kill();
      finish(() => reject(new Error("tasklist timed out")));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`tasklist exited with code ${code}`));
      });
    });
  });
}

export const systemProcessListTool: ToolDefinition<
  typeof processListInputSchema,
  ProcessListOutput
> = {
  id: "system.process.list",
  name: "List running processes",
  description: "List running process names and IDs. Never includes command-line arguments.",
  inputSchema: processListInputSchema,
  requiredPermissions: ["system.process.read"],
  riskLevel: "LOW",
  timeoutMs: 5_000,
  async handler(
    _input,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ProcessListOutput>> {
    try {
      const csv = await runTasklist(5_000, context.signal);
      const all = parseTasklistCsv(csv);
      return {
        status: "succeeded",
        output: { processes: all.slice(0, MAX_PROCESSES), truncated: all.length > MAX_PROCESSES }
      };
    } catch {
      return {
        status: "failed",
        error: { code: "PROCESS_LIST_FAILED", message: "Could not list processes." }
      };
    }
  }
};
