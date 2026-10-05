# ADR-008: Projects, read-only Git, and scoped filesystem boundary

- Status: Accepted
- Date: 2026-10-05

## Context

M5.2 gives George its first ability to look inside a software project: list files, read a file,
search file contents, and inspect Git state (status, branch, log, diff). This is materially more
sensitive than M5.1's desktop launcher, because the natural shape of these capabilities --
"give me a path", "run git with these args", "cd into this folder" -- is exactly the shape of an
arbitrary-filesystem or arbitrary-command primitive if implemented naively. The AI must never be able
to supply a raw filesystem root, an arbitrary `cwd`, an arbitrary executable, raw Git arguments, a
shell fragment, or absolute filesystem authority of any kind. At the same time, George must stay
read-only here: it may inspect a project but must not modify, move, or delete anything in it in this
milestone.

## Decision

**A trusted `ProjectRegistry` is the only source of `projectId` → filesystem-root resolution.**
Projects are configuration-only references (id, display name, root path, optional default
application), persisted through the same `SettingsStore`/Zod-schema architecture already used for
Settings (`projectDefinitionSchema` in `@george/config`) -- no second configuration system was
introduced. Removing a project from George's configuration never touches the referenced folder; the
Settings UI states this explicitly before the user confirms removal. `ProjectRegistry` is constructed
with a live getter over the current configuration and re-canonicalizes/re-`stat`s a project's root on
every resolution, rather than caching a result from the moment the project was added, so a root that
becomes unavailable (deleted, unmounted, replaced by a symlink) is caught at the moment a tool tries
to use it.

**Every tool in this surface accepts only a trusted `projectId` and, where relevant, a relative
`relativePath` -- never an absolute path, a raw `cwd`, or raw Git arguments.** All input schemas are
Zod `.strict()`, which rejects any additional field a caller might try to smuggle in (e.g. `path`,
`cwd`, `gitArgs`). `project.open` additionally accepts an optional trusted `applicationId`, resolved
the same way `apps.open` resolves one.

**Path containment resolves and canonicalizes; it never trusts a string prefix.** A naive
`target.startsWith(root)` check would wrongly authorize a sibling directory that merely shares a name
prefix (`C:\Projects\foo` would wrongly authorize `C:\Projects\foobar`). `resolveProjectPath` rejects
any `..` segment and any absolute/drive/UNC path outright, then requires
`resolved === root || resolved.startsWith(root + sep)`. Because a symlink or junction can be created
_after_ that lexical check passes and before the file is actually read (TOCTOU), a second function,
`assertRealPathContained`, re-resolves both the root and the candidate path with
`realpathSync.native` immediately before every sensitive filesystem operation.

**Git access is strictly read-only and uses direct, structured process invocation -- not a Git
library.** `GitAdapter` spawns the fixed `git` executable with `shell: false`, a George-built argument
array, a bounded output buffer, and a timeout. The exposed tools are `git.status`,
`git.branch.current`, `git.log` (bounded `limit`), and `git.diff` (narrow `scope: "working" |
"staged"` input only -- no ref, revision-range, pathspec, or flag passthrough). Every write/mutating
Git subcommand -- `add`, `commit`, `push`, `pull`, `fetch`, `checkout`, `switch`, `merge`, `reset`,
`restore`, `clean`, `stash`, `rebase`, and any branch/tag creation or deletion -- is simply absent from
the tool surface, not merely undocumented. Git output (diff text, log messages, branch names) is
treated as untrusted data: it is returned as plain structured tool output and is never interpolated
into a system or security instruction.

**Sensitive files are denied before any access, deterministically.** `isSensitivePath` matches a
basename against a fixed, case-insensitive pattern list (`.env`/`.env.*`, `*.pem`, `*.key`, `*.pfx`,
`*.p12`, `id_rsa`/`id_ed25519`/`id_ecdsa` (and `.pub`), `credentials*`, `secrets*`, `.npmrc`, `.netrc`,
`known_hosts`, `authorized_keys`) and runs _before_ any `stat` or read, so a denial never confirms or
denies the file's existence. This is not an LLM judgment call and cannot be bypassed by a traversal
sequence, because containment is already checked first.

**All list/read/search/log/diff output is bounded by centralized constants**
(`packages/tools-core/src/output-limits.ts`: `PROJECT_LIST_MAX`, `DIRECTORY_LIST_MAX`,
`FILE_READ_MAX_BYTES`, `SEARCH_MAX_FILES`, `SEARCH_MAX_RESULTS`, `GIT_LOG_MAX`,
`GIT_DIFF_MAX_BYTES`, and related constants), rather than scattered magic numbers, so the budgets are
auditable in one place.

**`project.open` is the one non-read-only tool, and it reuses rather than duplicates the M5.1 launch
path.** It resolves `projectId` → canonical root through `ProjectRegistry`, resolves an
`applicationId` (explicit, or the project's configured default) through the same
`ApplicationRegistry` that backs `apps.open`, and launches it via the same `launchExecutable` helper
with the canonical root as its only argument. It is `riskLevel: "HIGH"` and runs through the identical
`ToolRuntime` → `PolicyEngine` → Approval → Audit pipeline as every other high-risk tool. The Projects
UI's "Abrir proyecto" button calls a dedicated `POST /api/v1/projects/:id/open` route that registers
a continuation in the same `PendingApprovalStore` the Agent uses, so a UI-triggered open and an
Agent-triggered open resolve through the exact same approval list and
`/api/v1/approvals/:id/approve|deny` routes -- there is deliberately no separate UI code path for this
action.

**Audit records only safe metadata.** ProjectId, toolId, status, risk, policy outcome, approval
correlation, duration, and a typed safe error code are recorded; file contents, search snippets, Git
diff/log bodies, prompts, and AI responses are never persisted, matching the existing M5 audit
contract.

## Alternatives considered

### Use a Git library (e.g. `simple-git`) instead of direct `spawn`

A library would save some porcelain-output parsing, but adds a dependency whose own argument-building
and shell-invocation behavior would need the same security review as our own code, for marginal
benefit given how narrow the four read-only operations are. Rejected: direct structured invocation
with `shell: false` is simpler to audit and has no transitive supply-chain surface for this scope.

### Allow an explicit filesystem root in tool input, validated against an allowlist at call time

Would avoid needing a persisted `ProjectRegistry`, but reintroduces exactly the "AI supplies a path"
shape this ADR exists to avoid, and loses the stable, reviewable `projectId` indirection the rest of
the system (Settings UI, audit, approval summaries) depends on. Rejected.

### Cache a project's canonical root at registration time

Simpler and faster, but would let a root that becomes invalid, unmounted, or redirected by a
symlink/junction after registration continue to be treated as valid until the next explicit
re-validation. Rejected in favor of re-resolving on every use.

## Consequences

- `ProjectRegistry`, `GitAdapter`, and the filesystem tools live in `@george/tools-core`, following
  the same package boundary as `ApplicationRegistry` and the M5.1 tools.
- `@george/config` gained `projectDefinitionSchema` and an `assistantProfileSchema.projects` field;
  no new configuration package or file format was introduced.
- No write, delete, move, or mutating-Git capability exists anywhere in this milestone; introducing
  one later requires its own threat review, approval gating, and audit design, following the pattern
  already established by `apps.open` and `project.open`.
- M6 (Memory) and Voice are unaffected by and do not depend on this boundary; they were explicitly
  out of scope for this change.
