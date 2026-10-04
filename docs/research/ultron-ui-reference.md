# Research: Ultron-style immersive UI architecture

Status: architectural/product ideas only. No code from any external project has been copied. If
concrete third-party code is reused later, review its license, preserve required notices, and
document provenance here before merging.

## Ideas worth adapting for George's future orb milestone (M8+)

- **Three.js orb as a view of state, not a second state machine.** The orb should subscribe to
  George's existing `AgentDisplayState` (today: `READY`, `THINKING`, `EXECUTING`,
  `WAITING_APPROVAL`, `ERROR`; voice adds `LISTENING`, `TRANSCRIBING`, `SPEAKING`) and render it --
  it must never derive or invent its own notion of what George is doing. The current CSS/SVG orb in
  `app.component.html` already follows this pattern (`orb-wrap.thinking`, `.executing`,
  `.waiting-approval`, `.error` classes driven by `facade.agentState()`); a Three.js version should
  keep the same single source of truth.
- **Reasonable GPU budget.** Avoid unnecessary shader/particle complexity; respect
  `prefers-reduced-motion` (George's stylesheet already does this for the current orb); never let
  state be color-only, since color alone is not accessible.
- **Graceful WebGL fallback.** If WebGL is unavailable, fall back to the existing CSS/SVG orb rather
  than blocking the UI -- the simple orb is not disposable scaffolding, it is the fallback.
- **Show Mode as an additional view, not a replacement.** A fullscreen, voice-oriented, minimal-panel
  mode is additive to the existing Command Center/Settings views (see `AppComponent`'s `activeView`
  signal introduced in M5.0.2), not a rewrite of the productivity UI.
- **MediaPipe hand tracking as a UI convenience only.** Rotation/zoom/navigation gestures are
  plausible; gestures must never be wired to permission grants or tool approval, matching George's
  rule that voice/gesture/clap input can request actions but never approve them. Camera access stays
  off by default and requires explicit user enablement, reported by George Doctor like any other
  capability.

## Explicitly not adopted without further review

- No specific project's exact shader code, 3D assets, or UI copy should be vendored without a
  license check.
- Visual richness is secondary to the existing invariant that critical state must never depend on
  color alone.
