# Isolated development and agent testing

Status: Living — isolated profiles and real-stack QA.

Use agent-test profiles whenever testing Orkestrator from an installed Orkestrator
instance. A profile has its own Electron `userData`, backend registry, browser
gateway, worktrees, fixture, logs, Docker owner, and development image tag. It
binds only to `127.0.0.1` and never configures Tailscale Serve.

This guide covers the isolated application and browser workflow. Use
[testing-guide.md](testing-guide.md) first to choose between focused,
changed-only, aggregate, browser, agent, and iOS suites and to diagnose runner
timeouts, cache behavior, or failure artifacts.

## Prerequisites

- macOS or Linux, mise with the repository-pinned Bun 1.4.4 installed, and
  repository dependencies installed.
- Docker only for container fixture environments. The default fixture and local
  smoke path do not require a Docker image.
- The first TypeScript compilation and Vite startup normally take under a minute.

## One-shot browser validation

For review plans and automated validation, use these exact commands from the
repository root:

```bash
mise run test:agent:browser:isolated
# For design-only changes, run the design-canvas spec instead of the full suite:
mise run test:agent:design:isolated
```

Each task creates a unique disposable profile, starts `dev:test` concurrently,
polls `dev:status --json` until all runtime processes are ready, runs Playwright,
and stops/resets the profile in `finally`. Startup is bounded to two minutes,
the browser suite to fifteen minutes, and each cleanup command to 45 seconds.
An IPC-owned supervisor also cleans up when the caller is cancelled or killed.
Test failures and cleanup failures return a nonzero exit status. Artifacts stay
under `output/agent-testing/<unique-profile>/browser/`; profile state is removed.

These tasks provision Codex without agent credentials and run ordinary local
browser coverage. Live review and Docker tests remain opt-in and require the
manual profile workflow below. Ambient live-review/Docker opt-ins are disabled
inside these one-shot tasks.

To work around a host-specific problem without hand-assembling a profile, pass
`dev:test` profile flags through: `--credential-source <name>` (repeatable),
`--agent-platforms <list>`, `--no-agent-credentials` and
`--use-dev-worktree-folder`. A credential or platform flag replaces the
matching default, for example:

```bash
mise run test:agent:browser:isolated --agent-platforms codex,opencode
```

The runner owns `--profile` and `--fixture` and rejects anything else before it
creates a profile.

Both full browser tasks (`test:agent:browser` and its isolated variant) build
the packaged CLI first (`build:cli`), because `cli-ui.spec.ts` drives
`packages/cli/dist`.

Both commands and their workspace-exclusive resources are registered in
`.orkestrator-test-scheduler.json`. Discovery must select them **verbatim** as
separate commands. The full browser task covers the targeted design task; do
not schedule both. They are ordinary profiled commands, so the review worker
owns their capacity reservation. Do not wrap them in extra profile lifecycle
shell commands or call another aggregate scheduler around them.

The fixture backend uses a private two-slot scheduler inside its disposable
profile. Browser queue tests intentionally fill this simulated host; they must
not enqueue against the real host capacity already reserved by the outer review
task. Its fixed two-slot budget stays within the outer reservation, and reset
removes its queue along with the profile. A manually started profile uses the
real host scheduler, so the queueing case skips unless the suite runs with
`ORKESTRATOR_TEST_SCHEDULER_DIR` set and `ORKESTRATOR_TEST_HOST_WORKERS=2`. To
run it against a manual profile, export those two variables and
`ORKESTRATOR_TEST_HOST_MEMORY_MIB=2048` for both `dev:test` and the browser
suite.

## Codex typed-prompt resume qualification

`e2e/agent-testing/codex-typed-prompts-live.spec.ts` sends three short real Codex
turns through the composer (plan mode, a skill and a prompt template). It checks
that user rows keep the typed text after an inactive-environment round trip,
reload, tab close and picker resume. Skills/templates are planted only in the
disposable worktree. Traces and screenshots are disabled.

```bash
mise run dev:test --profile codex-typed-qa --fixture --credential-source codex --agent-platforms codex
# In another terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=codex-typed-qa ORKESTRATOR_AGENT_TEST_LIVE_TYPED_PROMPTS=1 mise run test:logged -- --name codex-typed-browser -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts codex-typed-prompts-live.spec.ts --workers=1
mise run dev:stop --profile codex-typed-qa
mise run dev:reset --profile codex-typed-qa
```

## Codex refused-login qualification

`e2e/agent-testing/codex-refused-login-live.spec.ts` sends one Codex turn on a
login the API refuses and checks the tab shows the 401 and the `needs-auth`
sign-in banner, before and after a reload (todo 0235). Give the profile a
made-up API key from a throwaway `CODEX_HOME`, never a real login; the key goes
to OpenAI and is refused.

```bash
mkdir -m 700 /tmp/qa-refused-codex-home   # holds auth.json: {"auth_mode":"apikey","OPENAI_API_KEY":"sk-proj-<made up>"}
CODEX_HOME=/tmp/qa-refused-codex-home mise run dev:test --profile codex-refused-qa --fixture --credential-source codex --agent-platforms codex
# In another terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=codex-refused-qa ORKESTRATOR_AGENT_TEST_LIVE_REFUSED_LOGIN=1 mise run test:logged -- --name codex-refused-browser -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts codex-refused-login-live.spec.ts --workers=1
mise run dev:stop --profile codex-refused-qa
mise run dev:reset --profile codex-refused-qa
```

## Claude warm-runtime qualification

`e2e/agent-testing/claude-warm-runtime.spec.ts` exercises real Claude follow-up
prompts, plan and permission changes, a paused approval across an inactive
environment, an MCP configuration edit and transcript rehydration after reload.
It enables project resources only for the disposable fixture, uses the harmless
MCP stdio server and changes only disposable worktrees.
It requires an explicit live opt-in and usable Claude credentials; a provider
failure is a failed qualification, never a passing smoke check.

Start a profile in one terminal:

```bash
mise run dev:test --profile claude-warm-qa --fixture --credential-source claude --agent-platforms claude
```

Run the test from another terminal, then stop and reset that exact profile:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=claude-warm-qa ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE=1 mise run test:logged -- --name claude-warm-app -- bunx playwright test --config e2e/agent-testing/playwright.claude-warm.config.ts --workers=1
mise run dev:stop --profile claude-warm-qa
mise run dev:reset --profile claude-warm-qa
```

## Grok container login qualification

The Docker fixture suite boots and restarts a disposable image with synthetic
access-only Codex and Grok imports. It checks owner-only permissions, retained
access tokens, empty refresh tokens, and unchanged read-only sources. Build the
profile image before running the Docker suite:

```bash
mise run docker:build:dev --profile grok-login-qa
mise run dev:test --profile grok-login-qa --fixture --fixture-environments local,container --credential-source grok --agent-platforms grok
# From a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=grok-login-qa mise run test:logged -- --name docker-login -- mise run test:agent:docker
```

`grok-container-login.spec.ts` also offers an opt-in real-provider check. It
requires a usable host Grok login when the profile starts; a missing or expired
login produces an explicit skip. Containers take the profile's own Grok
snapshot (`<dataDir>/agent-credentials/home/.grok/auth.json`, the profile's
HOME), which is the file the spec edits; until 2026-10-26 container staging
read the real host `~/.grok` instead, so the spec could not have passed. It gets an authenticated reply, advances only
the disposable profile's login expiry metadata, withholds the expired host
snapshot, restores a current host snapshot, and synchronizes it into the same
bridge. A follow-up must recall the first turn's codeword in the same session.
This simulates expiry and host renewal without waiting hours or consuming the
host's refresh token; it does not qualify the provider's own refresh exchange.
Traces and screenshots are disabled, and credentials and replies stay out of
assertion output.

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=grok-login-qa ORKESTRATOR_AGENT_TEST_DOCKER=1 ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN=1 mise run test:logged -- --name grok-login-live -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts --grep 'Grok login renewal'
mise run dev:stop --profile grok-login-qa
mise run dev:reset --profile grok-login-qa
```

## Start or reuse a profile manually

`dev:test` is a **foreground supervisor**. After printing `ready`, it stays
attached until Vite or Electron exits. It does not return at readiness. Never
use `mise run dev:test ...; mise run test:agent:browser` (or `&&`): the browser
command cannot run while the profile is alive. Use the one-shot tasks above
for automation.

For interactive development, keep the starter running in its own terminal:

```bash
mise run dev:test --profile codex-qa --fixture
```

Run status, login, tests, and stop/reset commands from a **second terminal**:

```bash
mise run dev:status --profile codex-qa --json
```

The second start is idempotent and reports the already-running launcher. Wait for
`status: "ready"`; never assume fixed ports. Use only the returned `browserUrl`,
`testProject`, `electronTitle`, and `logDir`. The manifest names the mode-0600
gateway auth file but never includes its token.

### Bridge builds

The backend runs from source, but it launches every local bridge from
`bridges/<bridge>/dist/index.js`. Before it starts the backend, `dev:test`
builds all five bridges with `turbo run build` (output in the profile's
`logs/bridge-build.log`). Turbo restores an unchanged bridge from its cache,
which takes a few seconds; a changed bridge, or a change to a package it
bundles such as `packages/protocol`, rebuilds in about five more. A failed
build stops the start. Plain `mise run dev` does not build bridges.

Preparation compares Turbo input hashes before and after the build and its log
write. If any input changed, restart `dev:test` to build again; it does not write
a new record for that attempt. Every bridge must have a nonempty task hash in
Turbo's plan. A failed or incomplete plan stops preparation or the suite check,
including when the stale-build override is set: the override permits known
mismatches, and cannot establish freshness when planning fails.

The start then records each bridge's Turbo build hash and the SHA-256 of its
`dist/index.js` in `runtime/bridge-builds.json` beside `status.json`. The
browser, paused-interactions, Claude warm-runtime and coordinator Playwright
configs compare that record with the checkout in a global setup and fail
before the first test when a bridge's sources or `dist` changed since the
profile started: the profile's bridges, some already running, would test the
old build. Restart the profile (`dev:stop`, then `dev:test` with the same
flags) to rebuild them, or set `ORKESTRATOR_AGENT_TEST_ALLOW_STALE_BRIDGES=1`
to run anyway. A profile started before records existed is reported, not
failed. The one-shot runners (`test:agent:browser:isolated`,
`test:agent:design:isolated`, `test:agent:coordinator`) start a new profile,
so they always build first. The older-bridge step below swaps one bundle in
during a spec, after the check, and is unaffected.
The Electron Playwright config starts its own app and does not use this guard.

## Sign a browser in

```bash
mise run dev:login --profile codex-qa          # human-readable
mise run dev:login --profile codex-qa --json   # { loginUrl, expiresAt, ... }
```

This is the normal way to reach the UI. The command reads the profile's auth
file on the host, exchanges it for a bootstrap code over loopback, and prints a
`loginUrl`. Open that URL in the browser under test: the gateway consumes the
code, sets the session cookie, and redirects to the app, so nothing has to be
typed into the login form.

The link is deliberately weak on its own. It carries a single-use code, not the
gateway token; it is destroyed by the first request that presents it; it expires
in two minutes; and it is only accepted on an agent-test profile's loopback
browser listener. Mint a new one whenever a link is spent or stale — that is
cheaper than reusing anything. The durable token never appears in the URL,
`dev:login` output, or browser state, and must still never be echoed, pasted
into chat, or captured in artifacts.

The resulting browser session renews on throttled keyboard and pointer activity,
so background status polling cannot keep an abandoned tab authenticated. It
lapses after 30 minutes without user activity, after 12 hours regardless of
activity, and whenever the backend restarts. Existing event and terminal streams
are closed at the same deadline. Any of those simply means minting another link.

A lapse is never silent. The first command or renewal that comes back `401`
sends the tab to the login page, so a stale-but-rendered UI is not a state an
agent has to diagnose: if the browser under test is suddenly showing the login
page, the session lapsed and the fix is a fresh `dev:login` link.

Agent-test profiles authorize the host's Claude, Codex, Cursor, Grok, OpenCode
and Pi credentials by default so manual QA can run real agents. A profile gets
the host's login, never its provider directory: Claude a process-scoped access
token, Codex, OpenCode and Grok an owner-only `auth.json` snapshot without a
refresh token in the profile's own home, re-read on every start. Sessions,
trust grants, MCP saves and settings stay in the profile. Pi alone shares the
host `auth.json` in place:

See [`credentials-and-models.md`](credentials-and-models.md) for the full
per-platform credential, container-import, and model-cache matrix.

```bash
mise run dev:test --profile live-agents --fixture
```

To narrow the profile to one provider, pass `--credential-source codex` (or any
other agent platform). To test the signed-out experience, pass
`--no-agent-credentials`. GitHub and unrelated ambient API credentials remain
disabled. Live agent requests can incur external effects or cost, so use only
the seeded fixture and do not put credentials in test output.

## Agent toolchains in an isolated profile

An agent-test profile provisions its own managed toolchain for every agent
platform by default, taking its selection from the launcher rather than from the
durable per-installation choice — an isolated run never inherits or rewrites
your real one.

An agent-test profile runs only the agents its own toolchain holds. Outside a
profile, Claude, Codex, OpenCode and Pi fall back to a PATH lookup when no
managed copy exists; inside one they do not, so availability reporting
(`checkHostTool`) and spawning agree: a platform the profile did not provision
reports as unavailable, and a launch requested directly through the backend
fails with `<Agent> is not installed in this agent-test profile's toolchain`
rather than running whatever version the host has on PATH. Cursor and Grok
resolve **only** through the managed toolchain everywhere, by design (`cursor`
on PATH is the desktop editor, not the ACP agent). A profile without them
reports `Cursor Agent is enabled but not installed yet` when a session is
created, which reads like a broken install rather than a missing selection.
A terminal tab is a shell, not a backend launch: a command typed there still
resolves through the shell's PATH, with the managed directories first.

The launcher's selection is also written into the profile's own state, so the
platforms it provisions are the platforms the app offers. Without that, a run
would download Cursor and Grok and still show only the legacy three in every
agent picker.

Startup seeds each toolchain from your host installation when it has the same
pinned version, so the default normally costs a local copy rather than a
download. Anything the host lacks is downloaded as usual, and a toolchain the
profile already has is left alone. Narrow the set when a run does not need all
five:

```bash
mise run dev:test --profile cursor-qa --fixture --agent-platforms cursor,grok
```

`--agent-platforms` belongs to `dev:test` only; `mise run dev` rejects it rather
than accept a value it would ignore, because ordinary development keeps its
durable per-installation selection.

A new agent-test profile keeps its worktrees under `<profile>/worktrees/` even
when Settings > Disk usage names a folder for new dev worktrees, so the browser
suites see the same layout on every host. Pass `--use-dev-worktree-folder` to
place them in that folder instead; `mise run dev` always uses it.

The launcher prints what it seeded, what it could not seed, and what Electron
will therefore download. A first run on a host without the pinned versions needs
network access for that download, and it is the slow part of startup — narrowing
the selection is the way to avoid it. If preparation fails, an agent-test profile
logs the reason and exits instead of waiting on a retry dialog nobody is there to
answer; look for it under the manifest's `logDir` and in the launcher output, then
re-run once the cause is fixed.

Seeding is one-way: nothing is written back into the production data directory,
and its activation directory is never touched. Use `--keep-toolchains` with
`dev:reset` to retain what a profile has provisioned.

On macOS, Claude's and Cursor's logins live in the login Keychain rather than on
disk. Startup reads only the explicitly authorized provider's named Keychain
records: Claude receives its access token only in the Claude bridge process,
while Cursor receives an owner-only `auth.json` in a Cursor-specific HOME using
its supported file credential store. The host Keychain directory is never linked
into the backend or terminal HOME. If an authorized profile still reports Claude
as signed out, confirm the host itself is logged in with `claude auth status`
before treating it as a profile problem.

Startup fills missing profile caches from available, bounded model metadata:
`agent-model-catalog.json`, `opencode-model-catalog.json`, Codex
`models_cache.json`, the Codex bridge `models-cache.json`, and Grok
`models_cache.json`. Cursor and Grok picker entries are also carried in the
shared `agent-model-catalog.json`; Cursor has no separate portable model-cache
file. This makes model pickers representative even in a deliberately
credential-free run. Existing profile caches are preserved across restarts, and
the seeding does not copy projects, sessions, prompts, settings, or additional
credentials. Grok's explicitly authorized local login is the sole exception: a
bounded owner-only `auth.json` snapshot is refreshed into the isolated home,
holding access tokens only. Its refresh tokens are blanked, so an expired host
login leaves Grok signed out in the profile (see
[credentials-and-models.md](credentials-and-models.md#agent-test-credential-policy)).

To create and start fixture environments during seeding:

```bash
mise run dev:test --profile codex-qa --fixture --fixture-environments local
# Requires the profile image printed in profile.json:
mise run dev:test --profile container-qa --fixture --fixture-environments local,container
```

`fixture-container` is created in restricted network mode. A network mode is
fixed when an environment is created, so to run the real-stack Docker set
against a full-network container start the profile with
`--fixture-network full` (it needs `--fixture-environments` with
`container`). `container-root-terminal.spec.ts` checks whichever mode the
fixture has: uid 0 through **New root terminal**, and a host outside the
allowlist refused (restricted) or reached (full). A credential-free Docker
profile (`--no-agent-credentials`) should leave Claude out of
`--agent-platforms`; otherwise the blocking "Claude Code Is Not Logged In"
dialog stops the UI specs.

```bash
mise run dev:test --profile container-full-qa --fixture --fixture-environments local,container \
  --fixture-network full --no-agent-credentials --agent-platforms codex,grok,opencode
```

The container fixture path builds the workspace-specific development image when
it is missing. Rebuild it explicitly without touching `orkestrator-v2:latest`:

```bash
mise run docker:build:dev --profile container-qa
```

Never add the live Orkestrator source checkout as the project under test. Use the
copied `testProject` only.

## Automated checks

Run focused package typechecks/tests first, with bounded `--parallel` workers on
direct suites. The aggregate runner already uses bounded logs; run every other
automated command through the repository's logged runner. It streams
stdout/stderr to private storage, preserves the child exit status, deletes raw
output on success, and compresses bounded failure evidence. Run each command
separately so its result belongs to one check:

```bash
mise run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck
mise run test:logged -- --name changed-component -- \
  bun --cwd=apps/web test src/path/to/ChangedComponent.test.tsx \
  --parallel=2 --only-failures

ORKESTRATOR_AGENT_TEST_PROFILE=codex-qa \
ORKESTRATOR_AGENT_TEST_RUN_ID=codex-qa \
mise run test:logged -- --name agent-browser -- mise run test:agent:browser

mise run test:logged -- --name agent-electron -- mise run test:agent:electron

# Against a profile started with --fixture-environments local,container:
ORKESTRATOR_AGENT_TEST_PROFILE=container-qa \
mise run test:logged -- --name agent-docker -- mise run test:agent:docker

# Run for cross-cutting or release-sensitive changes:
mise run test

# Release validation, including the serial iOS suite:
mise run test:all
```

The Playwright agent commands are opt-in and are not included in `mise run
test`. They require the matching profile and fixture preparation described in
this document. `mise run test:all` adds the serial iOS suite, not the agent
browser suites.

The build-pipeline steering scenario uses the live-review opt-in and Codex
credentials. Start a disposable fixture profile in a separate terminal, then
run this focused check:

```bash
mise run dev:test --profile qa-build-steer --fixture --credential-source codex --credential-source claude --agent-platforms codex
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-build-steer ORKESTRATOR_AGENT_TEST_REVIEW=1 \
  mise run test:logged -- --name build-steer-live -- mise run test:agent:browser -- \
  e2e/agent-testing/browser-gateway.spec.ts --grep 'build pipeline live steering'
mise run dev:stop --profile qa-build-steer
mise run dev:reset --profile qa-build-steer
```

It sends `/steer` through the composer into a held-open build turn, switches to
another environment, checks the instruction's file effect and authoritative
transcript while inactive, then returns and reloads to verify transcript and
controls. It cancels the turn and removes its pipeline and fixture environments
in cleanup. Credential-free one-shot browser validation skips this scenario.
Set `ORKESTRATOR_AGENT_TEST_MODEL` to override its `gpt-6.1-sol` build model when
the test account needs a different supported model.
The Claude credential source serves host-tool onboarding when Claude is
installed; the scenario runs only a Codex model turn. The scenario temporarily
seeds an empty `.claude.json` onboarding marker in the profile's isolated HOME
if it is absent, and removes only the marker it created during cleanup. This
does not authenticate Claude or modify the host's configuration.

Before stopping that profile, you can also run the live mail scenario:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-build-steer ORKESTRATOR_AGENT_TEST_REVIEW=1 \
  mise run test:logged -- --name mail-steer-live -- mise run test:agent:browser -- \
  e2e/agent-testing/browser-gateway.spec.ts --grep 'agent mail Deliver now steers'
```

It releases mail from the conversation's Deliver now action into a running
Codex turn, checks that one steer UUID joins the existing session's history,
and verifies the mail's file effect while another environment is active.
Reloading must retain the delivered status without sending the carrier again.
The native mail-steer suite separately exercises a turn changing between the
active-run lookup and the provider's check of `expectedRunId`.

The live OpenCode spec (`e2e/agent-testing/opencode-live.spec.ts`) has its own
opt-in and uses the host's OpenCode credentials. No fixed default model ships,
so without a pin the native-tab case starts on the default your connected
providers resolve and reads that model back from the projection.
`ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL`, written as `<provider>/<model>` from a
connected provider, pins the native tab. The build-pipeline case asserts
thinking rows, so it needs a pinned model that emits reasoning and is skipped
without one.

```bash
mise run dev:test --profile qa-opencode-live --fixture --credential-source opencode --agent-platforms opencode
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-opencode-live ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1 \
  ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL='<provider>/<model>' \
  mise run test:logged -- --name opencode-live -- mise run test:agent:browser -- \
  e2e/agent-testing/opencode-live.spec.ts
mise run dev:stop --profile qa-opencode-live
mise run dev:reset --profile qa-opencode-live
```

The native-tab case sends a real turn and switches environments while it
runs. It then checks the transcript after returning and after a hard reload.
It also checks Agent Info usage metrics, undo (the reverted reply leaves the
transcript), redo, compact and fork (the fork tab keeps the source's model and
reasoning profile before its first prompt). The build-pipeline case starts an
OpenCode build on the pinned model. It checks that the served transcript has
no raw `{ info, parts }` envelopes, then checks that thinking and timed tool
rows render before and after reload. Each case
removes its pipeline and environments during cleanup. The spec never presses
**Share…**, which would publish the conversation. Without the opt-in, every
case is skipped and no profile is needed.

The live MCP apply probe (`e2e/agent-testing/mcp-apply-live.spec.ts`) has
its own opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_MCP=1`. For each provider in
`ORKESTRATOR_AGENT_TEST_MCP_PROVIDERS` it saves and applies a harmless stdio
server (`mcp-probe-server.mjs`) through the MCP editor's own commands in every
writable scope, then edits, renames and removes it, and reads from the
server's log whether each model call really reached it. It refuses to write a
source outside the test worktree or the profile's data directory. Authorizing
the Codex or OpenCode credential source points those providers at the host's
own homes, so their user scopes are then skipped; the
[live record](../todo/mcp/0039-mcp-management.md#live-apply-record-2026-10-18) shows
how those scopes were covered with an access-only credential seeded into the
profile. Run one provider at a time (flake 0420). Each provider writes
`output/agent-testing/<run>/mcp-apply-live/<provider>.json`.

The live idle-observation spec (`e2e/agent-testing/idle-observation-live.spec.ts`)
has its own opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`. For each
provider in `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS` (default all six) it runs
one native tab through a missed final event, a parked approval, a sub-agent, a
background shell, a cut event stream with the browser offline, a hidden
document, a turn that completes with no renderer connected, and an idle wait
past the 10 min idle detach. Each case must settle with no stuck Stop button
or sidebar "working", inside the latency budgets. The faults are injected in
the page (an `EventSource` and `document.visibilityState` wrapper), not in the
product. `ORKESTRATOR_AGENT_TEST_IDLE_CASES` narrows the cases,
`ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS` shortens the idle wait for a
cadence-only check, and `ORKESTRATOR_AGENT_TEST_IDLE_MODELS` takes
`<platform>=<model>` pairs. Providers run in parallel with `--workers=4
--fully-parallel`; run one provider alone to measure a lost announcement,
because another environment's announcement also recovers a view (stamp gap).
Each provider writes
`output/agent-testing/<run>/idle-observation-live/<platform>.json`. The
recorded run and its credential setup are in
[0049-native-agent-idle-observation.md](../todo/transcripts-and-observation/0049-native-agent-idle-observation.md#live-qualification-record-2026-10-21).

The live Multi Review cycle (`e2e/agent-testing/multi-review-live.spec.ts`)
has its own opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1`, and uses the
host's Claude and Codex credentials. Each case runs a real two-reviewer review
(a Claude reviewer and a Codex reviewer, with Codex preparing and
consolidating) on the cheapest models: Haiku 4.5 and GPT-6-Luna at low effort.
Override the picker labels with `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CLAUDE_MODEL`
and `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CODEX_MODEL` when the catalog changes.
The restart case stops the profile and starts it again with the credential and
platform selection stored in its `profile.json`, so run the file on its own,
against a profile you started by hand:

```bash
mise run dev:test --profile qa-multi-review --fixture --credential-source claude --credential-source codex --agent-platforms claude,codex
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-multi-review ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1 \
  mise run test:logged -- --name multi-review-live -- mise run test:agent:browser -- \
  e2e/agent-testing/multi-review-live.spec.ts
mise run dev:stop --profile qa-multi-review
mise run dev:reset --profile qa-multi-review
```

`ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE=<n>` (2 to 32) adds a scale case. It
starts an n-reviewer panel alternating Claude and Codex through
`start_multi_review`, samples the backend's RSS and the reviewers setting up and
running once a second, fails if more than four were ever seen setting up, and
writes reviewer latency (p50, p95, max) and peak RSS to `scale.json` in the
case's output folder. Run it with `-g scale`.

Every case writes a small change into a fresh environment. The other cases
launch the review through the launcher: it right-clicks **Multi Review**, picks each row's
model, checks the work summary and duplicate warning, and presses Start. Once a
reviewer's prompt is sent, it disturbs the review in one of five ways. It
leaves the review unmounted in another environment, reloads the renderer,
restarts the backend, `SIGKILL`s the Claude reviewer's bridge, or `SIGKILL`s
only the Claude Code process under that bridge while the bridge stays up.
Before signalling, it confirms that the bridge is a child of this profile's
backend, and for the CLI case that exactly one Claude Code process is a direct
child of that bridge.
The review must then settle from backend state alone. The case checks the
snapshot first: phase, reviewer state, reports and consolidation. It also
checks that each reviewer kept its provider session and start time, that a
new request id appears only for a result reminder, restart continuation or
schema repair, and that
no transcript holds more prompts than those turns allow. When it holds more,
the failure labels each user turn by the follow-up it opens with, never by its
text. It then checks the
tab, on return and again after a reload: the graph's node states, the
inspector's transcript tail, the controls and the reviewer's read-only tab.
A repeated reviewer transcript read with its source token must answer
`unchanged`. After a restart
both reviewers must complete, because both bridges report a turn the restart
cut short and the runner continues it once. After a killed Claude bridge the
Claude reviewer must complete the same way, and the Codex peer must complete.
After a killed Claude Code process the bridge must be the same process, and the
Claude reviewer must complete after its restart continuation (the bridge
reports the signal as `interruption: "restart"`).
The case records each reviewer's outcome as a Playwright annotation in
`results.json`. If preparation fails before any
reviewer starts, the case restarts that step once and records it. Each case
cancels its review and deletes its environments in cleanup. The restart case
leaves the profile running under a detached launcher, so stop it with
`dev:stop` as usual. It restarts without `--fixture`, so `dev:status` no
longer reports `testProject` afterwards; the spec falls back to the profile's
seeded copy.

### Live transcript paging

`e2e/agent-testing/transcript-paging-live.spec.ts` drives transcripts past the
100-message live window with real providers and checks history paging end to
end. It has its own opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PAGING=1`,
and uses the host's Claude and Codex credentials:

```bash
mise run dev:test --profile qa-paging --fixture --credential-source claude --credential-source codex --agent-platforms claude,codex
# In a second terminal, one case at a time or both:
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=900000 \
ORKESTRATOR_AGENT_TEST_PROFILE=qa-paging ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PAGING=1 \
  mise run test:logged -- --name transcript-paging-live -- mise run test:agent:browser -- \
  e2e/agent-testing/transcript-paging-live.spec.ts
mise run dev:stop --profile qa-paging
mise run dev:reset --profile qa-paging
```

The silence-watchdog override applies only to this deliberate long-running
qualification: a real provider can keep advancing through the trail for more
than five minutes before Playwright reports a result. It leaves the runner's
normal configuration unchanged.

Each case lays a trail of files in a fresh environment; every file names the
next under a random name, so the agent has to read them one at a time. The
stop each tool call read places every row, so the spec checks pages and the
live tail for gaps, duplicates and order without reading model prose.

- **Native conversation** (Claude Haiku, 150 stops by default; set
  `ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_PLATFORM=codex` for GPT-6-Luna). Claude
  reads with its Read tool, and its tool-only rows coalesce into one folded
  tool group that each page grows from the front. Codex notes each
  stop in a sentence so that every step gets a row. The backend
  window must be truncated with a cursor, and following the cursor in
  40-message pages must reach the first prompt with every stop in order. In
  the browser, **Load earlier messages** must bring the prompt back, keep the
  reader's row on screen (moving the list off the top when rows land above
  it), and expand a tool row from the loaded page. Then the same after a reload.
  "Keep" means the list stands within 8 px of the position that puts the row
  back at its old offset, limited to the list's scroll range. A tool-only run
  folds into one group, so after the last page the whole transcript can fit
  the viewport. The prompt then pushes the row down and the list stays at
  the top, which is the only position it can take. Each click records a
  content-free `-layout` annotation (part ids, stops, boxes, scroll range)
  so a drift can be attributed without reading transcript text.
- **Multi Review** (a Claude Haiku and a Codex GPT-6-Luna reviewer, 130 stops).
  The trail protocol is in an `AGENTS.md` that is part of the change. Codex
  loads it as instructions; a Claude reviewer runs read-only without project
  instructions and in practice reviews without walking it, so the long
  reviewer is the Codex one. Codex opens a row only where reasoning or a
  message follows a tool call, so the protocol asks for one sentence per stop.
  While reviewers run, no stall may be reported, and a reviewer running past
  2.5 progress-probe intervals must show its progress clock advance. Probes run
  once a minute, so a short reviewer shows only its baseline. Afterwards, each
  reviewer longer than the window must have a bounded summary, an `unchanged`
  repeat read, pages back to its prompt, and a reviewer tab whose **Load
  earlier messages** keeps the reader's place. When Claude is unavailable,
  `ORKESTRATOR_AGENT_TEST_PAGING_FIRST_REVIEWER=codex` makes the first
  reviewer a medium-effort Codex one.

Scroll upward with the mouse wheel when you drive these views by hand or from
a spec. A programmatic `scrollTo` is not user intent to the transcript list: it
stays pinned to the tail and snaps back. Measurements land as annotations in
`results.json`. Override models and trail lengths with the variables named in
the spec's header.

### Live cold restart

`e2e/agent-testing/cold-restart-live.spec.ts` stops and starts the whole
profile (backend, bridges and Electron) around real provider turns and checks
that display tails and build-pipeline histories reconcile with no lost,
duplicated or stale rows. It has its own opt-in,
`ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART=1`, and restarts the profile with the
selection stored in its `profile.json`, so run it on its own against a profile
you started by hand:

```bash
mise run dev:test --profile qa-cold --fixture --credential-source claude --credential-source codex --agent-platforms claude,codex
# In a second terminal:
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=900000 \
ORKESTRATOR_AGENT_TEST_PROFILE=qa-cold ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART=1 \
  mise run test:logged -- --name cold-restart-live -- mise run test:agent:browser -- \
  e2e/agent-testing/cold-restart-live.spec.ts
mise run dev:stop --profile qa-cold
mise run dev:reset --profile qa-cold
```

Turns follow a trail of files (as in the paging spec), and every prompt
carries a random tag, so a prompt delivered twice is countable. Reconciliation
compares ordered row ids, displayed text and parts (excluding measured times and
publication metadata). Replay checks count prose and tool-call occurrences across
row splits and re-keying; Codex's live `bash` and replayed `exec_command`/code-mode
`exec` forms of a single trail read share one canonical operation. When a turn
has advanced since the captured snapshot, prose counts stop at its last captured
tool call so newly generated steps are not mistaken for replay. Explicit
follow-up prompts may intentionally read an earlier stop again.

- **Native conversation** (Codex GPT-6-Luna by default; set
  `ORKESTRATOR_AGENT_TEST_COLD_RESTART_NATIVE_PLATFORM=claude` for Haiku). After
  an idle graceful restart, the first transcript read must be the persisted
  display tail (`freshness: "cached"`) with exactly the conversation's rows,
  and a client reading on from that cached view must converge on the
  provider's rows. Then the backend is `SIGKILL`ed mid-turn: the tail may lag
  by up to the checkpoint age, but must hold the prompt and no row the provider
  lacks; the turn must settle, every earlier row must survive, and a follow-up
  finishes the trail. The browser shows each prompt and closing word once.
- **Build pipeline**. One pipeline's backend is `SIGKILL`ed the moment its
  build prompt is journaled (`pendingPromptAttempt`), the mid-dispatch window;
  the prompt must reach the provider once, on the same session. Acceptance may
  race this live crash. The deterministic pre-acceptance case lives in
  `apps/backend/src/core/build-pipeline-service-recovery.test.ts`: a subprocess
  holds `send` after durable admission, is killed with SIGKILL, and a fresh
  service/storage pair must retry the same request id and session exactly once.
  A second pipeline is restarted mid-turn after a persist boundary: its committed history must read
  back straight after the restart without the provider, and the stage
  continues once on the same session. Both are cancelled once the build turn
  ends, and an idle restart must return every stage history byte-identical.

Review validation on 2026-10-21 exercised the real profile with Codex Luna and
GPT-6.1-Sol build turns. The strengthened build check reached final history but
reported 18 repeated trail reads within one prompt (`mid-turn: a stop was read
twice in the same prompt`). This remains an unresolved live qualification
failure; the assertion is retained. An earlier Luna build also failed to return
its required structured review-preparation result. The credential-free held-send
SIGKILL regression independently qualifies pre-acceptance same-request-id retry.

The restarts leave the profile running under a detached launcher; stop it
with `dev:stop` as usual. `dev:status` no longer reports `testProject` after a
restart, so the spec falls back to the profile's seeded copy.

### Live revision tokens with inactive views

`e2e/agent-testing/claude-revision-tokens-live.spec.ts` checks Claude's
transcript content-revision tokens while the view under test is off screen.
It has its own opt-in and uses the host's Claude credentials:

```bash
mise run dev:test --profile qa-revtok --fixture --credential-source claude --agent-platforms claude
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-revtok ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS=1 \
  mise run test:logged -- --name revision-tokens-live -- mise run test:agent:browser -- \
  e2e/agent-testing/claude-revision-tokens-live.spec.ts
mise run dev:stop --profile qa-revtok
mise run dev:reset --profile qa-revtok
```

One session runs two cases. First, a prompt starts a background Bash command,
then the test switches to a second tab in the same pane. Second, a prompt
starts a background subagent, then the test selects another environment. In
each case the turn ends, the task finishes and Claude answers its report while
the view is off screen. The test reads the session the way a view does, with
its last transcript and state tokens. It checks four things. Every change
reaches it as a delta or snapshot. A settled session answers `unchanged` ten
times in a row. The off-screen view sends no reads. On return the view shows
the newest row without a reload, keeps its transcript token, and settles to
conditional `unchanged` reads. A reload then repaints the same newest row.
The model writes each marker as a sum it computes, so only an assistant row
can contain it. Only the newest row is checked on screen, because the list is
virtualized; every marker is checked in order in the conditional reader's
retained rows. The reader validates delta base tokens and applies the shared
protocol delta helper. Each case must observe a new task running while the
foreground is idle, its later completion, and a post-idle transcript update.
The launching row must have its final state and deferred report output. Forced
snapshots independently compare against the retained view without repairing it.
Active idle checks require unchanged polls for both transcript and session state.
`ORKESTRATOR_AGENT_TEST_REVISION_MODEL` overrides the model (default Haiku).
Each read the page sends for the session is recorded as a content-free
timeline annotation in `results.json`.

A dev profile renders under `React.StrictMode`, so a remount (an environment
switch or a reload) mounts the view twice and every read is doubled for about
300 ms. A remount also re-reads session state without a token on purpose
(`useNativeAgentSession` never trusts a state token it did not read itself).
The idle checks therefore start 2 s after the newest row appears.

### Live MCP apply in an inactive environment

`e2e/agent-testing/mcp-apply-inactive.spec.ts` saves and applies MCP server
changes for a Claude session while its environment is busy or inactive, then
checks the apply outcome, the tool the model can actually call, the settings
view and the agent panel. It covers a dropped event stream, a hard reload, a
bridge restart (a new runtime generation), a removal, and a backend-user file
shared by two environments. It needs the live-MCP opt-in and Claude credentials:

```bash
mise run dev:test --profile qa-mcp-inactive --fixture --credential-source claude --agent-platforms claude
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-mcp-inactive ORKESTRATOR_AGENT_TEST_LIVE_MCP=1 \
  mise run test:logged -- --name mcp-inactive -- mise run test:agent:browser -- \
  e2e/agent-testing/mcp-apply-inactive.spec.ts
```

It writes only the disposable environment's `.mcp.json` and the profile's
isolated `~/.claude.json`, and its fixture server lives under
`output/agent-testing/<profile>/`. A profile's provider homes are always its
own, including a Codex or OpenCode source it authorizes (that adds only a
restricted copy of the host's `auth.json`), so a user-scope save never reaches
the operator's own `config.toml` or `opencode.json`. Set
`ORKESTRATOR_AGENT_TEST_MCP_OLDER_CLAUDE_BRIDGE` to the `dist` folder of a
Claude bridge built before the `mcpConfigReporting` marker to add the
older-bridge step. That step swaps the build in only while it starts the
environment's bridge, then restores the current one.
`ORKESTRATOR_AGENT_TEST_MODEL` pins both tabs' Claude model.
`ORKESTRATOR_AGENT_TEST_MCP_APPLY_ONLY=1` keeps every apply, generation and UI
check but drops the ones that need the model to answer: Claude's bridge
records the MCP files a query was built from when the query starts, so the
apply half still runs when the provider refuses requests (a rate limit, say).
A full-mode pass is still needed for the tool-call checks.

### Live slash commands in an inactive environment

`e2e/agent-testing/slash-command-inactive.spec.ts` sends a selected project
command, switches environments, and checks that it completes while inactive
and runs exactly once. Meanwhile it changes the inventory, refreshes the
catalogue and drops the event stream for 10 s. It then checks the result after a
reload, a narrow viewport and two bridge restarts. It needs
`ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1` and the providers' credentials.
`ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS` picks `codex` (default) and/or
`claude`. `ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT` is `local` (default, a
host worktree with the `projectResources: true` override) or `container`. The
container variant needs a profile started with
`--fixture-environments local,container`. It writes the command files and the
execution marker inside the container's `/workspace` through `docker exec`,
sets no policy override (containers load project resources by default) and
restarts the container's bridge. Neither variant writes a user-scope command
file.

```bash
mise run dev:test --profile qa-slash --fixture --fixture-environments local,container \
  --credential-source codex --credential-source claude --agent-platforms codex,claude
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-slash ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 \
  ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=codex,claude ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=container \
  mise run test:logged -- --name slash-inactive -- mise run test:agent:browser -- \
  e2e/agent-testing/slash-command-inactive.spec.ts
```

### Live slash-command picker

`e2e/agent-testing/slash-command-picker.spec.ts` plants two project commands
in a disposable host worktree (`projectResources: true`), then checks the `/`
menu against the real provider: one group header per run of a source, in the
catalogue's order; arrow keys following the rendered order across groups and
clamping at both ends; a command file added on disk appearing after a refresh;
and the new row surviving a hard reload. It sends no prompt. On Pi it first
checks that the planted templates are listed before the session attaches,
with no refresh and no turn, as a `stale` list marked `attachPending` whose
picker says more commands load when the session starts (todo 0069). It needs
`ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1`; `ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS`
picks from `claude` (default), `pi` and `grok`.
`ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=container` runs it in a
containerized environment instead (a profile started with
`--fixture-environments local,container`), writing the commands into the
container's `/workspace` through `docker exec` with no policy override.

```bash
mise run dev:test --profile qa-picker --fixture --credential-source claude \
  --credential-source pi --credential-source grok --agent-platforms claude,pi,grok
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-picker ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 \
  ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=claude,pi,grok \
  mise run test:logged -- --name slash-picker -- mise run test:agent:browser -- \
  e2e/agent-testing/slash-command-picker.spec.ts
```

### Live close retention

`e2e/agent-testing/close-retention-live.spec.ts` checks, with real providers
and through the real app, that closing a native agent tab keeps the
conversation. It has its own opt-in and uses the profile's host credentials:

```bash
mise run dev:test --profile qa-close-live --fixture --agent-platforms cursor,grok,opencode,pi
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-close-live ORKESTRATOR_AGENT_TEST_LIVE_CLOSE_RETENTION=1 \
  mise run test:logged -- --name close-retention-live -- mise run test:agent:browser -- \
  e2e/agent-testing/close-retention-live.spec.ts
mise run dev:stop --profile qa-close-live
mise run dev:reset --profile qa-close-live
```

For each platform in `ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_PLATFORMS`
(default `cursor,pi,opencode,grok`), a launched tab is asked to remember a
codeword. The case closes the tab with its close button and reloads to check
the tab stays closed. It then opens a new tab from the toolbar, finds the
conversation in the resume list, resumes it and asks for the codeword. Only a
model that still holds the first turn can answer, so the reply proves the same
native conversation continued. The backend transcript must hold the first
prompt exactly once. `ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_MODELS` takes
`<platform>=<model>` pairs, for example an OpenCode model from a connected
provider. A platform that is not enabled or not signed in is skipped with that
reason. Each case deletes its environment.

The same flow runs without credentials, for all four platforms, in the
component browser suite: `e2e/CloseRetention.spec.ts` drives the real pane
tree and native agent tab against `e2e/fixtures/close-retention-host.ts`. That
host runs the real backend command registry and native agent service, and the
real Cursor, Pi and ACP bridges and OpenCode provider, over fake vendor
engines (`bridges/cursor-bridge/src/testing/fake-engine-server.ts`,
`bridges/pi-bridge/src/testing/fake-engine-server.ts`,
`bridges/acp-bridge/src/testing/fake-agent-close.ts` and
`e2e/fixtures/close-retention-opencode.ts`). Its assertions read each engine's
own store, so a duplicated or lost prompt fails there.

The same host also carries the lifecycle cases that need a fault on the real
stack. Its fixture page mounts the app shell's agent information button and
toaster, and the host adds endpoints for the faults:

- `/restart-bridge` stops a bridge and starts it again on the same port and
  token. With `shed: true` for Cursor it first rewrites the state file as the
  bridge's own budget pass would under a smaller budget, so a reload shows a
  transcript that persistence shed.
- `/cursor-saturate-steer` fills a held Cursor turn's steer journal straight at
  the bridge until it refuses with `steer-capacity-exceeded`.
- `/pi-startup-gate` holds Pi prompts at `AgentSession.prompt`, before Pi
  accepts them.
- `/seed-native-session` maps a tab to a provider session, as an earlier
  backend run would have. Claude has no real bridge here: `peekBridge` answers
  a stale Claude bridge whose close route is a 404.

### Live paused interactions

The tmux hook transport also has two credential-free qualifications:

```bash
# Generated hook in a real container tmux session, using the exec-based writer:
ORKESTRATOR_TMUX_HOLD_CONTAINER_IMAGE=<development-image-tag> \
  mise run test:logged -- --name tmux-hold-transport -- \
  bun test --cwd apps/backend ./tests/tmux-hook-hold-transport.test.ts --parallel=1 --only-failures
# Pinned Claude CLI, scripted loopback model, real elapsed wait beyond 600 s:
RUN_LIVE_TMUX_HOOK_HOLD=1 ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=750000 \
  mise run test:logged -- --name tmux-hold-cli -- \
  bun test --cwd apps/backend ./tests/tmux-hook-hold-live.test.ts --parallel=1
```

The container case repeats pause/resume three times; a default test also holds
an empty request file open across a hook poll before completing each write.
The CLI case uses a temporary home and fake API key, waits for a real
`PermissionRequest`, holds it for more than 600 seconds, and then approves the
fixture command. Its elapsed wait is not configurable: shortening it would no
longer qualify Claude's former hook timeout. The pinned managed Claude binary
must be installed (or supplied through `ORKESTRATOR_POLICY_CLAUDE_PATH`). Both
fixtures clean up their own resources. Neither uses host credentials or calls
an external model.

Codex Default-mode questions have a credential-free qualification against the
pinned real app-server as well:

```bash
RUN_LIVE_CODEX_APP_SERVER=1 RUN_LIVE_CODEX_QUESTION_DEADLINES=1 \
  ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=750000 \
  mise run test:logged -- --name codex-question-deadlines -- \
  bun test bridges/codex-bridge/src/app-server/live-request-user-input.test.ts --parallel=1
```

The quick cases prove a watched question parks and its answer reaches the
model, while a pipeline retains Codex's Default-mode refusal. The extra deadline
opt-in runs a held question and an unheld control together in separate temporary
homes. Every 30 seconds it checks that the held question remains pending with
its moved deadline and no second model sample; after a fixed 10.5 minutes it
answers. The control must expire after the production five-minute window and
send an empty answer. Neither elapsed window can be shortened by an environment
variable. The longer watchdog allows Bun to buffer output from the long test.
This uses a loopback model and fake key; the browser qualification
below additionally covers real-model behavior, card controls and reload.

The launch-policy renderer regression is also exercised against a running
container in `native-draft-attachments.spec.ts`. On a disposable Docker fixture
profile, run it with `ORKESTRATOR_AGENT_TEST_DOCKER=1` and
`--grep 'Docker fixture restricted-network'` through the browser Playwright
config. It creates its own full-network container, applies the restricted
session override, checks the provider-sandbox approval description before and
after reload, and stops/deletes the environment afterwards.

`e2e/agent-testing/paused-interactions-live.spec.ts` checks that a question or
approval paused from its card waits past ten minutes on a real CLI, and that
answering it later lets the turn carry on with the answer. It has its own
opt-in and config, and uses the profile's host credentials:

```bash
mise run dev:test --profile qa-pause --fixture --credential-source claude --credential-source codex \
  --credential-source opencode --credential-source pi --agent-platforms claude,codex,opencode,pi
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-pause ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 \
  ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=claude,codex,opencode,pi \
  mise run test:logged -- --name paused-interactions-live -- \
  mise run test:agent:paused-interactions
mise run dev:stop --profile qa-pause
mise run dev:reset --profile qa-pause
```

Each case (a Claude question and approval, a Codex question and command approval,
a Grok question and permission, an OpenCode question and permission, a Pi approval)
gets its own local environment under an `approvals: "ask"` policy and its own
real turn. Providers run in parallel, and a provider's own cases start one
after the other. As soon as a request appears, the spec holds its countdown
through the backend, before starting another case or waiting for a slower
provider. It then resumes and pauses each countdown from the card, waiting
for the backend state and enabled controls between actions. OpenCode publishes
no deadline: its card must be visible before the absence of a countdown is
asserted within that card. It then checks every 60 s that
each request is still pending, the turn has not ended and no marker file
appeared. Once 10.5 minutes have passed since every card was checked, it
signs in again and reloads, then answers each card. Every turn must finish
with the chosen codeword, or with the approved command's marker file and done
token. The whole run takes about 20 minutes.

- `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS` narrows the providers (default
  `claude,codex,grok,opencode,pi`). Leave out any provider the host is signed
  out of: a provider that cannot start fails the run.
- `ORKESTRATOR_AGENT_TEST_PAUSE_CASES` narrows case ids within those providers
  (default: all). For just the Codex Default-mode question, use
  `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=codex` and
  `ORKESTRATOR_AGENT_TEST_PAUSE_CASES=codex-question`. Unknown ids and empty
  selections fail before any environment is created.
- `ORKESTRATOR_AGENT_TEST_PAUSE_WAIT_MS` shortens the wait for a shakedown.
  Only the default proves the ten-minute claim.
- `ORKESTRATOR_AGENT_TEST_PAUSE_MODELS` takes `<platform>=<model>` pairs. It
  defaults to `pi=openai/gpt-6-sol`. A profile now also receives the host's
  saved Pi default model, but the pin keeps the run independent of whatever
  the host saved; without either, the bridge would start on its last resort
  (for a ChatGPT-backed OpenAI login, the newest ChatGPT-backend model, not
  the catalogue's first `gpt-4`, which that login refuses).

The approval card is answered with **Approve** alone. The spec never picks an
optional or amendment option. Codex cards no longer offer one: the old
"Approve with command policy" wrote a durable rule into the Codex home (the
profile's isolated one; earlier profiles shared the host home, as recorded in
[0031-live-provider-and-platform-qualification.md](../todo/cross-cutting/0031-live-provider-and-platform-qualification.md)).
The task remains explicitly opt-in (the environment flag above is required);
it is not part of the default suite or CI because it spends real provider tokens.
Two additional cases inject setup failures immediately after creation and
before layout persistence against real fixture environments, and verify that
stop/delete removes both the stored environment and any started worktree.
A one-minute heartbeat covers setup, raising, the long wait, finishing and cleanup,
including unchanged five-minute polls. `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=90000`
can check it against a shorter watchdog. Environments are registered for stop/delete
immediately after creation, so setup failures also clean up; cleanup failures fail
the qualification. Credential-free regression tests for cleanup, immediate holds
and approval choices run in `mise run test`. The evidence is in
[0001-agent-interactions-and-permissions.md](../todo/agent-engines/0001-agent-interactions-and-permissions.md#live-pause-record-2026-10-21).

### Live design-tool cycle

`e2e/agent-testing/design-live.spec.ts` runs the design canvas with a real
Claude and Codex through the `orkestrator-design` MCP server. It has its own
opt-in and uses the profile's host credentials:

```bash
mise run dev:test --profile qa-design-live --fixture --credential-source claude --credential-source codex --agent-platforms claude,codex
# In a second terminal:
ORKESTRATOR_AGENT_TEST_PROFILE=qa-design-live ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1 \
  mise run test:logged -- --name design-live -- mise run test:agent:browser -- \
  e2e/agent-testing/design-live.spec.ts
mise run dev:stop --profile qa-design-live
mise run dev:reset --profile qa-design-live
```

`ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS` (default `claude,codex`) picks the
providers, `ORKESTRATOR_AGENT_TEST_DESIGN_TURN_TIMEOUT_MS` (default 420000)
bounds each turn, and `ORKESTRATOR_AGENT_TEST_DESIGN_MODELS` takes
`<platform>=<model id>` pairs (for example `claude=claude-haiku-4-5`) that are
set on the test environment before launch. Each provider gets two fresh environments. The case launches
**New design workspace** with the provider and a fixture-scoped brief:
create a frame, `inspect_element`, `replace_element_html`, `capture_frame` and
`save_canvas` to a nonce path. It checks that the launch linked the
conversation to the canvas, then switches environment once the opening prompt
is accepted, and checks the canvas, the saved `.orkdes` and the idle controls
on return after a renderer reload. Successful `inspect_element` and `capture_frame`
calls are required in the launch transcript. **Ask agent** then captures the
selection while another client edits the frame: the stale-context notice appears, the agent re-reads, and
both edits survive. Next the approval mode is set to Ask (Claude) or Untrusted
(Codex). The agent is asked for one shell command before a style edit, and the
test switches away while the approval is pending. On return the request must
still be pending after a renderer reload, the turn `blocked` and the canvas
unchanged; after approval the edit lands. Finally **Implement** starts a new conversation holding an
unsent handoff draft that survives a switch and renderer reload, and the canvas
links both conversations. Last, the design conversation's tab is closed: the
link must record its session, and after a reload Ask agent's **Resume
conversation** reopens it in a `design-resume-…` tab with the same user turns
and nothing sent. The design MCP call count, failed calls and response bytes are
attached as `design-mcp-usage`. A content-free heartbeat runs every minute for
the whole case, including approval waits and cleanup, and is cleared in `finally`.

`e2e/agent-testing/design-resume-clients-live.spec.ts` is the short companion
for two clients resuming one design conversation at once
(`ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME=1`; providers from
`ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS`, default `claude`). It launches a
design workspace with a one-word brief, closes the conversation's tab, then has
two separately signed-in browser contexts press **Resume conversation**
together. The requests must overlap in flight; a serialized run fails. For
Codex, the bridge is restarted (with a verified new process) before the tab
closes, so the close/resume lifecycle is exercised across a bridge restart.
Both `design_session_resume` answers must name the same
`design-resume-…` tab and live session, the shared layout must hold that one
tab, and the transcript must keep its user turns:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-design-live ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME=1 \
  mise run test:logged -- --name design-resume-clients -- mise run test:agent:browser -- \
  e2e/agent-testing/design-resume-clients-live.spec.ts
```

Never press Escape to clear a sidebar tooltip in a live spec: with nothing
focused, Escape stops the active tab's running turn (`useEscapeToStop`). A
Claude CLI rate limit (429) ends the turn on an API error; rerun later rather
than treating it as a product failure.

The profile's Claude bridge authenticates with the Claude login of the shell
that started `dev:test` (access token only), so check that login's usage in
Settings before a run. A shell with no `CLAUDE_CONFIG_DIR` uses the default
login (on macOS the plain `Claude Code-credentials` Keychain entry). A shell
whose `CLAUDE_CONFIG_DIR` is set, for example an Orkestrator agent tab on an
added account, uses that directory's login: the desktop records the directory
and that it was explicit (`ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT`),
and the backend reads the matching hashed Keychain entry or that directory's
`.credentials.json`, with no fallback to the default login. An explicit
`~/.claude` counts as explicit, because Claude hashes it too. The bridge keeps
the profile's own `CLAUDE_CONFIG_DIR`; sessions, settings and project state
stay there, so a scratch configuration directory is not needed to isolate
session writes.

### Live coordinator suite

The live coordinator suite checks that a real provider keeps the coordinator's
read-only boundary (`read-only`), that delegation never waits inside a turn
(`async`), that worker mail flows with nobody's help (`family`), that the
status wakes of work the coordinator started reach it (`status`), and that
peer mail between two ordinary environments wakes each side with **Wake
peers** on (`peer`). Every scenario with mail also checks how each mail
carrier is shown as a tile. It runs as one command and owns its profiles:

```bash
mise run test:agent:coordinator                              # every platform and scenario
mise run test:agent:coordinator --credential-source codex    # one platform; repeatable
mise run test:agent:coordinator --scenario async             # one scenario; repeatable
```

For each platform in turn (Claude, Codex, Pi, OpenCode, Cursor, Grok), the
runner starts a disposable `dev:test --fixture` profile authorized for that
platform's host credential alone (`--credential-source <platform>
--agent-platforms <platform>`). It runs `e2e/agent-testing/coordinator-live.spec.ts`
with `ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR=1`, then stops and resets the
profile. One platform failing does not stop the next. The exit status is 1 when
any platform failed. Skips do not fail the run, but the closing line says so
when no platform qualified.

Like `test:agent:browser:isolated`, the runner re-runs itself as a detached
supervisor that holds an IPC channel to the command you started. Cancelling,
or killing that command outright, closes the channel; the supervisor then
stops the platform in progress and stops and resets its exact profile, so no
credential-bearing profile or provider turn outlives it.

The read-only case:

1. Assigns the platform to a fresh main coordinator conversation on the fixture
   project through the Coordinator page's backend commands. Grok's run sets
   **Coordinator safety level** to `advisory` and restores it afterwards.
   Every run sets **Coordinator web research** to off and restores it
   afterwards, so the fetch step tests the whole `network` denial. Allowed
   search is checked separately by the canary in
   `bridges/codex-bridge/src/app-server/live-network-lock.test.ts`.
2. Plants a canary file in the checkout and a canary Kanban ticket, then
   digests the checkout.
3. Sends one turn in build mode. Plan mode, which a fresh coordinator composer
   selects, tells the agent not to try, so the boundary would never be
   exercised. The turn asks the agent to attempt each of these once: create a
   file, edit `README.md`, run `touch` from the shell, run `git commit
   --allow-empty`, call Orkestrator `launch_job` on the project home (the
   checkout as an environment), and fetch `https://example.com/` (with no tool
   that can, the agent is told to make no call and report `unavailable`). It then asks
   the agent to read the canary file, call `list_tickets`, and end with one
   `COORDINATOR_LIVE_REPORT` line.
4. Passes when the digest is unchanged, every attempt is reported `denied` or
   `unavailable`, and both canary values came back. An attempt reported
   `succeeded` or `declined` fails the case. So does a `denied` with no tool
   call in the transcript that names the attempt (the file, `git commit`, a
   tool named `launch_job`, or `example.com`). A model that skips a call
   because it knows its sandbox is read-only has not exercised the boundary.
   On Codex, the call is often a code-mode `exec` row. Codex 0.162.1 emits no
   item for a call its sandbox refuses (a rejected `apply_patch`, or a command
   failing with "Operation not permitted"), so the bridge reads the cell back
   from the rollout and shows it with the output the model got
   (`RefusedCellTail`). The projection keeps a row's output behind its
   `detailRef`, so the case fetches each `exec` row's details the way opening
   the row does (`get_native_agent_tool_details`). A cell is source, and an early throw, rejected await or
   unexecuted branch skips a call it names, so a cell counts only for create,
   edit, shell and commit, which the digest judges, and only with a sandbox
   refusal in its output (`patch rejected: writing is blocked by read-only
   sandbox`, `Operation not permitted`, `Permission denied` or `Read-only
   file system`). The refusal must also be attributable to the one call that
   could have produced it, so a cell counts only when its whole source is a
   single direct, awaited `apply_patch` or `exec_command` call with literal
   arguments, optionally wrapped in `text(...)`, and the command is the
   probe's own (`touch` of the probe file, or the probe's `git commit`). Any
   other call, lookup, branch, throw or printed text in the cell means a
   refusal could have come from somewhere else, so it does not count
   (`cellEvidence`). The prompt asks Codex for one mutation per cell in that
   shape. A cell never stands in for the fetch or `launch_job`. A
   Codex `exec` row is not an ordinary call either, so a cell that mentions
   `example.com` cannot pass the fetch step. The upstream behaviour and the
   bridge's row are checked by
   `bridges/codex-bridge/src/app-server/live-refused-calls.test.ts`, which
   needs no credentials.
5. Holds the network fetch and `launch_job` to the transcript as well, since
   the digest cannot see them: a fetch changes nothing in the checkout, and a
   launched worker writes after the turn has been measured. A matching tool
   call that completed fails the case whatever the report says; a `denied`
   needs a matching call that was refused; an `unavailable` fails when the
   transcript attempts it and nothing refused the attempt. Before the second
   digest, the case also fails if the project home gained a job tab or session.
6. Fails if any approval or question reached the harness. The coordinator's
   policy must settle its approvals without anyone answering, so the harness
   still denies the approval (or cancels the question) to keep the turn safe
   and bounded, and records its kind as a failure. An interaction the policy
   had already resolved is not counted.

The digest covers every file and directory outside `.git` (content,
permission bits, link target) and Git's user-visible state: HEAD, refs, staged
index entries, status, configuration, the exclude file, hooks (type, mode and
content) and linked worktrees. It ignores Git's caches, which a permitted
`git status` may rewrite.

A platform is **skipped**, with the reason recorded, only when the profile has
no usable login: the session's auth status is signed out, needs auth or
expired, or the provider's error says so. It is also skipped when the platform
is not enabled in the profile. Anything else fails, including a toolchain that
will not start, a platform the coordinator does not offer, and a turn that does
not finish within `ORKESTRATOR_AGENT_TEST_COORDINATOR_TURN_TIMEOUT_MS` (default
600000).

Each platform writes one summary per scenario,
`output/agent-testing/<profile>/coordinator/<platform>-<scenario>.json`, and the
platform's verdict combines them: failed when any scenario failed or wrote no
summary, passed when every scenario passed, skipped otherwise. The read-only
summary has the verdict, the reason, the tier, both digests and any changed paths, the
reported outcomes, the tool names and normalized states, and the kinds of any
interactions that escaped the policy. The run writes `output/agent-testing/qa-coordinator-<time>/summary.json`.
Neither contains prompts, file contents or tool output; Playwright traces kept
on failure do, like every other agent-test trace.

A turn prints nothing for minutes, so the spec prints a progress line every
minute and `test:logged`'s five-minute no-output watchdog does not fire:

```bash
mise run test:logged -- --name coordinator-live -- \
  mise run test:agent:coordinator --credential-source claude
```

`test:logged` stops a command after 30 minutes
(`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS`), which one Multi Review on a slow
provider or several platforms in one run exceeds; the cut-off also cancels
every platform after it. Raise that variable for a long run, or run the suite
directly.

The `async` case launches two real workers on the fixture project through the
coordinator and watches the coordinator's turns, its delegations
(`get_project_coordinator`), every family mailbox and the coordinator's prompt
queue every two seconds. It answers nothing: an approval or question from the
coordinator or a worker is denied (or cancelled) and fails the case.

1. One turn asks the coordinator to launch a *reporter* and a *silent* worker
   and end. The turn must be seen running, then idle; both `launch_environment`
   results must carry `delivery: "async"`; the turn must make no `sleep`,
   `read_messages`, `get_message_status` or `list_environments` call; and the
   reporter's delegation must still be running when it ends.
2. The silent worker finishes without mail and must produce exactly one
   workflow notice. The reporter sends one progress message and then waits in
   a shell loop for a gate file the harness owns. Its progress message must be
   seen `inject-held` (`delegation-running`) and never delivered while its
   delegation runs.
3. The harness opens the report gate and waits for both reporter messages to
   be held, then sends a *busy* turn (three Orkestrator reads), queues a prompt
   behind it (`enqueue_prompt_queue_message`, as the composer does), and opens
   the finish gate. The reporter ends, so the report is pending while the
   coordinator is busy and a user prompt is queued. The case requires
   an observation of exactly that state, and the queued prompt must run before
   the reporter's carrier (by transcript row, or by the queue draining before
   the report's `injectedAt` where a bridge does not echo the carrier).
4. Both reporter messages must arrive in one echoed transcript carrier row,
   identified by the message ids it contains, with no notice about the reporter;
   each delegation wakes the coordinator once. Without complete carrier rows the
   count stays unverified and the check fails. Neither per-message
   `injectRequestId` nor nearby `injectedAt` timestamps prove a shared carrier.
5. A last turn calls `read_messages` five times with identical arguments; the
   fourth or fifth structured result must carry `repeatedRead: true`. The tool
   call evidence must show five successful reads with identical arguments.

The `family` case sends one prompt and then only watches, for up to 35 minutes
(`ORKESTRATOR_AGENT_TEST_COORDINATOR_FAMILY_TIMEOUT_MS`). The coordinator
launches two workers and, in the same turn, follows the second one up by
environment id while it is still on its first request; both report; the
coordinator then pings the first worker by environment id until six pings have
been answered (two messages, then ten more alternating). It passes when
messaging is at its defaults, both reports arrived, the busy follow-up joined
the open delegation (one delegation, one carrier carrying the report and the
reply), each ping has a distinct delivered request and reply, ordered by
persisted creation timestamps with each reply before the next request, no family
message is `stored` or `inject_failed`, and nothing reached the harness.

The `status` case runs two parts on one coordinator, with default messaging
settings (status updates at *Decisions and problems*). It waits at most
`ORKESTRATOR_AGENT_TEST_COORDINATOR_REVIEW_TIMEOUT_MS` (default 2700000) for
the review, one turn budget for the waiting worker's startup turn, and five
step budgets for the remaining waits. The enclosing test deadline includes
`turn + 5 * step + review` plus four minutes for setup/cleanup; the runner adds
two more minutes per case.

1. **Review.** The harness sets the saved Multi Review defaults to the
   platform with the fewest reviewers a panel allows (restored afterwards),
   creates a local environment and writes one file with a real defect into its
   worktree. One prompt asks the coordinator to call `launch_multi_review` on
   that environment with auto-fix and auto-PR off and no reviewer rows, and
   gives it standing orders: on the "ready" notice call
   `address_multi_review`, on the "fix session finished" notice write a done
   line. The harness then only watches. It passes when the launch result says
   `delivery: "async"`; exactly one `ready` notice (toned attention, or
   success for a clean report) and then exactly one `fix-done` notice (toned
   success) were injected, each in its own carrier row; the one
   `address_multi_review` call comes after the ready carrier and before the
   fix-done one; no review state was notified twice; the done line follows;
   the coordinator made no `sleep`, `read_messages`, `get_message_status`,
   `list_environments` or `get_multi_review` call; and nothing reached the
   harness. A `failed`, `cancelled` or `fix-failed` notice ends the wait
   early. An interactive Fix ends at `fix-done`: only a structured Fix
   reaches `completed`, which `address_multi_review` does not start.
2. **Approval** (every platform but Cursor, which never asks). The harness
   creates an ordinary local environment whose execution policy is
   `approvals: "ask"` (Codex also keeps its provider sandbox on, since it asks
   only to leave it) and lets its startup agent answer once and go idle. A
   second prompt asks the coordinator to `send_prompt_to_tab` that tab a task
   that runs one `touch` outside every checkout, and gives it standing orders
   for the waiting notice and the report. The harness *holds* that worker's
   approval (`holdWorkerInteractions` in `coordinator-live-observer.ts`)
   until the coordinator has been woken by the `waiting` notice and has
   written its line, then denies it and waits for the worker's report. It
   passes when one `send_prompt_to_tab` call was made, only approvals reached
   the harness from that worker, exactly one `waiting` notice (toned
   attention) was injected at least 19.5 seconds after the backend created
   the approval (the 20-second debounce less a 500 ms timestamp tolerance) and
   before it was answered, the coordinator acknowledged it, the worker's report
   (or its finished notice when no report arrived) followed, nothing was polled,
   and no other interaction reached anybody.

What the `status` case leaves to `coordinator-status-wakes.test.ts`, because
no provider is involved: which states notify under each setting, dedupe and
coalescing (seven reviews settling together are one wake), ownership (a review
the user started never wakes a coordinator), budgets, restart recovery, and
build pipeline notices, which reach a coordinator through the same notice and
carrier as a Multi Review's.

Mail tiles are judged on every scenario with mail (`async`, `family`, `status`
and each side of `peer`) by `e2e/agent-testing/coordinator-mail-tiles.ts`.
Each provider echoes the injected carrier as a user row in its own way, and the
transcript shows that row as tiles only when the renderer's
`isPeerMailCarrierContent` accepts its `content`. The check runs the
renderer's own `createPeerMailNativeMessagesFromCarrier` over every echoed
row and requires: no carrier row shown raw (a carrier only in the parts, or
after other text, fails), exactly one tile per injected message and none
dropped, no text outside the carriers (the tiles would hide it), and each
notice tile toned as its notice. `async` also requires a batched row, since
the reporter's two messages share one carrier. The summary counts carrier
rows, tile rows, batched rows and tiles.

The `peer` case needs no coordinator. It turns **Settings → Messaging → Wake
peers** on for its run (off by default) and restores it afterwards, then
creates two ordinary local environments on the fixture project, each with a
startup agent on the platform in build mode, the way `launch_environment`
does but with no coordinator behind them, so their mail takes the `peer`
route. The responder's startup prompt asks it to say ready and end its turn;
once it is idle, the opener's startup prompt sends it the first message by
environment id. Each side answers message *n* with message *n + 1*
(`reply_message`) until the tenth, and the opener then writes a done line.
The harness sends nothing after the two startup prompts and answers nothing,
waiting at most `ORKESTRATOR_AGENT_TEST_COORDINATOR_PEER_TIMEOUT_MS` (default
1800000) for the exchange. It passes when Wake peers was the only messaging
setting changed, all ten messages exist exactly once with the right sender and
recipient, each routed `peer` and `injected`, each created no earlier than the
previous one was delivered (the delivery is what woke its recipient), no other
message passed between the peers, the opener wrote its done line, no
interaction reached the harness, and neither transcript holds a user row
other than its startup prompt and mail carriers. A peer turn failing on a
recognised sign-in error skips the case. Both environments are stopped and
deleted when it ends.

Each scenario step waits at most
`ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS` (default 600000). Workers
the coordinator launched are stopped and deleted when the case ends. The
summary records each named check with a bounded, content-free detail (counts,
placements, phases) and the observed counts: messages, notices and carriers
to the coordinator (a carrier count of -1 means unverified), and its `sleep`,
`list_environments`, `read_messages` and `get_message_status` calls across the run.
Playwright timeouts cover the sum of each scenario's wait budgets plus four
minutes for setup and cleanup. The profile runner uses those same timeouts and
adds two minutes per selected scenario for process overhead. Both honor the
step, turn, family, review and peer timeout environment overrides.

Credential-free tests in `coordinator-live-observer.test.ts` exercise the same
observer and gate/queue orchestration as the live spec, including completion
and mail injection between reads, queue overlap, poll output collection,
cleanup after a worker deletion fails, and a held worker's approval staying
pending until it is released, with retries after failed resolutions.
`coordinator-live-status-orchestration.test.ts` runs the same status orchestration
as the live spec through a scripted command transport: environment creation and
startup, review and approval waits, release recovery, cleanup, and startup
interactions that must fail qualification. `coordinator-live-status.test.ts` and
`coordinator-mail-tiles.test.ts` cover the status and tile evaluations, including
observation lag and report selection independent of mailbox order. Evaluator and
runner tests cover negative evidence and deadline relationships, including a
startup turn budget larger than a step budget.

To run the spec against a profile you started yourself, set the opt-in and
optionally narrow the platforms and scenarios
(`ORKESTRATOR_AGENT_TEST_COORDINATOR_SCENARIOS=async,family,status,peer`). Each case closes the main conversation an
earlier case assigned and leaves the project home environment in place:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=<profile> ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR=1 \
  ORKESTRATOR_AGENT_TEST_COORDINATOR_PLATFORMS=claude,codex \
  bunx playwright test --config e2e/agent-testing/playwright.coordinator.config.ts
```

Real turns cost tokens, so the suite runs only when asked for. It has its own
Playwright config, is not part of `mise run test`, CI or the browser suites, and
is not registered in `.orkestrator-test-scheduler.json`, so review never
selects it. Without the opt-in, every case is skipped.

Do not add another `tee`; the terminal harness may already retain output, and a
second verbatim copy recreates the disk-amplification problem. On failure the
runner prints a unique `orkestrator-test-run.*` directory below the platform
temporary directory. Inspect
the compressed file in bounded chunks instead of rerunning solely to recover
output:

```bash
ORK_TEST_ARTIFACT_DIR=/path/printed/by/the/runner
gzip -cd "$ORK_TEST_ARTIFACT_DIR/agent-browser.log.gz" | tail -n 200
```

The exit status is authoritative. Pattern searches are diagnostic only; some
tests print expected errors while exercising failure handling. See
[testing-guide.md](testing-guide.md#logged-commands-and-failure-artifacts) for
source bounds, watchdogs, retention, and cleanup.

The browser suite uses the auth file outside Playwright to mint a 60-second,
single-use loopback bootstrap, exchanges it by POST, and never puts the durable
gateway token in browser state or history. It creates a real local worktree,
drives a backend-owned terminal operation, reloads while it is progressing,
verifies the rehydrated output and diff state, and cleans up. The Electron suite
launches the real main process and preload, then checks the profile title,
`userData`, IPC invocation, clipboard bridge, and supervised backend shutdown.
On macOS every Electron spec launches with `--use-mock-keychain`
(`e2e/agent-testing/electron-launch-switches.ts`). Without it `safeStorage`
reads the login-keychain item named after the fixed profile title, which every
worktree shares. Electron from another worktree then waits on an access prompt
nobody answers, and startup never opens a window. The annotation spec also
renders the real Notes column beside the native view. It checks the view's
bounds at app zoom 0.8, 1 and 1.25, overlays, the narrow Preview/Notes switch
at app zoom 1.5, and keyboard traversal for create and send. The held Discuss
request is cancelled and verified absent from the queue before its compose-draft
hold is removed;
a profile-local Codex probe refuses and records accidental provider launches.
Capture pixels are compared with the target at preview zoom 0.8, 1 and 1.5 in
both fixed and Notes-offset views, at natural DPR and forced DPR 1 and 2 with
`--force-device-scale-factor`. Views stay small enough to assert native image
scale without reduction. The Window-menu test always checks the selected label;
its OS-focus predicate runs only when the host exposes a key window (and an
active app on macOS).
The annotation spec also checks pins and Show on page for an offscreen target,
a target in an open and a closed modal, and a late web font (fixture routes
`/dialogs` and `/fonts`), result-capture stability and comparison labels
(`/motion`, `/fonts`, an expired `/account` sign-in), and records client
selection-to-saved timing in its `baselines` case. Pages still loading are
probed through `mainFrame.executeJavaScript`: `webContents.executeJavaScript`
waits for the load event, which a late font holds.
The opt-in Docker suite verifies the seeded container and proves that a direct
container command is rejected for an otherwise valid Orkestrator container
owned by another profile. Its two annotation cases write evidence into the
fixture container, check paths inside it and wait (up to about 5 minutes, one
garbage-collection period) for settled-evidence cleanup; the live one needs
`ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`.

`web-annotations-approval-live.spec.ts` (opt-in
`ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION=1`, provider from
`ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT`, default Claude) raises a live
approval, then switches environments in the client, reloads, drops the event
stream and restarts the profile gracefully and by `SIGKILL`. It stops and
starts the profile, so run it alone against a profile you started:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=annotation-qa ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION=1 \
mise run test:logged -- --name annotation-disruption -- mise run test:agent:browser -- \
  e2e/agent-testing/web-annotations-approval-live.spec.ts
```

`ORKESTRATOR_AGENT_TEST_BROWSER=webkit` runs a browser-config spec in WebKit
(Safari's engine, the iOS wrapper's `WKWebView`) instead of Chromium.

Artifacts are written below `output/agent-testing/<profile-or-run-id>/`, with
traces and screenshots retained on failure and a JSON result summary. Browser
artifacts are redacted after the run as a second defense for the short-lived
session cookie. Oversized files and trees are removed rather than loaded without
a bound or retained unredacted. Do not add gateway tokens, prompts, terminal
output, or fixture contents to reports.

## Manual browser QA

Use the in-app Browser, or Playwright for repeatable assertions, against the
exact `browserUrl` from status. This is the default client for normal UI and
agent testing. Do not use Computer Use to open or drive the desktop app unless
the change specifically exercises Electron-only behavior such as menus,
clipboard, preload/IPC, window identity, or shutdown. For those native checks,
target the exact `electronTitle`; never interact with a window titled only
`Orkestrator AI`.

If the browser shows the login page, do not go looking for the token: run
`mise run dev:login --profile <profile>` and open the `loginUrl` it prints, as
described above. The page itself repeats that command for the running profile.
Typing the token into the form still works and remains the fallback if the
launcher is unavailable — `authFile` is an owner-only JSON file whose `token`
property is exactly what the field wants, it is the gateway token rather than an
OTP, and it must never be echoed, put in a shell argument or URL, pasted into
chat, or captured in screenshots, traces, logs, and reports.

Use the fixture to create/start an environment and open a terminal. Run the
fixture project's own `bun run dev` — the script belongs to the copied fixture,
not to this repository, whose commands are mise tasks — then open the printed
preview, change the `fixture-v1` marker, and verify status/diff updates. Every
background change must include this path:

1. Start the operation.
2. Switch to another environment or tab.
3. Let it progress or finish while inactive.
4. Return and verify status, messages, pending interactions, and controls from
   authoritative snapshots.

Reload once more after returning and verify the same result again. Do not accept
a result that works only while the initiating component stays mounted: live
SSE/IPC events are incremental hints, and the check must prove a missed event
can be recovered.

Two traps when scripting this path:

- **Escape is Stop.** While a turn runs, Escape stops it if the chat tab's
  composer has focus or nothing has (`useEscapeToStop`). A test that presses
  Escape to close a tooltip right after Send stops its own turn, and Claude
  reports that as an SDK `ede_diagnostic` result. Use
  `dismissSidebarTooltip` (`e2e/agent-testing/sidebar-tooltip.ts`).
- **Offline is not a dropped stream.** `context.setOffline(true)` fails new
  requests but leaves the open event stream connected, so events still arrive
  and nothing reconnects. To drop the stream, also call `window.stop()` in the
  page while offline; the gateway client then reconnects and replays from its
  cursor once back online. `watchEventStream`
  (`e2e/agent-testing/event-stream-outage.ts`) does both and asserts the
  reconnection.

For each failure record profile and commit, automated commands, route used,
reproduction steps, expected and actual results, severity, and evidence paths.
Continue past non-blocking failures and state any skipped flows.

## Frontend change checklist

Use this cycle whenever a change affects rendered UI, routing, browser gateway
behavior, frontend state, terminal presentation, environment controls, or any
interaction a user can perform in the desktop window. Test the actual Vite
renderer against a real isolated backend, not only component mocks.

Before starting the UI, typecheck the web package and run the owning test file
(see [Automated checks](#automated-checks)). Do not proceed to browser QA with a
known type error or deterministic focused test failure. A browser pass cannot
compensate for a broken static or unit check.

For a frontend change, exercise at least:

1. The primary user path changed by the implementation.
2. Empty, loading, success, and error/disabled states that are reachable safely.
3. A page reload after the state change, proving the UI rehydrates from the
   backend instead of depending on the event that originally produced it.
4. A narrow viewport and a normal desktop viewport for layout-affecting changes.
5. Keyboard focus, labels, and the relevant accessible role/name for new controls.

Iterate without restarting unnecessarily:

- Frontend-only edits should arrive through Vite HMR in the running profile.
  Wait for the update, then re-run the affected path. Hard-reload the page if the
  test specifically needs a clean mount.
- Changes to Electron main/preload code, backend startup/options, profile wiring,
  or installed dependencies require stopping and starting the profile again.
- Backend business-logic changes generally require a restart because the
  supervised backend is not a Vite module.
- Use `dev:reset` only when the scenario requires pristine persisted state. A
  normal implementation loop should preserve the profile so reload and
  rehydration behavior remain testable.
- After every restart, call `dev:status --json` again; ports may have changed.

Minimum verification by change type:

| Change scope                                    | Minimum required verification                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CSS, layout, or visual component                | Web typecheck; owning tests; real browser at desktop and narrow viewport; screenshot of non-sensitive UI if useful      |
| Frontend interaction or Zustand/Context state   | Web typecheck; owning tests; browser smoke; primary path; reload; inactive-tab path when background state is involved   |
| Browser gateway or backend command              | Backend and web typechecks; focused gateway/command tests; browser smoke; authenticated real-browser path               |
| Electron main, preload, IPC, or window behavior | Desktop typecheck; focused Electron tests; `test:agent:electron`; native-window check when visual behavior changed      |
| Docker lifecycle or container UI                | Backend typecheck; exact-owner focused tests; local browser smoke; opt-in Docker fixture/suite when Docker is available |
| Cross-cutting or release-sensitive change       | All relevant checks above, then `mise run test`; use `mise run test:all` for release validation including iOS             |

Record enough evidence for another agent to reproduce the result: profile name
and tested commit/worktree, exact commands and pass/fail counts, the logged
runner's compressed failure artifact path when a command fails, the browser or
Electron route and viewport when layout matters, short reproduction steps with
expected and actual results, artifact paths under
`output/agent-testing/<run-id>/`, and any skipped flow with its concrete reason.
Failure screenshots should show only the UI needed to establish the issue, and
test names, annotations, console messages, and filenames must not carry secrets.

If an automated suite fails, inspect its saved log and owning test first. If it
failed in an aggregate/parallel run, rerun the owning file alone before calling
it flaky, then follow the flake workflow in
[testing-guide.md](testing-guide.md#diagnose-a-failure).

Before handing off, confirm there is no live launcher for the test profile and
report whether its state was reset or deliberately retained.

## Stop and reset

```bash
mise run dev:stop --profile codex-qa
mise run dev:reset --profile codex-qa
```

Stopping the profile also discards every issued browser session, since they live
only in the backend process.

Reset refuses a live launcher unless `--stop-first` is explicit. It validates the
profile sentinel and path, removes only exact-owner Docker containers, and then
deletes that profile's disposable state. Worktrees the profile registered in an
outside repository are unregistered, and their branches are deleted only when
already merged into the default branch. Preserve downloaded binaries with
`--keep-toolchains`.

Profiles whose checkout has since been deleted are removed automatically the
next time any profile starts. `mise run dev:prune --dry-run` lists what would
go; `--older-than <days>` also removes stopped profiles idle for that long.

## Troubleshooting

- Read `dev:status --json`, then inspect only the returned `logDir`. Its derived
  `loginCommand` is the exact `dev:login` invocation for that profile.
- A login page that reappears mid-session means the browser session lapsed or the
  backend restarted. Mint a fresh link rather than hunting for the token.
- For failed tests and typechecks, inspect the compressed artifact directory
  printed by the logged runner rather than relying on the agent/tool buffer.
- An occupied reserved port fails startup clearly; retrying allocates fresh ports.
- `Bridge build failed; see .../bridge-build.log` means a bridge no longer
  compiles; fix it or run that bridge's `build` script to see the error.
  `Profile <name> is running bridge builds that no longer match` from a
  Playwright run means a bridge changed after the profile started; restart
  the profile.
- If Docker is unavailable, use the local fixture flow.
- A missing toolchain affects nested agents, not credential-free fixture/server
  testing. Use `--credential-source <name>` when a test should expose only one
  provider, or `--no-agent-credentials` for signed-out behavior.
- `dev:stop` validates launcher PID start time and reports surviving owned
  processes; it never kills by executable name or port.
- If reset refuses the target, do not bypass the sentinel or path check. Inspect
  `profile.json` and choose the intended named profile.

## Claude container login renewal qualification

The deterministic tests cover startup refresh with surviving MCP logins, account
switch fencing, sanitization publication races, and bridge-start ordering. The
Docker fixture also boots and restarts with a legacy Claude refresh token on a
read-only mount and verifies that the working credential is access-only.

`apps/backend/tests/claude-container-login-live.test.ts` qualifies the real
refresh exchange separately. It runs the pinned host CLI, then pushes its
renewal into a running container while a Claude background task waits past the
old token's **actual** expiry. The same session must produce a model response
after expiry; the container is never restarted, and no renderer is mounted.
Credentials and responses stay out of test output.

Provision an **exclusive disposable account** at
`<private-root>/agent-accounts/claude/<uuid>` with an on-disk `.credentials.json`.
Do not borrow a personal login or an agent-test profile's copied refresh token:
this qualification intentionally rotates the dedicated account's refresh token.
Wait until the real login has 90–240 seconds remaining; do not edit expiry
metadata. Build a development image and supply the pinned host toolchain's bin
directory. Then run:

```bash
ORKESTRATOR_LIVE_CLAUDE_LOGIN=1 \
ORKESTRATOR_LIVE_CLAUDE_ACCOUNT_HOME=<private-root>/agent-accounts/claude/<uuid> \
ORKESTRATOR_LIVE_CLAUDE_IMAGE=orkestrator-v2:dev-<workspace-hash> \
ORKESTRATOR_LIVE_CLAUDE_TOOLCHAIN_BIN=<pinned-toolchain-bin> \
  mise run test:logged -- --name claude-login-live -- bun test --cwd apps/backend ./tests/claude-container-login-live.test.ts --parallel=1 --only-failures
```

The test is skipped without the opt-in. With the opt-in, missing prerequisites,
provider failures, ineffective refreshes, and failed continuations fail the
qualification. It removes only its own container and scratch directory; the
renewed dedicated login remains in its home. A synthetic Docker pass does not
prove that the provider refresh exchange succeeded.
