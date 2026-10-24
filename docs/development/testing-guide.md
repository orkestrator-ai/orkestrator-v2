# Testing guide

Status: Living — how to choose and run tests.

This is the operating guide for choosing, running, and diagnosing Orkestrator's
automated tests. Use repository-level `mise` tasks for complete workflows and
the repository-pinned Bun runtime for focused tests. For isolated development
profiles, browser automation, Electron automation, and Docker fixtures, continue
with [agent-testing.md](agent-testing.md).

## Choose the smallest useful test

| Goal | Command | When to use it |
| --- | --- | --- |
| Test one file | `mise run test:logged -- --name focused -- bun test ./path/to/file.test.ts --parallel=1 --only-failures` | First feedback while editing one owner |
| Test root unit tests | `mise run test:logged -- --name root-unit -- mise run test:unit` | Root `tests/unit` only |
| Test changed code | `mise run test:changed` | Fast local feedback across affected packages and files |
| Test the repository | `mise run test` | Authoritative default, non-iOS validation before handoff; runs only the [area suites](#area-suites) the change can reach |
| Test the repository, every area | `mise run test:full` | What CI runs; every area suite regardless of the change |
| Test everything, including iOS | `mise run test:all` | Release-sensitive or iOS validation on a Mac with Xcode |
| Check format, lint, and types | `mise run test:logged -- --name check -- mise run check` | Static validation; this does not run tests |
| Run browser component tests | `mise run test:logged -- --name browser -- mise run test:browser` | Playwright component/browser coverage |
| Run isolated-stack agent tests | `mise run test:agent:browser:isolated` | Creates a disposable profile, runs browser tests, and cleans up |
| Run design-only real-stack tests | `mise run test:agent:design:isolated` | Same lifecycle, only `design-canvas.spec.ts` |
| Run Electron agent tests | `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` | Main process, preload, IPC, clipboard, and shutdown |
| Run Docker agent tests | `mise run test:logged -- --name agent-docker -- mise run test:agent:docker` | Opt-in container ownership and fixture coverage |
| Qualify live paused interactions | `mise run test:logged -- --name paused-interactions-live -- mise run test:agent:paused-interactions` | Opt-in billed turns in a disposable profile; set `ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1` ([agent-testing.md](agent-testing.md#live-paused-interactions)) |
| Run the live coordinator suite | `mise run test:agent:coordinator --credential-source <platform>` | Manual and opt-in: real provider turns, one disposable profile per platform ([agent-testing.md](agent-testing.md#live-coordinator-suite)) |

Choose validation scope using [AGENTS.md](../../AGENTS.md#choosing-validation-for-a-change)
before applying this loop. Documentation-only changes need only
`mise run format:check`.

A normal code implementation loop is:

1. Run the owning test file while iterating.
2. Run `mise run test:changed` after the local behavior is green.
3. Run `mise run check` through `test:logged` and run `mise run test` before
   handoff.
4. Add the relevant browser, agent, Docker, or iOS suite when the changed area
   requires it.

### Area suites

A few slow, self-contained test sets are area suites, declared in
`scripts/test-areas.ts`: the real-Chromium transcript-artifact suites and the
tmux suites. `mise run test` runs an area only when the change can reach it,
and prints an `AREA RUN` or `AREA SKIP` line with the reason.

An area runs when any file in its import graph differs from the merge base
with local `main`, including uncommitted and untracked files. The graph starts
at the area's test files and its package's preloads and follows every runtime
import into workspace packages; type-only imports do not count. Each area also
lists triggers for inputs an import cannot express, such as fixtures read by
path. Dependency, lockfile, `bunfig.toml`, `tsconfig`, `mise.toml`, Turbo, and
test-runner changes run every area, and so does anything uncertain: no merge
base, a Git failure, or an unreadable graph.

CI runs `mise run test:full`, which sets `ORKESTRATOR_TEST_AREAS=all`, so a
coupling the graph cannot see is still caught before merge. `test:all` also
runs every area. Set `ORKESTRATOR_TEST_AREA_BASE` to compare against a branch
other than `main`.

Add an area only for a slow test set whose import graph is narrow. Measure
first: an area whose graph reaches shared hubs such as storage or the protocol
package runs on most changes and saves little.

`test:changed` is an optimization, not final proof. It uses Turbo's affected
package graph and Bun's changes from the local `main` ref. Configuration files,
dynamic coupling, generated artifacts, or a stale local `main` can make a
change's true impact wider than the selected set.

Never use a bare `bun test` at the repository root. Without an explicit `./`
path, Bun treats arguments as discovery filters and can collect Playwright
specifications, package tests, and intentionally malformed fixtures. Use
`mise run test` for the default suite or prefix a focused path with `./`.

Playwright loads every spec under Node, so a spec must not import Bun-only
code. Backend storage needs `bun:sqlite`, and one such import aborts the whole
suite. Reach the backend through a Bun child process instead:
`e2e/design-service-client.ts` hosts a real design service for the component
design specs, and `e2e/agent-testing/backend-store.ts` reads and writes stores
behind a running profile. `tests/unit/playwright-spec-loading.test.ts` lists
every Playwright config under Node in `mise run test`, so such an import fails
there first.

### Documentation-only merge conflicts

The repository's
[merge-conflict exception](../../AGENTS.md#documentation-only-merge-conflict-resolution)
allows format-only validation when the complete original conflicted-path list
is known, every conflict was in prose documentation or other non-code text not
consumed by tests, builds, or tooling, and manual resolution changes only those
files. Confirm no conflict markers remain and run `mise run format:check`; do
not run tests, lint, typechecking, builds, or scenario suites for that
resolution, including when code, configuration, or tests auto-merge. This
repository policy takes precedence over generic merge-validation guidance.

Retain the original unmerged path list before staging, tied to the merge's
parent commit IDs, for resumed work. Resolving a source conflict to one parent's
version does not make it a documentation-only conflict. If the list is missing
or incomplete, run relevant validation on the merged result, including the full
suite when impact cannot be scoped; do not reconstruct a prose-only scope from
staged or combined diffs. New code/configuration edits,
non-documentation resolutions, tooling-consumed documentation, and outstanding
feature validation still follow the normal requirements.

### Public-site smoke tests

`mise run test:browser` also runs `e2e/public-site/` against a fresh production
build of the public client. To run only that smoke flow:

```bash
mise run test:logged -- --name public-browser -- \
  bunx playwright test --config e2e/public-site/playwright.config.ts
```

It checks landing-page login, deferred connection-screen loading, direct loads
and reloads of `/connect`, the home link, and install-command clipboard feedback
at desktop and narrow widths. This pre-connection flow needs no backend,
credentials, or isolated application profile. The server is owned and stopped
by Playwright; `ORKESTRATOR_PUBLIC_E2E_PORT` overrides its default port 4423.
Authenticated renderer flows still use isolated profiles as described below.

### Native browser controls

`e2e/AgentLaunchDialog.spec.ts` uses Google Chrome to exercise the native
input/datalist popup with keyboard selection at desktop and phone widths.
It requires a graphical session (or Xvfb on Linux). Install its browser channel
before running the component browser suite:

```bash
mise exec -- bunx playwright install chrome
```

The bundled Chromium build does not expose this native popup through automation
on macOS; use the Chrome channel for this spec rather than simulating a
suggestion by assigning the input value.

### macOS shell-test prerequisites

The default root suite executes Linux container scripts in isolated host
fixtures. These tests require Bash 4 or newer, GNU tar, coreutils, findutils,
grep and sed, plus `flock`. macOS's system Bash and BSD utilities do not satisfy
those requirements. Install the tools with Homebrew:

```bash
brew install bash coreutils findutils gnu-tar grep gnu-sed flock
```

The fixtures that need GNU `tar` or `date` put Homebrew's GNU tool directories
(under `/opt/homebrew/opt` or `/usr/local/opt`) ahead of the inherited PATH
themselves (`tests/unit/gnu-shell-tools.ts`), and skip with the install command
in the test name when those tools are missing. For everything else, prefer the
tools for the validation command without changing the global shell
configuration (use `/usr/local` in place of `/opt/homebrew` on Intel Macs):

```bash
PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" \
  mise run test:logged -- --name root-suite -- mise run test
```

The fixtures replace privileged commands and root paths; this does not run the
container firewall against the host. Keep Docker archive fixtures free of macOS
AppleDouble metadata with `COPYFILE_DISABLE=1` and an explicit archive format.

### Execution policy qualification

The shared matrix in `tests/conformance/execution-policy/` checks resolver output,
adapter requests, and the policy projected into Agent Info. Container shapes
include optional provider sandboxes under both full and restricted firewalls.

Pi loads a fixture extension through the production SDK resource setup. Claude's
`conformance-execution-policy-live.test.ts` drives the pinned SDK's real CLI with
a scripted local model endpoint, including an unsandboxed control, an explicit
sandbox escape, an unlisted destination, and a failed sandbox launch. These tests
use temporary homes, fake credentials, and no external model service. macOS uses
an enclosing `sandbox-exec` profile to deny only the nested sandbox launch; Linux
removes sandbox dependencies from the child's PATH. Working sandbox dependencies
are required for the escape and network cases.

OpenCode and Grok conformance read actual fixture project configuration using
the pinned CLI's `debug config` and `inspect --json`. They discover the managed
binary in the normal toolchain directory, or accept explicit
`ORKESTRATOR_POLICY_OPENCODE_PATH` / `ORKESTRATOR_POLICY_GROK_PATH` paths. Explicit
paths must exist and report the pinned version. When a managed binary is absent,
those adapter cases are visibly skipped with an installation reason; resolver,
protocol and other adapter checks still run. Install both pinned CLIs for full
execution-policy qualification evidence. The fixtures do not read user credentials
or start a production backend.

## What the aggregate runner does

`mise run test` submits four independent groups to the host capacity queue:

| Group | Contents | Scheduling |
| --- | --- | --- |
| Workspace | Web, backend, desktop, public web, CLI, toolchain, and protocol package tests | Turbo runs at most two package tasks; each package gets two Bun workers when the budget is six or more, including the backend, capped at two while port and deadline-sensitive tests need higher-concurrency qualification |
| Root | Root renderer and repository-contract tests plus agent artifact and fixture-server support tests | Receives the remaining worker budget: one worker on a large host, up to two on smaller ones |
| Bridges | ACP, Claude, Codex, Cursor, and Pi bridge tests | Turbo runs two bridge tasks, each with one Bun worker |
| Protocol | Regeneration check for the committed Codex protocol lockfile | One independent command |

All cooperating runs share a host budget: one worker slot per logical core by
default (`ORKESTRATOR_TEST_HOST_WORKERS` may raise it to four per core), plus a
memory admission budget of 65% of physical memory. This suite still plans at
most eight Bun workers of its own, including the backend pool, whose
Node-preloaded integration suites do not load happy-dom. The larger host budget
lets other worktrees and review validations run beside it. The protocol check
reserves one slot too. Groups run together when they fit; smaller machines queue
groups instead of spawning extra workers.
The per-suite plan includes the protocol slot in its eight-slot ceiling.
Each ordinary group reserves an estimated 1 GiB per worker (bounded by the host
memory budget). These are admission estimates, not operating-system CPU or
memory limits; measure peak use before increasing concurrency.

The runner reports each group as soon as it finishes, but prints detailed
failure sections in a stable order. It waits for every group, so one failure
does not hide failures in groups that were already running.

`mise run test:all` runs the same four groups first. If they pass and the host is
macOS with Xcode available, it runs the iOS suite last and by itself because the
simulator is a shared machine resource. On other hosts it is equivalent to the
non-iOS suite.

The Playwright component suite and the real-stack agent suites are deliberately
not part of `mise run test`; they require different fixtures and, for agent
testing, an isolated running application profile. Select them using the table
above and [agent-testing.md](agent-testing.md).

## Where tests live

Put a test in the package that owns the code it exercises, so it runs with that
package's preload and is typechecked by that package's configuration:

| Code under test | Test location | Runtime |
| --- | --- | --- |
| `apps/backend/src` | Beside the source, or `apps/backend/tests/` for multi-module integration suites and shared fixtures | Node-only preload |
| `apps/desktop/electron` | `apps/desktop/tests/` (a few older suites sit beside the source) | Node-only preload |
| `packages/*`, `bridges/*` | Beside the source | Node-only preload |
| `apps/web/src` | Beside the source; older renderer suites remain under `tests/unit/` | Happy DOM and renderer mocks |
| Repository scripts, release configuration, documentation and cross-package contracts | `tests/unit/` | Happy DOM and renderer mocks |

The root `tests/` tree loads Happy DOM for every file. Happy DOM replaces
`fetch`, `Response`, `AbortController` and the timer and microtask queues,
and it reports errors thrown from its queues instead of letting them become
uncaught exceptions. A server-side test there is not exercising the runtime the
code ships in. `tests/unit/test-suite-ownership.test.ts` therefore rejects
root tests that import backend or desktop sources.

The same guard gives every test file exactly one owner. It derives the owners
from what actually runs: the aggregate's groups (`buildConcurrentGroups` in
`scripts/test-all.ts`) and each package's test selectors, not a list kept
beside them. A new test file that no suite selects, or that two suites select,
fails it.

### Controlled time

Wait for an explicit signal, not wall time. To skip an application delay,
capture it with `installControlledTimeout` (`tests/helpers/controlled-timeout.ts`,
tested by `tests/unit/controlled-timeout.test.ts`). It intercepts only timers
scheduled at one exact delay, leaving Testing Library, promises and unrelated
timers real, and it throws when more timers are pending at that delay than
expected (by default one, which suits a debounce) so a colliding module is not
captured by accident. `advance()` runs the captured timers, `pendingCount()`
says whether one is armed, and `restore()` reports any it drops. The
`GlobalSettings`, `PersistentTerminal`, `AddProjectDialog` and desktop
`BackendProcess` suites use it.

- A negative assertion needs evidence that its deadline has passed or cannot
  arrive: advance the captured timer, or show that none is armed. Do not
  shorten a sleep without that.
- Fake time in the parent cannot advance a child process; use an explicit
  completion signal or a controllable fixture boundary instead.
- Avoid global fake time across a real HTTP handshake.
- Never run all timers on loops that re-arm themselves (retries, polling).
- Install controlled time before rendering, advance inside `act`, settle the
  promises the advance triggers, and restore real time even when an assertion
  fails.
- Do not swap a sleep for an async query that waits the same wall time, and
  never change a production debounce or retry constant to make a test cheaper.

`mise run typecheck` covers every location: package tests through each
package's typecheck script (`tsconfig.test.json` in the backend and desktop),
root tests and `scripts/` through `tests/tsconfig.json`, and the browser and
agent specs through the two `e2e` configurations. Test code uses the same
strict options as the code it tests.

## Focused test commands

The standard focused form uses `test:logged`, which also places the command
under the output bounds and watchdogs described below. Because the wrapper is a
mise task, its nested `bun` uses the repository-pinned version. Pass an explicit
path and a bounded worker count:

```bash
# Root test
mise run test:logged -- --name root-example -- \
  bun test ./tests/unit/example.test.ts \
  --parallel=1 --only-failures

# Web test, using the web package's working directory
mise run test:logged -- --name web-example -- \
  bun test --cwd apps/web ./src/path/example.test.tsx \
  --parallel=2 --only-failures

# Backend test with the Node-only preload used by its package script
mise run test:logged -- --name backend-example -- \
  bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./src/core/example.test.ts \
  --parallel=1 --only-failures

# Desktop test, likewise from its package directory
mise run test:logged -- --name desktop-example -- \
  bun test --cwd apps/desktop \
  --preload ../../tests/setup-node.ts ./tests/example.test.ts \
  --parallel=1 --only-failures

# One bridge test
mise run test:logged -- --name codex-bridge-example -- \
  bun test ./bridges/codex-bridge/src/example.test.ts \
  --parallel=1 --only-failures
```

### Opt-in preview checks

Service preview checks that need Docker, a pinned framework, or a real
browser are skipped unless their variable is set. They use throwaway data
directories, CAs, and owner labels. Install the Vite fixture into an isolated
copy first (see `test-fixtures/preview-vite/README.md`).

```bash
# Real Docker: same-port containers, host decoy, recreation, docker exec relay.
# The image is required; the relay image defaults to it.
ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE=orkestrator-v2:latest \
  mise run test:logged -- --name preview-docker -- mise run test:preview:docker

# Real Chromium, Firefox and WebKit against private preview origins.
# Install the engines once: mise exec -- bunx playwright install chromium firefox webkit
# Add the Vite variable for HMR; --project=firefox or --grep can narrow the run.
ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite \
  mise run test:logged -- --name preview-browser -- mise run test:preview:browser

# Loopback route latency for the evidence log (prints one [preview-bench] line)
mise run test:preview:bench
```

The preview suite uses a browser-local loopback proxy, throwaway certificates
and fresh contexts; it changes neither system DNS nor the trust store. Chromium
pins the test leaf. Firefox and WebKit bypass certificate validation only in
those contexts. WebKit engine coverage does **not** qualify shipping Safari or
iOS. The suite covers sibling reads/frames, visible links, hostile workers and
same-service iframe returns through a synthetic external identity provider.

Live Tailscale Serve header preservation is a separate opt-in transport check:

```bash
ORKESTRATOR_TEST_TAILSCALE_SERVE_METADATA=1 \
  mise run test:logged -- --name tailscale-metadata-live -- \
  bun test --cwd apps/backend ./src/tailscale-serve-metadata.test.ts --parallel=1
```

It requires a signed-in tailnet node with HTTPS enabled and unused HTTPS port
18443 (`ORKESTRATOR_TEST_TAILSCALE_SERVE_PORT` overrides it). It creates a
synthetic loopback metadata receiver and a temporary, tailnet-only Serve root
handler. Existing listeners are refused, teardown removes only that handler,
and no tailnet names or credentials are recorded. It verifies `Sec-Fetch-Site`,
`Sec-Fetch-Mode`, `Sec-Fetch-Dest` and `Sec-Purpose` (including prefetch/prerender)
arrive unchanged, then evaluates the read policy on the received headers.
This is transport evidence; wildcard DNS, preview certificates and a browser
through `publicPort` still need the real deployment qualification in
[the two-machine runbook](preview-two-machine-runbook.md#5-publication-from-the-second-machine).

These opt-in scenarios do not run in `mise run test` or in CI. The preview
spec-loading check runs in the default suite; the live metadata case is
reported as skipped unless its opt-in variable is set.

The real Electron window with the desktop tunnel on needs no variable: it is
`e2e/agent-testing/service-preview-electron.spec.ts`, part of
`mise run test:agent:electron`. It launches Electron on a disposable
agent-test profile with `ORKESTRATOR_PREVIEW_TRANSPORT=1` (agent-test backends
keep that variable and `ORKESTRATOR_PREVIEW_RELAY`) and two preview-app
fixtures. Run it alone with
`bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`.

Record results in the evidence log of
[0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md#evidence-log).

### Opt-in design checks

Design export from a real running container (the shipped helper over
`docker exec -i`, `/workspace` on a `volume-nocopy` named volume, interrupted
by killing the client, stopping or restarting the container and emptying the
workspace) is skipped unless its image variable is set. The container and
volume carry a throwaway owner label and are removed by id.

```bash
ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE=orkestrator-v2:latest \
  mise run test:logged -- --name design-export-container -- bun test --cwd apps/backend \
  ./src/core/design/export-container.test.ts
```

### CLI scenarios

The published client has targeted scenarios that start isolated backends
through the packaged launcher (disposable data and worktree roots, no Electron
or Vite), drive the packaged `orkestrator` executable with argv only, assert on
JSON envelopes and authoritative state, and clean up what they created. The
package suite already runs a subset (`packages/cli/tests/cli-client.test.ts`);
the full matrix is a separate task:

```bash
# Credential-free: read-only, local-lifecycle, retry-and-retention,
# setup-failure, client-exit, exec, wrong-profile
mise run test:logged -- --name cli-scenarios -- mise run test:cli:scenarios

# One scenario, keeping its root for inspection on failure
mise run test:cli:scenarios -- --scenario exec --keep-on-failure

# Opt-in, credentialed, real tokens: one bounded turn plus a follow-up
ORKESTRATOR_SCENARIO_MODEL=gpt-5.6-sol \
  mise run test:cli:scenarios -- --scenario live-session --provider codex

# Container variants against this worktree's own image (never `latest`);
# docker:build:dev prints the tag it built
mise run docker:build:dev
mise run test:cli:scenarios -- --environment-type container \
  --docker-image orkestrator-v2:dev-<worktree hash>
```

`mise run test:agent:browser:isolated` includes `e2e/agent-testing/cli-ui.spec.ts`
(CLI changes seen by an open and a reloaded renderer). Its live question test
needs a profile started with Claude credentials:

```bash
mise run dev:test --profile qa-cli-live --fixture --credential-source claude --agent-platforms claude
ORKESTRATOR_AGENT_TEST_PROFILE=qa-cli-live ORKESTRATOR_AGENT_TEST_LIVE_CLI=1 \
  mise run test:agent:browser -- e2e/agent-testing/cli-ui.spec.ts
mise run dev:stop --profile qa-cli-live && mise run dev:reset --profile qa-cli-live
```

The run manifest (IDs, exit codes, stages — no prompts or tokens) is written to
`output/cli-scenarios/<run>/manifest.json`. Record live results in the
[evidence log](../todo/cli-and-slash-commands/0014-cli-qualification.md#evidence-log), against the coverage
table in [cli-testing.md](cli-testing.md#coverage-by-layer).
See [public-cli.md](../architecture/public-cli.md#targeted-scenarios).

To drive a running `dev:test` profile with the CLI during manual or agent QA,
follow [cli-testing.md](cli-testing.md).

For an intentionally unlogged interactive invocation, use `mise exec -- bun`
rather than an ambient Bun installation. Agent-operated validation should use
the logged form above.

Use `--parallel=1` when reproducing a failure or when the file owns a process,
port, or other shared fixture. Use `--parallel=2` for a small independent set.
The aggregate runner owns larger worker allocations; do not copy its maximum
into every command running alongside it.

`--parallel` isolates test files. A test that passes only after a sibling file
has installed a mock or global is not self-contained and should be fixed. Do not
reach for `--no-isolate` to preserve that accidental dependency.

Do not add Bun's `--no-orphans` flag indiscriminately. Some validation tests
intentionally spawn helpers that outlive their immediate parent long enough to
exercise supervision and cleanup. The repository runner instead places each
group in its own process group and terminates that whole tree if a watchdog
fires.

### Recurring-work harness

`apps/backend/scripts/recurring-baseline.ts` counts how often the backend's
recurring owners attempt work and the physical work that implies. Run it when
a change touches a cadence, a cache or join, admission, or a workflow or
observation driver (see [recurring-work.md](../architecture/recurring-work.md)).
It takes about 30 s and needs no Docker, Git remote, GitHub or provider.

```bash
# Print a fresh artifact; --out writes it, --overhead adds a real-time
# recorder cost measurement that comparisons ignore
mise exec -- bun apps/backend/scripts/recurring-baseline.ts \
  --out output/benchmarks/recurring-before.json

# After the change: list every counter that moved, or exit 1 on any difference
# to prove a change is observation-only
mise exec -- bun apps/backend/scripts/recurring-baseline.ts \
  --compare output/benchmarks/recurring-before.json --fail-on-change

# The harness's own determinism test
mise run test:logged -- --name recurring-baseline -- \
  bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./tests/recurring-baseline.test.ts \
  --parallel=1 --only-failures
```

Generate the reference before making the change; no artifact is committed
(`output/benchmarks/` is ignored by Git).

- **Driven owners.** The real `DiffStatsService` (diff scans and Files-panel
  list and tree reads behind the `git-docker-scan` pool), `GitFetchScheduler`,
  `ContainerGitFetchPolicy`, `PrMonitorService` (with a seeded jitter source)
  and `ClaudeStatePollManager` run on a manual monotonic clock with a fresh
  content-free recorder per scenario. Fake Git, `gh` and Docker seams charge
  the work units the production scanners perform per call (`PHYSICAL_COST` in
  `recurring-baseline-harness.ts`; update it alongside a scanner change).
- **Phases.** A 30 s startup phase and a separate 10 min warm-idle phase,
  longer than the 5 min fetch cooldowns. Each client models the Files panel
  open on the first environment, refreshing list and tree every 5 s.
- **Scenarios** (`DEFAULT_SCENARIOS`) vary environment count (1, 10, 50),
  local and container mix, 0 to 2 clients, PR mix (none, or cycled none,
  open, terminal) and 0 or 200 completed workflow records per store; ids such
  as `env10-mixed-c2-pr-wf200` encode those choices.
- **Modelled, not driven.** The activity jobs (native sweep, launch and queue
  scans, Claude state, tmux queues, mail, renames, coordinator repair,
  retention, lease expiry, tab cleanup) are reported under `modelledIdle` as
  nominal attempts from their catalogue cadence, never mixed with driven
  counters.
- **Driven blocks.** `nativeObservation` (`recurring-baseline-native.ts`)
  runs the real native activity sweep and queue scan against fake providers,
  in rollback and shared modes. `workflows` (`recurring-baseline-workflows.ts`)
  runs the real feature-planning, build-pipeline, looped-review and
  multi-review supervisors over a temporary store, in whole-store rollback and
  keyed modes. Multi review's real rollback, `WorkflowDueScheduler`, runs on
  real timers, so its legacy whole-store tick (`adaptiveScheduling: false`)
  stands in for it. Each domain reports `storageReads` (store content
  decoded, cached or not, and uncached row queries) beside `storageStats`
  (reuse of already-decoded records). The test holds every attempt to a
  per-domain budget (`STORAGE_PER_ATTEMPT` in `recurring-baseline.test.ts`),
  so one extra read per pass fails it.

It is a call-count model, not a profile. It does not measure durations, CPU,
RSS or I/O bytes; provider, transcript and storage cost behind the modelled
jobs; change-to-visible freshness against the
[latency budgets](../architecture/recurring-work.md#latency-budgets); renderer
polling other than the Files panel; or bridge-side recurrence. Those need the
live isolated profile tracked in
[0048-recurring-work-qualification.md](../todo/transcripts-and-observation/0048-recurring-work-qualification.md).
Live counters for a running backend come from `get_recurring_work_diagnostics`
or the `recurringWork` block of `/__orkestrator/metrics`.

#### Live idle A/B

`scripts/recurring-live-ab.ts` is the committed form of the live idle A/B.
Per arm and repeat it starts a disposable credential-free profile
(`dev:test --fixture --fixture-environments local,container
--no-agent-credentials`), waits for `ready`, settles for 60 s, and then samples
`recurringWork` plus the backend and Electron processes' CPU time and RSS
every 30 s over a 6-minute window (longer than the 5-minute container fetch
cooldown). It then times edit-to-detection: it appends to a tracked file in
each fixture environment and waits for the `diff-scan` `changed` counter to
move. Probes start at random offsets across one 15 s container poll period,
so they are not phase-locked to the poll. Last, it counts `Unhandled promise rejection (continuing)` guard lines in
the profile logs, stops the profile with `dev:stop` and resets it with
`dev:reset`. Each invocation adds a unique suffix to its profile names and
checks the owned launcher PID and start identity before sampling, stopping or
resetting. SIGINT and SIGTERM cancel active waits and requests, then wait for
owned-profile cleanup before exiting (130 and 143 respectively). Existing or
unverifiable profiles are refused. `--keep-profiles` retains stopped state.

Freshness probes require a valid pre-write metrics baseline; failed baselines
and counter resets are reported as unusable, outside the latency percentiles.
Kind rates use their first and last observed samples and label shortened
intervals partial; kinds that disappear remain in the report. A reset or
disappearance inside an observed interval invalidates that rate.

Arms are `candidate` (defaults), `rollback`
(`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all`,
`ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`) and `metrics-off`
(`ORKESTRATOR_RECURRING_METRICS=0`, CPU and RSS only). Build the CLI first; the
freshness probes use it.

```bash
mise run build:cli
mise exec -- bun scripts/recurring-live-ab.ts --arms candidate,rollback,metrics-off \
  --repeats 1 --out output/benchmarks/recurring-live-ab.json
```

Each run takes about 10 minutes. The JSON holds kinds, counts, durations and
process totals only. The script reads the gateway token from the profile's
auth file and sends it only as a loopback request header. Stdout is a Markdown
summary. Measured limits: the Electron window is a client (its renderer
polls), bridges and Docker are not in the CPU/RSS totals, and detection is
backend-side, a lower bound on change-to-visible.

For transcript, projection and storage cost, use the
[efficiency harness](efficiency-harness.md) (`mise run efficiency:baseline`).

## Logged commands and failure artifacts

The aggregate tasks already run through the bounded log infrastructure. Use
the same infrastructure for a focused test, typecheck, build, smoke test, or
Playwright command when persistent failure evidence is useful:

```bash
mise run test:logged -- --name changed-component -- \
  bun --cwd=apps/web test ./src/path/ChangedComponent.test.tsx \
  --parallel=2 --only-failures

mise run test:logged -- --name web-typecheck -- \
  bun run --cwd apps/web typecheck

mise run test:logged -- --name agent-browser -- \
  mise run test:agent:browser:isolated
```

Run checks separately so each exit status and artifact belongs to one command.
The logged wrapper above is for manual evidence capture. Review discovery uses
the registered one-shot command verbatim, without the logging wrapper.
Do not add `tee`: it duplicates potentially large or sensitive output while the
runner is already retaining a bounded copy.

On success, raw logs are deleted and only `summary.json` remains. On failure,
the runner prints a unique `orkestrator-test-run.*` directory below the
platform temporary directory. It compresses each group's log and keeps a small
JSON summary. Inspect the printed directory rather than rerunning merely to
recover output:

```bash
ORK_TEST_ARTIFACT_DIR=/path/printed/by/the/runner
jq . "$ORK_TEST_ARTIFACT_DIR/summary.json"
gzip -cd "$ORK_TEST_ARTIFACT_DIR/root-and-agent-support-tests.log.gz" \
  | tail -n 200
```

The limits are:

| Resource | Default behavior |
| --- | --- |
| Persisted output | 64 MiB per command group, then terminate the group |
| Failure tail printed to the terminal | 256 KiB |
| Failure reports printed after the tail | Every `(fail)` line with up to 40 preceding lines of its own task, at most 25 per group |
| No-output watchdog | 5 minutes |
| Absolute group deadline | 30 minutes, or 60 minutes for the iOS group |
| Permissions | Directory `0700`, files `0600` |
| Retention | Completed run directories expire after 7 days |

A noisy group can push a failure out of the 256 KiB tail. The runner therefore
also keeps Bun's report for every failing test it sees, wherever it appeared.
That report is the `(fail)` line plus the preceding error, expectation and
stack lines. Context comes only from lines with the same Turbo task prefix,
because streamed tasks interleave. These reports print under `--- Failing tests
in <group> ---` after the tail, and every tail line is capped at 2,000
characters: one longer line once cut the GitHub Actions log off before the
reports. On GitHub Actions, `ci.yml` points
`ORKESTRATOR_TEST_LOG_DIR` at the runner's temporary directory and uploads the
compressed logs as the `test-logs-<run>-<attempt>` artifact when the job fails.

The process exit status and `summary.json` status are authoritative. Expected
error text can appear in passing tests that exercise failure handling, so a
text search is only diagnostic.

`ORKESTRATOR_TEST_LOG_DIR` directs artifacts to a specific private directory.
When setting it, the caller owns its cleanup and must not share it between
concurrent commands. `ORKESTRATOR_TEST_MAX_OUTPUT_BYTES` lowers or raises the
per-group output ceiling. Do not raise the limit simply to retain recursive DOM
or object dumps; fix the assertion or logging source instead.

## Watchdogs and stuck processes

Every aggregate group and `test:logged` child has two watchdogs:

- No output for five minutes is treated as a stalled command. This is only a
  meaningful signal because every group streams its child output as it happens.
  Turbo's `--output-logs=errors-only` would buffer a whole run into one silent
  window and get a healthy slow group killed, so the aggregate groups do not
  use it. Turbo's default log order does the same per task in CI, so the groups
  also pin `--log-order=stream`.
- Thirty minutes of total group time is treated as a runaway command even if it
  continues to print output. The iOS group builds and boots a simulator and
  carries its own sixty-minute budget instead.

When either fires, the runner sends `SIGTERM` to the command's process group and
then `SIGKILL` after one second. That cleans up Bun workers, Turbo children, and
spawned fixtures rather than leaving them to slow later runs. The failure
summary records `timeoutReason` as `no-progress` or `absolute`.

Because each group runs in its own process group, the terminal's Ctrl+C reaches
the runner and nothing else. The runner relays it: on `SIGINT`, `SIGTERM`, or
`SIGHUP` it terminates every live group tree, escalates to `SIGKILL` after two
seconds, and cancels queued groups. Reservations remain occupied until their
registered process groups have drained. A second Ctrl+C stops the runner
immediately; the next scheduler participant drains its registered orphan groups
before reclaiming their slots.

For a known, legitimate long-running diagnostic, override only the necessary
limit for that invocation, in milliseconds:

```bash
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=900000 \
ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=1200000 \
mise run test:logged -- --name long-diagnostic -- command arg
```

Do not make a larger limit the normal configuration. The deadline exists to
catch a wedged run, not a slow one: the slowest group measured on the reference
host is the workspace group at roughly four minutes on a cold cache. A default
`mise run test` that gets anywhere near thirty minutes needs investigation
rather than a raised limit.

If an interrupted manual command leaves a process behind, identify it by its
exact command, working directory, PID, or owned port before stopping it. Never
kill by a broad executable name because other worktrees and agent profiles may
be using the same runtime.

## Host capacity queue

`mise run test`, `test:changed`, and `test:all` no longer reject a second suite
because another worktree is testing. They print `QUEUED`, then `RUNNING` when
capacity is granted. Group watchdogs start only after admission. The private
SQLite queue is shared by local worktrees, repositories, agent platforms, and
terminals for the same OS user. Transactions own admission; no UI or central
daemon must remain mounted or connected.

Worker and memory reservations are fixed for each running group. Worktrees
take fair turns, with FIFO ordering within a worktree. When the next eligible
request is too large for the remaining capacity, it holds its place rather
than allowing a stream of smaller jobs to starve it. A bounded exception allows
an already-running resource holder's cohort to finish compatible work in spare
slots (at most 32 admissions past any blocked request, FIFO within each worktree).
Unrelated small jobs cannot bypass the waiter. This can deliberately leave some
slots idle briefly. Repeated instances of the same group in one
worktree also share an exclusive resource; iOS excludes every host job.

Queueing is cancellable and bounded: the default wait budget is 30 minutes,
separate from execution watchdogs. A wait expiry or unavailable queue yields
`INCOMPLETE`, never a passing result or an assertion-failure claim. Queue-only
failures exit `75`; partial assertion failures remain visible in captured logs.
The queue contains at most 256 reservations. Dead owners are not redispatched;
their registered child groups are drained before capacity is returned.

Configuration (use the same settings in all participating launchers):

| Environment variable | Purpose |
| --- | --- |
| `ORKESTRATOR_TEST_HOST_WORKERS` | Set the host ceiling (default 8; capped at logical CPUs minus 2, minimum 1, maximum 64) |
| `ORKESTRATOR_TEST_HOST_MEMORY_MIB` | Lower the estimated host memory budget |
| `ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS` | Wait deadline, from 1 second to 2 hours |
| `ORKESTRATOR_TEST_SCHEDULER_DIR` | Private same-user SQLite directory; normally leave unset |
| `ORKESTRATOR_COOPERATIVE_STARTUP_MS` | First-publish allowance before a cooperative runner is treated as stalled |
| `ORKESTRATOR_COOPERATIVE_STALE_MS` | Silence after its last channel read before a cooperative runner is treated as stalled |

The host ceiling and per-suite ceiling are separate. To evaluate more host
parallelism, set `ORKESTRATOR_TEST_HOST_WORKERS=10` (or 12 on a sufficiently large
host) consistently in all launchers, keeping the per-suite layout bounded. Compare
cold and warm multi-worktree completion times, memory pressure/swap, process-tree
peak memory, responsiveness, and test failures before adopting a higher setting.
CPU percentage alone does not measure safe available capacity.

An active queue keeps its original budget; changed settings apply when idle.
The old `ORKESTRATOR_TEST_ALLOW_CONCURRENT` override no longer bypasses admission.
Older worktrees that still use the fail-fast lease must be updated to participate
in the new queue. Direct focused tests and unrelated dev servers do not reserve
capacity automatically. A Docker container is a separate scheduler namespace;
this is not a distributed scheduler or a physical-host container quota manager.

### Multi Review validation

Non-cooperative review commands use their declared absolute timeout by default;
silence alone is not evidence that a compiler, build, or integration stage is
stuck. An exact repository `commandProfiles` entry may opt a lifecycle command
into a `noProgressTimeoutMs` watchdog (bounded from one second to two hours).
`ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS` overrides that value only for commands
that already opted in; it does not add a watchdog to arbitrary discovered
commands. The clock starts after capacity admission and resets on stdout or
stderr bytes, so queue waits do not consume it. A declared stall produces
incomplete evidence, terminates the process group, and records the reason.
`lastOutputAt` is persisted in each command result for status/reconnect readers
without retaining output content in status metadata. Cooperative commands
continue to use their scheduler heartbeat and execution clock instead.

For service-backed browser checks, select the exact one-shot tasks documented
above. `dev:test` stays attached after readiness and is never a sequential setup
step before Playwright. Do not invent foreground lifecycle shell wrappers.

The environment-owned worker persists queued/running command states and separate
queue/execution durations alongside its heartbeat. Switching environments,
closing the validation view, or reconnecting the backend does not start another
command; the UI rehydrates from that state. Cancellation removes pending tickets
and terminates owned processes. A stale worker remains uncertain until explicitly
cancelled, never automatically retried.

A single command can also be stopped from its row in the validation table
(`stop_review_validation_command`). The control writes a per-command tombstone
beside the run's state, so the request survives backend restarts. The worker
terminates that command's process group, keeps its partial output, and records
it as `incomplete` with a user-stop limitation; a command that has not started
yet is recorded as `incomplete` without running. Commands that depend on it are
skipped, and every other command continues, so the run still completes and its
partial evidence is packaged for review.

Discovery scopes the plan to the change. It reads `AGENTS.md` (and
`CLAUDE.md` or equivalents) at the root and in changed directories and follows
their guidance on which suites a given kind of change needs, omitting suites for
areas the change cannot affect and naming the omission in one limitation. When
the instructions require a suite for every change, or the change's reach is
uncertain, the full relevant coverage runs.

Ordinary discovered commands are sized in this order: an exact repository
`commandProfiles` entry, then the command's measured CPU use, then discovery's
weight (four slots for `weight: 1`, eight for `weight: 2`). After each
undisturbed run of at least a second, the worker records the command's average
parallelism (CPU time of its reaped descendants over wall time, from bash's
`times`) in the host scheduler database, keyed by repository, directory and
command. Later requests reserve the busiest of its last five runs, rounded up,
so every worktree of the repository benefits. The validation table shows each
command's average cores and the slots it held, which is how to spot commands
that reserve more than they use.

Slots are elastic. A request carries a floor (`minWorkers` in a profile, or a
quarter of its size by default) and starts with whatever is free above that
floor instead of waiting for its whole estimate. Memory and exclusive resources
are not elastic and must fit whole. Later jobs may backfill around a blocked
job; a blocked job counts only overtaking that competes with it (for capacity it
is short of, or for one of its resources), and after 32 such bypasses it holds
its turn until it fits. One validation run executes at most two heavy or four
light commands at once; host admission governs everything beyond that.

Exact repository `commandProfiles` can declare `workers`, `minWorkers` and
`memoryMiB` requirements for known commands. These are estimates, not OS limits.
A profile describes what a command wants, not what the host has: a requirement
larger than the frozen host budget is clamped down to it rather than refused, so
a lowered ceiling slows a command instead of making it permanently incomplete.

Use `workspace:` resource names for workspace-local directories and services, and
`workspace:*` to exclude other commands in the same worktree. Use `host:` names
for shared ports, databases, or simulators; `host:*` excludes the whole host.
Legacy unprefixed names and `*` retain host scope so older discovered plans do
not silently lose exclusions. Repository-owned profiles override discovery's
resource guesses for exact root-directory commands.

This repository declares its aggregate commands in
`.orkestrator-test-scheduler.json`. They reserve their constituent groups and
publish bounded scheduling state through a private per-command channel, avoiding
double reservations. `cooperativeCommands` lists eligible alternatives, not a
checklist. `commandProfiles[command].covers` explicitly declares overlapping
coverage: when both commands appear, the worker runs the covering command once,
then records the redundant entry as skipped with its covering command ID. Failed
coverage remains incomplete. Coverage is deduplicated only when the covering
command also depends on the required prerequisites and no dependency cycle is
introduced. Dependent checks wait for the actual covering result. The original plan stays immutable.
A repeated identical command (the same command line and directory) is covered
by its first copy the same way, recorded as `(identical command)`, unless the
repeat waits on a prerequisite the first copy did not, which may make the rerun
meaningful. Discovery is also told never to plan a command twice.

A missing `.orkestrator-test-scheduler.json` is normal and silent. One that is
present but unreadable, oversized, or invalid is *ignored* rather than fatal:
the run continues with no cooperative commands and no profiles, and reports the
reason (naming the file) on the run itself. Losing cooperative scheduling is a
degraded run; losing every command's evidence to a config typo is not acceptable.

Command timing counts wall time once: intervals with any executing group count
as execution; intervals with only waiting groups count as queued; setup and idle
gaps count as neither. Each ticket also keeps its own queue deadline. Parallel
work never multiplies command timeouts. Older runner channels without the wall
clock marker are timed from their observed state by the validation worker.

Queue explanations (resource holder, worker slots, estimated memory, or fairness)
are persisted with command results and survive inactive views and reconnects.
Only bounded hashed worktree identifiers, process IDs, and resource counts appear
in diagnostics, never command contents or credentials.

A cooperative runner's startup (shell profile, toolchain resolution, transpilation) is allowed
a generous first-publish window before it is considered stalled; staleness is
then measured from its last successful read, not from spawn. A missing or stale
cooperative heartbeat makes validation incomplete.
Declared exclusive resources also reach those groups: constituents of one
command may share them internally, but another command cannot use them while
an owning group is running.

Discovery must use selected entries verbatim as separate commands, choosing the
smallest non-overlapping set that satisfies the repository requirements. An
unconfigured wrapper that launches an aggregate runner while holding its own reservation
stops with an explicit infrastructure limitation (exit 75), instead of waiting
for its own capacity forever. Declare the wrapper's cooperation before using it.

After admission, the worker (and each cooperative group) rechecks HEAD.
Changed snapshots require rediscovery rather than certifying stale code. One
validation run still feeds the round's shared, hashed, immutable review artifacts;
reviewers do not each launch full suites. `incomplete` evidence carries a reason
and any partial logs. Reviewers must report that gap as a limitation, not invent
a failed test or claim full validation passed.

## Caching and duration history

Workspace and bridge package tests run as Turbo tasks, but both are declared
`"cache": false`. A replayed cache entry would let a group report success having
executed nothing, and this repository still tracks live flakes in
`docs/tests/flaky-tests/0000-index.md`, so a green that proves only "the inputs are unchanged" is
not worth the seconds it saves. Every aggregate invocation runs every test.

`build` stays cacheable, and it is the expensive dependency. Only the backend
and CLI `test:workspace` tasks depend on it, through the root `turbo.json`,
because `apps/backend/tests/standalone.test.ts` and
`packages/cli/tests/cli.test.ts` consume `dist`. Web, web-public, desktop and
protocol override `dependsOn` to `[]` in their own `turbo.json`: their tests
consume no build output. The workspace group asks Turbo for `build` and
`test:workspace` in one invocation, so every build still runs while
independent tests overlap it, and a warm run skips the rebuilds. Both test
tasks keep their `inputs` declarations, which name the shared Bun configuration
and preload files alongside the package files, so the wiring is already correct
if caching is ever reconsidered.

Turborepo 2.8 automatically shares its local cache across linked Git worktrees
when no explicit cache directory is configured. Do not add a relative
`--cache-dir .turbo` or `cacheDir` setting: an explicit relative directory
disables that worktree sharing and turns each new agent worktree into a cold
build. CI still needs to restore a local cache or use remote caching because a
fresh checkout has no local cache to share.

The aggregate groups pass `--output-logs=new-only`, which streams the output of
every executing task and hides only replayed build logs. Streaming is what keeps
the no-progress watchdog meaningful, and it is why a passing group's log still
shows real per-package test counts. They also pass `--log-order=stream`: Turbo's
default `auto` order becomes `grouped` whenever it detects CI, which holds a
task's output until the task exits. On a four-core GitHub runner the backend
package runs on one Bun worker for longer than the five-minute watchdog, so
grouped output got it killed on every CI run.

`--continue=dependencies-successful` keeps a failing package from cancelling
the rest of its group, so one run reports every failing package. A task whose
own dependency failed still does not start.

Turbo runs each package script from that package's directory, and Bun reads
`bunfig.toml` from the invocation directory without walking up to the repository
root. Backend, desktop, package and bridge test scripts therefore name the
Node-only preload explicitly with `--preload ../../tests/setup-node.ts`.
Dropping it is not a silent no-op: it is what sets `CODEX_BRIDGE_NO_SERVER`,
isolates the git configuration and the worktree root, and installs the bounded
diagnostics, so without it the codex bridge suite binds a real port and fails.
`apps/backend/bunfig.toml` names the same preload, so a bare `bun test <file>`
from `apps/backend` is isolated too; Bun loads a preload named in both places
once. Without it a backend test fell back to `ORKESTRATOR_WORKTREE_DIR` from
the shell, or to a non-canonical `os.tmpdir()` such as macOS `/tmp`.

The runner also keeps Bun timing profiles in a private temporary directory
keyed by the Git common directory and worktree path. Bun updates these files after each aggregate
run and uses them to schedule slow files earlier on future runs. The profiles
are reused within a worktree and contain durations, not test output. Separate
worktrees have separate writable profiles so concurrent runs cannot corrupt
each other's timing files. Do not point concurrent worktrees at the same
`ORKESTRATOR_TEST_TIMINGS_DIR` override. Turbo's immutable build cache remains
shared across worktrees.

When comparing performance, record whether the run was cold or warm, the commit,
the host's logical core count, and whether a development profile or another
focused suite was active. On the 18-core reference machine, the measured
post-change runs were about 188 seconds cold and 75 seconds warm; these are
diagnostic reference points, not fixed pass criteria.

## Parallel isolation and Bun module mocks

The suite is dominated by I/O waits (tests that boot real backend processes, bind
ports, drive happy-dom) rather than CPU, so it parallelizes well:

- **Within a group** — `bun test --parallel` spreads test *files* across worker
  processes. This is where nearly all of the win is (the root suite alone goes
  from ~100s to ~30s).
- **Across groups** — `scripts/test-all.ts` runs the workspace, root, bridge and
  protocol groups concurrently, with bounded worker pools (`planWorkers`) so
  the three worker-consuming groups cannot oversubscribe a small CI runner.
  Larger hosts give each package task a second worker while keeping at most
  two package tasks active; the root group takes the remainder. iOS is opt-in through `test:all` and runs
  last and alone because the simulator is a single shared resource.

Group output streams to private bounded files while only a failure tail and the
Bun failure reports stay in memory. Passing groups print a summary; failing
groups print both and retain compressed artifacts. **Every** failing group is reported rather than stopping at the first.

Always add `--parallel` when running a suite directly; a sequential run of
`tests/` takes roughly three times as long.

**`--parallel` implies `--isolate`.** Each test file gets a fresh module registry,
which removes the cross-file `mock.module()` leakage described below — but it also
means a test that only passed because a *sibling* file had mutated a global will
now fail. That is a real bug being exposed, not a parallelism problem: fix the
test to set up what it needs itself. `bridges/claude-bridge/src/routes/events.test.ts`
is the worked example — it guarded its `globalThis.TransformStream` polyfill with
`if (!globalThis.TransformStream)`, so it silently depended on another suite
installing that global first.

Before assuming a parallel-only failure is a race, run the file on its own:

```bash
bun test path/to/one.test.ts   # if this fails alone, it was never self-sufficient
```

### Bun `mock.module()` rules

Bun's module mocking is **global at the module-cache level**. In this repo, top-level `mock.module()` calls can leak across test files even when `mock.restore()` is used later.

Use this stable pattern:

1. Put truly shared mocks in `tests/setup.ts`.
   - Example: native wrapper mocks from `@/lib/native/*` are registered once there so files do not fight over competing global mocks.
2. If some tests need a mocked module but other tests need the real module, keep the module real in `tests/setup.ts` and put **shared mock functions** in `tests/mocks/*`.
   - Example: `tests/mocks/clipboard-paste.ts` exports reusable mock functions, and `terminal-paste.test.ts` wires them up per-file with `mock.module(...)`.
3. Prefer mocking narrow dependencies, not broad app modules or shared UI components.
   - Avoid top-level mocks for modules like `@/components/chat/NativeMessage` unless the whole suite should use that fake. These are especially likely to pollute unrelated tests.
4. Do not assume `mock.restore()` fixes module-cache pollution.
   - It is useful for resetting function state, but it is not a reliable isolation boundary for `mock.module(...)` in Bun.
5. Before adding a new `mock.module(...)`, search for existing comments/patterns in `tests/setup.ts` and `tests/mocks/`.
   - If the same module is mocked in multiple files, centralize it or convert to shared mock functions.

### Snapshot-and-restore pattern for unavoidable sibling-component stubs

When a test *must* stub a sibling component that has its own test file (e.g. `ChatTab.test.tsx` stubbing `./ComposeBar`, when `ComposeBar.test.tsx` needs the real module), snapshot the real module before installing the stub and restore it in `afterAll`. Bun caches the first `mock.module` factory result, but a subsequent `mock.module(path, () => snapshot)` call does override the cache for future imports.

```typescript
import { afterAll, mock } from "bun:test";

// 1. Snapshot the real module BEFORE any mock.module call that would replace it.
import * as realComposeBar from "./ComposeBar";
const realComposeBarSnapshot = { ...realComposeBar };

// 2. Install the stub.
mock.module("./ComposeBar", () => ({ ComposeBar: () => <button>Stub</button> }));

// 3. Restore when this file's tests finish so later files see the real module.
afterAll(() => {
  mock.module("./ComposeBar", () => realComposeBarSnapshot);
});
```

Use this only as a last resort — prefer not mocking sibling components at all when feasible (see rule 3 above).

## Diagnose a failure

Use this order:

1. Read the aggregate summary to identify the failing group and whether a
   watchdog or output bound fired.
2. Inspect the compressed failure tail from the printed artifact directory.
3. Rerun the owning file alone with the same relevant environment and
   `--parallel=1`.
4. If it fails alone, diagnose the test or product behavior. If it passes alone
   after failing in the normal aggregate or parallel suite, treat it as a
   credible flake and follow the repository flake workflow.
5. Rerun the affected group or `mise run test:changed`; finish with the full
   suite once the cause is addressed.

Keep [the flake registry](../tests/flaky-tests/0000-index.md) current for
credible flakes. Its top-level index only lists the ten group folders; each
group's own `0000-index.md` table tracks its cases. Search the group indexes
first; open only the matching case file.
Record the exact test and file, original command and worker configuration,
failure message and duration, suite counts, isolated rerun command and result,
observation date, and an evidence-backed hypothesis. Do not skip, loosen, or
delete a test to hide an intermittent failure. When fixed, retain the case-file
history and mark the index row resolved with stress or parallel verification.

Aggregate runs remove ambient bridge debug flags before spawning their groups:
`ORKESTRATOR_BRIDGE_DEBUG`, `CLAUDE_BRIDGE_DEBUG`, `CODEX_BRIDGE_DEBUG`,
`ACP_BRIDGE_DEBUG`, `PI_BRIDGE_DEBUG`, and `CURSOR_BRIDGE_DEBUG`. This prevents
a development profile's diagnostics from changing authoritative test inputs.
If a focused reproduction needs one of those flags, set it explicitly on that
focused command and record it with the result.

## Verification by change type

Use the default suite plus the additional evidence relevant to the change:

| Change | Minimum additional verification |
| --- | --- |
| Test runner, package scripts, Turbo configuration | Focused runner unit tests, then both cold-enough and warm `mise run test` observations |
| Backend, protocol, or bridge | Owning file/package tests; exercise subprocess cleanup when lifecycle code changed |
| React component or store | Owning component/store tests and `mise run test:browser` when browser behavior matters |
| User-visible or background renderer flow | Isolated-stack browser cycle, including inactive-environment rehydration |
| Electron main/preload/IPC | Focused Electron tests plus `mise run test:agent:electron` |
| Docker lifecycle or ownership | Local fixture coverage plus `mise run test:agent:docker` |
| iOS | `mise run test:all` on macOS with Xcode, or report that iOS was not run |

For real-stack flows, artifact handling, authentication, and safe profile
cleanup, follow [agent-testing.md](agent-testing.md). Stop and reset profiles
after the run unless their retained state is explicitly part of the evidence.
