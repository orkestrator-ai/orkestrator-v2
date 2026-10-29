---
id: 207
title: "System nodes, version 1"
phase: 2
plan: "P2.7"
status: in-progress
depends_on: [201, 203]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-207-system"
pr: ""
updated: 2026-10-29
---

# 207 · System nodes, version 1

- **Plan:** [P2.7 System nodes, version 1](../composable-graphs.md#p27-system-nodes-version-1)
- **Decisions:** D12, D20
- **Depends on:** [201](201-run-record-and-storage.md), [203](203-scheduling.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Side effects run in the backend, idempotently, so no agent node needs push or GitHub access.

## Work

- [x] `prepare-environment`, reusing Build Pipeline provisioning.
- [x] `run-validation-and-seal`, reusing the review validation service and `generate_looped_review_package`.
- [x] `push-branch`: idempotent per commit; force-with-lease only after a code rewind.
- [x] `open-pull-request`: pushes, then opens, updates or reopens the PR; idempotent per run and branch.
- [x] `wait-for-checks` (D20): reads the PR monitor's `checkSummary`, waits within a bound (default 60 minutes, at most 6 hours) without polling of its own, outputs `check-summary@1`.
- [x] `update-ticket`: column moves, comments, criteria results (`record_kanban_criteria_checks`).
- [x] `notify`: agent mail to the coordinator or a tab.
- [x] `run-validation` (added by 101 for report §9.4): runs the plan without sealing, outputs the new built-in `validation-results@1`.
- [x] `GraphRunProvisioner` for runs that create their own environment (202's seam).
- [x] Per-action parameter and port rules checked by the compiler, with diagnostic codes.
- [x] `open-pull-request` reports 108's `pull-request-state@1` beside `pr-result@1`.

## Tests

- [x] Retries and restarts never repeat a side effect.
- [x] Force-with-lease only after a code rewind.
- [x] `wait-for-checks` returns passed, failed and pending-at-timeout.
- [x] Ticket updates match today's pipeline lifecycle.
- [x] Provisioning reuses the Build Pipeline's commands, once per run.

## Done when

- [ ] Every version 1 system node works and is idempotent.

## Notes

**2026-10-29 · Files.** Protocol (browser-safe, new export `./graphs/system-actions`):
`graphs/system-actions.ts` (the action table `GRAPH_SYSTEM_ACTION_SPECS`: label, `sideEffect`,
idempotency, params, input and output types; `checkGraphSystemParams`, `graphSystemActionParams`
(defaults), `graphSystemRequiredInputs`, `graphForcePushRewind`, `GRAPH_TICKET_LIFECYCLE_EVENTS`,
`GRAPH_TICKET_STATUSES`, `GRAPH_WAIT_FOR_CHECKS_DEFAULT_MINUTES`/`_MAX_MINUTES`,
`graphPullRequestStateType`), `graphs/compile-system.ts` (the compiler pass); tests
`system-actions.test.ts`. Backend: `graph-node-system.ts` (the `system` executor and
`GRAPH_SYSTEM_ACTION_HANDLERS`), `graph-system-action.ts` (action context, typed inputs/outputs,
the effect helper, dependencies, `GraphSystemActionError`), one module per action
(`graph-system-prepare.ts` with `GraphRunEnvironmentProvisioner`, `graph-system-validation.ts`,
`graph-system-push.ts`, `graph-system-pull-request.ts`, `graph-system-checks.ts`,
`graph-system-ticket.ts`, `graph-system-notify.ts`), `graph-system-environment.ts` (git/gh in an
environment with its credentials), `storage-graph-effects.ts` (the effect journal),
`build-pipeline-kanban-lifecycle.ts` (the pipeline's ticket lifecycle table, now read by the
pipeline too). Tests: `graph-node-system.test.ts`, `graph-system-{checks,ticket,prepare,validation,runtime}.test.ts`,
`storage-graph-effects.test.ts`, support `graph-system-test-support.ts`. Wired in `index.ts`
(provisioner on `GraphRunService`, executor registered, `shutdown()` before the graph runs drain).
`PrMonitorRuntime.onEvent(listener)` added for in-process observers.

**2026-10-29 · Parameters and ports (compile-time).** Ports bind by type, not name: an action
reads at most one input per type it lists and writes each output type on whichever port declares
it; an `error` output (`error@1`) is always allowed. Codes: `system-param-invalid` (`detail`
unknown, type, range, format, required, conflict; path `nodes[i].params.<key>` or
`nodes[i].params`), `system-port-unsupported` (`detail` input-type, output-type, duplicate,
schema_mismatch), `system-input-missing` (path `nodes[i].inputs`). Params: prepare-environment
`setup` (bool, true); run-validation `outputBytes` (1,024–32,768, 8,192); run-validation-and-seal
and open-pull-request `targetBranch` (branch name, default the project's PR base branch);
open-pull-request `draft` (false); wait-for-checks `timeoutMinutes` (1–360, 60); update-ticket
`lifecycle` (build-started, validation-complete, pr-raised, complete, failed) | `status`
(backlog, in-progress, review, done) | `comment` (≤ 2,000) | `record: criteria` | `taskId`
(at least one of the first four; `lifecycle` conflicts with `status`/`comment`; `record` needs a
`verification-verdict@1` input, `pr-raised` a `pr-result@1`); notify `to` (coordinator | tab,
required), `tabId` (required for tab, refused for coordinator), `subject` (≤ 200), `message`
(≤ 8,000, required). Inputs: prepare `ticket@1`?; validation and seal `validation-plan@1` +
`workspace@1`; push `workspace@1`; PR `workspace@1` + `pr-description@1`; checks `pr-result@1` +
`workspace@1`?; ticket `verification-verdict@1`?, `pr-result@1`?, `ticket@1`?; notify `text@1`?,
`markdown@1`?. Outputs: prepare `workspace@1`; validation `validation-results@1`, `workspace@1`;
seal `review-package@2`; push `workspace@1`; PR `pr-result@1`, `pull-request-state@1`; checks
`check-summary@1`. Plan params stay as authored (defaults applied at run time), so existing plan
digests do not change.

**2026-10-29 · Idempotency design.** Every side effect goes through `ctx.effect(key, perform,
{probe})`: the intent is written to the run's effect journal before the effect (`intended`, with
the backend process as `owner`), `done` with replay data after, `failed` on an error (a stop —
cancel or shutdown — leaves it `intended`). A key already `done` replays its data and does
nothing; an `intended` or `failed` one first asks the action's probe whether the effect happened
(remote has the commit; the branch has an open PR), or relies on the downstream's own idempotency
(agent mail request id; the validation worker's run id; ticket compare-then-write). Keys never
contain the attempt: `push:<branch>:<sha>`, `pr:<branch>` (and `pr:<branch>:after:<merged url>`),
`<action>:<node>#iter=<n>[#branch=<k>]` for prepare, ticket, notify and the checks deadline,
`…:validation:<plan digest>` and `…:seal:<plan digest>`. Same-key effects are serialised in
process. Journal rows live in `graph-artifacts` (`<run>/effect:<sha256 of key>`, owned by the run,
`effectFormatVersion` 1, data ≤ 64 KiB), so environment deletion removes them with no new store.
Executor: jobs run in the background (start waits ≤ 2 s, then `running`, `observeAfterMs` 30 s;
the settling job calls `requestObservation`); `wait-for-checks` is re-evaluated per call and
subscribed to PR monitor events.

**2026-10-29 · Actions (behaviour).** prepare-environment: `start_environment` when not running,
`run_environment_setup` when setup is incomplete, fails on a failed setup without override,
outputs `{branch, headRef: HEAD, baseRef: HEAD}`. Validation: plan headRef must equal the
workspace commit and the environment's HEAD; worker run id `graph-validation-<hash(run, slot,
plan digest, generation)>`; a cancelled/failed run bumps the generation. Seal:
`generate_review_package` (packageId = validation run id, round = iteration, expectedHead,
validationPlan), file copied with `putFile` and the `ReviewPackageReference` minus
`diffCharacters` as the descriptor. Push: plain `git push origin <sha>:refs/heads/<branch>`;
refused non-fast-forward without a rewind; force-with-lease leased on the remote-tracking ref;
sets the branch upstream afterwards (best effort) so 210's inspection finds `@{upstream}`.
Open-pull-request: push, adopt/open (`gh pr create --repo --head --base`), reopen if closed, new PR
if merged, `gh pr edit` only when title/body differ, re-read mergeability up to 6 × 5 s while
UNKNOWN, then store `prUrl`/`prState`/`prBaseBranch`/`hasMergeConflicts` on the environment (as
Ship's persistence did) and `pr_monitor_watch`. It does not touch the ticket: that is
`update-ticket` (`lifecycle: pr-raised`). wait-for-checks: deadline recorded on first call; first
call asks the monitor to watch; failing check → `failed` at once; all done → `passed`; still pending
at the deadline → `pending`; total 0 for 2 minutes → `none`; then one `gh pr view --json
headRefOid,statusCheckRollup` read for failing names and head (after 3 failed reads the counts
alone, with unnamed failing entries). update-ticket: ticket = `taskId` or the task whose
`environmentId` is the run's environment. notify: workflow notice from `{system, workflow,
resourceId: run id}`, request id `graph-notify:<hash(run, slot)>`, body ≤ 32 KiB.

**2026-10-29 · New built-in type (102's library).** `validation-results@1` `{headRef, state
passed|failed|incomplete, total, passed, failures [{id, command, state failed|incomplete,
exitCode|null, summary, output}], limitations}`, items `failures`/`failure`, ≤ 384 KiB, strings
≤ 32 KiB, ≤ 64 items, validator `validation-results` (state agrees with failures, ids unique,
counts fit). The §9.4 example drops its custom `validation-results` (built-in names are
refused) and its `validation-failure` matches the element shape; 102's `artifact-type-def.test.ts`
index moved accordingly.

**2026-10-29 · For 210 (rewind state).** `GraphRewind.code` is now `GraphRewindCode {headRef,
backupRef?, from?, upstream?, upstreamCommitsDropped?}` (guarded). Record `upstream` and
`upstreamCommitsDropped` from `inspectCodeRewind` before the reset; `graphForcePushRewind(run.rewinds,
consumed)` makes the next push of the branch force-with-lease once (a completed push records
`forcedForRewind` in its effect data).

**2026-10-29 · For 213 (mock runs).** `GRAPH_SYSTEM_ACTION_SPECS[action].sideEffect` is true for
every action but `wait-for-checks`; register a mock `system` executor (`{mock: true}`) that records
"would have run" for those and answers outputs from the types' examples. `GRAPH_SYSTEM_ACTION_HANDLERS`
can be reused for the read-only one.

**2026-10-29 · For 214 (launch).** Launching on a new environment: omit `environmentId`; the
registered `GraphRunEnvironmentProvisioner` creates it once (`controlRequestId: graph-run:<run>`,
local for `create.kind: worktree`, containerized + restricted for `container`, named from a
`ticket@1` input's title), starts it with `start_environment_background` (re-asked after 60 s)
and reports ready when running. Link the Kanban ticket to the run's environment
(`update_kanban_task {environmentId}`) at launch so `update-ticket` finds it (no `taskId` on the
run record). Kanban `buildPipelineId` linking is not done for graph runs.

**2026-10-29 · Not done here.** "Done when" stays unticked until the PR exists and the executor
runs in a real stack; no live GitHub/Docker run was made (fakes cover git/gh/commands; the
production shell reuses the PR monitor's credential paths). Edge transforms on system-node inputs
are not applied (102/205 own value transforms).

**2026-10-29 · Designer (212) reads the specs.** The editable designer now takes labels,
descriptions, `sideEffect`, idempotency, ports and params from `GRAPH_SYSTEM_ACTION_SPECS` and
validates params with `checkGraphSystemParams` (see 212's Notes); its own catalogue is removed.
Inconsistency found: notify's `message` allows 8,000 characters (`GRAPH_SYSTEM_PARAM_BOUNDS.messageChars`)
but the template schema (101) caps every param string at `maxSystemParamStringBytes` (2 KiB), so
a message over 2 KiB is `template-invalid` before the spec's bound applies. The designer shows
and enforces the 2 KiB template bound; aligning the two (raise the template bound for system
params or lower `messageChars`) is left to the coordinator.
- 2026-10-29 (coordinator): `notify`'s `messageChars` bound lowered from 8,000 to 2,000 so it fits the template schema's 2 KiB cap on parameter strings; the designer and the compiler now agree.

**2026-10-29 · Live verification: `run-validation` in a repair loop (fixed).** On profile
`graphs-live` the report §9.4 loop as written (`qa-live-failure-diagnosis`, a copy of the example)
failed live at iteration 2: `validate` refused with "The validation plan is for commit f1e42aa7b555,
the workspace is at 1c6b1e6080a3", because the run's one `validation-plan@1` names the starting
commit while the loop carries the fixer's new commit. Mock runs never check `headRef`, so they
passed. Fix (`graph-system-validation.ts`): `run-validation` now accepts a plan made for the
workspace commit or an ancestor of it (`git merge-base --is-ancestor`; any failure refuses) and
runs it on the workspace commit (the plan handed to the worker is rebased, since the worker checks
HEAD against `plan.headRef`). `run-validation-and-seal` stays exact: the sealed package names the
commit its plan was made for. Tests in `graph-system-validation.test.ts` ("a plan for an ancestor
runs on the later commit a repair loop carries", "a plan for a commit outside the workspace's
history is refused", "sealing refuses a plan made for an ancestor"); the first two fail without the
fix. The port description in `GRAPH_SYSTEM_ACTION_SPECS` says so. Rerun after the fix (run
`launch-2f036405…`, diagnoser Claude `sonnet@low`, fixer Codex `gpt-6-luna@medium`, a deliberately
broken `math.ts` with a one-command plan `bun test math.test.ts`): iteration 1 failed (1 failure),
one diagnose branch (items fan-out), dedupe, fix committed; iteration 2 validated the fix commit and
passed; loop `repair` done after 2 iterations, run complete in 40 s with 2 agent sessions.

**2026-10-29 · Live verification: design bake-off without the pull request.** Run
`launch-2033e6fc…` of `qa-live-bake-off`: the report §9.3 example with the review sub-graph and
the `pr` system node removed (`build` feeds `describe-pr` directly) and the build taint warning
acknowledged. Roles on two providers: designer Claude `sonnet@low` (three lens branches, the
researcher exception: provider-configured, ordinary turn), judge Codex `gpt-6-luna@low` (enforced,
read-only; decision `simplicity`), builder Codex `gpt-6-luna@medium`, describer Claude `sonnet@low`
(enforced). Launched from the CLI with the fixture's Kanban ticket as `ticket@1`; the run waited
at the `approve` edit form, was approved unchanged through `graph_run_answer`, then built one
commit (`server.ts`, `server.test.ts`) and produced a `pr-description@1`; complete with 6 agent
sessions, every read node's guards passed, origin unchanged. The `pr` node was deliberately not
run: opening a pull request is an outward action that needs the user's approval (and the fixture's
origin is a local bare repository), so "from launch to PR" is not demonstrated and the Phase 2
exit criterion stays open.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · All eight system actions, the provisioner, compile-time param/port rules, the effect journal and `validation-results@1`, with tests. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Designer (212) now reads `GRAPH_SYSTEM_ACTION_SPECS`; notify message bound inconsistency recorded. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (live verification, `graphs-live-verify`) · `run-validation` accepts an ancestor's plan (repair loops failed live at iteration 2); live §9.4 loop converged; live bake-off ran to the PR description (PR node not run). · Every system node live, including `open-pull-request` with the user's approval.
