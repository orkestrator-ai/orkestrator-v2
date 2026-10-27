# CLI qualification

Checked against `main` at `00a0cb82` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

Code items 1 to 4 and qualification items 2 to 4 are done and on `main`
(`c23f6be9` #1274, with the harness toolchain install from `a51045a4` #1287).
The open work is the live run for three providers, two measurements or
re-runs, one CLI gap the file mentions in passing, and two open questions.

### Tasks

1. **Live `live-session` for Pi, Cursor and Grok, and the completion flip** (qualification item 1). Status: blocked (on API-key credentials; Cursor is unblockable on this Linux host, see below).
2. **Re-run the slow-admission `--wait` recovery under load** (code item 4, flake 0440). Status: open.
3. **Lost-response recovery for `environment exec --wait` and `environment start --wait`**: they still exit 4 on a lost response. Status: open (noted in code item 4, never filed).
4. **Token cost of a live run** (qualification item 5). Status: open (optional measurement).
5. **Fresh Linux evidence**: the latest Linux CLI run is 2026-09-26. Status: open.
6. **Ship the Pi, ACP and Cursor bridges in the published package?** (open question 1). Status: open.
7. **Re-run qualified providers after an agent upgrade?** (open question 2, shared with 0031). Status: open (maintainer's call).

### 1. Live `live-session` for Pi, Cursor and Grok, and the completion flip

**Problem.** `PROVIDER_COMPLETION` marks Pi, Cursor and Grok `unqualified` (`apps/backend/src/core/public-api/providers.ts:46-57`), so `run wait` on those providers cannot report completion and scripts cannot use it as a success signal.

**Context.** The scenario can drive all three since code item 1. The procedure is written in the item: flip the entry locally, run local and container, commit the flip only with a passing run, and check the host `~/.pi/agent`, `~/.grok` and Cursor state are untouched. Container input staging through `ORKESTRATOR_AGENT_TEST_HOST_HOME` has never been exercised by a container run.

**Investigation.** Still accurate on `main`. Since 0166 the harness installs each provider's pinned binary (`packages/cli/scenarios/harness.ts:147-168`; Grok pin `1.0.67` in `packages/toolchain/src/manifest.ts:9`, the version 0016's picker run used without the older "Invalid params" failure). Credential presence on this Linux host, checked 2026-10-27 without reading values: `CURSOR_API_KEY` and `XAI_API_KEY` are unset in the shell, but the Orkestrator config holds a saved Cursor API key; `~/.pi/agent/auth.json` has only an OAuth entry (`openai-codex`), which the harness refuses; there is no Grok login. So Cursor could run here if that key is exported for the scenario only; Pi and Grok remain blocked. The scenario's selected-command step is Claude-only (`packages/cli/scenarios/cases.ts:1089`); the other new steps (refusals, `--literal`, `--attach`, `--enqueue`) run on every provider, so these runs also close 0017's per-provider gap.

**Decisions.**

- **Run Cursor now, ahead of Pi and Grok?**
  - **Yes: export the saved Cursor key into the scenario process only, run local and container, and flip Cursor alone if both pass (recommended).**
    - Pros: one of three providers qualifies without waiting; the item already allows per-provider flips.
    - Cons: needs the user's go-ahead to use that key for CLI scenarios (it was approved for `dev:test` profiles); costs live tokens.
  - **Wait until all three have credentials and run them together.**
    - Pros: one batch, one evidence entry.
    - Cons: Cursor stays unqualified for no technical reason.
- **What counts as a pass for the flip?**
  - **Local and container both pass every `live-session` stage, with no OpenCode-style false idle in the manifest and host provider state untouched (recommended).**
    - Pros: matches the qualification rule in "Constraints and rationale"; container proves the staging path never exercised before.
    - Cons: the container run needs a dev image (`mise run docker:build:dev`) and `--network full`.
  - **Local only, container as a follow-up.**
    - Pros: faster first flip.
    - Cons: `qualified` is provider-wide, so a container-only failure would ship as qualified.
- **How to unblock Pi?**
  - **Add a Pi `api_key` entry for a provider the user has a key for (recommended).**
    - Pros: fits the harness's existing API-key-only rule.
    - Cons: needs a paid API key for some Pi-fronted provider.
  - **Let the harness share the OAuth login by path (`PI_BRIDGE_AUTH_FILE`), as 0015 did for its probes.**
    - Pros: uses the login the host already has.
    - Cons: a refresh during the run rotates the host's token; the harness refuses OAuth for exactly that reason (cleanup must never discard the only valid refresh token).

### 2. Re-run the slow-admission `--wait` recovery under load

**Problem.** `submitForWait` (`packages/cli/src/client/commands/common.ts:101`) recovers a `transport-uncertain` admission by request key, but it has never been exercised live under the load that produced flake 0440.

**Context.** Flake 0440 (`docs/tests/flaky-tests/backend-services-and-tooling/0000-index.md:57`) stays open until this re-run.

**Investigation.** Unit coverage is in `client-waits.test.ts`; the flake row still reads "not re-run under load". Reproducing needs several concurrent live container runs (load average about 38 originally).

**Decisions.**

- **How to prove it?**
  - **Run three concurrent `live-session` container scenarios (OpenCode, plus Claude and Codex) and record whether any `--wait` printed the recovery warning and then settled (recommended).**
    - Pros: reproduces the original conditions; closes the flake with evidence.
    - Cons: three live container runs at once; the recovery path may simply not trigger, giving a pass that proves nothing.
  - **Add a deterministic scenario that delays admission past the client timeout with a test hook.**
    - Pros: always exercises the path through the packaged CLI and real backend.
    - Cons: a test-only delay hook in the backend; not a live-provider proof.

### 3. Lost-response recovery for `environment exec --wait` and `environment start --wait`

**Problem.** Code item 4 says these "still exit 4 on a lost response". A script that waits on a slow container start gets exit 4 although the operation may be running.

**Context.** Mentioned in passing in a done item; no todo owns it. Per the folder rules new work goes in a new file.

**Investigation.** Confirmed: `submitForWait` is used only by `packages/cli/src/client/commands/session.ts:136`; the environment commands do not call it. The request key is already saved before sending, so the same lookup would apply.

**Decisions.**

- **Close the gap, and where?**
  - **File a new todo to route every `--wait` mutation through `submitForWait` (recommended).**
    - Pros: one recovery rule for every waiting command; container start is the command most likely to outlast the 60 s request timeout.
    - Cons: `environment exec` has its own worker-claim semantics (code item 3), so the lookup must not mistake an unclaimed exec for a lost one.
  - **Document exit 4 as "check with `run get --request-id`" and leave it.**
    - Pros: no code.
    - Cons: every script must implement the recovery the session commands already do.

### 4. Token cost of a live run

**Problem.** Manifests record no usage, so the cost of a qualification run is unknown.

**Context.** Optional; does not affect `mise run test`.

**Investigation.** There is no public usage action (no usage field in `packages/protocol/src/public-api.ts`, no CLI command); usage lives in the backend's usage store (`apps/backend/src/core/commands-registry-usage.ts`). Reading it would need either a registry call outside `public_action` or a new public read.

**Decisions.**

- **How to collect it?**
  - **Read the scenario data directory's usage store directly in the harness after the run, before cleanup (recommended).**
    - Pros: no public API change; the harness already owns the data directory.
    - Cons: couples the harness to a storage layout; counts only what each provider reports.
  - **Add a content-free usage summary to a public read.**
    - Pros: scripts get it too.
    - Cons: a public-contract change for an optional measurement.
  - **Drop the measurement.**
    - Pros: closes the item.
    - Cons: no basis for budgeting live runs (0031 batches many).

### 5. Fresh Linux evidence

**Problem.** The CLI matrix on Linux was last run on 2026-09-26, before SQLite storage, the bridge splits, #1270's no-`PATH` rule and the 0166 harness change.

**Context.** The file records it under "Not run" but lists no item for it.

**Investigation.** This analysis ran on a Linux host, so the credential-free matrix (`mise run test:cli:scenarios`) and `mise run smoke:cli` can run here without credentials; the container matrix needs `mise run docker:build:dev`.

**Decisions.**

- **Add a Linux re-run?**
  - **Yes, credential-free local and container matrices plus `smoke:cli`, batched with the Cursor run in task 1 (recommended).**
    - Pros: cheap; covers a month of changes on the second platform.
    - Cons: Docker on this host must not collide with production containers (the harness owner labels guard this).
  - **No; rely on CI.**
    - Pros: no manual run.
    - Cons: no workflow under `.github/workflows/` runs `test:cli:scenarios` or `smoke:cli`, so CI gives no Linux CLI evidence.

### 6. Ship the Pi, ACP and Cursor bridges in the published package?

**Problem.** `packages/cli/scripts/build.ts:15-44` bundles only the Claude and Codex bridges, so a standalone `orkestrator serve` cannot run Pi, Cursor or Grok in local environments.

**Context.** Pi's vendored SDK is about 174 MB and Cursor's about 45 MB. The published 2.22.3 package is about 10 MB unpacked.

**Investigation.** Unchanged since 2026-10-22. The desktop app ships all bridges through `build.extraResources`; containers use `/opt/*-bridge`.

**Decisions.**

- **What should the npm package carry?**
  - **Keep it to Claude and Codex, and download other bridges on demand through `toolchain install` (recommended).**
    - Pros: small package; same hash-verified path as the agent binaries.
    - Cons: needs bridge artifacts published per release and a new toolchain kind.
  - **Bundle all five.**
    - Pros: standalone serve works for every provider immediately.
    - Cons: a package roughly twenty times larger for users who never use Pi or Cursor.
  - **Leave it and document the limitation.**
    - Pros: no work.
    - Cons: standalone serve (0033's remote hosts) keeps lacking three providers.

### 7. Re-run qualified providers after an agent upgrade?

**Problem.** `docs/development/upgrade-agents.md` lists `test:cli:scenarios` only for bundled native dependencies (`:1687`); a provider bump can break request-specific completion with no CLI re-run.

**Context.** Shared with 0031, whose recommendation (2026-10-25) is no blanket re-run, only the bumped engine's opt-in live specs. Slash commands already have such a rule (`upgrade-agents.md:1607`).

**Investigation.** Still open in 0031. `live-session` is the only test that proves a provider's `qualified` entry.

**Decisions.**

- **Rule for the runbook?**
  - **On a provider bump, run `live-session` for that provider only (recommended).**
    - Pros: matches the slash-command rule and 0031's recommendation; protects the `qualified` claim the CLI shows.
    - Cons: live tokens and a few minutes per bump.
  - **No rule; rely on users noticing.**
    - Pros: no runbook cost.
    - Cons: a broken completion mapping would ship as `qualified`.

Most shipped CLI behaviour has evidence at every layer: unit and contract
tests, real-backend tests, packaged scenarios on Linux and macOS (local and
container), live Claude, Codex and OpenCode runs, and a real browser. On
2026-10-25 the macOS packaging and profile checks, the foreign-owner Docker
decoy, the per-run model record, other-provider browser cards (OpenCode) and
the scenario measurements were done (see "Evidence log"). What is still
missing is the live qualification run for Pi, Cursor and Grok (the scenario
can drive them; see Qualification item 1), which needs API-key credentials
this host does not have, and the token cost of live runs. Until Pi, Cursor
and Grok are qualified, scripts on those providers cannot use `run wait` as
a success signal.

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
  `exec`, `wrong-profile`, `project-cascade`, `project-init` and (container
  only) `foreign-owner` (credential-free), plus `live-session` (opt-in).
  `setup-failure`, `client-exit` and `project-init` are local only, so the
  local matrix has nine cases and the container matrix seven.
- `wrong-profile` covers a missing explicit profile. `foreign-owner` puts a
  container and two volumes (one mounted, one unmounted) carrying every label
  of the scenario's environment except the owner beside it, and checks that
  `environment start`, `exec`, `list`, `stop` and `delete` leave all three
  exactly as created and that exec runs in the owned container.
- The run manifest records, per result, `backendReadyMs` (launch to the
  backend's readiness line), and on a live run's `session start --wait`
  entry `model: { requested, resolved }`: the pin (or `null`) and the model
  the session reports in force through `session config get`
  (`recordResolvedModel` in `cases.ts`, `RunManifest.annotate` in
  `harness.ts`).
- `e2e/agent-testing/cli-ui.spec.ts` checks CLI-made changes in an open and a
  reloaded renderer. Its live question and approval tests are gated on
  `ORKESTRATOR_AGENT_TEST_LIVE_CLI=1` and run on
  `ORKESTRATOR_AGENT_TEST_LIVE_CLI_AGENT` (default `claude`; optional
  `ORKESTRATOR_AGENT_TEST_LIVE_CLI_MODEL`). The approval test sets the
  environment's execution policy to `approvals: "ask"`.
- `mise run smoke:cli` checks the packed install's platform default config
  directory (macOS `~/Library/Application Support/orkestrator-cli` under a
  disposable `HOME`): 0700 directory, 0600 file, group-writable file refused.
- Recorded runs: Linux on 2026-09-26, macOS with Docker Desktop on
  2026-10-18 and 2026-10-25, the 2026-10-18 one after SQLite storage (#969), native-agent provider and
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
2. **Done (2026-10-25): record the resolved model per live run.** After
   `session start --wait`, `live-session` reads `session config get` and adds
   `model: { requested, resolved }` to that manifest entry, also for a failed
   turn; a failed read is recorded as `readError`, not fatal. Covered by
   `packages/cli/tests/scenario-manifest.test.ts`. Live: an unpinned OpenCode
   run recorded `opencode-go/gpt-5.6-luna`; Claude records its composer alias
   `default` (see "Assumptions and decisions").
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

1. **Open: live `live-session` for Pi, Cursor and Grok**, local and container. Each
   run needs the file assertion plus a follow-up turn. Look specifically for
   OpenCode-style false success: an idle status after a failed turn, or idle
   just after the prompt is accepted and before any answer exists. The
   scenario can now run them (Code item 1); `PROVIDER_COMPLETION` reports
   them `unsupported`, so a run is expected to end with `--wait` exiting on
   `capability-unavailable` until a provider is flipped: qualify by flipping
   the entry locally, running the scenario, and committing the flip only
   with a passing run. Check after each run that the host `~/.pi/agent`,
   `~/.grok` and Cursor state are untouched. Still owed on 2026-10-25: this
   host has no usable credentials. Pi's `auth.json` holds only an OAuth
   entry (the harness keeps `api_key` entries only), there is no
   `CURSOR_API_KEY` or `XAI_API_KEY`, and the host Grok login expired on
   2026-10-23. To close: export `CURSOR_API_KEY`, `XAI_API_KEY` (or sign in
   to Grok again) and add an `api_key` entry to Pi's `auth.json`, build the
   bridges, then run the scenario per provider as described above.
2. **Done (2026-10-25): macOS.** The credential-free matrix and the container
   matrix on Docker Desktop passed on 2026-10-18 and again on 2026-10-25.
   - Packed install: `mise run smoke:cli` passed on macOS.
   - The config directory: `smoke-packed.ts` now runs the installed client
     with a disposable `HOME` and no override and checks
     `~/Library/Application Support/orkestrator-cli` is created 0700 with
     `connections.json` 0600, that a group-writable file is refused (exit 4,
     `connection-not-configured`), and that restoring 0600 works again.
   - `--profile` discovery: every `cli-ui.spec.ts` call uses `--profile`
     against a running `dev:test` profile; the spec passed on three macOS
     profiles (`qa-0014`, `qa-0014-claude`, `qa-0014-codex`).
3. **Done (2026-10-25): browser.** `cli-ui.spec.ts` runs its live tests on
   any provider and gained an approval test. Both passed live on OpenCode
   and on Claude. Codex raised neither a question nor an approval in build
   mode on a host environment (both turns just completed), so there is no
   Codex card to check that way; Pi, Cursor and Grok wait on the
   credentials of item 1.
4. **Done (2026-10-25): foreign-owner Docker decoy through the CLI.** The
   `foreign-owner` container scenario (see "Current state"). A deliberate
   `docker start` of the decoy made it fail at the next check, and its
   cleanup removed the decoy.
5. **Optional measurement.** Done for start-up time, time to failure
   evidence, flake rate and cleanup failures (2026-10-25, "Evidence log").
   Still open: token cost of a live run. The manifest records no usage. To
   collect it, read the provider's usage for the scenario's session before
   cleanup (the backend's `usage-history` store in the scenario data
   directory) or from the provider's billing console for a dedicated key.
   None of this shortens `mise run test`.

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
- Browser card runs use a `dev:test` profile with the provider's
  credentials (`--credential-source <agent>`); a profile stages the host
  login without its refresh token, so OAuth logins are fine there.
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
- Since #1270 an agent-test backend never falls back to `PATH`, so the
  harness installs the selected provider's pinned binary (Claude, Codex,
  OpenCode, Pi or Grok) into the scenario data directory before `serve`, on
  every live run (changed 2026-10-26 by todo 0166; before that only Grok's
  was installed and a host provider's session could not start).
- Live runs use host credentials (`--credential-source`) and cost real tokens.

### Evidence log

Record each run with its date, commit, platform and versions, provider pins,
command, result and limitations. Run artifacts are
`output/cli-scenarios/<run>/manifest.json` (git-ignored; IDs, stages, exit
codes, backend start-up time and, for live turns, the pinned and reported
model).

- **2026-10-26, macOS (Darwin 27.0.0, arm64), todo 0166.** Branch
  `todo-0166-opencode-attach-prompt-0d17ce147985` on `93018933` plus the
  0166 fix; Bun 1.4.4, Docker 29.9.2, image
  `orkestrator-v2:dev-742a66a47e71`, OpenCode 1.19.4 (pinned, installed by
  the harness), model `opencode-go/gpt-5.6-luna` (provider default),
  API-key credentials.
  - Before the harness change the run failed at once: "OpenCode is not
    installed in this agent-test profile's toolchain" (the #1270 PATH
    refusal), manifest `2026-10-26T00-35-10-927Z-be855dae`.
  - `live-session --provider opencode`, local: pass (51.8 s), every stage
    including `prompt --attach --wait` (exit 0, 4.2 s) and the transcript
    check; manifest `2026-10-26T00-36-39-580Z-6b222f87`.
  - Same, container: pass (88.0 s), `prompt --attach --wait` exit 0 (8.3 s);
    manifest `2026-10-26T00-38-15-570Z-fa598ef6`. No cleanup errors.
- **2026-10-25, macOS arm64, review follow-up on `bab01b13`.** Bun 1.4.4,
  worktree image `orkestrator-v2:dev-1af641a7170c` rebuilt with
  `mise run docker:build:dev`.
  - `mise run test:cli:scenarios`: local 9/9 pass (47 s including build),
    manifest `2026-10-25T18-36-53-741Z-be5e1a2e`.
  - `bun packages/cli/scripts/run-scenarios.ts --environment-type container
    --docker-image orkestrator-v2:dev-1af641a7170c`: container 7/7 pass
    (169 s), including the added unmounted foreign volume; manifest
    `2026-10-25T18-39-29-682Z-8f32d1f8`. Both matrices record non-null
    `backendReadyMs` for every case and no cleanup errors.
  - Real Docker negative control: deleting the unmounted foreign volume
    made `assertUnchanged` fail; all three decoy resources were then
    verified absent, including idempotent cleanup of the removed volume.
  - Deterministic tests cover container and volume removal errors/timeouts,
    verified and already-absent cleanup, cleanup-only failure retention,
    readiness measurement and manifest output, and answered-card polling
    retries, deadline and empty/new pending interactions. These tests use
    controlled Docker/backend responses and do not qualify live providers.
  - Static checks, focused regressions and test ownership checks passed.
    The repository suite exited 1 on the existing terminal-history pagination
    timeout (5001.99 ms); its unchanged complete owner passed alone in 7.0 s.
    The backend reported 11433 passed, 89 skipped, one failed and one error;
    all other packages and groups passed. Recurrence and artifacts are in
    [flake 0213](../../tests/flaky-tests/backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md#cli-qualification-review-validation--2026-10-25).
  - No provider turns or browser card checks were repeated for these
    harness and documentation fixes.

- **2026-10-25, macOS (Darwin 27.0.0, arm64), this file.** Branch
  `todo-0014-cli-qualification-060fd6539163` on `00a0cb82`; Bun 1.4.4,
  Docker Desktop Engine 29.9.2, image `orkestrator-v2:dev-1af641a7170c`,
  Claude Code 2.1.304, OpenCode 1.19.0 (scenario, managed binary on `PATH`)
  and 1.19.4 (profile toolchain). Host load average 24 to 64 throughout.
  - Credential-free, local (`mise run test:cli:scenarios`): 9/9 pass, then
    three more back-to-back runs, 27/27 pass (matrix 64 to 80 s). Container
    (`--environment-type container --docker-image
    orkestrator-v2:dev-1af641a7170c`): 7/7 pass including `foreign-owner`
    (48.6 s), 191 s total. No cleanup errors, no decoys left.
  - Measurements from the three repeated local runs (27 scenario runs):
    backend start-up 1.4 to 4.4 s; time to setup-failure evidence 13 to
    15 s; scenario durations 2 to 15 s; flake rate 0/27 (plus 0/16 in the
    first local and container passes); cleanup failures 0. Token cost not
    measured (item 5).
  - `foreign-owner` alone: pass (19.8 s). With a `docker start` of the decoy
    inserted, it failed at `[start] the foreign-owner decoy changed`, and
    cleanup removed the decoy and its volume.
  - Live `live-session`, local, unpinned: Claude pass (58.7 s; manifest
    `model: { requested: null, resolved: "default" }`). OpenCode recorded
    `resolved: "opencode-go/gpt-5.6-luna"`; start, file assertion,
    follow-up, command listing, refusals and `--literal` passed, then the
    `--attach` prompt settled `unknown` (exit 7) on both runs because it
    never reached OpenCode. Filed as
    [0166](0166-opencode-prompt-attachment-never-dispatched.md).
  - `mise run smoke:cli`: pass, including the new platform config directory
    check (`<tmp>/home/Library/Application Support/orkestrator-cli`).
  - `cli-ui.spec.ts` on `dev:test` profiles (all calls through
    `--profile`): `qa-0014` (`--credential-source opencode`): the two
    credential-free tests passed; the live question and approval tests
    first failed on the asynchronous-submit race (see "Assumptions and
    decisions"), then both passed after the fix (1.6 min).
    `qa-0014-claude`: 4 passed, 1 skipped (the Codex move test's own gate),
    1.5 min. `qa-0014-codex` (`gpt-6-sol`): both live tests failed their
    exit-6 precondition because Codex completed without asking. All three
    profiles were stopped and reset.
  - Host homes: the scenario runs use disposable provider homes; the
    profiles stage host logins without refresh tokens.
  - Checks: `mise run format:check`, `mise run lint` (exit 0; existing
    warnings only) and `mise run typecheck` pass; `packages/cli` suite
    259/259. Complete `mise run test`: exit 1 after about 27 minutes, solely on
    `commands-file-copy.test.ts` (EPIPE in a container helper case this
    branch does not touch); that file passed alone three times. Registered
    as flake
    [0910](../../tests/flaky-tests/environments-and-containers/0910-file-copy-container-helper-stdin-epipe.md).
    Root/agent-support, bridges, the protocol lockfile and every other
    workspace package passed. The aggregate remains failed.
  - Not run: Pi, Cursor, Grok (no credentials, item 1); container
    `live-session`; Linux (the 2026-09-26 run is still the latest Linux
    evidence).

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

## Assumptions and decisions

- **Where the resolved model comes from (Code item 2).** Options: (a) the
  public `session config get` (the composer's selected model); (b) parse
  the transcript; (c) read provider state from the disposable home. Chose
  (a): it is the public surface a script would use, works for every
  provider and container runs, and needs no new API. Pro: no backend
  change, request-independent. Con: it is the model the session reports in
  force, which for Claude is the alias `default`, not a concrete model ID;
  the transcript carries no model either. Recorded as is rather than
  guessed.
- **A failed model read does not fail the run.** Options: fail the scenario
  or record `readError`. Chose recording: the turn's own outcome stays the
  verdict, and a provider with no composer state would otherwise fail
  qualification for an unrelated reason. Con: a missing model is only
  visible in the manifest and the printed line.
- **Decoy as a new container-only scenario (item 4)** rather than extending
  `wrong-profile`. `wrong-profile` is a client-side selection check that
  needs no Docker; the decoy needs a container environment and the
  worktree image. The decoy carries every label a lookup by environment
  could match (`app`, `environment-id`, `project-id`, `environment-name`)
  and a foreign `orkestrator-owner`, plus mounted and unmounted volumes. The
  unmounted volume can be deleted without Docker's in-use protection, so it
  exposes an ownership regression that a mounted volume could mask. Cleanup
  accepts only explicit already-absent responses, verifies absence and records
  other Docker failures. Deterministic negative controls and cleanup failure
  coverage are in `packages/cli/tests/scenario-docker-decoys.test.ts`; these
  checks do not add live Docker qualification evidence. Con: it does not cover
  a container reached by ID, which the CLI cannot name; the gateway check in
  `browser-gateway.spec.ts` keeps covering that.
- **Config directory check in `smoke:cli` (item 2)** rather than a unit
  test (one exists: `defaultCliConfigDir` takes the platform) or a manual
  check. The smoke runs the packed install, so it proves the shipped layout
  and real `os.homedir()` resolution on whichever platform runs it. A
  disposable `HOME` keeps the operator's own configuration untouched. Con:
  the macOS branch is only proved when the smoke runs on macOS.
- **Browser cards on OpenCode (item 3).** OpenCode is the only non-Claude
  provider with usable credentials here for a profile that raises both
  interactions; Codex was tried and does not ask in build mode. The live
  tests became provider-parametrised instead of copied per provider. The
  approval case uses the per-environment execution policy, because a host
  session auto-approves by default. The first OpenCode run failed in the
  test, not the product: the renderer submits asynchronously, so `run
  wait` straight after the click still saw the answered interaction (exit
  6); a CLI-only repro settled `succeeded` even with the resolve running
  concurrently. The test now retries while only the answered interactions
  are reported (bounded at 60 s).
- **OpenCode `--attach` lost prompt filed as todo 0166**, not fixed here: it
  belongs to todo 0017's attachment path and needs its own diagnosis. It
  makes OpenCode's `live-session` fail after the parts this file owns
  (start, file assertion, follow-up, model record) have passed. Fixed by
  0166 on 2026-10-26 (see the evidence log).
- **Item 5 narrowed, not finished.** Start-up, failure time, flake rate and
  cleanup failures were measurable from the manifests; token cost was not,
  and stays open.

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

- [0166-opencode-prompt-attachment-never-dispatched.md](0166-opencode-prompt-attachment-never-dispatched.md):
  the OpenCode `--attach` failure found by this file's 2026-10-25 run.
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
