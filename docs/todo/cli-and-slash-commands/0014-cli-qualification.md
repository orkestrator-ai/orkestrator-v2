# CLI qualification

Checked against `main` at `b83ae534` (2026-10-22).

Most shipped CLI behaviour has evidence at every layer: unit and contract
tests, real-backend tests, packaged scenarios on Linux (local and container),
live Claude, Codex and OpenCode runs, and a real browser. What is missing is
the live qualification run for Pi, Cursor and Grok (the scenario can now
drive them; see Qualification item 1), the macOS packaging and profile
checks, and other-provider browser cards. The credential-free, container and
live Claude, Codex and OpenCode matrices were re-run at `a5d338c1` on macOS
with Docker Desktop and passed (see "Evidence log"). Until Pi, Cursor and
Grok are qualified, scripts on those providers cannot use `run wait` as a
success signal.

## Current state

- `PROVIDER_COMPLETION` in `apps/backend/src/core/public-api/providers.ts`
  marks Claude, Codex and OpenCode `qualified` and Pi, Cursor and Grok
  `unqualified`, so runs on the last three end `unknown` or `unsupported`.
  `public-cli.md` "Request-specific completion" holds the provider matrix.
- The scenario harness (`packages/cli/scenarios/harness.ts`) starts each
  scenario's backend through the packaged launcher (`serve --runtime-flavor
  agent-test`). `packages/cli/scripts/run-scenarios.ts` accepts `--scenario`,
  `--provider`, `--environment-type`, `--docker-image`, `--keep-on-failure`
  and `--list`. There is no option to target an already running profile.
- `packages/cli/scripts/build.ts` bundles only `claude-bridge` and
  `codex-bridge`; OpenCode runs its own server. The published package is
  unchanged. For a live Pi, Cursor or Grok run the harness gives the scenario
  backend its own resource root (`prepareProviderRuntime` in
  `packages/cli/scenarios/provider-runtime.ts`): the packaged Claude and
  Codex bridges plus the provider's bridge as this worktree built it
  (`bridges/<bridge>/dist` and `package.json`, the desktop layout). It also
  enables the provider in the fresh data directory (`agent-platforms.json`)
  and, for Grok, installs the pinned binary with `orkestrator toolchain
  install --tool grok` (Grok never falls back to `PATH`). The CLI, backend
  and Claude/Codex bridges under test stay the packaged ones.
- Scenarios in `packages/cli/scenarios/cases.ts`: `read-only`,
  `local-lifecycle`, `retry-and-retention`, `setup-failure`, `client-exit`,
  `exec`, `wrong-profile` (credential-free) and `live-session` (opt-in).
  `setup-failure` and `client-exit` are local only, so the container matrix
  has five cases.
- `wrong-profile` covers only a missing explicit profile. The foreign-owner
  Docker decoy exists only as a fixture in
  `e2e/agent-testing/browser-gateway.spec.ts`.
- `e2e/agent-testing/cli-ui.spec.ts` checks CLI-made changes in an open and a
  reloaded renderer. Its live question test is gated on
  `ORKESTRATOR_AGENT_TEST_LIVE_CLI=1` and a Claude profile.
- Recorded runs: Linux on 2026-09-26 and macOS with Docker Desktop on
  2026-10-18, the second after SQLite storage (#969), native-agent provider and
  transcript unification (#970, #971), the Claude bridge `sendPrompt` split
  (#984) and agent SDK upgrades (#935, #964). See "Evidence log".
- Every isolated scenario backend runs with disposable provider homes
  (`isolateProviderHomes` in `packages/cli/scenarios/provider-homes.ts`). Before
  2026-10-18 the harness inherited the operator's `HOME` and provider
  variables, so live runs wrote sessions into the host's `~/.claude`,
  `~/.codex` and OpenCode directories. Since 2026-10-22 it also points
  `PI_CODING_AGENT_DIR` and `GROK_HOME` into the disposable home on every
  run, and stages credentials for a live Pi, Cursor or Grok run: Pi's
  `api_key` entries only (OAuth entries are dropped; a file with none is
  refused), the host's `CURSOR_API_KEY`, and `XAI_API_KEY` or Grok's
  `auth.json` through `restrictGrokAuthSnapshot` (refresh token blanked,
  expired logins refused). Pi and Grok runs also set
  `ORKESTRATOR_AGENT_TEST_HOST_HOME` to the disposable home so container
  input staging reads the staged files, not the host's (not yet exercised by
  a container run). `CURSOR_API_KEY`,
  `XAI_API_KEY` and the `GROK_AUTH_*` overrides are cleared for every other
  run.
- Each isolated backend also starts with a decoy parent agent tool connection
  (`INHERITED_AGENT_TOOL_ENV`). The startup regression checks both the login
  shell and a catalogue probe cannot see it. The backend drops any inherited `ORKESTRATOR_AGENT_MCP_URL`
  and `ORKESTRATOR_AGENT_MCP_TOKEN` at startup
  (`dropInheritedAgentToolConnection`, `apps/backend/src/main.ts`).

## Outstanding work

### Code

1. **Done (2026-10-22): make Pi, Cursor and Grok runnable in
   `live-session`.** Scenario-only bridge overlay, platform enablement,
   pinned Grok binary and credential staging, as described in "Current
   state". Covered by `packages/cli/tests/scenario-provider-homes.test.ts`;
   a credential-free packaged run reached each bridge (see "Evidence log").
   Flipping `PROVIDER_COMPLETION` and the `public-cli.md` matrix waits on
   Qualification item 1.
2. **Record the resolved model per live run.** The run manifest holds IDs,
   stages and exit codes only. An unpinned OpenCode run therefore leaves no
   record of the model it used (2026-10-18), so the evidence log cannot pin
   it. Add the session's resolved provider model to the manifest entry for
   `session start`.
3. **Done (2026-10-22): settle a provably unstarted local exec.** A local
   controller that exits before claiming `state.json` can settle `failed`
   (`exec-failed`, evidence `none`, "worker never started"). A timeout or
   Docker client failure cannot prove controller exit. Those unconfirmed
   launches remain pending even when status finds no state yet; reconciliation
   accepts a late claim and never starts a second worker. Failed status reads
   do not prove non-execution. Covered by local launcher tests, unreadable
   claims and stubbed Docker transport/timeout/missing-state/late-claim paths
   in `public-api-exec.test.ts`.
4. **Done (2026-10-22): `session start --wait` and `session prompt --wait`
   survive a slow admission.** A `transport-uncertain` submission under
   `--wait` is now looked up by its saved request key and namespace, with
   server validation of the submitted scope and canonical intent
   (`submitForWait` in `packages/cli/src/client/commands/common.ts`),
   repeating while the key is `not-found` or reads fail with
   `connection-failed`, then observed to the end in the same `--timeout`
   deadline measured before submission, with a warning naming the recovery.
   Ordinary successful admission retains the full observation duration;
   definitive lookup errors and interruption retain recovery-key details.
   Nothing is resubmitted; if the key never appears in the budget the original
   exit 4 stands. Without
   `--wait` the behaviour is unchanged. Covered by `client-waits.test.ts`.
   Not re-run live under load; flake
   [0440](../../tests/flaky-tests/backend-services-and-tooling/0440-cli-live-opencode-container-start-transport-timeout.md)
   stays open until it is. Other `--wait` mutations (`environment exec`,
   `environment start`) still exit 4 on a lost response.

### Qualification

1. **Live `live-session` for Pi, Cursor and Grok**, local and container. Each
   run needs the file assertion plus a follow-up turn. Look specifically for
   OpenCode-style false success: an idle status after a failed turn, or idle
   just after the prompt is accepted and before any answer exists. The
   scenario can now run them (Code item 1); `PROVIDER_COMPLETION` reports
   them `unsupported`, so a run is expected to end with `--wait` exiting on
   `capability-unavailable` until a provider is flipped: qualify by flipping
   the entry locally, running the scenario, and committing the flip only
   with a passing run. Check after each run that the host `~/.pi/agent`,
   `~/.grok` and Cursor state are untouched.
2. **macOS.** The credential-free matrix and the container matrix on Docker
   Desktop (including the `exec` scenario) passed on 2026-10-18. Still open:
   - Packed install: `mise run smoke:cli`.
   - The config directory `~/Library/Application Support/orkestrator-cli` and
     its permission checks.
   - `--profile` discovery against a `dev:test` profile.
3. **Browser.** Question and approval cards for a CLI-started run on providers
   other than Claude. `cli-ui.spec.ts` checks only Claude live.
4. **Foreign-owner Docker decoy through the CLI.** Add a scenario (or extend
   `wrong-profile`) where a container labelled for another profile exists, and
   assert the command neither falls back nor mutates it.
5. **Optional measurement.** Scenario start-up time, time to failure evidence,
   flake rate, cleanup failures and token cost, before claiming the CLI makes
   testing faster. It does not shorten `mise run test`.

Run prerequisites specific to the CLI scenarios (shared profile and
credential setup is in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)):

- Container runs need this worktree's own image. Build it with
  `mise run docker:build:dev` and pass the printed tag to `--docker-image`;
  `run-scenarios.ts` refuses a `:latest` tag.
- Non-Claude container runs need `--network full`, because the default
  restricted allowlist reaches only Anthropic's API. The `live-session` case
  adds it itself for non-Claude providers; any new live container scenario
  must do the same.
- Codex and OpenCode live scenarios now require API-key credentials. The
  harness refuses OAuth `auth.json` files before starting a backend: a 401 can
  trigger refresh even for a fresh login, and cleanup must never discard the
  only valid rotated refresh token. Codex accepts `CODEX_API_KEY`,
  `OPENAI_API_KEY`, or an API-key-only `auth.json` from the original `CODEX_HOME`;
  OpenCode accepts only `type: "api"` entries from the original XDG data home.
  Writable provider homes and container inputs stay disposable. Earlier
  evidence below used copied OAuth credentials; those passes remain historical
  evidence, not qualification of the new API-key-only setup. Claude resolves
  custom host config directories before isolation and stages only its access
  token. Credential-free runs clear inherited credential-source and host-home
  controls. Regression coverage includes fresh/stale OAuth refusal and host
  credential survival after scenario cleanup.
- Pi, Cursor and Grok: build the provider's bridge first (`mise run
  build:pi-bridge`, `build:cursor-bridge` or `build:acp-bridge`); the
  harness refuses an unbuilt one. Pi needs an `api_key` entry in its
  `auth.json` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); Cursor needs
  `CURSOR_API_KEY` in the environment; Grok takes `XAI_API_KEY` or a host
  login with at least a minute of validity left, and downloads its pinned
  binary into the scenario data directory on every run.
- Pin the model with `ORKESTRATOR_SCENARIO_MODEL`. Codex's default model was
  unsupported on the test account, and the disposable Codex home carries no
  `config.toml`, so the host's configured model is not inherited. The case
  validates the pinned model against a refreshed catalogue (`agent options
  --refresh`) before using it.
- The packaged `serve` has no managed toolchain, so local live runs resolve
  `claude`, `codex` and `opencode` from `PATH`. If `opencode` is not on it,
  prefix the pinned managed copy for the run (on macOS,
  `PATH="$HOME/Library/Application Support/orkestrator-v2/toolchains/bin/current:$PATH"`).
- Live runs use host credentials (`--credential-source`) and cost real tokens.

### Evidence log

Record each run with its date, commit, platform and versions, provider pins,
command, result and limitations. Run artifacts are
`output/cli-scenarios/<run>/manifest.json` (git-ignored; IDs, stages and exit
codes only).

- **2026-10-25, macOS (Darwin 27, arm64), 0017 command surface.** Branch
  `todo-0017-cli-command-surface-b2ac5c7a331e` on `ba7cc8d4`; Bun 1.4.4,
  Claude Code 2.1.304, Agent SDK 0.3.309.
  - `mise run test:cli:scenarios -- --scenario project-cascade --scenario
    project-init`: both passed locally (3.3 s, 2.3 s) after one fix to the
    scenario itself (`environment create` takes base branch and commit
    together). Container variants were not run (no worktree-owned image built).
  - `mise run test:cli:scenarios -- --scenario live-session --provider claude`:
    passed (52.7 s, local). Beyond the existing turn and follow-up it covered
    `session commands --refresh` (ready), an unknown command refused (exit 3)
    and a stale binding revision refused (exit 8) with nothing admitted, Claude's
    built-in `/context` through `session command --wait` (succeeded, 1.0 s),
    `--literal` (1.9 s), `--attach` (the agent quoted the attached file, 4.0 s),
    and `--enqueue` behind a running `sleep 20` turn (a plain prompt was refused
    busy; the queued run succeeded after the slow turn, 27.9 s). Two earlier
    attempts failed on the scenario's own choice of command: project commands
    in `.claude/commands` were not in this Claude build's session catalogue, so
    the step uses the built-in `/context`. No other provider was run.
  - Final rerun on the committed code (after the local-only start point was
    narrowed to `project init` projects and the attach step learned the
    image-only refusal): `project-cascade` 7.4 s, `project-init` 6.7 s and
    Claude `live-session` 61.8 s, all passed.
  - `cli-ui.spec.ts` on an isolated `qa-0017` profile: the new "CLI-initialized
    project and its cascade removal" test and the existing settings test passed
    (24.3 s); the profile was stopped and reset.

- **2026-10-22, macOS, review fixes.** Recovery now validates the submitted
  canonical intent and scope on the server, refuses saved intent conflicts,
  preserves definitive lookup and interruption errors, and shares an absolute
  recovery deadline without shortening ordinary successful observation. Exec
  transport failures retain uncertainty until the worker reports. Grok API
  keys cross private staging into only Grok container startup and are removed
  by credential revocation.
  - Passing: format check, lint, workspace typecheck, complete CLI package
    suite, focused public exec/session/account regressions, and the real
    Docker fixture suite (71.7 s; credential-free Codex-only profile, including
    inactive-view rebuild and rehydration). The disposable profile was stopped
    and reset. No live provider turn was run.
  - Packaged CLI scenarios: local 7/7 and container 5/5, using the worktree
    image `orkestrator-v2:dev-6b1b2e970fa3`; no cleanup errors.
  - The first complete suite failed in Pi runtime vendoring, two firewall
    fixture deadlines and a Claude plan-preference sentinel. Complete owning
    files subsequently passed unchanged (Pi 21.8 s, firewall 40.1 s, Claude
    0.2 s); recurrences are recorded in cases 0514, 0192 and 0385. The first
    Pi isolated retry failed too; only its later isolated pass established
    intermittence. All workspace packages and protocol regeneration passed
    in that initial complete run.
  - Initial Docker attempts used an incorrect profile that enabled unsigned-in
    Claude and blocked the UI, plus a logger idle allowance shorter than the
    rebuild scenario's own deadline. The passing run selected Codex without
    credentials and used a 540 s logger idle allowance for the existing 480 s
    rebuild test; no test timeout, assertion or skip changed.
  - Final complete suite: exit 1 in 651.6 s, solely on the unchanged
    `storage helper > reports unknown content and foreign markers without
    touching data` five-second timeout. The complete owning file passed alone
    (3.4 s); registered as confirmed flake
    [0672](../../tests/flaky-tests/environments-and-containers/0672-container-storage-marker-aggregate-timeout.md).
    Root/support, all bridges and protocol regeneration passed. The aggregate
    remains failed; isolated passes do not replace its result. Evidence:
    `orkestrator-test-run.TfxXYL` below the host temporary directory.
  - Standalone component/public browser, Electron and iOS suites were omitted:
    no renderer, Electron or iOS implementation changed. Docker's real-stack
    browser flows and the packaged CLI scenarios supplied the scenario checks.

- **2026-10-22, macOS.** `main` at `b83ae534` plus this branch's changes.
  macOS (Darwin 25.6.0, arm64), Bun 1.4.3. Credential-free only; no live
  provider turn was run.
  - Bridge overlay smoke (ad hoc script over `startIsolatedBackend` with
    `credentialSource` pi, cursor and grok, empty `PI_CODING_AGENT_DIR` and
    `GROK_HOME`, no `CURSOR_API_KEY` or `XAI_API_KEY`): each packaged backend
    enabled the provider, created and readied a local environment, and
    `session start --wait` failed with the provider bridge's own sign-in
    error (`pi-bridge/src/credentials.ts`, `cursor-bridge/src/credentials.ts`,
    `acp-bridge/src/acp-credentials.ts`). Grok's pinned binary installed
    through `toolchain install --tool grok`. This shows the scenario reaches
    each bridge; it is not qualification.
  - Credential-free, local (`mise run test:cli:scenarios`), host load
    average 150 to 400 from other worktrees: 5/7 pass (`read-only`,
    `local-lifecycle`, `retry-and-retention`, `exec`, `wrong-profile`).
    `setup-failure` and `client-exit` failed in `environment start`,
    `environment launch` and `run wait` stages this branch does not touch.
    Rerun alone: `client-exit` passed, `setup-failure` failed again after
    1052 s at load 400. Only `client-exit` is registered as flake
    [0671](../../tests/flaky-tests/backend-services-and-tooling/0671-cli-scenarios-environment-start-under-extreme-load.md);
    `setup-failure` remains unconfirmed and needs a quiet-host rerun.
  - Package and backend tests: `packages/cli` suite 161/161 pass;
    `public-api-exec.test.ts` 19/19 pass.
  - Not run: live Pi, Cursor and Grok (no API-key credentials in this
    environment, and live runs on the host's own logins were not
    authorized); container runs for them; flake 0440 under load.

- **2026-10-18, macOS.** `main` at `a5d338c1` plus this branch's fixes.
  macOS 27.0 (Darwin 27.0.0, arm64), Bun 1.4.3, Docker Desktop with Engine
  29.8.1, image `orkestrator-v2:dev-e15f47e54b3f` (`mise run
  docker:build:dev`). Pins: `@anthropic-ai/claude-agent-sdk` 0.3.296, Claude
  CLI 2.1.296 (image), Codex 0.162.1 (`config/codex-version.json`), OpenCode
  1.19.0 (`@opencode-ai/sdk`, image and managed binary). Load average 9 to 14
  for the first pass; the host then rebooted and the final pass ran at 12 to
  38.
  - Final pass, with every fix on this branch:
    - Credential-free, local (`mise run test:cli:scenarios`): 7/7 pass, no
      cleanup errors.
    - Credential-free, container (`--environment-type container --docker-image
      orkestrator-v2:dev-e15f47e54b3f`): 5/5 pass (`read-only`,
      `local-lifecycle`, `retry-and-retention`, `exec`, `wrong-profile`), no
      containers left.
    - Live `live-session`, local: Claude pass (31.5 s, default model), Codex
      pass (45.7 s, `ORKESTRATOR_SCENARIO_MODEL=gpt-6-sol`), OpenCode pass
      (43.7 s, default model, not recorded; see Code item 2; managed
      `opencode` prefixed on `PATH`, see the prerequisites).
    - Live `live-session`, container: Claude pass (60.0 s, restricted
      allowlist), Codex pass (80.5 s, `gpt-6-sol`, `--network full`, no
      `CODEX_HOME` opt-in), OpenCode pass alone (98.5 s, `--network full`).
      Run concurrently with the other two, OpenCode failed once with
      `transport-uncertain` (flake 0440, Code item 4). No containers left.
  - First pass, before the reboot, with only the provider-home fix: the same
    matrices all passed (credential-free 7/7 and 5/5; live local 20.6 to
    25.1 s; live container 37.4 to 70.5 s).
  - Every live run did the file assertion, a non-empty transcript and the
    follow-up turn. Host homes checked after both passes: no `ork-cli-*`
    project in `~/.claude/projects`, no Codex session naming a scenario root,
    no OpenCode session or project row for one, and the host Codex
    `last_refresh` unchanged.
  - Found and fixed during the run:
    - The harness inherited the operator's `HOME` and provider variables, so
      live runs wrote into host provider homes, and Codex in a container
      needed `CODEX_HOME` pointed at the host's own `~/.codex` (which also
      staged its `config.toml`, hooks and skills). Now `isolateProviderHomes`;
      covered by `packages/cli/tests/scenario-provider-homes.test.ts`.
    - A backend started from inside an agent session inherited that session's
      agent tool URL and token, and spread them into every bridge, exec worker
      and probe, so its agents could act as the parent tab. Now
      `dropInheritedAgentToolConnection`; the startup/login-shell/catalogue
      regression now covers this separately from exec's own environment filter.
    - After the reboot, local `exec` hung for its whole 10-minute budget: with
      no bundled Bun, `resolveBunBinary` fell back to `bun` on `PATH`, here a
      mise shim that cannot resolve from `/`, where exec control runs. It now
      falls back to the Bun running the backend; covered by
      `commands-agent-support.test.ts`. The stuck-pending receipt is Code
      item 3.
  - Not run: Pi, Cursor, Grok (bridges not packaged); `mise run smoke:cli`,
    the macOS config directory and `--profile` discovery (macOS item);
    `cli-ui.spec.ts` and other-provider cards (Browser item); Linux (the host
    is macOS; the 2026-09-26 run is the latest Linux evidence).

- **2026-09-26, Linux.** Pre-merge tree based on `a9337716`, shipped as #854.
  Bun 1.4.2, Docker 29.7.2, image `orkestrator-v2:dev-7e8f587df147`.
  - Credential-free, local: 7/7 pass, no cleanup errors.
  - Credential-free, container: 5/5 pass, no containers left.
  - Live Claude, Codex and OpenCode, local and container: pass. Codex used a
    pinned model; non-Claude container runs used `--network full`; Codex in a
    container used `CODEX_HOME`.
  - `mise run test:agent:browser:isolated`: 7 passed, 5 skipped (Docker and
    live gated). Live `cli-ui.spec.ts` question test with Claude: pass.
  - Full suite, `mise run check` and `mise run smoke:cli`: pass.
  - Found and fixed during the run: OpenCode reported success for a failed or
    not yet answered turn (now `turnTerminalError`, reading
    `readOpenCodeTurnTerminalError` in `opencode-turn-outcome.ts`); `run wait`
    exited 6 for up to ten seconds after a question was answered.
  - Not run: Pi, Cursor, Grok (bridges not packaged); macOS; Docker Desktop.
  - Durations: live local runs 31 to 45 s; live container runs 35 to 90 s
    (Claude under the restricted allowlist took 90 s). The per-run artifact
    table was dropped with the plan; artifacts were git-ignored. Which test
    proves each scenario class is in
    [`cli-testing.md`](../../development/cli-testing.md#coverage-by-layer).

## Constraints and rationale

- Live runs are opt-in. Do not claim live or Docker coverage from scripted
  adapters, or UI rehydration from API polling.
- A provider is `qualified` only after a live, bounded turn through the
  packaged CLI, real backend and real bridge, settled on request-scoped
  evidence and checked by a file assertion. Generic unit tests do not count.
- If a provider's mapping fails, withdraw that provider alone to
  `unqualified`. Its run evidence stays readable.
- Model wording is never the assertion.

## Open questions

- Bundle more bridges into the package, or qualify against dev profiles?
  Decided 2026-10-22: neither, for qualification. The harness overlays the
  worktree-built bridge on the packaged resources for that run only
  (`provider-runtime.ts`). Still open: whether the published package should
  ship the Pi, ACP and Cursor bridges at all. Without them a standalone
  `orkestrator serve` cannot run those providers in local environments
  (Pi's vendored SDK is about 174 MB, Cursor's about 45 MB).
- Should qualified providers be re-run after every agent SDK or binary
  upgrade? [`upgrade-agents.md`](../../development/upgrade-agents.md) has no such
  step, and
  [`upgrade-agents.md` → Other dependencies](../../development/upgrade-agents.md#other-dependencies)
  lists `test:cli:scenarios` only for bundled native dependencies. The shared
  question is in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Related

- [0017-cli-command-surface.md](0017-cli-command-surface.md): each new capability adds a
  scenario and, where the UI rehydrates, a `cli-ui.spec.ts` check.
- [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
  for Docker Desktop runs batched with other container work.
- [`public-cli.md`](../../architecture/public-cli.md#targeted-scenarios),
  [`cli-testing.md`](../../development/cli-testing.md),
  [`testing-guide.md`](../../development/testing-guide.md#cli-scenarios),
  [`agent-testing.md`](../../development/agent-testing.md).

## Replaces

- `docs/improvements/cli-commands/plan/00-cli-commands-index.md` (the
  outstanding line: Pi, Cursor and Grok live, macOS)
- `docs/improvements/cli-commands/plan/07-environment-lifecycle.md` (the
  foreign-owner Docker decoy gap; the rest is done)
- `docs/improvements/cli-commands/plan/10-run-completion-and-waiting.md`
  (unqualified providers)
- `docs/improvements/cli-commands/plan/15-packaging-documentation-and-rollout.md`
  (macOS packaging and Docker Desktop)
- `docs/improvements/cli-commands/plan/14-targeted-testing-and-qualification.md`
  (coverage-by-layer table moved to `cli-testing.md`; other-provider question
  cards, the Docker decoy and measurement are items 3, 4 and 6 above; the
  per-run evidence table was summarised into "Evidence log")
