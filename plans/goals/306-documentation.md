---
id: 306
title: "Documentation"
phase: 3
plan: "P3.6"
status: not-started
depends_on: [305]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 306 · Documentation

- **Plan:** [P3.6 Documentation](../goals.md#p36-documentation)
- **Decisions:** D14
- **Depends on:** [305](305-browser-scenario-and-qualification-record.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Durable behaviour moves from this plan to the living docs.

## Work

- [ ] Write `docs/architecture/goals.md`: model, statuses, the loop, limits, what each provider supports, and how to write a good goal.
- [ ] Update `docs/architecture/native-agent-commands.md`, including the "no other shortcuts are planned" paragraph and the provider tables.
- [ ] Update `native-agent-service.md`, `agent-messaging.md`, `recurring-work.md` where relevant, and `bridges/*/AGENTS.md`.
- [ ] Update the entry in `docs/todo/agent-engines/0007-provider-sdk-adoption-backlog.md` that says to revisit Codex goals, so it points to the decision here.
- [ ] Add the new doc to `docs/README.md`, and add a row to the root `AGENTS.md` table if goals need their own rules.
- [ ] Add user-facing guidance on writing goals to the app's help or user guide, if one covers native agents.

## Tests

- [ ] Link checks and the docs tests pass.

## Done when

- [ ] Someone can understand and change goals without reading this plan.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
