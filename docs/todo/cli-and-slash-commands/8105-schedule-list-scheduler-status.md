# `orkestrator schedule list` says when schedules will not fire

From [5160](../cross-cutting/5160-silent-failures-live-evidence.md) task 3.
Settings → Schedules shows a notice when this backend is not firing
schedules, but the public `schedule.list` action does not carry that status,
so a CLI user listing schedules on a paused backend is not told they will not
fire. On 2026-11-14 the user (maintainer) chose to add it.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing has been built.

### Tasks

1. **Carry the scheduler status in `schedule.list` and print it**: the public result gains the status, and `orkestrator schedule list` prints a notice when the backend is not firing. Status: open.

### 1. Carry the scheduler status in `schedule.list` and print it

**Problem.** `orkestrator schedule list` on a backend that has lost the
registry writer lease, or defers to another backend or a newer data
directory, lists schedules as if they will fire.

**Context.** The backend command `list_scheduled_jobs` already answers
`scheduler` (`{ firing: true }`, or `firing: false` with `writer-lease-lost`,
`another-backend` or `newer-data-directory`), mapped by `schedulerStatus`
(`commands-registry-scheduled-jobs.ts`), with the text from
`schedulerPausedMessage` (`packages/protocol/src/scheduled-jobs.ts`). The
public action is `apps/backend/src/core/public-api/actions-schedules.ts`
(tests in `public-api-schedules.test.ts`); the CLI command is
`packages/cli/src/client/commands/schedule.ts`; the contract is in
`packages/protocol/src/public-api*.ts` (see
[public-cli.md](../../architecture/public-cli.md)). 5160 task 3 showed the
Settings notice live on 2026-11-14 with two real backends on one data
directory.

**Investigation.** Not started.

**Decisions.**

- **Where does the CLI print it?**
  - **The status as a field of the JSON result, plus a one-line notice on
    stderr with Settings' text when it is not firing (recommended).** Check
    how the command prints today before choosing the exact place.
    - Pros: a script reading the result can act on it; a person sees the
      same text as Settings; stdout's shape only gains a field.
    - Cons: a caller that ignores stderr and the new field still misses it.
  - **A non-zero exit when not firing.**
    - Pros: impossible to miss in a script.
    - Cons: listing succeeded; a failure exit would mislead.
- **Older backends?**
  - **No adapter (recommended, and the user's instruction).** Under the
    user's 2026-11-14 legacy-retirement decision every machine and client
    updates together; the result simply gains a field, with the contract,
    manifest and register updated as the tooling requires.
    - Pros: no compatibility code.
    - Cons: none while machines update together.
  - **An older-version adapter.**
    - Pros: a new CLI against an old backend would still list.
    - Cons: contrary to the decision.

## Assumptions and decisions

### Add the status (user decision, 2026-11-14)

The user (maintainer) chose on 2026-11-14 to add the scheduler status to the
`schedule.list` result and print it in the CLI, with no older-version
adapter, rather than leave the CLI as it was. Recorded in 5160's Assumptions
and decisions as well.

## Constraints and rationale

- The public CLI contract rules in the root `AGENTS.md` ("Public CLI
  contract") apply: results stay content-free.

## Related

- [5160](../cross-cutting/5160-silent-failures-live-evidence.md) task 3: the
  live evidence for the Settings notice.
- [Scheduled jobs](../../architecture/scheduled-jobs.md).
- [8108](../cross-cutting/8108-legacy-retirement-sweep.md): the
  legacy-retirement decision.

## Replaces

Nothing; new work from 5160 task 3.
