# ADR-001: General architecture

- Status: Accepted for M0
- Date: 2026-10-02

## Context

George must support a personal first installation while keeping the application reusable and the
domain core portable. A large runtime or premature service decomposition would increase cost before
there is an executable product.

## Decision

Use a pnpm TypeScript monorepo with small packages and explicit public exports. Keep the protocol
dependency-free; place platform, UI, AI, storage, and integration implementations behind future
adapters. Separate generic engine code from installation-owned profiles and runtime data.

## Consequences

Boundaries can be checked at package edges and features can evolve independently. M0 intentionally
does not select a desktop runtime or persistence engine; revisit these choices when their milestone
needs them.
