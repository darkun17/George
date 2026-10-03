import { describe, expect, it } from "vitest";
import {
  InvalidConfigurationError,
  hostConfigurationSchema,
  aiConfigurationSchema,
  loadAIConfiguration,
  loadHostConfiguration,
  parseAssistantProfile
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

describe("loadHostConfiguration", () => {
  it("defaults to loopback and the configured local port", () => {
    expect(loadHostConfiguration({})).toEqual({
      host: { address: "127.0.0.1", port: 43100 },
      tools: { grantedPermissions: ["system.info.read"] }
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
      grantedPermissions: ["system.info.read"]
    });
    expect(loadHostConfiguration({ GEORGE_TOOL_PERMISSIONS: "" }).tools.grantedPermissions).toEqual(
      []
    );
    expect(() =>
      hostConfigurationSchema.parse({
        host: { address: "127.0.0.1", port: 43100 },
        tools: { grantedPermissions: ["bad permission", "bad permission"] }
      })
    ).toThrow();
  });

  it("grants the development diagnostic permission explicitly and defaults production to none", () => {
    expect(loadHostConfiguration({ NODE_ENV: "test" }).tools.grantedPermissions).toEqual([
      "system.info.read"
    ]);
    expect(loadHostConfiguration({ NODE_ENV: "production" }).tools.grantedPermissions).toEqual([]);
  });
});
