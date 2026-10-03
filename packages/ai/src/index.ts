import type { AIConfiguration } from "@george/config";
import { randomUUID } from "node:crypto";
import type {
  AIMessage,
  AIProvider,
  AIProviderInfo,
  AIProviderResult,
  AIToolDescriptor
} from "@george/protocol";
import { z } from "zod";

export class AIProviderError extends Error {
  readonly code: "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR";

  constructor(code: AIProviderError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AIProviderError";
    this.code = code;
  }
}

export interface AIProviderManagement {
  getInfo(): Promise<AIProviderInfo>;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
}

export interface ManagedAIProvider extends AIProvider {
  readonly management: AIProviderManagement;
}

const ollamaChatSchema = z.object({
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
    tool_calls: z
      .array(z.object({ function: z.object({ name: z.string().min(1), arguments: z.unknown() }) }))
      .max(8)
      .optional()
  })
});
const ollamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1) }))
});
const ollamaShowSchema = z.object({ capabilities: z.array(z.string()).optional() });
type Fetcher = typeof fetch;

export class OllamaProvider implements ManagedAIProvider {
  readonly id = "ollama";
  readonly capabilities = { streaming: false, tools: true } as const;
  readonly management: AIProviderManagement = {
    getInfo: () => this.getInfo(),
    listModels: (signal) => this.listModels(signal)
  };
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetch: Fetcher;
  readonly #timeoutMs: number;
  #modelSupportsTools: boolean | undefined;

  constructor(options: {
    readonly baseUrl: string;
    readonly model: string;
    readonly fetch?: Fetcher;
    readonly timeoutMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#model = options.model;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async chat(
    messages: readonly AIMessage[],
    options?: { readonly signal?: AbortSignal; readonly tools?: readonly AIToolDescriptor[] }
  ): Promise<AIProviderResult> {
    const signal = combineTimeout(options?.signal, this.#timeoutMs);
    const ollamaMessages = messages.map(toOllamaMessage);
    const tools = options?.tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.id,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
    if (tools?.length) await this.#assertModelSupportsTools(options?.signal);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.#model,
          messages: ollamaMessages,
          stream: false,
          ...(tools ? { tools } : {})
        }),
        signal,
        redirect: "error"
      });
    } catch (error) {
      if (options?.signal?.aborted) throw abortError(error);
      throw new AIProviderError("PROVIDER_UNAVAILABLE", "Ollama is unavailable.", { cause: error });
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new AIProviderError("PROVIDER_ERROR", "The configured Ollama model is unavailable.");
      }
      throw new AIProviderError(
        response.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR",
        "Ollama could not process the request."
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (options?.signal?.aborted) throw abortError(error);
      if (signal.aborted) {
        throw new AIProviderError("PROVIDER_UNAVAILABLE", "Ollama is unavailable.", {
          cause: error
        });
      }
      throw new AIProviderError("PROVIDER_ERROR", "Ollama returned an invalid response.", {
        cause: error
      });
    }
    const parsed = ollamaChatSchema.safeParse(payload);
    if (!parsed.success)
      throw new AIProviderError("PROVIDER_ERROR", "Ollama returned an invalid response.");
    const message = parsed.data.message;
    if (message.tool_calls?.length) {
      const calls = message.tool_calls.map(({ function: tool }) => {
        if (
          typeof tool.arguments !== "object" ||
          tool.arguments === null ||
          Array.isArray(tool.arguments)
        ) {
          throw new AIProviderError("PROVIDER_ERROR", "Ollama returned an invalid response.");
        }
        return { id: randomUUID(), toolId: tool.name, input: tool.arguments };
      });
      return { kind: "tool_calls", calls };
    }
    return { kind: "message", text: message.content };
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    const combined = combineTimeout(signal, 5_000);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/tags`, {
        signal: combined,
        redirect: "error"
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      throw new AIProviderError("PROVIDER_UNAVAILABLE", "Ollama is unavailable.", { cause: error });
    }
    if (!response.ok) throw new AIProviderError("PROVIDER_UNAVAILABLE", "Ollama is unavailable.");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      if (combined.aborted) {
        throw new AIProviderError("PROVIDER_UNAVAILABLE", "Ollama is unavailable.", {
          cause: error
        });
      }
      throw new AIProviderError("PROVIDER_ERROR", "Ollama returned an invalid model catalog.", {
        cause: error
      });
    }
    const parsed = ollamaTagsSchema.safeParse(payload);
    if (!parsed.success)
      throw new AIProviderError("PROVIDER_ERROR", "Ollama returned an invalid model catalog.");
    return parsed.data.models.map(({ name }) => name);
  }

  async #assertModelSupportsTools(signal?: AbortSignal): Promise<void> {
    if (this.#modelSupportsTools === true) return;
    if (this.#modelSupportsTools === false) {
      throw new AIProviderError(
        "PROVIDER_ERROR",
        "The configured Ollama model does not support tools."
      );
    }
    const requestSignal = combineTimeout(signal, 5_000);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.#model }),
        signal: requestSignal,
        redirect: "error"
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      throw new AIProviderError("PROVIDER_UNAVAILABLE", "Ollama is unavailable.", { cause: error });
    }
    if (!response.ok) {
      throw new AIProviderError(
        response.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR",
        "Ollama could not inspect the configured model."
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      throw new AIProviderError("PROVIDER_ERROR", "Ollama returned invalid model capabilities.", {
        cause: error
      });
    }
    const parsed = ollamaShowSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AIProviderError("PROVIDER_ERROR", "Ollama returned invalid model capabilities.");
    }
    this.#modelSupportsTools = parsed.data.capabilities?.includes("tools") ?? false;
    if (!this.#modelSupportsTools) {
      throw new AIProviderError(
        "PROVIDER_ERROR",
        "The configured Ollama model does not support tools."
      );
    }
  }

  async getInfo(): Promise<AIProviderInfo> {
    try {
      const models = await this.listModels();
      return {
        id: this.id,
        status: models.includes(this.#model) ? "AVAILABLE" : "MISCONFIGURED",
        model: this.#model,
        models
      };
    } catch (error) {
      return {
        id: this.id,
        status:
          error instanceof AIProviderError && error.code === "PROVIDER_ERROR"
            ? "MISCONFIGURED"
            : "UNAVAILABLE",
        model: this.#model,
        models: []
      };
    }
  }
}

export class MockProvider implements ManagedAIProvider {
  readonly id = "mock";
  readonly capabilities = { streaming: false, tools: false } as const;
  readonly management: AIProviderManagement = {
    getInfo: async () => ({ id: this.id, status: "AVAILABLE", model: null, models: [] }),
    listModels: async () => []
  };

  async chat(
    messages: readonly AIMessage[],
    options?: { readonly signal?: AbortSignal }
  ): Promise<AIProviderResult> {
    if (options?.signal?.aborted) throw abortError(new DOMException("Aborted", "AbortError"));
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    return { kind: "message", text: `Mock response: ${lastUserMessage?.content ?? ""}` };
  }
}

function toOllamaMessage(message: AIMessage): Readonly<Record<string, unknown>> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_name: message.toolId };
  }
  if (message.role === "assistant" && message.toolCalls) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        function: { name: call.toolId, arguments: call.input }
      }))
    };
  }
  return { role: message.role, content: message.content };
}

export function createAIProvider(config: AIConfiguration): ManagedAIProvider {
  switch (config.provider) {
    case "mock":
      return new MockProvider();
    case "ollama":
      return new OllamaProvider(config.ollama);
  }
}

function combineTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(cause: unknown): AIProviderError {
  return new AIProviderError("PROVIDER_UNAVAILABLE", "The provider request was cancelled.", {
    cause
  });
}
