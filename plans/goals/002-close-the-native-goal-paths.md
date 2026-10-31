---
id: 002
title: "Close the native goal paths"
phase: 0
plan: "P0.2"
status: done
depends_on: [001]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
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

- [x] Keep `features.goals=false` and update its comment to point at this plan.
- [x] If 001 shows Claude's `ProposeGoal` is offered, add it to `disallowedTools` (`bridges/claude-bridge/src/services/session-manager-prompt-query.ts`) on every turn, not only read-only coordinator turns.
- [x] Apply the same closure to Grok, Cursor and Pi where 001 shows a model-facing goal tool and the provider has a way to turn it off. Where it has none, record the gap in Notes and in the provider's Phase 3 item.
- [x] Say in `bridges/*/AGENTS.md` for each touched bridge why the path is closed.

## Tests

- [x] Unit test per closed path, beside the existing `features.goals` assertions in `codex-config.test.ts`.
- [x] Extend `live-network-lock.test.ts` only if the Codex behaviour changed.

## Done when

- [x] The model cannot start a native goal in a session on any provider where a closure exists, and every gap is written down.

## Notes

**2026-10-31 · Result.** Codex stays closed by `features.goals=false`. Claude's `ProposeGoal` is in `disallowedTools` on every turn (`withNativeGoalClosed`). Grok's model names no goal tool over ACP, and Pi has none without an extension.

**Gap: Cursor.** The model names `CreateGoal` and `UpdateGoal`. `@cursor/sdk` 1.2.0 has no option to turn them off, because they arrive from Cursor's own agent. Our carrier tells the agent to use no other goal tool, which reduces the chance but does not close the path. Recorded in `bridges/cursor-bridge/AGENTS.md`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
