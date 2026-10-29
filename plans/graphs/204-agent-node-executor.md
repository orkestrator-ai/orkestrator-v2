---
id: 204
title: "Agent node executor and the shared branch runner"
phase: 2
plan: "P2.4"
status: not-started
depends_on: [103, 105, 106, 203]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 204 · Agent node executor and the shared branch runner

- **Plan:** [P2.4 Agent node executor and the shared branch runner](../composable-graphs.md#p24-agent-node-executor-and-the-shared-branch-runner)
- **Decisions:** D12, D15
- **Depends on:** [103](103-result-kind-registry.md), [105](105-prompt-templates.md), [106](106-capability-profiles.md), [203](203-scheduling.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Agent nodes run on the same hardened machinery as reviewer fan-outs, with per-activation tools and policies.

## Work

- [ ] Extract `AgentBranchRunner` from `review-fanout.ts`: admission, session creation with an explicit policy, the dispatch journal and proof-based recovery, observation, result reading, repair, reminder and continuation, token metering, transcript capture.
- [ ] Keep review-specific parsing and provenance behind `ReviewFanoutHost`; Multi Review and the pipeline fan-out keep their behaviour.
- [ ] Per-activation MCP credential (as `workflowResultConnection`): `submit_<port>`, `validate_<port>`, status; `report_progress` for types with `items`; `read_artifact` for `on-demand` inputs; opt-in tickets, mail and artifacts.
- [ ] `ask_human` only on nodes that opt in (D15): a call pauses the activation, the run shows "waiting for you", and the answer returns as the tool result.
- [ ] A node completes when every required output has an accepted artifact. Structured-output providers get one combined schema, split by port.
- [ ] `session: "fresh"` by default; `session: "continue"` only under the report §5.2 constraints.

## Tests

- [ ] `review-fanout-interleaving.test.ts`, the Multi Review efficiency benchmark and the dispatch tests pass unchanged.
- [ ] Executor tests with fake providers: completion, repair, reminder, continuation, restart recovery.
- [ ] `ask_human` pause and resume, including a backend restart while waiting.
- [ ] `session: "continue"` constraints are enforced.

## Done when

- [ ] Agent nodes run end to end on fake providers, and the extraction is behaviour-neutral for existing fan-outs.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
