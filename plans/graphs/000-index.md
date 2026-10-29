# Graphs plan: work items

Status board for [`plans/composable-graphs.md`](../composable-graphs.md). Each
work item has its own file, and the file's front matter is where its status
lives. This index mirrors it. Read [AGENTS.md](AGENTS.md) before starting or
updating an item; `tests/unit/graphs-plan.test.ts` fails when a file and its
row disagree.

An item is **ready** when every item in its *Depends on* column is `done`.
Statuses: `not-started`, `in-progress`, `blocked`, `done`, `dropped`.
Status changes reach `main` with the pull request that does the work, so this
board shows merged work. To see work in flight, search open pull requests for
the item ID (`gh pr list --search "graphs 107"`).

## Phase 0: parameterise today's flows and fix the findings

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 001 | [001-pipeline-reviewers-read-only.md](001-pipeline-reviewers-read-only.md) | 0 | in-progress | — | Build Pipeline reviewers get plan mode and `readOnly`; a reusable git guard refuses commits; acceptance checks become a list per kind. |
| 002 | [002-iteration-limit.md](002-iteration-limit.md) | 0 | in-progress | — | Coordinator `launch_build` uses `MAX_BUILD_PIPELINE_ITERATIONS` instead of a literal 20. |
| 003 | [003-panel-review-routing.md](003-panel-review-routing.md) | 0 | in-progress | — | A clean consolidated report skips Address on the panel path, as on the single-review path. |
| 004 | [004-typed-address-report.md](004-typed-address-report.md) | 0 | in-progress | — | Address submits a `fix-result`; Verify reads it instead of the last assistant text, with a fallback for old runs. |
| 005 | [005-reviewer-lenses.md](005-reviewer-lenses.md) | 0 | in-progress | — | Per-reviewer focus (`lens`) in Multi Review and the pipeline panel; editable presets in Settings. |
| 006 | [006-pipeline-stage-instructions.md](006-pipeline-stage-instructions.md) | 0 | in-progress | — | `BuildStepConfig.instructions` (≤ 16 KiB) rendered as a framed section in each stage prompt. |
| 007 | [007-cli-build-pipeline-launch.md](007-cli-build-pipeline-launch.md) | 0 | in-progress | 006 | Public `build.*` actions and `orkestrator build launch\|list\|get\|cancel`, with per-step models, instructions and reviewer lenses. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] The pipeline review is read-only on every provider that supports it. The guard refuses a review that commits.
- [x] The coordinator cannot request more iterations than the protocol accepts.
- [x] Clean reports skip Address on both review paths.
- [x] Verify reads a typed Address report for new runs, and still reads old runs. (evidence: [004](004-typed-address-report.md); `apps/backend/src/core/build-pipeline-address-report.test.ts`, "an Address submission reaches the Verify prompt as a framed report" and "a pipeline record from before the upgrade still uses the last assistant text")
- [x] Lenses and per-stage instructions round-trip through launch, record, restart, the coordinator tools and the CLI. Lens presets can be edited in Settings, and editing one leaves recorded reviews unchanged.
  - [x] Lenses: launch, record, restart, coordinator tools and CLI; presets editable in Settings; editing or deleting one leaves recorded reviews unchanged (evidence: [005](005-reviewer-lenses.md) Notes, "Tests").
  - [x] Per-stage instructions through the CLI: `orkestrator build launch --instructions` (evidence: [007](007-cli-build-pipeline-launch.md) Notes, "Tests"; `packages/cli/tests/build-command.test.ts` round trip).
- [x] `build-pipeline-view.md`, `review-preparation.md` and `coordinator.md` match the new behaviour.

## Phase 1: model, compiler and read-only designer

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 101 | [101-template-schema.md](101-template-schema.md) | 1 | in-progress | — | `GraphTemplateV1` and its parts, with hand-written guards and bounds, in `packages/protocol/src/graphs/template.ts`. |
| 102 | [102-type-library.md](102-type-library.md) | 1 | in-progress | 101 | Built-in artifact types mapped to existing schemas, custom `ArtifactTypeDef`, the cross-provider schema subset, schema from example. |
| 103 | [103-result-kind-registry.md](103-result-kind-registry.md) | 1 | in-progress | 001 | Registry replaces the result-kind `switch` statements; new `graph-output` kind with per-port submit tools; generic provenance validator. |
| 104 | [104-predicates.md](104-predicates.md) | 1 | in-progress | 101, 102 | JSON predicate language: operators, typed paths, a total and bounded evaluator. |
| 105 | [105-prompt-templates.md](105-prompt-templates.md) | 1 | in-progress | 101, 102, 106 | Logic-less templates, five render modes, evidence frames, size estimates, lints, the locked system contract. |
| 106 | [106-capability-profiles.md](106-capability-profiles.md) | 1 | in-progress | 101 | Profiles compiled to `NativeAgentExecutionPolicy`, new capabilities, no push for agents, per-provider enforcement matrix. |
| 107 | [107-compiler.md](107-compiler.md) | 1 | in-progress | 101, 102, 104, 105, 106 | `compile()` → frozen plan with digest, diagnostics for every rule in report §7.4, cost estimate, `firstIterationFrom`. |
| 108 | [108-builtin-templates.md](108-builtin-templates.md) | 1 | in-progress | 107, 001, 003, 004, 005 | Multi Review, Build Pipeline and Looped Review described as templates, pinned to their engines by tests. |
| 109 | [109-template-storage-and-trust.md](109-template-storage-and-trust.md) | 1 | in-progress | 101, 107 | `graph-templates` store, project templates with digest trust, per-project capability ceiling, template commands. |
| 110 | [110-canvas-spike-and-read-only-designer.md](110-canvas-spike-and-read-only-designer.md) | 1 | in-progress | 107, 108, 109 | Time-boxed React Flow vs in-house spike; read-only `graph-designer` tab with library, canvas, inspector, compile panel, JSON import and export. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] All three built-in templates compile cleanly. The pinning tests fail when either the engine or the template changes alone (evidence: [108](108-builtin-templates.md) Notes, "How the pins work").
- [x] The result-kind registry change is behaviour-neutral, as shown by the unchanged conformance suites (evidence: `git diff --stat c253f0b01 HEAD` over `apps/backend/src/core/workflow-result-conformance.test.ts` and `workflow-result-tools.test.ts` is empty, and both pass; [103](103-result-kind-registry.md) Progress log).
- [x] Compiler, predicate, prompt and schema-subset modules have unit tests for every diagnostic code (evidence: tables typed by each code list in `packages/protocol/src/graphs/compile-diagnostics.test.ts`, `predicate-typecheck.test.ts`, `predicate-eval.test.ts`, `prompt-diagnostics.test.ts`, `schema-subset.test.ts`; [107](107-compiler.md) Notes).
- [x] The designer shows the built-in templates and imported user templates, with diagnostics pinned to nodes and edges (evidence: [110](110-canvas-spike-and-read-only-designer.md) Notes, "Tests and evidence"; `e2e/agent-testing/graph-designer.spec.ts`).
- [x] The canvas library is chosen and the decision is recorded (evidence: [110](110-canvas-spike-and-read-only-designer.md) Notes, "Spike result"; [`docs/architecture/graphs.md`](../../docs/architecture/graphs.md#canvas-library-decision-spike-2026-10-29)).

## Phase 2: graph runtime and editable designer

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 201 | [201-run-record-and-storage.md](201-run-record-and-storage.md) | 2 | in-progress | 107 | `GraphRun`, `NodeActivation`, `GraphArtifact`; `graph-runs` and `graph-artifacts` stores; reference artifacts on disk with hashes; bounds. |
| 202 | [202-supervisor-domain.md](202-supervisor-domain.md) | 2 | in-progress | 201 | `graph-run` in `KEYED_SCHEDULING_DOMAINS`, obligation classifier, rollback switch, recovery on start. |
| 203 | [203-scheduling.md](203-scheduling.md) | 2 | in-progress | 202 | Ready set, workspace locks, admission through the shared pool and per-provider caps, run limits, observation cadence. |
| 204 | [204-agent-node-executor.md](204-agent-node-executor.md) | 2 | in-progress | 103, 105, 106, 203 | Extract `AgentBranchRunner` from `review-fanout.ts`; per-activation MCP credential with port tools; opt-in `ask_human`; session modes. |
| 205 | [205-replication-and-collection.md](205-replication-and-collection.md) | 2 | in-progress | 204 | `replicate` over panel, lenses and samples (≤ 32); stable branch keys; collect policies; zip edges. |
| 206 | [206-gate-merge-loop-failure.md](206-gate-merge-loop-failure.md) | 2 | in-progress | 104, 203 | Gates with skipped subtrees, deterministic merges (dedupe default), bounded loops with carried ports, retry and `onFailure`. |
| 207 | [207-system-nodes.md](207-system-nodes.md) | 2 | in-progress | 201, 203 | `prepare-environment`, `run-validation-and-seal`, `push-branch`, `open-pull-request`, `wait-for-checks`, `update-ticket`, `notify`. |
| 208 | [208-human-nodes.md](208-human-nodes.md) | 2 | in-progress | 203, 204 | Approve, edit and choose nodes; waiting surfaces in the sidebar, run view and coordinator; optional timeout. |
| 209 | [209-guards-and-enforcement.md](209-guards-and-enforcement.md) | 2 | in-progress | 001, 106, 204 | Read-only guard on read/none nodes, remote-ref guard on every agent node, GitHub credential withheld, `minEnforcement` checks. |
| 210 | [210-restart-and-rewind.md](210-restart-and-rewind.md) | 2 | in-progress | 201, 203, 204 | Restart supersedes exactly the lineage descendants; loop-aware; code rewind reuses the pipeline's. |
| 211 | [211-run-view.md](211-run-view.md) | 2 | in-progress | 201, 204 | `graph-run` tab on `flow-graph/` via `graphRunFlowModel`; inspector with artifacts; actions; rehydration. |
| 212 | [212-editable-designer.md](212-editable-designer.md) | 2 | in-progress | 107, 109, 110 | Canvas editing with undo, inspector forms, prompt and type editors, live compile, safe save, taint acknowledgement. |
| 213 | [213-mock-runs.md](213-mock-runs.md) | 2 | not-started | 204, 206, 207 | `graph-mock-provider.ts` answers from examples, schemas or pinned sequences; zero sessions; side effects only recorded. |
| 214 | [214-launch-surfaces.md](214-launch-surfaces.md) | 2 | not-started | 109, 204, 211 | Generated launch dialog; action bar, Kanban and designer entry points; CLI `orkestrator graph`; Control MCP tools; status wakes; schedules. |
| 215 | [215-describe-a-graph.md](215-describe-a-graph.md) | 2 | not-started | 103, 107, 212 | An agent turns a description into a `graph-template` artifact, repaired against compiler diagnostics, opened as an unsaved draft. |
| 216 | [216-documentation.md](216-documentation.md) | 2 | not-started | 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215 | `docs/architecture/graphs.md` and a user guide, catalogued in `docs/README.md`; related docs updated. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [ ] The design bake-off graph (report §9.3, without the subgraph) runs end to end on at least two providers, from launch to PR. It uses lenses, a judge, a human approval and a system PR node.
- [ ] The failure-diagnosis loop (report §9.4, with a static panel instead of `items`) converges or stops at its bound.
- [x] Restart from a mid-graph node keeps independent branches and supersedes exactly the descendants.
- [x] Code rewind works as it does in the pipeline.
- [ ] A backend restart in the middle of a fan-out recovers without re-dispatching. Interleaving seeds cover activations.
- [ ] Read-only guards refuse a committing reviewer on every provider. Enforcement tiers shown in the UI match the live conformance runs.
- [ ] A mock run of every example template passes with zero provider sessions.
- [ ] The inactive-environment test passes for the run view and human nodes.
- [ ] Multi Review and Build Pipeline suites, benchmarks and interleaving tests are unchanged after the `AgentBranchRunner` extraction.

## Phase 3: Multi Review on the graph runtime

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 301 | [301-multi-review-on-graph-runtime.md](301-multi-review-on-graph-runtime.md) | 3 | not-started | 204, 205, 206, 207, 209, 210, 211, 214 | Run the built-in Multi Review template on the graph runtime behind a setting; prove parity; flip the default; retire the bespoke service. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [ ] Multi Review runs on the graph runtime by default, and the bespoke service is retired or scheduled for retirement.

## Phase 4: extensions

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 401 | [401-items-fanout.md](401-items-fanout.md) | 4 | not-started | 205 | Fan out over the items of a list artifact, bounded by `maxBranches`, with per-item provenance through to fixes. |
| 402 | [402-subgraphs.md](402-subgraphs.md) | 4 | not-started | 107, 204 | Inline templates with namespaced IDs and parameter pass-through; built-in Multi Review usable as a block. |
| 403 | [403-isolated-branch-worktrees.md](403-isolated-branch-worktrees.md) | 4 | not-started | 205, 210 | One worktree per replicated writer branch, then `select` or agent `merge`; lifecycle, disk and container story. |
| 404 | [404-per-node-user-mcp.md](404-per-node-user-mcp.md) | 4 | not-started | 106, 204 | Per-session injection of user MCP servers in every bridge, so `mcp:<server>` can grant as well as deny. |
| 405 | [405-template-sharing.md](405-template-sharing.md) | 4 | not-started | 109 | Export and import with signatures or digests, and a review flow for project templates. |
| 406 | [406-coordinator-authoring.md](406-coordinator-authoring.md) | 4 | blocked | 214, 215 | Coordinator writes templates as drafts under the project-template trust rule. Blocked: D6 defers it. |

## Phase 5 (optional): the Build Pipeline

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 501 | [501-build-pipeline-port.md](501-build-pipeline-port.md) | 5 | not-started | 301 | Optional: port the Build Pipeline only if Phase 3 shows clear benefit. |
