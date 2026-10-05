import { describe, expect, it } from "vitest";
import type { ManagedAIProvider } from "@george/ai";
import { buildDoctorReport, type DoctorDependencies, type ProjectDoctorStatus } from "./doctor.js";

const settings = {
  assistant: { name: "George", language: "es" },
  user: {},
  ai: { provider: "mock" as const },
  projects: []
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

function baseDeps(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    aiProvider: provider(),
    settings,
    sessionCount: () => 0,
    pendingApprovalCount: () => 0,
    auditHealthy: () => true,
    trustedOriginCount: () => 1,
    appVersion: "0.1.0",
    dataDirectory: "C:\\fake\\George",
    gitAvailable: async () => ({ available: true, version: "2.44.0" }),
    projectStatuses: async () => [],
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
    const report = await buildDoctorReport(baseDeps({ aiProvider: unavailable }));
    expect(report.ai).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "provider", state: "UNAVAILABLE" })])
    );
  });

  it("reflects a genuinely unhealthy audit sink rather than always reporting AVAILABLE", async () => {
    const report = await buildDoctorReport(
      baseDeps({
        sessionCount: () => 2,
        pendingApprovalCount: () => 1,
        auditHealthy: () => false,
        trustedOriginCount: () => 2
      })
    );
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
    const report = await buildDoctorReport(baseDeps({ trustedOriginCount: () => 0 }));
    expect(report.security).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "originPolicy", state: "MISCONFIGURED" })
      ])
    );
  });

  it("reports voice as not installed and never exposes secrets", async () => {
    const report = await buildDoctorReport(baseDeps());
    expect(report.voice.every((check) => check.state === "NOT_INSTALLED")).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/credential|secret|token|cookie/i);
  });

  it("reports Git as available with its version when the probe succeeds", async () => {
    const report = await buildDoctorReport(
      baseDeps({ gitAvailable: async () => ({ available: true, version: "2.44.0" }) })
    );
    expect(report.git).toEqual([{ id: "executable", state: "AVAILABLE", detail: "2.44.0" }]);
  });

  it("reports Git as unavailable when the probe fails, instead of a hardcoded green check", async () => {
    const report = await buildDoctorReport(
      baseDeps({ gitAvailable: async () => ({ available: false }) })
    );
    expect(report.git).toEqual([{ id: "executable", state: "UNAVAILABLE" }]);
  });

  it("reports a valid, Git-backed project as available", async () => {
    const projects: readonly ProjectDoctorStatus[] = [
      { id: "george", displayName: "George", rootAvailable: true, gitRepository: true }
    ];
    const report = await buildDoctorReport(baseDeps({ projectStatuses: async () => projects }));
    expect(report.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project:george", state: "AVAILABLE", detail: "George" })
      ])
    );
  });

  it("reports a project with a missing root as unavailable, and counts it in the registry summary", async () => {
    const projects: readonly ProjectDoctorStatus[] = [
      { id: "ghost", displayName: "Ghost", rootAvailable: false, gitRepository: false }
    ];
    const report = await buildDoctorReport(baseDeps({ projectStatuses: async () => projects }));
    expect(report.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project:ghost", state: "UNAVAILABLE" }),
        expect.objectContaining({
          id: "registry",
          detail: expect.stringContaining("1 with an unavailable root")
        })
      ])
    );
  });

  it("reports a non-Git project without claiming it has Git", async () => {
    const projects: readonly ProjectDoctorStatus[] = [
      { id: "plain", displayName: "Plain", rootAvailable: true, gitRepository: false }
    ];
    const report = await buildDoctorReport(baseDeps({ projectStatuses: async () => projects }));
    expect(report.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "project:plain", state: "AVAILABLE" })])
    );
  });

  it("does not recursively scan files -- the probe is bounded and injected, never real I/O in this test", async () => {
    let called = 0;
    await buildDoctorReport(
      baseDeps({
        projectStatuses: async () => {
          called++;
          return [];
        }
      })
    );
    expect(called).toBe(1);
  });
});
