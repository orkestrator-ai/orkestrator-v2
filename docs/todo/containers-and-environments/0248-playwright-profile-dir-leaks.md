# Leftover Playwright browser profile directories

Checked against `main` at `7809191f` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Find the 2026-10-25 burst**: identify what made 259 profiles between 12:40 and 12:42. Status: closed without a source (2026-10-28): not chased further, as recommended; the macOS evidence below points at Playwright Test runs, and every test-owned launch is now attributable.
2. **Sweep stale profiles automatically**: remove profiles past an age floor that no live process uses, both in tests and in the backend. Status: done (2026-10-28); the backend half deviates from the recommendation, see [decision 3](#3-task-2-backend-a-profile-ledger-under-the-data-directory-not-a-private-tmpdir).
3. **Report profiles in `disk:report`**: show their count, size and age. Status: done (2026-10-28).
4. **Qualification run**: `mise run test` plus design and preview use, a backend SIGKILL and a restart, then `/tmp` holds nothing stale. Status: partly done (2026-10-28): `mise run test` ran on macOS, and the SIGKILL-and-restart path of the design renderer is an automated real-Chromium test; the `dev:test` session on omarchy-hp is still open.
5. **Where the sweep lives (open question)**: a shared helper, or a private `TMPDIR` for the backend's launches. Status: settled (2026-10-28): one owner-scoped path per owner, no helper shared across `tests/` and `apps/`.
6. **Origin of the `ork-artifact-preview-*` directories (Needs verification)**: real previews or tests. Status: instrumented (2026-10-28); needs a day of production logs.

### 1. Find the 2026-10-25 burst

**Problem.** 259 profiles appeared in two minutes, which points to a run that started many browsers and was killed.

**Context.** Playwright makes each profile with `mkdtemp(... "playwright_chromiumdev_profile-")` and removes it only from the launching process when the browser exits. The name holds no PID.

**Investigation.** `/tmp` now holds 273 profiles: the same 259 from 2026-10-25 12:xx, and 14 from 2026-10-26 between 10:00 and 13:59. That is one more than the file records, and none appeared after 2026-10-26 13:59. They total 2.8 MB. The pinned version is still `playwright-core` 1.64.0 (`apps/backend/package.json:33`). The same hour also has 31 `ork-artifact-preview-*` directories, so a preview-heavy run may account for both. No log on the host names the run: the production backend's logs under `~/.config/orkestrator-v2/logs/` do not mention previews.

**Decisions.**

- **Keep chasing the 2026-10-25 burst, or design for the next one?**
  - **Stop chasing it; make every future leak attributable instead (recommended).** Give test processes a PID-named `TMPDIR` (task 2), so the next burst names its owner.
    - Pros: the evidence for 2026-10-25 is gone; the 2.8 MB at stake is small; task 2 fixes the class of leak anyway.
    - Cons: if the source was one of our own long-running harnesses, it keeps leaking until task 2 lands.
  - **Correlate the burst with agent sessions and test runs on the host at that time.**
    - Pros: could find a harness bug directly.
    - Cons: needs transcript and terminal history, which the guidance says must not be copied into artifacts; there is likely no answer.

### 2. Sweep stale profiles automatically

**Problem.** Nothing removes a leaked profile, and on this host `/tmp` is a 16 GB tmpfs, so leaked files use RAM.

**Context.** A profile counts as stale only when it is past an age floor and no live process uses it as `--user-data-dir`. The design renderer's browser lives as long as the backend. Playwright rejects `--user-data-dir` in `launch()` and `launchServer()`.

**Investigation.** `launchDesignBrowser` (`apps/backend/src/core/design/renderer.ts:75-79`) uses the backend's own `TMPDIR`. Preview jobs (`transcript-artifacts/preview-jobs.ts:92`) use the worker's scratch directory, set as `TMPDIR` by `processWorkerEnv` (`preview-supervisor.ts:128-143`). `tests/temp-sweep.ts:30` and `:83` support an age-only sweep (`legacyMaxAgeMs`), but nothing calls it for this prefix.

Bare profiles cost little: 2.8 MB for 273. Preview scratch directories cost far more. Each holds a full profile, `.cache` and `.config` and takes about 9 MB, so the 206 on this host use 1.8 GB of tmpfs. That is roughly 650 times what the file's "3.6 MB" figure suggests is at stake.

**Decisions.**

- **How should tests contain their profiles?**
  - **A PID-named private `TMPDIR` per test process, set from the preload and swept with `sweepStaleTempDirs` once its owner is dead (recommended).**
    - Pros: catches profiles and every other test leak inside the directory; the owner can be proved; no `/proc` scan needed.
    - Cons: it must be set before Bun caches `os.tmpdir()`, so it may have to go in the runner (`scripts/test-all.ts`) rather than `tests/setup.ts`; Turbo must pass `TMPDIR` through (0247 task 5).
  - **Sweep `/tmp/playwright_chromiumdev_profile-*` at the start and end of `scripts/test-all.ts`, by age floor plus a `/proc` scan for `--user-data-dir`.**
    - Pros: no change to the test environment.
    - Cons: the same prefix is used by `playwright-cli` and agent browser sessions, so removal relies on the `/proc` check alone; another user's processes are not visible.
- **How should the backend contain its own?**
  - **Launch design and preview browsers with a backend-owned `TMPDIR` under the data directory, and empty it at startup (recommended).**
    - Pros: only Orkestrator's own browsers live there, so a startup sweep is safe without a liveness scan.
    - Cons: profiles move off tmpfs onto disk; a startup sweep has to wait until no old backend shares that data directory.
  - **Sweep the system `/tmp` at startup by age and liveness.**
    - Pros: also clears leaks from before the change.
    - Cons: risks deleting other tools' live profiles, against the constraints.

### 3. Report profiles in `disk:report`

**Problem.** Operators cannot see these leftovers.

**Context.** `disk:report` is read-only.

**Investigation.** `scripts/disk-report.ts:418-429` reports only `orkestrator-*` under the temporary directory. It shows neither `playwright_chromiumdev_profile-*` nor `ork-artifact-preview-*`, which is the far larger cost here.

**Decisions.**

- **Which prefixes to report?**
  - **Both `playwright_chromiumdev_profile-*` and `ork-artifact-preview-*`, each as its own row (recommended).**
    - Pros: shows where the 1.8 GB actually is.
    - Cons: profiles from other tools are counted too, so the row has to say that its owner is uncertain.
  - **Profiles only, as the file says.**
    - Pros: narrower.
    - Cons: misses the preview scratch directories that dominate the size.

### 4. Qualification run

**Problem.** The fix needs evidence that a killed backend leaves nothing stale.

**Context.** The run must not kill the production backend on the host.

**Investigation.** None: this waits on task 2.

**Decisions.**

- **Where to run the SIGKILL step?**
  - **An isolated `dev:test` profile, with the SIGKILL sent to that profile's backend PID as recorded by `dev:status` (recommended).**
    - Pros: follows the host safety rules; exercises the real design and preview paths.
    - Cons: the `dev:test` backend's `TMPDIR` must match the production layout for the result to transfer.
  - **A standalone backend started by hand with a temporary data directory.**
    - Pros: simpler process ownership.
    - Cons: no real design canvas session, so the design renderer path goes unchecked.

### 5. Where the sweep lives

**Problem.** Tests and the backend both need a stale-directory sweep.

**Context.** This is the file's open question. `tests/temp-sweep.ts` lives under `tests/`, and backend code cannot import from there.

**Investigation.** The backend has no temporary-directory sweep helper today.

**Decisions.**

- **Shared helper, or a private `TMPDIR` per owner?**
  - **A private `TMPDIR` per owner (backend: its data directory; tests: per process), each emptied by its owner (recommended).**
    - Pros: no cross-owner deletion, which honours the "when unsure, keep it" constraint; no shared code across the `tests/` and `apps/` boundary.
    - Cons: two small sweep paths instead of one.
  - **Move `temp-sweep.ts` into a shared package used by both.**
    - Pros: one implementation.
    - Cons: still has to decide liveness for a PID-less prefix in the shared `/tmp`, which is the hard part.

### 6. Origin of the `ork-artifact-preview-*` directories

**Problem.** If real previews leave these directories behind, production leaks about 9 MB per preview.

**Context.** This question is shared with [0247](0247-test-temp-dir-leaks-from-full-sweep.md) task 2.

**Investigation.** The count has grown from the file's 146 to 206 today, with the newest at 2026-10-26 21:57. They come in batches of 6 (or multiples of 6), one second apart, and hold `.config/google-chrome-for-testing`. So the 6 jobs ran in sequence, not as a concurrent test fan-out.

I ran 17 preview-reaching backend test files under a private `TMPDIR`: nine of them alone, then all 17 in two `--parallel=2` batches. None left a scratch directory. So the batches do not come from those files under focused runs. Production removes scratch only after a verified kill (`preview-supervisor.ts:338`, `:348`), and nothing sweeps it at startup. Another possible source is a real backend started outside `bun test`: `transcriptArtifactRuntime` defaults to on when `NODE_ENV` is not `test` (`apps/backend/src/core/index.ts:948`). That covers the CLI scenario harness, the packaged-backend test and the production app.

**Decisions.**

- **How to settle the origin?**
  - **Log a content-free counter of scratch directories left behind after an unverified kill, and check the production backend's logs after a day (recommended).**
    - Pros: decisive for production; no prompts or contents logged.
    - Cons: needs a code change and a day of real use.
  - **Fix both paths without settling it (the startup sweep in task 2).**
    - Pros: removes the leak whatever its source.
    - Cons: a test or harness bug that makes six previews per run stays unexplained.

Every Playwright Chromium launch makes a throwaway profile directory,
`playwright_chromiumdev_profile-XXXXXX`, in the launching process's temporary
directory. Many of them are never removed. Nothing deletes them
automatically today; this file is the work to make that happen.

## Current state

- How Playwright handles the directory (`playwright-core` 1.64.0,
  `lib/coreBundle.js`): `mkdtemp(join(os.tmpdir(), "playwright_chromiumdev_profile-"))`
  at launch, then `removeFolders(tempDirectories)` from the **launching**
  process when the browser exits. The directory therefore leaks whenever the
  launching process is gone before the browser exits (a SIGKILL, a test
  timeout, `process.exit` before cleanup) or the removal fails. The name holds
  no PID, so a later process cannot tell who owned it.
- What was found on omarchy-hp (Arch Linux x86_64) on 2026-10-26:
  - 272 directories directly under `/tmp`, 3.6 MB in total. 259 of them were
    created between 12:40 and 12:42 on 2026-10-25, a single burst; the other 13
    are spread across 2026-10-26. None was in use: no running process had any
    of them as `--user-data-dir`.
  - One came from a `chrome-headless-shell` that crashed at startup at
    10:49:52 (core dumps for PIDs 2704660 and 2704890). Its profile,
    `/tmp/playwright_chromiumdev_profile-iNxw1y`, was created that same second
    and is still there, still empty.
  - 146 `ork-artifact-preview-*` scratch directories (61 from 2026-10-25,
    85 from 2026-10-26). Each holds its own `playwright_chromiumdev_profile-*`,
    because the preview worker's `TMPDIR` is its scratch directory.
- Code that launches Playwright Chromium:
  - Production: the design renderer (`apps/backend/src/core/design/renderer.ts`,
    `chromium.launchServer`, in the backend's own temporary directory) and
    artifact preview jobs
    (`apps/backend/src/core/transcript-artifacts/preview-jobs.ts`, inside the
    worker's private scratch directory).
  - Tests and scripts: `chromium.launch` in the backend's transcript-artifact
    and design tests, `e2e/perf/*`, `scripts/qa-leaf-workspace-browser.ts`,
    and the Playwright test runner behind the `test:browser` and
    `test:agent:browser*` tasks.
- `tests/temp-sweep.ts` can already sweep a prefix by age alone
  (`legacyMaxAgeMs`) when the name holds no PID. It cannot tell whether a
  directory is still in use.
- `disk:report` lists `orkestrator-*` leftovers in the temporary directory but
  not Playwright profiles.

## Outstanding work

### Code

1. Find what produced the burst of 259 on 2026-10-25 between 12:40 and 12:42
   (a killed test run, the recurring live runner, or a backend restart) and fix
   it at the source if it is ours.
2. Remove stale profiles automatically. A profile is stale only when it is past
   an age floor (hours, not minutes) **and** no live process uses it as
   `--user-data-dir`. The age floor alone is not enough: the design renderer's
   browser lives as long as the backend, and its profile is as old as the
   backend.
   - Tests: sweep at the start and end of `scripts/test-all.ts`, or give each
     test process a private, PID-named `TMPDIR` from the preload
     (`tests/setup.ts`) so `sweepStaleTempDirs` can remove it, and everything
     else leaked inside it, once its owner is dead.
   - Backend: sweep the backend's own temporary directory at startup, where the
     design renderer's profiles live.
3. Add `playwright_chromiumdev_profile-*` to `disk:report`, showing the count,
   size and age of what would be swept.

### Qualification

1. After the fixes, run `mise run test` and a session that uses the design
   canvas and artifact previews. Kill the backend once with SIGKILL, restart it,
   and record that no profile older than the age floor is left in `/tmp`.

## Constraints and rationale

- Never remove a profile a live browser is using, including one owned by
  another user's process or by a container sharing `/tmp`. When unsure, keep
  it.
- Do not touch profiles other tools create in the same place (`playwright-cli`
  and agent browser sessions) unless they are both stale and unused. They use
  the same prefix and cannot be told apart.
- Playwright rejects `--user-data-dir` in `launch()` and `launchServer()`
  args, so we cannot pick the directory name ourselves without switching to
  `launchPersistentContext`. That is why the options above sweep, or contain
  the directory inside a temporary directory we own.

## Open questions

- Settled on 2026-10-28: one sweep path per owner, see
  [decision 6](#6-task-5-one-sweep-path-per-owner).

## Needs verification

- Whether the 85 `ork-artifact-preview-*` directories from 2026-10-26 came from
  real previews in the running app or from preview tests. This is the open
  question in [0247](0247-test-temp-dir-leaks-from-full-sweep.md)'s Needs
  verification, and it decides whether production leaks preview scratch
  directories. Their profiles go when their scratch directory goes, so they
  need no separate sweep.

## Evidence from the macOS host (2026-10-28)

Read-only counts in this host's `$TMPDIR` (`/var/folders/…/T`; `/tmp` held
none of these prefixes). Nothing outside this run's own directories was
removed.

- 75 `playwright_chromiumdev_profile-*` directories at the first count, 67 at
  the second (86 to 91 MB), and 7 `playwright-artifacts-*`. They came in
  clusters: 18 in one hour on 2026-10-27, 10 in one hour on 2026-10-28.
- The 9 profiles in use at the time all belonged to
  `chrome-headless-shell` processes whose parents were Playwright Test workers
  (`playwright/lib/worker/workerProcessEntry.js` under Node) of another
  worktree's `playwright test --config e2e/playwright.config.ts`. No live
  profile belonged to a Bun test or a backend.
- Of the unused ones, 52 hold only `Default/` (27 files in most), with file
  times spread over about two minutes after the directory was made and no
  top-level `Local State`, which Chromium writes when it shuts down. That is
  what a browser killed with its launcher leaves.
- The real-Chromium test added here shows the backend half of that: after its
  launcher is SIGKILLed, Chromium exits by itself within seconds (its pipe
  closes), and its profile stays.

The only launcher in the repository that runs many browsers at once is
Playwright Test (`fullyParallel`, default workers, two projects, and a new
worker, so a new browser, after every failing test). A run whose workers were
killed or kept failing is therefore the likely source of the 2026-10-25 burst,
but nothing on this host proves it, and the Arch host's evidence is gone.

## Implementation (2026-10-28)

- **Tests.** `tests/private-tmpdir.ts` gives a process a private `TMPDIR`,
  `ork-test-tmp-<pid>-<random>`, under the one it had (under `/private/tmp`
  on macOS). `tests/isolate-tmpdir.ts`
  loads it from both Bun preloads (`tests/setup.ts`, `tests/setup-node.ts`),
  after the git-config and worktree isolation, and the two `test:browser`
  Playwright configs (`e2e/playwright.config.ts`,
  `e2e/public-site/playwright.config.ts`) call it in the runner, whose workers
  inherit it. Each owner removes its directory when it finishes, unless a live
  process names it on its command line. The next test process sweeps the
  directories of exited owners that are over an hour old and that no live
  process names. `tests/temp-sweep.ts` gained that in-use check
  (`isInUse`, `namedByLiveProcess`) and, without an explicit root, also sweeps
  the parent of a private `TMPDIR`, so the existing prefix sweeps still reach
  leftovers made before a process went private.
- **Backend, design renderer.** `launchDesignBrowser` reads the profile from
  the browser's spawn arguments (`--user-data-dir=`). The renderer records it
  in `<data dir>/design-browser-profiles/` (`design/browser-profiles.ts`), with
  the backend's and the browser's PIDs and start identities, and drops the
  record after the browser is closed once Playwright has removed the profile.
  `DesignService.initialize()` sweeps at start-up: a recorded profile goes
  only when its backend and its browser have both exited, it is over an hour
  old, and no live process names it. An unrecorded profile is never touched.
  `processStartIdentity` and `isProcessAlive` moved from the preview supervisor
  to `core/process-identity.ts`, which both callers use.
- **Backend, preview scratch.** Unchanged from 0247 (PID-named, removed at
  start-up). The runner's `close()` now logs
  `[artifact-preview] worker scratch left for startup recovery` with only a
  count and the isolation mode when a worker's scratch outlives the stop.
- **`disk:report`.** Three new rows, read-only: `playwright_chromiumdev_profile-*`,
  `ork-artifact-preview-*` and `ork-test-tmp-*`, each with count, size, how
  many a live process names, and the oldest age. The profile row says its
  owner is unknown.
- **Tests added.** `apps/backend/src/core/design/browser-profiles.test.ts`
  (ledger rules, renderer record and release, service start-up),
  a real-Chromium case in `design/renderer.test.ts` (SIGKILL a renderer
  process, then the sweep removes exactly its profile; slow tier),
  `tests/unit/private-tmpdir.test.ts`, new cases in
  `tests/unit/temp-sweep.test.ts`, `tests/unit/disk-report.test.ts` and
  `transcript-artifacts/preview-isolation.test.ts`.

## Validation (2026-10-28, macOS)

- `mise run format:check`, `mise run lint`, `mise run typecheck` and
  `bun check -p e2e/tsconfig.json`: pass.
- `mise run test`, after the macOS root change: the root, bridges and codex
  lockfile groups pass. The workspace group fails on one test,
  `preview-terminal-roots.test.ts` ("the spawned local setup terminal is a
  managed root until it exits", a 20 s timeout). It times out the same way when
  run alone with `tests/isolate-tmpdir.ts` switched off, touches none of the
  changed files, and is not in the flaky registry; it is a failure on this
  host, not caused by this change. The whole run left no `ork-test-tmp-*`
  directory behind.
- The first `mise run test`, with the private directory inside the per-user
  temporary directory, failed `tunnel-supervisor.test.ts` (SH-03) and
  `codex-subagent-cards.test.ts` on the socket path limit; both pass after the
  change (decision 2).
- The slow-tier `design/renderer.test.ts`, with the new SIGKILL case, passes
  through `test:logged` with the other touched backend files.
- One `e2e/playwright.config.ts` spec on a private port: the worker's profile
  was made in `/private/tmp/ork-test-tmp-<pid>-*/` and the directory was gone
  after the runner exited.

## Assumptions and decisions

### 1. Task 1: stop chasing the burst

Chose the recommended option: no further search for the 2026-10-25 source.
The Arch host's evidence is gone and this worker runs on macOS. The
read-only evidence above names Playwright Test workers as the only live owners
here, which is enough to aim the containment (decision 2) at the Playwright
configs as well as the Bun preloads. Correlating with transcripts or terminal
history was not done, as the analysis advised.

### 2. Task 2, tests: a private `TMPDIR` per test process, set from the preload

Chose the recommended option, in the preload rather than the runner. The
analysis worried that Bun caches `os.tmpdir()`; Bun 1.4.4 reads `TMPDIR` on
every call (checked), so the preload is early enough, and it also covers a
bare `bun test <file>`, which `scripts/test-all.ts` would not.

Details chosen along the way:

- On macOS the private directory goes under `/private/tmp`, not inside the
  per-user temporary directory. The first full run put it inside, which is
  49 characters before the private part, and two tests failed on the 104-byte
  Unix socket limit (the SSH askpass broker in `tunnel-supervisor.test.ts`,
  and `codex-subagent-cards.test.ts`'s control socket). `/private/tmp` is
  canonical and shorter than the per-user directory, so every path gets
  shorter than before; the directory is still owner-only (`mkdtemp`). Other
  platforms keep the process's own temporary directory, so an operator's
  `TMPDIR` is still honoured there. The prefix is the short `ork-test-tmp-`
  for the same reason.
- `ORKESTRATOR_TEST_KEEP_PRIVATE_TMPDIR=1` keeps each directory, because
  removing it at the end hides exactly the leftovers a 0247-style leak hunt
  looks for.
- Under `--parallel` Bun evaluates the preload once per file in a worker, so
  each evaluation gets its own directory, and its `afterAll` restores `TMPDIR`
  before removing it. A process that inherited a private directory (a nested
  runner, or a Playwright worker) reuses it and owns nothing.
- Removal at the end is recursive (what a test left inside is ours), except
  when a live process names the directory, so a browser that outlived its test
  keeps its profile until the next sweep.
- The age floor is an hour, as for the other test prefixes, plus the in-use
  check the constraints ask for.
- Applied to the `test:browser` Playwright configs too, because that is where
  this host's profiles came from. Not applied to the real-stack
  `e2e/agent-testing` configs or the preview config, which start real
  backends and agents that this worker could not run; that is
  [0830](0830-playwright-temp-leaks-after-0248.md) task 1.

### 3. Task 2, backend: a profile ledger under the data directory, not a private `TMPDIR`

Deviated from the recommendation for the design renderer. The renderer calls
`chromium.launchServer()` inside the backend process, and Playwright makes the
profile with `mkdtemp(os.tmpdir())` of that process. A backend-owned `TMPDIR`
for those launches alone is not possible: `launchServer` has no option for it
and rejects `--user-data-dir`. Changing the whole backend's `TMPDIR` would move
every child's temporary files (agents, bridges, Git, sockets) into the data
directory, where macOS socket paths would pass 104 bytes. Running the browser
server in a helper process would undo the renderer's direct ownership of the
browser process (0037).

Instead the renderer records each profile it launches, with owner identities,
in `<data dir>/design-browser-profiles/`, and start-up removes only recorded
profiles. This keeps the property the recommendation wanted: only Orkestrator's
own profiles are ever removed, and a second backend on the same data
directory keeps its own (its PID and start identity are alive). The profile
stays on the temporary file system rather than moving to disk.

The sweep runs only at start-up, like the preview scratch sweep, so a profile
younger than the hour floor at a restart waits for the next start. Preview
scratch is not moved to the data directory: 0247 already names it for the
backend's PID and removes it at start-up, which is the same guarantee.

### 4. Task 2, backend: the age floor and the in-use check for recorded profiles

An hour on the profile directory's modification time, the same as the
preview scratch, and checked even though ownership is exact, because the
scope asks for both conditions. The command-line check runs only when a
record is otherwise removable; a process list that cannot be read keeps every
profile.

### 5. Task 3: report three prefixes

Chose the recommended rows for `playwright_chromiumdev_profile-*` and
`ork-artifact-preview-*`, and added `ork-test-tmp-*`, since that is where test
profiles now land. Each row shows how many a live process names, so the
report says what a sweep could consider without removing anything. The
profile row says its owner is unknown because other tools share the prefix.

### 6. Task 5: one sweep path per owner

Chose the recommended option. The tests' path is `tests/temp-sweep.ts`
(prefix, PID, age, in-use); the backend's is the design ledger plus the
existing preview scratch sweep, which now share `core/process-identity.ts`
inside the backend. The command-line scan is written twice (about 25 lines in
`tests/temp-sweep.ts` and in `core/process-identity.ts`) rather than shared
across the `tests/` and `apps/` boundary.

### 7. Task 6: count leftovers at stop

Chose the recommended option. The start-up sweep already logs how many
scratch directories it removed (0247), so the missing half was the stop: the
runner's `close()` now counts scratch that outlived it, with no paths or
content. Reading the production logs after a day of use is still open.

### 8. Task 4: what was qualified here

Only what this worker can run without the production backend: `mise run test`
on macOS, and the real-Chromium SIGKILL test, which kills a process running
the design renderer and checks that the next sweep removes exactly its
profile. The `dev:test` session with the design canvas and previews, a SIGKILL
of that profile's backend and a restart, still has to run on omarchy-hp.

### 9. A new todo for what is left

The real-stack Playwright configs and the design renderer's
`playwright-artifacts-*` directory (Playwright makes one per launch, beside
the profile, and it is not on Chromium's command line, so the ledger cannot
record it) are recorded in
[0830](0830-playwright-temp-leaks-after-0248.md) rather than here, to keep this
file's tasks closable.

## Related

- [0830-playwright-temp-leaks-after-0248.md](0830-playwright-temp-leaks-after-0248.md)
  (what this file leaves open).
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
  (`ork-artifact-preview-*` and the `TMPDIR` passthrough question).
- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md).
- [Process crashes and kills](../../debugging/process-crashes-and-kills.md)
  (a Playwright browser core dump is identified by this profile path).
- [Disk usage](../../development/disk-usage.md).

## Replaces

Nothing; new work found on 2026-10-26 while diagnosing a
`chrome-headless-shell` crash.
