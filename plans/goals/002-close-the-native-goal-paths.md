---
id: 002
title: "Close the native goal paths"
phase: 0
plan: "P0.2"
status: not-started
depends_on: [001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 002 · Close the native goal paths

- **Plan:** [P0.2 Close the native goal paths](../goals.md#p02-close-the-native-goal-paths)
- **Decisions:** D2, D4
- **Depends on:** [001](001-provider-behaviour-probes.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A provider's own goal loop cannot start in an Orkestrator session behind the backend's back.

## Work

- [ ] Keep `features.goals=false` and update its comment to point at this plan.
- [ ] If 001 shows Claude's `ProposeGoal` is offered, add it to `disallowedTools` (`bridges/claude-bridge/src/services/session-manager-prompt-query.ts`) on every turn, not only read-only coordinator turns.
- [ ] Apply the same closure to Grok, Cursor and Pi where 001 shows a model-facing goal tool and the provider has a way to turn it off. Where it has none, record the gap in Notes and in the provider's Phase 3 item.
- [ ] Say in `bridges/*/AGENTS.md` for each touched bridge why the path is closed.

## Tests

- [ ] Unit test per closed path, beside the existing `features.goals` assertions in `codex-config.test.ts`.
- [ ] Extend `live-network-lock.test.ts` only if the Codex behaviour changed.

## Done when

- [ ] The model cannot start a native goal in a session on any provider where a closure exists, and every gap is written down.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
