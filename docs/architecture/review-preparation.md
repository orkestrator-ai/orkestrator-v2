# Multi-review preparation

Status: Living — multi-review pipeline; queue wait is 30 minutes.

Manual multi-review and pipeline review preparation use the same three stages:

1. An agent commits the relevant safe changes and discovers a validation plan.
2. An environment-owned worker executes that plan and captures evidence.
3. The backend seals one package, then gives every reviewer its reference.

The agent is no longer responsible for waiting on commands, ingesting their
output, calculating exit codes, or assembling the evidence package. Pipeline
implementation and fix prompts request focused development checks; the following
preparation stage owns the final full validation pass.

## Fresh discovery for arbitrary repositories

There is deliberately no cross-round command-plan or result cache. Each round
examines the current instructions, tree, changes, CI, manifests, task definitions,
scripts, and toolchain. The prompt assumes no language or package manager and
does not use a fixed list of configuration filenames as a freshness heuristic.
An explicit preparation retry also discovers a new plan.

The plan identifies the exact committed HEAD, commands, relative working
directories, prerequisites, exclusive resources, weights, timeouts, and coverage
limitations. Runtime validation bounds the plan to 32 commands and 24,000 UTF-8
bytes. Dependencies must refer to earlier commands, so cycles are rejected.
Missing prerequisites are limitations, not implicit permission to install tools.

The worker uses Orkestrator's Bun runtime and Bash, including inside Docker; the
reviewed repository needs neither a JavaScript manifest nor application code to
host the worker. Project commands still need their own declared tools installed.

## Execution and parallelism

### OpenCode submission-tool ownership

OpenCode's workflow-result MCP connection is warmed up before dispatch, but
temporary permissions are granted only immediately before the prompt. The
broker verifies a `connected` MCP status (HTTP success alone is insufficient),
persists the owning request in session metadata, and reads the permission grant
back before dispatching. Each turn exposes only its selected submission tool
and the validation/status helpers; ordinary turns deny the workflow tools.

Status readers, including a review tab inspecting a session through a separate
provider, never restore permissions. Backend workflow owners settle by request
ID under the same per-session lock as dispatch. Cleanup requires a terminal
assistant response belonging to that request, not an idle status alone: an
accepted asynchronous prompt may not have appeared yet. A stale cleanup cannot
revoke a newer turn, and provider recreation recovers ownership from metadata.
Explicit abort also retires the owned grant. No renderer or live event is
required for completion or cleanup.

The opt-in OpenCode compatibility suite exercises the real server against a
local mock model and authenticated result store, including an idle observer
between grant and prompt, successful submission, and provider recreation.

### Validation commands

Commands with satisfied prerequisites can overlap. The initial concurrency
budget is two: weight-one commands can run together, while internally parallel
or memory-heavy commands use weight two. Overlapping resource names serialize;
`*` reserves the runner exclusively. Discovery must explicitly assess parallel
safety rather than infer it from a command's name.

A failed prerequisite skips its dependants with an explicit reason. Independent
checks continue, preserving useful evidence from a failing suite. Command
timeouts range from one second to two hours. Cancellation, timeout, and output
overflow terminate the command's process group. A worker-death watchdog also
terminates its command groups. Intentionally detached commands are unsupported.

Each workspace has one validation lock, preventing separate review jobs from
interfering. Waiting for another job is bounded by
`ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS` (default 30 minutes). Backend or UI
restarts reconnect to the existing run rather than launching duplicate commands.
An uncertain/stale worker is reported as an error and requires explicit recovery;
it is never treated as evidence that a command did not run.

## Evidence and sealing

The worker streams stdout and stderr directly into private files under
`.orkestrator/review-artifacts/<run-id>/`. Captures are bounded to 32 MiB per
stream and 256 MiB per run. Exceeding a bound fails that check and records that
the evidence is incomplete. Raw output does not return in control responses or
enter the preparation agent's context.

Durable result metadata records actual exit status, duration, byte counts,
artifact paths, and SHA-256 digests. Files become read-only when closed. Clean
Git status and HEAD are checked before and after execution; a changed snapshot
cannot be certified. Package generation checks the expected HEAD again and
verifies captured artifact hashes.

The sealed manifest contains the plan and validation metadata alongside the
existing diff and review context. Reviewers share its immutable package
reference. Integrity verification checks both the manifest and hashed logs.
Reviewer prompts request summaries first, targeted reads of failure evidence,
and no duplicate full validation pass. Large successful logs are not injected
into reviewer prompts. Read-only files and hashes detect accidental changes;
they are not a security sandbox against a malicious project command.

## Lifecycle and visibility

The header's restart control selects the work currently in progress. During a
build or fix it restarts the implementation turn, during validation it restarts
the test run, and during a dedicated package-preparation turn it rediscovers the
validation plan. A cancelled validation run or pending review retry also routes
to preparation. The older backend command `retry_build_pipeline_review` remains
available to existing command clients: it explicitly discards the current review
package and report and starts a fresh review attempt, even when the pipeline is
paused or failed. The renderer does not call that command, and the public
`orkestrator` CLI does not expose it.

Authoritative worker state lives in an atomically replaced, size-bounded state
file with a heartbeat. Workflow snapshots project that state to both review UIs.
Switching tabs/environments or unmounting a component does not cancel validation.
Explicit cancellation, pipeline pause, and environment stop/delete drain active
workers. A persistent cancellation marker prevents delayed launch requests from
starting a cancelled run.

The UI shows per-command status and duration, limitations, and separate discovery
and snapshot, validation, and packaging timings. Progress remains recoverable
after reload. Legacy in-flight preparation results and older packages without
log hashes remain readable during upgrades.

## Auto-fix and auto-PR

`autoFix` and `autoPr` are fixed on the workflow at launch. The launch dialog
opens its two checkboxes on the saved app-level settings. Coordinator launches
(`launch_multi_review`, `start_multi_review`) take the same saved values unless
the call sets them, and a requested `autoPr: true` turns an omitted `autoFix` on
(`multiReviewAutomation` in `coordinator-launch-defaults.ts`). Both paths then
run the same `MultiReviewService` code:

| Step | Durable record | Recovery after restart |
| --- | --- | --- |
| Consolidation with findings and `autoFix` | report saved with `phase: interactive`, `addressPromptPending` (`queueDefaultFix`); no `ready` | The supervisor delivers the pending handoff under its reserved request id; failed attempts persist and fail the review after three |
| Consolidation with nothing to fix and `autoPr` | report saved with `phase: ready` and `autoPrLaunch: { basis: clean-review, state: pending }` in one save (`queueCleanReviewAutoPr`); no Fix | The supervisor launches the PR as below while the review is still `ready` on that clean report |
| Fix runs in its ordinary interactive tab | `fixSession` observed `running` | Observation resumes from the provider session |
| Fix turn finished on its own, `autoPr` | `fixSession.status: idle` and `autoPrLaunch: pending` in one save (`queueAutoPr`) | The supervisor retries the launch under `multi-review-pr:<id>`, which the native-agent layer deduplicates |
| PR session | `autoPrLaunch: launched` with its tab, or `failed` after three attempts | A launched PR is never repeated |

Only proof that a Fix completed, or a clean report, queues the PR: a complete
structured result, an interactive handoff turn that finished on its own as its
conversation's last turn, or a consolidated report with no issues and no
coverage gaps. A clean report needs no Fix, so with `autoPr` on it goes
straight to the PR whatever `autoFix` says, for button, coordinator and every
other launch alike. Its intent is marked `basis: clean-review` and is
delivered only while the review is still `ready` on that report; starting a
Fix first drops it, and a review that moved on records `skipped`. A Fix that fails, is stopped, is superseded or cannot be confirmed
records `skipped` with its reason, or nothing when the session failed. The
review stops there. A custom Fix never starts a PR, and a new Fix drops an
undelivered PR intent so the PR cannot race it. Every PR intent records the
Fix attempt that authorized it (`autoPrLaunch.fixIdentity`). Status notices and
`get_multi_review` therefore never present an earlier PR as the outcome of a
later Fix; that Fix's changes need a manual PR update. `autoPr` without `autoFix`
means a PR after a Fix the user (or `address_multi_review`) starts. The PR
session pushes the branch and opens the pull request; nothing merges.

## Performance boundary and verification

Without reusing earlier results, preparation cannot finish before its required
commands finish. This design removes agent round trips and log processing from
execution, avoids the pipeline's duplicate final pass, and overlaps safe work.
Its target is discovery plus the command dependency critical path plus small
sealing overhead. Discovery latency still depends on the selected agent and
repository; no fixed speedup is assumed.

Real-process worker tests cover overlapping commands, resource exclusion,
dependency failures, idempotent launch/reconnect, cancellation, timeout, output
bounds, snapshot changes, and same-size artifact replacement. Controller tests
cover manual and pipeline handoff and controller replacement. Service tests
exercise the backend command path, sealing, integrity, and environment cleanup.
The browser gateway suite includes a real-worker test that switches environments,
lets validation finish, reloads, and reads the same completed snapshot.

## Fan-out budgets and benchmark

After sealing, `ReviewFanoutRunner`
([`review-fanout.ts`](../../apps/backend/src/core/review-fanout.ts)) hands the
package to every reviewer, for standalone Multi Review and Build Pipeline review
stages alike. The cost of that control plane (admission, observation,
persistence, evidence verification, consolidation input) is bounded
independently of panel size, up to the 32-reviewer maximum:

| Dimension | Budget | Owner |
| --- | --- | --- |
| Concurrent session setups | 4 (`DEFAULT_REVIEW_ADMISSION_CONCURRENCY`) | `review-fanout-scheduler.ts` |
| Concurrent observations | 8 (`DEFAULT_REVIEW_OBSERVATION_CONCURRENCY`) | `review-fanout-scheduler.ts` |
| Concurrent work per provider | 4 (`DEFAULT_REVIEW_PROVIDER_CONCURRENCY`) | `review-fanout-scheduler.ts` |
| Any configured cap | Clamped to 16 (`MAX_REVIEW_FANOUT_CONCURRENCY`) | `review-fanout-scheduler.ts` |
| Evidence verifications | 2 per evidence generation: before admission and before consolidation | `review-evidence-permits.ts` |
| Provider transcript reads | At most one progress read per live reviewer per 60 s; none on other passes | `multi-review-progress.ts`, `review-fanout-transcript.ts` |
| Observational writes | At most one workflow write per pass, for any panel size | `ReviewFanoutRunner.stageObservation` |
| Controller fence checks | One committed row read each, with no lease, whatever the panel size or retained review history; four per running reviewer per pass, plus one (and one per pending request) on providers that report interactions | `StorageReviews.validateMultiReviewController` |
| Multi Review store work per running pass | No whole-store read; two lease acquisitions (the controller claim and the observational flush) at any panel size | `storage-reviews.ts` |
| Running-reviewer observation | Next pass 3 s after the previous one finishes, plus up to 1 s stable per-workflow jitter; admission, dispatch and consolidation work runs at 1 s | `multi-review-service.ts` |
| Accepted report | 1 MiB, 100 issues, 16 KiB per prose field | `packages/protocol/src/structured-review/budgets.ts` |
| Consolidation input | 640 KiB with every source ID kept; overflow fails before dispatch | `review-consolidation-evidence.ts` |
| Reviewer-tab transcript snapshot | 500 messages and 2 MiB; unchanged polls carry no messages | `multi-review-reviewer-transcript.ts` |
| Flow graph step-session tail (preparation, consolidation, Fix) | 100 messages and 256 KiB; unchanged polls carry no messages; polled only while the step is live and visible | `multi-review-step-transcript.ts` |
| Provisional findings (`report_finding`) | 50 per reviewer, 16 KiB each, so together under one report's budget; staged in memory and written with the pass's observations | `review-provisional-findings.ts` |
| Admission queue position | No write of its own: rides on the pass's safety commits and observational flush | `review-fanout-admission.ts` |

Why these values:

- **640 KiB consolidation input** is roughly 160k tokens at four bytes per
  token, leaving room for instructions and output inside a 200k-token context.
  A synthetic 32-reviewer panel with six issues per report uses about 82% of it.
- **1 MiB per report, 16 KiB per prose field, 100 issues** sit far above a
  typical report (about 18 KiB with six issues), so they reject only runaway
  output. They apply only to answers accepted in the fan-out, never to stored
  reports or other review features; violations go through the bounded repair
  path.
- **Caps of 4/8/4/16.** Four overlapping setups remove most of the serial cost
  for the common two- to eight-reviewer panels without a 32-process burst.
  Admission therefore takes ceil(reviewers / 4) setup waves, and one slow
  reviewer does not delay its peers.
- **3 s running cadence.** Reviews take minutes; 3 s keeps the tab fresh while
  cutting provider status traffic by at least two thirds compared with 1 s.
- **Fence checks read one row.** A running reviewer is fenced four or five
  times a pass, so a fence check must not grow with the panel or with retained
  history. When each check instead took the store's lease and parsed every
  retained workflow (2026-10-15, after the SQLite move), a 32-reviewer running
  pass made 128 checks, 130 lease acquisitions and 132 whole-store parses, and
  50 retained finished 8-reviewer workflows (about 8 MiB) made a running pass
  about 25 times slower.

[`multi-review-efficiency.bench.test.ts`](../../apps/backend/src/core/multi-review-efficiency.bench.test.ts)
measures this with fake providers, a temporary store and synthetic reports
(`multi-review-efficiency-fixtures.ts`) for 1, 2, 4, 8, 16 and 32 reviewers,
an 8-reviewer panel over 50 retained finished workflows, a two-provider panel
and one slow reviewer. It counts only through the fake provider, the command
invoker and storage and database spies, so the same file can run against an
older build of the SQLite store. Its numbers are control-plane work, not model
latency, tokens or cost. The default run asserts two verifications per
generation, transcript reads bounded by reviewer count, at most one save per
running pass, no whole-store read and at most two Multi Review lease
acquisitions per running pass (unchanged by retained history),
`min(reviewers, 4)` concurrent setups, and that a slow setup does not
serialise the panel: the other three reviewers are dispatched while it is still
being created, checked by ordering rather than elapsed time. Separate storage
probes count the actual SQLite rows and serialized bytes fetched with zero and
50 retained workflows. They check a cold reader and a reader invalidated by
another backend, so a keyed API cannot hide a whole-store cache load. To record
the result table:

```bash
MULTI_REVIEW_BENCH_OUT=/tmp/multi-review-bench.json \
  mise run test:logged -- --name multi-review-bench -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/multi-review-efficiency.bench.test.ts --parallel=1
```

Add `MULTI_REVIEW_BENCH_REPORT_ONLY=1` to measure an older build without the
assertions. The remaining budgets are asserted by focused tests:
`review-fanout-efficiency.test.ts` (transcript reads, writes per pass,
admission, isolation), `multi-review-service-efficiency.test.ts` and
`multi-review-reviewer-transcript.test.ts` (reviewer-tab snapshots),
`storage-multi-review.test.ts` and `storage-looped-review-controller.test.ts`
(fence checks read one row without the lease),
`structured-review/budgets.test.ts` (reports) and
`review-consolidation-evidence.test.ts` (consolidation input). Open
scale and cost work is in
[0027-multi-review-scale-and-cost.md](../todo/coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).
