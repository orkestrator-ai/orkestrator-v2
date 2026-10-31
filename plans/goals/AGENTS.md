# Goals plan: keeping work items current

This folder splits [`plans/goals.md`](../goals.md) (the plan) into one file per
work item. The plan holds the design and the decisions (D1–D15). These files
hold each item's status, its checklist and the record of the work. Change the
design in the plan, never only here.

Each item's status lives in its file's front matter. [`000-index.md`](000-index.md)
mirrors it, one row per item. `tests/unit/goals-plan.test.ts` fails when a file
and its row disagree, or when the format below is broken. Run it after every
edit:

```bash
mise exec -- bun test tests/unit/goals-plan.test.ts
```

## How status reaches `main`

Agents never commit to `main` (root `AGENTS.md`). A status change therefore
reaches `main` with the pull request that does the work, and the board on
`main` shows merged work only.

- Put the item ID in the branch name and pull request title, for example branch
  `goals-103-turn-edge-driver` and title `feat(goals): 103 turn-edge driver`.
  Others then find work in flight with `gh pr list --search "goals 103"`.
- One pull request may deliver part of an item. It ticks what it finished and
  leaves the status `in-progress`.
- The pull request that finishes an item sets `status: done` in the same
  change, so `main` shows `done` exactly when the work merges. Open the pull
  request first, then add its URL to `pr` in a follow-up commit on the same
  branch.
- A pull request closed without merging changes nothing on `main`. Nothing
  needs undoing.

## Picking up an item

1. Read the item, the plan section it links, and every decision it lists.
   Check the plan's Status line: decisions marked proposed need the
   maintainer's confirmation before Phase 1 work starts. Once confirmed,
   decisions are settled. If the work shows one is wrong, stop and ask the
   user. Any change is recorded in the plan's Decisions table, with its reason,
   never by quietly doing something else.
2. Check that it is ready: every item in `depends_on` is `done` on `main`. You
   may start early only on a part the item's Notes call independent; say so in
   the log.
3. Check that nobody else is on it: search open pull requests for the item ID.
   If one exists, ask the user before starting.
4. In your first commit: set `status: in-progress`, `owner` (who you are: the
   agent and environment, or a person's name), `branch` and `updated`; update
   the index row's Status; add a log line.

## While working

- **Tick a box in the same change that makes it true.** Never tick partial
  work. If an item turns out larger, split the line into sub-items and tick
  those.
- **A box that no longer applies** is ticked and struck through, with the
  reason: `- [x] ~~Old text~~ (not needed: replaced by X, see Notes)`.
- **New work inside the item's scope** goes under Work or Tests as new
  unticked boxes. Work outside its scope gets a new item file (see Numbering),
  not a wider old one.
- **Notes** record decisions made during the work, deviations from the plan
  and facts later items need: reason codes, schema shapes, file names. Date
  each entry.
- **The progress log** gets one line per working session, newest last:
  `YYYY-MM-DD · who · what changed · next step`. Keep it short. Never paste
  prompts, secrets, credentials, file contents or command output into it.
- **`updated:`** changes to today's date whenever you edit the file.

## Statuses

| Status | Meaning | Fields that must be set |
| --- | --- | --- |
| `not-started` | Nobody has started it. | none |
| `in-progress` | Work has started on `branch`. Some boxes may be ticked. | `owner`, `branch` |
| `blocked` | It cannot continue until something outside it changes. | `blocked_by`: what blocks it and who can unblock it |
| `done` | Every box is ticked, and the work is in the pull request that sets this. | `pr` |
| `dropped` | It will not be done. | a dated reason in Notes |

- `blocked_by` is empty unless the status is `blocked`. Clear it when the
  block lifts, and set the status the item had before.
- `pr` lists every pull request that delivered part of the item, separated by
  commas.
- Never delete an item file. `done` and `dropped` files stay as the record.

## Phase exit criteria

Each phase's exit criteria are checklists in `000-index.md`. Tick one in the
pull request that demonstrates it, and link the evidence (a test, a run) from
the log of the item that proved it. When every item and every exit criterion of
a phase is done, update the plan's Status line in the same change.

## Numbering

- An item's ID is permanent: the phase times 100, plus a sequence number
  (`103` is Phase 1, item 3). IDs are never reused or renumbered.
- A new item takes the next free number in its phase (Phase 1 after `109` is
  `110`). Add its row to that phase's table in ID order.
- A new item's `plan` field names the plan section it serves. If it changes the
  design, add the change to the plan first.

## Front matter format

The test parses this exact format. Keep the keys in this order, one per line,
`key: value`:

```yaml
---
id: 103                         # three digits, the same as the file name prefix
title: "Goal service and turn-edge driver" # double-quoted; must match the heading
phase: 1                        # the ID's first digit
plan: "P1.3"                    # double-quoted plan section
status: not-started             # one of the statuses above, unquoted
depends_on: [001, 102]          # three-digit IDs, ", "-separated, or []
blocked_by: ""                  # double-quoted; non-empty only when blocked
owner: ""                       # double-quoted
branch: ""                      # double-quoted
pr: ""                          # double-quoted
updated: 2026-10-31             # YYYY-MM-DD
---
```

(The `#` comments above are explanation only. Real front matter has none.)

The index row has the same ID, phase, status and dependencies: `—` when there
are none, otherwise IDs separated by `, `.

## When the whole plan is finished

Durable behaviour belongs in `docs/architecture/goals.md` (item 306), not in
these files. Once everything is `done` or `dropped`, these files remain only as
the record of the work.
