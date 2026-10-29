# Git fsmonitor: live evidence, orphaned daemons and other hosts

Orkestrator no longer turns on git's fsmonitor daemon. It removes the setting
it wrote to older worktrees, stops a worktree's daemon before removing or
moving it, and retries timed-out status and diff reads without the daemon. The
design and the arktech-mini evidence are in
[git-scan-caches.md](../../architecture/git-scan-caches.md). This file holds
what that change (`cddc3e004`, #1386, first released in v2.34.2-beta) could
not prove or did not cover.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

Nothing in this file is done yet. No commit after #1386 touches
`git-fsmonitor.ts` or its callers.

### Tasks

1. **Daemons already orphaned**: decide between a one-off sweep and "a reboot is the answer". Status: open.
2. **User-level fsmonitor on Orkestrator's own reads (open question)**: whether to override a `core.fsmonitor` the user set in their own git config. Status: open.
3. **Fallback for other git calls**: which further worktree reads, if any, retry without the daemon after a timeout. Status: open (depends on 2).
4. **Qualification: Windows process cleanup**: the fingerprint probe's bounded `taskkill /t /f` branch. Status: open (needs a Windows host).
5. **Qualification: arktech-mini after upgrade**: old worktrees lose the setting, their daemons exit, git calls are fast again. Status: open (needs arktech-mini on v2.34.2-beta or later).
6. **Qualification: per-call latency on other hosts**: internal APFS, Linux and Windows, with and without fsmonitor. Status: open (Linux measured; APFS and Windows left).
7. **Qualification: recovery from a real hung daemon**: capture timings if one recurs. Status: open (opportunistic).

### 1. Daemons already orphaned

**Problem.** A daemon whose worktree or repository was deleted before #1386 is stopped by nothing. `git fsmonitor--daemon stop` needs a path that still resolves to the daemon's repository, and that path is gone. The daemons exit only on reboot.

**Context.** #1386 stops a daemon before every removal and move (`stopGitFsmonitorDaemon`, `apps/backend/src/core/git-fsmonitor.ts:35-44`; callers at `commands-environment.ts:2255` and `:2294`, `environment-cleanup.ts:280`, `environment-move.ts:384`), and no longer starts new ones, so the set of orphans can only shrink. arktech-mini had about 700 (git-scan-caches.md, "Why fsmonitor is off").

**Investigation.** The file assumed only macOS was affected. It is not: git 2.56.0 on this Linux host reports `feature: fsmonitor--daemon`, and a daemon starts, reports `is watching` and stops in a fresh repository. One orphan is running here now: PID 1252400, `git fsmonitor--daemon run --detach`, started 2026-10-26 09:26 UTC by a pre-#1386 backend in the CLI `setup-failure` scenario (`packages/cli/scenarios/cases.ts:397`). Its `GIT_DIR` points into `/tmp/ork-cli-setup-failure-Co3wpB/fixtures/setupfail/.git/worktrees/…`, and `fixtures/setupfail` no longer exists. The watched path is found differently per platform:
- macOS: `lsof` on the daemon's IPC socket, as the file said.
- Linux: `/proc/<pid>/environ` carries `GIT_DIR`. The socket in `/proc/net/unix` shows only the relative name `fsmonitor--daemon.ipc`, and `lsof` is not installed on this host.

Either way, a daemon is an orphan when its `GIT_DIR` (or socket directory) no longer exists. A daemon whose repository still exists may belong to the user and must not be touched.

**Decisions.**

- **Sweep or reboot?**
  - **Record that a reboot is the answer, and document a manual check in git-scan-caches.md (recommended).** Give the per-platform command that lists `git fsmonitor--daemon run` processes whose repository is gone, for a user who cannot reboot.
    - Pros: no new code that signals processes; the backlog cannot grow after #1386; one reboot clears it.
    - Cons: a host that never reboots keeps its orphans (one idle process and an inotify or FSEvents handle each).
  - **A one-off backend sweep at start-up.**
    - Pros: reclaims orphans without the user doing anything.
    - Cons: the backend would kill processes it did not start, by name; it needs a macOS and a Linux path finder; it runs on every start for a problem that ends with one reboot.
  - **A manual `mise` task that kills orphans after confirmation.**
    - Pros: explicit and reviewable.
    - Cons: development tooling, so it does not reach installed users, who are the ones with the backlog.

### 2. User-level fsmonitor on Orkestrator's own reads (open question)

**Problem.** A user who sets `core.fsmonitor=true` in `~/.gitconfig` gets a daemon in every environment worktree as soon as Orkestrator runs git there, with the same per-call cookie wait #1386 removed. Only a timeout makes Orkestrator skip the daemon today.

**Context.** `change-tracking/capture.ts` already passes `core.fsmonitor=false` on every call (`SAFE_GIT_CONFIG`, `apps/backend/src/core/change-tracking/capture.ts:176-183`, and the helper at `:358`). git-scan-caches.md says, as a design choice, that "a user who wants it can still set it in their own git config; the fallbacks below keep that safe".

**Investigation.** Neither host with evidence has a user-level setting: `git config --global core.fsmonitor` is unset here. The isolated test config sets it to `false` (`tests/isolate-git-config.ts:28`), so tests cannot see a user's value. Stop and migration calls already pass `GIT_FSMONITOR_DISABLED_ARGS` (`git-fsmonitor.ts:15`).

**Decisions.**

- **Override a user-level fsmonitor for Orkestrator's reads?**
  - **No; keep the timeout-only fallback (recommended).** It matches the recorded design, and nothing yet shows a user with a global setting.
    - Pros: respects the user's explicit git config; no change across about 150 git call sites.
    - Cons: such a user pays the cookie wait on every poll in every worktree, and the daemons start again (they are still stopped on removal and move).
  - **Yes, for application-owned worktrees only.** Pass `-c core.fsmonitor=false` on Orkestrator's read-only calls there; leave project homes alone.
    - Pros: Orkestrator's own worktrees never start a daemon, whatever the user's config.
    - Cons: needs a shared git runner or many call-site edits; overrides a setting the user chose.
  - **Yes, everywhere, as `capture.ts` does.**
    - Pros: simplest rule.
    - Cons: also overrides the user's own checkout, where the user may rely on the daemon.

### 3. Fallback for other git calls

**Problem.** Only the reads listed under "Current state" retry without the daemon. Any other git call in a worktree with a hung daemon waits for its own timeout and then fails.

**Context.** The backend has about 150 `"git"` invocations in 39 non-test files under `apps/backend/src`. Only calls that refresh the index or scan the working tree (`status`, and `diff` against the working tree) consult the daemon. `rev-parse`, `show` and commit-to-commit diffs do not.

**Investigation.** The working-tree `status` reads with no fallback are: `build-pipeline-code-rewind.ts:167` and `:195`, `build-pipeline-service-lifecycle.ts:1111`, `commands-projects.ts:229`, `nodes/node-files.ts:359` and `root-changes.ts:72` (30 s, the project home's change list). The covered reads are at `commands-files.ts:986-996`, `project-git-service.ts:437`, `commands-review.ts:950`, `review-validation-worker.ts:96-102` and `review-worktree-fingerprint.ts:189-197`.

**Decisions.**

- **Which further calls get the fallback?** (Moot if task 2 chooses an override.)
  - **The remaining working-tree `status` reads above, through `runGitWithFsmonitorFallback` (recommended).**
    - Pros: small and targeted; covers every call that actually waits on the daemon; uses the existing helper.
    - Cons: build-pipeline calls go through an environment runner, so they need `retryGitWithoutFsmonitorOnTimeout` with that runner instead.
  - **Every git call against a worktree.**
    - Pros: uniform.
    - Cons: most calls never consult the daemon; large churn for no gain.
  - **None; close the item.**
    - Pros: no change.
    - Cons: a hung user daemon still breaks code rewind, file listing and the root-changes picker.

### 4. Qualification: Windows process cleanup

**Problem.** The fingerprint probe's Windows branch, a bounded `taskkill /pid <pid> /t /f` (`review-worktree-fingerprint.ts:71-83`), has never run.

**Context.** On POSIX the probe owns a process group (`grouped = process.platform !== "win32"`, `review-worktree-fingerprint.ts:44`). The blocking-hook regression is skipped on Windows (`review-worktree-fingerprint.test.ts:203`). CI already has one Windows job, `claude-hook-only-windows` on `windows-latest` (`.github/workflows/ci.yml:109-129`).

**Investigation.** None beyond the code; this host is Linux.

**Decisions.**

- **What run counts as a pass, and where?**
  - **A Windows variant of the blocking-hook case, run on `windows-latest` in CI like `claude-hook-only-windows` (recommended).** It passes when the probe returns the fallback status within the timeout plus the 1 s `taskkill` bound, and no hook process survives.
    - Pros: repeatable; no Windows machine needed; guards against regressions.
    - Cons: the hook fixture needs a Windows form (no `#!` and no SIGTERM); adds CI minutes.
  - **One manual run on a Windows machine.**
    - Pros: no CI change.
    - Cons: one-off evidence; nobody here has a Windows host.

### 5. Qualification: arktech-mini after upgrade

**Problem.** Nothing yet shows the migration working on the host that motivated it.

**Context.** Migration runs from diff stats (`removeLegacyWorktreeFsmonitor`, `git-fsmonitor.ts:60-76`, called at `commands-files.ts:978`). It needs a backend on v2.34.2-beta or later (`git tag --contains cddc3e004`).

**Investigation.** None possible here; arktech-mini is macOS.

**Decisions.**

- **What counts as a pass?**
  - **On arktech-mini, count `git fsmonitor--daemon` processes and save each environment worktree's `config.worktree`, upgrade, wait for one diff-stats pass, then repeat and time `git status` in three worktrees (recommended).** Pass: no `core.fsmonitor=true` left in any application-owned worktree, the daemons for those worktrees are gone, and `git status` takes about 0.1 s.
    - Pros: tests exactly what the change claims, on the real data directory.
    - Cons: needs that host and the user's time.
  - **A synthetic macOS run with a fresh data directory.**
    - Pros: any Mac will do.
    - Cons: does not cover worktrees that older versions really wrote, or the external volume.

### 6. Qualification: per-call latency on other hosts

**Problem.** The 1.1 s penalty was measured on one host only (arktech-mini, external APFS and `/private/tmp`). Whether fsmonitor ever wins is unknown.

**Context.** If a large repository shows a real win, an opt-in setting could be revisited (see "Constraints and rationale").

**Investigation.** Linux, this host (git 2.56.0, btrfs, this repository's worktree, 6,903 tracked files, `core.untrackedCache=true`), 20 `git status --porcelain` calls each: 10–12 ms per call with `-c core.fsmonitor=false`, 8 ms with a running daemon. There is no cookie penalty on Linux, and no meaningful win at this size. Internal APFS and Windows are not measured.

**Decisions.**

- **What counts as done?**
  - **One measurement each on internal APFS and Windows, same method, recorded in git-scan-caches.md; revisit opt-in only if a host shows a win of over 100 ms per call (recommended).**
    - Pros: cheap; the threshold makes the revisit decision mechanical.
    - Cons: one repository size; a very large monorepo might still differ.
  - **Also measure a very large repository (over 100,000 files).**
    - Pros: tests the case fsmonitor exists for.
    - Cons: no such project is in use here; effort for a feature that is off.

### 7. Qualification: recovery from a real hung daemon

**Problem.** The timeout fallback has only been exercised with injected timeouts and a blocking hook, not a real hung daemon.

**Context.** Hangs were seen on arktech-mini before #1386. With fsmonitor no longer enabled by Orkestrator, a hang now needs a user-enabled daemon.

**Investigation.** None; no hang has been reported since #1386.

**Decisions.**

- **How to close it?**
  - **Opportunistic: if a hang recurs, record the read, the first timeout and the fallback duration in git-scan-caches.md; otherwise close it with the arktech-mini qualification (task 5) (recommended).**
    - Pros: no artificial setup; the unit tests already cover the mechanics with real git.
    - Cons: may never produce evidence.
  - **Force a hang (for example `SIGSTOP` on a daemon) and time the fallback.**
    - Pros: deterministic evidence.
    - Cons: a stopped daemon is not the same failure as a hung one; extra setup for little gain.

## Current state

- `enableGitScanCaches` (`apps/backend/src/core/commands-files.ts:1280`) writes
  only `core.untrackedCache=true`.
- `removeLegacyWorktreeFsmonitor` (`git-fsmonitor.ts:60`) unsets an
  application-owned linked worktree's `core.fsmonitor=true` and stops its
  daemon. Project homes, including linked user checkouts, are excluded.
  Successful attempts are cached per backend process; failures can retry on
  later diff-stats passes.
- The cleanup ledger's `worktree` step, `removeLocalWorktree`,
  `cleanupFailedLocalWorktree` and a move's quiesce step stop the daemon first.
- Diff stats, the project home's status, the review package status, the
  validation worker's drift check and the fingerprint probe retry once with
  `-c core.fsmonitor=false` after a timeout.
- The Node test preload sets `core.fsmonitor=false` in the isolated global
  config (`tests/isolate-git-config.ts:28`).
- The builtin daemon also exists on Linux: git 2.56.0 on omarchy-hp has it
  (2026-10-28), and one pre-#1386 orphan is running there (task 1).

### Automated coverage

- `git-fsmonitor.test.ts`: preload and scan-cache settings, worktree-only
  migration, preservation of main/shared/user config and a linked project home,
  daemon shutdown (a real builtin daemon on macOS and Windows; the cases assume
  Linux has none, `git-fsmonitor.test.ts:130`, `:160`, `:174` and `:308`, so
  "stops a running daemon" is skipped on Linux even where git now supports it),
  concurrent and once-per-process migration, retries after rev-parse/config
  read/unset failures, status/diff and project-home toolbar fallback wiring,
  non-timeout failures, cancellation and second-attempt failures. Host timeout
  paths inject a structured timeout; the Git repositories and fallback reads
  are real.
- `diff-stats-tracking.test.ts`: ownership wiring from tracked environments,
  including migration of an application worktree alongside a linked project home.
- `commands-local-worktree.test.ts`: daemon-stop ordering for removal and failed
  creation cleanup, missing paths, and best-effort stop failure handling.
- `environment-move.test.ts`: quiesce stops the daemon at the old path before
  the destination exists.
- `environment-cleanup.test.ts`: the cleanup ledger stops the daemon before
  removing its worktree, through an injected command runner.
- `commands-integration.test.ts`: newly created local environments enable the
  untracked cache without writing fsmonitor to worktree config.
- `commands-review.test.ts`: review-package status retries after a structured
  timeout and still records dirty paths.
- `review-validation-worker.test.ts`: real spawnSync timeout fallback under
  Node and Bun, retry arguments, drift capture by the worker after timeout,
  and non-timeout failure preservation.
- `review-worktree-fingerprint.test.ts`: Node/Bun captures, timeout reason
  suppression, persistent fsmonitor-disabled prefix, and termination of a
  blocking hook and its descendant before fallback completes. The hook ignores
  SIGTERM so the regression exercises escalation and pipe cleanup.

The cleanup-ledger and commands-integration suites have now executed from the
backend directory. The earlier root-level commands matched no files because
root `bunfig.toml` excludes backend discovery. For focused backend tests, use
`bun test --cwd apps/backend ./src/core/<file>.test.ts --parallel=1` through
`mise run test:logged`. On 2026-10-28 `git-fsmonitor.test.ts` passed on this
Linux host with one skip ("stops a running daemon").

## Outstanding work

### Code

- [ ] **Daemons already orphaned** (task 1). A daemon whose worktree was
  deleted before this change is stopped by nothing: there is no path left to
  send `stop` to. They exit on reboot. Decide whether a one-off sweep is worth
  it (the watched path is not on the daemon's command line; on macOS `lsof` on
  its IPC socket finds it, on Linux `/proc/<pid>/environ` gives `GIT_DIR`) or
  record that a reboot is the answer.
- [ ] **Other git calls have no fallback** (task 3). Only the reads listed
  above retry. Any other git call against a worktree whose user enabled
  fsmonitor still waits for its own timeout and then fails.

### Qualification

- [ ] **Windows process cleanup** (task 4). Qualify the fingerprint probe's
  bounded `taskkill /t /f` branch on Windows; blocking-hook process-group
  regressions currently run on POSIX hosts.
- [ ] **arktech-mini after upgrade** (task 5). With the new backend on the
  real data directory, confirm that existing environment worktrees lose
  `core.fsmonitor` from `config.worktree` after their first diff-stats pass,
  that their daemons exit, and that a git call in one is back to about 0.1 s.
  Count `git fsmonitor--daemon` processes before and after.
- [ ] **Other hosts** (task 6). Measure per-call git latency with and without
  fsmonitor on an internal APFS volume, Linux and Windows. If a large
  repository shows a real win, revisit an opt-in setting. Linux done on
  2026-10-28: 8 ms with the daemon, 10–12 ms without.
- [ ] **A real hung daemon** (task 7). The fallback has not been seen
  recovering from one. Capture timings if it recurs.

## Constraints and rationale

- Removed, not made opt-in: no existing per-project git-tuning setting fits,
  and an opt-in that is slow on the main host would be a trap.
- Migration requires established application ownership, excludes project homes,
  and touches only the linked worktree's own `config.worktree`, by
  explicit path, and only the exact value Orkestrator wrote (`true`).

## Open questions

- Whether a user-level fsmonitor (in `~/.gitconfig`) should also be overridden
  for Orkestrator's own reads, the way `change-tracking/capture.ts` already
  does. Today only timeouts trigger that. Task 2.

## Needs verification

- The 1.1 s penalty was measured on one host only. Task 6; on Linux there is
  no such penalty.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
  (the orphan in task 1 sits in a leaked `/tmp/ork-cli-setup-failure-*`
  directory)

## Replaces

Numbered 0734 on its branch until `main` took 0734 for the Codex MCP
handshake todo; renamed before merge.
