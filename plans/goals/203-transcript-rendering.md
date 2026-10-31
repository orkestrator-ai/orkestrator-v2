---
id: 203
title: "Transcript rendering"
phase: 2
plan: "P2.3"
status: not-started
depends_on: [104]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 203 · Transcript rendering

- **Plan:** [P2.3 Transcript rendering](../goals.md#p23-transcript-rendering)
- **Decisions:** D12
- **Depends on:** [104](104-continuation-prompts.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A transcript shows what the goal loop did, and never shows a continuation as the user's words.

## Work

- [ ] Mark goal messages in the projection, including after a reload and on each provider's history format.
- [ ] Continuation tile: iteration number, collapsed text.
- [ ] Rows: goal set, check passed or failed (with the output on expand), paused with reason, ended.
- [ ] Exclude continuations from the composer's up-arrow history and prompt-resend affordances. Check suggested prompts and session titles too, because a title must not come from a carrier.

## Tests

- [ ] Rendering on every provider's history format, using recorded fixtures.
- [ ] A user message containing carrier-like text still renders as a user message.

## Done when

- [ ] A long goal's transcript reads clearly, with no false user bubbles.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
