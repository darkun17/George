# ADR-004: AI providers

- Status: Accepted; structured tool-call contract added in M4.1
- Date: 2026-10-02

## Context

The project should support multiple model vendors and local providers without binding orchestration
to an SDK or development tool.

## Decision

Expose a small vendor-neutral `AIProvider` port, explicit tool support flag, structured
`AIProviderResult`, and safe tool descriptors in protocol. Adapters own wire-format conversion and
selection stays outside Core. The port supports request-local tool continuations without vendor
types; the deterministic mock stays non-tool-capable. The Ollama adapter uses its structured `/api/chat`
tool request/response fields and checks the selected model's advertised `tools` capability from
`/api/show` before sending tools. Missing capability metadata fails closed. Claude Code is a
development tool, not an assumed George runtime.

## Consequences

Core remains provider-independent. Anthropic can be added in the adapter factory without changing
AgentRuntime. Each adapter must validate provider responses, keep malformed calls as safe failures,
and never emulate tool calls by parsing free-form model text.
