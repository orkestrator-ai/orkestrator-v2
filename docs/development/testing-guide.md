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
| Test the repository | `mise run test` | Authoritative default, non-iOS validation before handoff; excludes the [slow tier](#test-tiers). Only pre-review implementation workers skip it when Multi Review or a build pipeline comes next; review preparation must schedule it when applicable |
| Test the slow tier | `mise run test:slow` | On demand only: tests that wait on real processes, servers, or wall-clock time |
| Test both tiers | `mise run test:full` | What CI runs; default and slow tiers |
| Test everything, including iOS | `mise run test:all` | Release-sensitive or iOS validation on a Mac with Xcode |
| Check format, lint, and types | `mise run test:logged -- --name check -- mise run check` | Static validation; this does not run tests |
| Run browser component tests | `mise run test:logged -- --name browser -- mise run test:browser` | Playwright component/browser coverage |
| Run isolated-stack agent tests | `mise run test:agent:browser:isolated` | Creates a disposable profile, runs browser tests, and cleans up |
| Run design-only real-stack tests | `mise run test:agent:design:isolated` | Same lifecycle, only `design-canvas.spec.ts` |
| Run Electron agent tests | `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` | Main process, preload, IPC, clipboard, and shutdown. Needs a display; on a shared Linux host use a disposable one ([agent-testing.md](agent-testing.md#electron-specs-and-their-display)) |
| Qualify the shipping package's fuses and dev-mode gate | `mise run test:logged -- --name package-security -- mise run test:package:security` | Unsigned local shipping `--dir` build of this host, fuses read from the binary, hostile-launch smoke ([agent-testing.md](agent-testing.md#packaged-app-electron-spec)) |
| Run the packaged-app Electron test | `mise run package:linux:unpacked` and `mise run package:linux:unpacked:test`, then `mise run test:logged -- --name agent-electron-packaged -- mise run test:agent:electron:packaged` | Shipping security smoke (macOS/Linux) and Linux design journey against the packaged `file://` renderer on disposable profiles ([agent-testing.md](agent-testing.md#packaged-app-electron-spec)) |
| Run Docker agent tests | `mise run test:logged -- --name agent-docker -- mise run test:agent:docker` | Opt-in container ownership and fixture coverage |
| Qualify live paused interactions | `mise run test:logged -- --name paused-interactions-live -- mise run test:agent:paused-interactions` | Opt-in billed turns in a disposable profile; set `ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1` ([agent-testing.md](agent-testing.md#live-paused-interactions)) |
| Run the live coordinator suite | `mise run test:agent:coordinator --credential-source <platform>` | Manual and opt-in: real provider turns, one disposable profile per platform ([agent-testing.md](agent-testing.md#live-coordinator-suite)) |

Choose validation scope using [AGENTS.md](../../AGENTS.md#choosing-validation-for-a-change)
before applying this loop. Documentation-only changes need only
`mise run format:check`.

Only pre-review implementation workers defer the full pass when Multi Review
or a build pipeline follows. Review preparation must discover and schedule every
applicable validation command from AGENTS.md, including `mise run test`, once
against the committed branch. The worker exemption does not apply to preparation
and must never cause preparation to defer its own validation to a later review.
When no review follows, implementation workers run the required full validation.

A normal code implementation loop is:

1. Run the owning test file while iterating.
2. Run `mise run test:changed` after the local behavior is green.
3. Run `mise run check` through `test:logged` and run `mise run test` before
   handoff, except for pre-review implementation workers as described above.
4. Add the relevant browser, agent, Docker, or iOS suite when the changed area
   requires it.

### Test tiers

The default suite is meant to be deterministic: its outcome should not depend
on how busy the host is. Test files that wait on something outside the test
process — real Git, tmux, Chromium, agent CLIs, servers, sockets, or
wall-clock sleeps and long timeouts — form the slow tier, declared in
`scripts/test-tiers.ts`. `*-live.test.ts`, `*.live.test.ts`, and
`*.integration.test.ts` files are slow by name in the root group and in every
package that has such files (backend, desktop, protocol, and the Claude, Codex
and Pi bridges). A unit test of a `scripts/*-live.ts` benchmark is named
`*-live-script.test.ts` so that it stays in the default tier.

When a file mixes cheap checks with real processes, split it rather than
moving the cheap checks too: for example `firewall-egress-filter-names` and
`workspace-setup-script-contract` stay in the default tier beside their
slow-tier siblings. Before moving a file, consolidate repeated expensive setup
(build a fixture once and copy it per test, or evaluate many cases in one
shell) so the slow tier stays fast as well.

- `mise run test` runs the default tier and prints how to run the rest.
- `mise run test:slow` runs only the slow tier. Run it on demand, for example
  when changing the subsystems those tests drive; for one owning file, run that
  file directly through `test:logged`.
- `mise run test:full` (CI) and `mise run test:all` run both tiers.

Each package's `test:workspace` or `test:bridge` script calls
`scripts/bun-test-tier.ts`, which reads `ORKESTRATOR_TEST_TIER`
(`default`, `slow`, or `all`) and either ignores the package's slow files or
runs only them.

Package scripts start the tier wrapper with `bun --no-env-file`, so the wrapper
does not preload development dotenv values into the test process. Its child
`bun test` loads `.env.test` with the normal test precedence; explicitly inherited
environment variables still take priority.

Prefer making a slow test deterministic (fake clocks, in-process fakes) over
adding it to the slow tier. Add a file to the tier when it genuinely needs real
processes or time; the list started from files whose median duration was 3 s
or more across recent aggregate runs.

Only one complete aggregate run (`test`, `test:slow`, `test:full`, `test:all`)
holds the host at a time. Its groups share a host-wide scheduler resource, so
another worktree's complete run queues until the first finishes; overlapping
suites made every run slower and pushed subprocess tests into timeouts.
`test:changed` is exempt, and `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1` opts a run
out.

`test:changed` is an optimization, not final proof. It uses Turbo's affected
package graph and Bun's changes from the local `main` ref. Configuration files,
dynamic coupling, generated artifacts, or a stale local `main` can make a
change's true impact wider than the selected set.

Never use a bare `bun test` at the repository root. Without an explicit `./`
path, Bun treats arguments as discovery filters and can collect Playwright
specifications, package tests, and intentionally malformed fixtures. Use
`mise run test` for the default suite or prefix a focused path with `./`.

For a focused web or backend owner, select its package directory, for example
`bun test --cwd apps/backend ./src/core/pr-monitor-agent-completion.integration.test.ts --parallel=1`.
The root `bunfig.toml` excludes these package trees, so a root-relative app
filter can match no tests. Put `--cwd` after `test`: `bun --cwd apps/backend test`
dispatches the package's `test` script instead, broadening discovery to the
package suite. Run focused commands through `test:logged` as above.

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
build of the public client. On Linux both suites run in a private loopback-only
network namespace (`scripts/loopback-network.ts`), so other builds' Docker
networks cannot abort their page loads (flake
[2340](../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md));
set `ORKESTRATOR_E2E_HOST_NETWORK=1` to keep them on the host network. To run only that smoke flow:

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

### Other browser engines

The component suite runs in Chromium. For a qualification run in Safari's engine,
set `ORKESTRATOR_E2E_BROWSER=webkit` (or `firefox`). The `mobile-chromium` and
`desktop-chromium` project names still name the viewport profile:

```bash
ORKESTRATOR_E2E_BROWSER=webkit mise run test:logged -- --name browser-webkit -- \
  bunx playwright test --config e2e/playwright.config.ts \
  e2e/PaneBreakpoint.spec.ts e2e/EnvironmentSettingsDrawer.spec.ts
```

The native datalist popup spec is skipped on alternate engines, as are
CDP touch-input cases. Engine checks use `browserName`, independently of the
viewport project name.

Playwright's WebKit has no `moveBefore`, so it exercises the stable-host
`appendChild` fallback natively. It runs on the host, so it does not stand in
for iOS Safari on a device or simulator. Install it with
`mise exec -- bunx playwright install webkit`. Assertions on Electron-only CSS
such as `-webkit-app-region` only run under Chromium.

CI runs `MobileAppShellLayout.spec.ts` in Chromium and WebKit, including native
touch compatibility-event suppression and Chromium's CDP pen input. The same
matrix also runs the overview scroll-preservation cases from `PipelineFlow.spec.ts`
and `GraphRunFlow.spec.ts` in both viewport layouts. Other component specs and
alternate-engine qualification remain opt-in. When an engine
run finds a bug, also add a unit test that fails without the fix. Touch handling
is the usual case:
WebKit and iOS Safari never focus a tapped button, so a dismissal that only
works through Chromium's focus blur passes in Chromium and fails there.

### Native browser controls

`e2e/AgentLaunchDialog.spec.ts` covers the branch field's input/datalist in
every engine: the `list` link, the options, and that a chosen suggestion reaches
the confirmed selection. It chooses one with `fill`, since a suggestion taken
from the popup only sets the value and fires `input`.

`e2e/AgentLaunchDialogNativePopup.spec.ts` drives Chromium's own datalist popup
with the keyboard (todo 1171). The popup is browser UI, outside the page, so
three settings matter:

- `channel: "chromium"` runs the full bundled build in Chrome's new headless
  mode. The default headless shell has no autofill popup. A headed window only
  gets one while it has focus, which a locked or unattended macOS desktop never
  gives it: Chrome drops the popup with `kNoFrameHasFocus`.
- `--screen-info={0,0 2000x2000}`. New headless mode's default 800x600 screen
  leaves no room below the field, so Chrome drops the popup with
  `kInsufficientSpace`.
- Keys go through CDP `Input.dispatchKeyEvent` as `rawKeyDown` with the native
  key code on macOS (ArrowDown 125, Enter 36) and Linux (XKB codes 116 and
  36). Omitting Linux native codes also closes the popup with `kViewDestroyed`.
  Playwright's macOS `press` adds editing commands, so the spec sends CDP keys
  without those commands.

On failure the spec appends Chrome's `Autofill.PopupHidingReason.DataList`
histogram, which names why the popup closed. `kAcceptSuggestion` is the
expected one.

The bundled Chromium itself needs no manual step. `test:browser`, the
`test:agent:browser*` tasks, `test:agent:design:isolated` and
`test:agent:docker` depend on `mise run playwright:install`, which downloads the
build the pinned Playwright needs into the shared cache and does nothing when it
is already there. It passes `--no-remove`, so builds that worktrees on another
Playwright version still use are kept.

### macOS shell-test prerequisites

The default root suite executes Linux container scripts in isolated host
fixtures. These tests require Bash 4 or newer, GNU tar, coreutils, findutils,
grep and sed, plus `flock`. macOS's system Bash and BSD utilities do not satisfy
those requirements. Install the tools with Homebrew:

```bash
brew install bash coreutils findutils gnu-tar grep gnu-sed flock
```

The fixtures that need GNU `tar`, `date`, `rm` or `du` put Homebrew's GNU tool directories
(under `/opt/homebrew/opt` or `/usr/local/opt`) ahead of the inherited PATH
themselves (`tests/unit/gnu-shell-tools.ts`), and skip with the install command
in the test name when those tools are missing. Staged-input relay tests probe
the required flags directly and require them on Linux and CI. macOS also runs
all relay cases using only system tools, with fixture adapters mapping GNU
`rm --one-file-system` to BSD `rm -x` and GNU `du --apparent-size -B1` to BSD
`du -A -B1`, converting its 512-byte output blocks to bytes (rounded up). This
native lane exercises permissions, stale relay removal, revocation, symlinks,
entry limits and apparent-byte limits even without Homebrew coreutils; it does
not qualify GNU flag behavior. For everything else, prefer the tools for the
validation command without changing the global shell
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

CI also runs `conformance-apparmor-live.test.ts` twice on the same Ubuntu
runner, before and after its existing AppArmor remediation. The opt-in
`ORKESTRATOR_CLAUDE_APPARMOR_PHASE` must be `restricted`, `stock` or
`remediated`; missing opt-in skips the test, but an unexpected host/probe
result fails it. `stock` is the first phase of the separate
`claude-apparmor-qualification.yml` workflow on `ubuntu-24.04` (weekly, on
demand, and on pull requests that change its inputs): it accepts whichever
namespace answer the probe gives and requires the backend tier and the pinned
CLI to agree with it, failing only on a setup error such as missing programs.
Set `ORKESTRATOR_POLICY_CLAUDE_PATH` to the pinned native executable (its
version is checked and every query uses that path). The restricted phase
requires the real nested namespace refusal, a `provider-configured` backend
tier, the CLI's `apply-seccomp` failure, a required-sandbox read the CLI does
not run (also required for every refused `stock` answer, whatever the cause),
successful hook-only reads, a hook
write refusal, and an HTTP 422 provider-sandbox prompt refusal before dispatch.
The remediated phase requires `enforced`, a successful sandboxed read and
provider write control, and a coordinator sandbox write refusal without the
hook. These use the scripted local endpoint and temporary homes, with no
external model calls. `ORKESTRATOR_CLAUDE_APPARMOR_EVIDENCE` selects the output
directory for `restricted.json` (or `stock.json`) and `remediated.json`; CI uploads both with
OS, kernel, revision, pinned CLI version and assertion outcomes. Each report is
written once the probe has answered and rewritten when the phase ends, with
`outcome` and the `failedStage`, so a failing phase still leaves one. Remediation
belongs only on a disposable runner; the test never changes host policy.

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

`mise run test` first runs the guard stage (below) and stops, before admitting
any group, if it fails. It then submits four independent groups to the host
capacity queue:

| Group | Contents | Scheduling |
| --- | --- | --- |
| Workspace | Web, backend, desktop, public web, CLI, toolchain, and protocol package tests | Turbo runs at most two package tasks; ordinary packages get up to two Bun workers. The backend gets up to four in the default tier, and retains its two-worker ceiling in slow/all tiers |
| Root | Root renderer and repository-contract tests plus agent artifact and fixture-server support tests | Receives the remaining worker budget: one worker on a large host, up to two on smaller ones |
| Bridges | ACP, Claude, Codex, Cursor, and Pi bridge tests | Turbo runs two bridge tasks, each with one Bun worker |
| Protocol | Regeneration check for the committed Codex protocol lockfile | One independent command |

All cooperating runs share a host budget: one worker slot per logical core by
default (`ORKESTRATOR_TEST_HOST_WORKERS` may raise it to four per core), plus a
memory admission budget of 65% of physical memory. The ordinary worker plan is
capped at eight slots. The default tier can add up to two backend workers above
that plan; slow/all tiers retain the backend's two-worker ceiling. Host admission
reserves the actual group counts, including those additional workers. The larger host budget
lets other worktrees and review validations run beside it. The protocol check
reserves one slot too. Groups run together when they fit; smaller machines queue
groups instead of spawning extra workers.
The per-suite plan includes the protocol slot in its eight-slot ceiling.
Each ordinary group reserves an estimated 1 GiB per worker (bounded by the host
memory budget). These are admission estimates, not operating-system CPU or
memory limits; measure peak use before increasing concurrency.

`ORKESTRATOR_TEST_GROUPS` runs only some groups: a comma-separated list of
`backend`, `workspace`, `root`, `bridges` and `codex-protocol`. `backend` and
`workspace` split the workspace group into the backend package and every other
workspace package; selecting both runs the combined group. An unknown name, or a
selection with no group in the chosen tier, ends the run as incomplete (exit 75)
instead of passing on less. A backend-only run sizes the backend pool for the
whole host (one core left free, within the tier's ceiling). Unset runs every
group.

CI uses it to run `mise run test:full` as three shards on separate runners:
`backend`; `workspace`; and `root,bridges,codex-protocol`, which also carries the
paired Claude AppArmor qualification. The `Unit and integration tests` job passes
only when every shard passed, so it stays the suite's single status.
`tests/unit/ci-workflows.test.ts` checks that the shards cover every group once.

GitHub Actions runs on the organisation's Free plan: at most 20 jobs at once,
5 of them on macOS. When every merge kept its own full run and the packaged
build validation ran on almost every change, demand passed that cap and jobs
queued for over an hour (2026-11-10: 218 queued, 14 running). So:

- A newer push to a pull request, or a newer commit on `main`, cancels the
  older run of CI. A regression on `main` shows on the next completed run.
- Draft pull requests run no jobs; marking one ready for review starts them.
- `validate-bun-runtime.yml` (packaged desktop app and container image, on
  four platforms including two macOS runners) runs on pull requests and merges
  only when Bun, dependencies, Docker or packaging inputs change, and nightly
  on `main` for everything else.

The runner reports each group as soon as it finishes, but prints detailed
failure sections in a stable order. It waits for every group, so one failure
does not hide failures in groups that were already running.

After a failed run it reruns each failing test file alone, once, from the
directory and with the preloads of the suite that ran it (one worker, at most
ten files, ten minutes in all, five per file), and prints a verdict per file:
`PASSED ALONE` (likely a load flake: record it in the flaky-test register, never
skip it) or `FAILED ALONE` (a real failure). The files come from Bun's
`<file>:` header before each `(fail)` line, per Turbo task; a group that failed
without one (a crash, a build error) is named as having nothing to rerun. The
exit status stays the failure. `ORKESTRATOR_TEST_RERUN_FAILED=0` turns the
reruns off.

`mise run test:all` runs the same four groups first. If they pass and the host is
macOS with Xcode available, it runs the iOS suite last and by itself because the
simulator is a shared machine resource. On other hosts it is equivalent to the
non-iOS suite.

The Playwright component suite and the real-stack agent suites are deliberately
not part of `mise run test`; they require different fixtures and, for agent
testing, an isolated running application profile. Select them using the table
above and [agent-testing.md](agent-testing.md).

### Guards

`mise run guards` (`scripts/guards.ts`) runs the repository-wide checks in one
process, in about four seconds: the source-guard ratchet against
`tests/source-guards/baseline.json` and the checks that each production-source
guard still reaches its files, the DOM absence scan, project-class inheritance
chains, test suite ownership, the raw-console directive scan, and the flaky-test,
to-do and number-claim register tests (one `bun test` child alongside). They
share one `git ls-files -co --exclude-standard` listing, one read per file and,
for the source guards, one parse per file. On failure each guard prints its
problems and what to do, and the command exits non-zero. `--only <id>`
(repeatable) narrows it.

These checks of the real repository run only there. The guards' fixture tests
stay in the unit suite (`tests/unit/source-guards.test.ts`,
`dom-absence-scan.test.ts`, `inheritance-chains.test.ts`, `raw-console.test.ts`,
`test-suite-ownership.test.ts` and the guard-specific ones), and the root group
leaves the three register test files out once the stage has passed in the same
run. The stage runs whenever the root group is selected, outside the slow tier,
without host admission: it is one short process, like lint, and queueing it
behind another worktree's suite would defeat running it first. Set
`ORKESTRATOR_TEST_SKIP_GUARDS=1` to skip it, for a rerun after it passed or
when only the test groups' result matters. `mise run check` runs it between
lint and typecheck.

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

The `sleep-before-negative-assertion` source guard
(`tests/unit/source-guards.test.ts`) refuses a new fixed sleep followed by a
negative or exact-count assertion, and its siblings refuse released ports,
real subprocesses without a time budget and small fake pids. Existing offenders
sit in a baseline that only shrinks; see
[linting.md](linting.md#source-guards).

### Rendering inside a node scope

Components that read per-node state (`useScopedStore`, `useNodeScope`, from
`apps/web/src/lib/node-scope/`) need a `WindowScopeProvider` and a
`NodeScopeProvider` above them; outside one they throw in tests on purpose.
Render them with `renderInNodeScope` (`apps/web/src/test/render-in-node-scope.tsx`):

```tsx
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";

afterEach(cleanupNodeScopes);

const client = new FakeNodeClient({ invoke: { list_environments: [] } });
const { scope } = renderInNodeScope(<EnvironmentList />, { client, role: "leaf" });
client.emit("resource-changed", { kind: "environment" });
expect(client.calls("list_environments")).toHaveLength(2);
```

- Each call creates its own `WindowScope` and node scope, never the app's, so
  tests share no scope state. Options: `nodeId`, `role` (`command` by
  default), `client`, and `windowScope` to render a second node beside the
  first.
- `FakeNodeClient` answers `invokeRaw` from its invoke map (a value or a
  function of the arguments; an unmapped command rejects), records
  `invocations`, delivers `emit(event, payload)` and `emitTerminalOutput`
  synchronously, and exposes `connection` and `domains` as settable signals
  plus `listenerCount()`.
- Call `cleanupNodeScopes()` in `afterEach`. It unmounts what the helper
  rendered and disposes each window scope, which stops every scoped service and
  releases byte-budget reservations (invariant 15). Unmounting alone never
  disposes a scope (invariant 2). A test that opens scopes without the helper
  disposes its own `WindowScope`; one that touches the app's window scope
  calls `resetWindowScopeForTests()`.
- Plain modules take the scope explicitly, so their tests need no React:
  open a scope with `new WindowScope().open({ role, client })` and pass it.
- A per-node store (`scopedStoreHook`) read under `renderInNodeScope` reads
  the rendered scope. Seed it with `scope.store(def).setState(...)`. Its hook
  has no statics, and a component that reads it throws outside a provider in
  tests (plan item 3018). The per-store recipe, including the tests, is
  [node-scopes.md](node-scopes.md#tests).
- A component suite that mocks `@/lib/backend` renders with
  `renderInAppCommandScope(ui, options)` (or `renderHookInAppCommandScope`,
  or wraps a `renderToStaticMarkup` element in `InAppCommandScope`) from the
  same module, and seeds or reads stores with `appCommandStore(def)` from
  `@/test/app-command-store`: the providers are the app's own window and
  command scope, so the component reads a provider as it does in the app
  while the suite's seeds and mocks still apply. It disposes nothing; the
  suite resets the app's scope with `resetWindowScopeForTests()` as before.

### A native agent session as one projection

`useNativeAgentSession` reads a session only through the progressive views
(transcript, session state and discovery, each with its own token); a backend
without them is reported as too old, never read another way. A suite about
the tab's behaviour (composer, approvals, steering, coordinator panes) feeds
it through `createNativeAgentSessionBackend`
(`apps/web/src/test/native-agent-session-backend.ts`): describe the session
as one `NativeAgentSessionProjection` (or `null`), and spread the returned
`api` into the suite's `@/lib/backend` mock. It splits the projection the way
the backend does, answers `unchanged` while a domain's content is the same,
shares one projection read between the requests of one refresh, and pages
the rows `readHistory` returns behind "Load earlier messages". Its `api`
entries are mocks, so a suite can assert on the reads.

- A store write is not a backend update: the next read installs what the fake
  backend holds. To change the session mid-test, change what `readProjection`
  answers (`AgentNativeTab.test.tsx`'s `publishProjection` does both).
- A view whose provider session is not the tab's (`initialProviderSessionId`)
  is ignored, so give a test's projection the session id its tab names.
- Transcript and session state land separately; assert a combined outcome with
  `waitFor`, not right after one of them.
- Poll cadence runs on the read coordinator: install
  `installFakeReadCoordinator()` and `clock.advance(…)` rather than waiting
  for a real 500 ms or 1.5 s poll.
- Bun 1.4's `toMatchObject` writes its asymmetric matchers
  (`expect.objectContaining`, …) into the received object. Never point it at
  live store state the component is still rendering; read the field instead.

### Agent CLIs on `PATH`

Default and slow-tier tests must not reach the network or a provider login. A
backend path that resolves an agent CLI (`resolveCodexBinary` and its siblings
in `commands-agent-support.ts`) checks the managed copies first
(`toolchainBinDir`, `<resourceRoot>/bin`, `<appRoot>/binaries`,
`<appRoot>/bin`) and then falls back to the bare name, so `PATH` decides. CI
puts the pinned Codex on `PATH`, and a developer's `PATH` usually has a
signed-in one. Launching an environment with a prompt runs first-prompt naming
(`codex exec`), so a fixture that can reach it must supply a stub:

- `createPublicApiHarness` (`apps/backend/src/core/public-api/test-support.ts`)
  writes a slug-writing stub at `<root>/bin/codex` and logs each call;
  `harness.namingCalls()` returns them.
- The command fixtures (`apps/backend/tests/command-fixtures.ts`) offer
  `isolateCodexBinaryLookup`, `withFakeCodex` and `codexSlugScript`.

Do not prepend a stub to `PATH` for the whole suite: tests run in parallel
workers and some change `PATH` themselves.

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

### Opt-in Pi ChatGPT default-model check

`bridges/pi-bridge/src/agent-session-chatgpt-live.test.ts` sends one real
provider prompt through `createSession`, `ensureSession` and `dispatchPrompt`,
with no saved default, host fallback or model override. It requires a current
`openai` ChatGPT OAuth credential; a legacy `openai-codex` credential cannot
substitute. The test is skipped in normal suites. To opt in:

```bash
ORKESTRATOR_PI_CHATGPT_LIVE=1 \
  mise run test:logged -- --name pi-chatgpt-live -- \
  bun test ./bridges/pi-bridge/src/agent-session-chatgpt-live.test.ts \
  --preload ./tests/setup-node.ts \
  --preload ./bridges/pi-bridge/src/testing/test-isolation.ts \
  --parallel=1 --only-failures
```

By default it reads `~/.pi/agent/auth.json`. Set
`ORKESTRATOR_PI_CHATGPT_AUTH_FILE` to use a disposable login's auth file.
Only the `openai` credential is copied into a temporary agent directory; the
refresh token is replaced so the test cannot rotate the source credential.
The access token must have at least ten minutes remaining. The test checks
the selected model and an error-free provider answer, then removes its
temporary home, settings and sessions. It does not read or change host settings.

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
# On Linux that Playwright does not support (Arch), WebKit lacks ICU 74, libxml2 2.9
# and flite: run mise run test:preview:webkit-libs, then prefix the command with the
# PLAYWRIGHT_BROWSERS_PATH it prints (checksummed Ubuntu libraries, no system change).
# Add the Vite variable for HMR and the Next.js one for the app-router fixture
# (installed copies of test-fixtures/preview-vite and test-fixtures/preview-next);
# --project=firefox or --grep can narrow the run.
ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite \
ORKESTRATOR_TEST_PREVIEW_NEXT_DIR=/tmp/preview-next \
  mise run test:logged -- --name preview-browser -- mise run test:preview:browser

# Loopback route latency for the evidence log (prints one [preview-bench] line)
mise run test:preview:bench
```

The helper serializes setup and publishes immutable WebKit generations through an
atomic symlink swap. It remembers the source cache, so setup can be rerun after
exporting its output (including with `--force`). `PLAYWRIGHT_BROWSERS_PATH=0`
(package-local browsers) is explicitly unsupported: unset it before setup.

Retired generations stay on disk so an already running browser can finish.
When **all users of this private cache are stopped**, run
`mise run test:preview:webkit-libs -- --prune` to remove superseded revisions,
retired generations and abandoned staging copies. This is also required with
`--force --prune` to migrate an older private cache containing a real WebKit
directory instead of a symlink. Do not prune during browser tests. If a setup
process crashes while holding `.prepare-lock`, confirm that process has stopped
before removing that lock directory and retrying setup.

The preview suite uses a browser-local loopback proxy, throwaway certificates
and fresh contexts; it changes neither system DNS nor the trust store. Chromium
pins the test leaf. Firefox and WebKit bypass certificate validation only in
those contexts. WebKit engine coverage does **not** qualify shipping Safari or
iOS. The suite covers sibling reads/frames, visible links, hostile workers,
same-service iframe returns through a synthetic external identity provider,
`srcset`, source maps, SPA deep links and history, IndexedDB,
BroadcastChannel, Cache and worker isolation, frame and popup handling,
an IPv6-only (`::1`) service, upstream connection reuse and its closing on
revocation and endpoint generation change, and legacy-route ETag revalidation
(`upstream-pool.spec.ts`).

With the Vite variable set, `vite-page-load.spec.ts` (Chromium only) also
prints one `[preview-page-load]` line: medians of page-load time, requests,
304s, bytes and upstream connections through the private origin and the
legacy route. `ORKESTRATOR_TEST_PREVIEW_VITE_PAGE` picks the page,
`ORKESTRATOR_TEST_PREVIEW_LOAD_SAMPLES` the samples, and
`ORKESTRATOR_TEST_PREVIEW_POOL_OFF=1` turns connection reuse off for an A/B
comparison.

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

Seeded entry-port services in local environments have their own spec in the
same suite, `e2e/agent-testing/service-preview-seeded-electron.spec.ts`. It
gives the fixture project an `entryPort` and a `run` command, creates two local
environments, and checks the wait state, two servers on one port with the
port-move offer, a restart, agent links and framework hints in the real window
([browser-previews.md](../architecture/browser-previews.md#local-environments)).
It also runs headless on Linux through `playwright.electron-headless.config.ts`
with `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`. Both specs launch Electron through
`e2e/agent-testing/service-preview-electron-launch.ts`.

Record results in the evidence log of
[0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md#evidence-log).

### Opt-in annotation checks

A real desktop capture into a container environment is skipped unless its
variable is set. It uses this worktree's development image, creates its own
container environment on the spec's disposable profile and deletes it.

```bash
mise run docker:build:dev --profile <p>
ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1 \
  mise run test:logged -- --name electron-source-hints -- bunx playwright test \
  --config e2e/agent-testing/playwright.electron.config.ts \
  web-annotations-electron.spec.ts -g "source hints"
```

### Opt-in design checks

Design export from a real running container (the shipped helper over
`docker exec -i`, `/workspace` on a `volume-nocopy` named volume, interrupted
by killing the client, stopping or restarting the container and emptying the
workspace) is skipped unless its image variable is set. The container and
volume carry a throwaway owner label and are removed by id. The Linux Engine
qualification workflow (`container-live-qualification.yml`) runs it on amd64
and arm64 with each job's own image.

```bash
ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE=orkestrator-v2:latest \
  mise run test:logged -- --name design-export-container -- bun test --cwd apps/backend \
  ./src/core/design/export-container.test.ts
```

The same export into a container Orkestrator created (its network-policy
entrypoint, cloned workspace and lifecycle) is the Docker fixture case
`e2e/agent-testing/design-container-export.spec.ts`: round trip, a container
stopped outside Orkestrator, then an Orkestrator restart and a fingerprinted
replace. It runs with the other Docker fixture specs, or alone:

```bash
mise run dev:test --profile <p> --fixture --fixture-environments local,container
ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_DOCKER=1 \
  mise run test:logged -- --name design-container-export -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts design-container-export.spec.ts
```

Design canvases across a published backend and this checkout (upgrade, a
legacy `.orkdes` migration, the downgrade fence and the export-then-import
downgrade path, a future record version and a corrupt record) run against the
real `orkestrator` npm package on a private temporary data directory:

```bash
mise run test:logged -- --name design-mixed-versions -- bun scripts/qualify-design-mixed-versions.ts \
  --old-version 2.22.3 --report output/agent-testing/design-mixed-versions/report.json
```

Command nodes and leaves across a published release and this checkout, in both
topologies, for every domain scenario module
([version-compatibility.md](../architecture/version-compatibility.md#the-manifest-the-ratchet-and-ci),
"Mixed-version qualification"; scheduled weekly in CI). `--old-version current`
checks a new module against this checkout on both sides first:

```bash
mise run test:logged -- --name mixed-versions -- mise run qualify:mixed-versions -- \
  --old-version latest-stable --report output/agent-testing/mixed-versions/report.json
```

`e2e/DesignCanvas.spec.ts` takes `ORKESTRATOR_E2E_DESIGN_CPU_THROTTLE=<rate>`
(CDP `Emulation.setCPUThrottlingRate`, Chromium only) to slow the page instead
of loading the host when chasing a timing flake.

### CLI scenarios

The published client has targeted scenarios that start isolated backends
through the packaged launcher (disposable data and worktree roots, no Electron
or Vite), drive the packaged `orkestrator` executable with argv only, assert on
JSON envelopes and authoritative state, and clean up what they created. The
package suite already runs a subset (`packages/cli/tests/cli-client.test.ts`);
the full matrix is a separate task:

```bash
# Credential-free: read-only, local-lifecycle, retry-and-retention,
# setup-failure, client-exit, exec, lost-response, wrong-profile, project-cascade,
# project-init (container runs add foreign-owner and drop the local-only ones)
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

# The same, on a host whose Docker address pools are full (every start fails
# with resource-exhausted): the test-only shim retries only owner-labelled
# network creates on an unrouted /29 in 172.16.240.0/22
ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run test:cli:scenarios -- --environment-type container \
  --docker-image orkestrator-v2:dev-<worktree hash>
```

`live-session` installs the selected provider's pinned binary into the
scenario backend's toolchain (`toolchain install --tool`, five-minute timeout)
before `serve`, and never falls back to `PATH` or the host's copy, so every run
uses exactly the pinned version and needs network access for the download
(OpenCode is about 180 MB).

Scenario backends, and the CLI package tests that start a packaged backend,
run with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`. That skips the boot
host-reachability check: each backend is a new Docker owner stopped seconds
after `ready`, so its Linux probe network would belong to an owner nothing
reaps. A later on-demand check (a container scenario on a rootless daemon, a
workflow preflight) still runs. A scenario that needs the boot check passes
the variable through its own `env`.

The Electron specs under `e2e/agent-testing/` do the same through
`electronSpecEnvironment` (`e2e/agent-testing/electron-spec-environment.ts`):
every launch, Playwright's `electron.launch` or a bare spawn of the Electron
binary, builds its `env` there (`packagedLaunchEnvironment` calls it), which
sets the variable to `off` unless the spec passes its own value. The runner's
own value is ignored. Agent-test backends keep the variable
(`AGENT_TEST_SAFE_ENV_NAMES`). `tests/unit/electron-spec-environment.test.ts`
fails on a launch that builds its `env` any other way, including one with no
`env` at all. Besides the leaked network (todo 7470), the probe's container
can make Chromium abort the window's Vite module loads (flake 2340), and on a
host whose firewall drops Docker traffic the check's result dialog opened
mid-test and took keyboard focus (flakes 0620, 4250). No Electron spec runs
the boot probe now; the dialog itself is covered by
`ContainerHostReachabilityNotice.test.tsx` and the browser specs that close it,
and `dismissStartupDialogs` still closes it for a spec that turns the probe on.

`mise run test:agent:browser:isolated` includes `e2e/agent-testing/cli-ui.spec.ts`
(CLI changes seen by an open and a reloaded renderer). Its live question and
approval tests start their run on `ORKESTRATOR_AGENT_TEST_LIVE_CLI_AGENT`
(default `claude`; `ORKESTRATOR_AGENT_TEST_LIVE_CLI_MODEL` pins a model) and
need a profile started with that provider's credentials. The approval test
sets the environment's execution policy to ask (a host session otherwise
auto-approves):

```bash
mise run dev:test --profile qa-cli-live --fixture --credential-source opencode --agent-platforms opencode
ORKESTRATOR_AGENT_TEST_PROFILE=qa-cli-live ORKESTRATOR_AGENT_TEST_LIVE_CLI=1 \
  ORKESTRATOR_AGENT_TEST_LIVE_CLI_AGENT=opencode \
  mise run test:agent:browser -- e2e/agent-testing/cli-ui.spec.ts
mise run dev:stop --profile qa-cli-live && mise run dev:reset --profile qa-cli-live
```

The run manifest (IDs, exit codes, stages and, for a live turn, the pinned and
reported model; for a live scenario also the token counts and priced spend its
backend recorded, in `results[].usage` — no prompts, credentials or
environment names) is written to `output/cli-scenarios/<run>/manifest.json`.
The backend records a turn's usage when it records how the turn ended and on
every session-state read, so a run whose last turn is a `session start` counts
it too (to-do 7815, retired). Record live results in the
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

A test that needs a port binds port 0 in the component under test and reads the
bound port back, or keeps its own probe server bound until the port's owner
takes over. Binding port 0, closing the server and handing the number on lets
another process take the port first; where a component cannot bind port 0
itself, retry on `EADDRINUSE` with `retryOnAddressInUse`
(`@orkestrator/protocol/testing/ports`). The `released-port-rebind` source
guard refuses new instances ([linting.md](linting.md#source-guards)).

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
  with shared observation (its rollback mode went with
  `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`, todo 0048 task 13). `workflows` (`recurring-baseline-workflows.ts`)
  runs the real feature-planning, build-pipeline and multi-review
  supervisors over a temporary store in keyed mode, and feature planning and
  build pipelines also in rollback mode, on one manual clock. Rollback is what
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` selects: the whole-store tick. Multi
  review has no rollback mode since its `WorkflowDueScheduler` was removed
  (todo 0048 task 13). Each domain reports `storageReads` (store content
  decoded, cached or not, and uncached row queries) beside `storageStats`
  (reuse of already-decoded records) and `storageBytes` (what those reads
  fetched from SQLite; cache-served reads fetch nothing). The test holds every attempt to a
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
--no-agent-credentials --headless`, with `DISPLAY` and `WAYLAND_DISPLAY`
unset and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), waits for `ready`, settles for 60 s, and then samples
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
(`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all`; native queues, backend activity
and Multi Review stay keyed and native observation stays shared in both arms,
since their rollback drivers and the observation-sharing switch were removed)
and `metrics-off`
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

`--soak-cycles N` adds a lifecycle soak to every arm, after the window and the
freshness probes. Each cycle creates, starts (to `ready`), stops, restarts and
deletes one environment of each `--soak-environments` kind (`local` by
default, `local,container` for both) through the CLI; a failed step still
deletes its environment. Before and after the soak it reads the live
footprint three times, 5 s apart: scheduler keys per owner and job kind,
admission leases, container fetch and signal records, running recorded jobs,
and event-stream and terminal subscribers. A gauge is a leak when its lowest
reading after the settle is above its highest reading before the cycles. The
run exits 1 when a soak step failed, a gauge leaked or the profile's logs hold
a guard line.

```bash
mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --window-ms 60000 --freshness-probes 0 --soak-cycles 20 \
  --soak-environments local,container --out output/benchmarks/recurring-soak.json
```

After every cycle the soak also reads one trend sample: the footprint, the
cache gauges from `recurringWork.caches` (row cache, worktree snapshots,
local scan cache, native projection and change tracking; content-free counts)
and backend RSS. The summary prints each cache gauge's first, last, minimum
and maximum, and lists the gauges still rising: the lowest reading of the
last third of the samples is above the highest of the first third and the
middle third's median. A cache that warms up and plateaus, or tracks the
environments a cycle opens and closes, is not rising. Rising gauges are
reported, not failed: each needs reading against its bound (todo
[0048](../todo/transcripts-and-observation/0048-recurring-work-qualification.md)
task 10).

- `--soak-cycle-gap-ms MS` idles between cycles, so a soak can span an hour.
- `--soak-sessions N` (at most 8) keeps real Pi sessions open on a fake model:
  a loopback OpenAI-compatible endpoint the script serves
  (`scripts/recurring-live-ab-fake-model.ts`), named in the new profile's own
  Pi `models.json` under its isolated HOME. N sessions on the fixture's local
  environment stay open for the whole soak and get one prompt per cycle, and
  every cycle's local environment gets its own session before it is deleted.
  No credential, login or provider is involved.
- `--agent-platforms LIST` is passed to `dev:test`. `pi` alone needs no
  toolchain download; a profile whose start-up download fails exits.

```bash
mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --window-ms 60000 --freshness-probes 0 --fixture-environments local \
  --agent-platforms pi --soak-cycles 60 --soak-environments local \
  --soak-cycle-gap-ms 45000 --soak-sessions 2 \
  --out output/benchmarks/recurring-long-soak.json
```

`--busy-rounds N` adds the busy profile (todo
[0048](../todo/transcripts-and-observation/0048-recurring-work-qualification.md)
task 1, `scripts/recurring-live-ab-busy.ts`), after the window and before any
soak. It needs a local fixture environment and the Pi toolchain, and no
credential, login or provider: every turn goes to the fake model.

- Setup: `--busy-environments` (default 10) local environments, the
  fixture's included. One, `busy-ask`, is created with an `ask` execution
  policy (a registry setting, so through the gateway); a Pi session is opened
  in it and in `busy-1`, and `busy-2` gets a committed fixture file for a
  review to read.
- Rounds: for every count in `--busy-clients` (default `0,1,2`; headless
  Playwright clients from `scripts/recurring-live-ab-busy-clients.ts`, each
  signed in with its own `dev:login` link and showing `busy-ask`'s Pi tab),
  N rounds of: `--busy-burst-files` (default 200) files written into every
  environment at once and removed; a turn in `busy-1` held at the model
  (`[hold:<id>]`) with a prompt queued behind it (`session prompt
  --enqueue`), with `--busy-turn-files` (default 0) files written into
  `busy-1` while that turn is held and removed when the round ends, so the
  turn and thread-segment owners get file lists past the 2,000-row
  measurement cap (todo 4960), after which the round waits until the
  backend's diff stats for `busy-1` no longer show them (the
  `turn-clear-backend` row: the next burst writes as many one-line files into
  `busy-1`, and a removal the backend saw only together with it read as the
  same numbers, so that scan did not count as changed and the burst's
  `diff-scan` wait ran out; to-do 7765, retired 2026-11-11); a `bash` call the model asks for in `busy-ask` (`[tool:<id>]`),
  which Pi parks as an approval, and agent mail to that tab; with two
  clients the second one's link cut (the outage link of
  `client-outage-support.ts`), with one its document hidden; the approval
  answered through the public action, the held turn released and the queued
  prompt sent; a Multi Review on `busy-2` with every slot on the fake model
  (it runs `git rev-parse HEAD` through Pi's `bash` for its validation plan,
  then submits fixed finding-free results) followed to `ready`, watched by
  every client whose link is up from a review view of its own (a second
  signed-in context opened on `busy-2` before the launch, selecting the
  review's tab and recording each phase its header shows), the previous
  round's review cancelled and its tabs closed first (an environment holds at
  most nine tabs, so without that every launch after the ninth round is
  refused); and the cut or hidden client restored. A burst's badge is waited
  for only up to the 2,000 untracked files the environment scan counts lines
  for. The driver runs every step through this checkout's CLI, so run
  `mise run build:cli` first.
- Measures: each row of the latency budgets the round reaches, from the
  moment its cause is known (the fake model's arrival times, or the command's
  return) to what each connected client's page showed, plus backend rows
  (the approval in `session.interactions`, the queued prompt reaching the
  model, a Multi Review phase change after its corresponding result submission) and
  the resumed client's convergence. Workflow progress is timed from each
  result's submission (before acceptance) both to the backend's phase change
  (an upper bound) and to the review view showing that phase or a later one;
  a result that reached the backend before the view showed the review is
  reported as not sampled. Every scripted result (the validation plan, the
  reviewer report and the consolidated review; a review sends no preparation
  result) must have exactly one submission and its expected consuming phase. Failed rounds stop their sessions before reuse;
  an uncertain stop aborts the phase. Obligations: each held turn and queued
  prompt reaches the model exactly once, the approval is answered and its
  turn finishes, and every review reaches `ready`. `recurringWork` and
  process totals are sampled at every round boundary for the arm comparison.
  Each burst also records every environment's backend diff stats before it
  and when its wait ended (`burstRescans` in the artifact), and the summary
  names, for the rounds whose `burst-backend` wait ran out, the environments
  whose numbers did not move. On beelink2 on 2026-11-11 (8 rounds without
  clients, 10 environments, 2,500 burst and turn files) the driver without
  the `turn-clear-backend` wait timed out 4 of 8 bursts, each one short of
  +10, every time with `busy-1` reading 2,500 files and 2,000 lines on both
  sides; with it, none, each removal rescanned in 417 to 469 ms.
- A busy phase fails the run (exit 1) on a failed step, a wait that ran out,
  a duplicated dispatch or a guard line.

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate,rollback --repeats 1 \
  --window-ms 60000 --freshness-probes 0 --fixture-environments local \
  --agent-platforms pi --busy-rounds 3 --out output/benchmarks/recurring-busy.json
```

##### Before and after across commits

`--checkout DIR` runs the profile from another checkout: its launcher,
`dev:status`, `dev:stop`, `dev:reset` and CLI all run there, while the
sampling, freshness probes and summary stay this checkout's. Put a detached
worktree of the older commit under the git-ignored `output/benchmarks/`, run
`bun install --frozen-lockfile` in it (and in its `bridges/claude-bridge`),
and give each side a `--label`. mise is trusted for that checkout in the
child processes only (`MISE_TRUSTED_CONFIG_PATHS`). Remove the worktree with
`git worktree remove` when done: a checkout left under `output/` is collected
by a bare `bun test` path filter.

`--window hidden|visible|launcher-default` decides the Electron window.
`hidden` (the default) passes `--headless`; a launcher older than that flag
(before #1738, 2026-11-04) rejects it and always shows its window, so compare
such a commit with `--window launcher-default` on its side and
`--window visible` (`--no-headless`) on the newer side. Then the renderer is
a visible client on both sides, which matters because a hidden window's
renderer polls less.

A backend older than its `AGENT_TEST_SAFE_ENV_NAMES` entry (2026-11-01, after `0bd214ee`) for
`ORKESTRATOR_HOST_REACHABILITY_CHECK` drops the switch and runs the boot
probe, which creates Docker networks. Add that one entry to the scratch
checkout's `apps/desktop/electron/backend-process.ts` and record it with the
results. 1202 task 1 used this for `0bd214ee` against `main`:

```bash
git worktree add --detach output/benchmarks/task1-checkouts/base-0bd214ee 0bd214ee
mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --fixture-environments local --agent-platforms codex \
  --checkout "$PWD/output/benchmarks/task1-checkouts/base-0bd214ee" --label base \
  --window launcher-default --profile-prefix t1-base --out output/benchmarks/task1/idle-base-1.json
```

Counters are named by what they count on the commit that ran: a store that
was still a file on an older commit is charged as `storage-stat` there and as
`storage-read` once it moved into SQLite, so compare work units only where
both sides define them the same way.

Comparison columns keep the experiment arm beside the label and commit. Reusing
one label for different commits is rejected. Missing, reset, partial or
unmeasured rates display as unavailable (`—`), rather than zero.

#### Mail into a real claude-tmux tab

`scripts/tmux-mail-inject-live.ts` delivers agent mail to a real claude-tmux
tab on a running, credential-free profile and counts what each delivery
costs (BG-15 in to-do 1202). It serves a loopback Anthropic Messages endpoint
(`e2e/agent-testing/fake-anthropic-model.ts`), points the profile's own
isolated Claude directory (`<dataDir>/agent-credentials/claude`, never a real
home) at it with a fixture token and marks the CLI's first-run screens as
seen there, so the real Claude CLI runs in tmux with no login and no billed
turn. It opens a claude-tmux tab on the fixture's local environment, turns
mail injection on for it, primes the queue and draft stores with one queued
prompt and one saved-then-cleared draft, reads the `mail-injection` counters
over a quiet window, then sends messages one at a time and checks each is
typed once and reaches the model once. Last it checks that mail is held while
a draft is saved and delivered once the draft is gone. It stops the tab and
restores the two Claude files on the way out. Start a fresh profile for each
pass: what earlier passes left in the stores changes the counts. Missing or
invalid counters, counter resets and an idle window with no observed drain pass
fail the run and produce an error artifact. SIGINT/SIGTERM unwind the run,
stop its owned tab, restore the files and close the fake server before exiting.

The isolated-directory fallback applies to profiles without a host Claude
credential grant. Credentialed profiles retain the existing host tmux environment
and login, unless an added account selects a directory. This avoids changing the
CLI's Keychain namespace without supplying a token. Such profiles retain the
prior mismatch with the backend's isolated transcript directory; use the
credential-free profile above for this benchmark. The benchmark now rejects missing
credential-grant metadata, any host credential grant, and an active added Claude
account before configuring or launching anything. It checks the profile's own
account registry (SQLite or the older JSON layout), without probing host logins.
A failed installation rolls back both files before propagating the error; rollback
failures are included in the error artifact.

```bash
mise run dev:test --profile bg15 --fixture --fixture-environments local \
  --no-agent-credentials --agent-platforms claude --headless
mise exec -- bun scripts/tmux-mail-inject-live.ts --profile bg15 --deliveries 5 \
  --out output/benchmarks/bg15.json
mise run dev:stop --profile bg15 && mise run dev:reset --profile bg15
```

`--checkout DIR` runs `dev:status` in the checkout that started the profile.
Before 2026-11-06 a claude-tmux tab in an agent-test profile with no added
Claude account ran the CLI with the host tmux server's environment, which
reads the host's `~/.claude`; on an older commit, cherry-pick that fix
(`tmuxLocalClaudeConfigDirectory` in `commands-servers.ts`) into the scratch
checkout before running this.

#### Environment activity RPC counts (WEB-3)

`scripts/web3-activity-rpc-live.ts` measures a running credential-free profile
from a gateway browser at 1440 × 1000. It installs loopback Claude settings in
the profile, opens a native Claude tab on its sole local fixture environment,
and sends two held turns. For each idle → working → idle cycle it waits for
the browser's actual environment projection, lets boundary requests settle
for 3 seconds, then reads the gateway's cumulative per-command counters.
It saves command deltas and model-call counts only. Missing or reset counters
fail the run. The browser closes and Claude settings are restored on exit;
the caller must stop/reset the profile to stop its native session.

```bash
ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile web3 \
  --fixture --fixture-environments local --no-agent-credentials \
  --agent-platforms claude --no-headless
# In another shell, from the checkout containing the measurement script:
mise run test:logged -- --name web3-live -- bun scripts/web3-activity-rpc-live.ts \
  --profile web3 --checkout /absolute/path/to/profile-checkout \
  --out output/benchmarks/web3.json
# Run lifecycle commands from the checkout that owns the profile:
mise run dev:stop --profile web3 && mise run dev:reset --profile web3
```

Repeat with fresh profiles at each pinned commit. Older launchers without
`--no-headless` omit that flag; keep the window visibility alike. The
measurement uses a native tab, so it does not need the later tmux-directory
isolation fix on the before side. Compare `list_prompt_queues` and
`list_multi_review_workflows` separately from other requests: snapshot,
unread-state and transcript requests share the transition windows, and
their timing-dependent totals are not WEB-3's refetch cost. The two list
hydrators are all that remain at the 1202 baseline commit; the original
report's third list had already been removed there.

#### A claude-tmux tab in a container, and per-item counts on a busy profile

Two drivers took 1202 task 1's Linux counts on 2026-11-10; both read a
running credential-free profile and record kinds, counts and durations only.

`scripts/container-tmux-tab-live.ts` opens one claude-tmux tab on the
profile's container fixture environment. Its model is
`e2e/agent-testing/container-fake-claude-api.ts`, run by the container's own
Bun on the container's loopback and named in the container's
`~/.claude/settings.json` (`container-fake-claude-install.ts`), so the image's
real `claude` takes turns with no login. It measures five windows (no tab; the
idle tab before its first prompt, when no transcript exists; three queued
turns; the idle tab with its transcript bound; the container stopped with
`docker stop` behind the app's back) and, for each, both the backend's
`recurringWork` counters and every `docker exec` Docker itself reports for
the container (`docker events --filter event=exec_start`), labelled by
program only. Use Docker's count to compare commits: the claude-tmux tab
loop has its own recurring kind, `tmux-tab-loop` (B30), only from
2026-11-11 (todo 7567, retired that day); on older commits it is uncounted (`tmux-poll` is the
per-container Claude state poll), and an older backend leaves more loops
uncounted. Afterwards it starts the container again, removes the fake model
and stops the tab.

`scripts/busy-item-counts-live.ts` runs on a profile the 0048 busy driver
filled and kept (`recurring-live-ab.ts --busy-rounds 3 --busy-clients 0
--keep-profiles`), restarted with the same `dev:test` flags. It reads two
windows: everything running, then every `busy-*` environment stopped through
the public `environment.stop` action (so the presence pass meets stopped
environments that own mailboxes), and starts them again.

```bash
ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise run dev:test --profile ctab --fixture --fixture-environments local,container \
  --no-agent-credentials --agent-platforms claude --headless
mise exec -- bun scripts/container-tmux-tab-live.ts --profile ctab \
  --out output/benchmarks/ctab.json
mise run dev:stop --profile ctab && mise run dev:reset --profile ctab

ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise exec -- bun scripts/recurring-live-ab.ts \
  --arms candidate --busy-rounds 3 --busy-clients 0 --busy-environments 10 \
  --fixture-environments local --agent-platforms pi --freshness-probes 0 \
  --keep-profiles --profile-prefix busy --out output/benchmarks/busy.json
mise run dev:test --profile <the kept profile> --fixture --fixture-environments local \
  --no-agent-credentials --agent-platforms pi --headless
mise exec -- bun scripts/busy-item-counts-live.ts --profile <the kept profile> \
  --out output/benchmarks/items.json
```

Set `ORKESTRATOR_QUALIFICATION_DOCKER` before `PATH`: Bash expands these
assignments in order, so with the shim's directory already on `PATH`
`command -v docker` names the shim itself, which then execs itself in a loop
and the profile never leaves `starting` (seen 2026-11-11).

The busy driver needs `packages/cli/dist` (`bun run --cwd packages/cli
build`) in whichever checkout runs the profile; with `--checkout` its busy
phase uses that checkout's CLI, because today's CLI refuses a backend that
publishes no Linux process identity. A launcher older than `--headless`
shows its window on the signed-in desktop. On Linux keep it off with a
two-line `electron` wrapper that `exec`s the checkout's own Electron binary
with the switches in `HEADLESS_ELECTRON_SWITCHES`
(`apps/desktop/electron/runtime-profile.ts`) and no `DISPLAY` or
`WAYLAND_DISPLAY`, named by `ELECTRON_OVERRIDE_DIST_PATH` for that launcher
(`bun install.js` in its `electron` package first if `dist/` is missing).
Run `dev:stop` and `dev:reset` for such a profile from its own checkout.

`container-tmux-tab-live.ts` also records each container change signal's
state and rings (`tmux-hook-signal` is the claude-tmux doorbell) either side
of every window. To see the doorbell confirmed on a Linux host whose own
Docker cannot reach the host, run the same profile on a disposable rootless
daemon with host loopback: its containers reach the backend through
`10.0.2.2`, and the app's on-demand reachability check names that address
on the first container create even with the boot check off.

```bash
mise run docker:build:dev --profile ctab        # with the qualification shim, as above
mise run docker:disposable -- start --name ctab --host-loopback \
  --image orkestrator-v2:dev-<hash>             # the tag docker:build:dev printed
eval "$(mise run docker:disposable -- env --name ctab)"
# then the same dev:test, container-tmux-tab-live.ts, dev:stop and dev:reset
# commands as above, in this shell, so the profile and the driver use that daemon
mise run docker:disposable -- stop --name ctab
```

`scripts/tmux-interactive-orphan-live.ts` measures the interactive
terminal's capture loop (B19) left by a client that vanished without
detaching (to-do 7745, retired 2026-11-11). On the same container profile
and fake model as `container-tmux-tab-live.ts`, it opens one claude-tmux tab,
attaches interactive terminals through the gateway as the renderer does and
never detaches them, and counts Docker's `exec_start` events and the
`tmux-interactive-capture` attempts in four windows: the tab alone, an
unleased terminal (what every client left before the lease), a leased
terminal renewed every 15 s, and a leased terminal nobody renews, measured
from 50 s after it was created. It exits 1 unless the last window counted no
capture at all while the unleased and renewed windows counted some, and the
orphan's late renewal was refused; a refused late renewal alone proves
nothing, because a renewal detaches a lapsed terminal itself. It detaches
every terminal it made and stops the tab afterwards. On a host whose own Docker the session cannot reach, run
the profile on a disposable rootless daemon with the image built inside it:

```bash
mise run docker:disposable -- start --name orphan --host-loopback
eval "$(mise run docker:disposable -- env --name orphan)"
ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run docker:build:dev --profile orphan
# the same dev:test command as above with --profile orphan, then:
mise exec -- bun scripts/tmux-interactive-orphan-live.ts --profile orphan \
  --out output/benchmarks/orphan.json
mise run dev:stop --profile orphan && mise run dev:reset --profile orphan
mise run docker:disposable -- stop --name orphan
```

On beelink2 on 2026-11-11 (commit `53fe65bb6`, 120 s windows, rootless
disposable daemon): the tab alone made 33.5 container execs a minute; an
unleased orphan added 57.5 `tmux-interactive-capture` attempts and as many
`docker exec`s a minute (91.5 in all) for as long as it was left; a renewed
leased terminal the same 56.5 (8 renewals, none refused); and a leased
terminal nobody renewed none at all (33 execs a minute, its late renewal
answered `renewed: false`).

`scripts/human-prompt-reads-live.ts` measures BG-9: one native Claude
session started through the profile's CLI (`--checkout` for an older
commit's), the profile's isolated Claude directory pointed at the loopback
fake Anthropic model, no browser, then 60 s idle and 180 s with a turn held
at the model. The human-prompt monitor's bridge reads are the unattributed
`provider-request` counter; the artifact also has each kind's provider
requests a minute.

```bash
ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile bg9 --fixture \
  --fixture-environments local --no-agent-credentials --agent-platforms claude --headless
mise exec -- bun scripts/human-prompt-reads-live.ts --profile bg9 \
  --out output/benchmarks/bg9.json
```

A launch with a cold toolchain page cache needs no root on Linux: with the
profile stopped, `find <dataDir>/toolchains -type f -exec dd if={} iflag=nocache count=0 status=none \;`
evicts the toolchain's pages, and `fincore -b` on the same files confirms
nothing is resident. Delete `<dataDir>/toolchains/.verified-stamps.json` as
well for a full check. Time the `dev:test` start to its `Live` line (the
launcher runs the toolchain step before Electron) and read Electron's
`[toolchain] prepare.ready durationMs` from the profile's `logs/electron.log`,
which is rewritten on every start.

#### Image and layer sizes

`scripts/docker-image-layers.ts` measures an image on whatever Docker the host
has (1202 task 14, DK-7 to DK-9). `report` prints the uncompressed size, each
layer with the instruction that made it, and `du -sxk` of each `--du` path in
a throwaway `--network none` container; `changed` sums the layers of a probe
image that the base image does not hold, which is what a client holding the
base would pull. Build each side from a detached worktree under the
git-ignored `output/benchmarks/` with a tag of its own, and remove the tags
and worktrees when done:

```bash
git worktree add --detach output/benchmarks/img-before <commit>
(cd output/benchmarks/img-before && \
  docker build $(bun scripts/docker-image-build-args.ts) \
  -t orkestrator-v2:img-before -f docker/Dockerfile .)
mise exec -- bun scripts/docker-image-layers.ts report orkestrator-v2:img-before \
  --du /home/node/.npm --du /usr/local/share/mise/installs/bun
# Re-pull probe: append a line to every bridges/*/src/index.ts in the worktree,
# rebuild as orkestrator-v2:img-before-probe with the same build arguments, then
mise exec -- bun scripts/docker-image-layers.ts changed \
  orkestrator-v2:img-before orkestrator-v2:img-before-probe
docker image rm orkestrator-v2:img-before orkestrator-v2:img-before-probe
git worktree remove --force output/benchmarks/img-before
```

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
catch a wedged run, not a slow one. The slowest group is the workspace group:
roughly four minutes cold on the 18-core reference host. On GitHub's four-core
runner it grew past 33 minutes in November 2026 (backend 23 minutes on one
worker, then web 7), which is why CI now runs the backend as its own shard
rather than raising the limit. A default `mise run test` that gets anywhere near
thirty minutes needs investigation rather than a raised limit.

If an interrupted manual command leaves a process behind, identify it by its
exact command, working directory, PID, or owned port before stopping it. Never
kill by a broad executable name because other worktrees and agent profiles may
be using the same runtime.

## Production Orkestrator shares this host

Orkestrator is developed with Orkestrator. On a development machine, the
installed production app is usually running, and an agent's commands and test
suites are descendants of its backend. That process tree looks like this:

```text
orkestrator-v2 (Electron)
└─ bun …/resources/backend/main.js          production backend
   └─ codex-bridge / claude-bridge
      └─ agent CLI → shell → mise run test  your test run
```

The production backend, bridges, agent CLIs, and OpenCode server processes
have the same executable names and similar command lines to the ones tests
start. Killing any of them stops every local agent session on the host, including
the one running the tests. On 2026-10-26 the production backend received
`SIGKILL` three times while agents were running a full `mise run test`, each
time within a minute of the suite starting. It was not an out-of-memory kill:
Electron, in the same scope and process group, survived. Linux does not record
who sends a signal, so the culprit was not identified from the logs alone.

Test code, fixtures, and scripts must follow these rules, and so must commands
run by hand:

- Signal only what you spawned. Use the child handle, or the PID recorded at
  spawn time. Signal a process group (`kill(-pid)`) only when you started that
  child detached, so it leads its own group. Otherwise the group is the
  caller's.
- Give a fake child process a pid no live process can have: `fakePid(n)` from
  `@orkestrator/protocol/testing/fake-pids`, above any `pid_max`. Code under
  test that signals the child's process group would otherwise reach a real
  group on the host. The `small-fake-pid` source guard refuses new small ones
  ([linting.md](linting.md#source-guards)).
- Never select processes by name, pattern, or port. This rules out `pkill`,
  `killall`, `fuser -k`, `kill $(lsof -t -i :PORT)`, and `ps | grep` loops on
  the host. Production listens on fixed ports such as the remote gateway and
  agent tools ports.
- Never signal `process.ppid`, an ancestor, PID `0`, `-1`, or `-process.pid`.
  A test runs under agent shells, bridges, and the production backend, so an
  ancestor is very likely production.
- Treat a PID read from disk, a database, or a `ps` snapshot as unverified. A
  PID can be reused as soon as its process exits. Before signalling, confirm
  the start time (`/proc/<pid>/stat` field 22) and the exact command line, and
  do nothing if either is unknown. `host-test-scheduler.ts` and
  `local-server-reaper.ts` show the pattern.
- Never use production state. Tests and fixtures use temporary data
  directories, or an isolated `dev:test` profile for real-stack work. They must
  not use `~/.config/orkestrator-v2`, its toolchain directory, its instance
  descriptor, or its fixed ports. Code that "reclaims" a stale instance from a
  data directory must never resolve to the real one in a test.
- Bound tree walks to the root you own. Walk descendants from your own child,
  never upwards and never from a shared parent such as `systemd --user`.
  Orphans are re-parented there, not to PID 1, on this host.

If the production backend dies with `signal SIGKILL` while tests run, the
sender can be captured with an audit rule (requires `sudo`; lasts until reboot):

```bash
sudo auditctl -a always,exit -F arch=b64 -S kill -F a1=9 -k ork-sigkill
sudo auditctl -a always,exit -F arch=b64 -S tkill -F a1=9 -k ork-sigkill
sudo auditctl -a always,exit -F arch=b64 -S tgkill -F a2=9 -k ork-sigkill
sudo auditctl -a always,exit -F arch=b64 -S pidfd_send_signal -F a1=9 -k ork-sigkill
# Note the backend PID beforehand: pgrep -f resources/backend/main.js
sudo ausearch -k ork-sigkill -i | grep -B8 'opid=<backend-pid>'
sudo auditctl -D -k ork-sigkill   # remove the rules afterwards
```

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

An admitted ordinary command is told its grant in `ORKESTRATOR_VALIDATION_GRANTED_WORKERS`,
leaving the per-package `ORKESTRATOR_TEST_WORKERS` setting unchanged,
and every validation command sees `ORKESTRATOR_REVIEW_VALIDATION=1`. The
component browser suite (`e2e/playwright.config.ts`) runs the smaller of the
grant and Playwright's own default of half the cores, so a busy host runs fewer
browser workers instead of starving them, and an idle one runs as many as a
person's run. Its profile asks for eight slots with a floor of four, because
measured CPU use undercounts a suite that mostly waits on pages. Under review
validation that suite also retries a failed test once. A test that passes on
its retry is listed as flaky in the check's output; record it in the flake
registry like any other.

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

`commandProfiles[command].onDemand` keeps a slow suite out of automated review
validation unless the change needs it: `{ "when": [<path globs>], "instead":
<command> }`. When the branch touches none of the `when` paths, the worker runs
`instead` in its place (recorded in that result's limitation) or skips it. This
repository uses it for `test:full`, `test:slow`, `test:all` and the
`test:agent:*:isolated` suites; see
[review preparation](../architecture/review-preparation.md#validation-commands).
Running a suite yourself is unaffected.

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

Turbo runs in strict environment mode and passes a task only the variables
`turbo.json` declares. `TMPDIR` is in `globalPassThroughEnv` (not hashed), so
the workspace and bridge groups use the same temporary directory as the root
group and the caller: an operator's choice is honoured, and an aggregate run
with a private `TMPDIR` can be inspected afterwards for leftovers. Before
2026-10-26 Turbo dropped it and those groups fell back to `/tmp`.

Every Bun test process, and the runner of every Playwright suite
(`test:browser`, the real-stack `e2e/agent-testing` configs and
`test:preview:browser`), then moves to a private `TMPDIR` of its own, `ork-test-tmp-<pid>-<random>`
(`tests/private-tmpdir.ts`, loaded by `tests/isolate-tmpdir.ts` after the
other isolation preloads). It is made in the process's temporary directory,
except on macOS, where it goes under `/private/tmp`: inside the 49-character
per-user directory, test Unix sockets passed the 104-byte limit. If the shorter
root denies creation, it retries beneath the existing TMPDIR. If neither root
allows creation, TMPDIR and its ownership variables stay unchanged. Children
inherit the selected TMPDIR, so a Playwright browser profile
(`playwright_chromiumdev_profile-*`, a name with no owner in it) or anything
else a test leaves lands inside a directory a later run can attribute and
remove. The preload removes its directory when its `afterAll` runs unless a
live process still names it; a killed process's directory is removed by the
next test process once the owner has exited and the directory is an hour old
(0248). A test that needs the shared temporary directory reads
`ORKESTRATOR_TEST_PARENT_TMPDIR`. A process a test starts to outlive it, such
as the `dev:test` launcher a real-stack spec restarts, gets
`outlivingProcessEnv()` from the same module: the private directory is removed
when the runner exits, and only a command line, never an environment, keeps it
(0830). Linux limits a Unix socket path to 108 bytes and Chromium puts its
`SingletonSocket` in `TMPDIR`, so a test that launches full Chrome under a
temporary directory of its own keeps that directory's names short. For a leak
hunt, set `ORKESTRATOR_TEST_KEEP_PRIVATE_TMPDIR=1` so each private directory
is kept for inspection.

A test removes a temporary directory it made itself, after whatever holds the
directory open has finished, and awaits the removal so the process cannot exit
first. Classes that keep writing after their owner returns expose a `settled()`
that only waits (for example `TerminalHistory`, `McpManagementService`,
`SharedScanQueue` and `DiffStatsTracking`); await it, or the fixture's `stop()`, before the removal.
`tests/temp-sweep.ts` is the fallback for prefixes that cannot be removed at
source: it removes a PID-owned directory only when that PID is dead and the
directory is past its age limit. Some entries in a shared temporary directory
are not leaks: `orkestrator-test-run.*` (failure logs, kept 7 days by
`scripts/test-all.ts`), `orkestrator-test-scheduler-v1-<uid>`,
`orkestrator-test-timings.*`, `orkestrator-mcp-locks-<uid>`, and other tools'
own caches. The 2026-10-26 to 2026-10-29 leak hunt that set these rules is
to-do 0247 in git history.

The Windows process-marker qualification from retired to-do 0247 is explicitly
deferred under the current [platform support scope](../../README.md#quick-start):
Windows is unsupported and the backend refuses to start on `win32`. This is a
scope disposition, not a Windows pass. If Windows support resumes, reopen the
process-marker regressions and the real-Chromium escaped-browser ownership
check on Windows before claiming cleanup qualification there. The Chromium
check belongs to the transcript-artifacts area suite and requires Chromium to
be available. Linux procps and macOS/Unix `ps` evidence do not establish Windows
execution.

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
focused suite was active. These are diagnostic reference points, not fixed
pass criteria:

- **18-core reference machine** (2026-09, before the backend and desktop
  suites moved into their packages): about 188 seconds cold and 75 seconds
  warm.
- **GitHub's `ubuntu-latest` runner** (Ubuntu 26.04, four cores, 16 GB;
  `mise run test:full`, `main` runs of 2026-10-25): workspace group
  1,215–1,296 s, with the backend package 700–755 s and web 377–407 s, which
  run one after the other at one worker each on four cores; root and
  agent-support 199–214 s; bridges 145–191 s, of which ACP is 140–152 s. The
  test job takes about 21 minutes. By `main` run 41549578197 (2026-11-02,
  still one job) the workspace group took 1,998 s, with the backend 1,404 s and
  web 416 s; root 253 s and bridges 178 s. That run was the last measured before
  CI moved to shards, and the shards have no reference timing yet.

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
observation date, the observing branch's base commit
(`git merge-base HEAD origin/main`), and an evidence-backed hypothesis. Run
`mise run flaky:recurrence -- <case-id> --base <that commit> --registry-ref origin/main`
before calling a failure a recurrence: a base that predates the case's fix is
not one. Before a flake sweep, run `mise run flaky:stale` and close the cases
that are already fixed first. Do not skip, loosen, or delete a test to hide an
intermittent failure. When fixed, retain the case-file history and mark the
case resolved in the same change, with the Resolution section the registry's
[Recording a case](../tests/flaky-tests/0000-index.md#recording-a-case) rules
describe.

Aggregate runs remove an ambient `ORKESTRATOR_BRIDGE_DEBUG`, the only bridge
debug flag still read, before spawning their groups (the per-bridge spellings
such as `CLAUDE_BRIDGE_DEBUG` are no longer read, so they are left alone). This
prevents a development profile's diagnostics from changing authoritative test
inputs. If a focused reproduction needs the flag, set it explicitly on that
focused command and record it with the result.

### Reproduce before fixing

A fix for a flake is only as good as the evidence that it addresses the
failure that was recorded. A stress run that passes says little when the
unchanged code would have passed it too. Work in this order:

1. **Make it fail on demand.** Recreate the condition the hypothesis names,
   against the unchanged code, until the recorded failure appears:
   - a race between two events: inject a delay (a temporary `await Bun.sleep`
     or a deferred promise) on the side that has to lose;
   - a port or resource collision: hold the port or resource from another
     process or a test fixture while the test runs;
   - a deadline that only load breaks: starve the test of CPU with the
     contention runner. On Linux it pins K busy loops (default 6) and the
     command to one core (default the last), leaving the rest of the host
     alone, and stops only the burners it started:

     ```bash
     mise run test:logged -- --name repro -- \
       bun scripts/test-under-contention.ts --burners 6 -- \
       bun test path/to/owner.test.ts --rerun-each=5
     ```

     `mise run test:contention -- [--core N] [--burners K] [--duration S] -- <command>`
     is the same runner. It propagates the command's exit status and prints
     one summary line (core, burners, elapsed, exit). Without `taskset`
     (macOS) the burners run unpinned and it says the condition is weaker.
2. **Show the fix passes under the same condition.** Rerun the same
   reproduction (the same delay, held port or contention command) with the fix
   in place.
3. **Stress it.** Run the owner repeatedly with `--rerun-each=N`, under
   contention when load was the trigger. `--rerun-each` reruns the file's tests
   in one process, so a file that is not rerun-safe (module-level state, a
   fixture created once, a server bound at import) can fail for that reason
   alone. For such a file, loop fresh processes instead:

   ```bash
   mise run test:logged -- --name stress -- bash -c \
     'for i in $(seq 20); do bun test path/to/owner.test.ts || exit 1; done'
   ```

Record the result in the case's Resolution section as
`Reproduced: yes — <how>` or `Reproduced: no — <why>`, with the stress command
and its result. A fix that only raises a timeout without a reproduction is
weaker evidence; say so rather than presenting it as proven.

## Verification by change type

Use the default suite plus the additional evidence relevant to the change:

| Change | Minimum additional verification |
| --- | --- |
| Test runner, package scripts, Turbo configuration | Focused runner unit tests, then both cold-enough and warm `mise run test` observations |
| Backend, protocol, or bridge | Owning file/package tests; exercise subprocess cleanup when lifecycle code changed |
| React component or store | Owning component/store tests and `mise run test:browser` when browser behavior matters |
| User-visible or background renderer flow | Isolated-stack browser cycle, including inactive-environment rehydration |
| Electron main/preload/IPC | Focused Electron tests plus `mise run test:agent:electron` |
| Desktop packaging (`build` in `package.json`, `extraResources`) or how main loads the production renderer | `mise run package:linux:unpacked` and `mise run package:linux:unpacked:test`, then `mise run test:agent:electron:packaged` on Linux |
| Electron fuses (`build.electronFuses`), `electron-builder*.ts`, or desktop dev-mode gating (`apps/desktop/electron/dev-mode.ts`, `main.ts`) | `mise run test:package:security` on macOS or Linux: unsigned local shipping `--dir` build, fuse read (`output/package-security/`) and the hostile-launch spec ([agent-testing.md](agent-testing.md#packaged-app-electron-spec)) |
| Docker lifecycle or ownership | Local fixture coverage plus `mise run test:agent:docker` |
| Service previews: private origins, publication, bootstrap, request forwarding, or the preview fixtures | `mise run test:preview:browser` (all three engines); add `mise run test:preview:docker` for target resolution, port publication or the relay, and `mise run test:agent:electron` for the desktop tunnel. See "Opt-in preview checks". |
| iOS | `mise run test:all` on macOS with Xcode, or report that iOS was not run |

For real-stack flows, artifact handling, authentication, and safe profile
cleanup, follow [agent-testing.md](agent-testing.md). Stop and reset profiles
after the run unless their retained state is explicitly part of the evidence.
