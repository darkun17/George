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
| M5 Policy + Approval + Audit              | Approval lifecycle, persistent audit, and permission model                                               | Planned |
| M6 Memory                                 | Local memory model, retention and user controls                                                          | Planned |
| M7 Projects + Developer Tools             | Project context and safe Git/build tools                                                                 | Planned |
| M8 Knowledge                              | Document ingestion and retrieval with source provenance                                                  | Planned |
| M9 Voice                                  | Separate speech service and channel                                                                      | Planned |
| M10 Vision                                | Explicit screen capture and image understanding                                                          | Planned |
| M11 Automations                           | Scheduled workflows under policy and audit                                                               | Planned |
| M12 Integrations                          | Carefully scoped service and MCP adapters                                                                | Planned |
| M13 Distribution                          | Windows packaging, data migration and update strategy                                                    | Planned |

M0.5 aligned the architecture without creating placeholder apps or packages. M1 now provides the
request lifecycle, provider port usage, typed public errors, separate event and audit sinks, and a
mock provider. M2 can adapt these ports to a secured local transport and Command Center without
changing Core. M2 establishes local transport authentication before provider selection and Ollama
arrive in M3. M4 adds an independent policy-gated Tool Runtime with bounded execution, audit, and the
read-only `system.info` tool. M4.1 connects Agent orchestration and structured Ollama tool calling
through the same policy-gated runtime. M5 will add approval and durable audit. Voice stays after these
boundaries so it cannot bypass them. Vision follows explicit capture and consent design. Automation
follows reliable approval and audit.

M3 adds the independent @george/ai boundary with deterministic mock and local Ollama providers, validated selection, model discovery, and separate AI health. An optional Anthropic adapter is a later M3.1 candidate; M3 includes no cloud provider.
