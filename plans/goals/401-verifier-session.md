---
id: 401
title: "Verifier session"
phase: 4
plan: "P4.1"
status: not-started
depends_on: [106]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 401 · Verifier session

- **Plan:** [P4.1 Verifier session](../goals.md#p41-verifier-session)
- **Decisions:** D7
- **Depends on:** [106](106-done-check.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A goal with no check command can still be judged by something other than the agent doing the work.

## Work

- [x] Decide how to reuse `AgentBranchRunner` and the graph `verification-verdict@1` kind. Record the decision.
- [x] Per-goal setting: verifier provider and model (`verifier` on the goal, `--verifier <agent>[:model]`).
- [ ] The setting is shown with its cost in the UI (`verifierTokens` and `lastVerdict.tokens` are exposed; `apps/web` is not done here).
- [x] A failed verdict continues the loop with the reasons in an evidence frame. A verifier that cannot run pauses the goal.
- [x] Verifier spend counts toward the token budget.

## Tests

- [x] Pass, fail, crash and restart with fake providers.
- [x] Verifier is read-only on every provider that enforces it.

## Done when

- [x] A goal can end `complete` from a verdict.
- [ ] The UI says which proof it had (`statusReason` and `lastVerdict` are exposed in `NativeAgentGoalView`; `apps/web` is not done here).

## Notes

This is a design change if the maintainer wants it in the first release. Change D7 in the plan first.

**2026-10-31 · D7 changed.** The maintainer asked for the whole plan now, so D7 and the plan's Status table were edited with the reason.

**2026-10-31 · Reuse decision: `AgentBranchRunner` as it is, with a small host and no new runner.** A smaller runner would have to rebuild what makes a verifier honest: the read-only create and send arguments (including OpenCode's per-turn `reviewShellPolicy`), answering unattended interactions, the idle, stall and unreachable bounds, the result reminder, repair up to 3 times, and usage metering. `graph-describe-host.ts` is the precedent. `native-agent-goal-verifier.ts` holds the host, the prompt and the verdict rules. What differs from other owners: the branch record is not persisted. It lives for one `run` call, and `save` writes only the session's identity to `goal.verifierRun`, so a restart re-runs (as a check does) and the runner's dispatch recovery goes unused. Each run has its own session key, `goal-verifier:<goalId>:<runId>`, so a re-run is fresh on providers that reuse a key's session.

**2026-10-31 · Verdict.** The slot is the existing `verification-result` kind, through `submit_verification_result`. A provider the rollout excludes answers by structured output instead. `parseResult` applies the `verification-verdict@1` built-in validator (so `acceptanceCriteria` is required, though the kind still admits its legacy shape) and refuses a complete verdict that lists a failed requirement. Either failure gets the runner's repair turn. Kept on the goal: `summary` (the rationale, at most 2 KiB) and `reasons` (entries not `passed`, at most 16 of 512 bytes). No transcript is kept. `reasons` reach the agent in `failedVerdict` in the carrier, and are left out of public views and history.

**2026-10-31 · Schema facts.** New status `verifying`. New reasons `verifier-unavailable` (clearer than `check-unavailable`, because the two need different fixes) and `verdict-passed`. New events `verifier-finished`, `verifier-unavailable`, `verifier-run-ended`, and action `run-verifier`. New goal fields `verifier {agent, model?}`, `lastVerdict`, `verifierTokens`, `verifierRun`. A failed check, or the start of a new run, drops `lastVerdict`, because it judged older work.

**2026-10-31 · Tokens.** `tokensUsed` is the agent session's delta plus `verifierTokens`, because the agent's session cannot report the verifier's spend. No verifier session starts once the budget is spent: the goal ends `limited`, and resuming with a higher budget asks the agent again. `--budget` is refused when the verifier's provider is not in `GOAL_TOKEN_BUDGET_PLATFORMS`, on set and on resume. A session stopped early or cut short by a crash still counts, up to the last usage written to `verifierRun`.

**2026-10-31 · Stops and restarts.** A run does not hold the goal's `advance`, so the sweep keeps watching the session and environment during it. Leaving `verifying` for any reason, and `/goal clear`, abort the session and retire its slot; a verdict that arrives later is ignored. `init` stops a session named by `verifierRun`, counts its spend and runs again; it also stops one left on a goal that is no longer `verifying`. A stopping backend does not abort, so that shutdown stays quick, and the next process does it. A run fails to `verifier-unavailable` at the 30-minute limit (`verifierTimeoutDefaultMs`).

**2026-10-31 · Kept out of the way.** A verifier is a provider session with no native session record, as a reviewer is, so no tab shows it, no goal can attach to it (its key is not `env-*`), and no turn-end or attention listener hears it. It gets no artifact grant and no efficiency observer, and its result-tool credential cannot list `report_goal`. Its prompt omits the goal id.

**2026-10-31 · Read-only tiers, and what they cost.** Every provider gets the same read-only turn (`mode: "plan"`, `readOnly`, `reviewerSession`, the `automated-review` policy). How strongly it holds is the matrix's (`capability-enforcement.ts`): enforced on Codex, Pi, and Claude where its sandbox runs; provider-configured on OpenCode, Cursor, and Claude with no sandbox; advisory on Grok. No post-hoc workspace guard is added, so a Grok verifier's write would go unnoticed. Commands are limited too: a Claude read-only turn admits reading commands only, and a read-only sandbox can make a test suite fail if it writes. The prompt tells the verifier to say so and judge from what it can observe, so **a goal that must run a suite should also have a check.** Not run live: only fake providers exercised this (no live model calls), so each provider's real behaviour here is unqualified.

**2026-10-31 · Who may verify.** Any platform in `enabledAgentPlatforms`. `GOAL_QUALIFIED_PLATFORMS` is about driving the loop, which a verifier does not do; it runs the reviewer path. A bad model name surfaces when the session starts, as a pause with the reason.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude (worktree c4666baa82d9) · Built the verifier session, its protocol, `--verifier`, wiring and fake-provider tests; D7 changed. · UI proof and cost display in `apps/web`; live qualification.
