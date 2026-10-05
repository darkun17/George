import { describe, expect, it } from "vitest";
import {
  InvalidConfigurationError,
  hostConfigurationSchema,
  aiConfigurationSchema,
  loadAIConfiguration,
  loadHostConfiguration,
  PermissionResolver,
  parseAssistantProfile,
  projectDefinitionSchema,
  assistantProfileSchema
} from "./index.js";

describe("parseAssistantProfile", () => {
  it("accepts a minimal profile without a hardcoded personal identity", () => {
    expect(
      parseAssistantProfile({
        assistant: { name: "Assistant", language: "en" },
        user: {},
        ai: { provider: "mock" }
      }).assistant.name
    ).toBe("Assistant");
  });

  it("rejects invalid configuration with a typed error", () => {
    expect(() => parseAssistantProfile({ assistant: { name: " " } })).toThrow(
      InvalidConfigurationError
    );
  });
});

describe("AI provider configuration", () => {
  it("defaults to offline mock and requires an explicit Ollama model", () => {
    expect(loadAIConfiguration({})).toEqual({ provider: "mock" });
    expect(() => loadAIConfiguration({ GEORGE_AI_PROVIDER: "ollama" })).toThrow(
      InvalidConfigurationError
    );
    expect(
      loadAIConfiguration({ GEORGE_AI_PROVIDER: "ollama", GEORGE_OLLAMA_MODEL: "chosen-model" })
    ).toEqual({
      provider: "ollama",
      ollama: { baseUrl: "http://127.0.0.1:11434", model: "chosen-model" }
    });
  });

  it("rejects unknown providers and non-loopback Ollama URLs", () => {
    expect(() => aiConfigurationSchema.parse({ provider: "unknown" })).toThrow();
    expect(() =>
      aiConfigurationSchema.parse({
        provider: "ollama",
        ollama: { baseUrl: "http://example.com", model: "m" }
      })
    ).toThrow();
    expect(() =>
      aiConfigurationSchema.parse({
        provider: "ollama",
        ollama: { baseUrl: "http://127.0.0.1:11434/path", model: "m" }
      })
    ).toThrow();
  });
});

const EXPECTED_DEVELOPMENT_GRANTED_PERMISSIONS = [
  "system.info.read",
  "apps.list.read",
  "apps.open.execute",
  "system.process.read",
  "projects.list.read",
  "projects.read",
  "projects.open.execute",
  "git.read",
  "filesystem.list.read",
  "filesystem.read",
  "filesystem.search.read"
];

describe("loadHostConfiguration", () => {
  it("defaults to loopback and the configured local port", () => {
    expect(loadHostConfiguration({})).toEqual({
      host: { address: "127.0.0.1", port: 43100 },
      tools: {
        grantedPermissions: EXPECTED_DEVELOPMENT_GRANTED_PERMISSIONS,
        deniedPermissions: []
      }
    });
  });

  it("allows a valid port override but rejects public bind addresses", () => {
    expect(loadHostConfiguration({ GEORGE_HOST_PORT: "43210" }).host.port).toBe(43210);
    expect(() =>
      hostConfigurationSchema.parse({
        host: { address: "0.0.0.0", port: 43100 },
        tools: { grantedPermissions: ["system.info.read"] }
      })
    ).toThrow();
  });

  it("allows explicit permission configuration and rejects malformed or duplicate grants", () => {
    expect(loadHostConfiguration({ GEORGE_TOOL_PERMISSIONS: "system.info.read" }).tools).toEqual({
      grantedPermissions: ["system.info.read"],
      deniedPermissions: []
    });
    expect(loadHostConfiguration({ GEORGE_TOOL_PERMISSIONS: "" }).tools.grantedPermissions).toEqual(
      []
    );
    expect(
      loadHostConfiguration({ GEORGE_TOOL_DENY_PERMISSIONS: "project.open" }).tools
        .deniedPermissions
    ).toEqual(["project.open"]);
    expect(() =>
      hostConfigurationSchema.parse({
        host: { address: "127.0.0.1", port: 43100 },
        tools: { grantedPermissions: ["bad permission", "bad permission"] }
      })
    ).toThrow();
  });

  it("grants the development diagnostic permissions explicitly and defaults production to none", () => {
    expect(loadHostConfiguration({ NODE_ENV: "test" }).tools.grantedPermissions).toEqual(
      EXPECTED_DEVELOPMENT_GRANTED_PERMISSIONS
    );
    expect(loadHostConfiguration({ NODE_ENV: "production" }).tools.grantedPermissions).toEqual([]);
  });

  it("resolves explicit grants and denials with deny taking precedence", () => {
    const resolver = new PermissionResolver(["system.info.read", "project.open"], ["project.open"]);
    expect(resolver.resolve("desktop", "production")).toEqual({
      grantedPermissions: ["system.info.read"],
      deniedPermissions: ["project.open"]
    });
    expect(() => loadHostConfiguration({ GEORGE_TOOL_PERMISSIONS: "*" })).toThrow(
      InvalidConfigurationError
    );
  });
});

describe("projectDefinitionSchema", () => {
  const valid = { id: "george", displayName: "George", rootPath: "C:\\Projects\\George" };

  it("accepts a valid machine-readable id", () => {
    expect(projectDefinitionSchema.safeParse(valid).success).toBe(true);
    expect(projectDefinitionSchema.safeParse({ ...valid, id: "my-project.2" }).success).toBe(true);
  });

  it("rejects an id that is not a safe machine-readable identifier", () => {
    expect(projectDefinitionSchema.safeParse({ ...valid, id: "My Project" }).success).toBe(false);
    expect(
      projectDefinitionSchema.safeParse({ ...valid, id: "C:\\Projects\\George" }).success
    ).toBe(false);
    expect(projectDefinitionSchema.safeParse({ ...valid, id: "" }).success).toBe(false);
  });

  it("rejects a missing rootPath or displayName", () => {
    expect(projectDefinitionSchema.safeParse({ id: "george" }).success).toBe(false);
  });
});

describe("assistantProfileSchema projects", () => {
  it("defaults to an empty project list when absent", () => {
    const parsed = assistantProfileSchema.parse({
      assistant: { name: "George", language: "es" },
      user: {},
      ai: { provider: "mock" }
    });
    expect(parsed.projects).toEqual([]);
  });

  it("rejects duplicate project ids", () => {
    const result = assistantProfileSchema.safeParse({
      assistant: { name: "George", language: "es" },
      user: {},
      ai: { provider: "mock" },
      projects: [
        { id: "george", displayName: "George", rootPath: "C:\\a" },
        { id: "george", displayName: "George Again", rootPath: "C:\\b" }
      ]
    });
    expect(result.success).toBe(false);
  });
});
