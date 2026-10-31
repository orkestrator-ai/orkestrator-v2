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

- [x] Actions with the existing operation ledger and idempotency.
- [x] CLI commands, and `--wait` exits with a status per terminal state.
- [x] Update `docs/architecture/public-cli.md`.

## Tests

- [x] `packages/cli/tests` coverage, and replay of a set operation creates one goal.

## Done when

- [x] A script can set a goal, wait, and act on how it ended.

## Notes

- 2026-10-31: Actions are `session.goal.set|get|pause|resume|clear`
  (`public-api/actions-session-goals.ts`). `set` takes structured fields through
  `NativeAgentService.performGoalCommand`, never a `/goal` string; `pause` and `clear`
  act on the record and start no bridge. Receipts are content-free.
- 2026-10-31: `--wait` exit statuses: complete 0, `goal-claimed` 10, `goal-blocked` 11,
  `goal-limited` 12, `goal-paused` 13, `goal-gone` 14 (cleared, replaced before it ended,
  or no goal). Deadline stays 5, a waiting interaction 6. New codes in
  `PUBLIC_ERROR_EXIT`; the classification is `classifyGoalForWait` in `public-api-wait.ts`.
- 2026-10-31: Exactly-once needed more than the ledger: `GoalCommand`'s `set` gained an
  optional `goalId`, derived from the operation (`goalIdForRequest`), and `perform` returns
  the goal holding that ID, current or in history, instead of setting another. So a set
  the backend died during reconciles to `succeeded` or `interrupted` from evidence.
- 2026-10-31: `set` and `resume` confirm under the voice profile (a goal runs many
  unattended turns). Item 401's `--verifier` is not on the CLI or the action yet.
- 2026-10-31: The "done when" round trip is the real client against the real
  `public_action`, ledger and service with a scripted provider, with the goal moved to
  its end state on the record. A real provider's loop is 109's live suite, which was not
  run here. The 16 packaged tests in `packages/cli/tests` fail in this worktree because
  it has no built `dist`, so the new commands have not been through the packaged client.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude (worktree c4666baa82d9) · Added the actions, CLI, docs and tests. · Status and index left for the caller; verifier flag and a packaged run still open.
