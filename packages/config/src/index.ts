import { z } from "zod";
import type { Channel } from "@george/protocol";
import defaults from "../../../george.defaults.json" with { type: "json" };

export const projectDefinitionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "Project id must be a lowercase machine-readable identifier."),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  rootPath: z.string().trim().min(1),
  defaultApplicationId: z.string().trim().min(1).optional()
});
export type ProjectDefinition = z.output<typeof projectDefinitionSchema>;

export const assistantProfileSchema = z.object({
  assistant: z.object({
    name: z.string().trim().min(1),
    language: z.string().trim().min(2)
  }),
  user: z.object({ displayName: z.string().trim().min(1).optional() }),
  ai: z.object({
    provider: z.enum(["mock", "ollama"]),
    credentialRef: z.string().trim().min(1).optional(),
    ollama: z.object({ model: z.string().trim().min(1) }).optional()
  }),
  projects: z
    .array(projectDefinitionSchema)
    .max(64)
    .refine(
      (projects) => new Set(projects.map((project) => project.id)).size === projects.length,
      "Project ids must be unique."
    )
    .default([])
});

export type AssistantProfileInput = z.input<typeof assistantProfileSchema>;
export type AssistantProfileConfig = z.output<typeof assistantProfileSchema>;

export class InvalidConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigurationError";
  }
}

export function parseAssistantProfile(input: unknown): AssistantProfileConfig {
  const parsed = assistantProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidConfigurationError(
      `Invalid assistant profile: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

export const hostConfigurationSchema = z.object({
  host: z.object({
    address: z.literal("127.0.0.1"),
    port: z.number().int().min(1024).max(65535)
  }),
  tools: z.object({
    grantedPermissions: z
      .array(z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/))
      .max(128)
      .refine((permissions) => new Set(permissions).size === permissions.length),
    deniedPermissions: z
      .array(z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/))
      .max(128)
      .refine((permissions) => new Set(permissions).size === permissions.length)
      .default([])
  })
});

const ollamaBaseUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username !== "" ||
        url.password !== "" ||
        (url.pathname !== "/" && url.pathname !== "") ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        context.addIssue({ code: "custom", message: "Ollama URL must be a loopback HTTP origin." });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Ollama URL must be a loopback HTTP origin." });
    }
  });

export const aiConfigurationSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("mock") }),
  z.object({
    provider: z.literal("ollama"),
    ollama: z.object({
      baseUrl: ollamaBaseUrlSchema.default("http://127.0.0.1:11434"),
      model: z.string().trim().min(1, "An Ollama model must be configured.")
    })
  })
]);

export type AIConfiguration = z.output<typeof aiConfigurationSchema>;

export type HostConfiguration = z.output<typeof hostConfigurationSchema>;

export interface EffectivePermissions {
  readonly grantedPermissions: readonly string[];
  readonly deniedPermissions: readonly string[];
}

/** Resolves installation-owned grants and denials; requests and providers are not inputs. */
export class PermissionResolver {
  constructor(
    private readonly allow: readonly string[],
    private readonly deny: readonly string[] = []
  ) {}

  resolve(_channel: Channel, _environment: "development" | "production"): EffectivePermissions {
    return {
      grantedPermissions: this.allow.filter((permission) => !this.deny.includes(permission)),
      deniedPermissions: this.deny
    };
  }
}

export function loadHostConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): HostConfiguration {
  const result = hostConfigurationSchema.safeParse({
    host: {
      address: defaults.host.address,
      port: environment["GEORGE_HOST_PORT"]
        ? Number(environment["GEORGE_HOST_PORT"])
        : defaults.host.port
    },
    tools: {
      grantedPermissions:
        environment["GEORGE_TOOL_PERMISSIONS"] !== undefined
          ? environment["GEORGE_TOOL_PERMISSIONS"]
              .split(",")
              .map((permission) => permission.trim())
              .filter(Boolean)
          : environment["NODE_ENV"] === "production"
            ? defaults.tools.grantedPermissions
            : defaults.tools.developmentGrantedPermissions,
      deniedPermissions:
        environment["GEORGE_TOOL_DENY_PERMISSIONS"] !== undefined
          ? environment["GEORGE_TOOL_DENY_PERMISSIONS"]
              .split(",")
              .map((permission) => permission.trim())
              .filter(Boolean)
          : []
    }
  });
  if (!result.success) {
    throw new InvalidConfigurationError(
      `Invalid Host configuration: ${z.prettifyError(result.error)}`
    );
  }
  return result.data;
}

/** The env/defaults-derived assistant profile, used to seed a fresh SettingsStore. */
export function loadDefaultAssistantProfile(
  environment: Readonly<Record<string, string | undefined>>
): AssistantProfileConfig {
  const ai = loadAIConfiguration(environment);
  return parseAssistantProfile({
    assistant: { name: defaults.assistant.name, language: defaults.assistant.language },
    user: {},
    ai:
      ai.provider === "ollama"
        ? { provider: "ollama" as const, ollama: { model: ai.ollama.model } }
        : { provider: "mock" as const }
  });
}

export function loadAIConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): AIConfiguration {
  const provider = environment["GEORGE_AI_PROVIDER"] ?? defaults.ai.provider;
  const input =
    provider === "ollama"
      ? {
          provider,
          ollama: {
            baseUrl: environment["GEORGE_OLLAMA_BASE_URL"] ?? defaults.ai.ollama.baseUrl,
            model: environment["GEORGE_OLLAMA_MODEL"] ?? defaults.ai.ollama.model
          }
        }
      : { provider };
  const result = aiConfigurationSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidConfigurationError(
      `Invalid AI configuration: ${z.prettifyError(result.error)}`
    );
  }
  return result.data;
}
