# Isolated Development Mode and Agent Testing Plan

## Status

Proposed. The commands and workflows described as the target state in this
document do not exist yet unless explicitly called out as current behavior.

## Summary

Orkestrator is frequently developed from inside the installed production
Orkestrator application. Development and test instances therefore need to run
alongside the production app without reading, modifying, adopting, or deleting
production state.

The target is a first-class, profile-based development mode that agents can
start and inspect consistently:

```bash
bun run dev:test -- --profile agent-123 --fixture
```

The launcher will create an isolated runtime profile, choose free loopback
ports, start Vite, Electron, and the backend, seed a disposable Git fixture,
and publish a machine-readable status manifest. Agents will then be able to
exercise the same instance through a normal browser, Playwright, or Codex
Computer Use.

The implementation must make destructive operations safe by construction. A
development instance must not depend on users or agents remembering which app
window, data directory, Docker container, or checkout is production.

## Goals

- Run an unpackaged development build while the installed production app is
  open.
- Run development instances from more than one repository worktree at once.
- Isolate all mutable application, backend, Git, process, browser, and Docker
  state from production.
- Give agents a deterministic way to start, inspect, test, stop, and reset a
  development instance.
- Provide a disposable test project that exercises real Orkestrator workflows
  without registering the live Orkestrator checkout.
- Support both browser-based testing and native Electron testing through
  Computer Use.
- Preserve backend ownership of long-running state and rehydration behavior
  while environments or tabs are inactive.
- Produce useful test evidence: automated results, screenshots, traces, logs,
  and concise manual QA findings.

## Non-goals

- Copying production projects, environments, sessions, credentials, or UI
  state into development by default.
- Making an agent-test backend reachable outside the local machine.
- Using the live Orkestrator checkout as the project under test.
- Replacing unit and integration tests with UI automation.
- Fully testing real GitHub pull request behavior in the default fixture.
- Allowing reset or cleanup commands to target arbitrary directories or Docker
  resources.

## Current state

Several required foundations already exist:

- Electron sets development `userData` to `orkestrator-v2-dev`, separate from
  the packaged app's `orkestrator-v2` directory. The Electron single-instance
  lock is claimed after that override, so packaged and development instances
  can coexist.
- The backend accepts `--data-dir` and `ORKESTRATOR_DATA_DIR`.
- The Electron backend supervisor uses an ephemeral loopback control port.
- The browser gateway falls back across occupied ports and can use an
  ephemeral port.
- New Docker containers include an owner namespace derived from the backend
  data directory.
- The gateway can serve or proxy the Vite renderer, which makes the real
  backend accessible from a normal browser.

These foundations are not yet a complete agent-test mode:

- Every development checkout shares the single `orkestrator-v2-dev` Electron
  data directory and single-instance lock.
- Vite assumes port `1420`, so two development checkouts conflict.
- Local worktrees share `~/orkestrator-v2/workspaces` rather than a
  profile-scoped root.
- Production and development use the same `orkestrator-v2:latest` Docker image
  tag.
- Ownerless legacy Docker containers are treated as adoptable, and the
  container cleanup path can prune them. Development mode must never adopt or
  clean up these resources.
- Electron development currently enables managed desktop web access, which can
  interact with machine-wide Tailscale Serve state.
- There is no stable readiness manifest for agents to discover the active
  window, browser URL, fixture path, logs, or child process IDs.
- The existing Playwright suite uses a frontend fixture and does not boot the
  real Electron main process, preload, or backend.
- There is no standard disposable project or end-to-end agent runbook.

## Safety invariants

The following are non-negotiable and should be encoded in tests where
possible:

1. Production and development never share a mutable data directory.
2. Two development profiles never share a mutable data directory.
3. A development profile cannot read production configuration or credentials
   unless the user explicitly opts in to a narrowly defined credential source.
4. Every development Docker container has the exact expected owner label.
5. Development list, adoption, cleanup, and prune operations ignore ownerless
   and foreign-owned Docker resources.
6. A development Docker build never overwrites the production image tag.
7. Local worktrees and runtime files live below the selected profile root.
8. Development binds only to loopback and does not configure Tailscale Serve.
9. Reset and cleanup require a valid profile sentinel and refuse production,
   repository-root, home-directory, empty, or otherwise broad targets.
10. The runtime manifest and logs never contain gateway tokens, credentials,
    prompts, terminal contents, or file contents.
11. Closing or crashing the development Electron process eventually stops its
    supervised backend, bridges, terminals, and other process trees.
12. Switching away from a running environment or unmounting a React tree does
    not stop background work. Returning to it rehydrates from authoritative
    backend snapshots.

## Runtime profile design

Introduce one parsed runtime profile that is passed through Electron, backend,
Docker, local-worktree, and launcher boundaries rather than reconstructing
mode-specific paths independently.

Suggested shape:

```typescript
type RuntimeFlavor = "production" | "development" | "agent-test";

type RuntimeProfile = {
  flavor: RuntimeFlavor;
  id: string;
  displayName: string;
  dataDir: string;
  runtimeDir: string;
  worktreeDir: string;
  logDir: string;
  dockerOwner: string;
  dockerImage: string;
  rendererHost: "127.0.0.1";
  rendererPort: number;
  gatewayHost: "127.0.0.1";
  gatewayPort: number;
};
```

The profile ID must be normalized to a conservative filesystem- and
Docker-safe value. The default development profile can be a short hash of the
resolved repository root. Callers can provide a name such as `agent-123`, but
the normalized ID and resolved paths remain authoritative.

Suggested macOS layout:

```text
~/Library/Application Support/orkestrator-v2-dev/
└── profiles/
    └── <profile-id>/
        ├── profile.json
        ├── .orkestrator-dev-profile
        ├── data/
        ├── runtime/
        │   └── status.json
        ├── logs/
        ├── worktrees/
        └── fixtures/
```

Linux should use the equivalent XDG configuration/state roots. Tests should
inject roots and must not depend on the real home directory.

`profile.json` is persistent non-secret configuration. `runtime/status.json`
is ephemeral process state. The `.orkestrator-dev-profile` sentinel contains a
format version and profile ID so cleanup can verify the target independently
of command-line arguments.

## Target commands

### Start

```bash
bun run dev:test -- --profile agent-123 --fixture
```

Responsibilities:

1. Resolve and validate the profile.
2. Refuse any path equal to or nested within the production data directory.
3. Create the profile directories and sentinel.
4. Reserve free loopback ports for Vite and the browser gateway.
5. Compile the Electron main/preload code.
6. Start Vite with the selected strict port.
7. Start Electron with the resolved profile and renderer URL.
8. Wait for backend and renderer readiness.
9. Seed the fixture when requested.
10. Atomically publish `runtime/status.json` with `status: "ready"`.
11. Print the profile, browser URL, test-project path, status path, and log
    directory. Do not print authentication material.
12. Forward signals and shut down the full process tree.

The window title and application menu should visibly identify the instance:

```text
Orkestrator AI — DEV [agent-123]
```

The development icon or title-bar treatment should also differ from
production so visual automation and humans do not confuse the windows.

### Inspect

```bash
bun run dev:status -- --profile agent-123
bun run dev:status -- --profile agent-123 --json
```

Human output should summarize readiness, URLs, fixture path, and logs. JSON
output should return the parsed runtime manifest and a fresh liveness result.

Suggested manifest:

```json
{
  "version": 1,
  "status": "ready",
  "profile": "agent-123",
  "flavor": "agent-test",
  "dataDir": "/absolute/profile/data",
  "testProject": "/absolute/profile/fixtures/test-project",
  "electronTitle": "Orkestrator AI — DEV [agent-123]",
  "rendererUrl": "http://127.0.0.1:43101",
  "browserUrl": "http://127.0.0.1:43102",
  "authFile": "/absolute/profile/data/gateway-auth.json",
  "logDir": "/absolute/profile/logs",
  "pids": {
    "launcher": 123,
    "vite": 124,
    "electron": 125,
    "backend": 126
  }
}
```

The manifest may name the mode-`0600` authentication file but must not contain
its token. Any browser bootstrap mechanism should use a short-lived,
single-use loopback exchange and remove secret material from browser history.

### Stop

```bash
bun run dev:stop -- --profile agent-123
```

Stop should signal the owning launcher and wait for supervised processes to
exit. It should report surviving processes but must not kill unrelated
processes based only on executable name or port number.

### Reset

```bash
bun run dev:reset -- --profile agent-123
```

Reset is destructive and must:

- Require the exact profile directory and a valid sentinel.
- Confirm no live launcher owns the profile, or stop it first when explicitly
  requested.
- Resolve paths before comparison.
- Refuse the production data directory, repository root, filesystem root, home
  directory, or a profile root containing another active profile.
- Remove only Docker resources with the exact profile owner label.
- Report what was removed and whether it can be recreated.

An optional `--keep-toolchains` may retain large downloaded binaries while
deleting all test state.

## Implementation phases

### Phase 1 — Isolation hardening

Goal: make it impossible for a development process to mutate production state
before adding more convenient automation.

- Add the runtime flavor/profile parser and central path resolver.
- Replace the boolean-only Electron development identity with a resolved
  profile ID and profile-specific `userData` path.
- Keep the production path exactly backward-compatible.
- Give each profile a distinct single-instance lock through its `userData`.
- Make the product/window name include the development profile.
- Pass the resolved profile data directory to the backend explicitly.
- Make the local worktree base directory backend/profile-owned instead of using
  the global `~/orkestrator-v2/workspaces` path.
- Set `ORKESTRATOR_DOCKER_IMAGE` or an equivalent backend option and use a
  profile-specific tag such as `orkestrator-v2:dev-<workspace-hash>`.
- In agent-test mode, require exact Docker owner labels for listing, status,
  adoption, orphan cleanup, and prune. Never adopt ownerless legacy
  containers.
- Disable managed web client/Tailscale setup for agent-test mode and expose
  only the loopback browser gateway.
- Add a dev-profile sentinel and shared safe-target validation used by all
  cleanup paths.

Likely files:

- `apps/desktop/electron/app-constants.ts`
- `apps/desktop/electron/main.ts`
- `apps/desktop/electron/single-instance.ts`
- `apps/desktop/electron/backend-process.ts`
- `apps/backend/src/options.ts`
- `apps/backend/src/core/constants.ts`
- `apps/backend/src/core/docker-ownership.ts`
- `apps/backend/src/core/commands.ts`

Verification:

- Unit-test profile normalization and production-path refusal.
- Unit-test that two repository roots resolve to different development
  profiles, data paths, locks, worktrees, Docker owners, and image tags.
- Unit-test that agent-test Docker discovery ignores foreign and ownerless
  containers.
- Unit-test that agent-test cleanup emits only exact-owner Docker filters.
- Unit-test that agent-test backend startup has no Tailscale configuration.

### Phase 2 — Profile-aware launcher and lifecycle

Goal: provide one supported entry point that agents can operate without
manually coordinating ports and processes.

- Replace fixed port `1420` in the desktop development launcher with allocated
  ports passed to Vite and Electron.
- Prefer reserving ports in the launcher, then releasing them immediately
  before child startup. Use strict child ports so an unexpected race fails
  clearly instead of attaching to another instance.
- Capture the backend readiness contract without logging its token.
- Write the runtime manifest atomically and with restrictive permissions.
- Add `dev:status`, `dev:stop`, and `dev:reset` scripts.
- Record each child PID and process start time so PID reuse cannot cause an
  unrelated process to be killed.
- Handle SIGINT, SIGTERM, normal Electron exit, Electron crash, Vite failure,
  and partial startup failure.
- Retain bounded logs per profile and expose their paths through status.
- Make startup idempotent: a second start reports the running instance rather
  than starting duplicate backends.

Likely files:

- `apps/desktop/scripts/dev.ts`
- new modules under `apps/desktop/scripts/dev/`
- `apps/web/vite.config.ts`
- root and desktop `package.json`
- `turbo.json` if new environment variables must pass through Turbo

Verification:

- Start production and one development profile together.
- Start two development profiles from separate worktrees together.
- Confirm each status command returns only its own processes and URLs.
- Terminate the launcher in each supported way and confirm no owned backend or
  bridge remains.
- Confirm one profile can fail startup without stopping another.

### Phase 3 — Disposable fixture project

Goal: let agents test Orkestrator workflows without operating on this source
checkout or a real user repository.

Add a small fixture template under a clearly test-only directory. The launcher
copies it into the profile before initializing it, so the checked-in template
is never modified.

The seeded project should:

- Be initialized as a Git repository with an initial commit.
- Use a local bare repository as `origin`, avoiding network access.
- Include a small web server with a visible build/version marker.
- Include a health endpoint and a deterministic interactive control.
- Include setup commands and a deliberate file-change workflow.
- Emit a clickable localhost URL so terminal-to-browser behavior can be
  tested.
- Avoid secrets, databases, package registries, and external APIs.

Fixture seeding should register the copied project through the real backend
command surface. Optional flags may create a local environment, a containerized
environment, or both:

```bash
bun run dev:test -- --profile agent-123 --fixture --fixture-environments local,container
```

Real GitHub and pull request testing belongs in a separate explicit workflow
using a dedicated sandbox repository and credentials. It must not be part of
the safe default.

Verification:

- Repeated reset/start cycles produce the same initial Git state.
- The fixture template remains clean after tests.
- Local environment creation keeps worktrees below the profile root.
- Containerized creation uses only the profile image and owner namespace.
- Starting the fixture server exposes a page reachable from Electron and the
  browser gateway.

### Phase 4 — Browser and Electron smoke automation

Goal: cover the real stack, while keeping tests deterministic enough for local
agent use and CI.

Add two complementary layers:

1. A real browser-gateway Playwright suite that boots the isolated backend and
   Vite renderer, connects with test authentication, and exercises the seeded
   project.
2. A smaller Electron smoke suite that boots the real main process and preload
   and covers IPC/window integration that a normal browser cannot represent.

Suggested browser scenarios:

- Load projects and environments from authoritative backend state.
- Create and start an environment.
- Open a terminal and run a deterministic fixture command.
- Start the fixture server and open its preview.
- Modify a file and observe diff/status updates.
- Switch to another environment while work progresses, return, and verify
  rehydrated status and transcript.
- Stop and delete the environment.

Suggested Electron-only scenarios:

- Profile-specific title and identity.
- Preload IPC invocation.
- Native menus and dialogs.
- Clipboard and drag/drop behavior.
- Embedded browser surface behavior and its DevTools action.
- Window close and supervised backend shutdown.

Artifacts should go below `output/agent-testing/<profile-or-run-id>/` and may
include Playwright traces, screenshots, sanitized logs, and a JSON result
summary. Do not include gateway tokens, prompt contents, terminal output, or
fixture file contents in general diagnostic logs.

### Phase 5 — Agent runbook

Goal: make the workflow usable without repository archaeology.

Add `docs/development/agent-testing.md` after the commands exist. Link it from
`AGENTS.md` and the development section of `README.md`.

The runbook should cover:

1. Prerequisites and expected startup time.
2. Starting or reusing a named isolated profile.
3. Reading readiness and diagnostics through `dev:status --json`.
4. Finding and using the seeded test project.
5. Choosing browser, Playwright, or Computer Use.
6. Required automated checks before manual QA.
7. Capturing screenshots, traces, and concise failure evidence.
8. Testing inactive-environment rehydration explicitly.
9. Stopping and resetting the profile safely.
10. Troubleshooting ports, Docker, toolchains, credentials, and orphaned
    processes.
11. The strict rule never to add the live source checkout as the fixture
    project.

## Proposed agent workflow

The final runbook should present a workflow similar to the following.

### 1. Start and discover

```bash
bun run dev:test -- --profile codex-qa --fixture
bun run dev:status -- --profile codex-qa --json
```

Wait for `status` to become `ready`. Use only the returned browser URL, fixture
path, Electron title, and log directory. Do not assume fixed ports.

### 2. Run automated checks

Run focused typechecks and tests for the changed packages first. Then run the
real-stack smoke scenario relevant to the change. Direct suite invocations
must use `--parallel` in accordance with the repository testing guidance.

For browser behavior, use Playwright against the manifest's `browserUrl` and
save traces on failure. Assertions should prefer accessible roles and stable
user-facing text over CSS implementation details.

### 3. Exercise the test project

Use the seeded project only. Create an appropriate local or containerized
environment, start the fixture server, open its URL through Orkestrator, make a
small deterministic change, and verify the UI reflects the authoritative
backend state.

Every background-state change must include this regression path:

1. Start the operation.
2. Switch to another environment or tab.
3. Let the operation progress or finish while inactive.
4. Return to the original environment.
5. Verify status, messages, pending interactions, and controls are correct.

### 4. Use Computer Use for native QA

Target the exact Electron title reported by the manifest, for example
`Orkestrator AI — DEV [codex-qa]`. Never interact with a window titled only
`Orkestrator AI` during agent testing.

Suggested prompt:

```text
@Computer Test "Orkestrator AI — DEV [codex-qa]".
Use only the seeded fixture project.

Test:
- creating and starting an environment
- opening a terminal
- starting the fixture web server
- opening its browser preview
- switching away while work continues, then returning
- stopping and deleting the environment

For each failure include repro steps, expected result, actual result,
severity, and screenshot evidence. Continue past non-blocking failures and
finish with a short triage summary.
```

Computer Use is best for native UI behavior and realistic user journeys.
Playwright remains the preferred route for repeatable browser assertions and
traces.

### 5. Report evidence

A completed agent test report should state:

- Profile and commit tested.
- Automated commands and results.
- Manual flows exercised.
- Browser/Electron route used.
- Evidence paths for failures.
- Reproduction steps, expected result, actual result, and severity for every
  issue.
- Any skipped flows and the reason.

### 6. Stop or reset

```bash
bun run dev:stop -- --profile codex-qa
bun run dev:reset -- --profile codex-qa
```

Use reset only when disposable project and application state are no longer
needed. The command should report exactly which profile resources it removed.

## Credentials and external effects

The default fixture should exercise application mechanics without agent API
credentials. If a change specifically requires a live nested agent session,
credentials must be enabled explicitly and narrowly, for example:

```bash
bun run dev:test -- --profile codex-live --fixture --credential-source codex
```

The exact interface should be finalized during implementation, but it must
follow these rules:

- No implicit copying of production configuration or whole credential files.
- Enable only the named provider.
- Do not persist imported secrets in the fixture.
- Redact secrets from status, logs, process arguments, and test artifacts.
- Require a separate explicit flag for GitHub writes or other external side
  effects.
- Default all approvals to denial on timeout, disconnect, malformed answers,
  or process-generation death.

## Test plan

### Unit tests

- Runtime profile parsing, normalization, and path derivation.
- Production-path and unsafe-cleanup refusal.
- Profile-specific Electron identity and `userData`.
- Port allocation and strict-port propagation.
- Runtime manifest validation and redaction.
- Docker owner and image selection.
- Exact-owner listing, cleanup, and prune behavior.
- Profile-scoped local worktree paths.
- Process manifest liveness and PID-start-time validation.
- Fixture copy and seed idempotency.

### Integration tests

- Electron supervisor passes the resolved profile to the backend.
- Backend readiness produces a valid sanitized manifest.
- Two profiles start simultaneously without storage or port collisions.
- Production-like and agent-test registries see only their Docker resources.
- Stopping one profile leaves the other running.
- Reset removes only the selected fixture, worktrees, state, and exact-owner
  containers.
- Parent death stops the owned backend and local bridges.

### End-to-end tests

- Browser-gateway workflow using the real backend and fixture.
- Electron main/preload smoke workflow.
- Inactive-environment progress and rehydration.
- Local and containerized fixture environments where Docker is available.
- Clean shutdown after success and after forced child failure.

### Manual acceptance

- Keep the installed production app running throughout the test.
- Create or edit production-only harmless UI state before starting development
  and confirm development cannot see it.
- Create development-only state and confirm production cannot see it.
- Rebuild the development Docker image and confirm the production tag/digest
  is unchanged.
- Run development cleanup and confirm production and ownerless legacy
  containers are unchanged.
- Confirm Tailscale Serve configuration is unchanged.
- Confirm the development window is visually distinguishable.
- Inspect the fixture from a normal browser and Computer Use.
- Force-close Electron and verify the profile's backend and bridges exit.

## Acceptance criteria

This plan is complete when all of the following are true:

- The installed production application and an agent-test profile can run at
  the same time.
- Two source workspaces can run independent agent-test profiles concurrently.
- Production and development configurations, sessions, projects,
  environments, browser storage, and credentials remain isolated by default.
- Development Docker builds, containers, listings, cleanup, and prune actions
  cannot alter production or legacy ownerless resources.
- Local development worktrees are profile-scoped.
- Agent-test startup and shutdown do not change Tailscale configuration.
- `dev:status --json` supplies all non-secret information required by browser
  and Computer Use workflows.
- The disposable fixture exercises environment, terminal, server, browser,
  file-change, inactive-environment, and cleanup behavior.
- A real-stack smoke suite covers the browser gateway, backend, and at least a
  minimal Electron main/preload path.
- Reset refuses unsafe targets and removes only the named profile's resources.
- Forced termination does not leave the profile's backend or bridge process
  tree running.
- The agent runbook is linked from `AGENTS.md` and can be followed without
  relying on undocumented fixed ports or paths.

## Suggested delivery sequence

Keep changes reviewable and land safety before convenience:

1. **PR 1: isolation hardening** — runtime profile, profile-scoped data and
   worktrees, strict Docker ownership, development image tags, loopback-only
   agent-test gateway, and cleanup guards.
2. **PR 2: launcher and fixture** — profile-aware ports and lifecycle, status
   manifest, start/status/stop/reset commands, and the disposable project.
3. **PR 3: verification and documentation** — browser and Electron smoke
   tests, test artifacts, the operational agent runbook, and README/AGENTS.md
   links.

Do not publish the agent runbook's target commands as supported until their
implementation and isolation tests have landed.
