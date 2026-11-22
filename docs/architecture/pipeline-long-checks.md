# Pipeline long checks

Status: Living — slow checks a Build Pipeline stage hands to the pipeline:
the tools, how they run, how the stage is held, and the decisions behind them.

A corpus parity run, a byte-identity comparison, a full browser suite or a
performance run can take longer than an agent turn, a tool call or a monitor
survives. Before long checks, such runs were started inside the Verify (or
Build) turn and were cut off partway: a browser suite timed out after 91 of
215 tests, parity runs were stopped with thousands of rows pending, and the
verdict was accepted on a subset with the key criterion left for a person.

A long check moves the run out of the turn. The stage agent starts it; the
pipeline owns it from then on.

## The tools

`start_long_check` and `get_long_checks`
(`apps/backend/src/core/build-pipeline/long-check-tools.ts`, names in
`PIPELINE_LONG_CHECK_TOOL_NAMES`) are listed on the same connections as the key
information tools: to a credential whose environment a build pipeline owns, on
the general agent server, the OpenCode broker and a stage turn's
workflow-result server (not on graph-output or subork turns).

- **`start_long_check`** takes a `name`, an optional `criterion` ID from the ticket snapshot,
  and one to eight `commands` (`command`, optional `cwd` relative to the
  workspace root, `timeoutMinutes` from 1 to 120, default 60, and `scope`).
  Only the running Build, Rework, Address Findings or Verify session may call
  it, identified by its worker tab or current result key (or the signed
  capability on a shared connection). Review runs read-only and starts none.
  Execution requires a managed container stage whose provider policy permits
  unattended shell execution at the container boundary. The worker runs as
  the container's workspace user. Local worktrees and provider-sandboxed
  sessions are refused before admission.
- **`get_long_checks`** lists every check on the pipeline with its status,
  elapsed time and per-command progress (state, exit code, duration, output
  byte counts, last output time and artifact paths, never output). A stage
  does not need it to receive a result.

One check runs at a time per pipeline, because checks share the workspace's
validation lock; a second start while one runs is refused with the running
check's name. Related commands go in one check.

## How a check runs

A check is a one-off validation plan on the environment's own validation
worker (`review/validation-worker.ts`), the runner review preparation uses
([review preparation](review-preparation.md#validation-commands)):

- It is detached from every agent turn and from the backend, keeps its state
  in `.orkestrator/review-artifacts/<check id>/state.json`, and a restarted
  backend reconnects to it rather than launching it again. The worker claims a
  run id exactly once.
- The plan keeps the requested order within each scope and puts changed-scope
  commands first. The worker runs commands serially, including admission waits,
  and continues after an individual failure. Explicit requests execute the
  named commands even if the review scheduler would skip or substitute them.
- Per-command timeouts, the deadline environment variable
  (`ORKESTRATOR_VALIDATION_DEADLINE_MS`), output bounds and process-group
  cleanup all apply as they do to review validation.
- The plan's `headRef` is the HEAD read when the check starts. A commit during
  the run fails the check (`error`). Commit what the check should cover first,
  then keep HEAD and the checked files unchanged until settlement.

**Admit before acting.** `start_long_check` records the check on the pipeline
under the pipeline's lock before asking the worker to start it. If that start
call fails or its reply is lost, the supervisor's next poll starts it; the
worker's one-time claim stops it running twice.

## Supervision, progress and the ticket

`BuildPipelineLongChecks` (`build-pipeline/long-checks.ts`) runs on supervisor
passes while the pipeline has detached work or a pending attachment:

- It reads each running check's status from the worker at most every five
  seconds (`LONG_CHECK_POLL_MS`), and writes the projection to the pipeline
  record when a command changes state, the check settles, or once a minute for
  progress. Every worker reply is validated before it is applied.
- Status comes from the run (`longCheckStatusFromRun`): any failed command is
  `failed`; otherwise any command that did not finish (timed out, cancelled,
  capacity wait expired) is `incomplete`; a worker that stopped is `error`;
  otherwise `passed` when all requested commands ran successfully or had
  covering evidence. Failed status reads retain ownership and retry; only an
  authoritative worker outcome or confirmed cancellation settles the check.
- Each settled check is written on the Kanban ticket once
  (`longCheckTicketComment`): name, stage, round, outcome and duration, the
  criterion ID, numbered command outcomes and an evidence location. Raw
  command lines and diagnostics stay in the execution context. The check ID
  makes retries idempotent. Up to three attempts continue even after a stage
  or pipeline finishes. Linear and GitHub builds have no Kanban attachment.

A paused pipeline keeps the workspace reservation until its running check
settles. Cancelling a pipeline cancels its checks. An explicit environment
stop or delete drains them with the other validation runs
(`stopEnvironmentReviewValidation`) and records their outcomes before going
offline.

## Holding the stage

When a stage's turn ends, the supervisor checks for long checks that stage
started in the current round and has not been given yet
(`undeliveredLongChecks`), before the stage's own completion runs (after
pending user messages and worker mail):

- **Any still running:** the stage is held. Nothing is completed, no result
  reminder is sent and no structured-result deadline runs. A verdict the
  stage already submitted is not accepted.
- **All settled:** the results are handed back as one follow-up turn in the
  same session (`longCheckResultsPrompt`), under a new result key, through the
  same journaled dispatch as the result reminder. A result submitted before
  the checks finished is superseded, so no criterion is judged on a run that
  had not ended. The turn names each check's outcome, commands and output
  paths, says that an `incomplete` or `error` check is no evidence (the
  criterion is recorded as not checked rather than passed), and asks the stage
  to finish and submit its result again. Marking the checks delivered is saved
  with that dispatch, so a restart neither drops nor repeats it.

Follow-up delivery belongs to the originating stage session. A restart or code
rewind waits for a running check to settle, and the replacement session receives
no results from its predecessor. Verify applies worker evidence to the verdict:
an unsuccessful bound check blocks a pass on that criterion until a later
successful check establishes it on the same commit. A Build turn's reported
outcome is kept across the results turn unless that turn reports again.

Verify's prompt (`VERIFICATION_LONG_CHECK_INSTRUCTION`) tells it to use the
tool for anything that may run longer than a few minutes, to list the narrow
changed run first, and to end its turn rather than poll. A graph's Verify node
has no long check tools and does not carry the instruction.

## Bounds

| Bound | Value |
| --- | --- |
| Checks kept per pipeline | 8; old settled checks are dropped after ticket delivery and when the current attempt no longer needs them |
| Running checks per pipeline | 1 |
| Commands per check | 8 |
| Command timeout | 1 to 120 minutes, default 60 |
| Name / criterion / command / cwd | 120 / 600 / 4,000 / 512 characters |
| Poll interval | 5 s; progress written at most once a minute |
| Recorded consecutive failed reads | Capped at 12; polling continues |
| Ticket comment attempts | 3 |

## Decisions

- **Reuse the review validation worker rather than add a job runner.** It is
  already detached, restart-safe, bounded, isolated per environment and
  claims each run once. A new runner would duplicate all of that. The cost is
  the shared workspace lock, hence one check at a time.
- **Hold the stage and send a follow-up turn, rather than mail the result to
  the agent.** Holding is what stops a stage finishing on an unfinished run,
  and a follow-up turn under a new result key is the existing, journaled way
  to reopen a stage's result. Mail would reach an agent whose stage may
  already have finished.
- **Always deliver by follow-up, even if the agent read the result itself.**
  A result the agent submitted before the check settled cannot otherwise be
  told apart from one submitted after it. The cost is one extra turn for an
  agent that polled, which the tool tells it not to do.
- **Result on the ticket from the supervisor, not the agent.** The comment is
  written whether or not the agent's next turn runs, and from the worker's own
  record rather than the agent's account of it.

## Not covered

- The pipeline view does not yet show long checks; they are visible through
  `get_long_checks`, the pipeline record and the ticket comment.
- Codex keeps its default approval mode for these tools; they are not on the
  always-approved list, because starting a check runs commands.
