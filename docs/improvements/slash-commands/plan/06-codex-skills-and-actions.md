# 06 — Bind Codex skills to structured app-server input

Status: proposed. Dependencies: 01–04. [Index](00-index.md).

## Owners

`bridges/codex-bridge/src/index.ts`, `app-server-runtime-sessions.ts`,
`app-server-runtime-prompt.ts`, `engine/types.ts`, `engine/app-server-engine.ts`,
`app-server/event-reducer.ts`, and the existing prompt/input builders. Read the
committed generated `UserInput`, `SkillMetadata`, `SkillScope`, and
`SkillsListParams` as the wire authority; do not edit generated files by hand.

## Dedicated inventory

1. Add a typed engine skill-list operation backed directly by `skills/list`.
   Supply the effective cwd and `forceReload` on supported explicit refresh.
2. Stop extracting executable skills from `getRuntimeHealth`. Diagnostics
   deliberately discard private paths and also query MCP/hooks/account state,
   none of which is necessary to open the command picker.
3. Preserve canonical name, trusted absolute path, enabled state, plugin ID,
   and scope in a bounded bridge-private registry. Map `repo` to project origin;
   do not test it against the nonexistent scope `project`.
4. Expose opaque IDs, safe descriptions, provenance, and availability publicly.
   Disabled skills must not be executable. Handle per-cwd discovery errors as
   partial/unavailable inventory instead of silently claiming completeness.
5. Define duplicate-name resolution from the actual skill identity/path and
   provider precedence. The renderer must not choose a path. If the provider
   cannot disambiguate two names safely, require an explicit qualified choice
   or mark ambiguity unavailable rather than taking the last array entry.

## Input serialization

Extend `EngineUserInput` with a skill variant and make `toAppServerInput`
exhaustive. The current default branch assumes every non-text item is an image;
adding a union member without changing that branch would misroute it.

Build a turn containing:

- The canonical skill marker and user arguments in a text item, with the pinned
  protocol's required `text_elements` field supplied by serialization.
- A `{ type: "skill", name, path }` item from the private binding.
- Supported image/other inputs retained from the normal prompt path.

Keep the user's original command visible in the transcript while persisting
the resolved command identity for retries. Do not expose the skill path as a
browser-controlled attachment or read its entire contents into a projection.
Validate that the ID belongs to this environment/session and that the path is
still an enabled entry in the authoritative skill inventory.

Recommended UX: a skill is discoverable from `/`, but selection inserts `$name`
and retains the descriptor ID. Compatibility `/skill:name` aliases may map to
the same explicit binding; they must never be passed through as unhandled
slash text. Direct `$name` typing remains provider-native text unless a unique
qualified skill resolution is available under the shared contract.

## Lifecycle and invalidation

Convert `skills/changed` from an ignored notification into an invalidation
signal. Do constant-time state marking in the stdout pipeline and refresh
off-loop. Coalesce notifications; do not launch a scan per event.

Skill discovery must work without reattaching every idle thread. Bind entries
to the runtime generation and cwd. On generation death, withdraw stale private
bindings and rebuild when needed; never trust persisted paths as authorization.
Selected removed/disabled skills fail before turn start and preserve the draft.

## Built-ins and actions

Classify bridge `/help` and `/models` as bridge/Orkestrator behavior, not a
complete Codex CLI builtin list. Help should describe the same qualified
catalogue the picker uses, including skills and their invocation spelling.
Bound help output and distinguish unavailable entries.

Retain `/steer` through the existing runtime action and expected-turn semantics.
Expose `/compact` only through the implemented compact action/capability after
qualification. The existence of generated RPC types alone is not sufficient
to enable goals, settings, review, or session-reset commands. In particular,
old comments about absent goal RPCs must not replace a current engine-support
check; the plan does not enable goals.

## Tests and acceptance

- A selected skill produces exactly one text item and the expected skill item;
  serialization includes `text_elements: []` and preserves image inputs.
- Disabled, removed, wrong-session, stale-generation, and forged-ID submissions
  fail without `turn/start`. No client can supply its own skill path.
- `repo` scope and plugin ownership survive normalization; public snapshots
  and diagnostics still omit private paths.
- Skill changes while the tab is inactive appear on return; burst invalidation
  stays bounded and does not block JSONL reads.
- Lost acknowledgement/restart reconciles the original request once, using
  existing journal behavior; no automatic retry of ambiguous `turn/start`.
- Cold discovery does not start model turns or keep idle sessions attached.
- Help/menu execution identities agree, and commands completing locally remain
  visible through authoritative transcript rehydration.
