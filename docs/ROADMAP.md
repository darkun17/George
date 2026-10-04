# Roadmap

Milestones are proposed; each needs a focused scope and acceptance criteria before implementation.

| Milestone                                 | Focus                                                                                                    | State   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| M0 Foundation                             | Workspace, contracts, config schema, policy baseline, docs, checks                                       | Done    |
| M0.5 Local Runtime Architecture Alignment | Local web + native Host decision, lifecycle and transport security boundaries                            | Done    |
| M1 Agent Core                             | Request lifecycle, typed errors, agent boundaries, audit interface, mocked provider; no cloud dependency | Done    |
| M2 Local Host + Command Center            | Loopback HTTP, local session security, streaming, Angular dashboard/chat, visible activity               | Done    |
| M3 AI Providers                           | Provider adapters, first real provider, local provider option                                            | Done    |
| M4 Tool Runtime                           | Registry, dispatcher, execution pipeline, timeouts, typed results                                        | Done    |
| M4.1 Agent Tool Orchestration             | Provider-neutral tool calls, policy-gated Agent loop, Ollama adapter, visible activity                   | Done    |
| M5 Policy + Approval + Audit              | Approval lifecycle, persistent audit, and permission model                                               | Done    |
| M5.0.1 Dev transport hotfixes              | Dev-mode session/CSRF collision fix, chat layout fix                                                      | Done    |
| M5.0.2 Settings + George Doctor            | Settings UI/API, persisted assistant profile, real diagnostics                                           | Done    |
| M5.1 First Desktop Actions                | ApplicationRegistry, apps.list/apps.open, read-only process listing, approval-gated                      | Done    |
| M5.2 Projects + Git + Safe Files          | Project registry, read-only Git tools, scoped read-only filesystem tools                                 | Planned |
| M6 Profile + Memory                       | Local memory model, retention and user controls                                                          | Planned |
| M7 Voice Foundation                       | Push-to-talk voice channel, local STT/TTS                                                                 | Planned |
| M7.1 Activation                           | Global hotkey, later wake word                                                                            | Planned |
| M7.2 Tray + Autostart + Native Shell       | System tray, user-controlled autostart, optional Tauri shell                                              | Planned |
| M8 Immersive George Orb                   | Three.js orb reflecting real runtime state                                                                | Planned |
| M9 Vision                                  | Explicit, approval-gated screen capture and image understanding                                           | Planned |
| M10 Automations                           | Scheduled workflows under policy and audit                                                                | Planned |
| M11 Integrations                          | Carefully scoped service and MCP adapters                                                                | Planned |
| M12 Distribution                          | Windows packaging, data migration and update strategy                                                     | Planned |

M0.5 aligned the architecture without creating placeholder apps or packages. M1 now provides the
request lifecycle, provider port usage, typed public errors, separate event and audit sinks, and a
mock provider. M2 can adapt these ports to a secured local transport and Command Center without
changing Core. M2 establishes local transport authentication before provider selection and Ollama
arrive in M3. M4 adds an independent policy-gated Tool Runtime with bounded execution, audit, and the
read-only `system.info` tool. M4.1 connects Agent orchestration and structured Ollama tool calling
through the same policy-gated runtime. M5 added the approval lifecycle, exact-operation binding, and
persistent SQLite audit. M5.0.1 fixed two development-only transport issues (a dev-mode session/CSRF
collision and a chat layout bug) without touching the security model. M5.0.2 activated Ajustes with a
real Settings UI/API backed by a persisted assistant profile (outside the repository, no secrets) and
a George Doctor that performs real, non-hardcoded checks. M5.1 gave George its first controlled
desktop actions (`apps.list`, `apps.open`, `system.process.list`) through a trusted
`ApplicationRegistry` the model can only reference by ID, with `apps.open` requiring explicit human
approval. Voice stays after these boundaries so it cannot bypass them. Vision follows explicit capture
and consent design. Automation follows reliable approval and audit.

M3 adds the independent @george/ai boundary with deterministic mock and local Ollama providers, validated selection, model discovery, and separate AI health. An optional Anthropic adapter is a later M3.1 candidate; M3 includes no cloud provider.
