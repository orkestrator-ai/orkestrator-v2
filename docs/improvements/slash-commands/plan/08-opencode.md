# 08 — Use OpenCode's effective command catalogue and command API

Status: proposed. Dependencies: 01–04. [Index](00-index.md).

## Owners and version constraint

`apps/backend/src/core/opencode-commands.ts`, `opencode-capabilities.ts`,
`opencode-provider.ts`, provider contract tests, dispatch tests, and existing
message-ID/reconciliation helpers. Use `@opencode-ai/sdk/v2/client` at the
repository pin; Context7 examples using nested `path`/`body` parameters are not
the API shape to implement here.

## Catalogue

1. Remove `OPENCODE_BUILT_IN_SLASH_COMMANDS` from the executable inventory.
   `/themes`, `/exit`, `/editor`, and similar TUI controls are not evidence of
   a server command. Empty discovery remains empty.
2. Fetch the effective catalogue for the environment's directory. Qualify
   whether an additional unscoped read supplies anything useful; avoid the
   current two-request merge when the scoped list already includes inherited
   commands. Request position must not determine project/user ownership.
3. Normalize exact canonical names, real alias fields if available at the pin,
   descriptions, argument hints, and verified origin. Unknown origin is valid.
4. Retain server command defaults and relevant agent/model/subtask metadata
   privately. Expose a concise behavior hint only where the actual SDK data
   supports it. Do not expose command template bodies in the projection.
5. Validate failed/error SDK responses instead of silently converting them into
   a successful hard-coded catalogue. Surface stale/unavailable snapshot state.
6. Unify the public catalogue and executable name/binding cache. Preserve the
   current explicit-refresh invalidation, but remove duplicate sources that
   can disagree about what the selected command means.

## Dispatch

Use `session.command` only for a binding present in the effective authoritative
catalogue. Send canonical provider spelling, not the shared parser's lowercased
lookup key. Resolve aliases to that canonical name before dispatch.

Keep the current flat request shape: `sessionID`, `directory`, `messageID`,
`command`, required `arguments`, and supported optional fields. A bare command
must send `arguments: ""`. Preserve multiline arguments and supported file
parts; do not add a duplicate plain-text part containing the command.

Specify default precedence from step 01's pinned behavior: an explicit user
model/agent selection versus a command-defined default versus the session
default. Avoid always passing an implicit session default if it would override
the command's own intentional configuration. Keep read-only/coordinator policy
and tool restrictions at the provider's enforced boundary; a command that
selects an agent must not widen that boundary.

Do not interpret or expand the template in the renderer/backend. OpenCode owns
its command grammar, subtask behavior, file insertion, and execution lifecycle.
Unsupported metadata can be retained for execution or omitted, but cannot be
guessed from descriptions.

## Failure and recovery

An explicitly selected command that disappears or fails discovery must return
a command-specific pre-dispatch error. Remove the current discovery-error-to-
plain-prompt fallback for explicit selection. Unknown ordinary slash text can
still use the documented literal path.

Retain the existing exclusive message-ID reservation and transcript recovery.
Command execution can last longer than a prompt-acceptance request: qualify
`session.command` response timing and ensure the timeout does not incorrectly
prove non-dispatch. Lost responses remain ambiguous and reconcile with the same
`messageID`; do not create a second `promptAsync` turn as fallback.

Preserve workflow opt-out and the existing request marker. Reconnect/SSE
reconciliation must observe command/subtask progress and terminal outcome while
the user views another environment. A successful command transport response
does not by itself prove all subtask work has finished.

## Runtime shortcuts

Offer `/compact` through the existing native action only if qualified. UI
choices such as model selection or session navigation can be designed later;
they should not be smuggled into `session.command`. Keep known unsupported TUI
spellings in explanatory metadata only, not the executable command name set.

## Required tests

- Effective scoped discovery with inherited, builtin server, project, skill,
  and unknown-origin entries; no fabricated source labels.
- Both discovery endpoints fail, one fails, malformed data, and successful
  empty inventory produce distinguishable outcomes.
- `/exit` or `/themes` never calls `session.command` unless the server actually
  advertises a real same-named command with a supported binding.
- Canonical mixed-case name, aliases, no arguments, multiline arguments,
  attachments, and command defaults produce exact SDK requests.
- Removed selected command, old binding revision, and refresh race send nothing.
- Workflow prompt starting with slash stays on the intended literal path.
- Long command response, dropped acknowledgement, provider reconnect, and
  inactive environment retain at-most-once dispatch and authoritative progress.

Exit when the picker and executable registry are derived from the same effective
inventory and all existing dispatch/reconciliation guarantees remain covered.
