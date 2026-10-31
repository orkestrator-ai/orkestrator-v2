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

- [x] Mark goal messages in the tab's message pass, as peer mail does, which also covers a reload because it reads the provider row.
- [ ] Confirm the marking on each provider's history format.
- [x] Continuation tile: iteration number, collapsed text.
- [x] Rows: goal set, check passed or failed (with the output on expand), paused with reason, ended.
- [x] Exclude continuations from the composer's up-arrow history and prompt-resend affordances. Check suggested prompts and session titles too, because a title must not come from a carrier.

## Tests

- [ ] Rendering on every provider's history format, using recorded fixtures.
- [x] A user message containing carrier-like text still renders as a user message.

## Done when

- [ ] A long goal's transcript reads clearly, with no false user bubbles.

## Notes

- 2026-10-31: Goal turns become `goal-turn-<provider row id>` system rows in `AgentNativeTab.controller.tsx`, built by `apps/web/src/lib/chat/goal-messages.ts`. A carrier that does not parse is still a tile, with no raw text.
- 2026-10-31: Status rows are client-side only, derived from the snapshot's goal. They show the current state, so a pause that was resumed leaves no row and only the latest check has one. Earlier failed checks stay visible on the goal turn that answered them, because the carrier holds their output.
- 2026-10-31: The composer's up arrow walks the queued prompts, so the exclusion is in `queuedMessages`: queued goal turns have no row and cannot be edited or steered. A blocked one still shows its error and Retry. Moving a user's item past a hidden goal turn takes one step fewer than it shows, which is rare because goal turns queue behind the user's.
- 2026-10-31: `firstUserMessageOf` lives in `apps/backend/src/core/native-agent-projection-helpers.ts`. A tab whose only user rows are carriers gets no generated title, and a provider's own title is not filtered here.
- 2026-10-31: Turn clocks treat a goal turn as a prompt (`withGoalTurnsAsPrompts`), so a long goal reports its last turn's duration, not everything since the user last typed.
- 2026-10-31: The fixture test stays open: it needs recorded provider rows from the live runs, which do not exist yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Code · Tile, status rows, exclusions and the title fix built, with tests. · Provider fixtures and a long-goal read in a browser remain.
