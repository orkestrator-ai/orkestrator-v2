# Design frame bridges and frames grow under culling at 64 frames

Found on 2026-11-01 against `main` at `93b99bfb` (web code `95093c16`) by the
Linux run of the client performance harness; see
[0036 → Client performance on Linux](0036-design-canvas-qualification.md#client-performance-on-linux).

## Task analysis

Analysed 2026-11-02 against main at 38d55ee146c5bc29bdfb338c4f93f9de5f0cd787. The
constructor still added the listener, so the hypothesis still applied.

### Tasks

1. **Confirm or rule out a retained frame per culling cycle at 64 frames.** Status: done (confirmed by a component test, 2026-11-02).
2. **Fix it if confirmed, and make the harness's leak check fail on it.** Status: done in code and unit tests; the first live 100-cycle measurement converged at 64 frames (see Needs verification for repetition status).

### 1. Confirm the growth

**Problem.** In the harness's leak check (deactivate and reactivate the tab,
then pan every frame out of view and back) at 64 frames, window listeners and
live frames grew together while the DOM held 8 iframes throughout. The
2026-10-22 run on the Apple M5 Max converged at 64 frames over 100 cycles on
`60a75b73`; this one did not.

**Evidence** (Linux x64, Intel Core Ultra 9 285H, Chromium 156, a host shared
with other builds):

- 12 cycles × 3 runs: run 1 converged; run 2 grew window listeners 33 → 35 and
  CDP `Frames` 9 → 11; run 3 (load1 67–79) grew `JSEventListeners` 441 → 450,
  window listeners 39 → 44 and `Frames` 15 → 20.
- 100 cycles × 1 run (`--frames 1,64 --cycles 100 --skip-library`, load1
  falling from 42 to 3; report
  `output/benchmarks/design-canvas/2026-11-01T04-18-05-573Z.json`): window
  listeners 34 → 61 and `Frames` 10 → 37, one for one, with iframes at 8 and
  post-GC heap 13.8 → 14.6 MiB. Growth was uneven: +4 by cycle 10, +3 more by
  25, +16 by 50, then +4 over the last 50. At 1 frame the same run converged
  (listeners settled after the first cycle).

**Hypothesis (not verified).** `DesignFrameView` creates a
`DesignFrameBridge` in the iframe's `onLoad` handler and stores it with
`setBridge`. The bridge adds its `window` `message` listener in its
constructor, and only the effect that commits it closes it. If two `load`
events land before React renders (likely only on a busy main thread), the
first bridge is replaced in state before it is ever committed: nothing closes
it, and its listener keeps it and the frame's `Window` alive. That would give
one window listener and one retained frame per lost bridge, unevenly and
under load, as observed.

**Outcome (2026-11-02).** Confirmed with a component test,
`apps/web/src/components/design/DesignFrameView.bridge.test.tsx`. It renders
`DesignFrameView`, dispatches native `load` events inside one `act()` so
React cannot render between them, and counts `window` `message` listeners.
Against the unfixed code (main at 38d55ee14):

- two loads before a render left 2 listeners instead of 1;
- a load that landed in the same batch as the unmount left 1 listener instead
  of 0;
- 10 cycles of "two loads, cull (`live` false), restore" left 1, 2, 3 … 10
  listeners after each cull, and 2, 3 … 11 while live: one per cycle, the
  same one-for-one shape the harness saw.

A bridge that was replaced or dropped before commit is never closed, and its
listener keeps it and its target `Window` reachable. That explains the
harness's paired growth of window listeners and CDP `Frames` while the DOM
held 8 iframes. `DesignCheckpointPreview` used the same pattern.

**Next steps (as written at analysis).**

- Count bridges constructed against bridges closed in the harness (or a
  component test that fires two `load` events before React renders), to
  confirm or rule this out.
- Run the same 100-cycle check on the M5 Max at current `main`, to separate a
  regression since `60a75b73` from a host or Chromium difference.

**Decision.**

- **Where should the bridge add its window listener?**
  - **In an `open()` called by the effect that registers the bridge, so
    construction has no side effect (recommended if confirmed).**
    - Pros: a bridge that is never committed holds nothing; creation and
      cleanup pair in one effect.
    - Cons: every caller must open before asking; a small API change.
  - **Close the previous bridge inside `onLoad` before replacing it.**
    - Pros: one-line change.
    - Cons: still leaks a bridge created during an unmount; relies on the
      handler seeing the latest state.

### 2. Fix and guard

Once confirmed: fix it, add a unit test that fails without the fix, and rerun
`--frames 64 --cycles 100` until it converges. The harness already reports
`windowListeners` and `cdpFrames`; no harness change is needed.

**Outcome (2026-11-02).** Fixed with the recommended option. Construction of
`DesignFrameBridge` has no side effect. `open()` adds the listener; it is
idempotent and does nothing on a closed bridge, and `ask()` rejects before
`open()`. `DesignFrameView` opens the bridge in the effect that registers it
and closes it in that effect's cleanup. `DesignCheckpointPreview` opens it in
its close effect. The keyboard-shortcuts e2e fixture opens it right after
creating it in `onLoad`, because it already closes the previous bridge there.
The four lifetime tests in `DesignFrameView.bridge.test.tsx` fail without the
fix and pass with it. `frame-bridge.test.ts` pins the open/close contract, and
`DesignCheckpointPreview.test.tsx` checks that a replaced preview bridge is
never opened. The harness rerun completed two converging 100-cycle measurements at 64
frames, but its default three-run command exceeded the logged wrapper deadline
(see Needs verification).

## Assumptions and decisions

### Task 1: how to confirm

Chose a component test over counting bridges in the harness. The test is
deterministic: it forces the race with native `load` events inside one
`act()` instead of waiting for a busy main thread to produce it. It also
becomes the regression guard for task 2. The harness only shows the leak
under load, so it could neither confirm nor rule it out reliably. The test
covers a third case that the analysis did not name: a load in the same batch
as the unmount, such as a tab deactivation.

### Task 2: where the listener is added

Took the recommended option, an `open()` called by the effect that registers
the bridge. "Close the previous bridge in `onLoad`" would not fix the unmount
case, which the test shows also leaks. `ask()` before `open()` rejects
instead of opening lazily. Every ask in `DesignFrameView` happens after the
effect has run (render and setMode run in later effects, and hit tests need
`ready`), so a reject only exposes a caller bug, while lazy opening would
bring the side effect back to an object that might never be committed.

### Task 2: preview bridge

Applied the same change to `DesignCheckpointPreview`, which had the same
`onLoad` → `setBridge` pattern. `DesignPreviewBridge` now includes `open`.

### Task 2: Strict Mode coverage

Chose to test the real load-driven lifecycle under `StrictMode`, with real
bridge requests and source-checked replies. The initial effect replay happens
while bridge state is null; the subsequent iframe load commits the bridge.
The test verifies one listener, successful requests before and after rerender,
the same registered bridge without another load, and zero listeners on unmount.
This closes the Strict Mode coverage gap for this component's actual entry
path. It does not claim that a terminally closed bridge can be reopened or
that an arbitrary Activity hide/show preserving an already-loaded instance is
supported. No product change was needed for the tested Strict Mode path.

Options: testing the actual Strict Mode lifecycle (recommended) exercises the
component and its reply transport but does not simulate unrelated lifecycle
mechanisms; reopening closed bridges would allow effect reuse but weaken the
terminal close contract without evidence that Strict Mode requires it here.

## Current state

- `apps/web/src/components/design/frame-bridge.ts`: `DesignFrameBridge` adds
  its `window` `message` listener in `open()` and removes it in `close()`.
  The constructor has no side effect.
- `apps/web/src/components/design/DesignFrameView.tsx`: `onLoad` calls
  `setBridge(new DesignFrameBridge(…))`; the effect keyed on `bridge` opens
  it, registers it, and closes it on cleanup; another sets the bridge to null
  when the frame stops being live.
- `apps/web/src/components/design/DesignCheckpointPreview.tsx`: opens and
  closes its bridge in one effect.
- `e2e/perf/design-canvas-perf.ts`: the leak check samples CDP
  `JSEventListeners` and `Frames`, and `DOMDebugger.getEventListeners` on
  `window` and `document`.

## Outstanding work

- Finish the default three-run harness command and retain its full JSON report (see Needs verification).

## Constraints and rationale

- Harness numbers here come from a host shared with other builds; treat them
  as evidence of growth, not as rates.
- Frames retained this way hold sandboxed design content in memory until the
  tab closes; nothing is sent anywhere.

## Open questions

- Does the growth reach a user in normal use? The harness's cycle (tab
  deactivate and reactivate plus a full pan) is more aggressive than a
  person's, but long sessions on a busy machine run many such cycles.

## Needs verification

The post-fix live rerun on 2026-11-02 completed two 100-cycle measurements
at 64 frames and one at 1 frame, all reporting `converged true`. At 64 frames there
were 8 live iframes at rest and a maximum of 8 during pan. The convergence
verdict includes zero-slack checks on window listeners and CDP Frames between
the settled early and late samples. The command exceeded test:logged's 1,800,000 ms total group deadline
(1,800.8 seconds elapsed) during run 2 at 1 frame, after cycle 70. Run 3
was not reached. Numeric progress and the deadline diagnostic are logged in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8eVwnR/retention-100-rerun.log.gz`.
No final JSON report was written. The exact command was rerun after the
progress fix; it still exited 1 because of the wrapper deadline, so this is
partial live evidence rather than a passing complete harness check. A full
three-run retry needs an explicitly larger bounded group deadline, for example
`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 mise run test:logged -- --name
retention-100 -- mise exec -- bun e2e/perf/design-canvas-perf.ts --frames 1,64
--cycles 100 --skip-library`. That extended retry has not been run.


- Rerun `mise exec -- bun e2e/perf/design-canvas-perf.ts --frames 1,64
  --cycles 100 --skip-library` and check that `windowListeners` and
  `cdpFrames` settle at 64 frames. On 2026-11-02 the exact command was run
  through `test:logged` (`retention-100`), but the long measurement stopped producing
  output. The last setup message showed one renderer job running and 15 queued;
  the baseline reproduction also showed that Chrome had launched, so that
  message did not establish a setup stall. The logged runner
  terminated it after 300 seconds without output (312.1 seconds total). No
  retention samples or convergence report were produced. Failure artifact:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.GuSJLk/retention-100.log.gz`.
  The same inactivity termination reproduced on origin/main at 38d55ee14
  using independently installed dependencies and port 15372 (312.2 seconds;
  artifact `orkestrator-test-run.h9YAF0/baseline-retention.log.gz` under the
  same temporary-directory root). Commit dabd1137a adds progress every ten
  completed cycles, preserving watchdog detection of a stalled cycle.
  The original
  growth showed up only on a busy host, so a converging run on a quiet host
  proves less than the component test does.
- Run the same check on the M5 Max at current `main`. This was the analysis's
  second next step and is still open.

### Review validation outside this ticket

The original review package and all its artifacts were preserved. Its failed
unit aggregate and browser aggregate have no failing path in this branch's
`git diff origin/main...HEAD`. A detached origin/main worktree at 38d55ee14
with its own frozen dependency install reproduced:

- terminalPortalStore: four shifted-modifier routing failures (31 pass, 4 fail
  across it and node-action-requests); artifact `orkestrator-test-run.lDiwF4/base-web.log.gz`;
- ClaudeTmuxInteractiveTerminal: three invocation/routing assertions (23 pass,
  3 fail); artifact `orkestrator-test-run.egCYE0/base-root.log.gz`;
- Codex command catalogue: stale versus ready at line 293 (31 pass, 1 fail
  across it and fake-codex-app-server); artifact `orkestrator-test-run.Q97y9L/base-codex.log.gz`;
- all four desktop Cursor CloseRetention failures (2 pass, 4 fail), using
  `ORKESTRATOR_E2E_PORT=15371` to avoid another checkout's fixture server;
  artifact `orkestrator-test-run.gAlBN1/base-browser.log.gz`.

These artifact paths are under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`. No unrelated code or tests
were changed. The two originally recorded timeouts (root-change approval and
fake Codex version/invocation) passed in the focused baseline runs. Their
aggregate cause remains unexplained, not excused as environmental. A baseline
`mise run test` attempt waited behind another worktree's exclusive lease and
was cancelled while queued (exit 75); evidence is
`orkestrator-test-run.xsjdRk/baseline-aggregate.log.gz`. The detached worktree
was removed after all its owned commands finished.

Targeted post-change checks passed: StrictMode regression; bridge, frame view
and checkpoint preview tests; web and e2e typechecks; oxlint and formatting on
both edited TypeScript files. Previously passing broad checks were not repeated.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md)
  (task 5, client performance).

## Replaces

Nothing.
