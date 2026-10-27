# Leftover Playwright browser profile directories

Checked against `main` at `7809191f` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Find the 2026-10-25 burst**: identify what made 259 profiles between 12:40 and 12:42. Status: open.
2. **Sweep stale profiles automatically**: remove profiles past an age floor that no live process uses, both in tests and in the backend. Status: open.
3. **Report profiles in `disk:report`**: show their count, size and age. Status: open.
4. **Qualification run**: `mise run test` plus design and preview use, a backend SIGKILL and a restart, then `/tmp` holds nothing stale. Status: open (after 2).
5. **Where the sweep lives (open question)**: a shared helper, or a private `TMPDIR` for the backend's launches. Status: open.
6. **Origin of the `ork-artifact-preview-*` directories (Needs verification)**: real previews or tests. Status: open, with new evidence.

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

- Should the sweep live in one shared helper used by both the test runner and
  the backend, or should the backend only sweep inside its own data directory
  by giving its Playwright launches a private `TMPDIR`?

## Needs verification

- Whether the 85 `ork-artifact-preview-*` directories from 2026-10-26 came from
  real previews in the running app or from preview tests. This is the open
  question in [0247](0247-test-temp-dir-leaks-from-full-sweep.md)'s Needs
  verification, and it decides whether production leaks preview scratch
  directories. Their profiles go when their scratch directory goes, so they
  need no separate sweep.

## Related

- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
  (`ork-artifact-preview-*` and the `TMPDIR` passthrough question).
- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md).
- [Process crashes and kills](../../debugging/process-crashes-and-kills.md)
  (a Playwright browser core dump is identified by this profile path).
- [Disk usage](../../development/disk-usage.md).

## Replaces

Nothing; new work found on 2026-10-26 while diagnosing a
`chrome-headless-shell` crash.
