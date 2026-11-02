# Design frame bridges and frames grow under culling at 64 frames

Found on 2026-11-01 against `main` at `93b99bfb` (web code `95093c16`) by the
Linux run of the client performance harness; see
[0036 → Client performance on Linux](0036-design-canvas-qualification.md#client-performance-on-linux).

## Task analysis

Analysed 2026-11-01. Rechecked 2026-11-02 against main at 38d55ee14: the
constructor still added the listener, so the hypothesis still applied.

### Tasks

1. **Confirm or rule out a retained frame per culling cycle at 64 frames.** Status: done (confirmed by a component test, 2026-11-02).
2. **Fix it if confirmed, and make the harness's leak check fail on it.** Status: done in code and unit tests; the 100-cycle harness rerun at 64 frames is still open (see Needs verification).

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
never opened. The harness rerun has not been done yet (see Needs
verification).

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

- The harness rerun under Needs verification.

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

- Rerun `mise exec -- bun e2e/perf/design-canvas-perf.ts --frames 1,64
  --cycles 100 --skip-library` and check that `windowListeners` and
  `cdpFrames` settle at 64 frames. It was not run on 2026-11-02. The original
  growth showed up only on a busy host, so a converging run on a quiet host
  proves less than the component test does.
- Run the same check on the M5 Max at current `main`. This was the analysis's
  second next step and is still open.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md)
  (task 5, client performance).

## Replaces

Nothing.
