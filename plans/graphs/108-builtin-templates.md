---
id: 108
title: "Built-in templates"
phase: 1
plan: "P1.8"
status: in-progress
depends_on: [107, 001, 003, 004, 005]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 108 · Built-in templates

- **Plan:** [P1.8 Built-in templates](../composable-graphs.md#p18-built-in-templates)
- **Decisions:** D5
- **Depends on:** [107](107-compiler.md), [001](001-pipeline-reviewers-read-only.md), [003](003-panel-review-routing.md), [004](004-typed-address-report.md), [005](005-reviewer-lenses.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The three built-in flows are described in the template model, so users can see and duplicate them, and tests keep descriptions and engines in step.

## Work

- [x] `graphs/builtins/multi-review.ts`, `build-pipeline.ts`, `looped-review.ts`, each with `engine` set to its engine.
- [x] They describe the behaviour after Phase 0 (read-only reviewers, routing, typed Address report, lenses).
- [x] Pinning tests compare each template with its engine: node set, routing conditions, iteration bounds, profiles and result kinds.

## Tests

- [x] All three compile with no errors.
- [x] Each pinning test fails when either side changes alone.

## Done when

- [ ] Built-in templates are merged and pinned.

## Notes

**2026-10-29 · Looped Review's engine is gone (raise with the maintainer).** Looped Review was
removed on 2026-10-29 by #1417 (`refactor(coordinator): remove looped review`), after the report
was written: `looped-review-service.ts`, its prompts and launcher are deleted, storage migration 5
(`retire-looped-reviews`) retires its records, and `generate_looped_review_package` is now
`generate_review_package`, shared by Multi Review and the pipeline. P1.8 and D5 still list it as a
built-in that "stays on its engine". Done here: `looped-review.ts` describes the flow as it last
ran (from the code before #1417), and the index marks its engine `retired`
(`GraphBuiltInTemplate.engineStatus`), so 110/214 can show it and offer only "Duplicate", never
"Run". Pins can only reach what survives: its result kind (`review-reconciliation`, whose schema
the template's type must equal), the pool schema, and the retirement itself (`RETIRED_LEGACY_STORES`
and `retireLoopedReviewsMigration`; reviving the engine fails the test until the status changes).
The maintainer should decide whether Looped Review stays a built-in (plan P1.8 and D5 need a line
either way).

**2026-10-29 · Files and exports.** Protocol (browser-safe, one new package export
`./graphs/builtins`): `graphs/builtins/index.ts` (`GRAPH_BUILT_IN_TEMPLATE_IDS`,
`graphBuiltInTemplates()`, `graphBuiltInTemplate(id)`, `isGraphBuiltInTemplateId`,
`GraphBuiltInTemplate {id, engine, engineStatus: active|retired, template (fresh copy), stages}`
where `stages` maps every node id to the engine stage or decision it describes),
`multi-review.ts` (`multiReviewBuiltInTemplate`, `MULTI_REVIEW_TEMPLATE_STAGES`),
`build-pipeline.ts` (`buildPipelineBuiltInTemplate`, `BUILD_PIPELINE_TEMPLATE_STAGES`,
`BUILD_PIPELINE_TEMPLATE_ROUNDS`, custom types `pullRequestStateType()` and
`criterionResultType()`), `looped-review.ts` (`loopedReviewBuiltInTemplate`,
`loopedReviewTemplate(allowance)`, `loopedReviewRoundAllowances`, `nextLoopedReviewAllowance`,
`loopedReviewTemplateStages`, types `findingPoolType()` and `reviewReconciliationType()`),
`support.ts`. Template ids equal the engines (`multi-review`, `build-pipeline`, `looped-review`),
revision `GRAPH_BUILT_IN_TEMPLATE_REVISION` = 1; the §9.1 example in `examples.ts` keeps the id
`multi-review` too, but as an example, not a built-in. Backend engine tables (new):
`build-pipeline-stages.ts` and `multi-review-steps.ts`. Tests: protocol
`graphs/builtins/{builtins,multi-review,build-pipeline,looped-review}.test.ts`, backend
`graph-builtin-templates.test.ts`, one case in `graphs/compile.test.ts`.

**2026-10-29 · Compile result.** Under default compile options all three compile with no
diagnostics at all (no errors, warnings or info), `launchable: true`, no pending
acknowledgements; so does `loopedReviewTemplate(n)` for every starting allowance 1–10. Worst-case
agent sessions: Multi Review 36 (= `multiReviewWorkEstimate` at 32 reviewers with auto-fix and
auto-PR), Build Pipeline 114 (Build + 3 rounds × (Fix, Prepare, 32 reviewers, Consolidate,
Address, Verify) + Ship + conflicts), Looped Review 33.

**2026-10-29 · How the pins work.** The engines had no tables for most of these facts, so they now
read them from small exported ones, and the tests read the same ones:
- `BUILD_PIPELINE_STAGES` (`build-pipeline-stages.ts`): stages in run order with `round`
  (before/every/later/after), `turn` (`write`, `read-only`, `guarded`, `system`), `result`, `only`
  (panel or preparation session) and `session` (phase, build phase, label). The supervisor now takes
  `SESSION_LABELS`, `sessionPhaseFor`, the restart phase (`buildPhaseForSessionPhase`),
  `workflowResultKind`, `readsReviewPackage` (`turn === "read-only"`), the Verify baseline
  (`turn === "guarded"`), the preparation session label and the panel's reviewer and
  consolidation result kinds and consolidation turn (`buildPipelineStageTurn`) from it.
  `usesPackagePreparationSession` replaces five copies of `usesReviewFanout(p) ||
  p.reviewPreparation`. `DEFAULT_BUILD_PIPELINE_ITERATIONS` (3) replaces the lifecycle literal.
- Exported decisions the engine itself calls: `verificationPassed` and
  `pullRequestNeedsConflictResolution` (+ `PULL_REQUEST_DETECTION_STATES`) in
  `build-pipeline-service-helpers.ts`; `multiReviewAutoFixDue` and `fixResultCompletes` in
  `multi-review-auto-pr.ts`; `reviewFanoutReviewerMode` and `REVIEW_FANOUT_FAN_IN` (the fan-in
  rule `{all-settled, minSuccessful 1, includeFailures}`) in `review-fanout.ts`.
- `multi-review-steps.ts`: `MULTI_REVIEW_STAGE_KEYS`, `MULTI_REVIEW_STEP_TURNS` (result kind and
  read-only per structured step), `MULTI_REVIEW_REVIEWER_RESULT_KIND`, `MULTI_REVIEW_INTERACTIVE_FIX`
  (build mode, interactive policy); the service and the Fix dispatch read them.
- The backend test compiles each template and compares the plan with those: node set and stage
  order (per round, via the stage map and the plan's loop `members`/`laterOnly`), result kinds
  (through each output type's `resultKind`; a review report with provenance stands for
  `consolidated-review`, whose schema must equal `review-report@1`'s and whose provenance mode
  must equal `REVIEW_CONSOLIDATION_PROVENANCE.mode`), turns (compiled `readOnly` and workspace
  access against `turn`, plus `executionModeForSessionPhase`, `executionModeOverrideForPhase`,
  `readsReviewPackage`), routing (a small route simulator over the plan, gates evaluated with
  104's evaluator and edge transforms applied, against `stageAfterReview`, `verificationPassed`,
  `pullRequestNeedsConflictResolution`, and Multi Review's `multiReviewAutoFixDue` /
  `queueCleanReviewAutoPr` / `queueAutoPr` over every combination of auto-fix, auto-PR, report and
  Fix completion), bounds (`DEFAULT_BUILD_PIPELINE_ITERATIONS`, `MAX_BUILD_PIPELINE_ITERATIONS`,
  panel `fanOut.max` = 32, collect = `REVIEW_FANOUT_FAN_IN`), role sharing (two nodes share a role
  exactly when their stages share a step's settings and instructions: `stepKeyForSessionPhase`,
  `reviewPreparation`, `reviewers[N]`), and role defaults (`multiReviewDefaultRows` and
  `buildPipelineConfiguredDefaults` under three saved-settings scenarios, against the template's
  `defaultsFrom`). The protocol tests pin what the protocol owns: panel caps, the saved
  auto-fix/auto-PR defaults (`resolveMultiReviewSettings`), the launcher's work estimate, lens and
  instruction fields, the verdict criterion schema, the review pool and reconciliation schemas.
- **Demonstrated.** Each side was mutated in a scratch edit, the tests run, then the edit reverted
  (31 mutations, script outside the repo). Every one failed except one that is not a behaviour
  change. Engine side: Verify turn `guarded`→`write`; Address result → none; `stageAfterReview`
  ignoring gaps; `verificationPassed` ignoring failed criteria; unknown mergeability as a
  conflict; default iterations 3→4; fan-in needing 2 reports; Multi Review consolidation
  writable; auto-fix ignoring the setting; Multi Review Fix model ignoring `fixReviewIssues`;
  pipeline Verify ignoring its action default; a renamed stage; reviewer cap 32→16; saved
  auto-fix default on; reconciliation result schema changed; Fix under its own step; reviewer
  mode `build`. Template side: consolidation `accountForAll`; Fix not interactive; findings gate
  ignoring gaps; auto-fix default on; 4 rounds; Verify as a writer; Ship defaults from `review`;
  panel cap 16; ship gate ignoring failed criteria; conflicts on unknown mergeability;
  consolidation under another role; reconciliation outcomes dropped; Review with the verifier
  profile. The exception: dropping Fix's `when: run.iteration > 1` changes nothing, because Fix's
  inputs come only from carries, so the compiler already makes it later-only (the `when` stays, as
  in report §9.2, and the test pins `laterOnly` and the route on iterations 1 and 2).

**2026-10-29 · Decisions.**
- **Provenance `cite`, not `accountForAll` (103's question).** Today's consolidation contract
  (`validateConsolidationContext`, now `REVIEW_CONSOLIDATION_PROVENANCE`) checks that every cited
  ID exists and every finding cites at least one; it lets the consolidator leave a source finding
  out. `accountForAll` on `review-report@1` (no `dropped` list) would mean "cite every source",
  stricter than the engine. Both built-ins use `cite`, pinned to the contract's mode. 301 can move
  to `accountForAll` with a review type that has a `dropped` list.
- **Consolidation is a `reviewer`, read node with the package**, not §9.1's `observer`/`none`: the
  engines run it as a read-only report turn that may make targeted reads and that reconciles each
  report's scope against the package. 105's `consolidation` definition now takes an optional
  `package` input and lists `reviewer` among its profiles.
- **Build Pipeline describes the default launch**, a reviewer panel (saved count 2): dedicated
  package preparation and consolidation; Build and Fix submit nothing. With one reviewer the engine
  prepares inside Build/Fix and skips consolidation; the graph model cannot switch topology on
  panel size, so a duplicate run with one reviewer still consolidates one report. 105's `build`
  and `pipeline-fix` definitions now declare their `fix-result` output optional (today's Build and
  Fix turns never submit one); `address-review` and `verify` take an optional `package` input
  (their builders read its recorded validation).
- **Ship and conflicts (D12, 105).** Ship = `describe-pr` (agent, `reviewer`/read,
  `pull-request-description`) + `pr` (`open-pull-request`). Conflict resolution = `resolve`
  (builder agent, `resolve-conflicts`, commits locally) + `push` (`push-branch`). The `has-conflicts`
  gate routes on `pull-request-state@1.hasMergeConflicts`, a custom type in the template mirroring
  `PullRequestDetection`: **207 must have `open-pull-request` report it** (output `state`) beside
  `pr-result@1`. Multi Review and Looped Review use the same describe + open pair.
- **Loop and ship gate.** `firstIterationFrom` on Prepare's `code` (Build in round 1, Fix later),
  carries Verify → Fix. Loop `maxIterations` = `DEFAULT_BUILD_PIPELINE_ITERATIONS` (a literal: the
  engine's per-launch 1–10 is not a template parameter). The `verified` gate after the loop is
  exactly `verificationPassed`: complete and no failed criterion, using an edge `flatten` +
  `filter` into a `list<criterion-result@1>` port. The loop's `until` is
  `verify.verdict.complete == true`, since a loop condition reads ports, not edges, and predicates
  do not enter lists (104): a complete verdict with a failed criterion ends the loop where the
  engine would run another round (the ship gate still refuses it). The test pins exactly this one
  difference. `criteria` (`update-ticket`) records criteria results each round.
- **Role defaults.** `defaultsFrom` is read as: a one-model role takes the first action key with a
  usable saved platform, else the app's default agent; a panel takes one position per key (unset →
  the first key's) then `additionalReviewers` (unset → the first key's). Multi Review: preparer and
  consolidator `[reviewPreparation, review]`, reviewer `[review, review2, additionalReviewers]`,
  fixer `[fixReviewIssues, review]`, describer `[pr]`. Pipeline: builder none (the pipeline's own
  agent), preparer `[reviewPreparation, review]` (one role for preparation and consolidation,
  which share `reviewPreparation`), reviewer as above, fixer `[fixReviewIssues]`, verifier
  `[verify, fixReviewIssues]`, describer `[pr]`, resolver `[resolve]`. 214's launcher should
  implement this reading.
- **Lenses and per-stage instructions** are launch settings bound with each role's model (005,
  006): the template replicates over the panel, not over a fixed lens list, and the built-in prompts
  render panel position, then focus, then instructions. Role descriptions say so; the pins cover
  the engine fields and the role-sharing rule above.
- **Multi Review Fix** is `askHuman: true` (today an ordinary interactive tab) and submits
  `fix-result@1`; a `fix-complete` gate stands for "only proof that the Fix completed queues the
  PR". Parameters `autoFix` and `autoPr` default to the saved settings' default (off).
- **Read-only floors.** Reviewer-profile nodes keep D4's default floor (`provider-configured`), so
  a duplicate on the graph runtime hides Grok for them; the engines still accept Grok reviewers.
  Verify has no floor (as in 107's §9.2 fixture).

**2026-10-29 · What the templates cannot say (engine behaviours, documented in node
descriptions).** Single-reviewer topology (above); the review-session transcript handed to Address;
ticket images; a Fix that leaves the worktree unchanged pausing the pipeline; the pipeline failing
when conflicts remain after resolution, and waiting while mergeability is unknown; Multi Review
skipping the PR when the environment already has one; a Fix the user starts by hand after an
auto-PR-only launch; coordinator launches turning `autoFix` on with `autoPr`. Looped Review: the
engine applied each reconciliation to the pool itself (the template's reconcile turn also submits
the resulting pool), prepared packages from a `review-preparation` result (the template uses the
validation-plan + seal path), and failed on an incomplete Fix (the template's gate just stops);
rounds are unrolled because loops do not nest (107), so a starting allowance other than 6 is
`loopedReviewTemplate(n)`.

**2026-10-29 · Open box.** "Done when" stays unticked until the PR merges; the templates are
pinned now.

**2026-10-29 · Compiler change (107).** `output-unused` no longer reports a port that a loop's
`until` reads (`<node>.<port>`): that port decides the loop. Looped Review's
`reconcile.reconciliation` is read only there. Test in `compile.test.ts`.
- 2026-10-29 (coordinator): registered in 109's built-in registry (`builtin-registry.ts`); the library lists all three with `engineStatus`, and refuses to launch them as graphs (`engine-template`).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Three built-ins with `engine`, engine stage tables and exported decisions, pinning tests (mutation-checked on both sides); Looped Review described as retired. · complete; awaiting PR (maintainer to confirm Looped Review stays a built-in)
