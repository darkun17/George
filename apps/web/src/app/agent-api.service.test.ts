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

  it("lists safe approval metadata and sends only the approval ID on resolution", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "c".repeat(43) }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            approvals: [
              {
                approvalId: "approval-1",
                requestId: "request-1",
                conversationId: "conversation-1",
                toolCallId: "call-1",
                toolId: "test.high-risk",
                riskLevel: "HIGH",
                createdAt: "2026-10-03T12:00:00Z",
                expiresAt: "2026-10-03T12:05:00Z",
                status: "PENDING"
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            requestId: "request-1",
            conversationId: "conversation-1",
            content: "done",
            receivedAt: "2026-10-03T12:00:00Z",
            completedAt: "2026-10-03T12:00:01Z",
            durationMs: 1
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = new AgentApiService();
    await service.bootstrapSession();
    const approvals = await service.getApprovals();
    expect(approvals[0]?.toolId).toBe("test.high-risk");
    await expect(service.resolveApproval("approval-1", "approve")).resolves.toMatchObject({
      status: "completed"
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/approvals/approval-1/approve");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("X-George-CSRF")).toBe(
      "c".repeat(43)
    );
  });
});
