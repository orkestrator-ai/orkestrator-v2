# Provider upgrade of 2026-11-06

## Task analysis

Analysed 2026-11-06 against main at `ee2cc8423`.

### Tasks

1. **Upgrade decision for each provider**: which release each pin moves to. Status: done.
2. **Claude: new SDK union members and startup detail**: two startup reasons, `session_writes_lost`, the CLI's `errors` text. Status: done.
3. **Claude: boundary hooks fail closed**: a throwing PreToolUse boundary hook ran the tool. Status: done.
4. **Claude: asks a person must answer stay out of permission rules**: `suppressAlwaysAllowRule`, `matchedAskRule`. Status: done.
5. **Pi: ChatGPT login default and install warnings**: the fallback model moved; failed installs went silent. Status: done.
6. **Codex, Cursor, Grok and ACP: no behaviour change needed**: protocol, patch and argv rechecks. Status: done.
7. **OpenCode 2.x gate**: whether 2.2.3–2.2.5 opened 0008's gate. Status: done (still closed).
8. **Adopt-later and not-relevant calls**: every other change in the changelogs. Status: done (candidates moved to 0007).
9. **Live evidence at the new pins**: signed-in checks, the container image, the Linux loopback failures. Status: open (image built and smoke-tested; Linux loopback failures fixed in the product; signed-in and macOS runs remain).
10. **One sign-in expiry for every provider**: Claude `credential_expires_at` beside Cursor's `expiresAt`. Status: done (live signed-in check open, task 9).
11. **One "a person must answer this" marker for every provider**: Claude now, Codex `humanCommand` later. Status: done (Codex path built and fake-tested; live once Codex leaves `experimentalApi`).
12. **Provider-neutral tool safety hints on approval cards**: Codex MCP `tool_annotations`. Status: done for Codex, Pi and Claude (Claude 2026-11-10: read from the CLI's MCP status when the call is parked; a signed-in check with a real MCP server is left to task 9).
13. **Where a turn's cost comes from**: Pi `totalFromProvider`, Grok `costUsdTicks`, ACP `Cost.currency`. Status: done (Grok ticks still wait on 0007 task 11).
14. **A transcript notice when a provider could not save the conversation**: Claude `session_writes_lost`, Pi's failed session write. Status: done.
15. **Grok session writeback**: whether an ACP child uploads sessions to code.grok.com. Status: done (`GROK_STORAGE_MODE=local` for bridge children; whether it outranks remote settings needs a signed-in check, task 9).

### 1. Upgrade decision for each provider

**Problem.** Every pinned SDK and CLI except OpenCode had a newer stable release, so upstream fixes and features were unused.

**Context.** The runbook is [upgrade-agents.md](../../development/upgrade-agents.md); the previous round is [1020](1020-provider-upgrade-2026-10-30.md). OpenCode stays on 1.x until [0008](0008-opencode-v2.md)'s gate opens.

**Investigation.** Upstream on 2026-11-06 (`npm view … dist-tags`, the Grok `stable` pointer, GitHub releases):

| Provider | Old | New | Notes |
| --- | --- | --- | --- |
| Claude Agent SDK / CLI | 0.3.314 / 2.1.314 | 0.3.319 / 2.1.319 | npm `latest`; the SDK's `claudeCodeVersion` is 2.1.319, the managed CLI's version. npm `stable` is 2.1.311, older than the old pin. |
| `@anthropic-ai/sdk` | 1.3.0 | 1.6.0 | The three imported block types are unchanged; 1.6.0 adds API error classes. |
| Codex | 0.166.0 | 0.167.0 | The only stable release after the pin (2026-11-06). |
| OpenCode SDK / CLI | 1.19.5 | 1.19.5 | npm `latest` and the `v1` branch head are still 1.19.5. |
| `@cursor/sdk` | 1.2.0 | 1.3.1 | 1.3.0 and 1.3.1 shipped the same day; identical `.d.ts` and README. |
| Pi | 1.4.0 | 1.5.0 | SDK and CLI, as `tracksCli` requires. |
| Grok Build | 1.0.70 | 1.0.77 | The `stable` pointer; `alpha` is 1.0.78. The binary prints `[alpha]`, which the runbook says is not evidence. |
| `@agentclientprotocol/sdk` | 2.1.0 | 2.4.0 | Stable v1 types: doc comments only. |

**Decisions.**

- **Which release per provider?**
  - **The latest stable release of each, one commit per provider (recommended).**
    - Pros: picks up every upstream fix; one revertable unit per provider, as the runbook's rollback asks.
    - Cons: Cursor and Grok each move several releases at once.
  - **Patch releases only.**
    - Pros: smaller behavioural surface.
    - Cons: no provider published a patch on its old line, so nothing would move.
- **Claude CLI: `latest` or `stable`?**
  - **`latest` (2.1.319), matching the Agent SDK's `claudeCodeVersion` (recommended).**
    - Pros: the combination upstream tested; the previous pins also followed `latest`.
    - Cons: less soak time.
  - **`stable` (2.1.311).**
    - Pros: upstream's slower channel.
    - Cons: a downgrade from the old pin, and mismatched with the SDK.

### 2. Claude: new SDK union members and startup detail

**Problem.** Agent SDK 0.3.319 adds two `SDKStartupFailureReason` members and a `system` subtype, and both exhaustive tables stopped compiling. Separately, the startup notice dropped the CLI's own `errors` text, which is where `config_file_invalid` names the broken file and `worktree_resume_refused` says whether a re-run continues.

**Context.** `claudeStartupFailureMessage` (`session-manager-prompt-handlers/result.ts`) and `SYSTEM_SUBTYPE_DISPOSITIONS` (`types/index.ts`) are keyed on the SDK's unions on purpose, so a bump forces a decision.

**Investigation.** `sdk.d.ts` at 0.3.319: `initialize_not_first` (the first stdin line was not the initialize request, so a wrapper script changed it), `config_file_invalid` (a configuration file is not valid JSON; every start is refused until it is repaired) and `SDKSessionWritesLostMessage` (disk full or quota exhausted as the CLI exits; documented as safe to ignore, results stand). No other `SDKMessage` type, hook event, `Options` or `Query` member changed. The result handler used `startupFailure || errors…`, so the `errors` text never reached the user.

**Decisions.**

- **How to show a startup failure?**
  - **The guidance followed by the CLI's own `errors` text, capped at 500 characters (`withStartupFailureDetail`) (recommended).**
    - Pros: fixes the new reason and the existing `worktree_resume_refused` text that already pointed at an error the user never saw; bounded.
    - Cons: the transcript shows the CLI's wording verbatim (a file path at most).
  - **Drop the sentence that refers to the CLI's detail.**
    - Pros: no provider text in the notice.
    - Cons: the user cannot tell which file to fix.
- **Fate of `session_writes_lost`?**
  - **`notice`, so it reaches the health panel now; a transcript notice is task 14 (recommended).**
    - Pros: compiles, counted, visible; matches the SDK's "safe to ignore".
    - Cons: a user resuming a session that lost lines is not warned in the transcript yet.
  - **`ignored`.**
    - Pros: none.
    - Cons: a disk-full host loses evidence silently.

### 3. Claude: boundary hooks fail closed

**Problem.** The CLI's default for a PreToolUse hook that throws is to run the tool anyway. The bridge's coordinator read-only hook, its stale-MCP-server hook and its workflow-result hook each hold a boundary, so an exception in any of them let the call through.

**Context.** Claude Code 2.1.317 added `onFailure: 'block'` on a hook matcher. With it set, the SDK refuses to start a query on a CLI that lacks the option. Outside agent-test profiles Claude falls back to whatever `claude` is on `PATH` (AGENTS.md, agent-testing profiles), so an older CLI there would fail every session.

**Investigation.** All three boundary hooks are wrapped by `recordingHookDenials` (`session-manager-prompt-hooks.ts`), and no other hook is. `HookCallbackMatcher.onFailure` in `sdk.d.ts` 0.3.319 documents the refusal on older CLIs.

**Decisions.**

- **How to fail closed?**
  - **Deny inside `recordingHookDenials` when the wrapped hook throws, with a fixed reason and a content-free `hook.boundary-failed-closed` log event (recommended).**
    - Pros: holds on every CLI version; one place; tested with a throwing hook.
    - Cons: does not cover a hook that returns output the CLI rejects (the bridge's outputs are typed literals).
  - **`onFailure: 'block'` on the boundary matchers.**
    - Pros: also covers invalid output; the CLI enforces it.
    - Cons: every session fails to start on a pre-2.1.317 CLI. Revisit when the bridge can read the CLI version before building the query.

### 4. Claude: asks a person must answer stay out of permission rules

**Problem.** The backend auto-applies a stored Orkestrator "always allow" rule to any request the bridge marks `ruleEligible`. Claude marks some asks as needing a person, and the bridge ignored both markers.

**Context.** `ruleEligible` is the shared, fail-closed gate for both answering with a stored rule and offering to save one (`apps/backend/src/core/permission-rules/request-detail.ts`). [0723](0723-orkestrator-permission-rules.md) owns the rules.

**Investigation.** `canUseTool` options at 0.3.319: `suppressAlwaysAllowRule` (the rule would grant more than this call, or a plugin started the call, where the CLI saves no rule at all) and `matchedAskRule` (a user ask rule forced the prompt; since 2.1.319 also when it reaches an MCP tool only under another name of its server). The SDK says hosts doing their own auto-approval should treat both as needing a person. Both fields existed before, but this release widens their meaning.

**Decisions.**

- **How to honour them?**
  - **Leave `ruleEligible` unset when either is present (recommended).**
    - Pros: reuses the shared field, so the backend, the card and the Settings list need no change; a later Codex `humanCommand` (task 11) can use the same field.
    - Cons: the card does not say why it offers no "always allow".
  - **A new `humanRequired` field on the shared request.**
    - Pros: the card could explain itself.
    - Cons: a protocol change for a reason only one provider reports today; task 11 decides whether to add it.

### 5. Pi: ChatGPT login default and install warnings

**Problem.** At 1.5.0 the bridge's last-resort model for a ChatGPT subscription login moved to `gpt-6.1-terra`, the newest backend model, while Pi itself still defaults to `gpt-6.1-sol`, so a native tab and a terminal tab would open on different models. Separately, a configured package that fails to install no longer fails the session. It is only listed in `LoadExtensionsResult.warnings`, which the bridge did not read, so its extensions disappeared without a trace.

**Context.** The rule is in `chatGptLoginModelIds` (`bridges/pi-bridge/src/models.ts`); the runbook's Pi step 6 asks for this recheck. Extension diagnostics go through `recordExtensionLoadDiagnostics` (`agent-session.ts`) into the shared health notices.

**Investigation.** pi-ai 1.5.0 `providers/data/openai-codex.json` ends on `gpt-6.1-terra`; Pi's unexported `defaultModelPerProvider` in `dist/core/model-resolver.js` names `gpt-6.1-sol` for both `openai` and `openai-codex`. The `openai` catalogue now starts on `chat-latest`. `resource-loader.js` 1.5.0 collects install failures with `collectPackageInstallWarnings` and merges them into `warnings`. The bridge's own pin test (`command-preview.test.ts`) proved Pi still attempts the install on `reload()`, which is why `skipPackageInstalls` exists.

**Decisions.**

- **Which model should a ChatGPT login open on?**
  - **Pi's own default first (`PI_CHATGPT_DEFAULT_MODEL`), then newest first, with a test that reads Pi's shipped table (recommended).**
    - Pros: native and terminal tabs agree; a Pi bump that moves the default fails a test instead of drifting.
    - Cons: one mirrored constant.
  - **Accept the newest model.**
    - Pros: no constant.
    - Cons: the two kinds of tab disagree.
- **How to surface a failed install?**
  - **A `warning` health notice per package, through the existing notice path (recommended).**
    - Pros: no protocol change; the detail carries Pi's own `pi remove …` hint.
    - Cons: the health panel, not the transcript.

### 6. Codex, Cursor, Grok and ACP: no behaviour change needed

**Problem.** Each bump had to be checked against what the bridge relies on.

**Context.** The runbook's provider sections list each check.

**Investigation.**

- **Codex 0.167.0.** The regenerated stable protocol adds `thread/section/changed`, the `humanCommand` command-approval kind and `InitializeCapabilities.requiredHumanApproval` (both need `experimentalApi`, which the bridge does not send), audio `fileId` inputs and `OtelRequirements.log_sse_deltas`. `turn/start.clientUserMessageId` and `userMessage.clientId` are intact. `codex features list` (temporary `CODEX_HOME`) shows `deferred_tool_world_state` moved from under-development/off to stable/on: deferred MCP namespaces are described in the world-state developer context checkpointed into history. The access-only auth probe reports what it did at 0.166.0.
- **Cursor 1.3.1.** `ToolName`, `InteractionUpdate`, `Agent`, `Run`, `SendOptions` and the error classes are unchanged. The diagnostic seam's minified bindings moved to `rg0`, `HZ1`, `cg0`, and the controller loop is unchanged; the rebased patch applies and the packaged import exposes `__orkestratorDiagnosticsV1`.
- **Grok 1.0.77.** Signed out: the `initialize` answer is byte-identical to 1.0.70 apart from the agent's id, instance, version and working directory; `--always-approve` and `--disable-web-search` are still global options; every `x.ai/*` name is present. 1.0.77 exits about 0.1 s after stdin EOF (1.0.70: about 2 s), so the runbook's `sleep 4 | timeout 6` liveness check reported a healthy binary as exit 0.
- **ACP SDK 2.4.0.** The stable v1 types the bridge imports are identical; `PROTOCOL_VERSION` is still 1.

**Decisions.**

- **Codex `deferred_tool_world_state`: keep it on or turn it off?**
  - **Keep it on (recommended).**
    - Pros: project-trust (including after a reload), network-lock and resume-context loopback tests all pass with it on; matches what users of the Codex CLI get.
    - Cons: tool descriptions now persist in history, as with `incremental_tools`; a signed-in resume has not been watched.
  - **`features.deferred_tool_world_state=false` in `codexAppServerConfigOverrides`.**
    - Pros: the history keeps its 0.166.0 shape.
    - Cons: no failing case justifies it; diverges from upstream.
- **`thread/section/changed`?**
  - **Add it to `IGNORED_METHODS` (recommended).**
    - Pros: thread sections are decided out (0007); keeps the unknown-notification counter clean.
    - Cons: none.
  - **Render it.**
    - Pros: none: the bridge never moves sections.
    - Cons: reopens a decided-out surface.
- **Grok liveness check.**
  - **Hold stdin open past the timeout (`sleep 10 | timeout 6`) and record why (recommended).**
    - Pros: 124 again means "alive"; a bogus-flag control exits 2.
    - Cons: none.
  - **Keep the old snippet.**
    - Pros: none.
    - Cons: it no longer distinguishes a healthy binary from one that exits.

### 7. OpenCode 2.x gate

**Problem.** The upgrade had to say whether OpenCode 2.2.3–2.2.5 changed 0008's readiness gate.

**Context.** 0008 was last rechecked against 2.2.2 (2026-10-30, [1020](1020-provider-upgrade-2026-10-30.md) task 8).

**Investigation.** Tags v2.2.2 → v2.2.5 and the published `@opencode/client` packages: storage policy (`AGENTS.md` byte-identical; one new one-way `job` migration), prompt input (identical `prompt-input.ts`: no per-prompt model, agent, tools or structured output), runtime-context gaps, stale-turn guard (identical `specs/v2/session.md`), bounded inbox and MCP endpoints (still under `/api/experimental/mcp/{server}`) are all as they were. No 1.x end-of-life notice. Not run: the 2.x binary itself. 2.x changes to remember for the future provider: `integration.use` no longer covers MCP, skills or plugins (`mcp.use`, `skill.use`, `plugin.use`); schedules now fire under `opencode serve` when `experimental.schedules` is on, which would run turns Orkestrator never dispatched; a built-in Claude Agent provider; experimental artifacts.

**Decisions.**

- **Move to 2.x?**
  - **No; stay on 1.19.5 (recommended).**
    - Pros: every gate condition is still closed.
    - Cons: 2.x-only features stay out of reach.
  - **Start the 2.x provider.**
    - Pros: none new.
    - Cons: ships the losses 0008 lists.

### 8. Adopt-later and not-relevant calls

**Problem.** Without a record, the next review rereads the same changelogs.

**Context.** Adopt-later items go into 0007's Candidates, which is rechecked on every bump. Items that several providers now report are not listed here; they are tasks 10–15.

**Investigation.**

- **Claude** (CLI 2.1.316–2.1.319, Agent SDK 0.3.315–0.3.319):
  - Adopt later: `pending_elicitation_requests` on the initialize answer (folds into 0007's re-arm candidate); `mcp_call.check_permissions` (with MCP Apps widgets); `permissions.blockReadsExemptPaths` and `workingDirectoriesAsGiven` (with the `blockWritesOutsideWorkingDirectories` candidate); `CLAUDE_CODE_SUBAGENT_EFFORT` (since 2.1.317 a subagent on another model uses that model's saved effort, not the composer's); `deleteSession` throwing after the transcript is already gone (only the destructive DELETE route calls it).
  - Not relevant: `set_has_subscribers`; `permissions.denyInsteadOfPrompting` (removes AskUserQuestion and plan tools, as `dontAsk` does); `read_file` `lossy`; `sdk-tools.d.ts` field changes; `bridge.d.ts` security tiers; `bashEditDiffEnabled`; gateway, runner, IDE and OTel items.
  - Behaviour, no code change: `setMcpServers` keeps `.mcp.json` and local servers up until a payload names them (`verify:claude:mcp-live` passes against both CLIs); MCP tasks are on by default, so an MCP tool card may show the CLI's placeholder text until `task_notification` carries the result (needs a live look, task 9); Stop now also cancels a message sent right after a model change; PostToolUse runs on calls that finish after a steer; Read no longer returns the "unchanged" stub; fast mode is deprecated for Opus 4.8 on 2026-11-30 (the live `supportsFastMode` decides). An internal `start_folder` subtype appears in the binary; if it shows up as `system:start_folder` drift, give it an `ignored` entry in `INTERNAL_SYSTEM_SUBTYPE_DISPOSITIONS`.
- **Codex** (0.167.0):
  - Adopt later: `respect_system_proxy` (experimental, opt-in; only on a corporate-proxy report, as a provider-neutral environment setting).
  - Not relevant: audio `fileId`; `thread/guardianReview` and other experimental-only methods; new off-by-default flags (`suppress_model_change_announcements`, `interrupt_on_cancel`, `incremental_exec_tools`, `code_mode_host_output_truncation`, `apps_early_resource_discovery`); TUI and host-extension work.
  - Behaviour, no code change: withdrawn network approvals now arrive as `serverRequest/resolved`, which the router already turns into a withdrawn card; superseded assistant text is evicted from live paginated history and restored for full resume; managed `[permissions.network]` reaches `configRequirements/read` (with 0007's requirements candidate).
- **Cursor** (1.3.0, 1.3.1):
  - Adopt later: `local.hostMcpBridgeUrls` (`@internal`; exempts loopback MCP URLs from a team admin allowlist; only if a team-admin user reports Orkestrator's loopback MCP blocked).
  - Not relevant: `modelCallCompleted` (only sent when a request sets `emitModelCallUsage`, which the SDK never does); conversation `last_run` (not read by the SDK); in-executor hook mode (never enabled); billing, Slack, Canvas and team messages.
  - Still blocked: `askQuestion` (still only in `ToolName`; local runs still reject it).
- **Pi** (1.5.0):
  - Adopt later: `responseModel` from pi-messages providers into the existing `NativeAgentTurnUsage.modelId`; `ctx.ui.custom({ blocked })` when extension dialogs are routed; `PI_SELF_UPDATE_COMMAND` so `pi update` in a terminal tab defers to Orkestrator's pin (whether it can touch the managed bundle today is unverified).
  - Not relevant: TypeBox no longer re-exported (no bridge import); device-code login options (Pi login is decided out); TUI changes; faux cache-write accounting.
  - Behaviour, no code change: tool-argument validation on pi-schema; OAuth compaction summaries; `setActiveToolsByName` order; failed session-file writes roll back and throw (task 14); a resumed session runs in the working directory it recorded (Orkestrator's worktree and `/workspace` paths are stable). OAuth refresh rotation: only URL validation changed, so `NON_ROTATING_OAUTH_PROVIDERS` is still right. No new network hosts.
- **Grok** (1.0.71–1.0.77; its changelog was not readable signed out, so the bundled user guide, `--help` and binary strings were compared):
  - Adopt later: background-task status `failed` (with 0007's background-task mapping); `grok usage` plan limits (a CLI subcommand, not ACP); `PromptResponse._meta.cancelTrigger` (capture signed in first).
  - Not relevant: subagent messaging (off by default); hooks `failClosed`; permission-rule syntax; request compression; sandbox self-update; TUI and dashboard changes.
- **ACP SDK** (2.2.0–2.4.0):
  - Adopt later: unstable `session/archive` (onto the existing `actions.archive`) and `auth/status` (onto `NativeAgentAuthStatus`), generically in the ACP bridge when an agent advertises them; Grok 1.0.77 does not.
  - Not relevant: `session/set_title`, `session/status`, proxy-chain types, removed batch types, SDK-connection helpers, v2 helpers.

**Decisions.**

- **Where do adopt-later items live?**
  - **In 0007's Candidates, each with what blocks it (recommended).**
    - Pros: one backlog rechecked on every bump.
    - Cons: 0007 grows.
  - **Only here.**
    - Pros: one file per upgrade.
    - Cons: the next bump reads 0007, not this file.

### 9. Live evidence at the new pins

**Problem.** The checks ran on a Linux host without logins. Several need a signed-in run, macOS, or a container image build.

**Context.** [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md) owns cross-platform qualification. Agent-test profiles authorise host credentials, but this round made no billed turns.

**Investigation.** Run and passed at the new pins (exit status from `test:logged`):

- Claude: bridge typecheck, build, full `test:bridge` suite, `sdk-compatibility.test.ts` (including the `canUseTool` proof), `verify:claude:mcp-live` against the SDK's CLI and the managed 2.1.319, `verify:claude:plugin-mcp-live` (2 pass), `verify:claude:first-turn-live`, `verify:accounts:resend-live`.
- Codex: `verify:codex:protocol`, the protocol unit test, typecheck, bridge suite, `live-network-lock`, `live-project-trust`, `live-request-user-input`, `live-policy-amendment`, `live-resume-context`, `notification-replay`, `verify:codex:network-approval`, `verify:codex:mcp-live`, the access-only auth probe.
- Cursor: typecheck, build, `test:bridge`, an isolated import of the vendored SDK exposing the diagnostic export, `packages/cli` tests.
- Pi: typecheck, build, `test:bridge`, an isolated import of the vendored SDK, `download:pi`.
- Grok and ACP: typecheck, build, `test:bridge`, the argv checks above, `verify:grok:mcp-live`.
- All: the four artifact records per CLI verified against fresh upstream downloads; `version-drift.test.ts`; `container-state-layout.test.ts` after each re-trace.

Failed at first, and not caused by the bump: on this Linux host `live-contract.test.ts` "coordinator research MCP survives a thread-scoped Orkestrator replacement", two cases in `live-refused-calls.test.ts` and `live-coordinator-skills.test.ts`. 0.166.0 failed identically. The cause was a product bug, not the fixture: Codex's bubblewrap sandbox mounts each denied directory as a read-only tmpfs, shallowest first and after the read grants, so a coordinator's `":tmpdir" = "deny"` inside `":slash_tmp" = "deny"` (any `TMPDIR` under `/tmp`, such as Debian's `libpam-tmpdir`) failed every sandboxed call, including the AGENTS.md read at `thread/start`, and a checkout under `/tmp` could not read itself. `codexCoordinatorTmpDenials` (`bridges/codex-bridge/src/codex-config.ts`) now leaves out, on Linux only, exactly the entries Codex cannot apply; `":root" = "deny"` still hides both directories there because Linux's `:minimal` binds only system directories. The fixtures now launch Codex as the backend does and expect each platform's own errno text, and also check the refused file does not exist. All four files pass on Linux (each run three times).

Container image: `docker build … -t orkestrator-v2-upgrade-check:20261106` (a throwaway tag; never `orkestrator-v2:latest`) passed, including the Grok and Pi `sha256sum` checks and every managed CLI's build-time run, and `docker/tests/final-image-smoke.sh` passed against it. Inside it, as `node`: Claude 2.1.319, Codex 0.167.0, OpenCode 1.19.5, Pi 1.5.0, Grok 1.0.77.

Signed in, in the disposable profile `qa-1031-upgrade` (`dev:test --fixture --headless`, host credentials for every platform; stopped and reset afterwards), with the new pins:

- `idle-observation-live.spec.ts` (hidden, reconnect, background; codex=`gpt-6.1-sol`, opencode=`opencode-go/deepseek-v4.1-flash`, others default): passed, 401.7 s. Claude passed all three cases, background included (it failed this case at 1020). Codex, Cursor and OpenCode passed hidden and reconnect; their background cases were `not-exercised`, as at 1020.
- `paused-interactions-live.spec.ts` with a 1 s hold (raise, pause, rehydrate, answer, continue; not a ten-minute hold): the combined Claude, Codex and OpenCode run failed on a Codex card (flake [9897](../../tests/flaky-tests/native-agents-and-transcripts/9897-live-paused-interactions-codex-in-combined-run.md)). Re-run: Claude and OpenCode, all four cases passed (41.1 s); Codex alone, the question passed and the approval stayed incomplete after its answer; the Codex approval alone passed (43.4 s).
- `close-retention-live.spec.ts` (Cursor, OpenCode): blocked before any agent work. This host's `ufw` drops Docker traffic to the agent-tools port, so the app's "Docker containers can't reach Orkestrator" dialog covered the page and the environment click timed out. A host firewall rule, not the upgrade; rerun once the rule in that dialog is applied.
- Pi and Grok: no signed-in run. The host's Pi `auth.json` holds no login, and its Grok login has expired, so the profile could not seed either.

Not run: `scripts/qualify-opencode-seeded-data.sh` (OpenCode did not move); the macOS sandbox live test; the Linux Claude sandbox probe; the billed coordinator-skills probe; `claude-host-login-refresh.ts`; signed-in sessions for Pi and Grok (no host login) and Cursor/OpenCode close and resume (host firewall); model and effort switches, compaction and sub-agent cards on every provider; `mise run test:agent:goals`.

**Decisions.**

- **When to run them?**
  - **Before the upgrade ships in a release, in a throwaway `dev:test` profile, batched with 0031 (recommended).**
    - Pros: one signed-in session covers several providers.
    - Cons: the merge lands before the evidence.
  - **Block the merge on them.**
    - Pros: nothing unproven merges.
    - Cons: the pins drift again while a person finds time for billed runs.
- **The Linux-only Codex loopback failures?**
  - **Find the root cause before touching the tests (recommended, done).**
    - Pros: it was a product bug that stopped every coordinator thread on hosts with `TMPDIR` under `/tmp`; fixed in the bridge.
    - Cons: a small rule that depends on Codex's mount order, to be removed when Codex skips covered masks.
  - **Loosen the assertions.**
    - Pros: green on Linux at once.
    - Cons: would have hidden the product bug.

### 10. One sign-in expiry for every provider

**Problem.** A claude.ai login ends at a known date, and Cursor's credential reports one too, but Orkestrator shows neither, so a user learns their login ended only when a turn is refused.

**Context.** The shared shape already has `NativeAgentAuthStatus.account.expiresAt` (`packages/protocol/src/native-agent.ts`), and the Cursor bridge already fills it (`bridges/cursor-bridge/src/credentials.ts`). Nothing in `apps/web` reads it.

**Investigation.** Agent SDK 0.3.319 results carry `credential_expires_at`: the end of the login's refresh chain as stored at sign-in, the server's date when sent and otherwise a 30-day estimate (the real end can be up to three days earlier). `AccountInfo` has no expiry. The Claude account status comes from `normalizeClaudeAccount` (`claude-sign-in.ts`), keyed per account by `claudeAccountKey`.

**Decisions.**

- **Where does it go?**
  - **Record it from each result in the Claude bridge, merge it into `account.expiresAt` for the same account key, and add one provider-neutral "Sign-in ends <date>" line where the account label already shows (`AgentInfoButton.tsx`, `AgentSignInCard.tsx`) (recommended).**
    - Pros: one field and one line serve Claude and Cursor, and any later provider that fills the field; no `if (platform === …)` in the renderer.
    - Cons: Claude's value is an estimate, so the line must say "about"; it is a visual change and needs the screenshot cycle in AGENTS.md.
  - **A Claude-only banner.**
    - Pros: can word the estimate precisely.
    - Cons: provider-only UI, which the architecture rules forbid.

### 11. One "a person must answer this" marker for every provider

**Problem.** Claude (task 4) and Codex 0.167.0 (`humanCommand`, behind `experimentalApi` and `requiredHumanApproval`) both mark approvals that only a person may answer. Today the shared contract can express that only by leaving `ruleEligible` unset, which the card cannot explain.

**Context.** Codex rejects matching commands outright when the client does not declare `requiredHumanApproval`, so a host with a managed `prompt-user` rule gets refusals instead of prompts; how the refusal reaches the transcript is unverified.

**Investigation.** `CommandExecutionApprovalKind` and `InitializeCapabilities` in the 0.167.0 generated protocol; `approvals.ts` already treats a non-`command` kind as not rule-eligible.

**Decisions.**

- **How to model it?**
  - **An optional `humanRequired: true` on the shared interaction request, set by Claude now and by Codex when `humanCommand` is stable; the card then says "Your settings require you to answer this" and offers no "always allow" (recommended).**
    - Pros: one field, one card behaviour for every provider; `ruleEligible` stays the enforcement gate.
    - Cons: a protocol change and a visual change.
  - **Keep using `ruleEligible` alone.**
    - Pros: no change.
    - Cons: the user cannot tell why a card has no "always allow".

### 12. Provider-neutral tool safety hints on approval cards

**Problem.** Codex 0.167.0 sends an MCP tool's `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` with its approval, and the card shows none of them.

**Context.** The hints are MCP tool annotations, so every provider that proxies MCP tools can in principle report them; Claude's `canUseTool` already reports the server (`source` on the shared request, 0007 task 4).

**Investigation.** Codex sends them in the elicitation `_meta` (`tool_name`, `tool_annotations`); `interactions.ts` in the Codex bridge builds the card without reading `_meta`. Whether Claude, Pi or Cursor expose annotations at approval time is unchecked.

Claude, 2026-11-10, against the pinned CLI 2.1.319 with a loopback model and a local MCP server (no credentials): `canUseTool` carries no annotations; `mcpServerStatus()` does. The status lists the server under its configured name and each tool under its bare name (`wipe.disk tool` on `hint.srv x`), while `canUseTool` names the call `mcp__hint_srv_x__wipe_disk_tool` (every character outside `[A-Za-z0-9_-]` becomes `_`) and `mcpServer.name` is the configured name. The status keeps only hints set to `true`, under the shared keys (`readOnly`, `destructive`, `openWorld`); a `false` and `idempotentHint` are dropped. The read answers in a few milliseconds while the CLI waits on `canUseTool`.

**Decisions.**

- **Adopt?**
  - **Add an optional `toolHints` (the four booleans) to the shared request; fill it from Codex first and look for the same data in the other bridges' MCP clients; the card shows a "Destructive" or "Read-only" tag (recommended).**
    - Pros: one card treatment from MCP's own vocabulary; useful for every MCP server.
    - Cons: hints are self-declared by the server, so the card must not treat them as a guarantee or let them change eligibility.
  - **Not now.**
    - Pros: no work.
    - Cons: a destructive MCP call looks like any other.

### 13. Where a turn's cost comes from

**Problem.** Turn costs mix billed amounts and catalogue estimates, and the usage row cannot say which.

**Context.** `costUsd` on the shared usage shapes (`native-agent.ts`). Pi 1.5.0 adds `Usage.cost.totalFromProvider` (true only for OpenRouter); Claude's `costUSD` is the CLI's estimate; Grok's `costUsdTicks` is ignored until 0007 task 11 settles its unit; ACP 2.4.0 allows non-money `Cost.currency` such as `"credits"`.

**Investigation.** Pi computes turn cost as a session delta (`prompt.ts`), so a per-message flag needs per-message summing.

**Decisions.**

- **How to show it?**
  - **An optional `costSource: "provider" | "estimate"` beside `costUsd`, filled per bridge; the usage row marks estimates (recommended).**
    - Pros: one convention for every provider; honest about estimates.
    - Cons: Pi needs per-message summing; a visual change.
  - **Leave cost unlabelled.**
    - Pros: no work.
    - Cons: estimates read as bills.

### 14. A transcript notice when a provider could not save the conversation

**Problem.** Claude's `session_writes_lost` (disk full or quota) and Pi 1.5.0's failed session-file write both mean a resume may miss part of the conversation, and the user sees at most a health-panel line.

**Context.** The shared transcript notice is `{ kind: "advisory", severity: "warning" }`; Claude's arrives as the CLI exits, often after the turn.

**Investigation.** `SDKSessionWritesLostMessage.lost` includes `transcript` with `transcript_session_ids`; Pi's `session-manager.js` 1.5.0 rolls the entry back and throws. How the Pi throw surfaces mid-run is unverified.

**Decisions.**

- **Adopt?**
  - **One advisory, "This conversation could not be fully saved; resuming it may miss recent messages", raised by any bridge that learns of a lost write for the session (recommended).**
    - Pros: same wording on every provider; Claude and Pi first.
    - Cons: Claude's arrives late, so it is appended after the turn.
  - **Health panel only.**
    - Pros: done (task 2).
    - Cons: the user who resumes does not see it.

### 15. Grok session writeback

**Problem.** Grok 1.0.77 documents session writeback to code.grok.com (`features.writeback`, `GROK_STORAGE_MODE`, a hidden `--storage-mode local|writeback`), and remote settings can turn it on. If an ACP child writes back, sessions an Orkestrator user ran locally would be uploaded.

**Context.** The ACP bridge sets the child's environment in `POLICY_ENV` (`acp-provider-config.ts`).

**Investigation.** The strings are in 1.0.70 and 1.0.77; the default for an ACP child and whether remote settings change it are unverified. It needs a signed-in run.

**Decisions.**

- **What to do?**
  - **Check signed in whether an ACP child writes back; if it can, set `GROK_STORAGE_MODE=local` for bridge children and offer writeback as an explicit, provider-neutral "sync sessions to the provider's cloud" setting (recommended).**
    - Pros: nothing leaves the machine without a choice; the setting generalises (Cursor cloud agents are decided out, but the setting would name the same idea).
    - Cons: overrides a remote setting an organisation may want.
  - **Leave Grok's default.**
    - Pros: no change.
    - Cons: an unseen upload path.

## Assumptions and decisions

Recorded 2026-11-06 by the worker that did the upgrade. Each choice takes the (recommended) option unless it says otherwise.

### Task 1: latest stable everywhere but OpenCode

One commit per provider (Claude, Codex, Cursor, Pi, Grok with the ACP SDK). Each CLI's four artifact records were emitted from, and then asserted against, fresh upstream downloads; Codex's `codex-code-mode-host` companions and Pi's `bundleIntegrity` digests included. The Dockerfile's Grok and Pi `sha256` literals are the manifest's Linux digests.

### Task 2: guidance plus the CLI's detail

`withStartupFailureDetail` caps the detail at 500 characters. The existing test that expected the bare guidance now expects guidance plus detail.

### Task 3: the wrapper, not `onFailure`

Chose the wrapper because the bridge cannot yet know the CLI version before building the query, and an older CLI on PATH would fail every session.

### Task 5: Pi's table is read by the test

`models.test.ts` reads `dist/core/model-resolver.js` text for both providers' defaults; the command-preview pin test now asserts the install attempt and its warning rather than a rejected `reload()`.

### Task 9: the Linux coordinator fix is conditional and Linux-only

`codexCoordinatorTmpDenials` omits a tmp denial only where Codex's bubblewrap cannot apply it (a denial nested in another, or a read grant inside a denial); every applicable entry stays, so a future `:minimal` that bound `/tmp` would still be refused. macOS (Seatbelt) is byte-identical. Dropping both denials unconditionally on Linux was rejected because it loses that guard.

### Task 10: one line, marked when estimated

The shared account gained `expiresAtEstimated?: true`; Claude's date is always marked estimated because the SDK cannot say whether it is the server's date or its 30-day guess, and estimates get a six-day attention window instead of three. A Claude date is credited to the account of the CLI that wrote the result (read from its initialize answer), never to whatever account the bridge last read, and a numbered result with no date clears it. Codex, Pi, Grok and OpenCode report no login end (Pi and Grok's stored `expires` is an access token they refresh), so they show nothing. Settings → Claude reads the host login outside any bridge and shows no date; a backend cache per agent account would fix that and is left as a follow-up. The line is `SignInExpiry` in Agent Info and the Settings sign-in card.

### Tasks 11 and 12: enforced in every layer, worded for every source

`humanRequired` and `toolHints` are optional fields on `AgentInteractionRequest`. `ruleEligible` stays the gate, and the rule readers and the enforcer also refuse a `humanRequired` request, so a stale snapshot cannot auto-answer it. The card says "You need to answer this yourself: a saved rule can't approve it." (true for Claude's two markers and Codex's managed rule alike) and drops the session and remember options; for Codex `humanCommand` the backend also rejects a session grant and the bridge degrades one to a one-time accept. Tool hints come from Codex MCP approvals only when `_meta.codex_approval_kind` is `mcp_tool_call`, and from Pi's own MCP client's `tools/list`, captured when the call is parked. Claude's annotations exist only in the CLI's MCP status read (see task 12 below for how they are now read); Cursor has no approval callback and Grok's permission request carries no annotations. Read-only is a neutral grey tag, a contradictory server gets no tag, and hints never change eligibility.

### Task 12: Claude hints from the status read, taken when the call is parked

Recorded 2026-11-10 by the worker that did the Claude half.

- **When to read the status?**
  - **A live `mcpServerStatus()` read when an `mcp__*` call is parked, bounded at 2 s, with no hints on any failure (chosen).**
    - Pros: the same moment Pi captures its hints, so the card reflects the tools the CLI currently has; the read measured 1 to 4 ms while the CLI waits on `canUseTool`; a closed or slow CLI only costs the tag.
    - Cons: one control request per parked MCP approval, and up to 2 s added to parking one if the CLI does not answer.
  - **Cache the annotations from the MCP panel's reads.**
    - Pros: no extra request at approval time.
    - Cons: empty until someone opens the panel, and stale after a server's tools change.
- **How to match the call to a status row?**
  - **By `mcpServer.name` from `canUseTool` and the exact call name the CLI builds from the tool's bare name; any ambiguity gives no hints (chosen).**
    - Pros: never shows a lookalike server's or another tool's tag; two names the CLI writes the same way (`a.b`, `a_b`) are refused, not guessed.
    - Cons: a server whose call prefix the CLI writes differently (claude.ai connectors may, unobserved) shows no tag.
  - **Match on the call name's tool suffix alone.**
    - Pros: would also cover a differently written prefix.
    - Cons: a tool missing from a stale status could pick up the tag of another tool whose name is its suffix.

The code is `bridges/claude-bridge/src/services/claude-mcp-tool-hints.ts`, called from `turnCanUseTool`; the hints go out as the parked request's `toolHints`, which the backend already forwarded for every bridge. They are display only: `ruleEligible` is computed exactly as before. `claude-mcp-tool-hints.live.test.ts` (slow tier) runs the pinned CLI with a loopback model and fails if a CLI bump changes the names, the annotation keys or the read's timing; when `false` or `idempotent` hints start arriving, the card can use them unchanged. Because the CLI drops `false`, a server that says `readOnlyHint: true, destructiveHint: false` reaches the card as read-only, which is the same tag.

### Task 13: one rule for combining

`costSource` sits beside every `costUsd` (`native-agent-cost-source.ts`, re-exported from `native-agent.ts`, which is past 3,000 lines). A total with any estimate is an estimate; it is provider-billed only when every priced part is; anything else is absent. Claude and OpenCode are estimates (both documented as computed from tokens), Cursor's `chargedCents` and an explicit ACP USD amount are provider-billed, and a Pi turn is provider-billed only when every entry the turn added says `totalFromProvider` (counted against a persisted per-turn baseline). Codex reports no cost; `account/usage/read` with a `threadId` returns estimated and native usage and is a possible follow-up. Every cost renders through `CostAmount`: "~$0.12" with "Estimated from token counts", plain for a bill. Found, not fixed: the ACP bridge stores the cumulative session cost as each turn's cost, which would overcount once an ACP agent reports a USD amount (none does today).

### Task 14: a transcript row, not the session notice

The advisory is a `status` warning part on an assistant row with empty content, the shape every bridge already appends, so it renders the same amber line everywhere and is never read as the agent's answer. The session-level `{ kind: "advisory" }` notice was rejected because the backend passes only errors through and it shows as a toast. Claude persists `writesLostAt` in its session preferences and restores the row on reload, because the transcript cannot record its own loss. Pi wraps the session manager's `_persist` (a real-SDK test fails if a release renames it) and rethrows unchanged. Codex, Cursor and Grok report no lost conversation write.

### Task 15: local storage, no setting yet

Signed out against 1.0.77: `agent stdio` reads `GROK_STORAGE_MODE` (the `--storage-mode` flag is global and ignored there); `local` behaves exactly as unset and writes the `sessions/<cwd>/<id>/` layout `session/load` reads. `GROK_STORAGE_MODE=local` is now in the Grok child's `POLICY_ENV`, and the argv liveness checks pass with it set. A provider-neutral "sync sessions to the provider's cloud" setting was not built: no user has asked to upload, and it needs a settings surface.

## Needs verification

- Task 9's list.
- Signed in, at the new pins: that Claude results carry `credential_expires_at` and `result_index` (task 10); a Claude ask carrying `suppressAlwaysAllowRule` or `matchedAskRule` (task 11); a Codex MCP approval with `tool_annotations` (task 12, read from Codex source and its tests), and a Claude approval for a real configured MCP server showing its tag (task 12, proved on the pinned CLI with a local server and a loopback model); billed OpenRouter, Cursor and ACP USD costs (task 13); a real full disk for Claude and Pi (task 14, proved with synthetic frames and `EISDIR` from the real Pi SDK); whether Grok's remote settings can override `GROK_STORAGE_MODE=local` (task 15).
- `initialize_not_first` may only arrive when `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` is set, which the bridge never sets (unverified).
- Whether an MCP tool card under Claude 2.1.319's default-on MCP tasks shows the CLI's placeholder text.

## Related

- [1020-provider-upgrade-2026-10-30.md](1020-provider-upgrade-2026-10-30.md)
- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md) (candidates)
- [0008-opencode-v2.md](0008-opencode-v2.md)
- [0723-orkestrator-permission-rules.md](0723-orkestrator-permission-rules.md) (task 4, task 11)
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
- [upgrade-agents.md](../../development/upgrade-agents.md)
