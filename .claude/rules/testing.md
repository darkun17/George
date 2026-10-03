# Testing

- Use Vitest. Keep the default test suite deterministic and independent of cloud credentials.
- Test behavior and security boundaries, especially policy outcomes and invalid configuration.
- Add contract tests when a public interface or boundary changes.
- Do not rely on network, machine-specific paths, or personal profile data in unit tests.
- Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build` before completing a change.
