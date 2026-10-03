import { describe, expect, it, vi } from "vitest";
import { AIProviderError, OllamaProvider, createAIProvider } from "./index.js";

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("OllamaProvider", () => {
  it("sends non-streaming chat and validates the assistant result", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "Hola" } }));
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "user-model",
      fetch: fetcher
    });
    await expect(provider.chat([{ role: "user", content: "Hola" }])).resolves.toEqual({
      kind: "message",
      text: "Hola"
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({ redirect: "error" })
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "user-model",
      stream: false
    });
  });

  it("maps official structured tool calls and tool result continuations", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "tools"] }))
      .mockResolvedValueOnce(
        jsonResponse({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "system.info", arguments: {} } }]
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ message: { role: "assistant", content: "16 GB" } }));
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "user-model",
      fetch: fetcher
    });
    const descriptor = {
      id: "system.info",
      description: "Read system info",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    };
    const requested = await provider.chat([{ role: "user", content: "RAM?" }], {
      tools: [descriptor]
    });
    expect(requested).toMatchObject({
      kind: "tool_calls",
      calls: [{ toolId: "system.info", input: {} }]
    });
    if (requested.kind !== "tool_calls") throw new Error("Expected a structured tool request");
    await provider.chat(
      [
        { role: "user", content: "RAM?" },
        { role: "assistant", content: "", toolCalls: requested.calls },
        {
          role: "tool",
          toolCallId: requested.calls[0]!.id,
          toolId: "system.info",
          content: '{"totalMemoryBytes":17179869184}'
        }
      ],
      { tools: [descriptor] }
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/show");
    const firstBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as {
      tools: unknown[];
    };
    expect(firstBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "system.info",
          description: "Read system info",
          parameters: descriptor.inputSchema
        }
      }
    ]);
    const continuation = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(continuation.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "system.info", arguments: {} } }]
      },
      {
        role: "tool",
        content: '{"totalMemoryBytes":17179869184}',
        tool_name: "system.info"
      }
    ]);
    expect(provider.capabilities.tools).toBe(true);
  });

  it("rejects malformed structured tool arguments without parsing text", async () => {
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          message: {
            role: "assistant",
            content: "use system.info",
            tool_calls: [{ function: { name: "system.info", arguments: "{}" } }]
          }
        })
      )
    });
    await expect(provider.chat([])).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Ollama returned an invalid response."
    });
  });

  it("checks the selected model's advertised tools capability before sending tools", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion"] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "chat-only-model" }] }));
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "chat-only-model",
      fetch: fetcher
    });
    await expect(
      provider.chat([{ role: "user", content: "use a tool" }], {
        tools: [
          {
            id: "system.info",
            description: "Read system information",
            inputSchema: { type: "object" }
          }
        ]
      })
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "The configured Ollama model does not support tools."
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/show");
    await expect(provider.management.getInfo()).resolves.toMatchObject({ status: "AVAILABLE" });
  });

  it("maps offline, missing model, invalid response, and cancellation safely", async () => {
    const offline = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("private network detail"))
    });
    await expect(offline.chat([])).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "Ollama is unavailable."
    });
    const missing = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }))
    });
    await expect(missing.chat([])).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "The configured Ollama model is unavailable."
    });
    const malformed = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ message: { role: "user", content: "raw" } }))
    });
    await expect(malformed.chat([])).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Ollama returned an invalid response."
    });
    const controller = new AbortController();
    controller.abort();
    await expect(offline.chat([], { signal: controller.signal })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
  });

  it("discovers installed models and marks a missing selection misconfigured", async () => {
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "not-installed",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ models: [{ name: "local-model" }] }))
    });
    await expect(provider.management.listModels()).resolves.toEqual(["local-model"]);
    await expect(provider.management.getInfo()).resolves.toMatchObject({
      status: "MISCONFIGURED",
      model: "not-installed"
    });
  });

  it("classifies a request timeout as unavailable", async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      fetch: fetcher,
      timeoutMs: 5
    });
    await expect(provider.chat([])).rejects.toBeInstanceOf(AIProviderError);
    await expect(provider.chat([])).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("creates the configured provider without coupling AgentRuntime to its implementation", () => {
    expect(createAIProvider({ provider: "mock" }).id).toBe("mock");
    expect(
      createAIProvider({
        provider: "ollama",
        ollama: { baseUrl: "http://127.0.0.1:11434", model: "chosen" }
      }).id
    ).toBe("ollama");
  });
});
