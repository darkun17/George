# Security

## Current posture

M4.1 runs a local Host and Angular Command Center. Its only built-in tool is read-only `system.info`;
it does not execute arbitrary commands or access personal files,
persist conversations, or store secrets. Ollama is optional, local-only, and receives prompts only
when selected by configuration. Structured model tool calls are untrusted requests and run only
through ToolRuntime and PolicyEngine. The Host binds to `127.0.0.1`, uses
an ephemeral session and CSRF token, validates exact Origins, and exposes only the small versioned
API. Its audit sink is in-memory and not durable. Policy remains a starting point, not an
authorization system until connected to trusted identity, permissions, approval, and audit storage.

## Initial threat register

| Threat                      | Impact                                                                               | Initial mitigation                                                                                                                                                                                                       | Status                                             |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Arbitrary command execution | Host compromise, data loss                                                           | No shell adapter; never execute model text; known executable plus validated arguments only in a future reviewed tool                                                                                                     | Prevented by scope; future design                  |
| Prompt injection            | Unauthorized tool requests or disclosure                                             | Treat all external content as untrusted data; it cannot grant permissions, alter policy/configuration, approve actions, bypass confirmation, or elevate privileges; independent PolicyEngine and trusted approval checks | Design requirement; enforcement future             |
| Malicious localhost webpage | A hostile website invokes the local Host API to operate tools or disclose local data | Loopback-only bind; exact Origin validation; no CORS; HttpOnly SameSite session cookie; CSRF token for POST; authenticated SSE; CSP, safe headers, bounded requests, timeouts                                            | Implemented for M4 endpoints                       |
| Malicious plugins           | Code execution or data exfiltration                                                  | No plugin loader in M4; later require explicit trust, capability limits, and isolation review                                                                                                                            | Out of scope                                       |
| Path traversal              | Access beyond approved roots                                                         | Validate canonical paths and scope filesystem tools; no filesystem tools in M4                                                                                                                                           | Future design                                      |
| Secret leakage              | Account compromise                                                                   | No secrets in repo or plaintext database; future OS-backed SecretStore and redacted logs                                                                                                                                 | Policy documented                                  |
| Unauthorized file access    | Private data disclosure or modification                                              | Least privilege and explicit user-approved roots; no filesystem adapter in M2                                                                                                                                            | Future design                                      |
| Excessive permissions       | Broad, persistent access                                                             | Per-tool declared permissions, policy checks, narrow grants and revocation                                                                                                                                               | Contracts started; enforcement future              |
| Unsafe AI tool calls        | Harmful or unintended actions                                                        | Validate schemas, exact registry lookup, PolicyEngine; ASK/DENY stop without execution or provider retry; bounded sequential loop                                                                                        | Implemented in M4.1                                |
| Log leakage                 | Personal data or credential disclosure                                               | Pino logs omit request bodies, cookies, CSRF tokens, prompts, and provider payloads; events and audit omit content                                                                                                       | Initial Host controls; review as integrations grow |
| Untrusted MCP server        | Tool spoofing or data disclosure                                                     | No MCP client in M4; later treat server tools/results as untrusted and require allowlisting                                                                                                                              | Out of scope                                       |
| Dependency supply chain     | Vulnerable or compromised code                                                       | Exact versions, lockfile, small dependency set, review and updates                                                                                                                                                       | Initial controls                                   |
| Excessive process privilege | Compromise gains admin/system authority and access to other sessions                 | Run Host in the signed-in user's session, not permanently as LocalSystem; future administrative actions require policy, approval, and a narrowly scoped UAC helper                                                       | Design requirement; not implemented                |

## Review requirements

New execution capabilities need a threat review, input validation, declared permissions and risk,
policy enforcement, bounded execution, and redacted audit events. Tool security must not depend on
the system prompt. Reject unknown tools and invalid configuration explicitly. Keep personal data,
credentials, runtime logs, databases, and model files out of version control.

## Local Host requirements (M2/M4)

The Host's loopback API is reachable by a browser page even when the page cannot read responses.
Treat it as an exposed API, not as trusted IPC. Bind to `127.0.0.1` by default, validate browser
Origins, restrict CORS, authenticate local sessions and streaming upgrades, apply CSRF defenses to
cookie-authenticated mutations, and set a strict UI CSP and safe headers. Cap message sizes and
timeouts; add rate limits to abuse-prone routes. Never use wildcard CORS on sensitive routes.
Remote access is disabled by default and needs explicit activation, authentication, pairing, TLS,
and separate policy.

### M2 implementation notes and limits

`GEORGE_HOST_PORT` changes only the port; public bind addresses cannot be configured. Bootstrap
creates random session and CSRF values held in process memory; the cookie is
`HttpOnly; SameSite=Strict; Path=/` and expires after eight hours. The CSRF token exists in Angular
memory only and is sent in `X-George-CSRF`. While Host serves plain HTTP, the cookie has no `Secure`
attribute; local HTTP is not encrypted against other local processes, so this is not a substitute
for OS-level isolation. Sessions disappear on restart.

Production accepts the exact Host origin. Development additionally accepts the loopback Angular
origin and proxies `/api/**`, avoiding CORS. POST requires `Origin`; same-origin EventSource GET may
omit it, so Host requires `Sec-Fetch-Site: same-origin` plus an exactly allowlisted loopback Host
authority, or validates a matching loopback `Referer`. There are no CORS headers. Host sets CSP with
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and disables camera,
microphone, and geolocation. Request bodies are limited to 16 KiB, user text to 4,000 characters,
headers to bounded sizes, and HTTP timeouts are configured. Session bootstrap has in-memory rate and
session-count limits. SSE requires Origin and session checks and has heartbeats and shutdown cleanup.

`GET /api/v1/tools` requires the local session. `POST /api/v1/tools/:id/execute` additionally
requires exact Origin and CSRF. It resolves only registered IDs, validates input using each tool's
Zod schema, and calls PolicyEngine before any handler. Granted permissions come from validated Host
configuration, never the request body. The development default explicitly grants only
`system.info.read`; `GEORGE_TOOL_PERMISSIONS` overrides the set, and an empty value grants none.
`system.info` uses `node:os` and returns platform, architecture, hostname, CPU model/count, memory
totals, and uptime, without environment variables or home paths. Runtime timeouts are capped and
cancellation signals reach handlers. `ASK` returns `APPROVAL_REQUIRED` and never executes; no
approval engine exists yet. Tool audit excludes input and output, stays in memory, and is lost on
Host shutdown. A browser compromise or local process can still act as the signed-in browser session;
plain local HTTP provides no confidentiality from other local processes.

George has no process listing, application control, filesystem access, arbitrary shell, or
persistent audit. `system.info` is portable and does not justify a platform package.
Process listing is deferred until an OS-specific adapter and output disclosure review are designed.

## Untrusted content boundary

All content obtained from web pages, documents, email, messages, APIs, and MCP servers is untrusted
input. Content may propose actions but cannot change policy or security configuration, grant
permissions, approve a pending operation, bypass confirmation, or elevate privileges. Only trusted
application configuration, the PolicyEngine, and the explicit approval mechanism can authorize an
action. Preserve provenance and treat retrieved instructions as data when building model context.

## AI providers (M3)

M3 can optionally send the current prompt to a user-selected model in local Ollama. Provider configuration accepts only HTTP loopback origins, and redirects are rejected. Calls have bounded timeouts, respect cancellation, and validate Ollama responses as untrusted input. Public errors are fixed safe messages. AI status and model catalog routes require the local session and use Cache-Control: no-store. Discovery never installs or downloads a model. Provider logs do not include prompts, responses, cookies, or headers. Cloud providers and credential handling remain out of scope.

## M4 Tool Runtime threat review

| Threat                                                     | M4 mitigation                                                                                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious tool input                                       | Every handler input is parsed through its registered Zod schema; invalid input is rejected before policy and handler invocation.                                                                     |
| Tool confused deputy or privilege escalation               | Tool definitions declare risk and required permissions; ToolRuntime always consults PolicyEngine; Host takes grants only from validated configuration and uses no request-supplied grants.           |
| Command injection, path injection, unsafe process spawning | No process listing, shell, filesystem, or app-control tool exists; system.info uses fixed node:os APIs and spawns no process.                                                                        |
| Tool denial bypass                                         | Host execution route can only call ToolRuntime; registry only resolves definitions and has no invoke operation. ALLOW is the only path to a handler.                                                 |
| Excessive or sensitive tool output                         | system.info returns a fixed small set of host facts; it omits environment, home paths, interfaces, and command lines. Future adapter output must be treated as untrusted and validated by consumers. |
| Timeout exhaustion                                         | Runtime caps per-tool timeout, propagates AbortSignal, races handlers against cancellation, and records TIMED_OUT.                                                                                   |

The process-list tool was deferred: system.info is fully portable through node:os, while safe Windows process listing needs a separate adapter and disclosure review. No platform package was added.

## M4.1 Agent tool orchestration threat review

| Threat                                        | Impact                                           | Implemented mitigation                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Malicious model tool call or unavailable tool | Unauthorized capability use or confusing retries | Provider output is accepted only as a structured result; exact IDs are resolved by ToolRuntime; unknown IDs fail without fuzzy matching.                                                         |
| Tool argument injection or schema bypass      | Handler misuse or privilege escalation           | Model input stays untrusted and is validated by the registered Zod schema before PolicyEngine and handler invocation.                                                                            |
| Repeated tool loop or denied call             | Resource exhaustion or policy probing            | Four tool-call rounds and eight calls per round; calls are sequential; ASK, DENY, invalid input, unknown tool, cancellation, or failure stops the request without provider retry.                |
| Tool output prompt injection                  | Retrieved content may influence model behavior   | Results are appended only as structured `tool` messages, never system instructions; they cannot grant permissions or change policy. This does not guarantee that a model ignores malicious data. |
| Oversized tool result                         | Memory or provider request exhaustion            | Each serialized output is bounded at 16 KiB; excess fails without truncation and is not sent for continuation.                                                                                   |
| Provider-specific parsing bug                 | Malformed vendor data crosses into Core          | Ollama conversion and Zod response validation remain in `@george/ai`; Core sees only the neutral result. No free-form parsing or regex is used.                                                  |
| Correlation ID spoofing                       | Provider ID mistaken for authority               | Provider call IDs are bounded and unique within a response and used only for correlation; George generates separate execution IDs.                                                               |

Request-local tool transcripts are discarded after the Agent request. Before sending tools, Ollama
checks the selected model's advertised `tools` capability via `/api/show`; missing or negative
metadata fails closed. A supported model may still return an ordinary final message, in which case
no tool runs. Ollama calls time out at 120 seconds, ToolRuntime calls are capped at 120 seconds, and
Host cancels the whole Agent request after 130 seconds.
