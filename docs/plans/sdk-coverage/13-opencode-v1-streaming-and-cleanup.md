# 13 — OpenCode on v1: streaming and cleanup

**Status:** 🟨 In progress · implementation complete, awaiting merge and browser QA · Depends on: 03

## Goal

Stay on the v1 session protocol (v2 is not stable enough yet), but stop
polling for things the v1 SSE stream already tells us, type the prompt
payload, and delete the renderer paths that no longer run. Everything here
is backend; the renderer only loses dead code. The migration to v2 remains
tracked in `docs/todo/opencode-v2.md` and is not part of this plan.

## Normalized model

None new. The existing projection fields (status, todos, diff, notices,
transcript) are filled from events instead of polls. Events remain hints:
every path keeps its snapshot read as the authority, per the invariants.

## Tasks

### SSE adoption (`apps/backend/src/core/opencode-provider.ts`)

- [ ] `session.status` and `session.idle` → activity transitions, with the
  existing `session.status` poll (`opencode-session-lifecycle.ts:71`)
  demoted to a reconciliation sweep at a longer interval.
- [ ] `message.updated` and `message.part.updated` → incremental transcript
  merge using the existing `mergeOpenCodeMessageInfo`/
  `buildOpenCodeMessageFromPart` helpers (`opencode-messages.ts:242,715`,
  currently unfed), with a full `session.messages` refetch only on a
  revision gap. `message.part.delta` → streaming text on the open part.
- [ ] `todo.updated` and `session.diff` → runtime summary and diff state
  without the health-snapshot refetch.
- [ ] `session.error` → `error` notice; `session.compacted` → `compaction`
  part (plan 03); `session.deleted` → mark the session missing.
- [ ] `mcp.tools.changed` → refresh the MCP list (plan 07);
  `permission.replied` → resolve the interaction (plan 04).
- [ ] `server.connected`, `server.instance.disposed`, `global.disposed` →
  reconnect and full reconcile, replacing the stream-error-only path at
  `opencode-provider.ts:462-478`.

### Typing and correctness

- [ ] Type the prompt payload: `parts` is `any[]` in
  `apps/web/src/lib/opencode-prompts.ts:186` and cast `as never` at
  `opencode-provider.ts:732`. Build it as the SDK's `Part` input union in
  the backend; the renderer sends attachments, not parts.
- [ ] `session.update` for titles (plan 09) and, if the v1 surface exposes
  the session permission ruleset, for plan 12. Record the finding either way.
- [ ] Use `client.global.health` instead of the raw `fetch('/global/health')`
  at `opencode-sessions.ts:67`.

### Dead code removal (renderer)

- [ ] Delete `openCodeStore.pendingPermissions`/`addPendingPermission`/
  `getPendingPermissionsForSession`, `replyToPermission`, and
  `subscribeToEvents` in `apps/web/src/lib/opencode-interactions.ts` (no
  production caller). Delete `OpenCodeQuestionCard` and its index export;
  the neutral `NativeAgentQuestionCard` is the live path. Move any
  behaviour worth keeping (multi-select exclusivity, draft persistence) into
  the neutral card if it is missing there.
- [ ] Update `AGENTS.md`'s OpenCode component table and SSE list to match
  what runs.

### Verification

- [ ] Backend tests with a fake OpenCode SSE stream: each adopted event
  updates the projection; a dropped event is recovered by the reconciliation
  sweep.
- [ ] Browser, inactive path: start a turn, switch environment, let it
  finish, return, reload; status and transcript are correct from the
  snapshot. Measure poll count before and after and record it in the PR.

## Out of scope

Any `client.v2.*` call. `session.next.*` events. Steering and `switchAgent`/
`switchModel`.

## Implementation notes

- The installed v1 session model exposes `Session.permission` as a
  `PermissionRuleset`. The SSE adapter retains that bounded provider value at
  the adapter boundary; plan 12 owns translating it into the normalized
  execution policy.
- A warm projection previously issued one `session.status` and one
  `session.messages` request per projection refresh. The fake-stream regression
  test records zero of each after the authoritative baseline; status is
  reconciled every 30 seconds and both are refetched after a stream gap.
- The inactive/reload guarantee is covered at the provider boundary by keeping
  the stream independent of renderer state and by the reconnect-gap regression
  test. Interactive browser QA remains required before merge.
