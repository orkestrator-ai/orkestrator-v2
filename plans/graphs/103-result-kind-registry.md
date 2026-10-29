---
id: 103
title: "Result-kind registry"
phase: 1
plan: "P1.3"
status: in-progress
depends_on: [001]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-103-registry"
pr: ""
updated: 2026-10-29
---

# 103 · Result-kind registry

- **Plan:** [P1.3 Result-kind registry](../composable-graphs.md#p13-result-kind-registry)
- **Decisions:** D8
- **Depends on:** [001](001-pipeline-reviewers-read-only.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Result kinds become a registry, so graph output ports can declare their own schema and submit tool without editing enums and `switch` statements.

## Work

- [x] `apps/backend/src/core/workflow-result-registry.ts`: kind → `{schema, validator?, contextValidator?, toolName, acceptanceChecks[]}`. Existing kinds register themselves; `workflowResultJsonSchema` and `validateWorkflowResult` delegate to it.
- [x] A `graph-output` kind whose schema and tool name come from the slot (`WorkflowResultSlotInput.schema` plus a new `toolName`).
- [x] Per-port `submit_<port>` and `validate_<port>` tools in `workflow-result-tools.ts`.
- [x] A provenance validator driven by the plan (`cite`, `accountForAll`) that reproduces today's consolidation context check for review kinds.
- [x] Keep `WORKFLOW_RESULT_KINDS` and the transport rollout (`workflow-result-rollout.ts`) compatible.
- [x] Environment-dependent validators (`workspace-commit`, `file-list-paths`): a registry hook plus a git-backed implementation installed by the backend.
- [x] Structured-output transport helpers: one combined schema per activation and the split by port (for [204](204-agent-node-executor.md)).

## Tests

- [x] `workflow-result-conformance.test.ts` and `workflow-result-tools.test.ts` pass without modification.
- [x] New tests: `graph-output` slots, per-port tool names, provenance validation on a non-review type.

## Done when

- [x] The registry change is behaviour-neutral for existing kinds, and `graph-output` slots work end to end with a fake provider.

## Notes

- Depends on [001](001-pipeline-reviewers-read-only.md) because both change acceptance-check registration.

**2026-10-29 · Files.** Backend: `workflow-result-registry.ts` (definitions, shared validation path,
`WorkflowResultRegistry` instance), `workflow-result-graph-output.ts` (the `graph-output` kind, slot
builder, combined-schema helpers), `workflow-result-environment-validator.ts` (git-backed hook);
`workflow-result-contracts.ts` now registers the built-in kinds. Protocol (browser-safe, new
exports): `./graphs/output-slots` (tool-name grammar, slot context and guard) and
`./graphs/provenance` (the generic provenance validator). Docs: `agent-engines.md` "Workflow
results through tool calls".

**2026-10-29 · Registry API.** `WorkflowResultKindDefinition {kind, schema(slot), providerSchema?,
toolName(slot), validationToolName(slot), label(slot), structural?, validator?, finalContent?,
contextValidator?, environmentValidator?, prepareSlot?}` where `slot` is
`WorkflowResultSlotView = {schema?, toolName?, context?}`. `registerWorkflowResultKind`,
`registeredWorkflowResultKinds`, `workflowResultKindDefinition(kind)`,
`validateRegisteredWorkflowResult(kind, value, slot)`, `workflowResultProviderSchema(kind, slot)`,
`workflowResultSlotTools(kind, slot) → {submit, validate}`. Per-backend state is
`WorkflowResultService.registry` (`entry(kind)` = definition + `acceptanceChecks[]`,
`addAcceptanceCheck`, `checksFor`, `setEnvironmentValidator`); 001's
`WorkflowResultService.addAcceptanceCheck` delegates to it with unchanged semantics. The registry
is per service instance, not global, so two services never share checks. Byte-identical behaviour
for existing kinds is pinned by the unmodified conformance/tools suites and by
`workflow-result-provenance.test.ts`, which keeps the old `validateConsolidationContext` as an
oracle and compares message for message over the Multi Review evaluation corpus and 14 citation
defects per case.

**2026-10-29 · `graph-output` kind (decision).** Added to `WORKFLOW_RESULT_KINDS` (last), so the
rollout gates it like any kind: the default settings include it, and an operator's explicit
`kinds` list saved before this change does not (graph outputs then use structured output until
the kind is added). Its generic tool is `submit_graph_output`, used by a slot without a port
declaration and by the OpenCode broker (whose tool list is static per environment). Slot fields:
`schema` (the port type's schema; persisted only for this kind), new `toolName` (`submit_<port>`),
and `context: WorkflowGraphOutputContext {type: "graph-output", port, label?, description?,
artifactType, storage? + budgets? (custom types only), choices? (decision), criterionIds?
(verification-verdict), provenance? {mode, fields, droppedField?, sources}}`. `prepare` refuses a
malformed slot (built-in schema mismatch, custom schema outside the subset, provenance field not
an `x-orkestrator-sources` field of the type, `toolName` on a built-in kind). `graphOutputSlotInput
(base, port, typeDefinition, {criterionIds?, sources?})` builds a slot from a compiled port.
Validation: `validateGraphArtifactValue` (budgets, schema, domain), then the placeholder check of
the built-in type's `resultKind`, then provenance.

**2026-10-29 · Tool naming.** `submit_<port>` / `validate_<port>` (`graphOutputToolNames`);
port = `GRAPH_KEY_PATTERN`, ≤ 48 chars, so names stay ≤ 57 chars. Reserved ports
(`GRAPH_OUTPUT_RESERVED_PORTS`): each kind's tool suffix (`review_report`, `graph_output`, …) and
`workflow_result`. **107 must report a reserved output port name and a `list<…>` output type**
(the slot guard refuses both). The tool title is `Submit <port>`; the description names the port,
its type ref and the port description; the input schema is the provider schema
(`x-orkestrator-sources` stripped). `workflowResultInstruction(kind, key, {tools})` names a port's
own tools.

**2026-10-29 · Activation capability (for 204).** `WorkflowResultService.activationCapabilityToken
(scope, resultKeys)` (2–16 distinct graph-output keys; the keys joined by `_`, then env + project + HMAC,
domain-separated from the single-key token; ~730 chars for UUID ids, under the codex bridge's
1,024 bound) and `authenticateActivationCapability(token)`.
`AgentToolsServer.workflowResultActivationConnection(env, project, target, keys)` lists
`validate_<p>`, `submit_<p>` per slot then one `get_workflow_result_status` answering for every
key. One port: the ordinary `workflowResultConnection` gives the same per-port names.
`registerWorkflowResultSlotTools(server, service, scopes[])` is the multi-slot registration.
Bridges are not changed: `parseWorkflowResultTurn` and the bridges' read-only allow lists know only
the kinds' static names, so 204 must teach them per-port names (one turn, several tools) before
graph nodes run read-only on Claude, Codex or OpenCode.

**2026-10-29 · Provenance validator.** `validateGraphProvenance(value, plan, sources, wording?)`
with `GraphProvenancePlan {mode, fields: [{segments, sourceClass?, minCitations?, derivedFields?}],
droppedField?}` and `sources: Record<id, class>`. `cite`: every cited ID exists (and has the
field's class). `accountForAll`: every source is cited or listed in the top-level `dropped`
(`[{id, reason}]`, `graphProvenanceDroppedSchema()`); codes `unaccounted_source`, `conflict`,
`duplicate`, `missing_field`. `graphProvenancePlanForSchema(mode, schema, sourceFields?)` derives
a plan. Review consolidation = `REVIEW_CONSOLIDATION_PROVENANCE` + `REVIEW_CONSOLIDATION_WORDING`
in the contracts module. **Issue for 108/301:** `review-report@1` has no `dropped` list, so the
§9.1 example's `provenance: accountForAll` on the consolidator means "cite every source", which
is stricter than today's consolidation (it may drop findings silently). 301 should either use
`cite` with the review plan above, or a review type with a `dropped` list.

**2026-10-29 · Environment hook (for 201/207).** `WorkflowResultEnvironmentValidator =
({attempt, validator: "workspace-commit" | "file-list-paths", value}) => Promise<issues>`,
installed with `WorkflowResultService.setEnvironmentValidator`; it runs after every pure check, on
validation and before the submission transaction (applied only to the digest it judged). Issues
spend a correction; a throw or a missing hook refuses with `storage_unavailable` /
`lookup_or_resubmit` and spends none (fail closed). The backend installs
`gitEnvironmentValidator(createPipelineEnvironmentGit(...))` (local and container):
`workspace-commit` checks `headRef` exists and is reachable from `refs/heads/<branch>` and
`baseRef` is an ancestor (`unknown_commit`, `unknown_branch`, `not_reachable`, `not_ancestor`);
`file-list-paths` checks each path is a pathspec inside the worktree, i.e. not through a symlink
(`git check-ignore --no-index`, batched, `outside_worktree`); missing files are allowed. Still for
201: `validation-plan`'s "headRef equals the validated HEAD" and the review package hash check.

**2026-10-29 · Structured output (for 204).** `graphOutputCombinedSchema(ports[{port, schema,
required, description?}])` → one object, every port required, optional ones nullable, annotations
stripped. `splitGraphOutputCombined(ports, value) → {ok, outputs[{port, value}], omitted} | {ok:
false, issues}` checks only the envelope; submit each value to its slot, and map slot issues back
with `graphOutputPortIssues(port, issues)` (`$.brief.title`).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Registry, `graph-output` kind with per-port tools and activation capability, generic provenance validator (review consolidation delegates), environment hook with git-backed checks, combined-schema helpers, docs and tests. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Behaviour-neutral check for the Phase 1 exit: `git diff --stat c253f0b01 HEAD` over `apps/backend/src/core/workflow-result-conformance.test.ts` and `workflow-result-tools.test.ts` is empty, and both suites pass unchanged (48 pass, 0 fail). · complete; awaiting PR
