# Design canvas qualification

Checked against `main` at `2459b05c` (2026-10-15); the flake review against
`9906db30` (2026-10-16).

The design canvas ([`design-canvas.md`](../architecture/design-canvas.md)) is
complete in code: recoverable operations, safe export, history, incremental
sync, visible-frame culling, the saved-designs library and agent context all
shipped with owning tests (#844, then #926, #928, #969 and #988). What it lacks
is evidence from real agents, real containers, an Electron window, assistive
technology and the client side under load. This file tracks that evidence and
the optimisations that were deliberately deferred until it exists, so that
nobody builds them speculatively.

## Current state

- Real-stack suite: `mise run test:agent:design:isolated` runs
  `apps/desktop/scripts/test-agent-browser-isolated.ts --design` against
  `e2e/agent-testing/design-canvas.spec.ts` on a disposable profile. The spec
  has two tests: "real gateway saves a design and rehydrates another client's
  edits" and "private canvases survive reload and can be retired to recover
  quota". It drives the backend through the `design_action` gateway command and
  the UI, never through an agent.
- The task passed on `7081ae8c` (2026-09-24). The Electron dev-startup failure
  that had blocked it was fixed by #840. On 2026-10-15, after the `AppShell`
  breakpoint fix that resolved flake 0209, both tests passed on a fresh profile
  and again inside a full `mise run test:agent:browser:isolated` run.
- Component browser spec `e2e/DesignCanvas.spec.ts` runs the real runtime at
  desktop and phone widths. Because `DesignService` loads `bun:sqlite` since
  #969, the spec drives it in a Bun child process (`e2e/design-service-host.ts`,
  #988).
- Container export is covered only by helper-level tests in
  `apps/backend/src/core/design/export-writer.test.ts` (the "container helper
  scripts (run locally)" and "container wrapper" groups). No run has exported
  from a running container.
- Client culling is unit-tested only (`planLiveFrames` in
  `apps/web/src/components/design/design-visibility.ts`, tested in
  `design-viewport.test.ts`). `scripts/benchmark-design.ts` measures
  backend-side transfer, commit and latency, not the browser.
- Mixed-version fallback and migration are unit-tested
  (`design-controller.test.ts`, `records.test.ts`); no run used real old and
  new binaries.

## Outstanding work

### Qualification

Live-agent and platform runs share prerequisites and batching with other todo
files; see [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

- **Live agents.** One fixture-scoped design-tool cycle each with Claude and
  Codex through the `orkestrator-design` MCP server: create, inspect, refine,
  capture, `save_canvas`. Include an **Ask agent** round trip against a stale
  selection (the agent re-reads, and its edit is still revision-checked), a
  handoff to a reviewable unsent implementation draft, and an environment
  switch while the agent runs and while it waits on a question or approval;
  on return the canvas, transcript and pending controls must be correct.
  Record the MCP call count and response bytes for the cycle.
- **Real-container export.** Export locally and from a running container.
  Interrupt before the write, during it, after the rename and before the
  association commit; also stop or restart the container mid-export, remove
  the worktree, and delete the canvas during export. Each must reconcile by
  exact digest, never by writing again. Until this has run, do not describe
  container export as qualified.
- **Electron window.** Open, edit, export, download, keyboard shortcuts and
  native host-file picking (`design_import_host_file`) in a real Electron
  window, through `mise run test:agent:electron` or a manual pass.
- **Manual accessibility.** A screen-reader pass over the layer tree, frame
  list, inspector and status live region, and a keyboard-only journey: reopen,
  select, edit, move and resize, undo, export. Focus must survive
  acknowledgment, drawer transitions, culling and errors. Check reduced
  motion, high zoom and narrow panes. Record observations next to the tests.
- **Large-canvas client performance.** At 1, 16 and 64 frames on one host and
  build, record gesture-to-preview and release-to-acknowledgment p50/p95,
  frame drops while panning, live iframe count and mounted layer rows, iframe
  DOM replacements per operation, renderer memory, and a leak check after
  repeated activate, deactivate and cull cycles (listeners, iframes, timers,
  blobs). Measure library open time at 1, 50 and 256 canvases; the benchmark
  measured one.
- **Mixed versions and migration on real binaries.** Old client with new
  backend and the reverse. Migrate a copied legacy `.orkdes` fixture, and check
  the explicit downgrade path (export before running an older backend). Cover
  a migrated record, an interrupted migration, a future record version and a
  corrupted record with an older backup.
- **Browser design flakes under controlled parallel load.**
  [0174](../tests/flaky-tests/0174-design-canvas-parallel-browser-timeout.md)
  (`e2e/DesignCanvas.spec.ts` timeouts with six workers) and
  [0208](../tests/flaky-tests/0208-design-canvas-private-import-picker-disabled-in-suite.md)
  (import picker stays disabled late in `test:agent:browser`) were not rerun
  in the 2026-10-16 review. Reproduce each with a fixed worker count and a
  synthetic CPU load. Then decide between a client wait on an observable state
  (the controller's 3 s cursor check is a real timer) and a product fix.

### Deferred until measured

Each option must be removable on its own without reverting a safety fix, and
none may log design content. Today there is one render worker
(`DESIGN_LIMITS.renderWorkers` in `packages/protocol/src/design-operations.ts`;
`DesignRenderer` accepts a `workers` option), a fresh isolated browser context
per job, no capture or inspection cache, no thumbnails (`DesignLibrary.tsx`
lists facts only; culled frames show placeholders), and a whole-record atomic
rewrite per commit (`write` and `writeAtomically` in `core/design/records.ts`).

Decision basis: the 2026-09-24 baseline from `bun scripts/benchmark-design.ts`
(one Linux x64 host, Bun 1.4.0, synthetic content, 20 samples; "before" is
`2aec227b`, before #844):

| Fixture | Catch-up bytes before → after | Edit p50/p95 ms before → after | Commit bytes before → after | Agent response full → compact | Style edit cold/warm ms | Library list ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 frame, small | 2478 → 1034 | 0.41/0.77 → 2.41/5.2 | 2487 → 17074 | 2282 → 403 | 131.2/122.3 | 0.33 |
| 16 frames, small | 36065 → 1034 | 0.71/4.48 → 2.42/3.96 | 37184 → 74606 | 2282 → 405 | 106.4/119.6 | 0.07 |
| 64 frames, small | 143777 → 1034 | 1.29/2.28 → 4.46/5.7 | 148448 → 249551 | 2282 → 405 | 105.7/114.8 | 0.03 |
| 16 frames, near-limit HTML | 3295765 → 1036 | 13.41/23.69 → 25.51/33.09 | 3296884 → 3334394 | 206191 → 405 | 183.1/190.2 | 0.1 |
| 64 frames, near-limit document | 3969491 → 1035 | 18.51/26.45 → 34.09/39.85 | 3974162 → 4075391 | 62232 → 405 | 130.1/153.9 | 0.11 |

Durable receipts cost 2–15 ms per edit, dominated by the record fsync; that
did not justify a storage redesign. In order:

1. **Library and offscreen thumbnails.** Low-priority, bounded capture jobs
   behind interactive work in the render queue, invalidated by content,
   viewport and runtime identity. A stale thumbnail is labelled, a missing
   renderer gives a placeholder, and a thumbnail is never a hit-test target.
   This is the feature that would create the repeated-capture workload item 2
   needs.
2. **Capture and inspection cache.** Only after thumbnails or measurements
   show repeated identical captures. Key on canvas and frame incarnation,
   content identity, viewport, runtime and sanitiser version, scale, colour
   scheme and parameters. 64 entries and 64 MiB with LRU eviction, counting
   PNG and base64 copies. Single-flight identical requests without coupling
   their cancellation; authorise the environment on every read; never cache
   animated content as a permanent result.
3. **Second render worker.** Measure memory and p95 latency with several
   environments rendering before raising `renderWorkers`.
4. **Warm browser-context pool.** Only if context setup dominates once the
   rest is done. It must prove a full reset of DOM, origin storage, listeners,
   routes, permissions and request state between jobs, pass adversarial tests,
   and be compared with fresh contexts including memory.
5. **Storage redesign.** Only if full-record rewrites dominate at high edit
   frequency on near-limit documents. Write a separate storage decision first
   (manifest indirection versus a journal or database) that keeps document
   and receipt atomicity, crash recovery, history and v1 export. Since #969
   cross-process leases already use the backend database
   (`core/design/coordination.ts`); records stay files.

## Constraints and rationale

- Runs use a unique isolated profile and only its fixture repository, with
  fixture-scoped prompts. Never put tokens or real designs in logs or
  screenshots. An unavailable platform is an explicit incomplete gate, not a
  pass.
- Single-machine timings are host evidence, not thresholds. The hard gates are
  correctness and explicit bounds, plus no unchanged HTML for geometry-only
  edits (met: about 1 KiB per catch-up at any size). A lower average with
  worse tail latency, memory pressure or starvation is not a win.
- Capability fallback: the client asks `design_capabilities`; when an old
  backend reports the command unsupported, `getCapabilities`
  (`apps/web/src/lib/design-client.ts`) returns `null` and the client uses the
  v1 legacy snapshot and action path. Missing support never shows a canvas as
  empty or deleted, and old clients never receive an incompatible export
  shape. Pinned by "a v1 backend falls back to legacy snapshots, never an
  empty document" in `design-controller.test.ts`.
- Optimisation rollback restores full snapshots or fresh contexts without
  touching stored documents. Storage rollback is a separate explicit
  conversion; reverting a binary is not enough once records are migrated.
- Non-goals unless evidence changes: multiplayer cursors and comments,
  authored JavaScript, external asset fetching, a resident design agent,
  design launch for providers beyond Claude and Codex (`DESIGN_AGENTS`), CRDT
  or automatic conflict merging, a new database, asset package or write-ahead
  log solely for speed, and automatic implementation dispatch, approval,
  publishing or deployment.
- Design flake review (2026-10-16): none of the backend design flakes was an
  ordering bug, and no product code changed.
  1. **Hint contract.** Hints stay at most once, best effort, and in commit
     order per canvas within one backend, because they are published inside
     the lane after their commit. The cursor and `design_sync` are
     authoritative, and there is no per-hint sequence number and no dedupe.
     The ordering is pinned by "live hints follow per-canvas commit order and
     stale validation publishes nothing" in `core/design/sync.test.ts` and
     stated under Synchronization in `design-canvas.md`. A sequence number
     would add nothing: revision plus status version already orders hints,
     and clients repair gaps by cursor.
  2. **0215 was fixed in the test.** The 4th event was the first commit's
     background-validation `status` hint, which is correct behaviour. The case
     now holds that job with `renderer.block` before counting, then asserts
     that the hint is the only later one. Awaiting validation inside
     `execute` was rejected: it would put a render on every HTML edit's
     acknowledgment path.
  3. **0193, 0218 and the 0225 design cases bound the work, not the
     deadline.** 258, 260 and 55 sequential fsynced commits took 0.4–0.9 s
     alone and over 5 s under load. The tests lower the bound with
     `withDesignLimit` (`core/design/test-support.ts`; `DESIGN_LIMITS` is read
     at call time), and in-memory cases check the shipped 256-change and
     50-entry bounds. Raising the per-test deadline was rejected because it
     keeps the load sensitivity. A `DesignServiceOptions` limit seam was
     rejected because it would touch `records.ts`, `apply.ts` and `service.ts`
     only for tests.
- Deliberate deviations, not bugs: drafts persist per client in
  `localStorage` (`design-drafts.ts`) rather than the backend compose-draft
  store; the layer tree uses its own fixed-row windowing instead of
  `react-virtuoso` so focused and selected rows stay mounted; "agent
  available" means enabled in settings.

## Open questions

- Should design join a shared live-provider harness (like
  `e2e/agent-testing/opencode-live.spec.ts`) rather than get its own spec?
- Is an Electron design spec worth keeping in
  `e2e/agent-testing/playwright.electron.config.ts`, or is a one-off manual
  pass enough?
- Are thumbnails wanted as a product feature on their own merits? The library
  shipped without them.
- Is a cross-environment design transfer UI wanted? Recovery copies, download
  and import cover copying today. If it is built, define and test the lock
  order for two-canvas operations before adding them.

## Related

- [design-operation-recovery-edges.md](design-operation-recovery-edges.md) and
  [design-agent-conversation-links.md](design-agent-conversation-links.md).
- [container-platform-qualification.md](container-platform-qualification.md)
  for container runs, [mixed-version-compatibility.md](mixed-version-compatibility.md)
  for old-client and old-backend runs, and
  [test-suite-and-ci-health.md](test-suite-and-ci-health.md) for flake triage.
- [`agent-testing.md`](../development/agent-testing.md) and
  [`testing-guide.md`](../development/testing-guide.md).
- Open design flakes:
  [0174](../tests/flaky-tests/0174-design-canvas-parallel-browser-timeout.md),
  [0208](../tests/flaky-tests/0208-design-canvas-private-import-picker-disabled-in-suite.md)
  and [0246](../tests/flaky-tests/0246-design-renderer-real-chromium-launch-deadline.md)
  (real-Chromium launch on CI). Resolved on 2026-10-16 as test artefacts:
  [0193](../tests/flaky-tests/0193-design-sync-gap-aggregate-timeout.md),
  [0215](../tests/flaky-tests/0215-design-operation-replay-event-count.md),
  [0218](../tests/flaky-tests/0218-design-service-replay-aggregate-timeout.md)
  and the design half of
  [0225](../tests/flaky-tests/0225-design-and-bench-aggregate-timeouts.md).
- Living-doc drift to fix in [`design-canvas.md`](../architecture/design-canvas.md):
  - The opening says the dialog has two modes and "no library or status
    panel". Since #928 `DesignWorkspaceDialog.tsx` has three tabs: **New
    design**, **Open design** (host `.orkdes` picker with an upload fallback)
    and **Saved designs** (`DesignLibrary`: search, rename, duplicate, trash,
    restore, purge).
  - The Tests paragraph omits the `cross-process` and `host-file` backend
    tests.

## Replaces

- `docs/improvements/design-space.md` (assessment; all twelve findings are
  implemented, the U4 remainder is in
  [design-agent-conversation-links.md](design-agent-conversation-links.md))
- `docs/improvements/design-space/plan/00-index.md` (qualification gaps,
  deferred items, non-goals, capability decision, measurements and
  deviations; the residual edges went to
  [design-operation-recovery-edges.md](design-operation-recovery-edges.md))
- `docs/improvements/design-space/plan/01-preserve-editing-intent.md` (done)
- `docs/improvements/design-space/plan/04-renderer-scheduling-and-recovery.md`
  (second-worker evaluation)
- `docs/improvements/design-space/plan/05-safe-saving-and-export.md`
  (real-container interruption runs; the rest is done)
- `docs/improvements/design-space/plan/06-validation-deletion-and-recovery.md` (done)
- `docs/improvements/design-space/plan/07-history-and-document-lifecycle.md`
  (cross-environment transfer question; the rest is done)
- `docs/improvements/design-space/plan/08-entry-readiness-and-library.md`
  (thumbnails; the readiness panel was removed in #926 and the library
  restored in #928)
- `docs/improvements/design-space/plan/09-selection-and-inspector.md` (done)
- `docs/improvements/design-space/plan/10-navigation-and-accessibility.md`
  (manual accessibility and Electron passes)
- `docs/improvements/design-space/plan/12-incremental-synchronization.md` (done)
- `docs/improvements/design-space/plan/13-visible-frame-and-layer-rendering.md`
  (client performance and leak evidence)
- `docs/improvements/design-space/plan/14-storage-rendering-and-mcp-efficiency.md`
  (conditional cache, context pool and storage redesign; A–D are done)
- `docs/improvements/design-space/plan/15-qualification-and-rollout.md`
