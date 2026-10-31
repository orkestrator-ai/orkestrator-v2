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

The recommended option asked for one isolated qualification run per suite. In
the initial implementation the billed real-stack suites (live agents, the
coordinator suite) did not run. Instead
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
- Green completion of the five specs that restart `dev:test` through
  `outlivingProcessEnv()`. The review runs below attempted them live; host
  startup and provider errors prevent claiming qualification.
- Coordinator qualification beyond the passing Codex read-only scenario below,
  and the rest of `mise run test:agent:electron`; the initial implementation
  ran only `electron-cleanup.spec.ts`.
- Any of these suites on macOS, where the private directory goes under
  `/private/tmp`.

## Review coverage and retained validation (2026-10-30)

Tested on Arch Linux with repository-pinned Bun 1.4.4 and Playwright 1.64.0,
on implementation commit `f40221b13` plus this review's test-only changes,
committed as `cc497998c` and `e26cd5100`. The latter makes detached-child
result publication atomic, so polling cannot read a partial JSON file.
Passing raw logs are deleted by `test:logged`; its retained `summary.json`
files and the results below preserve exit statuses and durations.

Two regressions now cover the remaining lifetime boundaries:

- `tests/unit/private-tmpdir-playwright.integration.test.ts` starts a private
  directory owner and a detached Bun child using `outlivingProcessEnv()`.
  The child signals readiness, then waits until the test has joined the owner
  and verified its private directory was removed. Only then may it create a
  temporary directory and file. It must use the original parent directory and
  inherit neither ownership marker. The test owns and stops the detached
  process group even on assertion failure.
- `apps/backend/src/core/design/renderer.test.ts` holds launch past the launch
  deadline and, separately, past completed shutdown. Each late handle is
  recorded in a real profile ledger. A close gate proves the artifacts stay
  owned during termination; releasing it removes the profile, record and
  artifacts without creating a browser context.

### Slow owners and static checks

All commands use `mise run test:logged -- --name <label> -- <command>`.

| Label | Command | Result and retained summary |
| --- | --- | --- |
| `tmpdir-playwright-review` | `bun test ./tests/unit/private-tmpdir-playwright.integration.test.ts --parallel=1 --only-failures` | Passed, 22.2 s; `/tmp/orkestrator-test-run.CkyCnv/summary.json`. Includes all six real configs with both runner/worker cleanup outcomes and the detached-child regression. |
| `renderer-review` | `bun test --cwd apps/backend ./src/core/design/renderer.test.ts --parallel=1 --only-failures` | Passed, 8.5 s; `/tmp/orkestrator-test-run.pmaK01/summary.json`. Chromium was present; the killed-backend artifacts regression and other real-browser cases ran. |
| `private-tmpdir-unit-review` | `bun test ./tests/unit/private-tmpdir.test.ts --parallel=1 --only-failures` | Passed, 1.5 s; `/tmp/orkestrator-test-run.grC3Xf/summary.json`. |
| `tmpdir-root-types-review` | `bun check -p tests/tsconfig.json` | Passed after giving the new subprocess environment its `NodeJS.ProcessEnv` annotation; the exact command was rerun, 3.0 s, `/tmp/orkestrator-test-run.2AlWEO/summary.json`. |
| `renderer-test-types-review` | `bun check -p apps/backend/tsconfig.test.json` | Passed, 2.4 s; `/tmp/orkestrator-test-run.uJEHka/summary.json`. |

Changed-file `bun fmt --check` and `bunx oxlint` passed. Preparation's passing
default suite (`/tmp/orkestrator-test-run.oFUlzG/summary.json`), full lint and
full typecheck were reused rather than repeated.

Both slow owners were also run directly on pinned test commit `cc497998c`,
with the same test selection and `--reporter=junit --reporter-outfile=...`.
Labels `tmpdir-playwright-pinned` and `renderer-pinned` passed in 19.9 s and
7.8 s respectively: 13 and 31 tests, with zero failures or skips. After the
atomic-publication change, the TMPDIR owner passed again on `e26cd5100`
(13 tests, zero failures or skips, 20.0 s;
`/tmp/orkestrator-test-run.GLsuEY/summary.json`), and its typecheck and lint
passed again. Their JUnit reports are retained under
`output/playwright/0830-review/` as `tmpdir-playwright.xml` and `renderer.xml`
(moved there from `output/validation/0830-review/` after the runs).

### Live coordinator and alternate preview engines

`mise run test:logged -- --name coordinator-live-tmpdir-review -- mise run
test:agent:coordinator --credential-source codex --scenario read-only` passed
in 71.8 s. The actual coordinator config ran a real Codex turn in disposable
profile `qa-coordinator-codex-b93d2fb9`, which was stopped and reset. Retained
summary: `/tmp/orkestrator-test-run.hDcWiJ/summary.json`; scenario verdict:
`output/agent-testing/qa-coordinator-2026-10-30T03-15-43-451Z/summary.json`.

`mise run test:logged -- --name preview-firefox-webkit-review -- bunx
playwright test --config e2e/preview/playwright.preview.config.ts --project
firefox --project webkit` passed in 47.8 s. Both browser binaries were first
installed with the pinned Playwright CLI. WebKit additionally needed ICU 74,
libxml2 and flite from the already-present pinned Playwright worker image;
these were copied into its user-local `minibrowser-wpe/sys/lib`, without
changing host system libraries. The exact preview command was rerun after
each dependency repair. Retained summary:
`/tmp/orkestrator-test-run.a7jO4r/summary.json`. Vite HMR remained opt-in.
An intermittent Firefox IPv6 navigation failure and its complete-owner pass
are recorded in [1319](../../tests/flaky-tests/previews-annotations-and-gateway/1319-firefox-preview-ipv6-empty-response.md).

### Live restart attempts

Started disposable profile `qa-tmpdir-0830-restarts` with `dev:test --fixture
--credential-source claude --credential-source codex --agent-platforms
claude,codex`. The focused command was:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-tmpdir-0830-restarts \
ORKESTRATOR_AGENT_TEST_RUN_ID=qa-tmpdir-0830-restarts \
ORKESTRATOR_AGENT_TEST_LIVE_PERMISSION_RULES=1 \
ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1 \
ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART=1 \
ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION=1 \
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=900000 \
mise run test:logged -- --name restart-scenarios-tmpdir-review -- \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/permission-rules.spec.ts:109 \
  e2e/agent-testing/graph-run-view.spec.ts:653 \
  e2e/agent-testing/multi-review-live.spec.ts:823 \
  e2e/agent-testing/web-annotations-approval-live.spec.ts:480 \
  e2e/agent-testing/cold-restart-live.spec.ts --workers=1
```

Exit 1 after 83.0 s: four failed, one skipped, one serial case did not run.
Evidence: `/tmp/orkestrator-test-run.ApBAza/summary.json` and
`restart-scenarios-tmpdir-review.log.gz`; sanitized browser results and failure
screenshots are under `output/agent-testing/qa-tmpdir-0830-restarts/browser/`.
The native cold-restart, Multi Review and permission-rule cases were blocked
by the host's "Docker containers can't reach Orkestrator" modal, before their
restart checks. The annotation case reported "Claude ended the turn on an API
error" before reaching approval. These are not passing qualification and no
assertions were weakened to hide them.

The graph restart needs its own opt-in. Reran it alone with
`ORKESTRATOR_AGENT_TEST_GRAPH_RESTART=1`, profile as above, run ID
`qa-tmpdir-0830-graph`, label `graph-restart-tmpdir-review`, and the same
Playwright command selecting only `e2e/agent-testing/graph-run-view.spec.ts:653`.
It restarted the profile and verified the persisted wait's identity and state,
then failed at line 704 opening the UI: the page showed "Orkestrator couldn't
connect". Exit 1, 48.3 s; `/tmp/orkestrator-test-run.uSfzX4/summary.json` and
`graph-restart-tmpdir-review.log.gz`. Its restarted launcher stayed ready after
Playwright exited; full graph UI qualification remains outstanding.

The previously unrun serial cold build case was selected alone at
`e2e/agent-testing/cold-restart-live.spec.ts:869` with the same profile,
`ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART=1`, run ID
`qa-tmpdir-0830-cold-build`, no-progress timeout 900000 ms and label
`cold-build-restart-tmpdir-review`. It performed its crash restart. The build
stage then went idle without the required `TRAILEND` marker in its committed
assistant rows; subsequent verify/fix stages did produce the marker, but
cannot satisfy the assertion about the original build session. After 430.4 s,
sent SIGINT to this run's exact Playwright CLI to stop further billed stages.
Exit 130, one interrupted; this is incomplete qualification, not a pass.
Evidence: `/tmp/orkestrator-test-run.FhbDV3/summary.json` and
`cold-build-restart-tmpdir-review.log.gz`, plus sanitized results under
`output/agent-testing/qa-tmpdir-0830-cold-build/browser/`.

After Playwright exited, inspected only the restarted launcher/backend's
temporary-directory environment entries. Neither carried a private ownership
marker, both still named an existing temporary directory, and Bun subprocesses
using those entries successfully created and removed a temporary file. Thus
the actual restarted profile also survived its Playwright owner's exit.
Stopped and reset `qa-tmpdir-0830-restarts`; no launcher or profile state was
deliberately retained. Browser failure artifacts and JUnit reports remain in
the checkout's output directories.
Both profiles' final `dev:status --json` responses were `status: "missing"`
with empty `live` maps (only empty data directories remained). The original
foreground `restart-profile-start-review` launcher exited 143 when the graph
test deliberately stopped it for restart; that is an expected lifecycle exit,
not a failed startup (`/tmp/orkestrator-test-run.VkWjQa/summary.json`).

## Related

- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
