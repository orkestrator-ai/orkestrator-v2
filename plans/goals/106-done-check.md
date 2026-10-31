---
id: 106
title: "Done check"
phase: 1
plan: "P1.6"
status: done
depends_on: [103, 105]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
updated: 2026-10-31
---

# 106 · Done check

- **Plan:** [P1.6 Done check](../goals.md#p16-done-check)
- **Decisions:** D7, D8
- **Depends on:** [103](103-goal-service-and-turn-edge-driver.md), [105](105-agent-signal-tool.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A goal completes because a command proved it, not because the agent said so.

## Work

- [x] Run the check with the `checking` status, outside the session work fence, with a default timeout of 10 minutes and a limit of 30 minutes.
- [x] Host worktree and container environments both work, because the exec worker already handles both. Confirm how a shell string maps onto its argv-preserving interface, and record the answer.
- [x] Keep the output tail within the bound in 101, content-free in logs, and persist `lastCheck` (exit status, duration, tail).
- [x] A failed check counts as an iteration, so a check that can never pass still ends at the cap.
- [x] A check that cannot start, or times out, pauses the goal with a reason rather than telling the agent it failed. A backend restart while `checking` re-runs the check, which is why checks must be safe to repeat; the UI in 202 says so.
- [x] The agent cannot change the check. It is shown to the agent so it can run the same command itself.

## Tests

- [x] Pass, fail, timeout and failure to start, with a fake exec.
- [x] Restart during a check. Check output containing carrier structure.
- [x] `claimed` when no check exists, and never `complete`.

## Done when

- [x] The only path to `complete` goes through a passing check or, after 401, a passing verdict.

## Notes

**2026-10-31.** A shell string maps to `["bash", "-lc", command]`, as a login shell would run it. Live on a host worktree and in a container, including output reaching the agent and a re-run after a killed backend. Not on Windows, where this would need `cmd`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
