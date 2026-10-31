---
id: 306
title: "Documentation"
phase: 3
plan: "P3.6"
status: done
depends_on: [305]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
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

- [x] Write `docs/architecture/goals.md`: model, statuses, the loop, limits, what each provider supports, and how to write a good goal.
- [x] Update `docs/architecture/native-agent-commands.md`, including the "no other shortcuts are planned" paragraph and the provider tables.
- [x] Update `native-agent-service.md`, `agent-messaging.md`, `recurring-work.md` where relevant, and `bridges/*/AGENTS.md`.
- [x] Update the entry in `docs/todo/agent-engines/0007-provider-sdk-adoption-backlog.md` that says to revisit Codex goals, so it points to the decision here.
- [x] Add the new doc to `docs/README.md`, and add a row to the root `AGENTS.md` table if goals need their own rules.
- [x] Add user-facing guidance on writing goals to the app's help or user guide, if one covers native agents.

## Tests

- [x] Link checks and the docs tests pass.

## Done when

- [x] Someone can understand and change goals without reading this plan.

## Notes

**2026-10-31.** `docs/architecture/goals.md` is the living doc, including how to write a goal. The app has no in-app guide for native agents, so that guidance stays there.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
