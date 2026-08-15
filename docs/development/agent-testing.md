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

Agent-test profiles use the host's active Claude, Codex, and OpenCode logins by
default so manual QA can run real agents:

See [`../credentials-and-models.md`](../credentials-and-models.md) for the full
per-platform credential, container-import, and model-cache matrix.

```bash
bun run dev:test -- --profile live-agents --fixture
```

To narrow the profile to one provider, pass `--credential-source codex` (or
`claude`/`opencode`). To test the signed-out experience, pass
`--no-agent-credentials`. GitHub, Cursor, Grok, and unrelated ambient API
credentials remain disabled. Live agent requests can incur external effects or
cost, so use only the seeded fixture and do not put credentials in test output.

Startup copies available, bounded model metadata into the isolated profile:
`agent-model-catalog.json`, `opencode-model-catalog.json`, Codex
`models_cache.json`, the Codex bridge `models-cache.json`, and Grok
`models_cache.json`. Cursor and Grok picker entries are also carried in the
shared `agent-model-catalog.json`; Cursor has no separate portable model-cache
file. This makes model pickers representative even in a deliberately
credential-free run. The seeding does not copy projects, sessions, prompts,
settings, or additional credentials.

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

Run focused package typechecks/tests first, with `--parallel` on direct suites.
Every automated command must save complete stdout and stderr to a log file.
Agent and tool output buffers often max out, so visible command output is not an
authoritative record. Enable `pipefail`, pipe through `tee`, and run each pipeline
separately so its exit status belongs to exactly one command:

```bash
set -o pipefail
bun run --cwd apps/web typecheck 2>&1 | tee /tmp/orkestrator-web-typecheck.log
bun test ./apps/web/src/path/to/ChangedComponent.test.tsx --parallel \
  2>&1 | tee /tmp/orkestrator-changed-component.log

ORKESTRATOR_AGENT_TEST_PROFILE=codex-qa \
ORKESTRATOR_AGENT_TEST_RUN_ID=codex-qa \
bun run test:agent:browser 2>&1 | tee /tmp/orkestrator-agent-browser.log

bun run test:agent:electron 2>&1 | tee /tmp/orkestrator-agent-electron.log

# Against a profile started with --fixture-environments local,container:
ORKESTRATOR_AGENT_TEST_PROFILE=container-qa \
bun run test:agent:docker 2>&1 | tee /tmp/orkestrator-agent-docker.log

# Run for cross-cutting or release-sensitive changes:
bun run test 2>&1 | tee /tmp/orkestrator-full-tests.log
```

Use descriptive, unique `/tmp` filenames when agents run concurrently. Do not
write transient console logs into the repository. If the visible tool output is
truncated, use the command's exit status and inspect the saved file in bounded
chunks instead of rerunning solely to recover output:

```bash
tail -n 200 /tmp/orkestrator-agent-browser.log
rg -n "\(fail\)|error:|Failing groups:" /tmp/orkestrator-agent-browser.log
```

The exit status remains authoritative because `pipefail` preserves failures from
the command before `tee`. Pattern searches are diagnostic only; some tests print
expected errors while exercising failure handling.

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
session cookie. Do not add gateway tokens, prompts, terminal output, or fixture
contents to reports.

## Manual browser QA

Use the in-app Browser, or Playwright for repeatable assertions, against the
exact `browserUrl` from status. This is the default client for normal UI and
agent testing. Do not use Computer Use to open or drive the desktop app unless
the change specifically exercises Electron-only behavior such as menus,
clipboard, preload/IPC, window identity, or shutdown. For those native checks,
target the exact `electronTitle`; never interact with a window titled only
`Orkestrator AI`.

If the browser shows the login page, `authFile` is an owner-only JSON file and
its `token` property is the exact code the page is requesting. It is the gateway
token, not an OTP or a code shown elsewhere. Read the value locally, type it only
into the gateway-token password field, and submit. Never echo it, include it in
a shell argument or URL, paste it into chat, or capture it in screenshots,
traces, logs, and reports.

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

Reset refuses a live launcher unless `--stop-first` is explicit. It validates the
profile sentinel and path, removes only exact-owner Docker containers, and then
deletes that profile's disposable state. Preserve downloaded binaries with
`--keep-toolchains`.

## Troubleshooting

- Read `dev:status --json`, then inspect only the returned `logDir`.
- For tests and typechecks, inspect the `/tmp` file named in the command rather
  than relying on the agent/tool output buffer.
- An occupied reserved port fails startup clearly; retrying allocates fresh ports.
- If Docker is unavailable, use the local fixture flow.
- A missing toolchain affects nested agents, not credential-free fixture/server
  testing. Use `--credential-source <name>` when a test should expose only one
  provider, or `--no-agent-credentials` for signed-out behavior.
- `dev:stop` validates launcher PID start time and reports surviving owned
  processes; it never kills by executable name or port.
- If reset refuses the target, do not bypass the sentinel or path check. Inspect
  `profile.json` and choose the intended named profile.
