# Isolated development and agent testing

Use agent-test profiles whenever testing Orkestrator from an installed Orkestrator
instance. A profile has its own Electron `userData`, backend registry, browser
gateway, worktrees, fixture, logs, Docker owner, and development image tag. It
binds only to `127.0.0.1` and never configures Tailscale Serve.

## Prerequisites

- macOS or Linux, Bun 1.3.14+, and repository dependencies installed.
- Docker only for container fixture environments. The default fixture and local
  smoke path do not require a Docker image.
- The first TypeScript compilation and Vite startup normally take under a minute.

## Start or reuse a profile

```bash
bun run dev:test -- --profile codex-qa --fixture
bun run dev:status -- --profile codex-qa --json
```

The second start is idempotent and reports the already-running launcher. Wait for
`status: "ready"`; never assume fixed ports. Use only the returned `browserUrl`,
`testProject`, `electronTitle`, and `logDir`. The manifest names the mode-0600
gateway auth file but never includes its token.

## Sign a browser in

```bash
bun run dev:login -- --profile codex-qa          # human-readable
bun run dev:login -- --profile codex-qa --json   # { loginUrl, expiresAt, ... }
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

Agent-test profiles authorize the host's Claude, Codex, Cursor, Grok, and
OpenCode credentials by default so manual QA can run real agents:

See [`../todo/credentials-and-models.md`](../todo/credentials-and-models.md) for the full
per-platform credential, container-import, and model-cache matrix.

```bash
bun run dev:test -- --profile live-agents --fixture
```

To narrow the profile to one provider, pass `--credential-source codex` (or any
other agent platform). To test the signed-out experience, pass
`--no-agent-credentials`. GitHub and unrelated ambient API credentials remain
disabled. Live agent requests can incur external effects or cost, so use only
the seeded fixture and do not put credentials in test output.

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
bounded owner-only `auth.json` snapshot is refreshed into the isolated home.

To create and start fixture environments during seeding:

```bash
bun run dev:test -- --profile codex-qa --fixture --fixture-environments local
# Requires the profile image printed in profile.json:
bun run dev:test -- --profile container-qa --fixture --fixture-environments local,container
```

The container fixture path builds the workspace-specific development image when
it is missing. Rebuild it explicitly without touching `orkestrator-v2:latest`:

```bash
bun run docker:build:dev -- --profile container-qa
```

Never add the live Orkestrator source checkout as the project under test. Use the
copied `testProject` only.

## Automated checks

Run focused package typechecks/tests first, with bounded `--parallel` workers on
direct suites. Every automated command must use the repository's logged runner,
which streams stdout/stderr to private storage, preserves the child exit status,
deletes raw output on success, and compresses bounded failure evidence. Run each
command separately so its result belongs to one check:

```bash
bun run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck
bun run test:logged -- --name changed-component -- \
  bun --cwd=apps/web test src/path/to/ChangedComponent.test.tsx \
  --parallel=2 --only-failures

ORKESTRATOR_AGENT_TEST_PROFILE=codex-qa \
ORKESTRATOR_AGENT_TEST_RUN_ID=codex-qa \
bun run test:logged -- --name agent-browser -- bun run test:agent:browser

bun run test:logged -- --name agent-electron -- bun run test:agent:electron

# Against a profile started with --fixture-environments local,container:
ORKESTRATOR_AGENT_TEST_PROFILE=container-qa \
bun run test:logged -- --name agent-docker -- bun run test:agent:docker

# Run for cross-cutting or release-sensitive changes:
bun run test

# Release validation, including the serial iOS suite:
bun run test:all
```

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
[`../test-logs.md`](../test-logs.md) for source bounds, retention, and cleanup.

The browser suite uses the auth file outside Playwright to mint a 60-second,
single-use loopback bootstrap, exchanges it by POST, and never puts the durable
gateway token in browser state or history. It creates a real local worktree,
drives a backend-owned terminal operation, reloads while it is progressing,
verifies the rehydrated output and diff state, and cleans up. The Electron suite
launches the real main process and preload, then checks the profile title,
`userData`, IPC invocation, clipboard bridge, and supervised backend shutdown.
The opt-in Docker suite verifies the seeded container and proves that a direct
container command is rejected for an otherwise valid Orkestrator container
owned by another profile.

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
`bun run dev:login -- --profile <profile>` and open the `loginUrl` it prints, as
described above. The page itself repeats that command for the running profile.
Typing the token into the form still works and remains the fallback if the
launcher is unavailable — `authFile` is an owner-only JSON file whose `token`
property is exactly what the field wants, it is the gateway token rather than an
OTP, and it must never be echoed, put in a shell argument or URL, pasted into
chat, or captured in screenshots, traces, logs, and reports.

Use the fixture to create/start an environment, open a terminal, run
`bun run dev`, open the printed preview, change the `fixture-v1` marker, and
verify status/diff updates. Every background change must include this path:

1. Start the operation.
2. Switch to another environment or tab.
3. Let it progress or finish while inactive.
4. Return and verify status, messages, pending interactions, and controls from
   authoritative snapshots.

For each failure record profile and commit, automated commands, route used,
reproduction steps, expected and actual results, severity, and evidence paths.
Continue past non-blocking failures and state any skipped flows.

## Stop and reset

```bash
bun run dev:stop -- --profile codex-qa
bun run dev:reset -- --profile codex-qa
```

Stopping the profile also discards every issued browser session, since they live
only in the backend process.

Reset refuses a live launcher unless `--stop-first` is explicit. It validates the
profile sentinel and path, removes only exact-owner Docker containers, and then
deletes that profile's disposable state. Preserve downloaded binaries with
`--keep-toolchains`.

## Troubleshooting

- Read `dev:status --json`, then inspect only the returned `logDir`. Its derived
  `loginCommand` is the exact `dev:login` invocation for that profile.
- A login page that reappears mid-session means the browser session lapsed or the
  backend restarted. Mint a fresh link rather than hunting for the token.
- For failed tests and typechecks, inspect the compressed artifact directory
  printed by the logged runner rather than relying on the agent/tool buffer.
- An occupied reserved port fails startup clearly; retrying allocates fresh ports.
- If Docker is unavailable, use the local fixture flow.
- A missing toolchain affects nested agents, not credential-free fixture/server
  testing. Use `--credential-source <name>` when a test should expose only one
  provider, or `--no-agent-credentials` for signed-out behavior.
- `dev:stop` validates launcher PID start time and reports surviving owned
  processes; it never kills by executable name or port.
- If reset refuses the target, do not bypass the sentinel or path check. Inspect
  `profile.json` and choose the intended named profile.
