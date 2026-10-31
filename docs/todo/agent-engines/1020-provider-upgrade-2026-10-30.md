# Provider upgrade of 2026-10-30

## Task analysis

Analysed 2026-10-30 against main at `6ce02251b`.

### Tasks

1. **Upgrade decision for each provider**: which release each pin moves to. Status: done.
2. **Claude: the new startup-failure reason**: `sandbox_required_unavailable`. Status: done.
3. **Codex: review delivery narrowed upstream**: `review/start` lost `detached`. Status: done.
4. **Codex: goal tools offered to every thread**: goals are stable and on. Status: done.
5. **Cursor: compaction outcome on `summary-completed`**: `failed` and `fallback`. Status: done.
6. **Adopt-later and not-relevant calls**: every other change in the changelogs. Status: done (adopt-later items moved to 0007's Candidates).
7. **Capacity and overload findings**: recorded for the retry-with-backoff work. Status: done (record only; no retry built here).
8. **OpenCode 2.x gate**: whether anything in 2.x changed 0008's gate. Status: done (unchanged).
9. **Live evidence at the new pins**: the signed-in checks the fixture and fake-model suites cannot make. Status: partly done; release qualification remains open (see review evidence below).

### 1. Upgrade decision for each provider

**Problem.** Every pinned SDK and CLI had drifted behind upstream, so fixes and features in newer releases were unused.

**Context.** The runbook is [upgrade-agents.md](../../development/upgrade-agents.md). OpenCode stays on 1.x until 0008's gate opens.

**Investigation.** Upstream on 2026-10-30 (`npm view … dist-tags`, the Grok `stable` pointer, GitHub releases):

| Provider | Old | New | Notes |
| --- | --- | --- | --- |
| Claude Agent SDK / CLI | 0.3.309 / 2.1.309 | 0.3.314 / 2.1.314 | npm `latest`; the SDK's `claudeCodeVersion` is 2.1.314, the managed CLI's version. npm's `stable` tag is 2.1.308, older than the old pin. |
| `@anthropic-ai/sdk` | 1.2.0 | 1.3.0 | The three imported types are unchanged. |
| Codex | 0.164.0 | 0.166.0 | 0.165.0 and 0.166.0 are the only stable releases after the pin; everything else is alpha. |
| OpenCode SDK / CLI | 1.19.4 | 1.19.5 | The SDK is byte-identical apart from its version. |
| `@cursor/sdk` | 1.0.40 | 1.2.0 | 1.1.0 and 1.2.0 in between; no changelog, only the README. |
| Pi | 1.4.0 | 1.4.0 | No newer release on npm or GitHub. |
| Grok Build | 1.0.67 | 1.0.70 | The `stable` pointer; `alpha` is 1.0.73. |
| `@agentclientprotocol/sdk` | 2.0.1 | 2.1.0 | No stable v1 type the bridge reads changed. |

**Decisions.**

- **Which release per provider?**
  - **The latest stable release of each, one commit per provider (recommended).**
    - Pros: picks up every upstream fix; one revertable unit per provider, as the runbook's rollback asks.
    - Cons: Cursor moves two minor lines at once.
  - **Patch releases only (hold Cursor at 1.0.x).**
    - Pros: smaller behavioural surface.
    - Cons: no 1.0.x patch exists after 1.0.40, so Cursor would not move at all.
- **Claude CLI: `latest` or `stable`?**
  - **`latest` (2.1.314), matching the Agent SDK's `claudeCodeVersion` (recommended).**
    - Pros: the SDK and the managed CLI are the combination upstream tested; the previous pin also followed `latest`.
    - Cons: `latest` has had less soak time than `stable`.
  - **`stable` (2.1.308).**
    - Pros: upstream's slower channel.
    - Cons: older than the old pin, so a downgrade, and mismatched with the SDK.

### 2. Claude: the new startup-failure reason

**Problem.** Agent SDK 0.3.314 adds `sandbox_required_unavailable` to `SDKStartupFailureReason`, and the exhaustive switch in `claudeStartupFailureMessage` stopped compiling.

**Context.** The bridge turns each startup reason into actionable text (`session-manager-prompt-handlers/result.ts`). The new reason means a working sandbox is required (by settings or policy) and cannot run, for example because bubblewrap is missing.

**Investigation.** The SDK's doc comment on `SDKStartupFailureReason` (`sdk.d.ts`, 0.3.314) gives the meaning. It was the only union change in 0.3.309 → 0.3.314: `SDKMessage`, system subtypes, hook events, `Options`, `Query`, `ModelInfo`, the context-category ids and `BUILTIN_TOOL_NAMES` are unchanged.

**Decisions.**

- **How to map it?**
  - **A specific message that names the sandbox and the fix (recommended).**
    - Pros: the user learns to install the sandbox or change the requirement instead of retrying.
    - Cons: one more string to keep current.
  - **Add a `default` branch with generic text.**
    - Pros: future reasons compile without edits.
    - Cons: loses the exhaustiveness check that caught this one.

### 3. Codex: review delivery narrowed upstream

**Problem.** Codex 0.166.0 removed `delivery: "detached"` from `review/start` (`ReviewDelivery` is `"inline"` only), but `startReview` still accepted it.

**Context.** Production already sends `"inline"` (`app-server-runtime-sessions.ts`); only a test sent `"detached"`.

**Investigation.** The regenerated `ReviewDelivery.ts`, `ReviewStartParams.ts` and `ReviewStartResponse.ts` (0.166.0): `reviewThreadId` is now always the thread passed in.

**Decisions.**

- **Narrow or keep?**
  - **Type the parameter with the generated `ReviewDelivery` (recommended).**
    - Pros: the next upstream change to the union reaches the bridge as a type error.
    - Cons: none.
  - **Drop the parameter.**
    - Pros: simpler signature.
    - Cons: a future second delivery mode would need the parameter back.

### 4. Codex: goal tools offered to every thread

**Problem.** Every native Codex thread offered the model `create_goal`, `get_goal` and `update_goal`, although 0007 records Codex goals as decided out and disabled.

**Context.** 0007 said goals sat behind `features.goals`, which the bridge never sets. Orkestrator ignores `thread/goal/*`, so a goal the model set was invisible, and a goal Codex continues on its own would run turns the bridge never dispatched.

**Investigation.** `codex features list` in a temporary `CODEX_HOME` shows `goals  stable  true` on both 0.164.0 and 0.166.0. A loopback probe (a fake Responses endpoint, the bridge's own `codexAppServerConfigOverrides`) found the three tool names in the first model request. With `features.goals=false` they were gone. The premise in 0007 ("behind a flag the bridge never sets") was wrong: the flag defaults on.

**Decisions.**

- **Turn goals off, or adopt them?**
  - **Turn them off with `features.goals=false`, which is what 0007's decision already says (recommended).**
    - Pros: makes the code match the recorded product decision; no turns the bridge did not dispatch; proved by a loopback test with a control.
    - Cons: a user who relied on the model's goal tools in an Orkestrator Codex tab loses them; nothing in Orkestrator showed them.
  - **Adopt goals: render `thread/goal/*` and own continuation turns.**
    - Pros: parity with the Codex CLI.
    - Cons: a turn-ownership design the bridge does not have; reopens a decided-out item without a product decision.

### 5. Cursor: compaction outcome on `summary-completed`

**Problem.** `@cursor/sdk` 1.2.0 says how a compaction ended (`failed`, `fallback`), and the bridge showed both as a successful summary.

**Context.** `failed` leaves the conversation unchanged; `fallback` means the model could not write a summary and Cursor kept a trimmed copy of the transcript (the 1.2.0 README, "Summarize the conversation").

**Investigation.** `SummaryCompletedUpdateSchema` gained `failed?` and `fallback?` (`dist/cjs/vendor/cursor-sdk-shared/delta-types.d.ts`). The runtime forwards them from the protobuf `summaryCompleted` message, and its completion carries no `summary` text. That also meant a `summary` that arrived before `summary-completed` settled the boundary, and the completion then appended a second, empty one.

**Decisions.**

- **How to show it?**
  - **Settle a failed boundary as `failure` with a note, prefix a fallback boundary with a note, and settle the boundary a `summary` already closed instead of adding one (recommended).**
    - Pros: provider-neutral (the compaction part already allows `failure`); fake-tested, with the SDK's own schema parsing the update.
    - Cons: outcome flags and event ordering need both adapter fixtures and signed-in evidence; see the review evidence below.
  - **Ignore the new fields.**
    - Pros: no work.
    - Cons: a failed compaction reads as success, though the model still holds the whole conversation.

### 6. Adopt-later and not-relevant calls

**Problem.** Without a record, the next review rereads the same changelogs.

**Context.** Adopt now meant a clear benefit, small, and testable with fakes or fixtures. Adopt-later items go into 0007's Candidates, which is rechecked on every bump.

**Investigation.** Changelogs, `.d.ts` diffs and the regenerated Codex protocol, per provider:

- **Claude** (Claude Code 2.1.310–2.1.314, Agent SDK 0.3.310–0.3.314):
  - Adopt later: `permissions.blockWritesOutsideWorkingDirectories` (a worktree-confinement policy; needs a product decision, and also removes EnterWorktree/ExitWorktree); `prewarm()` in `/core` with `claim()` now deciding `.mcp.json` servers and plugins (a spare-process lifecycle change, see 0005).
  - Not relevant: the split cache-creation token counts (`cacheCreationEphemeral5mInputTokens`, `…1hInputTokens`; cost comes from `costUSD`); typed auto-mode settings; AskUserQuestion `annotations[q].unanswered` (the model does not see it); the `mcpMount` rule source; `'Now using credits'` usage prefix; new `sdk-tools.d.ts` output fields; managed `pluginDigests`.
  - Behaviour, no code change: settings left out of `settingSources` no longer supply auto-mode rules or saved consents (what coordinators intend); `claude -p` startup failures now exit 1 with the error (checked in [0006](0006-session-titles-and-history.md) task 1: the title runner rejects any non-zero exit, so no change was needed); Monitor commands now run Bash-matching PreToolUse hooks.
- **Codex** (0.165.0, 0.166.0):
  - Adopt later: `Account.chatgpt.workspaceName` in the account label (the shared account shape has no workspace field); experimental `accountSession/list|switch`, `thread/fork.attachToSource`, `thread/memory/read`.
  - Not relevant: item `startedAtMs` / `completedAtMs` (a reload reads the rollout's own timestamps); Vertex/GCP provider and `account/gcp/setup`; new models through `model/list`; `nativeUsageUsdMicros`, `ImageGenerationItem.generationId`, `HooksListParams.threadId`, `ProcessExitedNotification.outputDrainTimedOut`, `Otel*` requirements (unread fields); features still off by default (memories, `mcp_connection_sharing`, Guardian v3); TUI and WebSocket changes; `plugin_discovery_prefetch` (plugins are decided out, and turning it off is optional).
  - Behaviour, no code change: `reasoning_effort_override` became stable and writes `configuration_update` items, which the reducer already handles; idle threads with no subscriber unload after 60 s instead of 1800 s, which idle detach already assumes; a resume whose saved model provider differs from the current one is refused (only users who set `model_provider` themselves).
- **Cursor** (1.1.0, 1.2.0):
  - Adopt later: `agent.summarize()` as a manual compaction (needs run ownership and a command route; throws on cloud agents and before the first saved conversation); root-session `resourceProviderOptions` / `overrideDeleteExecutor` as a coordinator write guard (the executor type is opaque).
  - Not relevant: `local.fs` and the fs helpers (the bridge runs on the real worktree); `SDKSummaryMessage` (the delta stream already carries the summary events); `local.reportedWorkspacePath`; stored run errors as `[code] message` (read back by the SDK).
  - Still blocked: `askQuestion` (still only in `ToolName`; the 1.2.0 runtime still auto-rejects it).
- **Grok** (1.0.68–1.0.70):
  - Adopt later: cost from `costUsdTicks` (unit now known, see 0007 task 11); elicitation through `x.ai/mcp/elicit` (0007 task 10); `GROK_DISABLE_EXPERIMENTS=1` for bridge children (stops config-file experiments changing the model, but overrides experiments a user joined); the `retry_state` session update for retry UI (unknown whether it reaches ACP clients).
  - Not relevant: TUI, dashboard, vim and worktree-copy changes; `GROK_UPDATE_CHANNEL` (the pin comes from the manifest); daemon-route features.
- **ACP SDK** (2.0.2, 2.1.0): not relevant: `RequestError.sessionNotFound` (agent side), MCP-over-ACP (Grok does not implement it), unstable `SessionMessage` ids, SSE and HTTP transport fixes.
- **OpenCode** (1.19.5): not relevant: the TUI worker RPC error reply, PTY route auth, `gitlab-ai-provider` 6.23.1. No SDK or server surface changed.
- **Pi**: no release.

**Decisions.**

- **Where do adopt-later items live?**
  - **In 0007's Candidates, each with what blocks it (recommended).**
    - Pros: one backlog rechecked on every bump, as its maintenance rule says.
    - Cons: 0007's list grows.
  - **Only here.**
    - Pros: one file per upgrade.
    - Cons: the next bump reads 0007, not this file, and would miss them.

### 7. Capacity and overload findings

**Problem.** A retry-with-backoff change for "model at capacity" and overload errors is being built separately (environment `0a0c29c6` on arktech-mini). It needs the exact shapes at the new pins.

**Context.** This upgrade records them and builds no retry.

**Investigation.**

- **Claude.** No type change. `api_retry` system messages keep `attempt`, `max_retries`, `retry_delay_ms`, `error_status` and `error: SDKAssistantMessageError` (which includes `rate_limit` and `overloaded`); results keep `api_error_status`. CLI 2.1.311 stopped retrying requests the API marks `x-should-retry: false`, so those failures reach the bridge sooner. 2.1.314 lowers an admin-capped effort and retries by itself. The binary classifies 529 or an `overloaded_error` body as `overloaded` and 429 as `rate_limit` (not compared against 2.1.309).
- **Codex.** `CodexErrorInfo` gained `policyCapacityUnavailable` (0.166, from a 503 `policy_capacity_unavailable`: "Policy-restricted capacity is unavailable. Please try again later.") and `modelNotFound` (0.165, never retried). `serverOverloaded` ("Selected model is at capacity. Please try a different model.") is unchanged. Codex retries either capacity code itself only when the server sends `Retry-After`, as `error` notifications with `willRetry: true`; otherwise the turn fails with `willRetry: false`. Both new codes pass through `codexErrorInfoToCode` unchanged. `-32001` is still app-server's own queue being full, not model capacity.
- **Cursor.** Error classes unchanged: `RateLimitError`, `NetworkError` and the rest, with `isRetryable` on `CursorSdkError`. No overload or capacity code exists. Run errors are now stored as `[code] message`, so `RunResult.error.code` survives a reload. The SDK's own retries (on unless `local.enableAgentRetries` is `false`) appear to gain a `Retry-After`-honouring rate-limit retry, capped at 300 s in total (read from the bundle, unproven), so errors the bridge sees have usually exhausted them.
- **OpenCode.** Unchanged in 1.19.5: `session.status` `{ type: "retry", attempt, message, next }` and `APIError.data.isRetryable`.
- **Grok.** Unchanged since 1.0.67: "Grok is temporarily overloaded…" text, error kinds `RateLimited`, `ServiceUnavailable` and others, a `retry_state` update, `rate_limit_retry_threshold`. The ACP schema has no overload stop reason or error code.

**Decisions.**

- **Build anything here?**
  - **No; hand the shapes over (recommended).**
    - Pros: no conflicting retry layer; the other worker owns the design.
    - Cons: the new Codex `policyCapacityUnavailable` is surfaced only as a code until that work lands.
  - **Classify `policyCapacityUnavailable` as retryable now.**
    - Pros: earlier benefit.
    - Cons: overlaps the other worker's change.

### 8. OpenCode 2.x gate

**Problem.** The upgrade had to say whether OpenCode 2.x changed 0008's readiness gate.

**Context.** 0008 was rechecked against 2.2.2 on 2026-10-30.

**Investigation.** `@opencode/cli` latest is still 2.2.2 (2026-10-29). `CHANGELOG.md` at `v2.2.2` touches none of the gate's conditions: image generation default, `SessionInfo.time.busy`, schedule conditions, prompt attachment source metadata. The prompt body still has no per-prompt model, agent, tools or structured output. The 47 unreleased `dev` commits since touch no storage policy, prompt schema, stale-turn guard, inbox bound or MCP endpoint. There is no 1.x end-of-life notice, and both `@opencode-ai/sdk` and `opencode-ai` are `latest` 1.19.5.

**Decisions.**

- **Move to 2.x?**
  - **No; stay on 1.19.5 (recommended).**
    - Pros: 0008's gate is still closed.
    - Cons: 2.x-only features stay out of reach.
  - **Start the 2.x provider.**
    - Pros: none new since 0008's recheck.
    - Cons: ships the losses 0008 lists.

### 9. Live evidence at the new pins

**Problem.** The suites below ran without logins. Several behaviours need a signed-in run, or a host this worker did not have.

**Context.** The initial upgrade used no billed turns. The review implementation request authorized signed-in qualification in an isolated profile; its evidence is recorded below. 0031 owns cross-platform qualification runs.

**Investigation.** At the initial upgrade, the following had not run at the new pins. The review evidence below supersedes individual checks, not the whole list:

- Claude: the billed coordinator-skills probe; the Linux sandbox probe (Linux host); `claude-host-login-refresh.ts` (container with a fake login); a local and a container native session (streaming, questions, abort, resume, model discovery, background task).
- Codex: the steer, MCP-approval and web-search canaries (billed); the rollout user-segment scan of real rollouts.
- OpenCode: `scripts/qualify-opencode-seeded-data.sh` against a built image; UI and build-pipeline smoke tests.
- Cursor: sign-in through `--login`, a turn with tools and a diff, model and effort switch, cancel, sub-agent cards; the real order of `summary` and `summary-completed`.
- Grok: a signed-in `session/new`, an edit without an approval card, a `use_tool` match, `/compact` over ACP, `session_info_update`.
- Every provider: slash-command re-qualification (only the Codex disabled-skills probe re-ran) and the inactive-environment path.

**Decisions.**

- **When to run them?**
  - **Before the upgrade ships in a release, in a throwaway profile, batched with 0031 (recommended).**
    - Pros: one signed-in session covers several providers.
    - Cons: the merge lands before the evidence.
  - **Block the merge on them.**
    - Pros: nothing unproven merges.
    - Cons: the pins drift again while a person finds time for billed runs.

## Assumptions and decisions

Recorded 2026-10-30 by the worker that did the upgrade. Each choice takes the (recommended) option.

### Task 1: latest stable everywhere

Moved every pin to the latest stable release, one commit per provider (Claude, OpenCode, Cursor, Codex, ACP SDK, Grok). Pi had none. Before writing the four artifact records per CLI, every one was checked against fresh upstream downloads (`verify-toolchain-artifacts.ts`). The manifest and Dockerfile were then rebuilt provider by provider and compared byte for byte against the verified state.

### Task 4: goals off

`features.goals=false` is in `codexAppServerConfigOverrides`, with a unit test and a loopback case in `live-network-lock.test.ts`. That case asserts Codex's default offers the tools and a bridge thread does not. 0007's "Decided out" entry is corrected.

### Task 5: compaction outcome

`applySummaryCompleted` takes the outcome. A completion with no text and no open boundary settles the newest boundary in the current turn instead of appending an empty one.

### Task 9: partially qualified in review

See the signed-in review evidence below. Remaining failures and unavailable credentials keep this task open before release.

## Constraints and rationale

- The initial upgrade checks ran without logins: SDK fixtures, fake models, loopback Responses endpoints and the pinned binaries in temporary homes. Review qualification used credential snapshots in a disposable profile and billed turns; no host credential, settings or transcript was edited.
- The container image was built under a throwaway tag (`orkestrator-v2-upgrade-check:tmp`), not `docker:build`'s `orkestrator-v2:latest`, which the host's own app uses.

## Review repair and signed-in evidence — 2026-10-30

The review repair (`47860b4d0`) shows `Compaction failed` in the collapsed
boundary (including a failed part produced by the Cursor adapter), and shows
`Compacting context` while pending. A completion followed by a summary revises
one boundary and keeps the failure or fallback outcome. A failure arriving
after summary text prefixes `FAILED_COMPACTION_NOTE`, preserving the text.
Regression cases cover both orders, repeated completion, multiple compactions,
a late update across model rows, and a new turn that must not reuse a boundary.

The real `@cursor/sdk` 1.2.0 local executor, with `composer-2` on macOS arm64,
emitted `summary-started → summary-completed → summary`. A read-tool turn,
manual `agent.summarize()` and follow-up all finished. Two fresh probes passed
(17.7 s and 14.6 s); neither exercised failure or fallback. The fixture at
`bridges/cursor-bridge/test-fixtures/compaction-order-1.2.0.json` retains only
event types and outcome flags. The adapter test supplies synthetic summary
text. Outcome permutations remain deliberate synthetic coverage, not a claim
that the service emitted failure or fallback in this run.

Profile: `qa-1020-review`, started with `mise run dev:test --profile
qa-1020-review --fixture --credential-source claude --credential-source codex
--credential-source opencode --credential-source cursor --credential-source
grok --credential-source pi --agent-platforms
claude,codex,opencode,cursor,grok,pi`. Its fixture, worktrees, toolchains,
credentials and provider transcripts are disposable. Managed versions are the
pins in task 1. No run targeted production sessions. Grok's expired host login
was withheld by the credential seeder, so its signed-in cases remain blocked.

- Claude and Codex: `provider-upgrade-inactive-slash`, exit 0 (228.5 s),
  both cases in `slash-command-inactive.spec.ts`. Covers command execution
  while inactive, catalogue changes, a real event-stream outage, return and
  hard reload, narrow viewport, bridge restarts at two dispatch boundaries,
  and no duplicate execution. Result:
  `output/agent-testing/qa-1020-review/browser/results.json`.
- Codex 0.166.0: `codex-signed-in-canaries`, exit 0 (18.4 s), the mutating
  MCP coordinator canary and streaming steer interruption in
  `bridges/codex-bridge/src/app-server/live-contract.test.ts`, with
  `RUN_LIVE_CODEX_APP_SERVER=1`, `RUN_LIVE_CODEX_MCP_APPROVAL_CANARY=1`,
  `RUN_LIVE_CODEX_STEER_CANARY=1`, `CODEX_PROTOCOL_BINARY=/private/tmp/ork-bin/codex/codex`,
  and `CODEX_HOME` pointing to the profile's restricted Codex credential copy.

- Cursor SDK 1.2.0: `cursor-live-cancel-resume`, exit 0 (13.0 s),
  `composer-2`: read tool completed, a streaming answer was explicitly
  cancelled (`RunResult.status=cancelled`), the handle was disposed, and
  `platform.resumeAgent` loaded the same conversation and completed another
  read-tool turn. Metadata only:
  `output/agent-testing/qa-1020-review/cursor-cancel-resume.json`.
- Pi 1.4.0: `provider-upgrade-pi-interaction`, exit 0 (31.2 s),
  `pi=openai-codex/gpt-6.1-sol`, the paused approval case plus both cleanup
  guards. The wait was shortened to 1 s: this proves ordinary approval
  raise/pause/answer/continuation, not a ten-minute hold. Pi's separate
  `opencode-go` API key returned `api_key_expired`; the default `openai`
  selection had no login. Neither failed configuration counts as a pass.

- Claude, Codex and OpenCode interactions: the available-provider run
  raised, paused, rehydrated after reload and answered all six requests.
  Claude question/approval, Codex question and OpenCode question/approval
  finished with the expected result. The Codex approval command created its
  marker and the turn became idle, but the final reply still said the command
  was pending, so the combined suite failed its continuation assertion after
  300 s. A separate `codex-approval`-only repeat passed (33.4 s), with both
  cleanup guards. This is a qualification limit, not a change to approval
  semantics or a relaxation of the assertion. Both runs used a 1 s hold,
  not a ten-minute hold.
- UI retention: in the independent `qa-1020-resume-owned` profile, OpenCode
  1.19.5 and Pi 1.4.0 (`openai-codex/gpt-6.1-sol`) passed close, reload,
  picker resume and continuation. Cursor 1.2.0 failed to show the original
  user row after selecting the sole resume entry (60 s assertion deadline).
  The complete suite returned one failure and two passes (114.3 s). The
  earlier shared-profile attempt overlapped another browser suite and is
  not used for this conclusion; the independent repeat establishes that
  concurrency does not explain the resume failure. The independent profile ran
  current bridge builds without the stale-build override.

- Inactive turns: a final repeat ran alone in `qa-1020-review`, with
  `ORKESTRATOR_AGENT_TEST_RUN_ID=qa-1020-idle-solo`,
  `ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`,
  `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=claude,codex,opencode,cursor,pi`,
  `ORKESTRATOR_AGENT_TEST_IDLE_CASES=hidden,reconnect,background`, and models
  `codex=gpt-6.1-sol,opencode=opencode-go/deepseek-v4.1-flash,pi=openai-codex/gpt-6.1-sol`.
  Command: `mise run test:logged -- --name provider-upgrade-inactive-turns -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts idle-observation-live.spec.ts --workers=1`.
  Hidden and reconnect cases passed on all five providers. Claude exercised
  a background task but failed the fresh tool-result-output assertion, as it
  had in the initial run. The other four providers' background cases were
  `not-exercised`, not qualified. Result: four provider tests passed, one
  failed (6.4 min), plus a teardown error because the failure trace exceeded
  the sanitizer's 16 MiB limit. Metadata-only case records remain under
  `output/agent-testing/qa-1020-idle-solo/idle-observation-live/`; bounded log
  evidence is `orkestrator-test-run.Nf9zT5/provider-upgrade-inactive-turns.log.gz`
  under the host temporary directory. No assertion or artifact bound changed.

The fixture-only test/JSON changes after profile startup tripped the source
fingerprint guard. Later checks set
`ORKESTRATOR_AGENT_TEST_ALLOW_STALE_BRIDGES=1` because no shipped bridge
source changed after that startup; only the ordering regression fixture and
its test were added. This is not evidence for a different runtime build.

### Validation after repair

- Targeted adapter/step-row/budget tests passed (2.5 s after adding the live
  ordering fixture); the notice-part presentation owner passed (0.3 s).
- Web and Cursor package typechecks passed (0.7 s and 0.2 s); changed-file
  oxlint and `mise run format:check` passed. Passing preparation-wide static
  checks and builds were not repeated.
- Preparation's failed `mise run test` was repeated verbatim through
  `test:logged` as `review-default-suite`: exit 0, 322.3 s. The preparation
  disk-report deadline and its isolated pass are recorded in flake 0259.
- Preparation's failed `mise run verify:codex:protocol` passed (0.8 s) with
  `CODEX_PROTOCOL_BINARY=/private/tmp/ork-bin/codex/codex`; its failed
  `mise run verify:opencode:live` passed (6.3 s) with
  `OPENCODE_CLI_PATH=/private/tmp/ork-bin/opencode/opencode`. The failures
  came from resolving an old or absent host executable, not pin drift.
- The first full browser repeat overlapped an owning-file browser run on its
  shared server. That server exited mid-run, causing connection-refused
  failures. This invalid infrastructure run is not product evidence; a
  separate exact `mise run test:browser` repeat completed afterwards: 981
  passed, 106 skipped, five failed (8.4 min). The two native branch-suggestion
  failures reproduced in the complete owning-file run (unchanged `rel` instead
  of `release/2.0`, already tracked in 0493). The other failures were mobile
  canvas tree attachment, pane transcript anchoring and tool-group overflow.
  The complete canvas, pane and tool-group owners passed alone (59.7 s,
  23.2 s and 78.5 s), recorded in flakes 1249, 0351 and 0747. These failures
  are outside the edited compaction owners; no assertion or skip was changed.

Both disposable profiles were stopped and reset with their exact `dev:stop`
and `dev:reset` commands after qualification. Sanitized evidence under
`output/agent-testing/` is retained outside their removed profile state.

### Release qualification still open

The successful checks above do not close task 9. Grok's expired credential,
Cursor's independently reproduced UI resume failure, the Claude background
output check, remaining provider slash-command cases, Linux sandbox/container
sessions, host-login refresh, rollout scanning and the OpenCode seeded-data
and build-pipeline matrix still require evidence. Failure/fallback compaction
event orders are synthetic coverage; only the successful live ordering was
observed. The deterministic fixes are ready for review, but these live limits
must be resolved before claiming release qualification.

## Related

- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md) (candidates, corrected Codex goals entry)
- [0008-opencode-v2.md](0008-opencode-v2.md)
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
- [upgrade-agents.md](../../development/upgrade-agents.md)
