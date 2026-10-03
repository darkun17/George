# Product

## Vision

George is a personal AI operating system: a local-first assistant that can build a useful model of
its user's context and carry out approved work through explicit tools. This is a staged product
vision, not a description of current M0 functionality.

## Problem and users

People work across documents, projects, applications, and services, while general chat interfaces
usually lack durable personal context and carefully bounded ways to act. George is for an
individual who wants a configurable assistant on their own computer, with a future path to other
installations and operating systems.

## What George is

- Generic engine plus installation-owned profile, memory, tools, policies, and data.
- Local-first and provider-agnostic, with auditable, permissioned capabilities.
- Built incrementally with explicit human approval for sensitive work.

## What George is not

- A generic chatbot, an unrestricted computer controller, or an LLM-driven shell.
- Bound to Claude Code, any AI vendor, or the initial Windows platform.
- At M0.5, a working conversational application, local host, web UI, desktop shell, voice, memory,
  or automation application.

## Principles

Security before autonomy; explicit capabilities; user-owned data; portable core; observable actions;
small composable interfaces; no personal identity in engine code.

## Future capabilities

Profile-aware conversation, durable memory, document knowledge, project tools, approved operating
system integrations, provider adapters, MCP integrations, automation, voice, screen understanding,
and additional channels. Each needs separate design and security review.

## Local interaction model

The primary experience is planned as an Angular Command Center served locally by a George Host in
the signed-in user's Windows session. A browser connects to a loopback-only endpoint by default.
Tauri remains an optional desktop shell for a window, tray, notifications, hotkeys, and autostart;
George is not Tauri-only. Remote access is disabled by default. Docker is optional for isolated or
auxiliary services and is not suitable for capabilities that interact with the user's live desktop.

The future Command Center may include Dashboard, Chat, Projects, Tools, Memory, Knowledge,
Automations, Activity, Security, and Settings. It should expose what George is doing, including
tool names and approval state. A compact launcher/overlay, invoked by a configurable global hotkey
such as Ctrl+Space, is also a future feature. No UI, host, tray, autostart, or launcher is implemented
in M0.5.

## M0 scope

Establish a buildable pnpm TypeScript workspace, strict compiler settings, lint/format/test commands,
shared contracts, a default policy engine, tool SDK shape, profile schema, documentation, and safe
package boundaries. No real AI provider, execution adapter, desktop UI, database, or personal data.

## License decision (pending)

MIT is short and permissive, with minimal conditions. Apache-2.0 is also permissive and includes
express patent-license and patent-termination provisions, but has longer notice and contribution
terms. Both require preserving applicable notices; neither guarantees project success or replaces
legal advice. **Recommendation: Apache-2.0** if the project intends to accept outside contributions
and welcomes commercial reuse, because its express patent terms provide contributors and users
clearer patent licensing. Keep the choice pending until the project owner approves it; no license
has been granted by M0.
