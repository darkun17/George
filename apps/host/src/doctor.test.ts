import { describe, expect, it } from "vitest";
import type { ManagedAIProvider } from "@george/ai";
import { buildDoctorReport } from "./doctor.js";

const settings = {
  assistant: { name: "George", language: "es" },
  user: {},
  ai: { provider: "mock" as const }
};

function provider(overrides: Partial<ManagedAIProvider> = {}): ManagedAIProvider {
  return {
    id: "mock",
    capabilities: { streaming: false, tools: false },
    chat: async () => ({ kind: "message", text: "" }),
    management: {
      getInfo: async () => ({ id: "mock", status: "AVAILABLE", model: null, models: [] }),
      listModels: async () => []
    },
    ...overrides
  };
}

describe("buildDoctorReport", () => {
  it("reports real AI provider status instead of a hardcoded indicator", async () => {
    const unavailable = provider({
      management: {
        getInfo: async () => ({ id: "ollama", status: "UNAVAILABLE", model: "m", models: [] }),
        listModels: async () => []
      }
    });
    const report = await buildDoctorReport({
      aiProvider: unavailable,
      settings,
      sessionCount: () => 0,
      pendingApprovalCount: () => 0,
      auditHealthy: () => true,
      trustedOriginCount: () => 1,
      appVersion: "0.1.0",
      dataDirectory: "C:\\fake\\George"
    });
    expect(report.ai).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "provider", state: "UNAVAILABLE" })])
    );
  });

  it("reflects a genuinely unhealthy audit sink rather than always reporting AVAILABLE", async () => {
    const report = await buildDoctorReport({
      aiProvider: provider(),
      settings,
      sessionCount: () => 2,
      pendingApprovalCount: () => 1,
      auditHealthy: () => false,
      trustedOriginCount: () => 2,
      appVersion: "0.1.0",
      dataDirectory: "C:\\fake\\George"
    });
    expect(report.security).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "auditDatabase", state: "UNAVAILABLE" })
      ])
    );
    expect(report.security).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "pendingApprovals", detail: "1" })])
    );
  });

  it("flags a missing trusted origin set as misconfigured", async () => {
    const report = await buildDoctorReport({
      aiProvider: provider(),
      settings,
      sessionCount: () => 0,
      pendingApprovalCount: () => 0,
      auditHealthy: () => true,
      trustedOriginCount: () => 0,
      appVersion: "0.1.0",
      dataDirectory: "C:\\fake\\George"
    });
    expect(report.security).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "originPolicy", state: "MISCONFIGURED" })
      ])
    );
  });

  it("reports voice as not installed and never exposes secrets", async () => {
    const report = await buildDoctorReport({
      aiProvider: provider(),
      settings,
      sessionCount: () => 0,
      pendingApprovalCount: () => 0,
      auditHealthy: () => true,
      trustedOriginCount: () => 1,
      appVersion: "0.1.0",
      dataDirectory: "C:\\fake\\George"
    });
    expect(report.voice.every((check) => check.state === "NOT_INSTALLED")).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/credential|secret|token|cookie/i);
  });
});
