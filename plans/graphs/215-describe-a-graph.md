---
id: 215
title: "\"Describe a graph\""
phase: 2
plan: "P2.15"
status: in-progress
depends_on: [103, 107, 212]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-215-describe"
pr: ""
updated: 2026-10-29
---

# 215 · "Describe a graph"

- **Plan:** [P2.15 "Describe a graph"](../composable-graphs.md#p215-describe-a-graph)
- **Decisions:** D1, D6
- **Depends on:** [103](103-result-kind-registry.md), [107](107-compiler.md), [212](212-editable-designer.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users can describe a graph in words and get a valid draft in the designer.

## Work

- [x] A built-in agent flow that submits a `graph-template` artifact whose schema is the template schema.
- [x] Compiler diagnostics fed back as repair prompts through the existing repair loop.
- [x] The result opens in the designer as an unsaved draft and never runs until the user saves it.
- [x] Not exposed to the coordinator (D6).
- [x] Designer UI: "Describe a graph" dialog (description, model picker, "Modify the current draft"), progress that rehydrates from the backend, errors shown.

## Tests

- [x] A fake provider's invalid draft is repaired using the diagnostics.
- [x] A draft cannot be launched before it is saved.
- [x] The coordinator's tool set has no describe or authoring tool.
- [x] Component tests for the dialog and the designer integration.

## Done when

- [ ] "Describe a graph" produces compiling drafts in the designer.

## Notes

**2026-10-29 · Shapes and files.** Protocol (browser-safe): `graphs/describe.ts`
(`GRAPH_TEMPLATE_RESULT_KIND`, `GRAPH_DESCRIBE_BOUNDS`, `graphTemplateJsonSchema()`,
`graphTemplateResultIssues(value, context?)`, `GraphTemplateResultContext {type: "graph-template",
providers, ceiling?}`, `graphTemplateResultContextProblem`, `GraphDescribeJobView`,
`GraphDescribeStartInput`) and `graphs/describe-prompt.ts` (`renderGraphDescribePrompt`,
`graphDescribeModelText`, `graphDescribeExamples`); both exported from the package. Result kind
`graph-template` added last to `WORKFLOW_RESULT_KINDS` (tool `submit_graph_template`, validation
through `validate_workflow_result`; bridges pick it up from the list), registered in
`workflow-result-graph-template.ts`; the slot context is a new member of
`WorkflowResultSlotInput.context` accepted by `validContext`. Resource kind `graph-describe` (id =
environment). Backend: `graph-describe-service.ts` (`GraphDescribeService`, `GraphDescribeError`,
`parseGraphDescribeStartInput`), `graph-describe-host.ts` (the `AgentBranchHost`),
`storage-graph-describe.ts` (store `graph-describe`, one row per environment, owned by it and deleted
with it; `storage.graphDescribe`), `commands-registry-graph-describe.ts` (`graph_describe_start`,
`_status`, `_cancel`, `_dismiss`), wired in `index.ts`. Web: `lib/backend/graph-describe.ts`,
`stores/graphDescribeStore.ts`, `GraphDescribeDialog.tsx`, `GraphDescribeControl.tsx` (in the
designer header). Docs: `docs/architecture/graphs.md` "Describe a graph", `storage.md` row.

**2026-10-29 · Decisions.**
- *Schema approach: tool transport.* The template cannot be expressed in the strict structured-output
  subset (optional fields everywhere, recursive predicates, open custom-type schemas and system
  params), so `graphTemplateJsonSchema()` is a portable tool-input schema (no `$ref`, depth and size
  within the portability test, enums for kinds/actions/profiles, open objects for predicates, type
  schemas, params and layout). The kind's `structural` hook replaces the JSON-schema walk with the
  template guard, and its `validator` runs the authoring rules and `compile()` errors under the
  slot's context. A job starts only when the result-tool rollout admits `graph-template` for the
  chosen agent (every qualified provider today); there is no structured-output fallback.
- *Authoring rules beyond the compiler:* a draft with `acknowledgements`
  (`acknowledgement-not-allowed`, only the user accepts a warning, D4) or `engine`
  (`engine-not-allowed`) is refused. Sub-graph and `items` replicate are not offered by the schema.
- *Repair loop:* in-turn, each refused submission returns `{code, path, message}` per guard or
  compiler error and spends the slot's rejection budget (4); an exhausted slot becomes a contract
  failure and the runner sends a repair turn with a fresh slot (`AGENT_BRANCH_MAX_SCHEMA_REPAIR_ATTEMPTS`,
  3), whose prompt lists the problems and points at `validate_workflow_result`. The exhausted slot
  keeps no payload, so that repair turn cannot quote the last diagnostics; the agent gets them again
  from validation.
- *Session:* the designer tab's own environment (must be running), read-only `plan` turn,
  `automated-review` policy, reviewer session, unattended interactions. Reuses `AgentBranchRunner` and
  `GraphAgentProviders` (a separate instance).
- *Examples:* only the §9 examples that compile today (§9.1, §9.2), layout and acknowledgements
  stripped, within 16 KiB. The draft to modify (≤ 64 KiB, need not pass the guard) and the
  description (≤ 8000 chars) sit in `<orkestrator-evidence>` frames.
- *Opening:* a completed job opens via `openDraft(tabId, template, projectId)` the first time an
  active designer tab sees it (asking first over unsaved edits), then the job is dismissed; otherwise
  the header offers "Open described draft". Unsaved drafts cannot launch
  (`GraphTemplateService.compile({template}, {forLaunch: true})` and `compileForLaunch` of an unsaved
  id both refuse).
- *D6:* app commands only; no public action, `run_action` or Control MCP tool reaches them.

**2026-10-29 · Remaining.** "Done when" stays open: the flow is proven with a fake provider over
the real workflow result service and agent tools server (MCP), but not yet with a live model in an
isolated `dev:test` profile; that run (describe → compiling draft in the designer) needs the
real-stack procedure in `docs/development/agent-testing.md` and live credentials.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Result kind, backend job service, prompt, designer dialog and tests; work and test boxes ticked. · Live-model run in a dev:test profile for "Done when".
