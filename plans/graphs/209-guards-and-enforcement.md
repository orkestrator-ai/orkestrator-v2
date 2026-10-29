---
id: 209
title: "Guards and enforcement"
phase: 2
plan: "P2.9"
status: in-progress
depends_on: [001, 106, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-209-guards"
pr: ""
updated: 2026-10-29
---

# 209 · Guards and enforcement

- **Plan:** [P2.9 Guards and enforcement](../composable-graphs.md#p29-guards-and-enforcement)
- **Decisions:** D4, D12
- **Depends on:** [001](001-pipeline-reviewers-read-only.md), [106](106-capability-profiles.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

What a profile promises is either enforced by the provider or detected by a guard, and the user can see which.

## Work

- [x] Apply the read-only guard from [001](001-pipeline-reviewers-read-only.md) to every node with `workspaceAccess: read` or `none`.
- [x] A remote-ref guard compares upstream refs before and after every agent node (none may push).
- Withhold the GitHub credential from agent session environments where the provider allows it:
  - [x] Claude and Grok (ACP) sessions whose policy denies `github.write` start without it.
  - [ ] Codex and Pi sessions withhold it too (Codex: per-thread `shell_environment_policy` needs a live check; Pi: a bash tool with a `spawnHook`). OpenCode and Cursor share one process per environment and cannot (see Notes).
- [x] `minEnforcement` filters pickers at launch and is re-checked at dispatch; a tier that dropped since launch fails the activation before dispatch.
- Record the applied tier on the activation and show it in the inspector:
  - [x] Recorded on the activation (`enforcement`, `enforcementReason`, `guards`), with `graphActivationEnforcementView` for the inspector.
  - [ ] Shown in the inspector (item 211 renders it).

## Tests

- [x] A committing reviewer is refused (fake providers here; live runs batched in todo 0031).
- [x] A push attempt is detected.
- [x] A tier drop fails before dispatch with a clear message.

## Done when

- [ ] Guards and enforcement checks are in place, and the tiers shown match live conformance runs.

## Notes

**2026-10-29 · Guard wiring.** `apps/backend/src/core/graph-agent-guards.ts` (`GraphAgentGuards`,
`GraphAgentGuardError`, `mergeGraphGuardResults`, `graphEnforcementGuardResult`,
`graphPathsDigest`). The executor (`graph-node-agent.ts`) owns one instance (`executor.guards`):
- **Before dispatch** (no session yet): the node is judged afresh on the live host
  (`enforcementHost`, default `defaultCoordinatorHostCapabilities`), an `enforcement` guard result
  is recorded, and a floor miss fails `guard-violation`. Then `guards.capture` records the baseline
  for **every** agent node and fails closed (`guard-violation`, guard result `unavailable`) when the
  worktree probe (`get_environment_uncommitted_paths` via `commandWorkspaceProbe(invoke, 3)`) or
  `ls-remote` cannot answer. 204's best-effort `baseline()` is gone.
- **Submit time:** `installGraphAgentExecutor` registers `executor.guards.acceptanceCheck(...)` on
  `graph-output`; it resolves the attempt through `graphRuns.activationForResultKey`, so only a
  running/awaiting-human activation's own keys of a `read`/`none` node are judged
  (`worktree_changed`, `nextAction: correct`). Writers are never refused here.
- **Consumption:** `GraphAgentBranchHost.acceptResult` calls `guards.certify` before any artifact is
  stored; a `GraphAgentGuardError` fails the branch (the runner aborts the session), the report's
  cause is `guard-violation`, and the results stay in `activation.guards`.
- Baselines from before 209 (no `capturedAt`) are not certified: results `unavailable`, no failure
  (mirrors 001's rule for in-flight reviews).

**2026-10-29 · Baseline shape** (`GraphActivationBaseline`, protocol `run-model.ts`, validated in
`run-guards.ts`): `{headRef, pathsDigest, pathCount?, paths?, capturedAt?, upstream?}`.
`pathsDigest` is now SHA-256 over the sorted path set (each path + NUL), no longer over porcelain
output. `paths` is kept only for read/none nodes with ≤ `GRAPH_RUN_BOUNDS.maxBaselinePaths` (64)
paths of ≤ 1,024 chars; a larger set is compared by digest and count (generic refusal listing the
current paths). `upstream` is `[{remote, ref: "refs/heads/<branch>", sha | null}]`, at most
`maxBaselineUpstreamRefs` (8).

**2026-10-29 · Remote-ref guard rule.** Watched remotes: `origin` and `branch.<b>.remote`; every
remote (≤ 8) when neither exists; no remote → `passed` ("no remote to watch"). After the turn each
watched remote is listed (`ls-remote --heads --tags`, 3 attempts; failure → `unavailable`, fails
the activation). Violation when the run branch moved, or any head/tag points at a commit the
activation created: `baseline..HEAD` (≤ 1,000) plus the worktree's HEAD reflog since `capturedAt`,
each with a commit time ≥ capture − 2 s (so a fast-forward onto older commits is not a push).
Commits named by the run's `push:<branch>:<sha>` effects (`graphPushedCommitOfEffectKey`, wired
from `storage.graphEffects` in `index.ts`) are never blamed on an agent, because `push-branch` is a
`read` node and may run beside a reviewer. Whole-remote comparison was rejected: teammates' and
sibling worktrees' pushes would fail activations. Not detected: pushes to a URL or an unwatched
remote, pushes of pre-existing commits to another ref, forged commit dates, GitHub writes that are
not pushes.

**2026-10-29 · GitHub credential per provider.** Protocol: `GITHUB_CREDENTIAL_ENV_VARS`,
`nativeAgentWithholdsGitHubCredential(policy)` (policy denies `github.write`, i.e. every graph
agent) and `withheldGitHubCredentialEnvironment(env, {ghConfigDir})` (drops `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`,
`ORKESTRATOR_GITHUB_CREDENTIAL_FILE`; `GH_CONFIG_DIR` → empty dir; appends `GIT_CONFIG_*` entries
resetting `credential.helper` and the github.com/gist scoped helpers).
- **Claude:** done. `runtimeEnvironmentForSessionQuery(policy)` (bridge `runtime-env.ts`) at both
  query-environment sites (`session-manager-prompt-query.ts`, `session-manager-runtime.ts`); the
  managed credential file is not read and `gh auth token` is not run for such a session.
- **Grok (ACP):** done. One child per session; `providerEnv(config, {withholdGitHub})` in
  `acp-context.ts`.
- **Codex:** not done. One shared `codex app-server` per environment; the coordinator's
  `shell_environment_policy.exclude` is process-level. A per-thread config in `thread/start` may
  work but needs a live check before relying on it.
- **Pi:** not done. The SDK runs in the bridge process; its bash tool accepts a `spawnHook` that
  could strip the env, but MCP children and extensions would still inherit it.
- **OpenCode, Cursor:** not feasible per session (shared `opencode serve` / in-process SDK with no
  env option).
- **Containers (every provider):** the runtime credential file (`/tmp/orkestrator-ai/github-token`)
  and the global Git `url.<token>.insteadOf` rewrite stay readable; only the remote-ref guard
  detects a push there. SSH keys are untouched everywhere.

**2026-10-29 · Helper for 214.** Protocol `@orkestrator/protocol/graphs/agent-enforcement`:
`graphAgentNodeEnforcement(compiled, platform, host)` (moved from backend
`graph-agent-policy.ts`, which re-exports `GRAPH_RESEARCHER_ON_CLAUDE_REASON` and
`graphAgentReadOnlyTurn`), `graphRoleProviderChoices(plan, host, platforms)` →
`GraphRoleProviders[]` (`{role, nodes, floor?, choices: [{platform, tier, reason?, allowed,
blockedBy?}]}`), `graphBindingFloorProblems(plan, roles, host)` (for refusing a launch),
`graphAgentFloorMessage`, `graphActivationEnforcementView(activation)` and `GRAPH_GUARD_LABELS`
(for 211). The launch compile (`graph_template_compile {forLaunch: true}` / `compileForLaunch`)
re-probes the host and returns `providerChoices` (enabled providers only). The dispatch message:
"<Provider> holds step <id> only at <tier> on this host, below the step's floor (<floor>), so it
was not started. <reason>".

**2026-10-29 · Live conformance.** Not runnable here: no graph launch command/dialog exists until
214, and no provider credentials. Recorded as task 10 of
[todo 0031](../../docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md):
per provider (Claude macOS/Linux ± bubblewrap, Codex, OpenCode, Cursor, Grok, Pi) a reviewer node
asked to write/commit/push, a builder asked to push, `gh auth status`/HTTPS push from the node's
shell, a bubblewrap break between launch and dispatch, and a Claude researcher. The coordinator
live suite gets a `graph-profiles` scenario once 214 lands.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Guards (read-only, remote-ref, enforcement at dispatch), Claude/Grok credential withholding, launch picker helper, tests, docs, todo 0031 task 10. · Codex/Pi withholding, inspector rendering (211), live conformance (after 214).
