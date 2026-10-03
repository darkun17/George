# Contributing

George is pre-alpha and its architecture is still being established. Before contributing:

1. Read `CLAUDE.md`, applicable `.claude/rules/`, and the relevant architecture document.
2. Keep changes inside package public APIs and preserve the documented dependency direction.
3. Add focused tests for behavior and security boundaries. Unit tests must not require cloud access.
4. Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.
5. Never include personal profile data, credentials, local databases, or generated outputs.

For changes to security boundaries or package responsibilities, propose an ADR with the change.
