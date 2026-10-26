# Leftover Playwright browser profile directories

Checked against `main` at `7809191f` (2026-10-26).

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
