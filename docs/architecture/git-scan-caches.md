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
git config; the fallbacks below keep that safe.

## Worktrees created by older versions

`removeLegacyWorktreeFsmonitor` runs from `getLocalGitStatusDetailed`, which
diff stats call for every local environment, once per worktree per backend
process. It reads only the linked worktree's own `config.worktree`, by explicit
path (`git config --worktree` falls back to the shared config when
per-worktree config is off). If that file says `core.fsmonitor=true`, the key is
unset and the daemon is stopped. A main checkout (a project home) is skipped
because Orkestrator never wrote its config, and any other value is left alone.

## Stopping daemons

`stopGitFsmonitorDaemon` runs `git -c core.fsmonitor=false -C <worktree>
fsmonitor--daemon stop` with a 5 s timeout, best effort. Git exits at once when
no daemon runs, and the `-c` keeps the call from starting one. It runs before
a worktree is removed in the cleanup ledger's `worktree` step, in
`removeLocalWorktree` and `cleanupFailedLocalWorktree`, and when a move quiesces
an environment (the daemon would keep watching the old folder).

## Bounded reads

These reads already had timeouts; on a timeout each now retries once with
`-c core.fsmonitor=false` instead of failing:

- diff stats (`getLocalGitStatusDetailed`: name-status, numstat, status; 60 s);
- the project home's status (`project-git-service.ts`, 10 s);
- the review package's worktree status (`commands-review.ts`, 30 s);
- the validation worker's drift check (10 s, `spawnSync` `ETIMEDOUT`);
- the worktree fingerprint probe's status read (10 s inside the probe; once it
  has fallen back, the rest of the probe skips the daemon too).

Other failures are not retried. Other git calls were left as they are.

## Tests

`tests/isolate-git-config.ts` writes `core.fsmonitor=false` into the isolated
global config every Node test process uses, so no fixture repository starts a
daemon. A test that needs one sets it in its own repository and stops it.
`git-fsmonitor.test.ts` guards the preload, `enableGitScanCaches`, the
migration's scoping and the daemon stop.

Remaining work: [0735-git-fsmonitor-follow-ups.md](../todo/containers-and-environments/0735-git-fsmonitor-follow-ups.md).
