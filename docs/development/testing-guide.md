# Testing guide

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
| Test the repository | `mise run test` | Authoritative default, non-iOS validation before handoff |
| Test everything, including iOS | `mise run test:all` | Release-sensitive or iOS validation on a Mac with Xcode |
| Check format, lint, and types | `mise run test:logged -- --name check -- mise run check` | Static validation; this does not run tests |
| Run browser component tests | `mise run test:logged -- --name browser -- mise run test:browser` | Playwright component/browser coverage |
| Run isolated-stack agent tests | `mise run test:logged -- --name agent-browser -- mise run test:agent:browser` | Real browser against an agent-test profile |
| Run Electron agent tests | `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` | Main process, preload, IPC, clipboard, and shutdown |
| Run Docker agent tests | `mise run test:logged -- --name agent-docker -- mise run test:agent:docker` | Opt-in container ownership and fixture coverage |

A normal implementation loop is:

1. Run the owning test file while iterating.
2. Run `mise run test:changed` after the local behavior is green.
3. Run `mise run check` through `test:logged` and run `mise run test` before
   handoff.
4. Add the relevant browser, agent, Docker, or iOS suite when the changed area
   requires it.

`test:changed` is an optimization, not final proof. It uses Turbo's affected
package graph and Bun's changes from the local `main` ref. Configuration files,
dynamic coupling, generated artifacts, or a stale local `main` can make a
change's true impact wider than the selected set.

Never use a bare `bun test` at the repository root. Without an explicit `./`
path, Bun treats arguments as discovery filters and can collect Playwright
specifications, package tests, and intentionally malformed fixtures. Use
`mise run test` for the default suite or prefix a focused path with `./`.

## What the aggregate runner does

`mise run test` submits four independent groups to the host capacity queue:

| Group | Contents | Scheduling |
| --- | --- | --- |
| Workspace | Web, backend, desktop, public web, CLI, and protocol package tests | Turbo runs at most two package tasks; each package gets one Bun worker on a large host |
| Root | Root tests plus agent artifact and fixture-server support tests | Receives the remaining worker budget, up to four workers on a large host |
| Bridges | ACP, Claude, Codex, Cursor, and Pi bridge tests | Turbo runs two bridge tasks, each with one Bun worker |
| Protocol | Regeneration check for the committed Codex protocol lockfile | One independent command |

All cooperating runs share a host budget: at most eight worker slots, leaving
two logical cores free where possible, plus a memory admission budget of 65% of
physical memory. The protocol check reserves one slot too. Groups run together
when they fit; smaller machines queue groups instead of spawning extra workers.
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

# One bridge test
mise run test:logged -- --name codex-bridge-example -- \
  bun test ./bridges/codex-bridge/src/example.test.ts \
  --parallel=1 --only-failures
```

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
  mise run test:agent:browser
```

Run checks separately so each exit status and artifact belongs to one command.
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
| No-output watchdog | 5 minutes |
| Absolute group deadline | 30 minutes, or 60 minutes for the iOS group |
| Permissions | Directory `0700`, files `0600` |
| Retention | Completed run directories expire after 7 days |

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
  use it.
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
than allowing a stream of smaller jobs to starve it. This can deliberately
leave some slots idle briefly. Repeated instances of the same group in one
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
| `ORKESTRATOR_TEST_HOST_WORKERS` | Lower the host worker ceiling |
| `ORKESTRATOR_TEST_HOST_MEMORY_MIB` | Lower the estimated host memory budget |
| `ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS` | Wait deadline, from 1 second to 2 hours |
| `ORKESTRATOR_TEST_SCHEDULER_DIR` | Private same-user SQLite directory; normally leave unset |
| `ORKESTRATOR_COOPERATIVE_STARTUP_MS` | First-publish allowance before a cooperative runner is treated as stalled |
| `ORKESTRATOR_COOPERATIVE_STALE_MS` | Silence after its last channel read before a cooperative runner is treated as stalled |

An active queue keeps its original budget; changed settings apply when idle.
The old `ORKESTRATOR_TEST_ALLOW_CONCURRENT` override no longer bypasses admission.
Older worktrees that still use the fail-fast lease must be updated to participate
in the new queue. Direct focused tests and unrelated dev servers do not reserve
capacity automatically. A Docker container is a separate scheduler namespace;
this is not a distributed scheduler or a physical-host container quota manager.

### Multi Review validation

The environment-owned worker persists queued/running command states and separate
queue/execution durations alongside its heartbeat. Switching environments,
closing the validation view, or reconnecting the backend does not start another
command; the UI rehydrates from that state. Cancellation removes pending tickets
and terminates owned processes. A stale worker remains uncertain until explicitly
cancelled, never automatically retried.

Ordinary discovered commands reserve half the host workers (`weight: 1`) or the
whole budget (`weight: 2`), plus named exclusive resources. These declarations
must honestly describe internally parallel commands. This repository declares
its exact aggregate commands in `.orkestrator-test-scheduler.json`: they instead
reserve their constituent groups and publish bounded scheduling state through a
private per-command channel, avoiding nested/double reservations. A cooperative
runner's startup (shell profile, toolchain resolution, transpilation) is allowed
a generous first-publish window before it is considered stalled; staleness is
then measured from its last successful read, not from spawn. A missing or stale
cooperative heartbeat makes validation incomplete.
Declared exclusive resources also reach those groups: constituents of one
command may share them internally, but another command cannot use them while
an owning group is running.

Discovery must use those exact entries as separate commands. An unconfigured
wrapper that launches an aggregate runner while holding its own reservation
stops with an explicit infrastructure limitation (exit 75), instead of waiting
for its own capacity forever. Declare the wrapper's cooperation before using it.

After admission, the worker (and each cooperative group) rechecks clean HEAD.
Changed snapshots require rediscovery rather than certifying stale code. One
validation run still feeds the round's shared, hashed, immutable review artifacts;
reviewers do not each launch full suites. `incomplete` evidence carries a reason
and any partial logs. Reviewers must report that gap as a limitation, not invent
a failed test or claim full validation passed.

## Caching and duration history

Workspace and bridge package tests run as Turbo tasks, but both are declared
`"cache": false`. A replayed cache entry would let a group report success having
executed nothing, and this repository still tracks live flakes in
`docs/flaky-tests.md`, so a green that proves only "the inputs are unchanged" is
not worth the seconds it saves. Every aggregate invocation runs every test.

`build` stays cacheable, and it is the expensive dependency. `test:workspace`
still depends on it, so a warm run skips the rebuild and goes straight to the
tests. Both test tasks keep their `inputs` declarations, which name the shared
Bun configuration and preload files alongside the package files, so the wiring
is already correct if caching is ever reconsidered.

Turborepo 2.8 automatically shares its local cache across linked Git worktrees
when no explicit cache directory is configured. Do not add a relative
`--cache-dir .turbo` or `cacheDir` setting: an explicit relative directory
disables that worktree sharing and turns each new agent worktree into a cold
build. CI still needs to restore a local cache or use remote caching because a
fresh checkout has no local cache to share.

The aggregate groups pass `--output-logs=new-only`, which streams the output of
every executing task and hides only replayed build logs. Streaming is what keeps
the no-progress watchdog meaningful, and it is why a passing group's log still
shows real per-package test counts.

Turbo runs each package script from that package's directory, and Bun reads
`bunfig.toml` from the invocation directory without walking up to the repository
root. Bridge test scripts therefore name the root preloads explicitly with
`--preload ../../tests/register-dom.ts --preload ../../tests/setup.ts`. Dropping
them is not a silent no-op: `tests/setup.ts` is what sets
`CODEX_BRIDGE_NO_SERVER`, isolates the git configuration, and installs the
bounded diagnostics, so without it the codex bridge suite binds a real port and
fails. A unit test derives the expected flags from `bunfig.toml` so the two
cannot drift.

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

Keep [../flaky-tests.md](../flaky-tests.md) current for credible flakes. Record
the exact test and file, original command and worker configuration, failure
message and duration, suite counts, isolated rerun command and result,
observation date, and an evidence-backed hypothesis. Do not skip, loosen, or
delete a test to hide an intermittent failure. When fixed, retain the history
and mark the entry resolved with stress or parallel verification.

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
