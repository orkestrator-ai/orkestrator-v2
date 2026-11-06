# Design perf: the leak check misreads a two-state listener count

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7` (measured at `b8033daf`, the
0036 branch). Found while rerunning
[0036](0036-design-canvas-qualification.md) tasks 5 and 12 on beelink.

### Tasks

1. **Find what the extra listeners are**: name the event listeners that come and go between the two `jsEventListeners` values the leak check samples. Status: open.
2. **Make the 12-cycle verdict tell a bounded two-state count from growth**: change the check in `e2e/perf/design-canvas-perf.ts` once task 1 says the second state is benign. Status: open (depends on 1).

### 1. Find what the extra listeners are

**Problem.** The client perf harness's leak check
(`leakCycles`, `e2e/perf/design-canvas-perf.ts`) reported "not converged" at
1, 16 and 64 frames in the 2026-11-06 Linux run with the 2026-10-22
parameters (12 cycles × 3 runs, report
`output/benchmarks/design-canvas/2026-11-06T04-48-37-098Z.json`). Every
failure was `jsEventListeners` alone: "grew from 258 to 283" (1 frame),
"309 to 364" (16 frames, two runs) and "354 to 439" (64 frames). Nothing
else moved: window and document listeners, CDP frames, iframes, DOM nodes
and documents were flat, and each run ended on the value it started from.

**Context.** The CDP `JSEventListeners` metric counts every listener in the
page. `memory()` forces garbage collection twice and waits 200 ms before
each sample, so the second value is not uncollected garbage. The check
compares the maximum of the second half of the cycles with the maximum of
the first half, so a second value that happens to land only in the second
half fails the run.

**Investigation.** Observed, not explained:

- The count takes exactly two values per size, on irregular cycles: 224
  (cycle 0 only), then 258 or 283 at 1 frame; 309 or 364 at 16 frames; 354
  or 439 at 64 frames. The gap is 25, 55 and 85. The DOM node count is the
  same in both states (1048, 1238 and 1481).
- In the 100-cycle run (`2026-11-06T04-05-14-034Z.json`, three runs at 1 and
  64 frames) the higher value appeared 7 to 11 times per run, spread over
  the whole run, and the count never went above it (one sample at 64
  frames read 376, between the two). All six runs
  converged because both halves held it. The 2026-11-01 run saw the same
  +25 at 1 frame and recorded it as warm-up.
- Not yet tried: sampling `DOMDebugger.getEventListeners` per node type in
  both states, or sampling twice per cycle to see whether the state follows
  the cycle's last action (tab reactivation or the pan back).

**Decisions.**

- **How to name the listeners?**
  - **Diff `DOMDebugger.getEventListeners` over the page's nodes between a high and a low sample (recommended).**
    - Pros: names the target, type and handler location directly; the
      harness already uses `DOMDebugger` for window and document counts.
    - Cons: a full-node scan is slow at 64 frames, so it must run only on
      the diagnostic path, not in every sample.
  - **Bisect by disabling UI pieces in the fixture (layer tree, toolbar tooltips).**
    - Pros: needs no new CDP code.
    - Cons: slow, and it changes the page being measured.

### 2. Make the 12-cycle verdict tell a bounded two-state count from growth

**Problem.** A verdict that fails on a bounded oscillation makes a short
leak check useless as evidence at every size, and hides a real
`jsEventListeners` leak among the false ones.

**Context.** The 100-cycle runs are the evidence that settles convergence
today (0036 task 12). The 12-cycle runs are the 2026-10-22 parameters that
0036 task 5 compares across hosts.

**Investigation.** Not started; it depends on task 1.

**Decisions.**

- **What to change once the listeners are known to be benign?**
  - **Compare the halves' minimums for `jsEventListeners`, keeping the maximum rule for every other metric (recommended).**
    - Pros: a leak raises the floor and still fails; a count that flips
      between two fixed values passes; other metrics keep the strict rule.
    - Cons: a leak that only adds listeners on some cycles and removes them
      on others would pass. Task 1's answer is what makes this safe.
  - **Remove the cause in the product, if task 1 finds one.**
    - Pros: no change to the check.
    - Cons: only possible if the second state is a real defect.
  - **Run the check longer (100 cycles) by default.**
    - Pros: both states show in both halves, as they did on 2026-11-06.
    - Cons: about 40 minutes a run on this host, and it still depends on
      chance.

## Current state

- `jsEventListeners` is the only metric affected. The harness's other leak
  signals (window and document listeners, CDP frames, iframes, nodes,
  documents, timers, animation frames, blob URLs, renderer processes, heap)
  converged in every 2026-11-06 run.
- Until this is done, read a 12-cycle `jsEventListeners` failure against the
  per-cycle samples in the JSON report: two alternating values with an
  unchanged final value are this case, not a leak.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md)
  tasks 5 and 12, and its 2026-11-06 qualification evidence.
