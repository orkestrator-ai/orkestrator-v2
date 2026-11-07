---
id: 7007
title: "Convert build pipelines, graphs and Multi Review"
phase: 7
plan: "§12 Phase 7 and Appendix E"
status: done
depends_on: [1008, 1010, 1011]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7007 · Convert build pipelines, graphs and Multi Review

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** L
- **Track:** C (contract)

## Domains

`pipelines`, `graphs`, `multi-review`.

## Current state (verified 2026-11-07)

- Build pipelines and graphs: 76 registered, 70 web. Multi Review: 30 and 27.
- Graph templates and runs already have strict hand-written guards in `packages/protocol/src/graphs/`. Reuse them as schemas, or wrap them in custom schema refinements; do not duplicate them.
- `NAMED_NODE_READ_COMMANDS` (`graph_run_get`, `graph_runs_list`) shows the read classification is not purely by name. Set `read` explicitly.

## Work

Apply the conversion checklist from [1011](1011-contract-policy-and-docs.md)'s "Domain contracts" docs to every command in the domains above:

- [x] Define each domain at version 1 (min 1) in `packages/protocol/src/contract/domains/`. (`pipelines`, `graphs`, `multi-review`.)
- [x] `defineCommand` for every command, with:
  - `args` and `result` schemas;
  - `access` (workspace, admin or internal), seeded from [0006](0006-grant-scope-live-evidence.md)'s observed list and today's deny-lists;
  - `read`, checked against `isNodeReadCommand`;
  - `critical` fields, with a one-line reason each in Notes.
- [x] Switch handlers to `register(def, handler)`.
  - Lenient handlers stay tolerant.
  - Strict (`assertOnlyKeys`) handlers become tolerant-with-critical.
  - Hand-written `commands-validation.ts` parsing is replaced by the schema where it is equivalent; keep user-facing error text.
- [x] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires. (None: no command of these domains was capability-gated.)
- [x] Web side:
  - a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - the domain's `lib/backend` functions call it;
  - typed results replace `invoke<T>` casts.
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)). Open: the backend's `PersistedBuildPipeline` is now the protocol's `BuildPipelineRecord`, the one exact match. The graph types were protocol types already. `PersistedMultiReviewWorkflow` carries the controller lease the reads strip, and the web's `PersistedBuildPipeline<T>`/`PersistedWorkflowRecord<T>` are generic over the snapshot, so neither matches; `asWebModel` marks each web cast. Left to 7010. Closed 2026-11-07 (orchestrator): 7010 made `BuildPipelineRecord` and `MultiReviewWorkflowRecord` the protocol records; the web's `PersistedBuildPipeline<T>`/`PersistedWorkflowRecord<T>` are views of them and the backend's `PersistedMultiReviewWorkflow` is the record plus the lease (7010 Notes, "Workflow envelopes").
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows. (`graphs`, `pipelines`, `multi-review`; pass against this checkout and v2.36.1, both topologies.)
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls. (`graphs` 39, `pipelines` 35 and `multi-review` 30 to 0.)


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal). Open: the build pipeline and Multi Review suites pass unchanged; three graph suites have edits outside that exception (Notes, "Test edits"). Closed 2026-11-07 (orchestrator), with this recorded deviation: the graph launch fakes returned incomplete shapes the real code never sends, which result validation in tests now refuses, and two hand-made test registrars now key by the definition's name. Neither changes a handler's behaviour; the same rule was applied to 7001 (by 7010), 7003 and 7005.
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments. (`mise run contract:ci` passes; no in-window snapshot has these definitions yet, so 0 fixtures.)

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them. (Every web call site goes through `pipelines(client)`, `graphs(client)`/`graphsOn` or `multiReview(client)`; the two remaining name strings are `incompatibility(error, command)` checks.)

## Notes

### Scope (2026-11-07)

- **104 commands**: the manifest's `pipelines` (35: `commands-registry-build.ts` and `commands-registry-workflow-results.ts`, including `set_environment_unread`, which 1006 placed here with its registering file), `graphs` (39: `commands-registry-graphs.ts`, `-graph-runs.ts`, `-graph-sharing.ts`, `-graph-describe.ts`, `-graph-launch.ts`, `-graph-mock.ts`) and `multi-review` (30: `commands-registry-reviews.ts`). The controller and coordinator workflow launches (`launch_multi_review`, `start_controller_build_pipeline`, ...) are the `coordinator` domain's.
- Files: protocol `contract/domains/{pipelines,graphs,multi-review}/` (domain, schemas, commands, client, index, tests; graphs splits its commands into `commands-templates.ts`, `commands-runs.ts`, `commands-launch.ts`), three subpath exports, the clients in `DOMAIN_CLIENTS`; backend the registrars above; web `lib/node-scope/domains/{pipelines,graphs,multi-review}.ts` and `lib/backend/{build-pipelines,multi-reviews,graph-*,launches,workflows}.ts`; scenario modules `scripts/mixed-version/scenarios/{graphs,pipelines,multi-review}.ts`.

### Where Effect is used (2026-11-07)

- **Effect Schema** for all 104 definitions and their result shapes, with 1001's rules. Records are `modelRecord<T>()` (7004's `contract/model-schema.ts`): declared fields are checked, every other key passes through, typed as the protocol interface. The graph guards run as `Schema.makeFilter` refinements (`guardedRecord`).
- **Deliberately not Effect:** the domain clients are promise adapters over 1009's `createDomainClient` (`commandApi`/`legacyCommandApi`, as 7002); the handlers keep their own validators and coded errors.

### Decisions (2026-11-07)

- **Graph guards reused, not duplicated (1001's "existing code is converted or bridged").** Options: (a) `Schema.declare` over `isGraphRun`/`isGraphTemplateV1`, strict; (b) a tolerant refinement over the guards' field errors; (c) a hand-written Effect schema of the whole template and run. (a) refuses a newer backend's added field or status in a client decode (the guards' `checkObject` refuses unknown fields, `checkEnum` values outside their lists), breaking the tolerant reader; (c) duplicates 45k lines of guards. Chosen (b): `guardedRecord(record, validate, expected)` in `domains/graphs/schemas.ts` runs `validateGraphTemplate` (template detail, describe draft, import and share-import results) and `validateGraphRun` with `verifyPlan: () => true` (the `changed` run and the restart/rewind run) and fails only on an error whose code is not in `FORWARD_COMPATIBLE_GUARD_CODES` (`unknown_field`, `enum`); errors behind a guard's cap pass. The plan digest check is the backend's integrity check on load, not a reader's. Not used: `validateGraphArtifact` (the artifact view sends the envelope without the `body` the guard requires) and `isGraphCapabilityCeiling` (its issues carry no codes, so an addition cannot be told from a break; the ceiling is a two-field record). No Zod remains in these domains (the graph guards were hand-written, not Zod).
- **The build pipeline and Multi Review guards are not used in a decode.** `isBuildPipeline` and `isMultiReviewWorkflow` refuse fields an older client does not know, and the renderer runs them only after `canonicalBuildPipeline`/`canonicalMultiReview` rewrite the Rework and Address Findings vocabulary; a decode before that rewrite would refuse snapshots today's renderer reads. The stored `snapshot` stays `unknown`, as the model types it.
- **Arguments declare every key a handler reads.** Keys read with `asString`/`asNonBlankString`/`asRequiredBoolean` are typed (same text: `Expected pipelineId to be a string`; the handler still refuses a blank one). Keys a protocol guard or a coded validator checks (the start requests, restart selections and models, step kinds, tokens, cursors, detail references, every graph argument, the conditional-read keys, the rollout's `enabled`/`providers`/`kinds`) are `optionalKey(Unknown)`, so codes (`GraphTemplateError`, `GraphRunServiceError`, `GraphAgentQuestionError`, `GraphRunRewindError`, `GraphDescribeError`, `GraphLaunchError`) and text are unchanged. `snapshots` on `import_legacy_build_pipelines` is a typed array (the schema's `Expected snapshots to be an array` is the handler's text). The start requests also declare the newer vocabulary's key names (`autoAddressFindings`, `addressFindingsModel`), which `canonicalMultiReview` rewrites before its guard runs. `graph_run_launch` declares `template` and `requestedBy` so `parseGraphLaunchRequest` still refuses them (dropped silently, a launch would run the stored template, or accept a caller-chosen origin).
- **Strict handlers made tolerant:** every graph handler's `onlyKeys`/`Unknown arguments` refusal is gone; the start and step-control guards' `hasOnlyKeys` now never sees an undeclared key. `parseGraphDescribeStartInput` keeps its own unknown-key check (unit-tested directly), which the command no longer reaches.
- **Result schemas** are derived from the protocol types (`BuildPipeline`, `BuildPipelineCodeRewindPreview`, `CreateFeatureBuildResult`, `StartFeaturePlanBuildResult`, `WorkflowResultToolsSettings`, `MultiReviewWorkflow`, `MultiReviewReviewerTranscript`, `MultiReviewStepTranscript`, `MultiReviewReviewerHistoryPage`, `ReviewValidationRun`, `ReviewValidationOutput`, the graph library, sharing, describe, launch, run-view, run-rewind and run-human types) and the stored envelopes (`BuildPipelineRecord`, `MultiReviewWorkflowRecord`). Conditional reads are unions (`get_build_pipeline`: `null`, `unchanged`, record with message patches, record; `list_*`: records, delta, or a manifest-conditional snapshot). Shared parts come from other domains: `NullableProjectionSchema` and `ToolDetailsSchema` (native-sessions), `KanbanTaskSchema` (kanban), `ClientEnvironmentSchema` (environments). Fields are optional apart from identity and discriminators, because the supervisors and storage are faked in tests with partial records (`{ operation: "start", input }`, `{ id: "pipeline-1" }`) and results are validated there; a present field is still type-checked (7001's convention). Which fields are always present converges in 7010.
- *(2026-11-07, orchestrator, completeness check: [7012](7012-allow-listed-grants.md) reclassified `graph_capability_ceiling_set` `workspace` → `admin` (`17577083d`): it was in `WORKSPACE_ADMINISTRATION_COMMANDS`, which the "none is in the workspace deny-lists" here missed.)* **`access`**: `workspace` for every command the web calls (none is in the workspace deny-lists; 0006's observed list includes `list_build_pipelines`, `list_multi_review_workflows`, `set_environment_unread`), `admin` for the workflow result rollout (`get_workflow_result_metrics`, `get_workflow_result_tools_rollout`, `set_workflow_result_tools_rollout`: backend-owned operational settings, no client caller), `internal` for `start_review_validation`, `status_review_validation`, `cancel_review_validation` (the supervisors' in-process `invoke`).
- **`read`** is what the command does, and `isNodeReadCommand` was brought into line rather than the other way round, because routing reads the classifier: `NAMED_NODE_READ_COMMANDS` gained the graph reads whose verb is not first (`graph_templates_list`, `graph_template_get`, `graph_template_compile`, `graph_template_export`, `graph_capability_ceiling_get`, `graph_project_template_review`, `graph_run_artifact`, `graph_run_transcript`, `graph_run_pending`, `graph_run_rewind_code_preview`, `graph_run_effects`, `graph_launch_options`) and the two code rewind previews; a new `NAMED_NODE_WRITE_COMMANDS` (`graph_describe_start`, `_cancel`, `_dismiss`) stops the verb rule reading those writes as reads (a behaviour change for routed calls: they now refresh the leaf's summaries, as a write should). `graph_sharing_keys` is a write (`create: true` makes a key). The protocol tests pin `def.read === isNodeReadCommand(def.name)` for all 104.
- **Critical fields**, per field:
  - `requestId` on `create_feature_build`, `graph_run_launch`, `graph_run_restart`, `graph_run_rewind_code`: the idempotency key; ignored, a retry acts twice.
  - `existingEnvironmentId` on `start_build_pipeline` and `launch_build_pipeline`: ignored, the build creates a new environment instead of using the chosen one.
  - `deliveryPolicy` on both build launches and `create_feature_build`: the "When verified" choice; ignored, verification does what the ticket's old policy says.
  - `selection` on `restart_build_pipeline_step`, `model` on `restart_multi_review_reviewer` and `restart_multi_review_step`: "Restart in…"; ignored, the step reruns on the old agent or model.
  - `expectedLastActivityAt` on `set_environment_unread`, `expectedRevision` on `graph_template_save`, `graph_template_delete`, `graph_capability_ceiling_set`: compare-and-swap guards; ignored, a newer activity or another client's write is overwritten.
  - `digest` on `graph_template_duplicate`: a project template is copied at the digest the user reviewed.
  - `value` on `graph_run_answer`: an edit form's edited input; ignored, the unedited value is approved.
  - Not critical: `knownRevision`/`knownSessions`/`prioritySessionKey`/`knownRevisions`/the manifest keys/`knownSourceToken`/`known` (ignored, the answer is fuller), `refreshUsage`, `autoFix`/`autoPr` (ignored, no automatic follow-up), `limit`.
- **Client API**: one function per command keyed by name (`commandApi`); version 0 is today's call by name, answered as sent (`legacyCommandApi`). No capability command exists, so nothing is folded into version 1. The renderer's fallbacks for backends without `launch_build_pipeline` or `start_feature_plan_build` read the `unknown-command` that version 0 passes through.
- **Web binding and the `workflows.ts` split**: `pipelines(client)`, `graphs(client)` (and `graphsOn(client, machine)`, whose machine-aimed client carries no range, so a routed call takes version 0), `multiReview(client)` over `domainApi`. `lib/backend/workflows.ts` (1,981 lines) is split: `build-pipelines.ts` (`createBuildPipelinesApi`, 30 functions) and `multi-reviews.ts` (`createMultiReviewsApi`, 28) hold the moved functions with their own command-scope bindings; `createWorkflowsApi` spreads both and `workflows.ts` re-exports the named functions, so no caller changed. `workflows.ts` is 1,161 lines. The conditional reads keep their own checks of the answer, which a pre-contract node's version-0 answer still needs. `launches.ts`' two build launches go through `pipelines(client)`. In suites the command scope has no negotiated domains, so every existing web test runs the version-0 path, today's call.
- **Register rows** (`version-compatibility.md`): **unaffected**: backends without `launch_build_pipeline` (`useBuildPipeline.ts`) and without `start_feature_plan_build` (`FeaturesView.tsx`), whose `unknown-command` reaches the caller through version 0; the Rework and Address Findings vocabulary (data; the start requests declare both key names); Address sessions without the typed report marker (backend); the hydration batch fallback (`list_environment_hydration`). None retires: every release in the window is pre-contract. No row is mechanical: no behaviour moved into an adapter.
- **Scenario modules**: `graphs` (template library round trip, ceiling, run list), `pipelines` (lists, unknown read, empty legacy import, refused save, unread badge set and cleared at its activity) and `multi-review` (lists, unknown and conditional reads, refused malformed start and history page). No agent turn. Pass with `--old-version current` and `--old-version latest-stable` (v2.36.1), both topologies.
- **Test edits** (outside "unchanged"): `commands-registry-graph-launch.test.ts`'s fakes answered a `GraphLaunchResult` without `template` and `{ launchable: true }` for `GraphLaunchOptions`; result validation in tests refused them, so they now answer complete shapes. `graph-run-rewind.test.ts` and `graph-node-agent-questions.test.ts` build a hand-made registrar keyed by name; it now keys by the definition's `name`. The unknown-key assertions in the graph sharing, mock, runs, templates, human and rewind suites assert the key is dropped (the exception). The build pipeline and Multi Review suites are unchanged (their partial fakes are why those result fields are optional). Web: `factories.test.ts` counts 38 `lib/backend` files (the two new ones).
- **Work split**: the graphs part was done by a forked sub-agent of this item before the orchestrator's "no sub-agents" rule reached it; it committed nothing itself.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): protocol `contract/domains/{pipelines,graphs,multi-review}/` (104 definitions, result schemas, the tolerant graph guard refinement, clients with adapters 1 and 0, tests), subpath exports, clients in `DOMAIN_CLIENTS`, `NAMED_NODE_READ_COMMANDS`/`NAMED_NODE_WRITE_COMMANDS`; backend registrars on `register(def, handler)`, their 104 `contract-domain-map.ts` entries removed, `PersistedBuildPipeline` aliased to `BuildPipelineRecord`; web domain bindings and every call site, `workflows.ts` split into `build-pipelines.ts` and `multi-reviews.ts`; scenario modules; docs (`version-compatibility.md` Client adapters bullet, `command-nodes.md` classifier). Commits: 14b70b425 (graphs), d6584fc4a (pipelines and multi-review, manifest: untyped 106 to 5 with the other Phase 7 agents' definitions), cf9061290 (scenario modules), and the docs/bookkeeping commit. Tests: protocol `graphs.test.ts`, `pipelines-multi-review.test.ts`, `command-nodes.test.ts` pass; backend: the 41 suites naming these commands 1195 pass / 8 fail, none from this item (`get_projects` result, bridge readiness, PR monitor, config and Cursor key suites, the renderer adapter-usage count: other domains mid-conversion), and the graph suites 66 pass; an (accidental) full backend run showed no other failure from this item; web: the 32 suites naming these commands or the moved functions pass apart from 12 `ActionBar.test.tsx` cases that expect `requestPaneTabActivation` without the scope argument the pane-layout store conversion added (not this item), and an earlier full web run had only this item's `factories.test.ts` count, since fixed. `mise run contract:check` and `mise run contract:ci` pass. Mixed-version `graphs`, `pipelines`, `multi-review` pass against this checkout and v2.36.1, both topologies. Protocol, backend and web typecheck clean in this item's files; oxlint and `bun fmt` clean. Open: 7010 model convergence and the graph test edits (Notes).
- 2026-11-07 (orchestrator): closed the shared-types box (7010 converged the records) and the tests box (test-data fixes only, recorded as a deviation); status done.
- 2026-11-07 (orchestrator, completeness check): recorded 7012's reclassification of `graph_capability_ceiling_set` to `admin` beside the stale `access` note.
