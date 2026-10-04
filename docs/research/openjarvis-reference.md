# Research: OpenJarvis-style local voice architecture

Status: architectural/product ideas only. No code from any external project has been copied. If
concrete third-party code is reused later, review its license, preserve required notices, and
document provenance here before merging.

## Ideas worth adapting for George's future voice milestones (M7+)

- **Local-first speech loop.** Microphone → Voice Activity Detection → local STT → the existing
  Host/AgentRuntime → local TTS → speaker, with no cloud round-trip required for the voice
  transport itself. Matches George's local-first principle; the AI provider stays swappable
  independently of the voice transport.
- **faster-whisper for STT.** A well-known local Whisper inference backend with configurable model
  size, device selection, and Spanish support. George should treat the specific STT backend as a
  provider behind an abstraction, not a hardcoded dependency, so it can be swapped later.
- **Kokoro with a Windows SAPI fallback for TTS.** Prefer a higher-quality local TTS voice; fall back
  to the OS-provided SAPI voice if Kokoro is unavailable or misconfigured; fall back to text-only if
  both fail. George must remain usable with voice entirely absent.
- **Push-to-talk before wake word.** Ship a manual activation (hotkey or UI button) first; add
  always-listening wake-word detection only once push-to-talk is stable, to bound CPU/privacy
  exposure during early iterations.
- **Doctor-reported voice status.** Whatever voice stack is chosen, George Doctor should report
  installation/configuration status per component (microphone detected, STT available, TTS
  available) using real checks, matching the pattern already established for AI/security checks in
  M5.0.2.
- **Optional clap/gesture activation.** A convenience trigger, never a security boundary -- consistent
  with George's rule that voice/gesture input can request actions but never approve them.

## Explicitly not adopted without further review

- Any specific project's exact model weights, prompts, or code should not be vendored without a
  license check.
- Always-on wake word is deferred until push-to-talk is proven stable in George's own UI.
- Voice-phrase approval ("yes", "approve") is rejected outright per George's security model: approval
  remains a deliberate UI action until a dedicated secure voice-approval design exists.
