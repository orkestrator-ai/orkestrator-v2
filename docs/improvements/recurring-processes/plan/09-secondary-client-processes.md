# 09 — Streamline secondary client reads

Status: Implemented (unit/component/Electron-unit qualified) — all five
subsections landed; Docker-availability sharing, a longer quiet design-canvas
interval and a shared display clock are recorded deferrals; real-stack browser
qualification remains for step 12. See [Completion notes](#completion-notes).
Dependencies: 03, 06; step 11 for new event contracts.
Findings: F05, F08. Implement subsections separately and prioritize by baseline.

## System and process usage

Targets: `SystemUsageIndicator.tsx`, `AgentInfoButton.tsx`, `system-usage.ts`,
`environment-process-usage.ts` and their command wiring.

1. Use one client subscription per backend/system sample key. The title bar's
   five-second demand and open popover's three-second demand combine into one
   effective cadence; closing the faster consumer restores the slower demand.
2. Retain existing backend pending-read joining and GPU/RAM caches. Add a bounded
   completed snapshot TTL only if nonoverlapping requests still repeat costly
   work. Account for project/disk target in keys; never reuse a disk reading from
   the wrong filesystem. Preserve CPU sampling-window correctness.
3. Keep environment process enumeration separate and demand-driven. Apply hidden
   document handling and shared in-flight reads across clients where safe.
   Retain process ownership validation, redaction and response bounds.
4. Show source sample time and stale state accurately. A failed refresh must
   not refresh the sample timestamp or imply a new measurement.

Acceptance: one physical expensive sample per agreed freshness window for an
equivalent target; no hidden optional meter reads; correct fallback on failed
sampling. Tests should cover multiple consumers and elapsed sampling windows.

## Coordinator and repository status

Targets: `CoordinatorPanel.tsx`, resource contracts/store binding, coordinator
commands/service and project Git status owner.

1. Subscribe to scoped `coordinator` changes before hydrating. Decide whether an
   always-mounted store or a panel-owned snapshot fits current architecture;
   either must rehydrate on mount/reconnect and fence project replacement.
2. Add a conditional generation/revision token and missed-event recovery coverage.
   The persistent-resource manifest omits coordinator today; extend deliberately
   or give this view a compact compatible recovery API.
3. Keep repository status separate: an external Git command need not emit a
   coordinator resource event. Reuse worktree/ref invalidation where available
   plus a low-frequency status probe and explicit fetch/sync/switch refresh.
4. Guard focus/visibility/timer overlap. Fetch-on-open remains subject to shared
   fetch policy; a status read does not need a remote fetch every time.

Acceptance: changes from another client appear promptly; no duplicate refresh
burst on focus; external Git changes recover; coordinator commands remain
backend-authoritative. Test switched projects while an old read is in flight.

## Reviewer transcript, validation output and initialization logs

Targets: `MultiReviewReviewerTab.tsx`, `multi-review-service.ts`,
`ReviewValidationStatus.tsx`, review output service, `InitializationLogs.tsx`.

1. Add conditional revision/cursor reads to reviewer progress where the provider
   supports them. Preserve the bounded returned tail and final refresh; include
   reviewer/workflow state in the view revision even if message text is unchanged.
2. Consider output offsets/digests for validation output. Detect truncation,
   rotation or generation reset and return an authoritative bounded tail when a
   cursor is invalid. Keep artifact availability/error semantics and manual copy.
3. Share Docker initialization tail reads by container generation and short
   freshness window. Skip identical client state writes. Start with shared
   snapshots; a durable log follower is a separate measured decision requiring
   bounded replay and restart recovery, not an automatic replacement.
4. Move scheduling to step 06. Keep reads scoped to active/open operations,
   retain current terminal stop behavior and restore immediately after visibility.

Acceptance: identical content need not retransmit/re-render; stopped/completed
views settle correctly; lost final events and reopened panels recover full
current bounded content. Add slow-read/manual-refresh and older-backend tests.

## Capability/readiness, annotation and login

Targets: `App.tsx`, `ServerConnectionSwitcher.tsx`, `BrowserTab.tsx`, desktop
browser-preview manager/preload, and `CursorSdkSignIn.tsx`.

1. Share Docker availability observations at the backend with explicit freshness
   and change hints if multiple clients measurably duplicate probes. Preserve
   recovery-only environment reconciliation and initial onboarding behavior.
2. Reuse connection transport health as supporting evidence, but retain an
   authenticated readiness probe: an open socket does not prove every command
   surface or credential is usable. Guard superseding probes and fence results.
3. For browser annotations, introduce operation IDs and terminal native events
   for submission/cancel/error. Subscribe before starting the operation; after
   reconnect or missing events, query authoritative operation status. Keep a
   slower temporary fallback until native/browser compatibility is proven.
   Submission must be handled once even if event and status read race.
4. Move pending Cursor login polling to guarded completion scheduling. A settings
   close removes observation only; login remains owned by the backend until its
   deadline or explicit cancellation. Add events only if they justify their cost.

## Design canvas and display clocks

Retain the canvas cursor/reset protocol and subscribe-before-read ordering.
Route its three-second safety check through visibility/demand policy, and trial
a longer quiet interval only after missed-final-hint recovery is qualified.

If profiling shows many elapsed components causing render work, provide a
reference-counted visible one-second display clock, plus a minute clock where
needed. Do not tie approval validity or workflow timeout enforcement to it;
those remain server decisions. Bounded focus/scroll/tooltip timers are outside
this migration.

## Qualification and rollback

Each subsection gets owning component/service tests, call-count measurements,
and real browser checks for hide/show, environment switch, reload and two clients.
Native annotation changes additionally require Electron/preload tests. Keep
subsections independently reversible. If a new event path fails qualification,
retain guarded snapshot polling rather than shipping a view that can go silent.

## Completion notes

Recorded 2026-09-26 on branch `worktree-agent-ad593df1a4827bf19` (based on
`implement-recurring-processes-aaceef7ccc03-r1` at `417b1209`, later merged
with its step 04 head in `e7c1942b`). One commit per subsection, each
independently revertible:

| Subsection | Commit |
| --- | --- |
| System and process usage | `dbe2cd6c` |
| Coordinator and repository status | `5d772075` |
| Reviewer transcript, validation output, initialization logs | `9ea9730e` |
| Capability/readiness, annotation and login | `96c2a0b2` |
| Design canvas and display clocks | `4cda1722` |

Call counts below are deterministic counts from the owning tests (fake
coordinator clock), per client unless stated; they are not live-profile
measurements.

### System and process usage (`dbe2cd6c`)

- `apps/web/src/hooks/useSystemUsage.ts`: one read-coordinator key per backend
  host sample (`system-usage` / `backend` / `disk=data-dir` — the only disk
  target `get_system_usage` samples; the coordinator's connection identity
  scopes it to one backend) and a separate `environment-process-usage` key.
  `SystemUsageIndicator` (5 s) and the open `AgentInfoButton` popover (3 s)
  subscribe to the same key: the fastest active demand wins and closing the
  popover restores 5 s. Both pause while the document is hidden and reconcile
  once on return (auxiliary priority).
- Staleness is judged on the coordinator clock from when the read that
  produced the retained sample started (`ReadState.observedAt`, never advanced
  by a failed read). A one-shot timer re-renders when that age crosses 10 s,
  so a hung or paused read cannot keep an old sample looking current; remote
  clock skew no longer affects it (the old rule compared client `Date.now()`
  with the backend's `sampledAt`). The backend `sampledAt` is shown in meter
  tooltips/`title` and exposed as `data-sampled-at`. Malformed samples are
  failed reads. `ReadCoordinator` gained one additive member, `clock`.
- Backend: concurrent `get_environment_process_usage` calls from several
  clients join one enumeration; nothing completed is cached; ownership
  validation, redaction and bounds are unchanged.
- **Completed-snapshot TTL: measured and not added.**
  `system-usage.test.ts` › "non-overlapping requests from two clients repeat
  no costly probe": two interleaved 5 s title bars (one request per 2.5 s for
  60 s) cost ≤ 5 GPU probes (15 s cache), 0 fresh 200 ms CPU baselines after
  startup, one `statfs` per request and two `os.cpus()` reads — nothing a TTL
  would save — while a TTL would serve stale CPU windows. Disk readings are
  keyed by target and never cross filesystems (same test).
- Counts: title bar + open popover 12 + 20 → 20 reads/min; hidden popover
  20 → 0; hidden process panel 20 → 0; the catalogue now lists
  `client-system-meters` and `process-usage` as `join`.
- Tests: `useSystemUsage.test.tsx` (combination and restore, inactive
  consumer, hidden/show with coalesced focus, failed refresh keeps sample time
  and ages into stale, malformed sample, server switch with a late answer,
  separate process key), rewritten `SystemUsageIndicator.test.tsx` and
  `AgentInfoButton.test.tsx` polling tests on the fake coordinator (hung
  refresh ages out, reopen within the freshness window reuses the retained
  list), backend join tests in `environment-process-usage.test.ts`.

### Coordinator and repository status (`5d772075`)

- **Ownership decision: panel-owned** (`useCoordinatorPanelData`), not an
  always-mounted store: the panel is the only consumer; it rehydrates on every
  mount; the read coordinator re-reads after a reconnect or server switch.
- Subscribes to scoped `coordinator` resource changes (id or `projectId`) and
  `config` changes (provider availability) **before** `ensure_project_coordinator`;
  an event during hydration is replayed as one read once the view is live.
- **Compact compatible recovery API** instead of extending the persistent
  manifest: additive `get_project_coordinator_view` (`coordinator-view-revisions.ts`)
  answers the step 11 `ViewSnapshotOutcome` contract. `generation` is one
  backend lifetime; `revision` changes whenever the captured snapshot's digest
  changes and comes from one process-wide counter, so it is never reused for a
  different body (also after eviction from the 256-project map). The snapshot
  mixes stored and live, unannounced facts (qualification, control MCP), which
  is why a digest rather than a store counter decides. `unchanged` carries no
  body; a removed workspace answers `deleted`. Clients do not gap-detect this
  view (its events are bodiless `resource-changed` invalidations); missed
  events recover through `onViewSafetyCheck` (five-minute manifest interval and
  resource revision gaps), reconnect reconciliation and the focus probe.
  Older backends (`Unknown backend command`) keep the previous 60 s full poll.
- **Repository status stays separate**: a 60 s visible-only probe through the
  coordinator (auxiliary), one probe per focus/visibility burst (10 s guard;
  focus + visibility no longer double-fire), explicit fetch/sync/switch, and
  adoption of a strictly newer `repositoryStatus` persisted inside the
  coordinator snapshot (so a status refreshed by another client arrives via the
  coordinator event). Status reads never fetch; fetch-on-open stays subject to
  the backend's 60 s fetch cooldown and in-flight join.
- Fencing: every answer carries its project id and is dropped after a project
  switch; status revisions never roll back; a view body that started before a
  direct mutation answer is discarded and re-read; `unchanged` is accepted only
  for the exact stamp sent. Coordinator commands stay direct and
  backend-authoritative.
- Counts (visible panel, quiet project): coordinator snapshot 1/min → 0
  periodic (one bodiless conditional read per 5 min safety check, per
  relevant event, and per guarded focus); Git status 1/min unchanged; a
  focus + visibility return 4 commands → at most 2 (and none within 10 s of the
  last probe).
- Tests: `coordinator-view-revisions.test.ts` (unchanged only for the held
  body, never-reused revisions, restart reset, deleted, eviction safety,
  command); `useCoordinatorPanelData.test.tsx` (event during hydration, other
  client's change with no re-render on `unchanged`, lost final event recovered
  by the safety check with no own polling, project switch with old ensure and
  old view read in flight, focus/visibility burst guard, 60 s status probe and
  hidden pause, persisted status adoption without rollback, direct answer
  racing a view read, legacy backend poll); `CoordinatorPanel.test.tsx`
  updated. Recovery rows this view adds to the step 11 list: lost final event
  → "a missed final event is recovered by the resource-sync safety check";
  generation reset / deleted → `coordinator-view-revisions.test.ts`;
  unsupported → "an older backend keeps the conservative full poll".

### Reviewer transcript, validation output, initialization logs (`9ea9730e`)

- Reviewer transcript: conditional source-token reads already existed and
  every answer carries reviewer/workflow state. The 4 s backstop now runs as an
  instance-scoped coordinator key (active tab of a running/pending reviewer
  only; paused hidden; reconciled on return); activation, status changes
  (including the final one) and workflow checkpoints still read directly.
  An `unchanged` answer whose state also did not move keeps the same object,
  so the message projection is not rebuilt every poll.
- Validation output: additive byte-offset contract
  (`ReviewValidationOutputStream.anchor`/`mode`, request `known`). The
  in-environment reader digests the last 64 bytes before each size; a client
  echoing `{ totalBytes, anchor }` receives `append` with only new bytes.
  Truncation, rotation (anchor mismatch), a gap larger than the 512 KiB bound
  or a malformed position answer an authoritative `tail`. The client merges
  into a bounded tail, resyncs (one retry) when it cannot place an append,
  skips identical answers, and polls through the coordinator without
  overlapping a slow read; status-change/manual refreshes always get a
  trailing read (final refresh preserved). Artifact confinement, error
  semantics and manual copy are unchanged. Older backends ignore `known`.
  Counts: a streaming command previously re-sent up to 512 KiB per stream
  every 2 s; now only appended bytes (idle: empty). The in-environment `bun`
  read per poll remains.
- Initialization logs: the backend shares `get_container_logs` per container
  id (the container generation) and tail size — in-flight join plus a 750 ms
  freshness window, failures never cached, 32 entries. The client uses one
  coordinator key per container (two views share a read), pauses hidden, and
  an identical tail writes no state (no re-render, no re-scroll). Counts: three
  clients polling one creating container for 10 s: 30 → 10 `docker logs`
  (`container-log-snapshots.test.ts`). Failure retries now follow the
  coordinator's capped backoff (≥ cadence) instead of every second. A durable
  log follower was not introduced (separate measured decision).
- Tests: `MultiReviewReviewerTab.{behavior,transcript}.test.tsx` (no overlap
  on slow reads, hidden pause and return, identity-preserving merge, cadence),
  `ReviewValidationStatus.test.tsx` (slow read, append/unchanged/rotation with
  hidden pause), `validation-output-merge.test.ts`,
  `review-validation-output-offsets.test.ts` (real reader: append, empty
  append, truncation, rotation, oversized gap, malformed position),
  `InitializationLogs.test.tsx` (rewritten on the fake coordinator: sharing,
  identical tails, hidden pause, stale flag), `container-log-snapshots.test.ts`.

### Capability/readiness, annotation and login (`96c2a0b2`)

- **Docker availability sharing: deferred.** A client probes once per 60 s
  (`docker info`), so a second client adds ≤ 1 probe/min, whereas step 01's
  baseline shows container state polls at one `docker exec` per container per
  second dominating Docker cost. Concurrent probes are rare at that cadence,
  so neither a join nor a shared observation has measurable benefit today.
  Recovery-only environment reconciliation and onboarding are untouched.
- Connection switcher: the authenticated readiness probe is kept (an open
  socket proves neither command surface nor credential); transport health is
  not substituted. A probe younger than 5 s is joined by focus/interval/menu
  bursts; only a stalled one is superseded, and its late answer remains fenced
  by generation. The 30 s interval skips while hidden.
- Browser annotation: `startAnnotation` returns an `operationId` (the host
  session id) and statuses carry it. The page runtime reports submit/cancel
  through a bounded console marker (the preview view has no preload); the
  preview manager forwards only the running operation's hint to its window as
  `browser-preview-annotation` (generic `listen` bus, so the preload bridge
  needed no new method). The renderer subscribes for the hook's lifetime
  (before starting), answers a matching event with an authoritative status
  read, serializes reads and acts on the first terminal answer only, so a
  submission is handled once when an event and a read race. A 1 s fallback
  poll stays (missed event, reload — which emits nothing — or older runtime);
  desktops without operation ids keep 150 ms. Counts: 400 → 60 status reads
  per annotating minute plus one per terminal event.
- Cursor login: one coordinator key; one read in flight (answers apply in
  order — the old refresh had no gate); 1.5 s only while pending; paused
  hidden; explicit refreshes (start, sign-out, cancel, credential revision)
  obtain a post-call read. Closing settings removes the observation only; no
  cancel is sent. No login events were added (not justified by cost).
- Tests: `BrowserTab.test.tsx` (event read, slow fallback, foreign
  operation/tab ignored, handled once under a racing duplicate event with no
  spurious error), Electron unit tests `browser-preview-manager.test.ts`
  (operation ids, only the running operation's hint forwarded, none after
  cancel) and `browser-preview-annotation-script.test.ts` (runtime emits one
  marker on cancel; bounded parser), `main-ipc` and `preload-api` suites
  unchanged and passing; `ServerConnectionSwitcher.test.tsx` (burst joins,
  stalled probe superseded, fenced late answer); `CursorSdkSignIn.test.tsx`
  (pending-only cadence, hidden pause, unmount never cancels, settled logins
  schedule nothing). `mise run test:agent:electron` passed (28 s); it does not
  drive annotation end to end.

### Design canvas and display clocks (`4cda1722`)

- The 3 s cursor safety check runs as an instance-scoped coordinator key while
  the canvas is active: unchanged cadence while visible, no reads hidden, one
  reconcile on return. Cursor/reset protocol, subscribe-before-read and the
  serialized refresh are unchanged. Test: `DesignCanvasTab.test.tsx` › "the
  cursor safety check keeps 3 s while visible, pauses hidden and repairs a
  missed hint on return".
- **Longer quiet interval: deferred** — missed-final-hint recovery has only
  the unit test above; the plan requires qualification first.
- **Shared visible display clock: deferred** — not profiled. The one-second
  clocks (`useElapsedTimer`, `usePromptDeadline`) exist only on running
  turns/cards and open prompt cards, clear when inactive/settled, and each
  re-renders one small component; nothing indicated render cost. Approval and
  workflow deadlines remain server decisions in either case.

### Checks

Focused suites above pass (web, backend, protocol, Electron unit), web,
backend and desktop typechecks pass. Aggregate results are recorded in the
final commit message of this note. Known unrelated failure:
`packages/protocol/src/preview-forward.test.ts` (two websocket-upgrade
tests time out at 5 s, also when run alone; no step 09 change touches preview
forwarding or its imports).

### Not done / untested constraints

- No real-stack browser qualification (hide/show, environment switch, reload,
  two clients with the isolated `dev:test` profile) and no live request-count
  or latency measurements; the counts above are deterministic test counts.
- Annotation native events were verified with Electron unit tests and the
  Electron main suite, not by annotating a real preview end to end.
- The validation reader still spawns one in-environment `bun` per poll; only
  transfer and client work were reduced.
- Legacy capability for the coordinator view is remembered per panel
  instance, not re-probed after a server switch within one mount.

### Rollback

Each subsection reverts independently. Protocol additions
(`get_project_coordinator_view`, validation `known`/`anchor`/`mode`,
annotation `operationId` and event) are additive; older peers keep their
previous behaviour, and reverting a client commit restores its own timer
without two schedulers running.
