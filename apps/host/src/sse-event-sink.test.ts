import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@george/protocol";
import { SseAgentEventSink } from "./sse-event-sink.js";

describe("SseAgentEventSink", () => {
  it("broadcasts structured events and removes disconnected listeners", () => {
    const sink = new SseAgentEventSink();
    const received: AgentEvent[] = [];
    const unsubscribe = sink.subscribe((event) => received.push(event));
    const event: AgentEvent = {
      type: "request.received",
      occurredAt: "2026-10-02T12:00:00.000Z",
      requestId: "request-1",
      conversationId: "conversation-1",
      channel: "desktop",
      metadata: {}
    };

    sink.emit(event);
    expect(received).toEqual([event]);
    expect(sink.subscriberCount).toBe(1);
    unsubscribe();
    sink.emit(event);
    expect(received).toHaveLength(1);
    expect(sink.subscriberCount).toBe(0);
  });
});
