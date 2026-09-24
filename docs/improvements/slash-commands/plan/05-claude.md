# 05 — Correct Claude command discovery and execution identity

Status: proposed. Dependencies: 01–04. [Index](00-index.md).

## Owners

`bridges/claude-bridge/src/services/session-manager-catalog.ts`,
`session-manager-prompt.ts`, `session-manager-core.ts`, session types and
persistence, `routes/session.ts`, `routes/plugins.ts`, and backend
`http-bridge-catalog.ts`. Existing catalogue-transport tests are particularly
important because a draining CLI control can still be present but unusable.

## Discovery changes

1. Remove unconditional `CLAUDE_BUILT_IN_SLASH_COMMANDS` seeding from successful
   SDK-backed responses. A successful empty inventory must stay empty.
2. Preserve SDK command names and aliases exactly. Normalize only the display
   prefix. Replace appended `/skill:name` rows with annotations on the matching
   `/<name>` entry. Preserve `plugin:name` namespaces. If init names are the
   only available data, describe the reduced metadata/freshness explicitly.
3. Stop defaulting absent SDK provenance to `builtin`. The installed declaration
   has no source/scope fields. Use a verified skill-name match, supplied metadata
   when actually available, or `unknown`. Do not infer plugin ownership merely
   from any colon in an arbitrary name.
4. Handle `system/commands_changed` as a full replacement using the same
   normalizer as `supportedCommands()`. Update bridge-owned inventory/revision
   even when no browser subscribes. Retain init inventory as a cold fallback.
5. Prefer readable live query control, then a qualified cached snapshot. Keep
   the draining-control guard and narrow closed-transport error handling.
   Do not turn arbitrary SDK errors into cached success.

## Probe configuration

Audit query construction and extract a shared discovery-configuration builder
only for options needed by both real queries and discovery probes: workspace,
enabled settings sources, local-settings selection, plugins, resource policy,
and relevant tool/skill restrictions. Do not copy prompt data or credentials
into public catalogue records.

A zero-turn probe still spawns a CLI. Single-flight and bound it, close it on
all outcomes, and keep rejection handlers on every abort/close consumer.
Avoid probing on each projection. If SDK discovery cannot reproduce active
session configuration without a real turn, expose provisional/unavailable
inventory until init; do not claim default-probe rows are authoritative.

Explicit refresh must report partial reload failure. Current `allSettled`
reload calls cannot mean all resources refreshed when one failed. Refreshing
resources must not widen the execution policy or override user settings.

## Invocation and lifecycle

Use the selected descriptor's canonical SDK spelling, plus the unchanged
argument suffix, in the existing query prompt transport. Keep provider aliases
resolvable to the same identity. Do not expand Claude command files in the
backend; the CLI owns command semantics, hooks, plugins, and discovery order.

Qualify session-changing commands before enabling them. `/clear`, model
selection, and permission changes can have effects beyond a text reply. If the
bridge cannot track their resulting session/configuration state authoritatively,
mark the entry unavailable with an actionable reason. Never implement `/clear`
by deleting a rollout. For supported commands, capture any changed SDK session
identity/config and reconcile it before the next submission.

Commands that answer locally without tool/model streaming must still settle the
dispatch journal and produce a visible durable result. Compact outcomes should
use actual SDK events/results, including a successful no-op for insufficient
history; do not fabricate success from the command name.

## Legacy compatibility

Make `/plugins/commands` a compatibility view of the SDK-backed catalogue when
scope can be established. Preserve the legacy response shape for supported old
clients. If pre-session legacy discovery cannot share authority, label and
constrain it rather than combining it with executable session results. Delete
the old scanner only after call-site inventory and mixed-version tests prove it
is no longer needed. Keep unrelated plugin discovery intact.

## Tests

- SDK returns no commands: no hard-coded rows are added.
- `foo` appears in both supported commands and init skills: one `/foo`, no
  `/skill:foo`; plugin command and aliases preserve canonical spelling.
- Missing source metadata is unknown; stale init data does not resurrect a
  command removed by a replacement event.
- Closed/draining control falls back correctly; other errors remain errors;
  cached idle reads do not spawn a fresh process.
- Differently configured sessions do not share a probe answer incorrectly.
- Reload partially fails; old in-flight discovery cannot overwrite new state.
- Execute a selected skill, a supported local-result command, and compact;
  verify no duplicate turn and correct persisted outcome after restart.
- Run the inactive-environment inventory update and command-result scenario.

## Exit criteria

Every enabled Claude row is grounded in session-compatible SDK discovery and a
qualified execution behavior. Dynamic command replacements survive turn end.
No synthesized Pi-style skill names or guessed builtin provenance remain.
