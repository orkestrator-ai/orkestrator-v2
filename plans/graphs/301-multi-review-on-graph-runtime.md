---
id: 301
title: "Multi Review on the graph runtime"
phase: 3
plan: "Phase 3"
status: in-progress
depends_on: [204, 205, 206, 207, 209, 210, 211, 214]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 301 · Multi Review on the graph runtime

- **Plan:** [Phase 3: Multi Review on the graph runtime](../composable-graphs.md#phase-3-multi-review-on-the-graph-runtime)
- **Decisions:** D5
- **Depends on:** [204](204-agent-node-executor.md), [205](205-replication-and-collection.md), [206](206-gate-merge-loop-failure.md), [207](207-system-nodes.md), [209](209-guards-and-enforcement.md), [210](210-restart-and-rewind.md), [211](211-run-view.md), [214](214-launch-surfaces.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Multi Review runs on the graph runtime with no loss of quality, robustness or efficiency.

## Work

- [x] A setting (plus an environment override for testing) selects the graph runtime for Multi Review.
- [x] Parity: evaluation corpus scores (`multi-review-evaluation.test.ts`).
- [x] Parity: efficiency budgets (two verifications per generation, at most one save per running pass, no whole-store reads).
- [x] Parity: interleaving and dispatch-recovery suites.
- [x] Parity: auto-fix and auto-PR ordering (`review-preparation.md`).
- [x] Parity: coordinator launch, status wakes and `get_multi_review`.
- [x] Parity: review-pass tab, CLI `review` commands, provisional findings, overlap metrics.
- [x] Parity: stored Multi Review records stay readable.
- [ ] Soak period on the graph runtime, then flip the default.
- [ ] Retire the bespoke service once no supported version needs it (`docs/architecture/version-compatibility.md`).

## Tests

- [x] The existing Multi Review suites run against both engines until retirement.

## Done when

- [ ] Multi Review runs on the graph runtime by default and the bespoke service is retired.

## Notes

### 2026-10-29 · Design (read model kept, run projected onto it)

- **Setting.** `AppConfig.global.multiReviewEngine: "bespoke" | "graph"` (absent
  = `bespoke`; `MULTI_REVIEW_DEFAULT_ENGINE`), validated and preserved by
  `updateGlobalConfig` when a save omits it; Settings → Review → "Multi Review
  runtime" (`MultiReviewEngineSetting.tsx`). `ORKESTRATOR_MULTI_REVIEW_ENGINE`
  overrides it (`resolveMultiReviewEngine` in `@orkestrator/protocol/multi-review`,
  `configuredMultiReviewEngine` in the backend). Read once per start.
- **Routing.** Every launch surface (dialog, `launch_multi_review`,
  `start_multi_review`, CLI `review launch`) already calls
  `MultiReviewService.start`, so routing lives there: on `graph` the record gets
  `engine: "graph"` and `graphRun: { runId: "multi-review-<workflow id>" }`
  (`MultiReviewGraphRunLink`, validated by `isMultiReviewWorkflow`). The review
  instruction travels as a run input (see the 2026-10-29 audit note); nothing
  falls back to bespoke.
- **Launch.** `multi-review-graph-engine.ts` launches through the new
  `GraphRunLaunchService.launchInline(request, template, runId, origin)` (same
  binding, floor, parameter and workspace checks as `launch`) compiled by
  `GraphTemplateService.compileInlineForLaunch`. The template is the built-in
  copied per launch (`multi-review-graph-template.ts`): `engine` dropped, string
  param `targetBranch` and the optional `markdown@1` run input `reviewInstruction`, and the target branch written
  onto `package`/`pr` system params (system params take no references).
  Bindings: preparer = `reviewModel ?? fixModel`; reviewer panel = reviewers in
  order with lenses; consolidator = `consolidationModel ?? preparer`; fixer =
  `fixModel`; describer = saved `pr` default. The first supervision pass
  launches, so a crash between record and launch relaunches under the same id.
- **Projection.** Approach chosen: graph-engine reviews project into the same
  Multi Review read model (not the tab rendering the run), because the tab, the
  CLI, `get_multi_review`, status wakes, the activity badge and overlap all read
  that record. `advanceMultiReviewGraph` reads the run by id; an unchanged
  revision costs that one read; otherwise `projectMultiReviewGraphRun`
  (`multi-review-graph-projection.ts`) maps activations to fields (plan →
  `preparationSession`, package → `reviewPackage`, review `panel.N` → reviewer N
  with attributed report and provisional findings from `report_progress`,
  consolidate → `reviewSession`/`consolidatedReport`/`consolidationOverlap`, fix
  → `fixSession`/`fixResult`, describe-pr/pr → `autoPrLaunch` with
  `fixIdentity`) and saves once under the controller lease if anything visible
  changed. Graph-run storage changes wake the review (`graph-run` resource
  listener; `multiReviewWorkflowIdOfRun`). Obligation `graph-run`
  (`isGraphEngineProjection`) shadows every bespoke obligation until the run
  settles; then `graphRun.settled` and the record is an ordinary settled review.
- **Controls.** Restart/stop/pause/resume/nudge/retry refuse with
  `MultiReviewGraphEngineError` (they belong to the graph run view);
  `address`/custom Fix wait for the run to settle and then run the ordinary
  interactive handoff. Cancel cancels the run; the record shows `cancelling`
  until the run settles. Close does not close the run's sessions. The review
  tab and reviewer tab offer no bespoke step control on a graph record (live or
  settled) and the tab shows "Open graph run".
- **Graph runtime changes for parity.** The consolidation built-in
  (`isGraphReviewConsolidationNode`) now passes each report's agent, model and
  lens label, stamps coverage gaps with `<label>/coverage-gap-<k>`
  (`graphReviewCoverageGapIds`), classes sources `issue`/`coverage-gap`, and
  checks the output with `REVIEW_CONSOLIDATION_PROVENANCE` and its wording
  (moved to `review-consolidation-provenance.ts`; `cite`, per the 103 note).
  `targetBranch` param drives agent prompts (`graph-agent-host.ts`);
  the `reviewInstruction` run input is read by the discovery review only.
- **Known differences** (documented in `review-preparation.md` §"The engine
  setting"): the automatic Fix is an unattended node (no interactive Fix tab);
  `validationRun` progress is not projected (the `package` node validates and
  seals in one activation); a Fix that asks a question waits in the graph run
  view, which the tab links to.
- **205 note** ("consolidation prompt must learn failed branches"): the bespoke
  prompt carries no failed-reviewer summary (failed reviewers are simply left
  out of `consolidationReports`), and the graph's built-in inputs drop `error@1`
  markers, so parity is both omitting them; the prompt was not changed.
- Old binaries reject records carrying `engine` (strict key list), so a
  downgrade during the soak hides graph-engine reviews; bespoke records are
  untouched.

### 2026-10-29 · Parity evidence (one entry per ticked box)

- **Setting.** `multi-review-graph-engine.test.ts` › "the engine setting"
  (override wins, unknown ignored; stored, validated and kept by a save that
  omits it; bespoke starts record no engine, graph starts record their run; a
  >4 KiB instruction runs on graph; one past 128 KiB refuses the start). `multi-review-engine.test.ts` (protocol)
  › "the engine setting". `GlobalSettings.multi-review-engine.test.tsx`
  (Settings saves `multiReviewEngine: "graph"`).
- **Evaluation corpus.** `multi-review-graph-evaluation.test.ts`, every corpus
  case, lens-free and lensed: "without the package input, the graph text
  equals the corpus prompt after id normalization"; "with the sealed package,
  the rendered prompt carries the bespoke package-scoped prompt";
  "invalid-and-failed: failed and stopped reviewers are omitted from both
  prompts"; "the reference and every citation fault get the bespoke verdict,
  issue for issue"; "every corpus rejected answer is refused by the graph
  review slot at the field bespoke acceptance names"; "limit-boundaries: the
  graph slot accepts a consolidation that keeps all 101 source issues, as the
  bespoke one does"; "the projected record, overlap and score equal the
  bespoke consolidation's"; "a lensed panel projects the same scores and
  overlap as the lens-free one". Fixes it forced: the built-in prompts refused
  the run-sealed package copy (path compare → SHA-256 and size), reports kept
  provider `null` placeholders (now parsed as on acceptance), and a
  consolidation's caps now rise to its sources' totals (`reviewLimits`).
  Remaining wording difference: an over-budget text field is `too_large` on
  the graph slot and `invalid_value` on the bespoke one, same path, both
  refused.
- **Efficiency.** `graph-run-efficiency.bench.test.ts` › "graph run
  control-plane benchmark: the Multi Review shape (item 301)" › "Multi Review
  panel of 1/8/32": the sealed package is hashed exactly twice per generation
  at every width (once for the panel through the shared sealed-file permit,
  once for consolidation), a running pass reads one run row, saves nothing
  and lists nothing, and no statement fetches more than one run row with ten
  retained runs. `multi-review-graph-efficiency.test.ts` › "a graph-engine
  Multi Review's record-side budgets" › "a full review with 8/32 reviewers":
  at most one record save per pass, none over an unchanged run, no
  `listAll*` in a pass, artifacts read a bounded number of times (each
  reviewer report at most twice: on completion and once more to translate the
  consolidation's ids, which the record does not keep). `graph-artifacts.test.ts`
  › "a consumer's branches share one sealed-file permit; another consumer
  hashes again (item 301)".
- **Interleaving and dispatch recovery.** `multi-review-graph-interleaving.test.ts`
  (real graph agent executor and the template's own built-in reviewer prompt,
  fake providers): "graph-engine Multi Review reviewer interleavings" › seed
  1–12, "the seeds exercise crashes, late deliveries and lost answers", "a seed
  replays the same outcome"; "a backend that dies at each reviewer dispatch
  state" (11 cases); "a backend that dies with the whole panel mid-dispatch"
  (3); "graph-engine Multi Review record recovery" (crash before launch, after
  launch, restarted service resumes from `projectedRevision` and never
  changes a settled record); "the built-in reviewer prompt reaches dispatch on
  a sealed package". Invariants per seed: journal before send, at most one
  delivery per request id, `dispatched` never resent, `absent` resent once
  under the same id, `unknown`/`lost` never resent, every reviewer settles
  once, one run launched. One test of this file was reported failing once in
  a combined run (name not captured) while it still used a substitute
  reviewer prompt; after the switch to the built-in prompt and the sealed
  package fixture fix it did not recur in six combined runs (`--parallel=8`
  with the graph and bespoke interleaving suites, `--parallel=16` with every
  graph and Multi Review suite). Not recorded as a flake: there is no
  reproduction and no failure message to record.
- **Auto-fix and auto-PR.** `multi-review-graph-auto-pr.test.ts`: "a Fix that
  completes queues the pull request, which opens only after it" (pending →
  launched, `fixIdentity`, `pr` is a system node fed the Fix's commit, starts
  after the Fix finished); "a Fix that does not complete fails the review and
  queues no pull request"; "a clean report goes straight to the pull request
  whatever autoFix says"; "findings without autoFix end ready; the manual Fix
  then runs as on any review"; "autoPr off never reaches the pull request
  nodes". `multi-review-graph-surfaces.test.ts` › "no saved revision of the
  run reads as an end the bespoke engine never shows".
- **Coordinator.** `multi-review-graph-surfaces.test.ts` › "coordinator launch
  on the graph engine" (launch_multi_review with saved defaults, explicit
  override, start_multi_review); "get_multi_review on a graph-engine record"
  (reads exactly as a bespoke record at reviewing and ready; at completed
  everything but the next-step wording, which names the graph run's pull
  request step); "status wakes for a coordinator-launched graph-engine review"
  (one notice each for ready, completed, pr-started, failed, cancelled; the
  only association is the Multi Review's, so the run adds none).
- **Review-pass tab, CLI, provisional findings, overlap.**
  `multi-review-graph-surfaces-reads.test.ts` › "CLI review commands on a
  graph-engine review" (launch once per request key, receipt settles on the
  launch's own evidence, get/list read the bounded projected summary, cancel
  stops the run) and "the review-pass tab's reads on a graph-engine review"
  (reviewer and step transcripts and history pages read the projected
  provider sessions; `report_progress` items show as provisional findings
  until the report is accepted; overlap equals `consolidationOverlap` of the
  equivalent bespoke review). `MultiReviewTab.graph-engine.test.tsx`: live
  and settled records link to their run and offer no bespoke control, the
  reviewer tab offers no Stop/Restart/Unstick, failed steps and the system
  PR step read correctly. Fixed for the tab: bespoke controls hidden on every
  graph record, failed consolidate/Fix attributed from sessions, a stalled
  preparation read from `preparationSession`, the PR step and notices name
  the graph run's step, `activeRequest` (with its result-submission state) is
  projected while the run is live, and reviewer `sessionKey` falls back to
  the host's `graphAgentSessionKey` so transcript artifacts resolve.
- **Stored records.** `multi-review-engine.test.ts` (protocol) › "stored Multi
  Review records" (every earlier bespoke shape stays valid and keeps its
  invariants; graph fields only with `engine: "graph"`);
  `multi-review-scheduling.test.ts` › "graph-engine reviews (item 301)". All
  existing Multi Review suites (bespoke records) pass unchanged.
- **Both engines.** Each parity suite above is the graph-engine variant of a
  bespoke suite (evaluation, efficiency bench, interleaving, auto-PR,
  coordinator, CLI, tab); the bespoke suites keep running unchanged against
  the bespoke engine. Suites that test bespoke internals with no graph
  counterpart (the service's own provider dispatch and step journals in
  `multi-review-service.test.ts`) stay bespoke-only.

### 2026-10-29 · Soak, flip and retirement

Not done, by the user's decision for this run: the graph runtime stays behind
the setting with `bespoke` as the default, and the bespoke service is not
retired. Both wait for a soak period on the graph runtime that the user
decides; then flip `MULTI_REVIEW_DEFAULT_ENGINE`, and retire the service once
no supported version needs it (`docs/architecture/version-compatibility.md`).

**2026-10-29 · Audit: the review instruction is a run input.** The audit
found that a review instruction over 4 KiB silently started on bespoke with
`graph` selected. The instruction is now the optional `reviewInstruction` run
input (`markdown@1`, 128 KiB), edged to a new optional `instruction` port on
`review` in the per-launch template copy (`multi-review-graph-template.ts`; the
protocol built-in and its digest are unchanged). `discovery-review` gained an
optional `instruction` input (text/markdown) that the adapter reads only from a
run input (`GraphBuiltInPromptInputValue.runInput`, producer `$input`), so the
prompt text matches bespoke (`createDiscoveryPrompt({ reviewInstruction })`);
the input wins over the older `reviewInstruction` parameter, still read for
runs whose frozen plan declares it. An instruction past 128 KiB encoded (Multi
Review allows 100,000 characters) refuses a graph start with
`MultiReviewGraphEngineError` before any record exists; the bespoke path is
unchanged. `multiReviewInstructionFitsGraph` is removed;
`multiReviewGraphInputs` and `multiReviewGraphInstructionProblem` are added.
Tests: `multi-review-graph-engine.test.ts` (a ~5.6 KiB instruction runs on
graph and reaches both reviewers; a 140,000-byte one refuses on graph and is
accepted on bespoke; no instruction, no input), `graph-agent-builtins.test.ts`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 · Graph-engine Multi Review behind `multiReviewEngine` / `ORKESTRATOR_MULTI_REVIEW_ENGINE` (default bespoke), projected onto the Multi Review record; all eight parity boxes and the tests box ticked with evidence. · Soak, flip and retirement await the user's decision.
- 2026-10-29 · Claude Opus 5.5 (graphs-audit-fixes) · review instruction as a run input (`markdown@1`); no bespoke fallback, an over-budget instruction refuses a graph start · awaiting PR
- 2026-10-29 · coordinator · The maintainer chose to keep the bespoke default and soak the graph runtime first (D23). · Soak, then decide the flip.
