# George

George is a local-first Personal AI Operating System for Windows, designed to grow into a portable,
configurable assistant. The repository is in **pre-alpha**. M4.1 provides a local Angular Command Center,
George Host, provider-independent Agent Core, optional Ollama provider, and a policy-gated Tool Runtime.

The application is generic; each installation supplies its own profile, data, credentials,
projects, tools, and policies. User data and secrets do not belong in this repository.

## Principles

- Security before autonomy; every capability will be an explicit, auditable tool.
- Provider-agnostic core, strict package boundaries, and portable domain logic.
- Installation-specific identity and configuration, with OS-backed secret storage planned.
- Incremental delivery without granting a model arbitrary computer access.

## Architecture

The pnpm TypeScript monorepo contains `protocol` (shared contracts), `tools-sdk` (Zod tool
definitions), `tools-core` (registry, policy gate, runtime, and `system.info`), `policy` (default
allow/ask/deny decisions), `config`, `ai` (mock and Ollama adapters), `core` (Agent Runtime),
`apps/host` (loopback HTTP and SSE), and `apps/web` (Angular Command Center). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 22.12 or newer, or 24 or newer
- pnpm 10 or newer
- Git

## Development

```powershell
pnpm install
pnpm dev
```

Open **http://127.0.0.1:4200** for the development Command Center. Angular proxies `/api/**` to
George Host at `127.0.0.1:43100`. To run the processes separately, use `pnpm dev:host` and
`pnpm dev:web`. Set `GEORGE_HOST_PORT` to change the Host port; the dev proxy reads the same setting.
For a production web build served by Host:

```powershell
pnpm build
pnpm --filter @george/host start
```

Then open **http://127.0.0.1:43100**. Override the port consistently with `GEORGE_HOST_PORT`.

Quality checks:

```powershell
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
```

`pnpm format` formats supported files; `pnpm format:check` checks formatting. Tests run locally
without cloud accounts or API keys.

## Security

Do not add secrets, personal profiles, local databases, or runtime data to Git. The only built-in
tool is read-only `system.info`; every tool handler is gated by PolicyEngine. High-risk `ASK` never
executes and returns `APPROVAL_REQUIRED`; there is no approval flow yet. Ollama can return
structured tool requests, but George alone authorizes them through PolicyEngine and executes them
through ToolRuntime. There is no shell, filesystem, process-list, or application-control tool.
The local Host uses an ephemeral session cookie and CSRF token; plain HTTP is not encrypted against
other processes on the device. Read [docs/SECURITY.md](docs/SECURITY.md) before adding capabilities.

## Tool Runtime (M4)

The Host exposes an authenticated `GET /api/v1/tools` catalog and a direct
`POST /api/v1/tools/:id/execute` diagnostic route. Execution requires a valid local session, exact
Origin, CSRF token, runtime input validation, and PolicyEngine `ALLOW`. The development defaults
explicitly grant `system.info.read`; set `GEORGE_TOOL_PERMISSIONS` to a comma-separated permission
list to override, or an empty value to grant none. Inputs and outputs are excluded from audit. The
in-memory audit lasts only for the Host process lifetime.

## Agent tool orchestration (M4.1)

The Agent endpoint can continue an Ollama response through a structured `system.info` tool call.
The model receives only safe tool ID, description, and input schema. Calls run sequentially through
ToolRuntime with policy checks, up to four tool-call rounds and eight calls per round. Tool results
are request-local data, limited to 16 KiB, and discarded after the request. Provider and model
support can vary; Ollama checks the selected model's advertised `tools` capability via `/api/show`.
Unsupported models are never simulated by parsing free-form text. See [docs/SECURITY.md](docs/SECURITY.md).

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for milestone status.

## Contributing

Contributions should preserve package boundaries and security defaults. Read [CLAUDE.md](CLAUDE.md),
the focused `.claude/rules/`, and the relevant ADR before changing architecture. License choice is
pending; see [docs/PRODUCT.md](docs/PRODUCT.md).

## AI provider configuration

George defaults to the deterministic offline mock. To use an already installed Ollama model, set
`GEORGE_AI_PROVIDER=ollama` and `GEORGE_OLLAMA_MODEL` to its exact model name. Optionally set
`GEORGE_OLLAMA_BASE_URL`; only HTTP loopback origins are accepted, with
`http://127.0.0.1:11434` as default.

In PowerShell:

```powershell
$env:GEORGE_AI_PROVIDER = "ollama"
$env:GEORGE_OLLAMA_MODEL = "<modelo-instalado>"
pnpm dev
```

George does not choose or download models. Authenticated `/api/v1/ai/status` and
`/api/v1/ai/models` report provider availability and installed models. Host health remains
independent of Ollama availability. Anthropic is a future adapter candidate; M3 adds no cloud
credentials.
