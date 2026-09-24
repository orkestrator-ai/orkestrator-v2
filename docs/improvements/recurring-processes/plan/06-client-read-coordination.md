# 06 — Coordinate client reads and document visibility

Status: In progress — coordinator and first migration (native session hook,
Files panel) landed with baseline foreground cadence and hidden-document pause;
quiet backoff (task 8), data-saving preference (task 9), step 09 consumers and
real-stack qualification remain. See [Completion notes](#completion-notes).
Dependencies: 01; relevant step 11 recovery contract before slower polling.
Finding: F05. Related proposal: client data-saving mode.

## Outcome

Equivalent mounted views share one refresh operation, hidden documents stop
optional presentation reads, and returning clients reconcile promptly. Backend
work and monitoring continue independently of every client subscription.

## Sources and proposed ownership

Introduce a focused module under `apps/web/src/lib/` following current transport
and store patterns. Integrate `resource-sync.ts`, `useNativeAgentSession.ts`,
`useFilesPanel.ts`, and later the step 09 consumers. Reuse existing connection
generation/reset signals, conditional tokens and projection caches.

Do not move prompt submission, approval resolution, workflow progression, or
durable queue draining into this coordinator. Its operations are read-only.

## Implementation tasks

1. Define read keys including connection identity/generation, resource kind,
   environment/session identity, options and requested view. Transcript windows
   with different limits/cursors cannot share responses unless a safe superset
   relation is explicit. Reset all pending/cache identities on server switch.
2. Represent subscriber demand: active/visible, requested freshness, explicit
   refresh, and whether the read is essential for interactive status. Aggregate
   demand for the same key without creating one timer per component. Keep a
   bounded map and evict entries after subscribers leave.
3. Join in-flight equivalent reads. Retain one dirty flag for an invalidation
   arriving after a read started. An explicit refresh must obtain a post-click
   observation; joining an older read alone does not satisfy it. Preserve the
   native hook's operation epoch/sequence fences when responses are applied.
4. Initially preserve foreground 500/1,500 ms native cadence and five-second
   file cadence. Change ownership/deduplication first so failures can be
   attributed. Keep progressive transcript/state/discovery reads separate and
   preserve unavailable/cached/current/empty distinctions.
5. Pause periodic presentation reads when the document is hidden or known
   disconnected. On visibility/focus/reconnect, coalesce signals and reconcile
   once. Browser online/offline state is a hint, not proof of backend readiness.
   Do not pause backend activity tracking or expire durable jobs with UI demand.
6. Bound resume work and prioritize session state/pending interactions before
   transcript history, file tree, metrics and auxiliary panels. Spread low-priority
   refreshes over a short bounded window to avoid every tab waking simultaneously.
   Maintain a documented maximum delay for visible critical reads.
7. Own errors and retries. Use capped jittered backoff for failed reads, reset
   after success/reconnect/explicit action where appropriate, and retain stale
   data with truthful freshness. Do not repeatedly retry permanent unsupported
   APIs; use capability fallback. Do not cache an auth failure as empty data.
8. After step 07 event coverage and step 11 recovery tests pass, trial quiet native
   backoff at 3/5/10/15 seconds. Running/blocked/recovering views keep their current
   latency budget until evidence supports a change. Record actual command and
   provider request counts per refresh before claiming savings.
9. If a data-saving preference is adopted, store it in the existing client-local
   preference layer. It changes this client's demand only. A second client with
   normal settings must retain its own freshness. Network hints may suggest a
   policy but must not silently change shared backend cadence.
10. Define disposal precisely. Subscriber unmount removes demand and invalidates
    callback application, but shared reads can continue for other subscribers.
    Cancel transport reads only where their abort does not stop backend work;
    late results must not rearm timers or overwrite newer identity state.

## Tests

Use a fake clock/document/transport and deferred read promises. Cover two
subscribers, option mismatches, delayed visibility change, rapid hide/show,
focus plus reconnect, invalidation during a read, explicit refresh during a read,
network failure, permanent unsupported API, server switch, target change,
unmount/remount and cleanup after cancellation. Assert request count, applied
revision and stale-state behavior.

Real browser coverage must include active tab in a hidden document, two windows
with different settings, environment switching during a turn, parked approvals,
completion while hidden, queued prompts, reload and missed final invalidation.
Keep old-backend coverage using conservative polling.

## Acceptance and rollback

Hidden optional views generate no scheduled read traffic; visible return obtains
authoritative state within its agreed latency. Equivalent subscribers join one
read, and no response crosses connection/session generations. Foreground behavior
matches baseline in the first migration. Roll back cadence/backoff separately
from coordinator ownership, avoiding simultaneous old and new timers.

## Completion notes

Recorded 2026-09-25 on branch `worktree-agent-a5ac9eb6e70b38e2b` (based on
`b9bd00fa`). Commits: `e43a0967` (coordinator), `4f636f0e` (native session and
Files panel migration), `df75da2a` and `92e1c1fa` (browser coverage),
`0d55ce20` (reconcile dedupe), plus this note.

### What landed

- `apps/web/src/lib/read-coordinator.ts`: `createReadCoordinator(options)` with
  injected clock/document/window/random, the renderer singleton
  `getReadCoordinator()`, `setReadCoordinatorConnection()`,
  `notifyReadCoordinatorReconnected()` and `resetReadCoordinatorForTests()`.
  Keys are `{ resource, target, options?, view? }` under a connection identity
  and generation. Tasks 1–3, 5–7 and 10 are implemented as specified:
  aggregated demand with one fixed-rate timer per key, bounded retention of
  subscriber-less entries (32), in-flight joining with one dirty flag, explicit
  refresh that always obtains a post-call read, hidden-document and
  transport-declared-disconnect pause, coalesced (50 ms) visibility / focus /
  pageshow / online / reconnect reconcile, critical first; standard spread
  100–600 ms, auxiliary 300–1,500 ms; documented maximum delay for a visible
  critical read `CRITICAL_READ_RESUME_MAX_DELAY_MS` = 50 ms plus event-loop
  latency. Failed reads use capped (30 s) jittered backoff that never polls
  faster than the key's healthy cadence, keep stale values with their original
  `observedAt`, never cache auth failures as empty data, and stop automatic
  reads of permanently unsupported APIs until reconnect/server switch/explicit
  refresh. A server switch aborts and fences in-flight results; eviction and key
  changes make late results inert, and they never rearm timers.
- Browser `offline` is deliberately **not** treated as disconnected: a desktop
  Local backend stays reachable without internet access. `online` only triggers
  a reconcile. `setDisconnected()` is the hook for a transport-declared
  disconnect; no transport calls it yet (step 10 owns reconnect lifecycle).
- `apps/web/src/hooks/useCoordinatedRead.ts`: React binding (latest-closure
  reads, resubscribe on key change only, in-place demand updates, opt-in
  `trackState`).
- `resource-sync.ts` forwards its existing confirmed-reconnect signal (fresh
  stream / replay miss / generation change, after its boot-announcement
  suppression) to the coordinator; `App.tsx` records the active connection from
  the existing connection-list subscription. No new transport listeners.
- `useNativeAgentSession.ts`: the 500/1,500 ms interval, resource-change and
  resync refreshes and the trailing reconcile now go through the coordinator
  (`critical`). Cadence, sequence/epoch fences, progressive transcript/state/
  discovery separation and unavailable/cached/current/empty handling are
  unchanged; connect, explicit and post-mutation reads stay direct. The key's
  `view` is the hook instance because reads apply into instance-local fenced
  state (conditional tokens), so cross-instance sharing waits for step 07.
- `useFilesPanel.ts`: the 5 s poll is coordinated (`standard`), keyed by
  environment snapshot key and active tab; the open/tab/target read and
  post-mutation reads stay direct. The manual refresh now obtains a post-click
  snapshot instead of joining an older in-flight one.
- `apps/web/src/lib/native-session-read-policy.ts`: cadence constants and the
  quiet-backoff policy hook (see below).

Foreground behavior matches baseline: fixed-rate ticks anchored at the cadence
change (as the recreated `setInterval` was), ticks skipped while a read is in
flight, same intervals. Differences: reads pause while the document is hidden
(invalidations are deferred into one reconcile on return), and one reconcile
read per active key happens after a confirmed transport reconnect.

### Gated / deferred

- **Quiet native backoff (task 8)** is implemented only as a disabled policy
  hook: `ReadDemand.quietBackoffMs` in the coordinator plus
  `NATIVE_QUIET_BACKOFF_TRIAL_MS` (3/5/10/15 s) and the empty
  `NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS` set. Adding a provider enables it
  for that provider's idle views only (never running/blocked/cancelling/
  recovering). Gate: step 07 interaction/completion event coverage and step 11
  missed-event recovery tests for that provider, plus recorded per-refresh
  command/provider request counts.
- **Data-saving preference (task 9)** deferred: there is no existing
  client-local preference layer to extend trivially, and the proposal requires
  a user-facing control. It should set per-client demand through this
  coordinator.
- **Step 09 consumers** (system meters, coordinator panel, reviewer transcript,
  init logs, Cursor login, design canvas) are not migrated.
- **Real-stack qualification** not run: isolated-stack browser QA (inactive
  environment switch, two clients with different settings, parked approvals,
  completion while hidden, queued prompts, reload, missed final invalidation),
  old-backend coverage and measured request counts/latency remain for step 12.
  Headless Chromium keeps pages `visible`, so the component browser spec
  emulates visibility.

### Checks

- Focused: `read-coordinator.test.ts` (fake clock/document/transport, deferred
  reads: two subscribers, option mismatch, delayed visibility change, rapid
  hide/show, focus + reconnect, invalidation and explicit refresh during a read,
  network failure/backoff, auth, permanent unsupported API, server switch,
  target change, unmount/remount, cancellation cleanup, retention bound, quiet
  policy), `native-session-read-policy.test.ts`,
  `useNativeAgentSession.visibility.test.tsx`, extended `useFilesPanel.test.tsx`
  and `resource-sync.test.ts`; interval-spy tests in `AgentNativeTab*.test.tsx`
  and `tests/unit/hooks/useFilesPanel.test.tsx` now drive the coordinator clock.
- `mise run test:logged -- --name check -- mise run check`: pass.
- Full web package (`bun test --cwd apps/web ./src --parallel=3`): 7,256 pass;
  one failure, `MobileAppShellLayout > closes the initial project drawer…`
  (55 s timeout under host load average ~35–50), known open flake 0068, passes
  in isolation.
- `mise run test:changed`: web-related groups green; failures were
  `GlobalSettings > copies the current web client URL` (1.2 s copy-feedback
  window exceeded under load; passes in isolation) and desktop
  `isolated-browser.test.ts > a profile exit during Playwright…` (5 s timeout;
  passes in isolation). Neither imports changed code.
- `mise run test:browser`: new `ReadCoordinator.spec.ts` passes on both
  projects; `DesignCanvas.spec.ts` and `DiffViewerMobile.spec.ts` failed and
  fail identically with the base-commit web sources, so they are pre-existing
  or environmental (Monaco/visibility timeouts under load).

### Rollback

Cadence/backoff rolls back independently of ownership: quiet backoff is already
off, and each migration is one hook-local `useCoordinatedRead` call replacing
one interval effect, so reverting a migration restores its old timer without
running both.
