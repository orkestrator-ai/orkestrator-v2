# 09 — Streamline secondary client reads

Status: Not started. Dependencies: 03, 06; step 11 for new event contracts.
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
