# Agent mail into a real claude-tmux tab: live evidence for BG-15

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`. From
[1202](1202-efficiency-review-follow-ups.md) task 8 (BG-15), which made a
tmux mail dispatch skip the reads its presence gate had just made. That was
measured with the real drainer and storage and a fake tab
(`apps/backend/scripts/tmux-mail-inject-reads.ts`); no mail was delivered to
a real claude-tmux tab.

### Tasks

1. **Deliver mail to a real idle claude-tmux tab and count the reads**: Status: open (needs a Claude CLI session in tmux, which a delivered message makes take a turn).

### 1. Deliver mail to a real idle claude-tmux tab and count the reads

**Problem.** BG-15's figures (7 keyed reads instead of 9 per delivery, one
fresh `claude_tmux_status` either way) come from a fake tab. Whether a real
tab's mail is still typed only into a live, idle session, and held when the
user queued a prompt or wrote a draft meanwhile, has not been seen live with
this change.

**Context.** The path is `AgentMailService.drainInjects` →
`PromptQueueDrainer.mailInjectPresence` → `dispatchMailInject` with the
presence → `claude_tmux_submit_queued`. Typing mail into the tab makes the
Claude CLI start a turn, so a live run needs a signed-in Claude CLI (a billed
turn) or a Claude CLI pointed at a loopback model inside the tmux session.
The build stage that made the change was not allowed either (no billed
turns, no real logins), so it stopped at the fake.

**Investigation.** None live. The `dev:test` profile used for 1202 task 1 on
2026-11-06 ran with `--no-agent-credentials`, so it had no claude-tmux tab.

**Decisions.**

- **How to run it?**
  - **A `dev:test` profile with `--credential-source claude`, one short message to an idle tab, read counts from the backend's `recurringWork` storage-read counters before and after (recommended).**
    - Pros: the real path end to end; one turn.
    - Cons: one billed turn; needs the maintainer's go-ahead.
  - **Point the tmux session's Claude CLI at a loopback model, as E10 did for the bridge.**
    - Pros: no billed turn.
    - Cons: the tmux launch has no such option today; building one is more than this check is worth.

Steps:

1. Start `mise run dev:test --profile <name> --fixture --credential-source claude --agent-platforms claude`.
2. Open a claude-tmux tab on the fixture environment and wait until it is idle.
3. From a second tab, send one agent-mail message to it with inject on.
4. Confirm it is typed once, and that a second message sent while a user prompt is queued is held (`held`, reason `queue`).
5. `dev:stop` and `dev:reset` the profile and record the outcome in 1202 task 8.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 8 (BG-15) and task 10 (the fresh liveness probe).
- [5120](../transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md): other tmux live evidence.
