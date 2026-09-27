# 10 — Schedule bridge packages using measured cost

Status: Retained after post-migration measurement.
Depends on: [07](07-acp-test-layers.md), [09](09-build-and-test-task-graph.md).

## Implementation result

The existing bounded two-package Turbo scheduler was retained. After moving the
bridges to node-only setup, the whole bridge group completed in 107.9 seconds
in a focused run and 95.9 seconds in the final aggregate. This is already at or
below the review's approximately 106-second idealized longest-first lower bound.
A custom dispatcher would add affected-package parsing, process lifecycle and
timing-profile policy for no material demonstrated improvement.

## Goal

Shorten the bridge group's tail without increasing its worker reservation or
changing its test coverage. Re-evaluate after ACP and preload improvements;
the scheduling opportunity in the source review may no longer exist.

## Evidence and initial decision

The reviewed bridge invocation had two slots and started Cursor and Pi first.
ACP began approximately 21 seconds later. ACP took 105.6 seconds; the other
four packages totaled about 101 seconds. Starting ACP immediately could have
reduced that particular group's 126.7-second execution to approximately
106 seconds. This is a model of that run, not a demonstrated speedup.

- [ ] Re-measure all five package durations after steps 06 and 07.
- [ ] Compare current scheduling with a two-slot longest-first schedule using
  those durations. Include package launch overhead and actual selected packages.
- [ ] If the predicted benefit is negligible, or work moved out of ACP makes
  the current scheduler adequately balanced, mark this step Deferred with the
  evidence. Do not add custom orchestration for an obsolete estimate.

## Preferred implementation shape

Preserve the admitted bridge group as the owner of its worker capacity and
child process tree. First verify whether the pinned Turbo version can express
the needed scheduling preference while retaining its existing affected-package
selection, summaries and failure reporting. Do not assume filter order defines
execution order.

If it cannot, the fallback is a small bridge-group dispatcher with a bounded
queue of package jobs. It starts the longest known selected package immediately
and fills the other slot with the next job, starting another when one finishes.
Keep package test scripts as the actual executors. Do not duplicate their
preload, worker or timing flags inside a second test command definition.

Two static lanes, “ACP” and “everything else”, are only acceptable if the new
measurements still justify that balance. If ACP becomes short, such lanes can
be slower than the existing scheduler and should not be adopted.

## Tasks

### 1. Determine the selected package set once

- [ ] Preserve the same five bridge packages for the full suite.
- [ ] For changed-code runs, obtain selection from the same affected package
  graph semantics used previously, using the pinned tool's structured task
  output if a custom dispatcher is required. Do not substitute a hand-written
  changed-path heuristic that misses protocol/shared dependencies.
- [ ] Bound and validate any tool output parsed by the dispatcher. Handle an
  empty affected set explicitly; an unexpectedly empty full set is incomplete
  evidence, not success.
- [ ] Keep provider-specific package scripts and per-worktree timing files.

### 2. Choose a simple cost policy

- [ ] Prefer existing per-package timing information. If aggregating Bun file
  profiles, treat the result as an estimate and account for packages with
  different worker counts rather than comparing incomparable totals.
- [ ] Use a deterministic fallback order for missing, stale, malformed or
  implausible profiles. Missing timing data must never skip a package or
  convert a real test failure into a cached pass.
- [ ] Keep cost inputs bounded to known package IDs and finite durations.
  They must not contain prompts, file contents, tokens or arbitrary commands.
- [ ] Avoid a new mutable shared profile across worktrees. Reuse worktree-local
  ownership, and do not change the immutable shared build-cache policy.

### 3. Preserve capacity and lifecycle semantics

- [ ] Dispatch no more jobs than the bridge group's actually admitted slots.
  If admission clamps the group to one worker, run one package at a time.
- [ ] Give each package its assigned Bun worker count, currently one. Never
  invoke a package alias whose unconstrained parallelism exceeds the reservation.
- [ ] Keep dispatcher children inside the registered process group, or register
  all leaders correctly if the implementation creates separate groups. Cancel
  queued jobs and terminate all running descendants on interrupt/watchdog.
- [ ] Do not acquire another host reservation inside a dispatcher already
  holding the bridge reservation. That can deadlock against its own capacity.
- [ ] Keep output streaming with bounded per-command logs and diagnostic tails.
  If jobs are multiplexed, retain package attribution and byte limits without
  creating an unbounded combined output buffer.
- [ ] Collect every package result even if a sibling fails. Preserve stable
  reporting order, signals/nonzero status, and infrastructure-error distinction.
- [ ] Maintain the aggregate/cooperative heartbeat, HEAD checks and scheduler
  coverage semantics used by background Multi Review validation.

## Validation

Use injected scheduling jobs with deterministic durations to check policy;
there is no need to add seconds of sleeps to scheduler unit tests. Cover:

| Scenario | Required result |
| --- | --- |
| Five known costs, two slots | Longest job starts immediately; no more than two active |
| One admitted slot | Same selected jobs run sequentially |
| Missing or invalid cost profile | Deterministic fallback; all jobs still execute |
| Only one affected bridge | Only that bridge executes |
| Shared protocol change | All graph-affected bridge owners are selected |
| Package assertion failure | Siblings finish; aggregate fails with package attribution |
| Spawn failure or interrupted child | Incomplete/failure evidence, never a fabricated pass |
| Cancellation while jobs queued | Queued jobs never start; running process trees drain |
| All jobs complete | Reservations release and no worker/child remains |

Retain real process-tree interrupt tests in the runner suite; a simulated queue
cannot prove OS cleanup. Run focused runner, scheduler and wiring suites, then
one full bridge execution and the default aggregate under ordinary capacity.

## Completion and rollback

- [ ] The exact same full/affected selected packages execute once.
- [ ] Real bridge-group execution improves beyond normal sample variation.
- [ ] Aggregate performance and contention do not regress materially.
- [ ] Worker, memory, cleanup, log and heartbeat invariants remain intact.
- [ ] Complexity is justified by the remaining benefit after earlier steps.

Rollback restores the original bridge group command and matching wiring tests;
it must not undo test-layer improvements from step 07. If the custom dispatcher
would require substantial duplicated scheduling infrastructure, defer this step
and retain Turbo's existing orchestration.
