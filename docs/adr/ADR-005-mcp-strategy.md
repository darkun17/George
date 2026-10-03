# ADR-005: MCP strategy

- Status: Proposed
- Date: 2026-10-02

## Context

MCP can expose external capabilities but also expands the trust boundary to independently operated
servers.

## Decision

Do not add MCP in M0. When introduced, keep it as an adapter that maps server capabilities into the
same validated tool and policy flow. Treat servers, descriptions, inputs, and outputs as untrusted;
require explicit server configuration and capability review.

## Consequences

The initial dependency graph stays small. Transport, authentication, server lifecycle, and trust
configuration remain open decisions until a concrete MCP milestone.
