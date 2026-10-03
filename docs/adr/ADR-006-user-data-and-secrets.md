# ADR-006: User data and secrets

- Status: Accepted as design constraint; runtime details deferred
- Date: 2026-10-02

## Context

The engine is reusable, while profiles, projects, knowledge, memory, and credentials belong to one
installation and must not leak into source control.

## Decision

Keep only a generic example profile in the repository. Runtime configuration stores secret
references rather than secret values. A future platform adapter will use the OS credential store;
Tauri application data APIs will determine platform-appropriate runtime paths when the desktop
runtime is selected.

## Consequences

No user data path or secret backend is hardcoded in M0. Exact migration, backup, encryption, and
multi-profile behavior need decisions before persistent runtime storage is implemented.
