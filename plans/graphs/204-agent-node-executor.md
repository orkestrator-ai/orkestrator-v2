---
id: 204
title: "Agent node executor and the shared branch runner"
phase: 2
plan: "P2.4"
status: in-progress
depends_on: [103, 105, 106, 203]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-204-agent"
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

- [x] Extract `AgentBranchRunner` from `review-fanout.ts`: admission, session creation with an explicit policy, the dispatch journal and proof-based recovery, observation, result reading, repair, reminder and continuation, token metering, transcript capture.
- [x] Keep review-specific parsing and provenance behind `ReviewFanoutHost`; Multi Review and the pipeline fan-out keep their behaviour.
- [ ] Per-activation MCP credential (as `workflowResultConnection`): `submit_<port>`, `validate_<port>`, status; `report_progress` for types with `items`; `read_artifact` for `on-demand` inputs; opt-in tickets, mail and artifacts.
- [ ] `ask_human` only on nodes that opt in (D15): a call pauses the activation, the run shows "waiting for you", and the answer returns as the tool result.
- [ ] A node completes when every required output has an accepted artifact. Structured-output providers get one combined schema, split by port.
- [ ] `session: "fresh"` by default; `session: "continue"` only under the report §5.2 constraints.

## Tests

- [x] `review-fanout-interleaving.test.ts`, the Multi Review efficiency benchmark and the dispatch tests pass unchanged.
- [ ] Executor tests with fake providers: completion, repair, reminder, continuation, restart recovery.
- [ ] `ask_human` pause and resume, including a backend restart while waiting.
- [ ] `session: "continue"` constraints are enforced.

## Done when

- [ ] Agent nodes run end to end on fake providers, and the extraction is behaviour-neutral for existing fan-outs.

## Notes

**2026-10-29 · Extraction (behaviour-neutral).** `agent-branch-runner.ts` (`AgentBranchRunner<B>`:
`advance`, `advanceIsolated`, `abandonLive`, `prepareContinuation`, `beginPass`, `commit`,
`stageObservation`, `flushObservations`, `record`) with collaborators taking one shared context
(`AgentBranchContext`): `agent-branch-types.ts` (`AgentBranchRecord`, `AgentBranchHost<B>`,
wording, model rule, retryable pre-dispatch errors), `agent-branch-commits.ts` (the serialized
write queue: safety commits applied inside their own write, staged observations, fence errors),
`agent-branch-observation.ts` (usage metering, progress and stall thresholds, transcript mirror,
commit nudge, `commitProgressObservation`), `agent-branch-stall.ts` (idle-poll bound, unreachable
provider, terminal failure), `agent-branch-turns.ts` (repair ≤ 3, the one reminder after the
idle-poll bound, the one restart continuation, and an owner continuation for `ask_human`). No
`extends`. `review-fanout.ts` keeps the panel (evidence check before admission, provisional
findings, admission-queue projection, fan-in outcome) and adapts each reviewer onto the runner
through `reviewBranchHost` (review prompt, structured-review contract and repair prompt,
provenance on acceptance, reviewer wording); `ReviewFanoutHost` and every export are unchanged
(`commitProgressObservation`, `attachAgentBeforeDispatch`, `resolveUnattendedReviewerInteractions`
are re-exported). Proof: `git diff --stat` on every review-fanout*, multi-review* and
build-pipeline-review-fanout* test and test-support file is empty; those suites, the interleaving
suite (24 default seeds plus 300 seeds locally) and the Multi Review efficiency benchmark pass.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Extracted `AgentBranchRunner` from the reviewer fan-out, behaviour-neutral. · Graph agent executor next.
