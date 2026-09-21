# 11 — Validate assurance, performance and operational behavior

Status: Implemented and validated locally; pending review and integration.
Depends on: steps 02–10 implemented or explicitly resolved as retained with
evidence.

## Implementation result

Focused validation has passed for ownership/runner wiring, the repeated gateway
case, both settings suites, merge/indicator consolidation, all bridge packages,
the validation worker, ActionBar, both native-agent files and PersistentTerminal.
Frozen root and standalone Claude installs passed without lockfile drift. Turbo
dry-run output confirmed the intended package dependency graph. `mise run
check` passed formatting, lint and all 11 package typechecks. The authoritative
`mise run test` completed successfully in 283.3 seconds: workspace 283.3
seconds, root 104.4 seconds, bridges 95.9 seconds and the protocol lockfile
check 0.5 seconds. The result proves the retained build and test closure passes;
timing should still be compared under similar host and cache conditions.

## Goal

Demonstrate that the final suite is faster for relevant workflows, still checks
the intended contracts, and behaves correctly under ordinary multi-worktree
load. Publish a result that distinguishes measured benefit from estimated or
deferred opportunities.

This final gate complements the owning/static/full validation required at each
implementation handoff. It does not authorize accumulating unverified changes
until the end.

## 1. Reconcile coverage and selection

- [ ] Re-run the inventory from step 01 against the final tree.
- [ ] Compare full selected files and expanded cases with the baseline. Explain
  each decrease as a reviewed duplicate removal, moved owner, changed grouping
  or compiler migration. Explain each addition, including newly owned files.
- [ ] Verify every compiler-only contract appears in an actually invoked
  TypeScript configuration and can fail the static gate.
- [ ] Review the old-to-retained-case mappings from steps 05 and 07. Spot-check
  actual assertions and production boundaries, not only the mapping text.
- [ ] Verify no new skips, automatic retries, early returns, blanket catches or
  widened tolerances hide behavior that used to be tested.
- [ ] Confirm full discovery still excludes E2E and intentional failure
  fixtures, while their explicit owner commands remain usable.

## 2. Review the reliability contracts explicitly

| Contract | Required retained evidence |
| --- | --- |
| Inactive environment | Work progresses while UI is inactive; remount recovers authoritative state |
| Missed events | Revision/generation/cursor gaps cause catch-up rather than silent loss |
| SSE replay | Subscribe-before-replay and connected cursor semantics remain covered |
| Dispatch | Ambiguous delivery cannot auto-retry; parked request/session recovery stays explicit |
| Approvals | Timeout, disconnect, malformed answers and generation death fail closed |
| Background lifetime | Unmount does not cancel backend work; explicit stop still does |
| Terminal output | Bounded backpressure signals desync and exact snapshot recovery |
| Resource bounds | Queue, payload, replay and output limits retain boundary and failure cases |
| SDK transport | Real rejected-abort/disposal regression still exercises the vendor client |
| Packaged runtime | Backend and CLI artifacts build, restore and run from their intended package context |
| Runner lifecycle | Cancellation/watchdogs clean descendants; no incomplete work is reported passed |
| Settings lifecycle | Unmount flushes pending valid edits once; timer conversion does not discard them |

Do not require a new test for every row if existing tests already prove it.
Identify the retained owner and inspect whether the change touched its
assumptions. Use a small number of targeted fault probes for rewritten timing,
layering and compiler contracts; restore all probe changes before final checks.

## 3. Execute the required workflows

Use the current documented commands after all runner changes. The following
repository-level commands already exist and must retain their meanings:

```bash
mise run test:changed

mise run test:logged -- --name streamlining-final-check -- mise run check

mise run test
```

- [ ] Run owning timer, preload, ACP, worker and runner tests at their normal
  configured isolation levels before the full gate.
- [ ] For runner/preload/build changes, exercise both warm and cold-enough
  conditions, including fresh-worktree artifact restoration.
- [ ] Run relevant browser tests if a changed harness or production seam affects
  browser timing, rendering, interaction or recovery behavior.
- [ ] Run the existing isolated-stack inactive-environment cycle for any changed
  product/background lifecycle seam: start work, switch away, allow progress or
  a pending prompt, return, and verify transcript, status, prompts and controls.
- [ ] Add Electron or Docker agent validation when actual runtime/fixture
  behavior in those environments changed. Do not require live provider billing
  or credentials for a test-only refactor that does not touch those boundaries.
- [ ] Check the runner's iOS-last behavior with its existing injected tests on
  Linux. Run `test:all` on a Mac with Xcode for release/iOS-sensitive changes;
  record unavailable platform validation accurately.

If a suite fails, preserve the failed result and artifact. Reproduce with the
owning file, use the existing flake workflow and distinguish assertion failure
from timeout, spawn failure or missing infrastructure. A later isolated pass
does not change the original aggregate result.

## 4. Compare performance under controlled conditions

### Quiet warm comparison

- [ ] Use the same host, pinned runtime, worker budget and relevant environment
  on baseline and candidate, with no concurrent known test workload.
- [ ] Warm required builds and establish comparable learned timing profiles.
  Record those preparation runs separately from the comparison sample.
- [ ] Collect three measured complete runs for each version, alternating base
  and candidate where feasible. Report each result and the median/range; do not
  calculate a convincing-looking p95 from three samples.
- [ ] Do not exclude failed runs from reliability reporting. If an unrelated
  failure prevents a comparable timing sample, explain it and replace the
  sample explicitly rather than silently dropping it.

### Build-cache-miss comparison

- [ ] Use at least one controlled comparable cache-miss run for each graph.
  Preserve dependency-install state and identify exactly which builds missed.
- [ ] Keep experimental cache cleanup scoped to a disposable benchmark area.
  Do not disable shared worktree caching in the production runner.
- [ ] Report time to source feedback separately from full required completion.
  More overlap is useful even when the same compilation CPU work remains.

### Normal contention and small-host behavior

- [ ] Run two cooperating worktree validations using the existing host queue.
  Report per-command queue/execution intervals and time until both finish.
- [ ] Confirm UI responsiveness, memory pressure, swap behavior and child
  cleanup; do not adopt a CPU-utilization increase as proof of safe capacity.
- [ ] Exercise one-slot/small-host planning with deterministic runner tests and
  a bounded runtime observation where practical. Do not change the frozen
  capacity of another user's active queue.
- [ ] Cancel a queued run and a running run in an isolated validation exercise.
  Confirm tickets, child process groups and background validation state settle.

These repetitions are a bounded acceptance experiment, not a new normal
requirement to execute every suite three times per handoff. Expand only when
variance, failures or a specific unresolved hypothesis warrants it.

## 5. Report results without overstating them

Use this comparison table, filled with real data:

| Metric | Baseline | Candidate | Interpretation |
| --- | --- | --- | --- |
| Quiet warm full run, median/range | To measure | To measure | Same required coverage and worker plan |
| Cache-miss full completion | To measure | To measure | Exact build misses listed |
| First source-test feedback | To measure | To measure | Distinct from full assurance |
| Settings file time | To measure | To measure | Controlled time benefit |
| Terminal/native file time | To measure | To measure | Timing families converted listed |
| ACP execution and process count | To measure | To measure | Direct/retained integration split |
| Worker control process count | To measure | To measure | Observation optimization only |
| Peak process-tree memory | To measure | To measure | Measurement method stated |
| Two-worktree completion | To measure | To measure | Queue and execution reported separately |
| Failures/skips/incomplete results | To measure | To measure | Every changed outcome explained |

Adopt a runtime optimization only when its improvement is repeatable and larger
than ordinary observation noise, with no unexplained assurance or reliability
loss. Small ownership cleanups may be worthwhile without material speed gains;
label them accordingly. Do not impose a fixed millisecond threshold in normal
CI based on this workstation's results.

## 6. Documentation, handoff and rollback

- [ ] Update `docs/development/testing-guide.md` for actual selection, preloads,
  graph, profiles and commands. Keep its current caching/concurrency caveats.
- [ ] Update the documentation catalog when the plans/results become active
  repository documentation, and link the implementation results from the
  source review without rewriting the original failed measurement as a pass.
- [ ] Update the flake registry for resolved or newly observed cases, retaining
  their historical evidence and exact commands.
- [ ] Mark each plan Complete, Retained or Deferred with a concise rationale.
  Do not mark benchmark targets achieved merely because code was merged.
- [ ] Prepare PR descriptions around final behavior, required checks and actual
  measured benefits. State missing platform evidence and unresolved limitations.
- [ ] Keep separate rollback boundaries for clocks, coverage consolidation,
  preloads, fixtures, task graph and package scheduling. Reverting an optimization
  must not silently discard newly added discovery ownership.
- [ ] Verify branch and configured upstream before any explicitly authorized
  push. Leave merging to a human maintainer under repository policy.

## Final completion criteria

The implementation is complete when the final selected/compiled coverage is
accounted for, required workflows pass, delivered optimizations have credible
performance evidence, and intentionally retained/deferred candidates are listed
with their rationale. If a required workflow cannot be completed, provide a
partial handoff identifying that gap and leave its acceptance item unfinished.
An incomplete required gate prevents claiming full validation; it does not
disappear because another suite ran faster.

The final user-facing summary should name the largest measured gains, total
workflow change under stated conditions, important coverage preserved, and
anything deferred. Report test-count reduction only alongside its retained
behavioral owners.
