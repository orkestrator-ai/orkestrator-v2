---
id: 209
title: "Guards and enforcement"
phase: 2
plan: "P2.9"
status: in-progress
depends_on: [001, 106, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-guard-polish"
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
  - [x] Codex sessions withhold it from every command the thread runs (per-thread `shell_environment_policy`, checked live against the pinned app-server).
  - [x] Pi sessions withhold it from their shell tools (`spawnHook`) and the MCP servers the bridge starts.
  - [x] ~~OpenCode and Cursor sessions withhold it too~~ (impossible: one shared `opencode serve` per directory and Cursor's in-process SDK have no per-session environment; see Notes).
- [x] `minEnforcement` filters pickers at launch and is re-checked at dispatch; a tier that dropped since launch fails the activation before dispatch.
- Record the applied tier on the activation and show it in the inspector:
  - [x] Recorded on the activation (`enforcement`, `enforcementReason`, `guards`), with `graphActivationEnforcementView` for the inspector.
  - [x] Shown in the inspector (item 211 renders it: `GraphRunInspector.tsx`, test "shows the profile, the tier actually enforced and why, guards, usage and errors" in `GraphRunTab.test.tsx`).

## Tests

- [x] A committing reviewer is refused (fake providers here; live runs batched in todo 0031).
- [x] A push attempt is detected.
- [x] A tier drop fails before dispatch with a clear message.

## Done when

- [x] Guards and enforcement checks are in place, and the tiers shown match live conformance runs (Claude, Codex, OpenCode and Pi on macOS, 2026-10-29; Grok, Cursor and Linux not run, see Notes and todo 0031 task 10).

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
- **Codex:** done 2026-10-29 (see the entry below).
- **Pi:** done 2026-10-29 for shell tools and bridge-started MCP servers (see the entry below).
- **OpenCode, Cursor:** not feasible per session (shared `opencode serve` / in-process SDK with no
  env option).
- **Containers (every provider):** the runtime credential file (`/tmp/orkestrator-ai/github-token`)
  and the global Git `url.<token>.insteadOf` rewrite stay readable; only the remote-ref guard
  detects a push there. SSH keys are untouched everywhere.

**2026-10-29 · Codex and Pi credential withholding** (branch `graphs-209-credentials`).
- **Protocol:** `WITHHELD_GITHUB_ENV_VARS` (the five token variables plus
  `ORKESTRATOR_GITHUB_CREDENTIAL_FILE`) and `NATIVE_AGENT_GITHUB_CREDENTIAL_WITHHOLDING`
  (`Record<AgentPlatform, {withheld, gap?}>`: Claude, Grok, Codex, Pi withheld; OpenCode, Cursor
  not). The remote axis stays **advisory on every provider**: withholding is never a boundary (SSH
  keys, the container's credential file, Git `insteadOf`, and an ancestor's environment through
  `/proc/<pid>/environ` stay reachable). Only its reason changed: it names the withheld credential
  where the platform withholds it, adds the platform's `gap` (Codex: app-server keeps it; Pi:
  extensions keep it) and, on OpenCode and Cursor, says the session keeps the credential.
- **Codex:** `shell_environment_policy` is accepted as thread configuration and applied per thread
  on the shared app-server. Checked against the pinned 0.164.0 with no credits
  (`bridges/codex-bridge/src/app-server/live-github-credential.test.ts`, `RUN_LIVE_CODEX_APP_SERVER=1`):
  one app-server with fake tokens in its environment, a graph-policy thread whose `env` command sees
  no token, no credential-file path, `GH_CONFIG_DIR` at the empty directory and the three helper
  resets (also after `reloadThread` rebuilds it from its rollout), and a sibling thread without the
  policy that still sees the tokens. Fails when the override is removed. Mechanism
  (`github-credential-config.ts`, `codexGitHubCredentialThreadConfig`): dotted keys
  `shell_environment_policy.exclude` = the process's own exclude list (`codexProcessShellExclude`;
  a thread value replaces it, which matters for a coordinator) + `WITHHELD_GITHUB_ENV_VARS` +
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`, and `shell_environment_policy.set` =
  `GH_CONFIG_DIR` + resets numbered from 0 (appending after an inherited count breaks under
  `inherit = "core"`; copying inherited entries would put an `http.extraheader` token into the
  request). Engine: `githubCredentialThreadConfig` in `policyThreadConfig` (start, resume, fork),
  option `ghConfigDir` (default one `mkdtemp` per process); a directory failure refuses the thread.
  `promptThreadConfig` includes the flag so a change reloads a loaded thread (graph result turns
  reload anyway). Not covered by the policy: app-server's own environment, hooks, and stdio MCP
  servers (they get Codex's default variable set plus what their entry names; graph nodes load only
  granted servers, item 404).
- **Pi:** `bridges/pi-bridge/src/github-credential.ts`. `createPiAgentSession` passes
  `withheldShellToolDefinitions` as `customTools` for a withholding policy: the SDK's own
  `createBashToolDefinition` (with the settings' command prefix and shell path) and
  `createPowerShellToolDefinition`, each with a `spawnHook` applying
  `withheldGitHubCredentialEnvironment`, `defaultActive: false` so activation follows the tool names
  as for built-ins. SDK custom tools win over built-ins and extension tools of the same name;
  `codemode` reaches the same registrations. MCP (`mcp.ts`): `preparePiMcp` resolves `mcp.json`
  `$NAME` references against the withheld environment (an entry naming a credential variable is
  skipped as unresolvable) and passes `PiMcpConnectContext.withheldGitHubCredential` to the
  transport, whose `stdioEnvironment` withholds before the entry's own `env` overlay. The MCP
  connection key carries the flag, so a policy flip rebuilds the session at the next turn boundary.
  Tested inside a real SDK session (`sdk-session.test.ts`: graph session's `env` lacks the token,
  ordinary session's has it; fails without the override) and in `github-credential.test.ts`.
  **Still inherits it:** Pi extensions (loaded only with project resources on) run in the bridge
  process and can read `process.env` or spawn with it; a credential written literally into an
  `mcp.json` entry reaches that server if the node was granted it.
- **OpenCode, Cursor:** impossible per session, unchanged (one `opencode serve` per directory; the
  Cursor SDK in the bridge process with no per-session environment option).

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

**2026-10-29 · Live conformance run** (worktree `graphs-live-verify` at `0f24330e3` plus the
`run-validation` fix of the same change; macOS, Claude sandbox available). Profile `graphs-live`
(`dev:test --fixture --credential-source claude,codex,opencode,pi,grok --agent-platforms
claude,codex,opencode,pi,grok`; the host Grok login had expired, so Grok was enabled but could not
run, and Cursor had no host login). The fixture's `origin` is a local bare repository inside the
profile (`fixtures/origin.git`), so every push went there and nowhere else. Two saved templates,
each one agent node: `qa-live-reviewer` (`reviewer` profile, `workspaceAccess: read`, default floor
`provider-configured`) asked to create a file, append to `README.md`, `touch` from the shell, `git
commit --allow-empty` and `git push origin HEAD:refs/heads/qa-reviewer-probe`; `qa-live-builder`
(`builder`, `write`) asked to create and commit a file and `git push` it to a new branch. One local
environment per provider; launched with `orkestrator graph launch … --role <role>=<provider>`
(Claude `sonnet@low`, Codex `gpt-6-luna@low`, OpenCode its default, Pi `openai/gpt-6-luna`); results
read with `graph_run_get` / `graph_run_transcript` (tool calls checked, not just the agent's own
report). Tiers shown: the "Run graph…" dialog, `orkestrator graph show --project --environment` and
the activation's dispatch-time `enforcement` guard agreed on every row.

| Provider | Reviewer tier shown | Reviewer: what happened | Builder tier shown | Builder push: what happened | Holds? |
| --- | --- | --- | --- | --- | --- |
| Claude | enforced | File tools absent; `touch`, `git commit`, `git push` refused by the bridge's read-only Bash hook. Worktree, HEAD and origin unchanged; guards passed. | advisory | Commit allowed; `git push` refused by Claude's permission rule ("Permission … denied"); remote-ref passed. | yes |
| Codex | enforced | Every attempt refused by the OS sandbox ("Operation not permitted"; push: "unable to create temporary object directory"). Unchanged; guards passed. | advisory | Pushed a new branch; **remote-ref guard violated**, activation failed `guard-violation`. | yes |
| OpenCode | provider-configured | Every attempt refused by OpenCode's permission rules. Unchanged; guards passed. | advisory | Commit allowed; `git push` refused by OpenCode's permission rule; remote-ref passed. | yes |
| Pi | enforced | Every attempt refused by the bridge's read-only gate. Unchanged; guards passed. | advisory | Pushed a new branch; **remote-ref guard violated**, activation failed. | yes |
| Grok | advisory, not offered (below the floor) | not run: host login expired | advisory | not run | picker filter only |
| Cursor | not enabled | not run: no host login | not enabled | not run | — |

Run ids (the profile was reset afterwards, so they no longer exist): reviewers `launch-e19ba7ac…`
(Claude Sonnet; a Haiku run skipped the attempts and is not counted), `launch-46cede1d…` (Codex),
`launch-cf8590ed…` (OpenCode), `launch-f0cd7abf…` (Pi); builders `launch-dd34c531…` (Claude),
`launch-ed8ee3ba…` (Codex), `launch-54a0871f…` (OpenCode), `launch-14e7ee1b…` (Pi). Codex and
OpenCode come from the parallel first round, where Codex's own push created the branch and
OpenCode never pushed; Claude and Pi were rerun one at a time against a remote without the probe
branch (finding 1). Every enforced
claim held, and so did the provider-configured one. No read-only node changed the workspace, so the
`worktree_changed` refusal and the consumption-time read-only failure were not reached live (the
providers refused first); they stay proven by the fake-provider tests. The builders show the
remote axis is advisory as stated: Claude and OpenCode refuse `git push` as written (stronger than
the tier, as their commit axis already says: another spelling would run), Codex and Pi push and
the guard catches it.

Findings. (1) **Remote-ref false positive with byte-identical commits.** The first builder round
ran all four providers in parallel with the same prompt; Claude's and Codex's commits were
byte-identical (same parent, tree, message, identity and second), Codex pushed, and Claude's
activation was also failed as a push although Claude's push had been refused. Commits are
content-addressed, so the guard's "a head points at a commit the activation created" cannot tell
them apart. It fails closed (never a missed push) and needs identical commits made in the same
second in sibling worktrees of one repository; recorded, not changed. (2) Claude's read-only hook
words its refusals as "Coordinator is read-only" / "Coordinator shells cannot …" inside a graph
reviewer (shared policy text in `bridges/claude-bridge/src/services/read-only-policy.ts`);
cosmetic, left for a follow-up. Not run: Grok and Cursor (no usable host login), Claude on Linux
with and without bubblewrap and the bubblewrap break between launch and dispatch (macOS host),
`gh auth status`/HTTPS push from a node's shell (agent-test profiles carry no GitHub credential, so
it could not distinguish withholding from absence). These stay in todo 0031 task 10.

**2026-10-29 · Live findings fixed** (branch `graphs-guard-polish`).
- **(1) Remote-ref attribution of an identical commit.** New
  `apps/backend/src/core/graph-agent-remote-attribution.ts`; the created-commit
  scan moved there (`graphCreatedCommits`, now bounded by a window
  `graphGuardWindow(capturedAt, finishedAt?)`, ±2 s skew). Unchanged: a ref
  pointing at a commit the activation created, and no other activation created
  it, is its push. New: when peers (other agent activations of any non-mock run
  with a baseline, captured before now and not finished before this capture −
  2 s; newest 16; `graphGuardPeerSource` over `listAllGraphRuns`, wired by
  default in `installGraphAgentExecutor`, dependency `peers`/`guardPeers`)
  created the same commit, each repository's own record of the push decides
  (`graphPushEvidence` → `pushed | none | unknown`): for a branch, a reflog
  entry "update by push" to that commit on `refs/remotes/<remote>/<branch>`
  within the activation's window; for a tag, the local tag at that commit.
  `graphAttributePush`: own evidence `none` and a peer's `pushed` → passed,
  detail "… is an identical commit that step <id> of run <id> pushed"; own
  `pushed` and every claimant `none` → violated; otherwise **ambiguous**:
  outcome `unavailable` (no protocol change; an older backend can still read
  the record), detail "cannot be attributed (ambiguous): <ref>: <peer> made
  the identical commit, and <reason>. The guard fails closed rather than
  guess." Reasons: a shared repository, no record anywhere (push by URL,
  reflogs off), unreadable evidence, or a peer in the same checkout. A peer
  source that fails or a peer that cannot be read clears nobody. At most 20
  refs are attributed per certification; any beyond are the activation's.
  `certify` takes `activationKey` so an activation is not its own peer.
  **Limit, stated plainly:** the live case (two *local* environments of one
  project) is still failed on both sides, now as ambiguous with the reason
  instead of a false "pushed". Local environments are worktrees of one
  repository, which share remote-tracking refs, tags and their reflogs; Git
  records nothing per worktree for a push, so no Git evidence can say which
  worktree pushed. Separate clones (container environments) are attributed
  precisely. A per-activation snapshot of every remote ref was considered and
  not stored: a ref can point at a commit created after the capture only if
  it changed during the window, unless an identical commit existed before,
  which the peer check covers (a peer that pushed and finished more than 2 s
  before this capture is not considered; the activation is then blamed, fail
  closed). Dropping the `base..HEAD` source (reflog only) was rejected: a
  repository with reflogs off would then hide real pushes.
  Tests: `graph-agent-remote-attribution.test.ts` (fake repos: separate
  clones → pusher violated, other passed; shared repository and push by URL →
  both ambiguous; no claiming peer → violated; failing source/unreadable peer
  clears nobody; same checkout; peer selection) and
  `graph-agent-remote-attribution.integration.test.ts` (slow tier, real Git:
  a bare origin, byte-identical commits via fixed author/committer dates, one
  push; clones → precise, worktrees → both ambiguous).
- **(2) Claude refusal wording.** `read-only-policy.ts` keeps one decision
  path and two wordings (`REFUSALS`, `ReadOnlyRefusalRole`):
  `readOnlyRefusalRole(sessionPolicy, readOnlyTurn)` is `coordinator` in a
  coordinator process (`ORKESTRATOR_BRIDGE_EXECUTION_POLICY`) or for a
  non-`readOnly` turn under the coordinator policy, else `read-only`. Graph
  reviewers and pipeline reviews (`readOnly` turns on an ordinary bridge) now
  read "This session is read-only, so `git commit` is not available here."
  with no delegation advice; coordinator wording is unchanged (default role).
  Passed from `claudeQueryOptions` (`session-manager-prompt-query.ts`). Tests:
  `read-only-policy.test.ts` (neutral wording for every refusal kind, role
  rule) and `session-manager-read-only-wording.test.ts` (the launched CLI's
  hook, review vs coordinator).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Guards (read-only, remote-ref, enforcement at dispatch), Claude/Grok credential withholding, launch picker helper, tests, docs, todo 0031 task 10. · Codex/Pi withholding, inspector rendering (211), live conformance (after 214).
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Codex (per-thread `shell_environment_policy`, live-checked on 0.164.0) and Pi (spawn-hooked shell tools, withheld MCP environment) credential withholding; OpenCode/Cursor struck as impossible; per-platform remote-axis reason; docs. · Inspector rendering (211), live conformance (after 214).
- 2026-10-29 · coordinator · Ticked "Shown in the inspector": 211's inspector renders the applied tier, its reason and guard results (test cited). · Live conformance remains (todo 0031 task 10).
- 2026-10-29 · Claude Opus 5.5 (live verification, `graphs-live-verify`) · Live conformance on Claude, Codex, OpenCode and Pi: shown tiers matched, every enforced claim held, pushes caught by the remote-ref guard; Done when ticked. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (guard polish, `graphs-guard-polish`) · Live findings fixed: identical-commit attribution through per-repository push evidence (precise for separate clones, explicit ambiguous failure for worktrees of one repository); neutral read-only refusal wording for non-coordinator Claude turns. · complete; awaiting PR
