# ADR-007: Local web runtime and native Host

- Status: Accepted as direction; implementation deferred
- Date: 2026-10-02

## Context

George needs a convenient command center and eventual access to native Windows capabilities. A
browser offers a flexible UI, while desktop interaction, audio, hotkeys, windows, and processes need
to run in the signed-in user's OS session. A powerful localhost API also introduces a browser-origin
attack surface. M0 has no runtime application yet.

## Decision

Choose **D) Hybrid local web + native Host**. A George Host process will own lifecycle, initialize
Core, and expose a limited local HTTP and streaming API to an Angular Command Center at
`http://127.0.0.1:<configurable-port>`. Bind to `127.0.0.1` by default, never `0.0.0.0`; add `::1`
only as an explicit, tested loopback option. Remote access is disabled by default.

The Host is the local native boundary. It runs as the signed-in user, not permanently as
`LocalSystem`, and coordinates Core, profile/configuration, memory, tools, PolicyEngine, audit,
transport, and future native adapters. Web requests do not call tools directly: Host routes requests
through Core and policy. The Host API is not trusted merely because it is loopback; before any
action-capable endpoint ships it needs Origin validation, restrictive CORS, local session auth for
HTTP and streaming, applicable CSRF protections, CSP and safe headers, bounded payloads, timeouts,
and suitable rate limits. Wildcard CORS is forbidden on sensitive endpoints.

Tauri remains an optional shell that may open the same Command Center and Host API, adding a desktop
window, tray, launcher, autostart, notifications, or global hotkeys. A regular browser remains a
supported client. Autostart is opt-in and user-disableable. The primary UI should surface status,
tool activity, and approval state.

Docker is optional for MCP servers, databases, AI services, or isolated auxiliary workloads.
Capabilities interacting with the live user desktop—applications, windows, microphone/audio,
clipboard, hotkeys, capture, UI Automation, or interactive processes—run outside Docker in the
user's session. Administrative work requires policy and approval followed by a narrowly scoped
UAC/elevated helper; the Host holds no permanent admin privilege.

No Host app, web app, desktop shell, server, Docker setup, or OS-specific package is created until
it has a real implementation responsibility. Keep Core portable and add platform adapters when
capabilities are implemented. macOS and Linux Hosts may later offer equivalent user-session behavior
with their own credential, permission, and desktop adapters.

## Alternatives considered

### A) Desktop/Tauri only

Provides native lifecycle and OS integration, but makes the UI dependent on one shell and complicates
ordinary browser access. Rejected as the only runtime; Tauri stays an optional shell.

### B) Browser/local web only

Gives a lightweight UI, but browsers cannot supply all required native desktop capabilities and
leaves the host/runtime boundary underspecified. Rejected as the complete architecture.

### C) Docker-first

Offers useful isolation for selected services, but is not a suitable runtime for interactive desktop
capabilities in the user's session and would impose an unnecessary prerequisite. Rejected as the
primary host; Docker remains optional.

### D) Hybrid local web + native Host

Combines browser flexibility with a least-privilege native process and leaves Tauri optional. Chosen,
with localhost treated as an exposed network boundary and protected before tools are reachable.

## Consequences

- M0 remains unchanged; M0.5 adds architecture and security requirements only.
- M1 can define request, error, and audit ports without committing to an HTTP framework.
- M2 must deliver local session security, loopback binding, and streaming authentication with its
  first action-capable transport, alongside the initial Angular UI.
- Distribution must manage a per-user Host lifecycle; autostart is optional and reversible.
- No Docker, Tauri, Angular, HTTP server, WebSocket implementation, platform package, or runtime
  dependency is introduced by this ADR.
- Exact port selection, local bootstrap/session mechanism, Origin behavior for direct browser use,
  UI serving strategy, and update/signing model remain open for M2/distribution design.
