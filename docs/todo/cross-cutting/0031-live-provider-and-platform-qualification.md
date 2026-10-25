# Live-provider and platform qualification

Checked against `main` at `2459b05c` (2026-10-15).

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
- Agent-test isolation: `checkHostTool` (`apps/backend/src/core/host-tools.ts`)
  reports only managed binaries in an agent-test profile, but spawning does
  not match it. `resolveClaudeBinary`, `resolveCodexBinary`,
  `resolveOpenCodeBinary` and `resolvePiBinary`
  (`apps/backend/src/core/commands-agent-support.ts`) fall back to the bare
  name on `PATH` in every runtime flavour. Only Cursor and Grok
  (`resolveManagedAcpBinary`) never fall back. `agent-testing.md` describes
  the fallback as intentional: it lets Claude, Codex and OpenCode run in a
  profile that provisioned nothing.

## Outstanding work

### Code

1. **Decide and align agent-test binary resolution.** Either keep the `PATH`
   fallback in agent-test profiles (and say in `agent-testing.md` that
   availability reporting and spawning differ), or refuse it for platforms the
   profile did not provision. With the second option, a launch requested
   directly through the backend could not reach a host binary that the profile
   reports as unavailable.
2. **Refresh the live OpenCode spec** (`e2e/agent-testing/opencode-live.spec.ts`)
   for the shipped fixes. Since #985 no fixed default model ships, and since
   #975 forks keep their model.
   - Make `ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL` optional; an unset model now
     resolves to a connected default. Keep it for the build-pipeline case,
     which needs a model that emits reasoning.
   - Rewrite the header comment and the `requirePinnedModel` error message,
     which still describe the old default failure.
   - Assert that the fork tab keeps the source's model and reasoning profile
     before its first prompt. The spec currently skips this on purpose.
   - Make the undo case assert that the reverted turn disappears; today it
     only checks the toast and an idle turn.
   - Update the matching paragraph in `agent-testing.md` (see "Related").
3. **A dev profile's backend reports the Electron version.** In a `dev:test`
   profile the backend starts as "Orkestrator 44.7.0": `ORKESTRATOR_VERSION`
   comes from an unpackaged Electron's `app.getVersion()`
   (`apps/backend/src/core/constants.ts:147`). The renderer is 2.21.1, so
   every event-stream reconnect raises "Reload to use the matching version"
   (`BackendVersionReminder.tsx`). The toast sits over the composer's Send
   button and intercepts browser-spec clicks; `slash-command-inactive.spec.ts`
   dismisses it with a locator handler. Pass the workspace package version in
   development, or skip the reminder for agent-test profiles.

### Qualification: checks with no other home

- **Electron terminal input resume.** Re-run `mise run test:agent:electron` for
  `e2e/agent-testing/terminal-input-resume-electron.spec.ts`. The review
  follow-up of #986 did not re-run the Electron suite. Confirm that Resume
  keeps the same PTY process id.
- **Live OpenCode spec.** One live run after the refresh above. Also check
  whether OpenCode 1.19's `session.fork` fills in `Session.model`. The fix
  falls back to the source session's model either way.
- **Runtime drift and advisories.** On two platforms, the Agent Info runtime
  section shows drift counters and an advisory notice, and both rehydrate after
  a reload.
- **Transcript part coverage.** Drive a compaction (Claude or Pi), an image
  round trip and a long-running tool. Switch tabs, let the turn finish in the
  inactive environment, then return and reload. The compaction, retry, status
  and image parts must render from the snapshot.
- **Usage panel.** On two providers, the usage panel shows turns and account
  windows and keeps them across a reload.
- **OpenCode inactive path.** Start a turn, switch environment, let it finish,
  return, reload. Record the poll count.
- **Grok tool output.** Terminal output from a Grok shell call renders inline
  and survives a reload. The upgrade runbook already covers the argv and
  handshake check for each Grok bump.

### Qualification: batching index

Platform runs, and the todo files with items for each:

| Run | Items in |
| --- | --- |
| macOS host with Docker Desktop (Apple Silicon) | [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md), [0022-container-resource-budgets-and-performance.md](../containers-and-environments/0022-container-resource-budgets-and-performance.md), [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md), [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md) |
| Real Electron window (`mise run test:agent:electron` or a manual pass) | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md) |
| Docker live suites and `mise run test:agent:docker` | [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0109-rootless-linux-runtime-gaps.md](../containers-and-environments/0109-rootless-linux-runtime-gaps.md), [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md), [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md), [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md) |
| Rootless Docker Engine, arm64 live suites, registry pulls | [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md), [0022-container-resource-budgets-and-performance.md](../containers-and-environments/0022-container-resource-budgets-and-performance.md) |
| Two machines or a remote backend | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0052-remote-client-bandwidth.md](../transcripts-and-observation/0052-remote-client-bandwidth.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md) |
| Firefox, Safari, iOS device or simulator, narrow real browser | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md), [0046-embedded-service-previews.md](../previews-and-annotations/0046-embedded-service-previews.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md) |
| Live GitHub (`gh` against a real repository) | [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md) |

Provider runs (credentials needed). Every provider also has items in [0049-native-agent-idle-observation.md](../transcripts-and-observation/0049-native-agent-idle-observation.md), [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md), [0024-coordinator-live-conformance.md](../coordinator-and-multi-review/0024-coordinator-live-conformance.md), [0044-web-annotation-qualification.md](../previews-and-annotations/0044-web-annotation-qualification.md); the table lists the rest:

| Provider | Items in |
| --- | --- |
| Claude | [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md) |
| Codex | [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md), [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md) |
| OpenCode | [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), the live spec and inactive-path checks above |
| Cursor | [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md), [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md), [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md) |
| Grok | [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0039-mcp-management.md](../mcp/0039-mcp-management.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md), [0007-provider-sdk-adoption-backlog.md](../agent-engines/0007-provider-sdk-adoption-backlog.md), the tool-output check above |
| Pi | [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md), [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md), [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md), [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md), [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md) |
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

## Open questions

- Should a provider that is qualified for a feature be re-qualified after
  every agent SDK or CLI upgrade? [`upgrade-agents.md`](../../development/upgrade-agents.md)
  has the bump runbook but no rule for this. The CLI, slash-command and MCP
  todo files each raise the same question.
- Which providers have credentials available for agent-test profiles, and who
  owns the macOS, iOS and two-machine runs?
- Should any of these runs become a scheduled CI job, such as Docker live
  suites on a Docker-capable runner or a macOS runner for Electron?

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
- Living-doc drift to fix: the OpenCode paragraph in
  [`agent-testing.md`](../../development/agent-testing.md) still says a pinned
  model is required because the shipped default fails, and links a deleted
  note. Since #985 no fixed default ships.

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
