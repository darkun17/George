# ADR-003: Policy engine

- Status: Accepted for M0 baseline
- Date: 2026-10-02

## Context

Sensitive work needs independent authorization decisions that cannot be bypassed by model prompts.

## Decision

Use explicit `ALLOW`, `ASK`, and `DENY` outcomes. The initial deterministic policy denies critical
risk and missing permissions, asks for high risk, and allows lower risks only when declared
permissions are granted. An unknown tool must be denied by a future dispatcher.

## Consequences

The baseline is easy to test and conservative. It is not a complete security policy: user identity,
resource scope, channel, contextual rules, human approval, and audit persistence are not yet wired.
