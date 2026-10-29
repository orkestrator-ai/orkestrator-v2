---
id: 105
title: "Prompt templates"
phase: 1
plan: "P1.5"
status: not-started
depends_on: [101, 102, 106]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 105 · Prompt templates

- **Plan:** [P1.5 Prompt templates](../composable-graphs.md#p15-prompt-templates)
- **Decisions:** D13
- **Depends on:** [101](101-template-schema.md), [102](102-type-library.md), [106](106-capability-profiles.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Node prompts are user templates with no executable logic, rendered behind a locked system contract.

## Work

- [ ] A logic-less engine: variables, list sections and input partials, nothing executable.
- [ ] The five render modes: `json-frame`, `markdown`, `summary`, `file`, `on-demand`. Evidence frames reuse `review-evidence-frames.ts`.
- [ ] A size estimator based on type budgets.
- [ ] Lints: unbound variables; per-branch variables before large shared inputs; prose output requested when output ports exist; instructions that contradict the profile (advisory).
- [ ] The locked system contract from `withUnattendedPolicy`, `workflowResultInstruction` and a capability statement generated from the node's profile ([106](106-capability-profiles.md)).

## Tests

- [ ] Rendering per mode, including escaping inside frames.
- [ ] Each lint fires and stays quiet on the right inputs.
- [ ] Templates that look like code (`{{constructor}}`, prototype names) render literally.
- [ ] Size estimates bound the actual rendered size.

## Done when

- [ ] Prompt templates are merged with tests and used by [107](107-compiler.md) and [204](204-agent-node-executor.md).

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
