# TypeScript

- Keep strict compiler options enabled; handle optional values and external data explicitly.
- Parse configuration and other untrusted input at runtime with Zod.
- Export package APIs through `src/index.ts` and package `exports`.
- Prefer discriminated unions and typed errors over ambiguous strings or swallowed exceptions.
- Avoid `any`, non-null assertions, broad casts, and mutable shared state.
- Use platform-neutral APIs in core packages; isolate platform-specific code in adapters.
