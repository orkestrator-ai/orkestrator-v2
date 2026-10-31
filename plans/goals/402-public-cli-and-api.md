---
id: 402
title: "Public CLI and API"
phase: 4
plan: "P4.2"
status: not-started
depends_on: [108]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 402 · Public CLI and API

- **Plan:** [P4.2 Public CLI and API](../goals.md#p42-public-cli-and-api)
- **Decisions:** D4
- **Depends on:** [108](108-the-goal-slash-command.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Scripts can run goals with the same rules as the composer.

## Work

- [ ] Actions with the existing operation ledger and idempotency.
- [ ] CLI commands, and `--wait` exits with a status per terminal state.
- [ ] Update `docs/architecture/public-cli.md`.

## Tests

- [ ] `packages/cli/tests` coverage, and replay of a set operation creates one goal.

## Done when

- [ ] A script can set a goal, wait, and act on how it ended.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
