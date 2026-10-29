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

Later pipeline stages read that evidence rather than repeating it. Address runs
targeted checks for the files it edits. It also owns failure triage: it fixes
recorded failures that relate to the ticket or the branch, and reproduces any
it believes are unrelated on the target branch. It ends by submitting a typed
fix result ([below](#the-address--verify-handoff)). Verify is a quick
acceptance review of the diff, read alongside the recorded package and that
result. It runs no suite, typecheck, lint or build, never builds or tests the
target branch, and creates no worktrees. A recorded failure in code the branch
changes blocks it unless the diff shows a repair; that sends the round to Fix,
which does the reproducing. Verify runs one narrow check only when an acceptance
criterion cannot be judged by reading the code.

## The Address → Verify handoff

Address is a typed stage like Review and Verify. Its turn opens a `fix-result`
workflow result slot, the same kind Multi Review's fix step submits
(`build-pipeline-context.ts` `workflowResultKind`), over the tool transport
(`submit_fix_result`) or, where the rollout keeps it off, the provider-enforced
schema. The prompt (`addressValidationInstruction`) says what goes where:
`summary`, `filesChanged`, `commandsRun` with each check's result, the repairs
and their commits in `notes`, and every finding left unaddressed and every
excused failure, with its target-branch reproduction or environmental evidence,
in `limitations`. The contract's own rule holds: `complete` is true only when
no check still fails and `limitations` is empty.

- **Missing or malformed.** A turn that ends without an accepted result gets
  the stage's one reminder and then fails the stage, as Review and Verify do
  (`awaitStructuredResult`, `remindMissingStageResult`). A structured-output
  result the contract rejects fails the stage with the contract's error. The
  tool rejects it at submit time instead, so the model corrects it in its turn.
- **Accepted.** `finishAddress` (`build-pipeline-service-recovery.ts`) copies
  the result onto the Address session as `fixResult`, bounded by
  `PIPELINE_FIX_RESULT_LIMITS` (`packages/protocol/src/build-pipeline-address-report.ts`:
  4,000-character summary, 48 files, 20 checks with failed checks kept first,
  10 notes, 10 limitations, cut entries counted in `omitted`), opens Verify and
  consumes the slot. An incomplete result (`complete: false`) still goes to
  Verify, which judges the round.
- **Verify reads it** (`verificationAddressReport` in
  `build-pipeline-address-report.ts`) as an untrusted JSON evidence frame
  (`<address-fix-result-json>`, framed by `ADDRESS_FIX_RESULT_FRAME_INSTRUCTION`
  from `review-evidence-frames.ts`), as another agent's claim to check against
  the diff. Only this round's live Address session after its latest review
  counts. A round whose clean review went straight to Verify, or whose Address
  was skipped or never had a result accepted, has no report and Verify says so.
- **Older sessions.** `addressReportKind: "fix-result"` on the session is the
  recorded marker of a typed Address turn. An Address session without it was
  started before the typed handoff (or by a path with no result transport): it
  advances to Verify on idle as before, a resume sends it no result slot, and
  Verify reads its last assistant text, at most 16,000 characters, as it always
  did. That fallback is a counted compatibility path
  (`build-pipeline.address-text-report`,
  [version compatibility](version-compatibility.md#register)).
- **Downgrade.** An older backend ignores `addressReportKind` and `fixResult`
  and advances an idle Address session to Verify without reading the result. A
  pending tool-mode Address dispatch it cannot bind fails the stage with "lost
  its result-slot binding", which a retry restarts.

The pipeline inspector shows an Address session's report above its transcript
(`PipelineAddressReport.tsx`).

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

## Read-only reviewers and the Git guard

Reviewers read the sealed package, never write. Multi Review and the Build
Pipeline run them the same way: when a package exists, every reviewer session
is created and prompted in provider plan mode with `readOnly: true` (the
fan-out host's `reviewerMode: "plan"`; for a single pipeline reviewer,
`startStage` and every redispatch of its session, including repairs, reminders
and user messages). OpenCode reviewers also get the constrained reviewer shell.
Consolidation is a report-only turn and is read-only too. How strongly
read-only is enforced depends on the provider: Claude (with its OS sandbox)
and Codex enforce it, OpenCode and Cursor configure it, Grok treats it as
advice.

The Build Pipeline backs this with a read-only Git guard on every provider
(`workspace-read-only-guard.ts`, applied by `build-pipeline-read-only-guard.ts`
to Review, consolidation and Verify):

- **Before dispatch** the backend records HEAD and the Git-visible
  uncommitted paths through `get_environment_uncommitted_paths`, the same
  probe for local worktrees and containers. A single reviewer keeps the
  baseline on its session (the `validation*AtStart` fields Verify already
  used); a panel keeps one on `reviewFanout.workspaceBaseline` for all its
  reviewers and the consolidator, taken before the first reviewer starts. A
  state the backend cannot observe fails the stage before any session exists.
- **At submit time** an acceptance check on `review-report`,
  `consolidated-review` and `verification-result` refuses a result with a
  correctable `worktree_changed` error that names the moved HEAD or the paths,
  so the agent can put the tree back and submit again within its turn. A
  refusal spends no correction budget.
- **When the result is consumed** the pipeline compares again: a single
  review before its report is routed, a panel whenever a reviewer report
  arrives and again before the consolidated report is accepted. A change
  fails the stage with the paths or HEAD in the error. Nothing is reset; the
  worktree is the evidence.

Scope is Git's: ignored files, `.git` internals, paths outside the worktree
and edits to a path that was already uncommitted are invisible. Guards detect;
they do not prevent. Review sessions and panel passes recorded before the
guard existed carry no baseline and are not certified.

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
| Evidence verifications | 2 per evidence generation: before admission and before consolidation. Each hashes the package and every validation artifact it references (at most 32 MiB per stream); `evidence.verify` reports both as `bytes` and the artifact count as `count` | `review-evidence-permits.ts`, `review-validation-artifacts.ts` |
| Provider transcript reads | At most one progress read per live reviewer per 60 s; none on other passes | `multi-review-progress.ts`, `review-fanout-transcript.ts` |
| Observational writes | At most one workflow write per pass, for any panel size | `ReviewFanoutRunner.stageObservation` |
| Controller fence checks | One committed row read each, with no lease, whatever the panel size or retained review history; four per running reviewer per pass, plus one (and one per pending request) on providers that report interactions | `ReviewsRepository.validateMultiReviewController` |
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
assertions.

That benchmark fakes verification, so it counts verifications but not what
one costs. The opt-in
[`multi-review-large-evidence.bench.test.ts`](../../apps/backend/src/core/multi-review-large-evidence.bench.test.ts)
writes validation artifacts totalling `ORKESTRATOR_MULTI_REVIEW_LARGE_EVIDENCE_MIB`
MiB into a temporary local worktree (32 MiB per artifact), verifies them twice
with real streamed SHA-256 as one evidence generation does, checks that one
changed byte fails, and bounds peak RSS growth. It is skipped without the
variable:

```bash
ORKESTRATOR_MULTI_REVIEW_LARGE_EVIDENCE_MIB=512 \
MULTI_REVIEW_LARGE_EVIDENCE_OUT=/tmp/large-evidence.json \
  mise exec -- bun test --cwd apps/backend \
  ./src/core/multi-review-large-evidence.bench.test.ts
```

On an Apple M5 Pro (internal SSD, Bun 1.4.4, 2026-10-25) 512 MiB in 16
artifacts verified in about 0.25 s per pass (about 2 GB/s), 0.5 s per
generation, with peak RSS growing by under 20 MiB; Bun 1.4.2 runs of 512 MiB
and 1 GiB took 0.36 to 1.2 s per pass. A GiB of evidence costs about two
seconds per generation on local disk, against reviews that take minutes. Container artifacts are hashed inside the container
(`stat`, then `sha256sum`) and were not measured. The remaining budgets are asserted by focused tests:
`review-fanout-efficiency.test.ts` (transcript reads, writes per pass,
admission, isolation), `multi-review-service-efficiency.test.ts` and
`multi-review-reviewer-transcript.test.ts` (reviewer-tab snapshots),
`storage-multi-review.test.ts`
(fence checks read one row without the lease),
`structured-review/budgets.test.ts` (reports) and
`review-consolidation-evidence.test.ts` (consolidation input). Open
scale and cost work is in
[0027-multi-review-scale-and-cost.md](../todo/coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).

## Dispatch recovery

Each reviewer's prompt goes out at most once per request id: `prepared` →
durable `dispatching` → `send` → `sent`, with the send the next fallible step
after the durable write. Two rules keep a recovered record honest
(`review-fanout.ts`):

- **`dispatching` is written only by the reviewer's own commit.** Every save
  serializes the whole panel, so the runner applies `dispatching` inside that
  reviewer's turn in the serialized commit queue (and reverts it if the write
  fails). A peer's earlier save can no longer make durable a request whose own
  commit, and so whose send, then never happened.
- **A recovered `dispatching` request is promoted only on proof.** The next
  owner asks the provider's dispatch journal (`dispatchStatus`). `dispatched`,
  or a result for this exact request id (the tool-transport slot, or a
  structured result naming the request), moves it to `sent`. `lost` (the
  provider restored the id without an outcome and refuses it for good) fails
  the reviewer at once. `absent` (the provider proves the id never reached
  it) moves it back to `prepared`, and the next pass re-runs admission and
  sends it again under the same id; a result for the exact request outranks
  that answer, and a late delivery of the first send is the provider's
  duplicate. Anything else parks it, and the idle-poll bound fails it closed.
  It is never re-sent under a new id
  ([0223](../todo/coordinator-and-multi-review/0223-provider-non-delivery-proof.md)).

A restart notice names the request it cut short (`interruptedRequestId`, see
[agent engines](agent-engines.md)), so a continuation the provider has
journaled but not yet started is not failed as a second restart. The Multi Review
preparation, consolidation and Fix steps and Build Pipeline consolidation park
an unconfirmed `dispatching` request, and re-send an `absent` one, the same way;
they have one writer per request, so the first rule does not arise there.
All these paths use `provider-dispatch-recovery.ts`: a saved result for the
exact request takes precedence over `absent`, `lost`, and `unknown`. A failed
result read supplies no proof, and a structured result naming another request
cannot settle the dispatch.

Build Pipeline's stage prompts follow the same rule. A new
`pendingPromptAttempt` carries `dispatchVersion: 1` and gets `dispatchingAt`
durably just before its send (cleared again when the send is refused before
the prompt was written). Only a versioned attempt without that timestamp is
known to be prepared and may send immediately. Legacy pending attempts without
the version may have reached the provider, even without `dispatchingAt`, so
require the same reconciliation as marked attempts. Both settle as sent on
`dispatched`, `pending`, or an exact-request result; without a result, `lost`
fails the stage, `absent` permits a same-id resend, and anything else waits
within the reconnect deadline before failing closed ("dispatch acceptance
could not be confirmed"). Legacy attempts use their original `startedAt`
for that deadline. An older backend ignores these fields and re-sends, as before.

`review-fanout-interleaving.test.ts` checks both rules over seeded
interleavings of commits, provider calls, cancellation, fence loss and backend
restarts. Its "a provider that proves an id never arrived" suites run the
restart and chaos flavours against a provider that answers `absent`, lets a
crash leave a send on the wire to land later, and must deduplicate it. Without a crash, a durable `dispatching` request that no send was
ever attempted for fails the seed, and the fake provider starts half of all
continuations late, so the status read still shows the restart they continue.

## Panel value measurements

Three content-free measurements show what each reviewer adds and whether the
shared prompt prefix is cached. None of them holds finding text, paths or
reviewer IDs.

- **Overlap counts.** When a consolidation is accepted,
  `consolidationOverlap`
  ([`review-fanout-provenance.ts`](../../apps/backend/src/core/review-fanout-provenance.ts))
  turns the `reviewSourceIds` the model cited into a `ReviewPanelOverlapV1`
  (`packages/protocol/src/review-fanout.ts`). It has to run then: the stored
  report keeps model labels, not source IDs. Multi Review stores it as
  `consolidationOverlap` beside `consolidatedReport` and clears both together.
  A Build Pipeline stores it as `reviewOverlap` on its Consolidation session,
  because the fan-out record is dropped once the next stage (Address, or
  Verify for a clean report) starts, and keeps it
  when report copies are discarded. Per run it counts the reviewers, the
  source findings, the source findings that were cited (the rest were
  dropped), the consolidated findings, and those only one reviewer
  substantiated. Per configured position it adds `novelFindings`: findings no
  earlier position substantiated. Summed over the first k positions, that is
  what a k-reviewer panel would have found. Position still carries no
  priority. The validator checks structure only, so a miscounted record
  cannot make its workflow unreadable.
- **Cache reads.** Reviewer records keep `cacheReadTokens` beside
  `tokenCount`, and Build Pipeline reviewer sessions mirror it once the
  reviewer settles. Claude, Codex and OpenCode report a session total. Pi and
  Cursor report their latest turn, so the record keeps the largest value seen.
  Each reviewer's tool loop rereads its own context from the cache on every
  model call, so cache reads are mostly that context, not the prefix shared
  across the panel. Compare reviewers 2..N against reviewer 1 on the same
  agent and model, as a share of `tokenCount`.
  Measured through the Claude CLI (2026-10-23), a separate session reads a
  prompt from cache only when it is byte-identical up to a message boundary
  and runs in the same working directory. A prompt that shares only its
  opening instructions got no cache hit. See
  [0025](../todo/coordinator-and-multi-review/0025-multi-review-panel-value.md#qualification).
- **Evaluation corpus.**
  [`multi-review-evaluation-corpus.ts`](../../apps/backend/src/core/multi-review-evaluation-corpus.ts)
  holds nine synthetic panels with a reference consolidation for each:
  severity disagreement, a contradiction, a late unique finding, two distinct
  problems at one location, a clean panel, failed and invalid reviewers,
  coverage gaps, Unicode and list limit boundaries, and evidence-frame
  injection.
  [`multi-review-evaluation.ts`](../../apps/backend/src/core/multi-review-evaluation.ts)
  scores an answer by recall, false merges, splits, unexpected findings,
  dropped sources, severity, location, provenance validity and verdict. It
  also rebuilds the pre-#833 full-report evidence (`d680ccdb`) inside the
  current prompt, so the evidence is the only thing that differs between the
  two. CI covers these in `multi-review-evaluation.test.ts`.

[`scripts/multi-review-evaluation.ts`](../../scripts/multi-review-evaluation.ts)
runs the live comparison. `prompts` writes each case's full and compact prompt
and reference answer under `output/multi-review-evaluation/`, and prints their
sizes. `score <case> <answer.json>` scores one model answer. `panel
<record.json>...` reads exported Multi Review workflows or Build Pipelines
(from `get_multi_review_workflow` or the pipeline record) and prints each
panel's overlap and cache-read shares. A Multi Review stored before
`consolidationOverlap` existed is summarised from its report's model labels
(`overlapFromModelLabels`), but only when every reviewer label is distinct.
`live` sends selected cases to the Claude CLI already signed in on the host,
with no tools and the report schema enforced. It saves the answers under
`output/multi-review-evaluation/live/` and prints scores and token usage. Keep
model answers and exported records out of the repository and CI logs.

On the corpus, the compact evidence is 81–93% of the full evidence for two to
five reviewers. One usable report has nothing to share, so its compact
evidence is about 10% larger. For two small reports the whole compact prompt
is about 2% larger, because the paragraph explaining `shared` outweighs what
it saves. The savings grow with panel size and shared scope.
