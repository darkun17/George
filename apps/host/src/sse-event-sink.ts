import type { AgentEvent } from "@george/protocol";
import type { AgentEventSink } from "@george/core";

export type AgentEventListener = (event: AgentEvent) => void;

export class SseAgentEventSink implements AgentEventSink {
  readonly #listeners = new Set<AgentEventListener>();

  emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }
}
