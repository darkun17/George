import "@angular/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiService } from "./agent-api.service.js";

afterEach(() => vi.unstubAllGlobals());

describe("AgentApiService", () => {
  it("keeps the bootstrap CSRF token in memory and sends it with agent requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "a".repeat(43) }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            requestId: "request-1",
            conversationId: "conversation-1",
            content: "Mock response"
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = new AgentApiService();

    await service.bootstrapSession();
    const response = await service.send({ conversationId: "conversation-1", input: "Hola" });

    expect(response.status).toBe("completed");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/session/bootstrap");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/agent/requests");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-George-CSRF")).toBe(
      "a".repeat(43)
    );
    expect(fetchMock.mock.calls[1]?.[1]?.credentials).toBe("same-origin");
  });
});
