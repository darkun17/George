import { arch, cpus, freemem, hostname, platform, totalmem, uptime } from "node:os";
import { z } from "zod";
import type { ToolDefinition } from "@george/tools-sdk";

export interface SystemInfo {
  readonly platform: string;
  readonly architecture: string;
  readonly hostname: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly uptimeSeconds: number;
}

export const systemInfoTool: ToolDefinition<z.ZodType, SystemInfo> = {
  id: "system.info",
  name: "System information",
  description: "Read basic operating system and hardware information.",
  inputSchema: z.object({}).strict(),
  requiredPermissions: ["system.info.read"],
  riskLevel: "SAFE",
  timeoutMs: 2_000,
  async handler(_input, context) {
    if (context.signal?.aborted) return { status: "cancelled", reason: "cancelled" };
    const cpuList = cpus();
    const result: SystemInfo = {
      platform: platform(),
      architecture: arch(),
      hostname: hostname(),
      cpuModel: cpuList[0]?.model ?? "unknown",
      cpuCount: cpuList.length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      uptimeSeconds: uptime()
    };
    return { status: "succeeded", output: result };
  }
};
