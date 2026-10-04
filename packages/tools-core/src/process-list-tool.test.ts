import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "@george/protocol";
import { parseTasklistCsv, systemProcessListTool } from "./process-list-tool.js";

const context: ToolExecutionContext = {
  executionId: "e",
  correlationId: "c",
  channel: "desktop",
  startedAt: new Date().toISOString()
};

describe("parseTasklistCsv", () => {
  it("extracts only name and pid, never the full row or extra columns", () => {
    const csv =
      '"System Idle Process","0","Services","0","8 K"\r\n"notepad.exe","4821","Console","1","4,120 K"\r\n';
    expect(parseTasklistCsv(csv)).toEqual([
      { name: "System Idle Process", pid: 0 },
      { name: "notepad.exe", pid: 4821 }
    ]);
  });

  it("ignores malformed or empty lines without throwing", () => {
    expect(parseTasklistCsv("")).toEqual([]);
    expect(parseTasklistCsv("not,csv,at,all\r\n")).toEqual([]);
    expect(parseTasklistCsv('"onlyonecolumn"\r\n')).toEqual([]);
  });
});

describe("system.process.list", () => {
  it("is declared read-only, LOW risk, and bounded by a safe permission", () => {
    expect(systemProcessListTool.riskLevel).toBe("LOW");
    expect(systemProcessListTool.requiredPermissions).toEqual(["system.process.read"]);
  });

  it("lists real running processes with only safe {pid, name} fields, never raw command lines", async () => {
    const result = await systemProcessListTool.handler({}, context);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output.processes.length).toBeGreaterThan(0);
    for (const process of result.output.processes) {
      expect(typeof process.pid).toBe("number");
      expect(typeof process.name).toBe("string");
    }
    expect(JSON.stringify(result.output)).not.toMatch(/--|\.exe .+ --|cmdline/i);
  });

  it("fails closed (not throwing) if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await systemProcessListTool.handler(
      {},
      { ...context, signal: controller.signal }
    );
    expect(result.status).toBe("failed");
  });
});
