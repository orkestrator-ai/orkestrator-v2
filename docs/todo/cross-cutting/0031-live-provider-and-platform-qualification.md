# Live-provider and platform qualification

Checked against `main` at `00a0cb82` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Runtime drift and advisories on two platforms**: Agent Info's drift counters and advisory notice render and rehydrate after a reload, on macOS and on Linux. Status: open.
2. **Transcript part coverage**: compaction, image round trip and a long-running tool on Claude or Pi, finished while inactive, then return and reload. Status: open (OpenCode's compaction part only is covered).
3. **Usage panel on two providers**: turns and account windows survive a reload, for two credential sources in one profile. Status: open.
4. **Grok tool output**: a Grok shell call's terminal output renders inline and survives a reload. Status: open.
5. **Codex live and cold row layout**: a multi-agent v2 turn is one assistant row live but two after a cold reload; align or document. Status: open (needs a recorded stream; the current layouts are pinned by a credential-free test).
6. **Re-qualification rule after agent bumps**: decide whether a feature qualified on one pin must be re-run after an SDK or CLI bump. Status: open (maintainer decision).
7. **Credentials and run ownership**: record which providers have agent-test credentials and who owns the macOS, iOS and two-machine runs. Status: open.
8. **Scheduled CI for platform runs**: decide which runs become CI jobs. Status: partly done (a weekly Docker live workflow exists; Electron and macOS are not in CI).
9. **Keep "Current state" and the batching index current**: the pins and CI list are already stale. Status: open.
10. **Graph capability profiles on live providers** (graphs item 209): the tiers the graph designer and launch pickers show match what each provider does to a graph agent node, and the guards and credential withholding hold on the real stack. Status: open (needs the graph launch surface from item 214 and provider credentials).

### 1. Runtime drift and advisories on two platforms

**Problem.** The Agent Info runtime section's drift counters and advisory notice have only been seen in passing (an OpenCode `server.heartbeat` counter on macOS), not checked on two platforms with a reload.

**Context.** A manual pass in a `mise run dev:test --profile <p> --fixture` profile on macOS and on Linux, each with a provider whose bridge reports unrecognised events.

**Investigation.** The rendering is in `apps/web/src/components/layout/AgentInfoButton.panels.tsx` (summary comment at `:517`, the "1 event this bridge did not recognise" string at `:591`). Each bridge has drift tests (for example `bridges/acp-bridge/src/acp-drift.test.ts`). The 2026-10-25 OpenCode run already produced one counter on macOS, so macOS needs only the advisory notice and the reload check.

**Decisions.**

- **How to produce drift on demand?**
  - **Use OpenCode, whose `server.heartbeat` is reliably unrecognised, on both platforms (recommended).**
    - Pros: no fault injection; already observed once; one credential source.
    - Cons: an advisory notice may not appear without a real advisory; depends on OpenCode keeping that event unhandled.
  - **Inject a fake unknown event through a bridge test seam.**
    - Pros: deterministic, and could become an automated browser case.
    - Cons: a scripted adapter is not live evidence under this file's own constraints.
- **Which Linux host?**
  - **A Linux node over ssh with its own isolated profile, leaving its configuration as found (recommended).**
    - Pros: matches the file; Linux is this repository's main development platform.
    - Cons: production Orkestrator shares the host, so the profile rules in `AGENTS.md` apply in full.
  - **Only macOS, treating Linux as covered by unit tests.**
    - Pros: one run.
    - Cons: the file asks for two platforms; rendering is the same, but rehydration goes through each host's backend.

### 2. Transcript part coverage

**Problem.** Compaction, retry, status and image parts are not proved to render from the snapshot after a turn finishes in an inactive environment, on Claude or Pi.

**Context.** Replaces the remaining browser QA of `03-transcript-part-coverage.md`. Needs `--credential-source claude --agent-platforms claude` (or Pi).

**Investigation.** No live spec drives a compaction plus image round trip plus long-running tool. The inactive-path procedure is in `docs/development/agent-testing.md` and `AGENTS.md` ("Test the inactive-environment path"). Claude is now pinned at SDK 0.3.309 and CLI 2.1.309 (`bridges/claude-bridge/package.json:16`, `docker/Dockerfile:193`), newer than the 0.3.296 named in Current state.

**Decisions.**

- **Which provider?**
  - **Claude (recommended).**
    - Pros: compaction is user-triggerable with `/compact`; image input is a first-class path; the most used native provider.
    - Cons: spends Claude tokens; compaction of a small fixture conversation may be trivial.
  - **Pi.**
    - Pros: covers a newer bridge whose compaction is less exercised.
    - Cons: Pi fronts the user's own providers; the default-model fallback issue ([0062](../agent-engines/0062-pi-chatgpt-login-without-saved-default.md)) can block a fresh host.
- **Manual or scripted?**
  - **A scripted opt-in spec under `e2e/agent-testing/`, gated like `ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE` (recommended).**
    - Pros: repeatable on every Claude bump (task 6); evidence is exact.
    - Cons: more work than one manual pass; asserting a compaction part needs a stable locator.
  - **A manual browser pass.**
    - Pros: fastest to close the item.
    - Cons: not repeatable; the next bump has no check.

### 3. Usage panel on two providers

**Problem.** The usage panel (turns and account windows) has not been seen to survive a reload on any two providers.

**Context.** Needs one profile with two credential sources, for example `claude` and `codex`. OpenCode's Agent Info showed no account windows, so it does not count.

**Investigation.** The usage surfaces are `apps/web/src/components/layout/AgentInfoButton.tsx`, `AgentInfoButton.panels.tsx` and `SystemUsageIndicator.tsx`. Both providers' credential routes into a profile are documented in `docs/development/credentials-and-models.md`.

**Decisions.**

- **Which pair?**
  - **Claude and Codex (recommended).**
    - Pros: both report account windows (subscription limits); both credentials are known to exist on the primary macOS host.
    - Cons: Codex's copied ChatGPT token lapses after about ten days, so the run must follow a host Codex refresh.
  - **Claude and Cursor or Grok.**
    - Pros: widens coverage to a less-tested provider.
    - Cons: unclear whether they report account windows at all; a run that shows none does not count.

### 4. Grok tool output

**Problem.** It is unproven that terminal output from a Grok shell call renders inline and survives a reload.

**Context.** Needs `--credential-source grok --agent-platforms grok`, one prompt that runs a shell command, then a reload. The pin is now Grok 1.0.67 (`docker/Dockerfile:196`, ACP SDK 2.0.1 in `bridges/acp-bridge/package.json:14`).

**Investigation.** The ACP bridge advertises `terminal: true` (`bridges/acp-bridge/src/acp-context.ts:1142`). A tool call's terminal content is rendered from a process-local map: `terminalDisplayOutput` (`bridges/acp-bridge/src/acp-client-methods.ts:46`) is read at normalisation time (`bridges/acp-bridge/src/acp-transcript.ts:222`-`:225`), and the map entry is deleted on `releaseTerminal` (`acp-client-methods.ts:257`) and on close (`:264`). If a `tool_call_update` that names the terminal is normalised after Grok releases it, the card shows `[Terminal <id>]` instead of the output. That ordering is exactly what a live run would expose, so the run is more than a formality.

**Decisions.**

- **What counts as a pass?**
  - **Output text visible in the card live, after a browser reload, and after a bridge restart (`dev:stop` and `dev:test`) (recommended).**
    - Pros: the restart case is where the process-local map could lose output.
    - Cons: a profile restart costs a few minutes.
  - **Live and after a browser reload only, as the file says.**
    - Pros: matches the file.
    - Cons: misses the release-then-normalise race above.
- **If output is lost, where is it fixed?**
  - **Copy the output into the tool part when the terminal exits or is released, so normalisation never depends on the map (recommended).**
    - Pros: makes the transcript the source of truth, in line with `AGENTS.md` invariant 1.
    - Cons: needs a byte bound per part (invariant 11), already present as `MAX_TOOL_OUTPUT_BYTES`.
  - **Keep released terminals' output in the map for a while.**
    - Pros: small change.
    - Cons: still lost on bridge restart; another bounded cache to size.

### 5. Codex live and cold row layout

**Problem.** A Codex multi-agent v2 turn is one assistant row live but two rows after a cold reload, so a reload visibly reshapes the transcript.

**Context.** Live spawns arrive only as `subAgentActivity` items, which are not tool calls, while the rollout's `spawn_agent` calls split the row (`bridges/codex-bridge/src/history/rollout.ts:616`, `:1728`). `bridges/codex-bridge/AGENTS.md` ("One row per model response") defines the live boundary.

**Investigation.** The live boundary rules now also open a row on a new tool call after `thread/tokenUsage/updated`, but neither rule fires on the final agent message after activity-only items, so the description still holds. `apps/backend/tests/codex-subagent-cards.test.ts:161`-`:178` pins both layouts (one live row with intro, four cards and summary; two cold rows). The recorded-fixture checklist in `bridges/codex-bridge/src/testing/fixtures/README.md:65` still has "sub-agent spawn and collaboration" unticked, so no recorded stream exists to decide from. Codex is now pinned at 0.164.0 (`docker/Dockerfile:194`), not 0.162.1.

**Decisions.**

- **How to get the evidence?**
  - **Record one live sub-agent turn with `CODEX_BRIDGE_RECORD_NOTIFICATIONS` on the current pin, scrub it, and add it as the README's missing fixture (recommended).**
    - Pros: settles this item and ticks a fixture box; replayable through `replay-recording.ts` for every future bump.
    - Cons: a recording contains prompts and paths; it must go through `scripts/scrub-codex-recording.ts` and a manual diff read.
  - **Decide from the existing synthetic fake.**
    - Pros: no live run.
    - Cons: the fake was written to the incident's shape, not to 0.164.0's actual stream.
- **Which layout should win?**
  - **Split the live row when a `subAgentActivity` item follows a finished response, matching cold (recommended).** Only if the recording shows a `tokenUsage` report between them.
    - Pros: one row per model response, as invariant 14 requires; reload no longer reshapes the transcript.
    - Cons: a new boundary rule in the live accumulator, which must not await anything (invariant 9).
  - **Keep both and document why they differ.**
    - Pros: no change; cards are identical either way.
    - Cons: a reload still moves the final answer to a new row, which users can see.

### 6. Re-qualification rule after agent bumps

**Problem.** There is no rule for whether a feature qualified on one provider pin must be re-run after an SDK or CLI bump, and the CLI, slash-command and MCP files raise the same question.

**Context.** The file recommends: no blanket re-run; re-run only the bumped engine's opt-in live specs, and re-qualify a feature only when the changelog touches it. Left to the maintainer.

**Investigation.** `docs/development/upgrade-agents.md` now has one such rule already: slash commands must be re-qualified for every provider whose pin moved, before the upgrade merges (`:1607`), plus the inactive-path check (`:1602`). So the runbook has started answering this per feature rather than generally. Pins moved for every provider since this file was checked (task 9).

**Decisions.**

- **What should the runbook say?**
  - **Adopt the file's recommendation as a general rule in `upgrade-agents.md`, with slash commands kept as the one mandatory re-qualification (recommended).**
    - Pros: bounded cost per bump; consistent with the rule already there; qualified rows that name versions stay honest.
    - Cons: changelog reading is judgement; a silent behaviour change can slip through.
  - **Re-run every qualified live spec for the bumped engine.**
    - Pros: strongest guarantee.
    - Cons: token cost and time on every bump; agent bumps are frequent.
  - **No rule; per-file decisions.**
    - Pros: no runbook change.
    - Cons: the question keeps resurfacing in each file.

### 7. Credentials and run ownership

**Problem.** It is not recorded which providers have agent-test credentials or who owns the macOS, iOS and two-machine runs, so batching cannot be planned.

**Context.** Known on 2026-10-25: the primary macOS host has OpenCode (`opencode`, `opencode-go`), and earlier runs show Claude and Codex there.

**Investigation.** Agent-test profiles can take Claude, Codex, OpenCode, Cursor, Grok and Pi credentials from the host (`--credential-source`), but nothing in the repository records which host actually holds which login, or who runs each platform batch.

**Decisions.**

- **Where to record it?**
  - **A short table in this file's Current state (provider, host, credential route, last verified), updated by each run (recommended).**
    - Pros: next to the batching index that uses it; no secrets, only availability.
    - Cons: goes stale unless each run updates it.
  - **In `docs/development/credentials-and-models.md`.**
    - Pros: a living doc rather than a todo.
    - Cons: that doc describes routes, not which machine has which login; host-specific facts do not belong there.

### 8. Scheduled CI for platform runs

**Problem.** Live and platform runs are manual, so regressions on macOS, Electron and Docker show up only when someone qualifies.

**Context.** The file recommends the credential-free Electron suite first (`terminal-input-resume-electron.spec.ts` took 16 s) and keeping provider suites manual.

**Investigation.** Out of date in the file: CI is now `.github/workflows/ci.yml` (no `lint.yml`), and `container-live-qualification.yml` (added `a0cc3edd`, 2026-10-23) runs the opt-in live Docker suites against a real Linux Engine on both architectures, weekly, on demand, and on pull requests touching those suites. So "Docker live suites on a Docker-capable runner" is done for Linux Engine. No workflow runs Electron or macOS (`ci.yml` uses `ubuntu-latest` only).

**Decisions.**

- **What next for CI?**
  - **Add `mise run test:agent:electron` to a weekly and on-demand Linux workflow under `xvfb`, mirroring the container workflow's schedule (recommended).**
    - Pros: credential-free; catches Electron main, preload and IPC regressions; the container workflow is a working template.
    - Cons: Linux Electron is not macOS evidence; needs a display server in CI.
  - **A macOS runner for the Electron suite.**
    - Pros: covers the platform most users run.
    - Cons: macOS runners cost more and are slower; still no Docker Desktop.
  - **Keep everything else manual.**
    - Pros: no CI cost.
    - Cons: Electron regressions stay invisible between qualifications.

### 9. Keep "Current state" and the batching index current

**Problem.** Live-run planning reads this file first, and parts of its Current state are stale.

**Context.** The file holds the shared prerequisites, and the owning files hold the evidence.

**Investigation.** Current state lists pins Claude SDK 0.3.296 / CLI 2.1.296, Codex 0.162.1, OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52 (ACP SDK 1.8.0), Pi 1.2.0. Today they are Claude SDK 0.3.309 / CLI 2.1.309, Codex 0.164.0, OpenCode 1.19.4, Cursor SDK 1.0.40, Grok 1.0.67 (ACP SDK 2.0.1), Pi 1.4.0 (`docker/Dockerfile:193`-`:197`, the bridges' `package.json` files, `apps/backend/package.json:23`). The CI paragraph names `lint.yml`, which no longer exists, and omits `ci.yml` and `container-live-qualification.yml`.

**Decisions.**

- **How to keep the pins from going stale again?**
  - **Replace the pin list with a pointer to `docker/Dockerfile` and the bridge manifests, and record pins only in each run's evidence (recommended).**
    - Pros: nothing to keep in step; evidence still names the versions it proved.
    - Cons: a reader cannot see all pins at a glance here.
  - **Update the list now and on every bump.**
    - Pros: one place to look.
    - Cons: it went stale within two days; bumps are frequent.

### 10. Graph capability profiles on live providers

**Problem.** Graph agent nodes show an enforcement tier per provider (`graphAgentNodeEnforcement`, the same matrix as the coordinator's qualification), the launch pickers filter on it, and post-hoc guards back it up (graphs item 209). Only fake providers have exercised this; no live run has shown that the tiers shown match what each provider does to a graph node.

**Context.** Added 2026-10-29 by graphs item 209 (`plans/graphs/209-guards-and-enforcement.md`). The credential-free coverage is `apps/backend/src/core/graph-node-agent-guards.test.ts` (a committing reviewer refused at submit and repairing, a commit found at consumption, baseline unavailable, push detection, a tier drop between launch and dispatch), `graph-agent-guards.test.ts`, the protocol's `agent-enforcement.test.ts`, and the Claude, Grok, Codex and Pi bridges' credential-withholding tests. A live run cannot start yet: there is no graph launch command or dialog until item 214, so the coordinator live suite (`apps/desktop/scripts/dev/coordinator-live.ts`) has no way to start a graph node. Once 214 lands, add a `graph-profiles` scenario there (or a sibling runner) rather than a new harness.

**What remains to run live**, per provider in `COORDINATOR_LIVE_PLATFORMS` (Claude on macOS and on Linux with and without a working bubblewrap, Codex, OpenCode, Cursor, Grok, Pi), on a disposable `dev:test --fixture` profile whose fixture project has a throwaway remote:

1. A `reviewer` node (read-only turn) asked to edit a file, commit and push: the provider's tier is the one the picker showed; an `enforced` provider refuses the write itself; on any provider a change is refused at submit (`worktree_changed`) or fails the activation at consumption with `read-only` evidence; a push fails it with `remote-ref` evidence.
2. A `builder` node asked to commit (allowed) and push (refused or detected): the run branch on the remote is unchanged unless a system node pushed.
3. `gh auth status` and `git push` over HTTPS from inside the node's shell: no credential on Claude, Grok, Codex and Pi (host and container), with `GH_CONFIG_DIR` pointing at an empty directory. Codex's per-thread `shell_environment_policy` is already proven against the pinned app-server without credits (`bridges/codex-bridge/src/app-server/live-github-credential.test.ts`, 2026-10-29) and Pi's spawn hook inside a real SDK session (`bridges/pi-bridge/src/sdk-session.test.ts`); the live run confirms them under a real model. Record what OpenCode and Cursor do (they still inherit the bridge's credential; expected gap), that a Pi extension still sees it (expected gap), and, in containers, that the runtime credential file is still readable (expected gap; detected only by the remote-ref guard).
4. On Linux, break bubblewrap between launch and dispatch: the Claude picker stops offering an `enforced`-floor node, and a launched one fails before dispatch with the "below the step's floor" message.
5. A `researcher` node on Claude runs as an ordinary turn at `provider-configured` with hosted search available.

**Decisions.**

- **Where should the scenario live?**
  - **A `graph-profiles` scenario in the coordinator live suite (recommended).**
    - Pros: one runner, one profile, the same platforms and summary format; tiers come from the same matrix.
    - Cons: the suite is already long; it needs graph launch helpers.
  - **A separate graph live runner.**
    - Pros: independent of coordinator setup.
    - Cons: a second harness to keep working.

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
- **Graph capability profiles.** Graph agent nodes' tiers, guards and
  withheld GitHub credential on each live provider; see task 10 above. Still
  owed (2026-10-29): everything, once item 214's launch surface exists.
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
