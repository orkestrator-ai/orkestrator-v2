# Playwright temporary directories 0248 leaves uncontained

Found on 2026-10-28 while implementing
[0248](0248-playwright-profile-dir-leaks.md).

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`. Rechecked 2026-10-30
against `main` at `cd7bbe3e5`: neither task had merged (the configs and the
ledger were unchanged since 0248, #1425), and both were implemented then.

### Tasks

1. **Private `TMPDIR` for the real-stack and preview Playwright suites**: the `e2e/agent-testing/*` and `e2e/preview` configs still launch browsers in the shared temporary directory. Status: done (live qualification partial, see Needs verification).
2. **The design renderer's `playwright-artifacts-*` directory**: a killed backend leaves one empty directory per browser that the 0248 ledger cannot record. Status: done.

### 1. Private `TMPDIR` for the real-stack and preview Playwright suites

**Problem.** A killed worker in these suites leaves its browser profile in the
shared temporary directory, where nothing can attribute or remove it.

**Context.** 0248 gave the two `test:browser` configs a private `TMPDIR`
(`tests/private-tmpdir.ts`), because Playwright Test workers owned every live
profile on the macOS host. The other configs start real backends, agents and
fixture servers that inherit the runner's `TMPDIR`.

**Investigation.** Not run: these suites drive live agents for many minutes
and are never part of the default validation (`AGENTS.md`). A backend started
under a private `TMPDIR` puts its own temporary files there too, including any
Unix sockets, so the macOS 104-byte socket path limit has to be checked
against the longest path those backends make.

**Decisions.**

- **Contain them, or leave them to their own cleanup?**
  - **Call `enterPrivateTestTmpdir()` from each config, as 0248 did, after one isolated qualification run per suite (recommended).**
    - Pros: the same containment and sweep as every other test process; a killed run becomes attributable.
    - Cons: needs one live run of each suite; the backends they start move their temporary files too.
  - **Leave them.**
    - Pros: no change to suites that are expensive to requalify.
    - Cons: they stay the uncontained source of the kind of burst 0248 started from.

### 2. The design renderer's `playwright-artifacts-*` directory

**Problem.** Each Playwright launch also makes `playwright-artifacts-XXXXXX` in
the launching process's temporary directory, removed with the profile. A
killed backend leaves it behind, and the 0248 ledger records only the profile.

**Context.** The 0248 ledger reads the profile from Chromium's
`--user-data-dir=` argument. The artifacts directory is not on Chromium's
command line, and its name holds no owner.

**Investigation.** The macOS host held 7 of these on 2026-10-28, against 67
profiles. They are empty for the design renderer, which uses no downloads,
traces or video. `playwright-core` 1.64.0 skips making it when the launch
options carry `artifactsDir` (`_prepareToLaunch`), but that option is not in
the public `launchServer()` type.

**Decisions.**

- **How to contain it?**
  - **Pass `artifactsDir` pointing into a directory the ledger owns, if `launchServer()` honours it at run time, and remove it with the record (recommended).**
    - Pros: nothing left in the shared temporary directory; no change to ownership of the browser process.
    - Cons: relies on an option outside the public type, so a Playwright upgrade must recheck it.
  - **Leave it.**
    - Pros: no change; each is an empty directory.
    - Cons: an unowned entry per killed backend accumulates in the shared temporary directory.

## Assumptions and decisions

### Task 1: every real-stack and preview config enters a private `TMPDIR`

Took the recommended option. `playwright.browser.config.ts` (which the Claude
warm and paused-interactions configs spread, so they share it),
`playwright.coordinator.config.ts`, `playwright.electron.config.ts` and
`e2e/preview/playwright.preview.config.ts` call `enterPrivateTestTmpdir()`
exactly as the `test:browser` configs do. The macOS socket-length concern in
the Investigation is already covered by `privateTmpdirRoot()`, which puts the
directory under `/private/tmp` there, and on Linux the private directory is
directly in the system temporary directory.

### Task 1: a restarted `dev:test` launcher keeps the shared `TMPDIR`

The current code showed a gap the analysis did not name. Five browser-config
specs (`cold-restart-live`, `graph-run-view`, `multi-review-live`,
`permission-rules`, `web-annotations-approval-live`) restart the profile with
a detached `dev:test` launcher that outlives the run. The runner removes its
private directory on exit unless a live process names it on its command line,
and a launcher only carries it in its environment, so the restarted backend,
Vite, Electron and bridges would have lost their `TMPDIR` before `dev:stop`.
Chose a new `outlivingProcessEnv()` in `tests/private-tmpdir.ts`, which hands
such a process the parent `TMPDIR` and drops the private variables, passed at
each of the five spawns. Rejected: reading every process's environment at
removal time (`/proc/*/environ` has no portable macOS counterpart, and it would
keep the whole directory for the profile's lifetime). The profile the isolated
runner starts is outside the Playwright run and was never affected.

### Task 1: qualification without billed turns

The recommended option asked for one isolated qualification run per suite. The
billed real-stack suites (live agents, the coordinator suite) could not run
under this work's constraints. Instead
`tests/unit/private-tmpdir-playwright.integration.test.ts` now loads each of
the four newly wired configs as well as the two `test:browser` ones, in a real
Playwright runner and worker, and checks both share one private directory that
is removed on exit, or kept while a browser that outlived the worker names it.
Live runs on the Linux host, each under its own `TMPDIR`:

- `mise run test:preview:browser -- --project chromium` passed.
- `electron-cleanup.spec.ts` through the Electron config passed.
- `mise run test:agent:design:isolated` (credential-free; the browser config
  against a disposable profile) ran its three cases, which all failed before
  reaching the canvas: the profile opened with the "Docker containers can't
  reach Orkestrator" dialog over the sidebar, because this host's ufw drops
  container traffic to the profile's agent-tools port. That is a host
  firewall state, not this change, and the host configuration was left
  alone. The run still showed the wiring: the runner's private directory was
  gone afterwards, and no `playwright_chromiumdev_profile-*` or
  `playwright-artifacts-*` was left in the run's `TMPDIR`.

After each run the only Playwright entry left in that `TMPDIR` was
`playwright-transform-cache-<uid>`, Playwright's compile cache, which the
runner makes before it loads a config and reuses across runs.

See Needs verification for what is left.

### Task 1: two tests broken on Linux by 0248's private `TMPDIR`

Chromium aborts at launch (`process_singleton_posix.cc: Socket path too long`)
when its `SingletonSocket`, which it makes in `TMPDIR`, passes Linux's 108-byte
limit. Two slow-tier tests launch full Chrome under a temporary directory of
their own inside the test process's private one, and failed on unchanged
`main` on this host: `renderer.test.ts` (killed backend sweep, 114 bytes under
`/tmp`) and the "retained for a live browser" cases of
`private-tmpdir-playwright.integration.test.ts`. Not flakes: they fail every
time. The design test now uses shorter names (`ork-dk-`, `t`); the
integration test makes its root in the parent `TMPDIR`
(`ORKESTRATOR_TEST_PARENT_TMPDIR`), because its runner's private directory
nests inside it. The testing guide records the limit.

### Task 2: `artifactsDir` inside the ledger, removed with the record

Took the recommended option. One correction to the Investigation:
`playwright-core` 1.64.0 *does* declare `artifactsDir` in the public
`launchServer()` type (`types.d.ts`, the `launchServer(options?)` overload), and
the server launcher passes it through `BrowserTypeLaunchParams` to
`_prepareToLaunch`, which then skips its `mkdtemp`. A direct probe launched
`launchServer({ artifactsDir })` and left no `playwright-artifacts-*` in
`TMPDIR`. So no off-type option is needed, though an upgrade should still keep
the real-Chromium test green.

The ledger makes `artifacts-<backend pid>-<random>` directly inside
`<data dir>/design-browser-profiles/` (`createArtifactsDir()`), the renderer
passes it to the launcher, and the record stores it. It is removed with the
record by `release()` and by the startup sweep (alongside the profile, or when
the profile is already gone). A failed launch, or a browser whose profile could
not be recorded, has it removed directly (`discardArtifactsDir()`). One no
record holds (its backend was killed between creating it and recording the
browser) is swept once its backend PID has exited and it is over an hour old;
a record that cannot be read keeps all of those. A record or caller naming an
artifacts path outside the ledger directory is never acted on. Playwright
leaves an explicit `artifactsDir` in place on close, which is why the ledger,
not Playwright, removes it.

Placed inside the ledger directory rather than the temporary directory so the
name can carry an owner and nothing is left in the shared temporary directory.
A sibling `artifacts/` subdirectory was rejected: its empty parent would stay
behind after the last record goes.

### Task 2: the artifact preview worker is left as is

`transcript-artifacts/preview-jobs.ts` also calls `launchServer()` without
`artifactsDir`, but its supervisor runs the worker with `TMPDIR` set to the
job's own scratch directory (`preview-supervisor.ts`), which is removed after a
verified exit or by the backend's start-up sweep. Its artifacts directory is
already contained.

## Needs verification

- A green `mise run test:agent:design:isolated` on a host whose firewall lets
  containers reach the agent-tools port.
- A full `mise run test:agent:browser:isolated` with credentials, which
  includes the five specs that restart `dev:test` through
  `outlivingProcessEnv()`. None of them ran live here.
- `mise run test:agent:coordinator` (billed) and the rest of
  `mise run test:agent:electron`; only `electron-cleanup.spec.ts` ran.
- The preview suite's Firefox and WebKit projects; those browsers were not
  installed on the host.
- Any of these suites on macOS, where the private directory goes under
  `/private/tmp`.

## Related

- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
