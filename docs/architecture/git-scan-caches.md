# Git scan caches and fsmonitor

Status: Living.

How Orkestrator speeds up the `git status` and diff reads it makes against
environment worktrees, and why it does not use git's fsmonitor daemon. Paths
are relative to `apps/backend/src/core/`.

| File | Purpose |
| --- | --- |
| `commands-files.ts` | `enableGitScanCaches` (new worktrees), `getLocalGitStatusDetailed` (diff stats) |
| `git-fsmonitor.ts` | Daemon stop, removal of the legacy setting, timeout fallback |
| `review-validation-worker.ts`, `review-worktree-fingerprint.ts` | Environment-side status reads with their own fallback |

## What is enabled

A new local environment worktree gets `core.untrackedCache=true` in its own
`config.worktree` (with `extensions.worktreeConfig`, the only shared write).
Container workspaces get it in their throwaway clone's config
(`docker/workspace-setup.sh`). Nothing else is turned on.

## Why fsmonitor is off

Until 2026-10-28 `enableGitScanCaches` also wrote `core.fsmonitor=true`. On
arktech-mini (macOS, worktrees on an external APFS volume and in
`/private/tmp`) that cost:

- **Every call:** about 1.1 s of cookie wait per git call in each of 13
  worktrees, against 0.05–0.18 s with `-c core.fsmonitor=false`. Diff stats,
  validation and review all run many git calls per pass.
- **Hangs:** some daemons stopped answering, so `git status` blocked for good.
  Multi Review then failed with "Git status could not be read" and "Review
  validation has not completed", and `launch_multi_review` timed out.
- **Leaks:** a daemon outlives its worktree. Nothing stopped them, and about
  700 had piled up; test fixtures leaked one per temporary repository.

The win fsmonitor offers (skipping the tree walk on very large trees) did not
show up at these worktree sizes, and the untracked cache keeps most of the walk
cheap. So it was removed rather than made opt-in: there was no existing
per-project git-tuning setting to hang it on, and an opt-in that is slow on the
main host would be a trap. A user who wants it can still set it in their own
git config; the fallbacks below keep that safe. Orkestrator does not override
a `core.fsmonitor` the user set (for example in `~/.gitconfig`) on its own
reads; only `change-tracking/capture.ts` and the stop and migration calls pass
`-c core.fsmonitor=false` unconditionally.

The daemon is not macOS-only. Git 2.56.0 on Linux reports
`feature: fsmonitor--daemon` in `git version --build-options`, and a daemon
starts, watches and stops there. On that Linux host it costs nothing per call
(about 8 ms with a daemon, 10–12 ms without, in a 6,903-file worktree), so the
cookie wait above is an APFS cost, not a cost of the daemon itself.

## Worktrees created by older versions

`removeLegacyWorktreeFsmonitor` runs from `getLocalGitStatusDetailed`, which
diff stats call with explicit ownership established from non-project-home local
environments. Successful migrations are cached per backend process; concurrent
scans share an attempt and transient Git/config failures are retried next time. It reads only the linked worktree's own `config.worktree`, by explicit
path (`git config --worktree` falls back to the shared config when
per-worktree config is off). If that file says `core.fsmonitor=true`, the key is
unset and the daemon is stopped. Project homes, including linked user checkouts,
and paths without established application ownership are skipped. Main checkouts
and any other config value are left alone.

## Stopping daemons

`stopGitFsmonitorDaemon` runs `git -c core.fsmonitor=false -C <worktree>
fsmonitor--daemon stop` with a 5 s timeout, best effort. Git exits at once when
no daemon runs, and the `-c` keeps the call from starting one. It runs before
a worktree is removed in the cleanup ledger's `worktree` step, in
`removeLocalWorktree` and `cleanupFailedLocalWorktree`, and when a move quiesces
an environment (the daemon would keep watching the old folder).

### Daemons left by older versions

A daemon whose worktree was deleted before v2.34.2-beta has no path left to
send `stop` to. Orkestrator does not hunt for these: it would have to signal
processes it did not start, and the set can only shrink now that nothing
starts new ones. A reboot clears them.

To find them without rebooting, list each `git fsmonitor--daemon run` process
with the repository it serves. A daemon whose repository still exists may be
the user's own; stop it with `git -C <worktree> fsmonitor--daemon stop` only
if it is yours. A daemon whose repository is gone can only be killed, after
checking the PID's start time and command line.

On Linux, the daemon's environment carries `GIT_DIR` (its working directory is
not the worktree, and `/proc/net/unix` shows only the socket's relative name):

```sh
ps -eo pid=,lstart=,args= |
  awk '$7 ~ /(^|\/)git$/ && $8 == "fsmonitor--daemon" && $9 == "run" {print $1}' |
  while read -r pid; do
    dir=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^GIT_DIR=//p')
    if [ -e "$dir" ]; then state=present; else state=gone; fi
    echo "$pid $state $dir"
  done
```

On macOS, the daemon's IPC socket names the repository: `lsof -a -U -p <pid>`
lists `<git-dir>/fsmonitor--daemon.ipc` (or a socket under `~/.git-fsmonitor-*`
for a repository on a network volume). This command has not been run on a Mac
for this document.

## Bounded reads

These reads already had timeouts; on a timeout each now retries once with
`-c core.fsmonitor=false` instead of failing:

- diff stats (`getLocalGitStatusDetailed`: name-status, numstat, status; 60 s);
- the project home's status (`project-git-service.ts`, 10 s);
- the review package's worktree status (`commands-review.ts`, 30 s);
- the validation worker's drift check (10 s, `spawnSync` `ETIMEDOUT`);
- the worktree fingerprint probe's status read (10 s inside the probe; once it
  has fallen back, the rest of the probe skips the daemon too). The probe owns
  each Git process group, gives timed-out Git 250 ms to remove its index lock,
  then kills descendants, closes captured streams and reaps Git before retrying.
  Windows uses a bounded `taskkill /t /f` helper for descendant cleanup;
- the project home's change list (`root-changes.ts`, 30 s);
- the coordinator's environment details (`nodes/node-files.ts`: status and the
  two diffs against `HEAD`, 20 s each);
- the cleanliness checks before a code rewind, through the environment's Git
  port (`workspace-code-rewind.ts` `readWorktreeStatus`, also used by
  `build-pipeline-service-lifecycle.ts`), a graph agent's branch worktree
  (`graph-agent-guards.ts`) and a graph select's branch move
  (`graph-system-select.ts`);
- the scratch-repository resume check (`commands-projects.ts`, 10 s);
- the delegated container's cleanliness check (`commands-environment.ts`,
  `reconcileContainerDelegationBase`, 30 s).

Only reads that scan the working tree consult the daemon: `status` and `diff`
against the working tree. `rev-parse`, `show`, `log` and commit-to-commit
diffs never wait on it, so they have no fallback. A cancelled read is not
retried: `runCommand` reports cancellation as a timeout, so callers pass their
`AbortSignal` to `retryGitWithoutFsmonitorOnTimeout`. Other failures are not
retried. Writes (`reset --hard`, `add`) are never retried, and the root-changes
patch build (`buildRootChangesPatch`), which diffs against a scratch index on
an explicit user action with a 120 s bound, was left as it is.

## Tests

`tests/isolate-git-config.ts` writes `core.fsmonitor=false` into the isolated
global config every Node test process uses, so no fixture repository starts a
daemon. A test that needs one sets it in its own repository and stops it.
`git-fsmonitor.test.ts` guards the preload, `enableGitScanCaches`, the
migration's scoping, the daemon stop and the fallback wiring. Its real-daemon
cases run wherever `git version --build-options` reports
`feature: fsmonitor--daemon`, Linux included, and stop every daemon they start.

Remaining work: [0735-git-fsmonitor-follow-ups.md](../todo/containers-and-environments/0735-git-fsmonitor-follow-ups.md).
