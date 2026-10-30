# Git fsmonitor: live evidence, orphaned daemons and other hosts

Orkestrator no longer turns on git's fsmonitor daemon. It removes the setting
it wrote to older worktrees, stops a worktree's daemon before removing or
moving it, and retries timed-out status and diff reads without the daemon. The
design and the arktech-mini evidence are in
[git-scan-caches.md](../../architecture/git-scan-caches.md). This file holds
what that change (`cddc3e004`, #1386, first released in v2.34.2-beta) could
not prove or did not cover.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`. Rechecked 2026-10-30
against `main` at `cd7bbe3e5`. No commit between the two touched
`git-fsmonitor.ts`, so none of the tasks had already been done on `main`. The
graphs merge (`3fa7d1733`, #1436) moved the code-rewind `status` reads into
`workspace-code-rewind.ts` and added two new ones (task 3). Tasks 1–3 were
done on the 0735 follow-up branch; see
[Assumptions and decisions](#assumptions-and-decisions).

### Tasks

1. **Daemons already orphaned**: decide between a one-off sweep and "a reboot is the answer". Status: done (a reboot is the answer; a manual per-platform check is in git-scan-caches.md, "Daemons left by older versions").
2. **User-level fsmonitor on Orkestrator's own reads (open question)**: whether to override a `core.fsmonitor` the user set in their own git config. Status: done (decided: no override; the timeout fallback stays the only bypass).
3. **Fallback for other git calls**: which further worktree reads, if any, retry without the daemon after a timeout. Status: done (every remaining working-tree `status` read, including the new graph ones, plus checkout confirmation fingerprint reads).
4. **Qualification: Windows process cleanup**: the fingerprint probe's bounded `taskkill /t /f` branch. Status: open (needs a Windows host or CI iteration; see the 2026-10-30 note under task 4).
5. **Qualification: arktech-mini after upgrade**: old worktrees lose the setting, their daemons exit, git calls are fast again. Status: open (needs arktech-mini on v2.34.2-beta or later).
6. **Qualification: per-call latency on other hosts**: internal APFS, Linux and Windows, with and without fsmonitor. Status: open (Linux measured; APFS and Windows left).
7. **Qualification: recovery from a real hung daemon**: capture timings if one recurs. Status: open (opportunistic).

### 1. Daemons already orphaned

**Problem.** A daemon whose worktree or repository was deleted before #1386 is stopped by nothing. `git fsmonitor--daemon stop` needs a path that still resolves to the daemon's repository, and that path is gone. The daemons exit only on reboot.

**Context.** #1386 stops a daemon before every removal and move (`stopGitFsmonitorDaemon`, `apps/backend/src/core/git-fsmonitor.ts:35-44`; callers at `commands-environment.ts:2260` and `:2299`, `environment-cleanup.ts:280`, `environment-move.ts:384`), and no longer starts new ones, so the set of orphans can only shrink. arktech-mini had about 700 (git-scan-caches.md, "Why fsmonitor is off").

**Investigation.** The file assumed only macOS was affected. It is not: git 2.56.0 on this Linux host reports `feature: fsmonitor--daemon`, and a daemon starts, reports `is watching` and stops in a fresh repository. One orphan is running here now: PID 1252400, `git fsmonitor--daemon run --detach`, started 2026-10-26 09:26 UTC by a pre-#1386 backend in the CLI `setup-failure` scenario (`packages/cli/scenarios/cases.ts:397`). Its `GIT_DIR` points into `/tmp/ork-cli-setup-failure-Co3wpB/fixtures/setupfail/.git/worktrees/…`. (Corrected 2026-10-30: that path, the repository and the worktree at `/tmp/ork-cli-setup-failure-Co3wpB/worktrees/origin-setup-fails-2d2a26de53f1` all still exist, and `git fsmonitor--daemon status` there reports `is watching`. The daemon is kept alive by a leaked test directory, not by a deleted path; a `stop` in that worktree would end it.) The watched path is found differently per platform:
- macOS: `lsof` on the daemon's IPC socket, as the file said.
- Linux: `/proc/<pid>/environ` carries `GIT_DIR`. The socket in `/proc/net/unix` shows only the relative name `fsmonitor--daemon.ipc`, and `lsof` is not installed on this host. The daemon's working directory is the user's home, not the worktree, so `/proc/<pid>/cwd` does not help either.

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

**Investigation.** The working-tree `status` reads with no fallback are: `build-pipeline-code-rewind.ts:167` and `:195`, `build-pipeline-service-lifecycle.ts:1111`, `commands-projects.ts:229`, `nodes/node-files.ts:359` and `root-changes.ts:72` (30 s, the project home's change list). Rechecked 2026-10-30: the graphs merge moved the code-rewind reads into `workspace-code-rewind.ts` (three reads) and added `graph-agent-guards.ts` (a branch worktree's dirty check) and `graph-system-select.ts` (before moving the run's branch). `reconcileContainerDelegationBase` (`commands-environment.ts`) also reads a container worktree's status with no fallback. `nodes/node-files.ts` also runs two `diff HEAD` reads, which scan the working tree. The covered reads are at `commands-files.ts:986-996`, `project-git-service.ts:437`, `commands-review.ts:950`, `review-validation-worker.ts:96-102` and `review-worktree-fingerprint.ts:189-197`.

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

**Investigation.** None beyond the code; this host is Linux. 2026-10-30: the blocking-hook case cannot simply be un-skipped. It intercepts Git with a POSIX `sh` script named `git` placed first on `PATH`, joins `PATH` with `:`, and finds Git with `which`; Node's `spawn("git")` on Windows resolves only `git.exe`/`.cmd`, so the probe would bypass the wrapper. A Windows variant needs another way to observe the calls (for example `GIT_TRACE` to a file) and a liveness check for the hook PIDs that works there (`process.kill(pid, 0)` does). The CI job also needs the backend test preload to work on Windows, which no job exercises today.

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
  `-c core.fsmonitor=false` after a timeout. Since the 0735 follow-up branch
  (2026-10-30), so do the project home's change list, the coordinator's
  environment details, the code-rewind, graph-agent and graph-select
  cleanliness checks, the scratch-repository resume check and the delegated
  container's cleanliness check. A cancelled read is not retried
  (`retryGitWithoutFsmonitorOnTimeout` takes the caller's `AbortSignal`).
- A user's own `core.fsmonitor` is not overridden (task 2).
- The Node test preload sets `core.fsmonitor=false` in the isolated global
  config (`tests/isolate-git-config.ts:28`).
- The builtin daemon also exists on Linux: git 2.56.0 on omarchy-hp has it
  (2026-10-28), and one pre-#1386 daemon is still running there, PID 1252400,
  watching a leaked CLI scenario worktree (task 1). It was left running on
  2026-10-30: it was not started by this work.

### Automated coverage

- `git-fsmonitor.test.ts`: preload and scan-cache settings, worktree-only
  migration, preservation of main/shared/user config and a linked project home,
  daemon shutdown (a real builtin daemon wherever `git version
  --build-options` reports `feature: fsmonitor--daemon`, Linux included),
  concurrent and once-per-process migration, retries after rev-parse/config
  read/unset failures, status/diff and project-home toolbar fallback wiring,
  non-timeout failures, cancellation (also through the helper's `signal`) and
  second-attempt failures, and the fallback wiring of `readWorktreeStatus`,
  `listRootChanges`, `isResumableScratchRepository` and
  `reconcileContainerDelegationBase`. Host timeout paths inject a structured
  timeout; the Git repositories and fallback reads are real.
- `graph-system-select.test.ts`: clean, dirty, failed and cancelled fallback
  status reads before either merge or reset; cancellation starts no fallback.
- `graph-branch-worktrees.test.ts`: isolated worktree refusal and certification
  after clean, dirty or failed retries, preserving the worktree path and flags.
- `nodes/node-files.test.ts`: each parallel status/diff read recovers independently,
  retains its output limit, or rejects the request after an exhausted retry.
- `commands-registry-project-home.test.ts`: all four checkout confirmation
  fingerprint reads recover after a timeout and preserve valid confirmation.
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
Linux host with one skip ("stops a running daemon"). On 2026-10-30 it passed
there with 23 tests and no skip, and no daemon started by the run survived it.

## Outstanding work

### Code

- [x] **Daemons already orphaned** (task 1). A reboot is the answer; the
  manual check is in git-scan-caches.md.
- [x] **Other git calls have no fallback** (task 3). Every remaining
  working-tree `status` read now retries.

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

## Needs verification

- The 1.1 s penalty was measured on one host only. Task 6; on Linux there is
  no such penalty.

## Assumptions and decisions

Added 2026-10-30 by the worker that acted on tasks 1–3, on `main` at
`cd7bbe3e5`.

### Task 1: a reboot is the answer, with a manual check

Took the recommended option. git-scan-caches.md now has "Daemons left by
older versions" with a read-only Linux command (tested on omarchy-hp; it lists
PID 1252400 as `present`) and the macOS `lsof` form (not run on a Mac, and the
doc says so). No code signals processes it did not start. The command reports
whether the repository still exists rather than only listing ones that are
gone, because the one daemon on this host turned out to watch a worktree that
still exists in a leaked test directory: a "gone only" filter would have hidden
it. PID 1252400 was reported and not stopped.

### Task 2: no override of a user's own fsmonitor

Took the recommended option, as the delegation asked: Orkestrator leaves a
`core.fsmonitor` in `~/.gitconfig` alone and relies on the timeout fallback.
The code still matches the recorded design (`capture.ts` is the only reader
that disables it unconditionally), and neither host with evidence has a global
setting. git-scan-caches.md now says so explicitly. The open question is
closed.

### Task 3: the fallback for every remaining working-tree status read

Took the recommended option. The list was rechecked against current `main`
because the graphs merge had moved and added reads, so it covers:
`readWorktreeStatus` (new in `workspace-code-rewind.ts`, used by its three
reads and by `build-pipeline-service-lifecycle.ts`), `graph-agent-guards.ts`,
`graph-system-select.ts`, `root-changes.ts` `listRootChanges`,
`nodes/node-files.ts` (status and both `diff HEAD` reads),
`project-git-service.ts` `inspectCheckout` (the index tree snapshot, working-tree
`diff-index`, unstaged `diff` and untracked `ls-files` reads),
`commands-projects.ts` `isResumableScratchRepository` and
`commands-environment.ts` `reconcileContainerDelegationBase`. The environment
runners throw the same `CommandFailedError` with `timedOut` as host
`runCommand`, so `retryGitWithoutFsmonitorOnTimeout` wraps them directly, as
`commands-review.ts` already did; no separate runner-specific helper was
needed.

`retryGitWithoutFsmonitorOnTimeout` now takes an optional `AbortSignal` and
does not retry once it has fired. `runCommand` reports a cancelled call as
timed out, and `graph-system-select.ts` passes a run signal, so without this a
cancelled graph action would have run a second `status`.
`runGitWithFsmonitorFallback` uses the same check instead of its own.

Left out on purpose: writes (`reset --hard`, `add`), reads that never consult
the daemon (`rev-parse`, `show`, `log`, commit-to-commit diffs,
index-only `diff --cached`, `hash-object`, `clean -n` and `submodule status`),
`buildRootChangesPatch` (a path-limited diff against a scratch index on an
explicit user action, already bounded at 120 s) and the
`git submodule foreach` status string inside `project-git-service.ts`, which
runs in a shell and would need its own `-c` inside the script. The remaining
backend diff/ls-files audit deliberately excludes `findLocalRenamePair`
(explicit rename lookup, 60 s), project-copy `gitPaths` (explicit file
inventory, 30 s), and the fingerprint probe's streaming diff (its own
process/capture bounds; inherits disabled fsmonitor after a status timeout).
Change-tracking capture and scope reads already disable fsmonitor through
`SAFE_GIT_CONFIG` or their embedded equivalent.

### Daemon tests on Linux (Automated coverage)

`git-fsmonitor.test.ts` now decides whether the builtin daemon exists from
`git version --build-options` (`feature: fsmonitor--daemon`) instead of
`process.platform !== "linux"`. It is a build feature, and git 2.56.0 on Linux
has it. The four cases that assumed otherwise now start, check and stop a
real daemon on Linux. Each case stops the daemon it started in `finally`, and
a process listing after the run showed only PID 1252400.

### Task 4: not attempted on this branch

The recommended option (a Windows CI variant of the blocking-hook case) still
stands, but it cannot be developed or proved from a Linux host, and a CI job
pushed without a Windows run would only show up red on the pull request. The
investigation note under task 4 records what a Windows variant has to change.

### Tasks 5–7: left open

They need arktech-mini, an internal APFS volume, Windows, or a real hung
daemon. Nothing here could produce that evidence.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
  (the orphan in task 1 sits in a leaked `/tmp/ork-cli-setup-failure-*`
  directory)

## Replaces

Numbered 0734 on its branch until `main` took 0734 for the Codex MCP
handshake todo; renamed before merge.
