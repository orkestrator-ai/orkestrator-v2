# The claude-tmux tab loop is missing from recurring-work diagnostics

## Task analysis

Analysed 2026-11-10 against `main` at `c98b20e6f`. Found by
[1202](../cross-cutting/1202-efficiency-review-follow-ups.md) task 1's Linux
run with a claude-tmux tab open in a container, which counted the
container's `docker exec` sessions from Docker's own event stream beside the
backend's `recurringWork` counters.

### Tasks

1. **Give the claude-tmux tab loop a recurring kind**: open.
2. **Explain the presence pass's extra reads and revision check**: open.

### 1. Give the claude-tmux tab loop a recurring kind

**Problem.** With one idle claude-tmux tab in a container, Docker reported
124.5–128.5 `docker exec` a minute for the container, while the backend's
`recurringWork` counters charged 64.5–65.5 a minute to all kinds together.
The difference is the tab's own loop: its per-tick snapshot (about 57 a
minute idle) and, before the transcript binds, its transcript search. On
`0bd214ee` the same loop made 230–404 execs a minute and none of them were
counted either. So `get_recurring_work_diagnostics` and `/metrics` cannot
show the cost of an open tmux tab, which was the report's BG-1 and BG-2, and
the 2026-11-06 macOS comparison read `tmux-poll`, the per-container Claude
state poll, as if it were the tab loops.

**Context.** `tmux-poll` (B18 in `packages/protocol/src/recurring-work.ts`)
is observed in `apps/backend/src/core/tmux-poll.ts`, the per-container
Claude state poll. The per-tab loop lives in `tmux-session.ts` and
`tmux-session-manager.ts`, with its cadence in `tmux-shared.ts`
(`TMUX_IDLE_*`) and its doorbell in `tmux-hook-signal.ts`; none of them
calls the recurring-work metrics. `tmux-interactive-capture` (B19) covers
only interactive captures. Task 8 of 1202 counted the loop with
`apps/backend/scripts/tmux-exec-count.ts` against a fake container instead.

**Investigation.** Counted live on beelink on 2026-11-10
(`scripts/container-tmux-tab-live.ts`, method in
[the testing guide](../../development/testing-guide.md#a-claude-tmux-tab-in-a-container-and-per-item-counts-on-a-busy-profile)).
Docker labels the tab loop's idle execs `sh -c echo` (the snapshot) and
`sh -c find` (the transcript search); the state poll's are `sh -c if`. Not
checked: whether the loop's storage reads are counted under another kind.

**Decisions.**

- **How to count the tab loop?**
  - **A new recurring kind for the per-tab loop, observed around each tick, with `docker-exec`, `tmux-spawn` and storage work units (recommended).**
    - Pros: diagnostics and `/metrics` show an open tab's cost per tab;
      the A/B drivers compare it without a Docker stream; the doorbell's
      saving becomes visible on hosts where it rings.
    - Cons: a protocol kind to add (`recurring-work.ts` table, budgets
      doc); every tick goes through the metrics wrapper.
  - **Charge the tab loop's execs to `tmux-poll`.**
    - Pros: no new kind.
    - Cons: mixes a per-container poll with per-tab loops, so neither
      rate means anything on its own.
  - **Leave it and count from Docker when needed.**
    - Pros: no code.
    - Cons: the diagnostics keep under-reporting container cost by half or
      more with one tab open, and local tabs have no Docker stream at all.

### 2. Explain the presence pass's extra reads and revision check

**Problem.** On the 0048 busy profile with two mailboxes, `main`'s
`mail-presence` pass read 9 rows and checked the store revision twice a
pass, where `0bd214ee` read 7 and checked once, with the same two mailboxes
running. Every read was answered without fetching bytes, so the cost is
small (60 cached reads and 30 checks a minute), but nothing explains it. The
doubled revision check was already seen idle on macOS on 2026-11-06 (1202
task 1).

**Context.** `refreshPresenceOnce` in `agent-mail-service.ts` (BG-3 reads
each environment once a pass). Measured with
`scripts/busy-item-counts-live.ts`; with both mailboxes' environments
stopped `main` read 3 a pass and base still 7, so the extra reads belong to
running environments.

**Investigation.** Not traced.

**Decisions.**

- **What to do with the difference?**
  - **Trace which reads the pass makes per running mailbox, then drop any
    that repeat a read made earlier in the same pass (recommended).**
    - Pros: small and local; the counters show the result directly.
    - Cons: the saving is cached reads, worth little on its own.
  - **Record it as expected and close the task.**
    - Pros: no work.
    - Cons: leaves an unexplained difference in the one pass that runs
      every 2 s for every mailbox.

## Related

- [1202](../cross-cutting/1202-efficiency-review-follow-ups.md) task 1 (the
  measurements) and task 8 (BG-1, BG-2, BG-7).
- [0048](0048-recurring-work-qualification.md) (the busy driver and the
  recurring-work instruments).
- [7531](../containers-and-environments/7531-idle-tab-cleanup-execs.md)
  (tab cleanup's execs, which base made without charging them).
