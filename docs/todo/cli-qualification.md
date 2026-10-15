# CLI qualification

Checked against `main` at `2459b05c` (2026-10-15).

Most shipped CLI behaviour has evidence at every layer: unit and contract
tests, real-backend tests, packaged scenarios on Linux (local and container),
live Claude, Codex and OpenCode runs, and a real browser. What is missing is
request-specific completion for Pi, Cursor and Grok, every macOS and Docker
Desktop run, and a re-run since the storage, provider and SDK changes of
October. Until Pi, Cursor and Grok are qualified, scripts on those providers
cannot use `run wait` as a success signal.

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
  `codex-bridge`; OpenCode runs its own server. Pi, Cursor and Grok therefore
  cannot run the `live-session` scenario at all.
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
- The only recorded run is the Linux run of 2026-09-26 (see "Evidence log").
  Since then the following have landed: SQLite storage (#969), native-agent
  provider and transcript unification (#970, #971), the Claude bridge
  `sendPrompt` split (#984), and agent SDK upgrades (#935, #964).

## Outstanding work

### Code

1. **Make Pi, Cursor and Grok qualifiable.** Either let `run-scenarios.ts`
   and the harness target an already running full `dev:test` profile for
   `live-session`, or bundle the Pi, ACP and Cursor bridges into the package.
   When a provider passes, flip its `PROVIDER_COMPLETION` entry and update the
   matrix in `public-cli.md`.

### Qualification

1. **Live `live-session` for Pi, Cursor and Grok**, local and container. Each
   run needs the file assertion plus a follow-up turn. Look specifically for
   OpenCode-style false success: an idle status after a failed turn, or idle
   just after the prompt is accepted and before any answer exists.
2. **macOS.**
   - Packed install: `mise run smoke:cli`.
   - The config directory `~/Library/Application Support/orkestrator-cli` and
     its permission checks.
   - `--profile` discovery against a `dev:test` profile.
   - The credential-free matrix.
   - The container matrix on Docker Desktop (`--environment-type container`),
     including exec descendant cleanup.
3. **Browser.** Question and approval cards for a CLI-started run on providers
   other than Claude. `cli-ui.spec.ts` checks only Claude live.
4. **Foreign-owner Docker decoy through the CLI.** Add a scenario (or extend
   `wrong-profile`) where a container labelled for another profile exists, and
   assert the command neither falls back nor mutates it.
5. **Re-run at current `main` and current pins.** Credential-free and container
   matrices, plus live Claude, Codex and OpenCode, local and container. Record
   the results in "Evidence log".
6. **Optional measurement.** Scenario start-up time, time to failure evidence,
   flake rate, cleanup failures and token cost, before claiming the CLI makes
   testing faster. It does not shorten `mise run test`.

Run prerequisites specific to the CLI scenarios (shared profile and
credential setup is in
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)):

- Container runs need this worktree's own image. Build it with
  `mise run docker:build:dev` and pass the printed tag to `--docker-image`;
  `run-scenarios.ts` refuses a `:latest` tag.
- Non-Claude container runs need `--network full`, because the default
  restricted allowlist reaches only Anthropic's API. The `live-session` case
  adds it itself for non-Claude providers; any new live container scenario
  must do the same.
- Codex in a container also needs the explicit `CODEX_HOME` credential opt-in
  (for example `CODEX_HOME=$HOME/.codex`). In an agent-test runtime,
  `portableInputSpec` (`apps/backend/src/core/portable-inputs.ts`) stages a
  Codex home into containers only from `CODEX_HOME`. On 2026-09-26, runs
  without it or without `--network full` stayed running to their deadline or
  failed with 401, and both were reported truthfully.
- Pin the model with `ORKESTRATOR_SCENARIO_MODEL`. Codex's default model was
  unsupported on the test account. The case validates the pinned model against
  a refreshed catalogue (`agent options --refresh`) before using it.
- Live runs use host credentials (`--credential-source`) and cost real tokens.

### Evidence log

Record each run with its date, commit, platform and versions, provider pins,
command, result and limitations. Run artifacts are
`output/cli-scenarios/<run>/manifest.json` (git-ignored; IDs, stages and exit
codes only).

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
    [`cli-testing.md`](../development/cli-testing.md#coverage-by-layer).

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
  Bundling widens what the published package ships; targeting a profile keeps
  the package small but makes the scenario depend on a running stack.
- Should qualified providers be re-run after every agent SDK or binary
  upgrade? [`upgrade-agents.md`](../development/upgrade-agents.md) has no such
  step, and
  [`upgrade-agents.md` → Other dependencies](../development/upgrade-agents.md#other-dependencies)
  lists `test:cli:scenarios` only for bundled native dependencies. The shared
  question is in
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

## Needs verification

- Whether the credential-free matrix still passes at `2459b05c`. It was not
  run for this file.

## Related

- [cli-command-surface.md](cli-command-surface.md): each new capability adds a
  scenario and, where the UI rehydrates, a `cli-ui.spec.ts` check.
- [container-platform-qualification.md](container-platform-qualification.md)
  for Docker Desktop runs batched with other container work.
- [`public-cli.md`](../architecture/public-cli.md#targeted-scenarios),
  [`cli-testing.md`](../development/cli-testing.md),
  [`testing-guide.md`](../development/testing-guide.md#cli-scenarios),
  [`agent-testing.md`](../development/agent-testing.md).

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
