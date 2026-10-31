# Bridge instructions

These rules apply to every bridge under `bridges/` and to the backend code that
calls them (`apps/backend/src/core/http-bridge-provider*.ts`,
`bridge-session-close.ts`, the activity sweep). The root
[`AGENTS.md`](../AGENTS.md) still applies; each bridge directory adds its own
`AGENTS.md` for engine-specific rules.

## Session surface routes

- Never poll a tab-facing route from a background reconciler. `/session/:id` and
  `/session/:id/status` are liveness touches — the codex bridge refreshes
  `lastAccessed` (which is what `detachableThreads` reads) and the claude bridge
  additionally hydrates the transcript. The backend's activity sweep runs every
  two seconds for every persisted session, so polling those would put idle
  detaching and transcript eviction permanently out of reach. Both bridges
  expose `GET /session/:id/activity` for exactly this: no touch, no hydration,
  no re-attach. Anything else the backend wants to poll needs the same
  treatment.
- The activity answer may carry an opaque `contentRevision` (Claude and Codex
  do). It must move whenever what a session view shows changes without an
  activity change (transcript rows, background-task snapshots, async
  questions), stay equal otherwise, and stay O(1) and no-touch. Never let
  computing it fail the read: omit the field instead. The backend announces a
  change on an idle session from it, and only a session that reports one may
  back off on the client.
- `GET /event/subscribe?observe=1` is the backend observer's stream: frames
  carry only the event type, the cursor `id:` and `{"sessionId"}`, the
  `connected` frame confirms `"observe": true`, and the subscriber must not
  keep the replay ring alive. It is a wakeup hint, never a source of activity,
  and like `/activity` it must not touch, hydrate or re-attach anything.
- `/session/:id/activity` answers an unknown session **in band** as
  `{"activity":"missing"}` and never 404s. The backend reads a 404 there as "this
  bridge predates the route" and fails the environment; if 404 also meant "session
  gone" it would delete a live session mapping against an older bridge. For the
  same reason the claude bridge answers a failed existence probe `idle`, never
  `missing` — an error is not evidence of deletion.
- `GET /session/:id/dispatch?requestId=` answers `dispatched` **only** on an
  explicit positive from that bridge's own dispatch journal. It answers `lost`
  **only** where the prompt route would refuse the id with 410
  `dispatch-outcome-lost`: a record an earlier process left without an outcome
  (Claude's `restoredDispatchedRequestIds`, the ACP, Cursor and Pi journals'
  `ambiguous`), never a local reply, and never over a `dispatched`. No record
  in a journal that is not complete (below), a record that may still run (the
  codex journal's `prepared`), an unreadable journal and a missing route are
  all `unknown`. The backend confirms a parked
  dispatch on `dispatched` and retires it on `lost` (cleared, never recorded as
  run, the draft's id released); `unknown` leaves it parked. Neither `lost` nor
  `unknown` means "never sent": reporting a lost record that way would have it
  run the same turn twice. `absent` does, and is an assertion too: answer it
  only while the session's journal is complete — created by this bridge, every
  claim written to disk before its handover, loaded cleanly, nothing evicted,
  trimmed or skipped since — and the id has no record of any state. The
  backend then re-sends a recovered request under the same id (0223), so a
  wrong `absent` runs a turn twice: when unsure, answer `unknown`. An adopted
  or resumed session is never complete. Like `/activity`, it must never touch
  liveness, hydrate or re-attach. A bridge that reports restart interruptions
  (Claude, Codex) adds `pending: true` beside `dispatched` while that request's turn is
  still in flight and `pending: false` once it finished; the backend lets a
  restart notice naming another request stand aside only for a `pending`
  request, so never report a finished request as pending.
- Prompt dispatch and `POST /session/:id/attach` share the same client timeout,
  because they do the same work. A bridge with no attached agent process pays a
  full spawn plus `initialize` plus `session/load` on whichever request arrives
  first; budgeting the prompt at the 30s default aborted cold dispatches
  mid-flight and reported them to the user as unresolvable. Attach exists to
  move that cost *outside* the at-most-once window, where a failure is
  unambiguous — nothing journaled, no prompt written. It must never dispatch a
  turn, and callers must treat it as best-effort: the prompt request performs
  the same work and is the one that answers authoritatively.
- A parked dispatch blocks its whole session, not just the prompt that created
  it: storage refuses every other request id until it is settled. Surface both
  ways out — retry under the same idempotency key, or discard — rather than the
  storage-level refusal, which names an invariant the user cannot act on.

## Transcript rows

Every bridge writes one transcript row per model response (one step of the
agent loop), never one per turn; each bridge's `AGENTS.md` names its boundary.
A turn kept alive by background work runs for hours, and a multi-megabyte row
fits no transcript window: readers get only a trimmed copy and lose its start
once newer rows push it out of the live tail.

- **Late updates find their row.** A tool result, subagent report, command
  change or settle lands on the row holding the call, however many responses
  ago that was, never on the newest row and never as a duplicate card. A
  subagent's output is bounded per call on that row.
- **Changed rows outside the window still reach readers.** Readers re-read only
  the live tail, so note a row in a `RecentlyRevisedRows`
  (`@orkestrator/protocol/node/revised-rows`) whenever it changes after a newer
  row exists, and pass its ids as `revisedMessageIds` in the
  `BridgeTranscriptSource`. The v2 summary then carries the changed rows that
  fall before the window as `revisedMessages`, and readers replace their
  copies. Note where the row changes, in the same step that moves the
  transcript revision, never from a deferred publish: a read between the two
  caches a token that would then never move. Do not note the newest row — it
  is always in the window, and noting it turns every streamed write into
  `revisedMessages` once it ages out. Clear the list when the history is
  replaced. Pass `revisedRowsOverflowVersion` with the notes: count/byte
  omissions produce `historyReconciliationToken`, whose change invalidates
  retained history so it can be re-paged. Tokens stay stable during unrelated
  live deltas; bounded notes must never silently certify stale held rows.
- **Pages never cut a row.** A page sends a row larger than its target whole,
  up to `BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES`, because the next cursor starts
  before that row, never inside it.

## Tab close and conversation retention

Closing a tab retains the conversation on every platform. Every managed bridge
(Claude, Codex, Cursor, Grok/ACP, Pi) serves `POST /session/:id/close`; backend
tab teardown and `HttpBridgeProvider.closeSession` both go through
`closeBridgeSessionRetaining` (`apps/backend/src/core/bridge-session-close.ts`).
When touching any of them:

- **Close is non-destructive.** It stops owned work, denies parked approvals,
  questions and plan approvals, settles dispatch claims, and releases the
  bridge's live mapping. It never deletes vendor history: no Claude SDK
  `deleteSession`, no Codex `thread/delete`, no OpenCode
  `client.session.delete`.
- **Only a 2xx that affirms `closed: true` is a confirmed close.** 200
  `{ closed: true, retained: true }` or `{ closed: true, missing: true }`.
  Anything else, including an empty or malformed 2xx, is not a close.
- **An unknown session is answered in band, never 404.** 200
  `{ closed: true, missing: true }`. A 404/405 from the close route means the
  bridge predates it; it is never evidence that the session is gone.
- **503 `{ closed: false, pending: true, error }` keeps everything.** The
  bridge keeps the session registered (and refuses new work on it); the
  backend keeps its durable teardown intent and the tab mapping, and the
  periodic reconcile sweep retries. Errors are fixed, content-free strings.
- **A close never falls back to DELETE.** On 404/405 the teardown stays pending
  with a `bridge-upgrade-required` failure the renderer shows as a restart
  notice, on every platform. Claude's DELETE deletes the rollout.
- **The last owner closes.** Two tabs can map to one provider session. Backend
  teardown is serialized per (environment, agent, provider session) and only
  the tab that finds no other mapping performs the provider close. A resume
  that replaces a tab's session closes the replaced one under the same lock
  and rules (`provider-session-ownership.ts`): never while another tab maps it
  or a Multi Review owns it. That close is journaled as a teardown intent
  under a reserved `resume-replaced:` key, so the reconcile sweep retries one
  that stayed pending.

## Interaction deadlines and pauses

Every parked question, approval and elicitation runs on an
`InteractionDeadline` (`packages/protocol/src/agent-interaction-deadline.ts`),
never a bare `setTimeout`. When touching one:

- **A pause only moves the deadline.** `POST /session/:id/{family}/:requestId/hold`
  with `{ held }` re-arms it at the hold ceiling (or the provider's own sooner
  limit) and a resume restarts a fresh window. Expiry still declines, denies
  or cancels; a hold never answers anything.
- **Always publish a deadline and the `hold` beside it.** A paused request
  carries its ceiling as `expiresAt`; older backends drop a request without
  one. Pass any limit the provider enforces itself (`providerLimitAt`) so the
  card says when the pause still ends.
- **Answer a missing request in band.** 409 `stale` for a request that is no
  longer pending, 422 `unavailable` when there is no room to extend. The
  backend only calls the route for a request whose published `hold` says it
  can, so it never probes an older bridge; it reads a 404 there as stale.
- **Never persist a deadline.** It holds a live timer; parked requests do not
  survive a bridge restart, and neither does their pause.

## Permission rule eligibility

Orkestrator's own "always allow" rules
([`permission-rules.md`](../docs/architecture/permission-rules.md)) are applied
by the backend, which answers a matching approval with the bridge's ordinary
allow-once. A bridge's only part is the `ruleEligible` marker on an approval:

- **Mark only exact detail.** Set `ruleEligible: true` only when the command
  string, every path, the host or the MCP server and tool are exactly what will
  run: never on a truncated value, a lossy argv join, a relative path the
  backend cannot place, input to a running terminal, or a request that also
  widens a sandbox (a write root). Without the marker the backend asks.
- **Never answer for a rule.** A bridge never applies or stores a rule, and a
  provider suggestion it forwards (`proposedCommandPrefix`) is a hint for the
  card only, never sent back to the provider.

## Native slash commands

The contract is [`docs/architecture/native-agent-commands.md`](../docs/architecture/native-agent-commands.md).
When touching command discovery or dispatch:

- **Never seed or guess rows.** A catalogue lists only what the provider
  reported and what its executor can run. A successful empty list stays
  empty; a failed read is `stale` or `unavailable`, never `ready: []`.
- **A selected command never becomes a prompt.** Removed, changed, forged or
  unverifiable selections are refused before journaling (bridges answer 422
  `command-unavailable`). Retries and queued items carry the resolved intent.
- **Private bindings stay private.** Skill paths, template bodies and
  provider command defaults never appear in a public descriptor.
- **Catalogue reads are metadata.** They must not touch `lastAccessed`,
  hydrate a transcript or re-attach an idle session; push freshness rides on
  `commandRevision` in the snapshot the backend already reads.

## Packaging

Every bridge that builds has to be listed in the root `package.json`'s
`build.extraResources`. `getBridgePath` falls back to `resourceRoot/<name>`
outside development and fails only at the moment a user selects it, while
containers carry on working from `/opt/<name>`.
`tests/unit/bridge-packaging.test.ts` enumerates them so the next one cannot be
forgotten.

The standalone npm package (`packages/cli`) carries them too, listed in
`packages/cli/scripts/bridges.ts`: bundled complete, or — for a bridge whose SDK
cannot be inlined — as its own bundle plus a pinned runtime that the backend
installs on first start (`apps/backend/src/core/bridge-runtime-install.ts`).
Anything that starts a bridge resolves it through `prepareBridgePath`, not
`getBridgePath`, so that install happens. `packages/cli/tests/cli.test.ts`
enumerates `bridges/` against that list.
