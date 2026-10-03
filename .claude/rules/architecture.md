# Architecture

- Keep `protocol` dependency-free. It defines shared domain contracts.
- `policy` may depend on `protocol`; `tools-sdk` may depend on `protocol`.
- `config` validates installation-owned configuration and may depend on `protocol`.
- `core` composes public package APIs and owns orchestration; leaf packages never import core.
- Import other workspaces via package exports, not source paths or package internals.
- Keep OS, UI, persistence, and provider implementations behind adapters in later milestones.
- Add an ADR when changing a boundary or a security-relevant architectural decision.
