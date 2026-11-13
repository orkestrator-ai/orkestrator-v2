# Design perf: a transient extra CDP frame fails the 12-cycle leak check

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544` (measured on branch commit `2519cfecf`, which retired to-do 7440). Found on beelink2 (Linux) while verifying 7440's fix.

### Tasks

1. **Find what the extra CDP frame is**: name the frame that `Performance.getMetrics` `Frames` counts on some samples and not others. Status: open.
2. **Decide whether the check should tolerate it**: change `cdpFrames` in `leakCycles` only if task 1 shows it is a bounded transient. Status: open (depends on 1).

### 1. Find what the extra CDP frame is

**Problem.** The client perf harness's 12-cycle leak check (`leakCycles`, `e2e/perf/design-canvas-perf.ts`) reported "cdpFrames grew from 9 to 10" for run 2 at 16 frames in a run with the 2026-10-22 parameters (report `output/benchmarks/design-canvas/2026-11-11T14-38-55-863Z.json` on beelink2, not committed). The samples read 10, 9 ×8, 10, 9, 10, 9: cycle 0 and two late cycles read 10, and the run ended on 9. Live iframes (8), window listeners (32) and DOM nodes (1266) were flat. The other eight runs (1, 16 and 64 frames) converged.

**Context.** `Frames` is the renderer's frame count: the main frame plus the live sandboxed design iframes (out of process), so 9 at rest with 8 iframes. Before 2140 (deleted 2026-11-06) the same signal grew without bound at 64 frames; that fix holds (64 frames converged in all three runs here). The host was heavily loaded during this run (load average 40 to 58 from other workers), and each cycle culls and recreates every iframe 1.5 s before the sample. The 2026-11-06 Linux runs saw `cdpFrames` flat. `jsEventListeners` behaves the same way for a different reason (counted objects pending finalization); see [`design-canvas.md` → Tests](../../architecture/design-canvas.md#tests).

**Investigation.** One observation only; not reproduced. A frame whose teardown has not finished 1.5 s after the cull (its `RemoteFrame` is held by Blink until the browser confirms the detach, which a heap snapshot on 2026-11-11 showed for six frames at a `jsEventListeners` high reading) would explain a 10 that ends at 9, but nothing here shows it is that frame. Not yet tried: reading `Page.getFrameTree` at a 10 sample, and rerunning on a quiet host.

**Decisions.**

- **How to identify it?**
  - **Record `Page.getFrameTree` (frame ids and URLs reduced to scheme) beside each sample under `--listener-census`, and rerun on a quiet host (recommended).**
    - Pros: names the extra frame directly; reuses the existing diagnostic flag, so measured runs are unchanged.
    - Cons: needs several runs, since it appeared once in nine.
  - **Wait longer before each sample.**
    - Pros: one-line change.
    - Cons: hides the question instead of answering it, and makes every run slower.

### 2. Decide whether the check should tolerate it

**Problem.** A check that fails on a frame that is only late to detach is weak evidence, but loosening it could hide the 2140 kind of growth.

**Context.** 2140's growth raised the count every cycle; a floor rule like `jsEventListeners`' would still catch that.

**Investigation.** Not started; it depends on task 1.

**Decisions.**

- **What to change if task 1 shows a frame still detaching?**
  - **Compare the halves' minimums for `cdpFrames` too, as for `jsEventListeners` (recommended).**
    - Pros: steady growth raises the floor and still fails; a late detach passes.
    - Cons: growth that is undone on alternate cycles would pass.
  - **Keep the strict rule and sample later after the cull.**
    - Pros: the check stays strict.
    - Cons: longer runs; a slow host can still miss the deadline.

## Related

- To-do 7440 (retired 2026-11-11; `git show 14df96544:docs/todo/design-canvas/7440-design-perf-listener-count-two-states.md`): the `jsEventListeners` two-state reading, explained in [`design-canvas.md` → Tests](../../architecture/design-canvas.md#tests).
- 0036 (retired 2026-11-13) tasks 5 and 12, summarised in [`design-canvas.md` → Qualification](../../architecture/design-canvas.md#qualification); the to-do is in Git history at `f2c4cee71`.
