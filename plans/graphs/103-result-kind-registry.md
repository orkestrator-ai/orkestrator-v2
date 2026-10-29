---
id: 103
title: "Result-kind registry"
phase: 1
plan: "P1.3"
status: not-started
depends_on: [001]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `apps/backend/src/core/workflow-result-registry.ts`: kind → `{schema, validator?, contextValidator?, toolName, acceptanceChecks[]}`. Existing kinds register themselves; `workflowResultJsonSchema` and `validateWorkflowResult` delegate to it.
- [ ] A `graph-output` kind whose schema and tool name come from the slot (`WorkflowResultSlotInput.schema` plus a new `toolName`).
- [ ] Per-port `submit_<port>` and `validate_<port>` tools in `workflow-result-tools.ts`.
- [ ] A provenance validator driven by the plan (`cite`, `accountForAll`) that reproduces today's consolidation context check for review kinds.
- [ ] Keep `WORKFLOW_RESULT_KINDS` and the transport rollout (`workflow-result-rollout.ts`) compatible.

## Tests

- [ ] `workflow-result-conformance.test.ts` and `workflow-result-tools.test.ts` pass without modification.
- [ ] New tests: `graph-output` slots, per-port tool names, provenance validation on a non-review type.

## Done when

- [ ] The registry change is behaviour-neutral for existing kinds, and `graph-output` slots work end to end with a fake provider.

## Notes

- Depends on [001](001-pipeline-reviewers-read-only.md) because both change acceptance-check registration.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
