# 09 — Define and implement consistent conversation retention on close

Status: Implemented (2026-09-26); product decision awaiting maintainer confirmation; live retention verified for Claude and Codex only. Not merged. See [step 11 evidence](11-conformance-verification-and-release-handoff.md#evidence-record-2026-09-26).  
Depends on: [04](04-durable-session-lifecycle-acknowledgements.md),
[05](05-cursor-permanent-close-and-late-work-ownership.md).  
Finding: INC-08.

## Outcome and decision boundary

The user should know whether closing a tab retains a resumable conversation.
Provider-specific HTTP DELETE behavior must not make that decision implicitly.

Recommended target: **ordinary tab close releases runtime resources and retains
conversation history**. Permanent conversation deletion remains an explicit,
separately named operation only where supported and authorized. In particular,
Codex `thread/delete` remains prohibited by AGENTS.md; this plan does not add it.

The recommended default was adopted on 2026-09-26 (see the decision record
below); the caller inventory and implementation evidence are in the
[implementation record](#implementation-record-2026-09-26) at the end of this step.

| Decision record | Value |
| --- | --- |
| Ordinary close retention | **Preserve history on every platform.** Tab close releases runtime resources and ownership only |
| Existing explicit delete controls | None in the UI. Claude's `DELETE /session/:id` (SDK `deleteSession`) is kept for explicit callers but nothing in the backend or renderer calls it any more; the renderer's `deleteSession` client helpers are unused exports |
| Automated workflow cleanup retention | Preserve. Multi Review close and orphan/startup cleanup use the same non-destructive close; no documented policy requires deleting reviewer or fix conversations |
| Unsupported/older bridge behavior | Fail visibly and keep the durable intent; legacy DELETE fallback only where proven non-destructive (never Claude) |
| Maintainer decision/reference | 2026-09-26 — adopted recommended default per maintainer instruction to implement the full plan; confirm at review |

If the chosen policy instead preserves provider-specific destructive close,
use the alternative path at the end of this step. Do not implement both policies
through an unexplained global flag.

## Owners and current paths

- [Backend tab teardown](../../../../apps/backend/src/core/commands-registry-teardown.ts)
  sends DELETE directly and persists teardown intents.
- [Provider contract](../../../../apps/backend/src/core/agent-provider-contract.ts)
  exposes `closeSession`; [HTTP provider](../../../../apps/backend/src/core/http-bridge-provider.ts)
  implements it with DELETE.
- [OpenCode provider](../../../../apps/backend/src/core/opencode-provider.ts)
  currently implements close using `client.session.delete`.
- [Multi-review cleanup](../../../../apps/backend/src/core/multi-review-service.ts)
  also calls `provider.closeSession`; it is a separate caller to classify.
- [Shared teardown inputs](../../../../packages/protocol/src/tab-teardown.ts).
- [Claude session routes](../../../../bridges/claude-bridge/src/routes/session.ts)
  and [durable deletion](../../../../bridges/claude-bridge/src/services/session-manager-persistence.ts).
- [Codex runtime release](../../../../bridges/codex-bridge/src/app-server-runtime-sessions.ts).
- [Cursor routes](../../../../bridges/cursor-bridge/src/http.ts),
  [Pi routes](../../../../bridges/pi-bridge/src/http.ts), and
  [Grok ACP routes](../../../../bridges/acp-bridge/src/acp-http.ts).
- [Living architecture](../../../architecture/agent-engines.md).

## A. Inventory the complete lifecycle surface

- [x] Find every `closeSession`, session DELETE, `teardown_tab`, orphan cleanup,
  workflow cleanup, explicit history deletion, and environment-removal caller.
  Record which action the user or workflow actually requested.
- [x] Separate logical tab identity, bridge session identity, vendor conversation
  identity, and transcript cache. Specify which survives each action.
- [x] Check multiple tabs referencing the same vendor conversation. Closing one
  tab must not stop/delete a conversation still owned by another tab.
- [x] Inspect Grok's actual release behavior and pinned OpenCode lifecycle APIs.
  Do not infer non-destructive close support from a method name. Use current
  documentation and the pinned SDK source when vendor semantics are needed.
- [x] Verify native and tmux resume listings after close. Their implementation
  can remain different, but user-facing retention must be accurately described.
- [x] Inventory automatic workflow sessions separately. Preserving history may
  increase retained provider data; document any existing cleanup/retention policy
  without silently deleting historical conversations as part of this change.

## B. Specify a non-destructive close contract

For the recommended retention policy, define the following lifecycle distinction
in backend/provider terms before changing routes:

| Operation | Execution | Active mapping/resources | Vendor history |
| --- | --- | --- | --- |
| Visibility unmount | Continues | Retained | Retained |
| Idle detach | Already idle | Release expensive handle; retain recovery identity | Retained |
| Close tab/session ownership | Stop owned work, settle approvals | Retire this tab's ownership durably | Retained |
| Explicit delete history | Provider-specific, deliberate destructive action | Reconcile every relevant owner first | Deleted only where supported |

- [x] Make `closeSession` mean the non-destructive row, or add a clearly named
  operation and migrate all relevant callers. Do not leave one path using the
  new meaning while direct teardown still uses destructive DELETE.
- [x] Define affirmative close capability/version evidence for managed bridges.
  Missing capability is unknown/unsupported, not permission to guess. Reuse an
  existing negotiation surface if suitable; otherwise document the additive
  contract in the shared protocol and test it.
- [x] Prefer an explicit route such as `POST /session/:id/close` where existing
  DELETE means permanent deletion. This route name is proposed, not present
  behavior. Leave the old destructive operation unambiguous for explicit callers.
- [x] Return success only after runtime ownership is safely closed and required
  metadata is published. Reuse step 05's late-work and failure semantics.
- [x] Define unknown-session close as idempotent only after route support is
  established. A bare 404 from an older bridge is not evidence that the session
  is gone. Never fall back from an unsupported close route to destructive DELETE.
- [x] Keep the existing backend teardown intent until the close is confirmed.
  Version any new intent semantics so an old pending DELETE intent is not silently
  replayed as an unintended destructive action after upgrade.

## C. Implement each provider at its actual boundary

| Provider | Planned adapter work for preserve-on-close |
| --- | --- |
| Claude | Add release/close path that stops query controls, denies pending interactions, settles dispatch claims, retires bridge ownership/preferences as appropriate, and does not call SDK `deleteSession` |
| Codex | Reuse reference-counted release/unsubscribe; retain last-tab stop behavior and approval rules; never introduce `thread/delete` |
| Cursor | Reuse step 05 permanent bridge close; keep SDK conversation store intact |
| Pi | Reuse permanent bridge close and preserve the Pi JSONL conversation; verify cancellation and publication semantics |
| Grok | Verify ACP release/detach and vendor history retention; implement only supported operations and expose limitations honestly |
| OpenCode | Stop the owned turn and release backend subscriptions/registration without `client.session.delete`; keep provider history and necessary resume metadata |

- [x] For OpenCode, distinguish shared server/session ownership from one tab's
  registration. End only the closing owner's work/subscription. Restore temporary
  review permissions and workflow ownership through the established service path.
- [x] For Claude, keep resumable SDK identity discoverable without resurrecting
  the closed logical tab during session-catalog reconciliation. A vendor history
  entry is not an active-tab mapping.
- [x] Retire agent-mail/MCP tab credentials and pending UI projections after the
  ownership close, while retaining any vendor conversation metadata required for
  deliberate future resume. Never persist rotated bearer tokens.
- [x] Preserve uncertain execution as visible/incomplete if a provider cannot
  prove stop. Resource release and conversation retention are separate questions.
- [ ] Adapt multi-review cleanup only after its desired retention is recorded.
  Do not globally change all cleanup callers by renaming one method and assuming
  they share the tab-close product intent.

## D. UI, migration, and compatibility

- [x] Audit tab-close labels, context menus, history deletion controls, confirmation
  copy, resume dialogs, and errors. Ordinary close should not imply permanent
  deletion under the recommended policy.
- [x] Do not add a new destructive deletion button as incidental scope. Existing
  explicit deletion controls must use the deliberate delete operation; a larger
  history-management UI is a separate product task.
- [x] Keep older bridge/runtime behavior non-destructive. When close support is
  unavailable, report the limitation and leave recoverable ownership/intent;
  offer the existing bridge upgrade/restart path where appropriate.
- [x] Document that history already deleted by old behavior cannot be recovered
  by this migration. Do not manufacture empty replacement conversations and call
  that restoration.
- [x] Check downgrades: an older backend must not reinterpret a new intent as
  authorization to delete history. If safe downgrade is unavailable, state the
  minimum compatible version and refuse the incompatible operation explicitly.
- [x] Update the architecture guide and any operator text that equates close
  with deletion. Keep the original review as historical evidence.

## Regression and real-stack coverage

For each platform, test create → completed synthetic turn → close → list/resume.
Assert preserved provider identity/history where supported, absent active-tab
mapping, released resources, and no stray prompt. Test last-reference close
separately from closing one of two references.

Add cases for close while running, startup close, approval pending, failed close,
retry, unknown session, legacy bridge without the route, lost response after
successful close, and backend restart with a durable teardown intent. The
unsupported-route case must explicitly assert that no DELETE fallback occurs.

Use focused backend teardown/provider tests and bridge route tests before the
isolated browser cycle. Browser QA must cover close, navigate away, reload,
resume listing, deliberate resume, and any existing explicit deletion flow.
Use only seeded fixture conversations for destructive cases.

## Alternative if provider-specific destructive close is retained

If that is the recorded product choice, keep it explicit in a capability/retention
descriptor and make the UI communicate the consequence before the action. Test
that the backend-selected descriptor matches each provider operation, survives
reload, and cannot be guessed from provider labels in multiple UI components.
Still fix INC-02 independently, and still distinguish runtime close failure from
successful history deletion. Do not mark this finding resolved solely because
the discrepancy is mentioned in an internal Markdown file.

## Acceptance

- [ ] The product decision and affected caller inventory are recorded.
- [x] Shared teardown and provider cleanup no longer imply contradictory meanings.
- [x] Every provider follows the selected policy or exposes an actionable limitation.
- [x] Older route/capability behavior cannot trigger destructive fallback.
- [x] Close, idle detach, unmount, and explicit deletion remain distinct.
- [ ] Cross-provider tests and required isolated browser QA pass.
- [x] Codex `thread/delete` remains absent, and already-deleted history is not
  misrepresented as recoverable.

## Implementation record (2026-09-26)

### Close contract

Every managed bridge (Claude, Codex, Pi, Grok/ACP, and Cursor via the
coordinator's change) serves `POST /session/:id/close`:

| Answer | Meaning | Backend action |
| --- | --- | --- |
| 200 `{ closed: true, retained: true }` | Owned work stopped, parked approvals denied, dispatch claims settled, runtime and mapping released, removal published | Retire the tab mapping, clear the intent |
| 200 `{ closed: true, missing: true }` | No live mapping for that id (already closed, lost response, never existed) | Same as above |
| 503 `{ closed: false, pending: true, error }` | Stop or cleanup not proven; the bridge keeps the session registered | Keep intent and mapping; retry on reconcile |
| 404 / 405 | Bridge predates the route | Claude: refuse with an actionable `bridge-upgrade-required` error (shown as a restart toast), keep intent. Others: legacy DELETE (below) |
| Any other 2xx (empty, malformed, oversized, `closed` not exactly `true`) | Not a confirmation | Keep intent and mapping (treated as pending) |

Errors are fixed, content-free strings. No close path calls Claude SDK
`deleteSession`, Codex `thread/delete`, or OpenCode `DELETE /session/:id`.

### Caller inventory

| Caller | Action actually intended | Behavior now |
| --- | --- | --- |
| `teardown_tab` (renderer tab close via `teardownTab`) for `*-native` kinds | Close one tab's ownership | Bridges: `POST /close`; OpenCode: `OpenCodeProvider.closeSession` through the native agent service (`closeProviderSessionIfRunning`, never starts a bridge); mapping retired on confirmation; history retained |
| `reconcile_tab_teardowns` (startup and the coalesced 60 s sweep, per-intent backoff 30 s doubling to 15 min) | Finish a user's earlier tab close | Same close; pre-upgrade intents are replayed with close, never DELETE |
| `reconcile_orphaned_tab_resources` (startup agent pane gone, or unreferenced interactive mapping after 1 h grace) | Release ownership nobody holds | Goes through `teardown_tab`, so the same non-destructive close |
| `teardown_tab` for `terminal` / `claude-tmux` | Stop a terminal process / tmux Claude CLI | Unchanged; neither deletes a vendor conversation (tmux Claude keeps its own JSONL) |
| `MultiReviewService.close` (parent tab close of a finished workflow) | Remove the workflow record and its tabs; stop its sessions | `provider.closeSession` is now the non-destructive close, so reviewer/fix conversations are retained (decision: preserve-on-close) |
| `HttpBridgeProvider.closeSession` | Provider-neutral close | `POST /close`, legacy DELETE only per the fallback table |
| `OpenCodeProvider.closeSession` | Provider-neutral close | Abort (settles workflow ownership; 404 = already gone), restore review permissions, reject pending permissions/questions of that session, forget registration; previously `client.session.delete` |
| `close_project_coordinator_conversation` / `remove_project` | Stop a coordinator runtime | Unchanged: stops the coordinator bridge process and invalidates the mapping; never called DELETE |
| `delete_environment` | Explicit environment removal | Unchanged: stops processes, removes mappings, worktree/container. It never called a provider DELETE; history inside a removed container goes with the container |
| `NativeAgentService` ensure/reconcile invalidation on authoritative `missing` | Drop a mapping whose provider session is gone | Unchanged (mapping only) |
| Renderer `deleteSession` helpers in `claude-client.ts`, `codex-client.ts`, `opencode-interactions.ts` | None — no caller | Unchanged, unused |

### Identities after each action

| Identity | Unmount | Idle detach | Tab close | Explicit delete (Claude DELETE only) |
| --- | --- | --- | --- | --- |
| Logical tab (`env-<id>:<tab>`) + backend mapping | Kept | Kept | Retired | Retired by its caller |
| Bridge session id / registry entry | Kept | Kept (handle released) | Removed from the live registry and state file | Removed |
| Vendor conversation (rollout, thread, JSONL, ACP session, OpenCode session) | Kept | Kept | **Kept** and listed for resume | Deleted |
| Bridge transcript cache | Kept | May be evicted | Dropped (reconstructible from the vendor) | Dropped |

Claude's bridge re-adopts a closed rollout as an idle session when
`/session/list` reconciles the SDK listing. That is history discovery, not a
resurrected tab: the backend mapping is gone, so nothing polls or reopens it
until the user deliberately resumes.

### Provider implementation and vendor evidence

| Provider | Close implementation | Evidence verified |
| --- | --- | --- |
| Claude | New `closeSessionRetainingHistory`: synchronous claim (`deleting`), abort, deny questions/plan approvals, close every owned query control (`Query.close()` ends the CLI) and wait for a racing dispatch claim, all within a 10 s budget; any `close()` failure/timeout or unsettled claim answers 503 with the session still registered and fenced (a retry re-runs the close). Then drop the registry entry. Keeps rollout and preferences (dispatch/steer journal, client alias) | Pinned SDK 0.3.280 `sdk.d.ts`: `deleteSession` "removes `{sessionId}.jsonl`" — so DELETE is destructive and is not used |
| Codex | New `closeSessionRetaining` (one attempt per session): admission fence first (prompt/steer/compact/review answer 409 `Session is closing` until confirmed, including while pending); last reference only, wait for an in-flight `turn/start`, interrupt through the escalating `abort` path and confirm the turn is terminal within a bounded budget (else 503, session kept); then a strict release: tombstone written before the registry drop, a failed write answers 503 with session, record and subscription intact; then unsubscribe and deny approvals | Bridge never sends `thread/delete`/`thread/archive` (grep + history) |
| Pi | New `closeSessionRetaining`: DELETE's release path plus: failed/timed-out cancel or release → 503 with the session kept; removal published with `persistBarrier`, re-inserted on write failure | Nothing in the bridge unlinks the JSONL session file; conversation reopens via `/session/list` + resume |
| Grok (ACP) | New `closeSessionRetaining` (one operation per session id; DELETE joins it): fence admission (409 `Session is closing`), deny permissions, questions and plan approvals with their cancel outcome, `session/cancel` a running turn and wait (2 s) for the prompt to answer, await a racing attach (5 s) and terminate its late child, 503 unless every child exited, write state without the session, and only then drop the registry entry. The session stays registered for the whole close, so a retry never gets an early `missing` | No ACP delete method exists in the bridge; Grok's store is only read; `session/list` + `session/load` reopen it (test) |
| Cursor | Coordinator's change on `bridges/cursor-bridge` (step 05 permanent close) | SDK conversation store is not deleted (step 05) |
| OpenCode | Teardown and `closeSession` are one path (`opencode-session-close.ts`): abort through the workflow-result broker (settles workflow-turn ownership; 404 = already gone), restore reviewer permissions, list pending permissions/questions and reject those of this session (read or reject failure fails the close; 404 on a reject is fine), forget the registration | Context7 (`/anomalyco/opencode` server docs): `DELETE /session/:id` "Delete a session and all its data"; `abort` "Abort a running session" with no statement about pending permissions/questions. Pinned SDK 1.18.32 types: abort returns boolean. Because withdrawal is not promised, close rejects them explicitly (fail closed) |

Grok limitation: close stops work by terminating the CLI child after
`session/cancel` and a bounded (2 s) wait for the cancelled prompt to answer; ACP offers no separate "release" call, and the
bridge-local journal, structured results and usage for that session are
dropped (the vendor transcript is what a resume rebuilds from).

### Legacy fallback table

| Platform | Legacy DELETE fallback on 404/405 | Evidence |
| --- | --- | --- |
| Claude | **Never** — teardown stays pending with "restart the environment" | DELETE calls SDK `deleteSession` |
| Codex | Allowed | d58a1371 and SDK-era DELETE: abort + drop memory; a43f9e25 onwards: unsubscribe |
| Pi | Allowed | `handleDelete` keeps the JSONL since 04a64ddc |
| Grok | Allowed | ACP DELETE since 53d4b3f6 kills the child and rewrites bridge state only |
| Cursor | Allowed | SDK bridge (671ad10a+) keeps the SDK store; earlier ACP path as Grok |

Encoded as `LEGACY_DELETE_RETAINS_HISTORY` in
`apps/backend/src/core/bridge-session-close.ts`, used by both tab teardown and
`HttpBridgeProvider.closeSession`.

### Shared ownership

Two logical tabs can map to one provider session (both resumed the same
OpenCode session, or the same bridge session was adopted twice). Teardown
checks the environment's other mappings: if another tab still maps the
provider session, only this tab's mapping is retired — no provider request and
no in-memory release. The last tab performs the real close. Teardowns are
serialized per (environment, agent, provider session) and re-read the tab's
mapping under that lock, so two tabs closed concurrently (or a user close racing
the reconcile sweep at concurrency 4) cannot both skip the provider close. Within Codex, two
bridge sessions on one thread were already reference-counted: only the last
reference interrupts and unsubscribes.

### Intents, migration and downgrade (section D)

- New native intents store `sessionId` as `retain-history-close:<id>`
  (`fenceRetainingCloseSessionId` in `packages/protocol/src/tab-teardown.ts`).
  Every backend that has teardown intents (since 02c3136d) refuses an intent
  whose `sessionId` differs from the tab's mapping, and with no mapping clears
  it without a provider call. An older backend therefore never replays a new
  intent as DELETE; the pending intent also keeps its orphan reaper away from
  that tab.
- Pre-upgrade intents (bare id) are replayed by the new backend with the close
  route, never with the DELETE their writer would have sent.
- Downgrade limitation: an older backend and older bridges restore the old
  per-provider semantics for *new* closes (Claude DELETE deletes history). No
  compatibility gate can change code that is already released; the minimum
  version with retain-history close is the release that ships this change.
- History already deleted by old behavior (Claude or OpenCode tab closes before
  this change) cannot be recovered; nothing here manufactures replacement
  conversations.

### UI audit

Tab close items ("Close", "Close others", …), the unsaved-changes dialog (file
editor tabs only), and the Resume Session dialog ("Select a previous … session
to continue the conversation") do not imply permanent deletion. No copy was
changed and no destructive control was added. The one visible addition: a
teardown that fails with `bridge-upgrade-required` (an old Claude bridge) shows
one warning toast per environment ("Restart the environment to finish closing
this tab"; the conversation was kept and the close will be retried), with no
action button (`apps/web/src/lib/tab-teardown-notice.ts`).

### Tests

Backend `commands-registry-teardown.test.ts` (POST close for every bridge,
OpenCode through the provider and its failure/not-running retention, in-band
missing, Claude 404/405 with no DELETE and the `bridge-upgrade-required`
marker, Codex legacy fallback, pending close keeps intent, lost-response retry,
shared session, concurrent close of two tabs sharing a session, reconcile at
concurrency 4 closing each shared session once, per-intent retry backoff,
intent fence and pre-upgrade replay); `commands-state-sync.test.ts` (orphan
reaping, bridge unavailable, hanging request); `index.test.ts` (the 60 s
coalesced sweep). Provider tests: `http-bridge-provider-close.test.ts` (2xx
must affirm `closed: true`, legacy fallback, Cursor closed conversation still
listed via a stateful fake) and `opencode-provider-close.test.ts` (pending
permission/question rejection scoped to the session, fail-closed reads and
rejections, 404 as gone, workflow-turn settlement, session still listed). Web:
`paneLayoutStore.teardown-notice.test.ts`. Bridge route/service tests: Claude
`services/session-manager-close.test.ts` and `routes/session-close.test.ts`
(real app router, 503 on `Query.close()` failure/timeout/unsettled claim);
Codex `session-close-route.test.ts` and `session-close-route-app.test.ts` (real
app, tombstone failure → 503, admission fence, `dispatchInFlight` close); Pi
`session-close.test.ts`; ACP `acp-session-close.test.ts` (pending keeps the
session registered, attach race, persist failure, deny outcome of each
interaction kind, shared close op, admission refused, cancel acknowledged
before the child stops, the actually-closed session listed and resumed).

Real-stack QA: the coordinator ran live retention checks for Claude and Codex
(close a tab, then find and resume the conversation). The isolated browser
cycle was not run for Cursor, Grok, Pi or OpenCode close, nor for the
restart notice; those rely on the automated tests above.
