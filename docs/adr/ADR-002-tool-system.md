# ADR-002: Tool system

- Status: Accepted; Agent orchestration added in M4.1
- Date: 2026-10-02

## Context

Future model-assisted actions need an explicit capability boundary and runtime validation; a prompt
cannot act as an authorization mechanism.

## Decision

Represent each tool with a stable dot-separated ID, name, description, Zod input schema, required
permissions, risk level, optional bounded timeout, and typed handler. The registry projects only ID,
description, and input schema to the provider. A structured model call is a request, never
authorization. `AgentRuntime` routes it to `ToolRuntime`, which resolves the exact ID, validates
input, and consults PolicyEngine before any handler. `ASK` and `DENY` stop the request without a
handler call or provider retry. Tool results return as structured tool data, bounded to 16 KiB and
kept only in the request-local transcript. Calls execute sequentially, with four tool-call rounds
and at most eight calls per round. Host direct requests remain subject to session, Origin, and CSRF
checks and share the same runtime.

## Consequences

Tools are inspectable and testable independently. M4 adds timeout, cancellation, safe audit records,
and the read-only `system.info` built-in; M4.1 adds the provider-neutral Agent loop and structured
Ollama adapter. Tool outputs from external adapters remain untrusted data and must be validated by
the consumer. Human approval, persistent audit, and platform-specific process listing remain future
work. No generic shell or arbitrary command tool is
permitted.
