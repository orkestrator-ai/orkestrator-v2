# Live-provider and platform qualification

Checked against `main` at `00a0cb82` (2026-10-25).

Most features ship with unit, contract and credential-free real-stack coverage
on Linux. The gate that is missing most often is the same everywhere: a run
against real providers, or on a platform the repository's CI does not have
(macOS, Docker Desktop, a real Electron window, Safari and iOS, a second
machine). This file holds what those runs share: the prerequisites, a batching
index so that one session on a platform, or with one provider's credentials,
closes items in several todo files at once, the checks that have no other home,
and the test-profile isolation gap that makes live results less trustworthy.

The owning todo file keeps the detail of what to assert and records the
evidence. This file only points at it.

## Current state

- Isolated profiles: `mise run dev:test --profile <name> --fixture`, narrowed
  with `--credential-source <name>` (repeatable), `--agent-platforms <list>`,
  `--no-agent-credentials` and `--fixture-environments local,container`. The
  procedure is in [`agent-testing.md`](../../development/agent-testing.md) and the
  per-platform credential matrix is in
  [`credentials-and-models.md`](../../development/credentials-and-models.md).
- One-shot and opt-in suites that live runs use:
  - `mise run test:agent:browser:isolated` and `mise run test:agent:design:isolated`
    (disposable profile, then stop and reset);
  - `mise run test:agent:browser` against an already running profile;
  - `mise run test:agent:docker` (only tests whose title matches `Docker fixture`);
  - `mise run test:agent:electron` (`e2e/agent-testing/playwright.electron.config.ts`);
  - `mise run test:cli:scenarios` (credential-free unless `--provider`);
  - `mise run verify:opencode:live`;
  - opt-in env gates such as `ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1`
    (`e2e/agent-testing/opencode-live.spec.ts`) and
    `ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`
    (`e2e/agent-testing/web-annotations-gateway.spec.ts`).
- CI (`.github/workflows/lint.yml`, `publish-container.yml`,
  `validate-bun-runtime.yml`) runs no live provider, no Docker live suite, no
  Electron window, and no macOS or iOS job. The only platform evidence CI adds
  is the native amd64 and arm64 final-image smoke.
- Almost all recorded evidence is from Linux amd64 with Docker Engine 29.7.2,
  taken before the SQLite storage migration (#969) and the October agent
  upgrades (#964).
- Current agent pins: Claude Agent SDK 0.3.296 / CLI 2.1.296, Codex 0.162.1,
  OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52 (ACP SDK 1.8.0), Pi 1.2.0.
- Codex sub-agent cards have a permanent credential-free spec over the real
  bridge and backend: `apps/backend/tests/codex-subagent-cards.test.ts`
  (runs in `mise run test`) and `e2e/CodexSubagentCards.spec.ts` (renderer,
  `mise run test:browser`). Both drive
  `bridges/codex-bridge/src/testing/fake-codex-subagents.mjs` through
  `apps/backend/tests/codex-subagent-stack.ts`. The live run is recorded
  under "Codex sub-agent cards evidence" below.
- Agent-test provider homes: every profile has its own `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME` and XDG directories, whether or not it authorizes the
  provider's credential source (`createBackendProcessEnvironment` in
  `apps/desktop/electron/backend-process.ts`). An authorized Codex or
  OpenCode source adds a restricted, owner-only copy of the host's
  `auth.json` with no refresh token, re-read on every start
  (`seedAgentTestProviderCredentials` in `apps/desktop/scripts/dev/profile-io.ts`);
  an authorized Claude source adds a process-scoped access token. Only Pi
  shares a host file (its `auth.json`, in place). See
  [`credentials-and-models.md`](../../development/credentials-and-models.md).

  Codex approval rules previously leaked through the shared home too. On
  2026-10-21 a profile run of
  `paused-interactions-live.spec.ts` answered a Codex command approval with
  the card's optional "Approve with command policy" choice (a harness bug,
  since fixed). Codex then wrote `prefix_rule(... decision="allow")` into the
  host's own `~/.codex/rules/default.rules`, and the next run's `touch` ran
  on the host policy without asking. The file was created by that run and
  removed afterwards. The isolated Codex home now covers `rules/` as well
  as `config.toml`.
- Agent-test isolation: availability reporting and spawning agree.
  `checkHostTool` (`apps/backend/src/core/host-tools.ts`) reports only
  managed binaries in an agent-test profile, and since 2026-10-25
  `resolveClaudeBinary`, `resolveCodexBinary`, `resolveOpenCodeBinary` and
  `resolvePiBinary` (`resolvePathFallbackAgentBinary` in
  `apps/backend/src/core/commands-agent-support.ts`) refuse the bare-name
  `PATH` fallback there too, with "`<Agent>` is not installed in this
  agent-test profile's toolchain". Other runtime flavours keep the fallback.
  Cursor and Grok (`resolveManagedAcpBinary`) never fall back anywhere.
  Covered by `apps/backend/src/core/commands-agent-support.test.ts`.
- A `dev:test` profile's backend reports the workspace package version, not
  Electron's (`desktopApplicationVersion` in
  `apps/desktop/electron/app-version.ts`, from #1265), so stream reconnects no
  longer raise the version reminder.

## Outstanding work

### Code

1. ~~**Decide and align agent-test binary resolution.**~~ Done 2026-10-25.
   An agent-test profile now refuses the `PATH` fallback for Claude, Codex,
   OpenCode and Pi, so a launch requested directly through the backend cannot
   reach a host binary the profile reports as unavailable (decision 1 below).
   Evidence: `resolvePathFallbackAgentBinary` in `commands-agent-support.ts`;
   `commands-agent-support.test.ts` covers managed-first, the fallback outside
   agent-test, the refusal (also through `resolveAgentBinary`), and that
   `checkHostTool` and spawning agree in one profile. `feature-build.ts` now
   passes the runtime flavour to its Codex naming call. The two Claude
   credential-brokering tests in `apps/backend/tests/commands-integration.test.ts`
   and the agent-test Claude probe in `host-model-catalog-refresh.test.ts`
   now provision a managed `claude`, as a real profile does. A live profile
   (`qa-0031-oc`, OpenCode only) logged `tool=claude available=false` and
   `tool=opencode available=true source=managed` and ran every OpenCode case
   below. `agent-testing.md` § "Agent toolchains in an isolated profile"
   describes the new behaviour.
2. ~~**Refresh the live OpenCode spec**~~ Done 2026-10-25
   (`e2e/agent-testing/opencode-live.spec.ts`).
   - `ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL` is optional. Unset, the native
     tab starts on the connected default and the spec reads it back
     (`composer.selectedModelId`, `provider/model` shape) and checks that the
     reply's `modelId` matches it. The build-pipeline case still needs the pin
     and is skipped without it (decision 2).
   - The header comment and the error message (`optionalPinnedModel`) no
     longer describe the old default failure.
   - The fork step asserts that the fork's composer keeps the source's model
     and reasoning id before its first prompt.
   - The undo case already asserted that the reverted reply leaves the
     projection and the screen; the live run showed the product does not do
     that yet (0175). The stale toast texts ("OpenCode session reverted",
     "OpenCode revert undone") were corrected to "Session reverted" and
     "Revert undone", and the post-fork check now matches only the visible
     reply, since the source tab stays mounted behind the fork.
   - `agent-testing.md` describes the optional pin and the new assertions.
3. ~~**A dev profile's backend reports the Electron version.**~~ Done; fixed
   on `main` by #1265 (`desktopApplicationVersion` passes the workspace
   package version when Electron is unpackaged; `apps/desktop/tests/app-version.test.ts`).
   On 2026-10-25 the locator handlers that dismissed the reminder were
   removed from `slash-command-inactive.spec.ts`, `slash-command-picker.spec.ts`,
   `mcp-apply-inactive.spec.ts` and `design-live.spec.ts`, so a regression
   shows up as a blocked click instead of being dismissed silently
   (decision 3). None of the six live OpenCode runs on profile `qa-0031-oc`
   (reconnects, reloads, environment switches) failed on the reminder.

### Qualification: checks with no other home

- ~~**Electron terminal input resume.**~~ Done 2026-10-25 on macOS 27.0
  arm64, Electron 45.0.0, Bun 1.4.2, `main` at `00a0cb82` plus this change:
  `ORKESTRATOR_AGENT_TEST_RUN_ID=qa-0031-electron-resume mise run
  test:agent:electron -- e2e/agent-testing/terminal-input-resume-electron.spec.ts`,
  exit 0, 1 passed, 0 skipped, 15.9 s, in a real Electron window. The spec
  asserts the shell's PTY process id is unchanged after the fenced write,
  after Resume and after the next write (`shellPid(1..3)`). It creates and
  removes its own temporary profile.
- ~~**Live OpenCode spec.**~~ Done 2026-10-25; evidence under "Live OpenCode
  spec evidence" below. The run found that undo leaves the reverted turn in
  the transcript, now
  [0175-opencode-undo-keeps-reverted-turn.md](../agent-engines/0175-opencode-undo-keeps-reverted-turn.md);
  the spec's full pass is that file's qualification (passed 2026-10-26 on
  OpenCode 1.19.4, pinned and unpinned; recorded in 0175). OpenCode 1.19's
  `session.fork` does **not** fill in `Session.model`: both fork sessions
  had empty `model` and `agent` columns in the profile's `opencode.db`, while
  their sources held `{"id":"gpt-5.6-luna","providerID":"opencode-go"}`. The
  fork still showed the source's model and reasoning, so the fallback (#975)
  is what carries it.
- **Runtime drift and advisories.** On two platforms, the Agent Info runtime
  section shows drift counters and an advisory notice, and both rehydrate after
  a reload. Still owed (2026-10-25): a manual pass in a `dev:test --fixture`
  profile on macOS and on Linux (for example over ssh on a Linux node, leaving
  its configuration as found), each with a provider whose bridge reports
  unrecognised events (the OpenCode run above showed "1 event this bridge did
  not recognise: server.heartbeat" in Agent Info, which is one such counter).
- **Transcript part coverage.** Drive a compaction (Claude or Pi), an image
  round trip and a long-running tool. Switch tabs, let the turn finish in the
  inactive environment, then return and reload. The compaction, retry, status
  and image parts must render from the snapshot. Still owed: a Claude or Pi
  profile (`--credential-source claude --agent-platforms claude`) and a
  manual or scripted browser pass; the OpenCode run above covers OpenCode's
  compaction part only.
- **Usage panel.** On two providers, the usage panel shows turns and account
  windows and keeps them across a reload. Still owed: one profile with two
  credential sources (for example `claude` and `codex`). The OpenCode runs
  above checked Agent Info's token usage only; their Agent Info snapshot
  showed no account windows, so they do not count as one of the two.
- ~~**OpenCode inactive path.**~~ Done 2026-10-25 (behaviour). The live
  spec's native-tab case starts a turn, switches to another environment,
  waits for the backend projection to settle with no UI mounted, returns,
  and hard-reloads; status, model and transcript were correct each time
  (five runs, below). The poll count was not recorded: neither the backend
  nor OpenCode's log counts `session.status` reads, and the "before" it was
  to be compared with (the pre-SSE code) no longer exists (decision 4).
- **Grok tool output.** Terminal output from a Grok shell call renders inline
  and survives a reload. The upgrade runbook already covers the argv and
  handshake check for each Grok bump. Still owed: a profile with
  `--credential-source grok --agent-platforms grok`, one prompt that runs a
  shell command, then a reload.

### Qualification: batching index

Platform runs, and the todo files with items for each:

| Run | Items in |
| --- | --- |
| macOS host with Docker Desktop (Apple Silicon) | [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0022-container-resource-budgets-and-performance.md](../containers-and-environments/0022-container-resource-budgets-and-performance.md), [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md), [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md) |
| Real Electron window (`mise run test:agent:electron` or a manual pass) | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md) |
| Docker live suites and `mise run test:agent:docker` | [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0109-rootless-linux-runtime-gaps.md](../containers-and-environments/0109-rootless-linux-runtime-gaps.md), [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md), [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md), [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md) |
| Rootless Docker Engine, arm64 live suites, registry pulls | [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md), [0022-container-resource-budgets-and-performance.md](../containers-and-environments/0022-container-resource-budgets-and-performance.md) |
| Two machines or a remote backend | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0052-remote-client-bandwidth.md](../transcripts-and-observation/0052-remote-client-bandwidth.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md) |
| Firefox, Safari, iOS device or simulator, narrow real browser | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0046-embedded-service-previews.md](../previews-and-annotations/0046-embedded-service-previews.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md) |
| Live GitHub (`gh` against a real repository) | [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md) |
| Stock Linux desktops with AppArmor or SELinux (Ubuntu 24.04 and 26.04, Debian, Fedora) and Docker containers | [0145-claude-linux-sandbox-apparmor-nested-userns.md](../agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md), [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md), [0190-claude-read-only-turns-without-working-sandbox.md](../agent-engines/0190-claude-read-only-turns-without-working-sandbox.md) |

Provider runs (credentials needed). Every provider also has items in [0049-native-agent-idle-observation.md](../transcripts-and-observation/0049-native-agent-idle-observation.md), [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md), [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md); the table lists the rest:

| Provider | Items in |
| --- | --- |
| Claude | [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md), [0223-provider-non-delivery-proof.md](../coordinator-and-multi-review/0223-provider-non-delivery-proof.md) |
| Codex | [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md), [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md), [0223-provider-non-delivery-proof.md](../coordinator-and-multi-review/0223-provider-non-delivery-proof.md) |
| OpenCode | [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0175-opencode-undo-keeps-reverted-turn.md](../agent-engines/0175-opencode-undo-keeps-reverted-turn.md) (the live spec's undo step) |
| Cursor | [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md), [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md), [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0223-provider-non-delivery-proof.md](../coordinator-and-multi-review/0223-provider-non-delivery-proof.md) |
| Grok | [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0007-provider-sdk-adoption-backlog.md](../agent-engines/0007-provider-sdk-adoption-backlog.md), the tool-output check above, [0223-provider-non-delivery-proof.md](../coordinator-and-multi-review/0223-provider-non-delivery-proof.md) |
| Pi | [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0223-provider-non-delivery-proof.md](../coordinator-and-multi-review/0223-provider-non-delivery-proof.md) |
| Several providers at once (mixed panels) | [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md), [0025-multi-review-panel-value.md](../coordinator-and-multi-review/0025-multi-review-panel-value.md) |

## Constraints and rationale

- Live runs are opt-in, cost tokens and can have external effects. Use only
  the seeded fixture project and synthetic prompts. Never use real prompts,
  production sessions or this repository as the fixture, and keep credentials
  out of test output.
- A skipped or timed-out run is not a pass. Record a provider without
  credentials as skipped, not as passing.
- Never claim live or Docker coverage from scripted adapters or fakes, and
  never use one platform's result for another. WebKit on Linux is not Safari
  evidence; Docker Engine on Linux is not Docker Desktop evidence.
- Record the commit, platform and versions, provider pins, exact command, exit
  status, counts, skipped cases and cleanup. Put them in the owning todo file,
  not here.
- Stop and reset every profile afterwards (`mise run dev:stop --profile <p>`,
  `mise run dev:reset --profile <p>`). Remove only resources the run created.

- Codex sub-agent cards (2026-10-17) are qualified in two layers, not
  through a fake Codex inside a `dev:test` profile. Decisions:
  1. The permanent spec drives a fake app-server through the real
     codex-bridge process, the real `HttpBridgeProvider` and the real
     `NativeAgentService` projection (`codex-subagent-stack.ts`), with the
     renderer half in the component browser suite. A `dev:test` profile has no
     seam for a fake Codex binary (the backend overwrites `CODEX_PATH` and
     Electron strips unknown env in agent-test), and putting the data path in
     `mise run test` gates every pull request in CI, which the browser and
     agent suites do not.
  2. The fake reproduces the multi-agent v2 incident shape (#602): path-only
     `spawn_agent` outputs, one spawn rejected with `collab spawn failed: agent
     thread limit reached`, child ids only in live `subAgentActivity` items, no
     `sub_agent_activity` records in the parent rollout. The live run confirmed
     codex 0.162.1 writes exactly this. A test steps it through a Unix control
     socket (`finish`), so no step waits on a clock; waits re-read the
     projection on each bridge SSE frame, under a 30 s safety deadline.
  3. "Reload" is a new backend service over the surviving bridge; "restart" is
     a new bridge, app-server and service over the same storage and Codex
     home, so identity can only come from child `session_meta` headers.
     Mutation checks: disabling `resolvePersistedChildThreadIds` fails only the
     cold assertions (three anonymous pending cards).
  4. A restart while children are still running is not covered: a dead
     app-server ends the turn, so it is a different scenario from card
     identity.

- Agent-test provider homes (2026-10-21). An authorized Codex or OpenCode
  source used to point the profile's `CODEX_HOME` and XDG directories at the
  host's, so MCP editor saves, Codex trust grants, rollouts and OpenCode
  state landed in the operator's real `~/.codex` and `~/.config/opencode`.
  Decisions:
  1. Isolate the homes and snapshot the credential, rather than make the MCP
     editor refuse host-home sources. A refusal would leave every other
     writer (trust grants, sessions, preferences, a refresh) on the host, and
     would block user-scope MCP qualification for those providers.
  2. The snapshot is taken by the `dev:test` launcher
     (`seedAgentTestProviderCredentials`), as Grok's and Cursor's already
     are, and re-read on every start. It carries no refresh token: Codex
     gets a non-empty placeholder (the Codex bridge treats a login without a
     refresh token or key as signed out) and a fresh `last_refresh`;
     OpenCode OAuth entries get an empty `refresh`. An expired access token
     is withheld with a warning. Once a copied access token lapses (about 10
     days for ChatGPT), the profile is signed out until the host's own Codex
     refreshes and the profile restarts; the host login is never spent.
  3. Codex and OpenCode remove only a snapshot an earlier start published
     (an `auth.json.orkestrator-host-snapshot` marker), so a login made
     inside a profile that does not authorize the host's survives. Grok keeps
     its unconditional removal.
  4. Claude gets the same treatment: the bridge and the host catalogue probe
     now keep the profile's own `CLAUDE_CONFIG_DIR` and authenticate with the
     brokered access token only (`applyClaudeHostCredentialEnvironment`).
     Before, they used the host's `~/.claude`, so profile sessions and
     project state were written there. The host directory is still read for
     the login and for read-only container imports. This also settles the
     old `~/.claude/.claude.json` first-run question: the profile is a first
     run by design, and the live run below authenticated without it.
  5. Host OpenCode config (`opencode.json(c)`) and Codex `config.toml` are
     not copied: they can carry MCP servers, hooks and provider settings the
     profile should not inherit. A provider defined only in host config is
     therefore not available in a profile.
  6. Pi still shares the host `auth.json` in place; that is unchanged.

### Agent-test provider home isolation evidence

Live run, 2026-10-21, macOS 27.0 arm64, this change on top of `9b3f53a2`,
Bun 1.4.2, pins as above (codex 0.162.1, opencode 1.19.0, claude 2.1.296),
bridges rebuilt first. Profile `qa-hosthome-0610`: `mise run dev:test
--profile qa-hosthome-0610 --fixture --credential-source claude
--credential-source codex --credential-source opencode --agent-platforms
claude,codex,opencode`.

- Seeding: the profile's `agent-credentials/codex/auth.json` and
  `agent-credentials/xdg-data/opencode/auth.json` were written `0600` with
  their markers. The Codex copy held the host's access token, a placeholder
  refresh token (checked by comparison, never printed) and no other secret;
  the OpenCode copy held its two API-key entries. The backend process had
  `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and all three XDG variables
  inside the profile.
- `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS=codex,opencode,claude
  ORKESTRATOR_AGENT_TEST_MCP_SCOPES=backend-user,project
  ORKESTRATOR_AGENT_TEST_MCP_MODELS=opencode=opencode-go/deepseek-v4.1-flash,codex=gpt-6.1-sol
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts
  e2e/agent-testing/mcp-apply-live.spec.ts`: exit 1, 2 passed, 1 failed,
  21.6 min.
  - Codex passed (10.9 min), user and project scope, neither skipped. The
    user-scope source was the profile's own `agent-credentials/codex/config.toml`,
    which also received the project trust grant; the host `config.toml` did not.
  - Claude passed (7.0 min), user and project scope, signed in through the
    brokered token with the profile's own `CLAUDE_CONFIG_DIR`; its two
    session directories are in the profile's `claude/projects`.
  - OpenCode failed (3.7 min): add, edit and remove applied from the
    profile's own `xdg-config/opencode/opencode.jsonc` and both tabs reached
    the edited server, but after each rename the model called the new name
    when asked for the old one, and on the first add it sent a different
    nonce. The rerun alone (run id `qa-hosthome-0610-oc2`, 3.6 min) failed
    the same two rename probes only. This is model behaviour, not apply or
    isolation; see the follow-up in [0039-mcp-management.md](../mcp/0039-mcp-management.md).
- Host after the run: `~/.codex/auth.json`, `~/.local/share/opencode/auth.json`,
  `~/.config/opencode/opencode.jsonc` and `~/.grok/auth.json` had the same
  SHA-256 and mtime as before the profile started; no host `config.toml`,
  `opencode.jsonc` or `~/.claude.json` entry names the profile or a probe
  server; no host Codex rollout, Claude project directory or OpenCode file
  names the profile. The host's Codex refresh token was not spent.
- Cleanup: `dev:stop` and `dev:reset` on the profile. Nothing was removed
  from the host.
- Left on the host by earlier profiles (not touched; the operator may remove
  them): 30 `[projects."…/orkestrator-v2-dev/profiles/<id>/…"]` trust entries
  in `~/.codex/config.toml`, 388 rollouts under `~/.codex/sessions` that
  name a dev profile path, and 206 `~/.claude/projects` directories for dev
  profile worktrees. All hold synthetic fixture content only.

### Codex sub-agent cards evidence

Live run, 2026-10-17, macOS 27.0 arm64, commit `31d0fb06`, managed codex
0.162.1, Bun 1.4.2, profile `qa-codex-subagents-d415` (`mise run dev:test
--fixture --credential-source codex --agent-platforms codex`), Codex thread
limit set to 2 in profile settings, model `gpt-6.1-sol` (low). One synthetic
prompt asked for three sub-agents (`alpha_check`, `beta_check`,
`gamma_check`) that each run one `echo`.

- Running: two cards (`Gibbs (alpha_check)`, `Kant (beta_check)`), "2 active".
- `gamma_check` rejected at the configured limit: one Failed card, "Agent could
  not start: agent limit reached.", never counted as active.
- Finished while the environment was inactive (two backend polls): three
  cards, two Finished, one Failed; no spinner, no duplicate.
- Fresh page load: the same three cards and ids; the nested transcript opens
  (`Exec echo alpha_check`, success, `done`).
- After `dev:stop` and `dev:test` on the same profile (new app-server process):
  the same three cards, ids, statuses and nested transcript.
- Model: the profile's saved Codex default
  (`agentSettings.platforms.codex.model`) was `gpt-5.4`, which this ChatGPT
  account's live catalogue no longer lists. The composer showed GPT-6.1-Sol,
  yet the first four attempts (composer, and `ensure_native_agent_session` /
  `dispatch_native_agent_prompt` with `model: "gpt-6.1-sol"`) all ran
  `gpt-5.4` per the rollout's `turn_context` and failed with 400 "The
  'gpt-5.4' model is not supported when using Codex with a ChatGPT account".
  Setting the saved default to `gpt-6.1-sol` let the run proceed. Fixed on
  `fix/codex-stored-model-mismatch`; see "Constraints and rationale" in
  [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md).
- Cleanup: `dev:stop` and `dev:reset` on the profile. The profile's Codex home
  is the host `~/.codex`, so the run's six rollouts under
  `~/.codex/sessions/2026/10/17/` (synthetic prompts only) were left in place.

### Live OpenCode spec evidence

Live runs, 2026-10-25, macOS 27.0 arm64, `main` at `00a0cb82` plus this
change, Bun 1.4.2, managed OpenCode 1.19.0 from the profile's own
toolchain. Profile `qa-0031-oc`: `mise run dev:test --profile qa-0031-oc
--fixture --credential-source opencode --agent-platforms opencode`. The
host's OpenCode login has the `opencode` and `opencode-go` providers. Each
run: `ORKESTRATOR_AGENT_TEST_PROFILE=qa-0031-oc
ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1 [ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL=…]
ORKESTRATOR_AGENT_TEST_RUN_ID=<run> mise run test:agent:browser --
e2e/agent-testing/opencode-live.spec.ts`.

| Run | Pin | Result |
| --- | --- | --- |
| `qa-0031-oc-unpinned` | none | exit 1, 1 failed, 1 skipped (build case, no pin), 89 s. Native case resolved `opencode-go/gpt-5.6-luna`, passed the inactive turn, reload and Agent Info usage; failed waiting for the stale "OpenCode session reverted" toast. |
| `qa-0031-oc-unpinned2` | none | exit 1, 1 failed, 1 skipped, 50 s. Toast text fixed; failed at "Undo must remove the latest reply": the projection kept the reverted reply (0175). |
| `qa-0031-oc-unpinned-noundo` | none | exit 1, 1 failed, 1 skipped. Diagnostic run with the two undo-hides assertions removed in an uncommitted copy: redo, compact and the fork model/reasoning assertion passed; the post-fork text check matched the hidden source tab. Fixed with a visible-only match. |
| `qa-0031-oc-unpinned-noundo2` | none | exit 0, 1 passed, 1 skipped, 36.7 s. Same uncommitted copy as above, with the visible-only fix: every other native-tab step passed, including fork model and reasoning and the post-fork reload. |
| `qa-0031-oc-pinned-build` | `opencode-go/deepseek-v4.1-flash` | exit 0, 1 passed (build case only, `--grep "build pipeline"`), 19.2 s: no raw envelopes, thinking and timed tool rows before and after reload. |
| `qa-0031-oc-final` | `opencode-go/deepseek-v4.1-flash` | exit 1, 1 failed, 1 passed, 82 s. The committed spec: build case passed; native case failed only at the undo-hides assertion (0175). |

- Undo: OpenCode's `session.revert` applied (the session row's `revert.messageID`
  was the second user message), but the projection still listed the reverted
  reply 30 s later. Tracked in 0175, fixed there 2026-10-26; the spec's
  undo step then passed.
- No Share dialog was opened in any run.
- Host after the runs: `~/.local/share/opencode/auth.json` kept its
  2026-10-19 mtime; the profile used its own snapshot and its own
  `opencode.db`.
- Cleanup: every case deleted its environments and pipeline;
  `mise run dev:stop --profile qa-0031-oc` and
  `mise run dev:reset --profile qa-0031-oc` afterwards.

## Assumptions and decisions

Recorded 2026-10-25 while working this file.

1. **Agent-test binary resolution: refuse the `PATH` fallback.** Options:
   (a) keep the fallback in agent-test profiles and document that
   availability reporting and spawning differ; (b) refuse it for any
   platform the profile did not provision. Chose (b). Why: an agent-test
   profile exists to test the pinned toolchain in isolation, and since every
   profile provisions all platforms by default, the fallback only ever
   mattered for a platform the profile deliberately left out, which
   `checkHostTool` already reports as unavailable. Pros: no launch path can
   reach a host binary of another version, which would make live evidence
   untrustworthy; one rule for reporting and spawning; a clear error naming
   `--agent-platforms`. Cons: a backend-level launch (bridge start, model
   catalogue probe, extension discovery, Codex environment naming) of a
   platform the profile left out now fails instead of quietly using the
   host's install; tests that faked an agent-test profile without a managed
   binary had to provision one. Not covered: a terminal tab is the user's
   shell, so a command typed there still resolves through the shell's
   `PATH` (managed directories first); that is not a backend launch.
2. **OpenCode build-pipeline case without a pin: skip, not fail.** Options:
   fail the run when the pin is missing, use the connected default, or skip
   the case. Chose skip with a reason. Why: the case asserts thinking rows,
   and the connected default need not reason, so running it unpinned tests
   the model rather than the product. Pros: the native case can be qualified
   with no model knowledge; the skip is reported as a skip, never a pass.
   Cons: an operator who forgets the pin gets a skipped case and must notice
   it.
3. **Remove the version-reminder locator handlers.** Options: keep them as
   harmless guards, or remove them. Chose removal. Why: the cause is fixed
   (#1265), and a handler that silently dismisses the reminder would hide a
   regression of that fix. Pros: a regression fails visibly. Cons: a
   legitimately mixed-version live run (none of these four specs is one)
   would now need its own handling.
4. **OpenCode inactive path without a poll count.** Options: add an
   OpenCode request counter to measure polls, or close the item on the
   behaviour alone. Chose the latter. Why: the count was meant as a
   before/after comparison for the SSE adoption, whose "before" code no
   longer exists, and the backend has no counter to read; a single number
   with no baseline would not show anything. Pros: no new instrumentation
   in a hot path for a one-off number. Cons: the polling cost of an
   inactive OpenCode session is still unmeasured; if it matters, add a
   counter under a new todo.
5. **Live OpenCode spec item closed with a failing case.** The item asked for
   one live run after the refresh. The run happened and found a product gap,
   which has its own file (0175) with its own qualification, so the gap is
   tracked there rather than holding this item open.

## Open questions

- Should a provider that is qualified for a feature be re-qualified after
  every agent SDK or CLI upgrade? [`upgrade-agents.md`](../../development/upgrade-agents.md)
  has the bump runbook but no rule for this. The CLI, slash-command and MCP
  todo files each raise the same question. Recommendation (2026-10-25): no
  blanket re-run; on a bump, re-run only the opt-in live specs for the bumped
  engine (for OpenCode, `opencode-live.spec.ts`), and re-qualify a feature
  only when the bump's changelog touches its surface. Left open because it
  changes the upgrade runbook's cost, which is the maintainer's call.
- Which providers have credentials available for agent-test profiles, and who
  owns the macOS, iOS and two-machine runs? Known 2026-10-25: the primary
  macOS host has OpenCode (`opencode`, `opencode-go`) and ran this file's
  OpenCode and Electron checks; earlier runs show Claude and Codex there too.
- Should any of these runs become a scheduled CI job, such as Docker live
  suites on a Docker-capable runner or a macOS runner for Electron?
  Recommendation: the credential-free Electron suite first
  (`terminal-input-resume-electron.spec.ts` took 16 s here), since it needs
  no secrets; live provider suites stay manual because they spend tokens.

## Needs verification

- A Codex multi-agent v2 turn renders as one assistant row live but two rows
  after a cold reload. Live spawns arrive only as `subAgentActivity` items, so
  nothing in the live row is a tool call to open the next row on, while the
  rollout's `spawn_agent` calls do split it (`history/rollout.ts`). The cards
  are the same either way; only their row and the final message's row differ
  (`apps/backend/tests/codex-subagent-cards.test.ts` scenario). Check against a
  recorded 0.162.1 stream whether live `wait_agent` or collab items should
  open the next row, and either align the live boundary or record why the two
  differ.

  The credential-free stack spec now asserts both layouts explicitly: one
  live row with the introduction, four cards and final answer; two cold rows
  with the introduction and four cards in the first, final answer in the
  second. It also checks that reopening only the backend preserves the live
  row. This guards the current boundary behavior; aligning the layouts still
  needs the recorded-stream evidence above.

## Related

- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md) for CI gates and
  slow or flaky suites.
- [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md) for
  old-client and old-bridge runs.
- [0175-opencode-undo-keeps-reverted-turn.md](../agent-engines/0175-opencode-undo-keeps-reverted-turn.md)
  for the undo gap the live OpenCode run found.
- The OpenCode paragraph in [`agent-testing.md`](../../development/agent-testing.md)
  was brought up to date on 2026-10-25 (optional pin, new assertions).

## Replaces

- `docs/2026-10-14/03-startup-claude-login-dialog.md` (left-open items: `PATH`
  fallback in agent-test, the `~/.claude` config-dir default)
- `docs/2026-10-14/04-opencode-fork-loses-model.md` (live check)
- `docs/2026-10-14/07-cleanup-follow-ups.md` (live OpenCode spec run)
- `docs/2026-10-14/terminal-input-recovery-plan.md` (Electron re-run)
- `docs/plans/codex-duplicate-agent-cards.md` (isolated browser workflow)
- `docs/plans/sdk-coverage/02-typed-engine-boundaries-and-drift.md`,
  `03-transcript-part-coverage.md`, `11-usage-cost-and-limits.md`,
  `13-opencode-v1-streaming-and-cleanup.md` and
  `14-acp-bridge-generalization.md` (their remaining browser QA)
