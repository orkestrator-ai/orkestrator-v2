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
[Assumptions and decisions](#assumptions-and-decisions). Rechecked 2026-11-06
against `main` at `c1724ab74` on arktech-mini, which runs v2.36.5-beta: tasks
5 and 7 are done and task 6 has its internal APFS figures; only Windows work
(tasks 4 and 6) is left.

### Tasks

1. **Daemons already orphaned**: decide between a one-off sweep and "a reboot is the answer". Status: done (a reboot is the answer; a manual per-platform check is in git-scan-caches.md, "Daemons left by older versions").
2. **User-level fsmonitor on Orkestrator's own reads (open question)**: whether to override a `core.fsmonitor` the user set in their own git config. Status: done (decided: no override; the timeout fallback stays the only bypass).
3. **Fallback for other git calls**: which further worktree reads, if any, retry without the daemon after a timeout. Status: done (every remaining working-tree `status` read, including the new graph ones, plus checkout confirmation fingerprint reads).
4. **Qualification: Windows process cleanup**: the fingerprint probe's bounded `taskkill /t /f` branch. Status: open (needs a Windows host or CI iteration; see the 2026-10-30 note under task 4).
5. **Qualification: arktech-mini after upgrade**: old worktrees lose the setting, their daemons exit, git calls are fast again. Status: done (2026-11-06 on v2.36.5-beta: no `core.fsmonitor=true` in any of 16 environment worktrees, no daemon running, `git status` 19 ms).
7. **Qualification: recovery from a real hung daemon**: capture timings if one recurs. Status: done (closed with task 5, as its decision says: no hang recurred).

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

**Investigation.** None possible on the Linux host. 2026-11-06 on arktech-mini
(Apple M5 Pro, macOS 27.2, Git 2.56.0, `/Applications/OrkestratorV2.app` at
2.36.5-beta, backend up since 03:24 that day, host up 14.5 h), read-only:

- **Settings.** No `core.fsmonitor=true` in the `config.worktree` of any of the
  16 environment worktrees (12 under `~/orkestrator-v2/workspaces` on the
  internal disk, 4 under `/Volumes/Lexar/workspaces` on the external USB APFS
  volume), nor in any of the 13 `config.worktree` files under this
  repository's `.git/worktrees`. Every one keeps `core.untrackedCache=true`.
  Neither `~/.gitconfig` nor this repository's shared config sets
  `core.fsmonitor`.
- **A worktree older versions wrote.** `clarity-sound-studio-20261015-…` on the
  external volume was created on 2026-10-15. Its `config.worktree` was last
  written on 2026-10-28 at 17:04 GMT, after `v2.34.2-beta` was tagged (16:26),
  and has no fsmonitor key: what the migration's unset leaves. Two others
  created on 2026-10-18 and 2026-10-24 carry `core.fsmonitor = false`, written
  at 10:38 that day, before `cddc3e004` was committed (14:14); the migration
  touches only `true`, so it left them alone, as designed.
- **Daemons.** No `git fsmonitor--daemon` process was running before this work
  or after it. The pre-upgrade count cannot be taken any more: the host has
  rebooted since the 700 were counted, and a reboot clears them (task 1).
- **Latency.** `git status --porcelain` in this environment worktree (internal
  disk, 9,394 tracked files, `GIT_OPTIONAL_LOCKS=0`, 20 calls): p50 19 ms, p90
  29 ms, against about 1.1 s before #1386. The other worktrees were not timed,
  because the run was limited to this worktree and throwaway repositories.

**Decisions.**

- **What counts as a pass?**
  - **On arktech-mini, count `git fsmonitor--daemon` processes and save each environment worktree's `config.worktree`, upgrade, wait for one diff-stats pass, then repeat and time `git status` in three worktrees (recommended).** Pass: no `core.fsmonitor=true` left in any application-owned worktree, the daemons for those worktrees are gone, and `git status` takes about 0.1 s.
    - Pros: tests exactly what the change claims, on the real data directory.
    - Cons: needs that host and the user's time.
  - **A synthetic macOS run with a fresh data directory.**
    - Pros: any Mac will do.
    - Cons: does not cover worktrees that older versions really wrote, or the external volume.

### 7. Qualification: recovery from a real hung daemon

**Problem.** The timeout fallback has only been exercised with injected timeouts and a blocking hook, not a real hung daemon.

**Context.** Hangs were seen on arktech-mini before #1386. With fsmonitor no longer enabled by Orkestrator, a hang now needs a user-enabled daemon.

**Investigation.** None; no hang has been reported since #1386. 2026-11-06:
none on arktech-mini either, where no daemon was running at all (task 5).

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
- On macOS (arktech-mini, Git 2.56.0, internal disk, 2026-11-06) a daemon
  exits by itself within 4 s when its worktree is removed, deleted or moved, or
  its `.git` is deleted. The macOS orphan check in git-scan-caches.md now reads
  the daemon's first open directory, because `lsof` shows only the socket's
  relative name there too.

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
On 2026-11-06 it passed on arktech-mini (macOS) with 25 tests and no skip, and
no daemon was left afterwards.

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
- [x] **arktech-mini after upgrade** (task 5). Done 2026-11-06 on
  v2.36.5-beta: no `core.fsmonitor=true` left, no daemons, `git status` 19 ms.
- [x] **A real hung daemon** (task 7). Closed with task 5: no hang recurred.
  If one does, record the read, the first timeout and the fallback duration in
  git-scan-caches.md.

## Constraints and rationale

- Removed, not made opt-in: no existing per-project git-tuning setting fits,
  and an opt-in that is slow on the main host would be a trap.
- Migration requires established application ownership, excludes project homes,
  and touches only the linked worktree's own `config.worktree`, by
  explicit path, and only the exact value Orkestrator wrote (`true`).

## Needs verification

- The 1.1 s penalty was seen only on arktech-mini's external USB APFS volume
  and in `/private/tmp`, with about 700 daemons running. Linux and the same
  host's internal disk (`$TMPDIR`, 103 daemons) show none. Whether the external
  volume or `/private/tmp` still does is not known; retest it there with the
  method in git-scan-caches.md only if fsmonitor is reconsidered.

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
the daemon (`rev-parse`, `show`, `log`, commit-to-commit diffs and
index-only `diff --cached`), bounded inspection helpers (`hash-object`,
`clean -n` and `submodule status`),
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

### Tasks 5–7: left open on 2026-10-30

They needed arktech-mini, an internal APFS volume, Windows, or a real hung
daemon. The Linux host could not produce that evidence. Tasks 5–7 were taken
up on 2026-11-06; see below.

### Task 5: passed from read-only evidence (2026-11-06)

Added 2026-11-06 by the worker that acted on tasks 5 and 6, on `main` at
`c1724ab74`, on arktech-mini.

Took the recommended pass criterion, in the form the constraints allowed. The
ticket forbade running against the real data directory or other checkouts, and
the host had already been upgraded and rebooted, so there was no "before" to
capture and no upgrade to perform. What was checked instead, read-only: every
environment worktree's `config.worktree` (by explicit path, with `git config
-f`), the daemon count, and `git status` in this worktree. All three pass. The
one pre-fix worktree that still exists shows the migration's result, and the
two with a hand-written `false` show that it leaves other values alone. Only
one worktree was timed rather than three, because the others belong to other
environments.

### Task 6: internal APFS measured; Windows still open (2026-11-06)

Took the recommended method (20 calls each form, recorded in
git-scan-caches.md) on throwaway repositories under `$TMPDIR`, and added a
100,000-file repository (the alternative option) because a synthetic one costs
seconds to generate. The daemon is faster on the internal disk, but by at most
about 50 ms per call, under the 100 ms threshold, so fsmonitor stays off and
no opt-in setting is proposed. The figures also show that the 1.1 s wait was
not an APFS property: git-scan-caches.md no longer says it was. The external
volume and `/private/tmp` were not retested, because the ticket limited
throwaway repositories to `$TMPDIR` and this worktree; that is recorded under
Needs verification rather than as a new to-do, since it matters only if
fsmonitor is reconsidered. Task 6 stays open for Windows, with task 4: neither
can be done on this host, and splitting them into a new file would only move
the same two Windows items.

### Task 7: closed with task 5 (2026-11-06)

Took the recommended option: no hang recurred, and the arktech-mini
qualification is done, so the task is closed. The unit tests already exercise
the fallback with real Git.

### Task 1 follow-up: the macOS orphan check was wrong (2026-11-06)

git-scan-caches.md's macOS form (`lsof -a -U -p <pid>` naming
`<git-dir>/fsmonitor--daemon.ipc`) had never been run on a Mac. On
arktech-mini `lsof` shows only the relative name `fsmonitor--daemon.ipc`, the
daemon's working directory is the home directory, and its environment has no
`GIT_DIR`. The daemon does hold its worktree open as its first directory
descriptor (then each parent, for FSEvents), so the doc now reads that; the
command was run against 101 throwaway daemons. On the same disk every daemon
exited by itself when its worktree was removed, deleted, moved, or deleted
straight after starting, so the doc no longer says a daemon outlives its
worktree in general. This is documentation only: no code reads these paths, so
there was no code defect to fix with a test.

### Measurement hygiene (2026-11-06)

Every repository was created under a `mktemp -d` directory in `$TMPDIR`,
and git config was set only in those repositories. Each daemon the run started
was stopped with `git -c core.fsmonitor=false -C <repo> fsmonitor--daemon
stop`, a process listing then showed none, and the directory was removed by its
exact path.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
- `0247-test-temp-dir-leaks-from-full-sweep.md` (deleted 2026-11-06)
  (the orphan in task 1 sits in a leaked `/tmp/ork-cli-setup-failure-*`
  directory)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 6, the Windows latency measurement) moved there on 2026-11-10.

## Replaces

Numbered 0734 on its branch until `main` took 0734 for the Codex MCP
handshake todo; renamed before merge.
