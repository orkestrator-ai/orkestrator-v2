# Disk state left behind by Orkestrator work

Status: Implemented with automated verification on 2026-09-28; an isolated
real-stack pass of the backend sweeps is outstanding.  
Prepared: 2026-09-28  
Source revision: `13db6e18`

## Intended outcome

Day-to-day Orkestrator work (environments, dev profiles, agent sessions, test
runs, image builds) does not leave disk usage growing without bound. Every
location that grows either has an owner that prunes it automatically, or is
reported so a person can decide. Nothing is deleted that its pruner cannot
prove it owns, and no unmerged work is discarded silently.

This follows on from
[environment-deletion-cleanup.md](environment-deletion-cleanup.md), which
covers state that environment deletion itself creates. That plan's
out-of-scope list is the starting point here.

## What was observed

One Linux machine, 243 GB btrfs root, 88% full (208 GB used), with 8 live
environments. Sizes are `du` measurements unless stated. Worktree
`node_modules` are hard links into Bun's install cache (link count 29 on a
sampled file), so they cost little extra disk and are excluded.

| # | Location | Size | Grows because | Owner today |
| --- | --- | --- | --- | --- |
| O1 | Docker build cache (`/var/lib/docker`) | 40.2 GB (32.9 GB not shared with an image) | Every image build adds layers; all 754 records were used within the last day, so only a size cap helps | Docker daemon GC; no limit configured |
| O2 | Turborepo cache, main checkout `.turbo/cache` | 17 GB, 3,045 artifacts (about 1,000 added per day) | Turbo shares one local cache across all worktrees, and eviction is opt-in | Nobody |
| O3 | Legacy Turbo artifacts at `.turbo/*.tar.zst`, `*-manifest.json`, `*-meta.json` | about 3 GB | Last written 2026-09-10; outside `cacheDir`, so eviction will never touch them | Nobody |
| O4 | Dev profiles, `~/.config/orkestrator-v2-dev/profiles/*` | 8.1 GB, 7 profiles, all orphaned | Only `dev:reset` removes a profile | `dev:reset` (manual) |
| O5 | Git worktree inside a dev profile (`workspace-aa7b8be3/worktrees/…`) | 2.8 GB (part of O4) | A dev-profile environment made a real worktree of the main repository; `dev:reset` deletes the folder but leaves the worktree registered and its branch behind | Nobody |
| O6 | Claude Code agent worktrees, main checkout `.claude/worktrees/*` | 5.0 GB, 26 worktrees | Claude Code keeps isolation worktrees that contain commits; all 26 have commits not on `main`, and 1 has uncommitted changes | Claude Code (keeps them by design) |
| O7 | Local environment branches with no environment | 175 of 183 `*-<12 hex>-r<N>` branches | Created before the cleanup ledger existed; that plan deliberately does not sweep them | Nobody |
| O8 | Stray directories in the workspaces root | 4 directories, < 1 MB | One is an empty `bridges/` tree left by F2 of the earlier plan; three `scan-caches-*` directories were created by a test (see T1) | Nobody |
| O9 | Claude transcripts for deleted worktrees, `~/.claude/projects/-home-…-workspaces-*` | 2.1 GB, 378 directories | One directory per worktree path | Claude Code, `cleanupPeriodDays` (default 30) |
| O10 | Codex session logs, `~/.codex/sessions/2026/09` | 1.8 GB | Per-session rollouts | Codex |
| O11 | Temporary directories in `/tmp` (tmpfs, so they use RAM) | 318 MB, about 30,000 entries | 29,550 `orkestrator-test-git-config-*` directories (T2); `orkestrator-packaged-backend-*` at 58 MB each; Playwright profiles | Tests (T2, T3) |
| O12 | Docker container `ork-8dd6e447ff3b0125-env-agent-test-mounts` | small | Created 2026-09-07 with a test environment ID (`commands-registry-environments-status.test.ts:715`); its owner label matches no profile or instance | Nobody |
| O13 | Abandoned atomic-write temp files | < 1 MB | `agent-platforms.json.44078.tmp` in the production data dir; 25 `*-manifest.json.tmp` in `.turbo/cache` | Nobody |
| O14 | Superseded agent CLI versions in `~/.local/share/mise/installs` (codex, claude, cursor-agent, opencode) | several GB | mise keeps every version it installed | mise (`mise prune`, manual) |

Already bounded, no change needed:

- **Bridge state directories:** `cursor-bridge-state` is now 5.3 MB, down from
  2.11 GB, so F1 and step 06 of the earlier plan are working.
- **JSON stores in the production data dir:** the `.bak.1`–`.bak.5` rotation
  keeps a fixed number of copies.
- **Production agent toolchains (3.3 GB):** `toolchain-manager.ts:41` prunes
  superseded versions after 14 days.
- **Electron HTTP cache (1.1 GB):** Chromium enforces its own limit.
- **`release/` and `binaries/`:** each build overwrites them.

Not Orkestrator's, and outside this plan's scope:

- **Swap file:** 31 GB.
- **Bun install caches:** two of them, `~/.bun/install/cache` (6.6 GB) and
  `~/.cache/.bun` (5.9 GB). The second exists because something set
  `XDG_CACHE_HOME`; the cause was not traced.
- **Remaining unexplained usage:** about 29 GB, probably btrfs snapper
  snapshots (reading them needs root).

## Findings in the repository

### T1 — A test creates real worktrees in the user's workspaces root

`tests/unit/electron/commands-integration.test.ts:2334` ("enables git's scan
caches on a newly created worktree") calls `start_environment` without
`context.worktreeDir`. `getWorktreeBaseDir`
(`apps/backend/src/core/commands-environment.ts:386`) then falls back to
`~/orkestrator-v2/workspaces`. Each run leaves a
`scan-caches-<id>-feature-scan-caches-<id>` worktree whose `.git` points into a
deleted `/tmp` repository. The earlier plan flagged this under "Related,
separate"; it still happens (most recent 2026-09-25).

### T2 — Test git-config isolation leaks one directory per test process

`tests/isolate-git-config.ts` creates a `mkdtemp` directory at import time and
removes it in `process.once("exit")`. Test workers that are killed, time out,
or exit through a path that skips `exit` handlers never run it; 29,550
directories have accumulated.

### T3 — Other test temp directories are not swept

`orkestrator-packaged-backend-*` (`apps/backend/tests/standalone.test.ts`),
`orkestrator-test-run-*` (`scripts/test-all.ts`), `pi-mcp-*`, and
`playwright_chromiumdev_profile-*` show the same pattern at smaller scale.

### D1 — Dev profiles have no automatic lifecycle

`dev:stop` leaves state in place, and `dev:reset`
(`apps/desktop/scripts/dev/lifecycle.ts:748`) is the only removal path. Nothing
ties a profile to the checkout it was created from, which `profile.json` records
as `repositoryRoot`. All 7 profiles on the machine point at checkouts that no
longer exist.

### D2 — `dev:reset` strands worktrees registered by the profile

`removeProfileState` (`apps/desktop/scripts/dev/profile-io.ts:84`) runs
`rm -rf` on the profile root. A local environment created inside the profile
registers its worktree under `<profileRoot>/worktrees/` with the host
repository. After the reset, `git worktree list` still shows the worktree and
its branch survives.

### B1 — Neither build cache has a size cap

- **Turbo:** `turbo.json` sets neither `cacheMaxAge` nor `cacheMaxSize`. Both
  are opt-in in Turborepo 2.10, and this repository is on the 2.10 schema. The
  shared worktree cache makes this one of the two largest single costs.
- **Docker:** the daemon has no `builder.gc.defaultKeepStorage`.
  `docker:build:dev` (`apps/desktop/scripts/dev-build-image.ts`) and the
  `dev:test --fixture container` path (`lifecycle.ts:469-492`) each build the
  57-stage image, so every rebuild from a different checkout adds gigabytes of
  layers.
- **`.dockerignore` gaps:** the file does not exclude `.turbo`, `.claude`,
  `release`, `binaries`, or `output`. The recorded build contexts are about
  14 MB today, so the context is small in practice. The exclusions are still
  worth adding so a build from the main checkout can never upload the 20 GB
  Turbo cache or the agent worktrees.

## Design

State is grouped by who can safely delete it:

1. **Configuration caps** for caches that know how to evict themselves (Turbo,
   BuildKit). Zero-risk, so this goes first.
2. **Dev tooling cleans up after itself.** Profiles, and the worktrees they
   register, are pruned when their checkout is gone. This runs automatically
   at `dev:test` start.
3. **Tests leave nothing behind.** Fix the leaks at source, and sweep stale
   leftovers when a test run starts.
4. **The app extends its existing reconciler** to provable leftovers that
   predate the cleanup ledger: stray workspace directories, orphaned
   environment branches, and abandoned temp files. Removal follows the same
   no-data-loss rules as the earlier plan.
5. **Report, don't delete**, for state owned by other tools (Claude Code
   worktrees and transcripts, Codex sessions, mise installs). A disk report
   makes these visible, and the people who own them decide.

## Implementation steps

### 01 — Cap the Turborepo cache (B1, O2, O3)

- Add `"cacheMaxAge": "7d"` and `"cacheMaxSize": "10GB"` to `turbo.json`.
  Eviction runs in a background thread at the start of each `turbo run`. The
  cache is shared by every worktree, so a single setting bounds all of them.
- Delete the legacy top-level `.turbo/*.tar.zst`, `*-manifest.json`, and
  `*-meta.json` files, plus `.turbo/cache/*.tmp`, once. This can be a one-off
  manual step, or it can live in step 07's report as a fix-it action.
- Add `.turbo`, `.claude`, `release`, `binaries`, and `output` to
  `.dockerignore`.

### 02 — Cap the Docker build cache (B1, O1)

This is machine configuration and needs root, so document it rather than
automate it:

- In `docs/development/` (setup), recommend `/etc/docker/daemon.json`
  `{"builder": {"gc": {"enabled": true, "defaultKeepStorage": "15GB"}}}`
  followed by a daemon restart.
- `dev:test` warns once per run when `docker system df` reports build cache
  above 25 GB. The message points at the setting, and at
  `docker builder prune --keep-storage 15GB` for an immediate fix.
- Do not run `docker builder prune` automatically. The build cache is shared
  with other projects on the machine, and AGENTS.md forbids broad Docker
  cleanup.

### 03 — `dev:prune` and automatic profile pruning (D1, D2, O4, O5)

- Extract the body of `resetProfile` after profile resolution into
  `removeProfile(profile, { keepToolchains })`: sentinel validation, removal
  of exact-owner containers, then state removal.
- Before removing state, for each registered worktree of `repositoryRoot` whose
  path is inside `profile.worktreeDir`:
  - run `git worktree remove --force`, falling back to `git worktree prune`
    when the host checkout is gone;
  - delete that worktree's branch only under the same policy as step 04 of the
    earlier plan: merged, an ancestor of the default branch, or no commits
    beyond its start point. Otherwise keep the branch and print its name.
- Add `pruneProfiles({ olderThanDays?, dryRun })` in
  `apps/desktop/scripts/dev/lifecycle.ts`. For each directory in
  `<developmentRoot>/profiles`:
  - skip it without a valid `.orkestrator-dev-profile` sentinel and
    `profile.json`;
  - skip it if any tracked process is live (`liveness(status)`);
  - remove it when `repositoryRoot` no longer exists;
  - with `--older-than <days>`, also remove it when its `status.json` mtime,
    or the profile root's mtime if there is no status file, is older than the
    limit.
- Add `apps/desktop/scripts/dev-prune.ts` and a `mise run dev:prune` task with
  `--dry-run`, `--older-than`, and `--keep-toolchains`.
- At the start of `startProfile`, before profile resolution
  (`lifecycle.ts:432`), run the orphan-only prune (never the age rule). Print
  one line per profile removed, and warn instead of aborting when it fails.
- Tests:
  - an orphan is removed and a live profile is kept;
  - a profile without a sentinel is kept;
  - a registered profile worktree is unregistered;
  - an unmerged branch is kept;
  - `--dry-run` removes nothing.
- AGENTS.md §9: keep "stop and reset when done", and note that orphaned
  profiles are now pruned at the next `dev:test`.

### 04 — Tests leave nothing behind (T1, T2, T3, O8, O11, O12)

- **T1:**
  - Give `createContext` in `commands-integration.test.ts` a per-test
    `worktreeDir` under the test's temp root.
  - In the test preload (`tests/setup-node.ts`), set a process-wide override
    that `getWorktreeBaseDir` honours when `context.worktreeDir` is absent.
    Point it at a per-run temp directory, so a future test that forgets the
    context field cannot reach `~/orkestrator-v2/workspaces`.
  - Add a guard test that fails if the fallback resolves inside the real home
    directory while running under the test preload.
- **T2:**
  - Name the directory `orkestrator-test-git-config-<pid>-<random>`.
  - At preload, remove siblings whose PID is no longer running and whose mtime
    is more than 1 hour old.
  - Keep the `exit` handler for the normal case.
- **T3:** apply the same PID-and-age sweep helper to the other `/tmp` prefixes
  created under `tests/` and `scripts/test-all.ts`. Put it in
  `tests/temp-sweep.ts` so each prefix opts in explicitly.
- **O12:** confirm `commands-registry-environments-status.test.ts` only reaches
  the fake Docker binary. Remove the stray container by hand
  (`docker rm ork-8dd6e447ff3b0125-env-agent-test-mounts`).

### 05 — Extend the backend reconciler to pre-ledger leftovers (O7, O8, O13)

This runs in the startup sweep next to the bridge-state sweep
(`environment-cleanup-reconciler.ts`), through the environment lifecycle queue.

- **Stray workspace directories:** remove a directory directly under
  `getWorktreeBaseDir()` only when all of the following hold:
  - no environment (live or `deleting`) references it;
  - it is not a registered worktree of any known project;
  - it contains no regular files except known build logs
    (`**/.turbo/turbo-*.log`).

  This is the F2 residue. Report anything else (for example `scan-caches-*`,
  or hand-made `wa-integration`) instead of deleting it. Use
  `removeConfinedDirectory`.
- **Orphaned environment branches:**
  - A branch is a candidate when its name matches the environment naming
    scheme (`<slug>-<12 hex>-r<N>`), the hex matches no environment ID prefix,
    and it is not checked out in any worktree.
  - Delete it only under the earlier plan's step 04 policy. Otherwise keep it
    and count it.
  - Run this once per project per day, not on every start.
- **Abandoned temp files:** remove `<store>.json.<pid>.tmp` in the data dir
  when that PID is not alive and the file is more than 1 hour old.
- Tests extend `environment-cleanup-reconciler.test.ts` with:
  - a directory that holds only build logs is removed;
  - a directory with any other file is reported, not removed;
  - a merged orphan branch is deleted, and an unmerged one is kept;
  - a temp file belonging to a live PID is kept.

### 06 — Other tools' state: surface, don't delete (O6, O9, O10, O14)

Orkestrator does not own this state, so it does not delete it. Step 07 lists
it with sizes and the owner's own cleanup command:

- **Claude Code isolation worktrees under `<project>/.claude/worktrees`:** list
  each one with a flag for merged, unmerged, or has uncommitted changes.
  Suggest `git worktree remove` only for merged, clean ones.
- **Claude transcripts for worktree paths that no longer exist:** suggest a
  lower `cleanupPeriodDays` in `~/.claude/settings.json`.
- **Codex sessions:** show the total size per month.
- **mise installs with superseded versions:** suggest `mise prune`.

### 07 — `mise run disk:report`

A read-only script, `scripts/disk-report.ts`, prints one table covering
O1–O14:

- the location;
- its size;
- the count of provably orphaned entries;
- the owner, and the command that cleans it.

It uses the same predicates as steps 03–05, so the report and the pruners
cannot disagree. `--json` gives machine-readable output. This makes
regressions visible, as T1 and T2 would have been. It is also the natural home
for step 01's one-off legacy Turbo cleanup, as `--fix legacy-turbo`.

## Expected effect on the observed machine

| Step | Recovered now | Growth afterwards |
| --- | --- | --- |
| 01 Turbo cap and legacy cleanup | about 10 GB | capped at 10 GB |
| 02 Docker GC (manual, root) | about 25 GB | capped at 15 GB |
| 03 Dev profile pruning | 8.1 GB | orphans removed at next `dev:test` |
| 04 Test hygiene | about 300 MB of RAM (tmpfs) | none |
| 05 Reconciler extensions | small (branches, empty directories) | none |
| 06–07 Report | up to 9 GB if the user acts (O6, O9, O10) | visible |

## Decisions

1. **Turbo limits.** 7 days and 10 GB. Four days of shared cache was 17 GB, so
   10 GB keeps roughly the last two days.
2. **Dev profile age rule.** Manual only. `dev`/`dev:test` start removes
   orphans; `dev:prune --older-than <days>` removes idle profiles on request.
3. **Orphaned environment branches.** Swept, but only when they pass the
   no-data-loss policy. Unmerged ones are kept and counted.

## Implementation notes

Where the code differs from, or adds to, the steps above:

- **Development images.** A profile's image is named after its checkout
  (`orkestrator-v2:dev-<hash>`), so pruning an orphaned profile also runs
  `docker image rm` (never `--force`) on its image, unless a surviving profile
  still names it.
- **Profile worktree branches.** `removeProfile` treats a branch as disposable
  only when it is an ancestor of `origin/HEAD`, `origin/main`, or a local
  `main`/`master`. It never deletes the default branch itself, or a branch
  still checked out in another worktree.
- **Build cache warning.** Runs only immediately before a `docker build` (the
  `--fixture-environments container` path and `docker:build:dev`), not on
  every start, because `docker system df` costs about a second.
- **Environment branch names** are `<slug>-<ns>[-r<N>][-<n>]`: revision 0 has
  no `-r`, and allocation can add up to two collision suffixes.
  `parseEnvironmentBranchNamespace` (`commands-agent-support.ts`) is the single
  definition. The backend sweep and `disk:report` both use it, and a test pins
  it against `environmentBranchBase`.
- **Branch sweep protections** go beyond the plan. Protected branches:
  - namespaces of live and `deleting` environments, and of ledger entries;
  - recorded `branch` and `delegationBaseBranch` names;
  - branches checked out in any worktree;
  - the configured default branch and the `origin/HEAD` target.

  Pre-ledger branches have no PR state. So besides the ancestor test, a branch
  with no commits beyond its reflog `Created from` entry also counts as
  disposable. Deletion goes through the existing `cleanupEnvironmentBranch`.
  The last sweep time per project is kept in
  `<dataDir>/environment-cleanup-sweeps.json`.
- **Serialisation.** The lifecycle queue is keyed per environment, so the
  sweeps run as one operation under the reserved key
  `orphaned-disk-state-sweep`. That gives them shutdown admission and draining.
  Creation cannot collide with them: it never picks an existing path or branch
  name, and new environments get a fresh ID namespace. Directories modified in
  the last hour are also skipped.
- **Stray workspace directories.**
  - The newest mtime anywhere in the tree counts, not only the top
    directory's.
  - A walk over 10,000 entries, or one that cannot be read, counts as content.
  - A failed `git worktree list` for any project abandons the pass.
  - The count of kept directories with content is logged only when it changes.
- **Store temp files** must match `<name>.json.<pid>.tmp`. Other shapes, such
  as `.coordinators.json.<uuid>.tmp`, are left alone.
- **Worktree root override.** `getWorktreeBaseDir` falls back to
  `ORKESTRATOR_WORKTREE_DIR` (the variable the backend already reads at
  startup) before `~/orkestrator-v2/workspaces`, and the test preloads set it.
- **Why test directories leaked (T2).** Bun 1.4.2 never runs
  `process.once("exit")` handlers registered in a test preload. Under
  `--parallel` it also re-runs the preload for every file. So every run leaked
  one directory per test file, not just killed workers. A preload-level
  `afterAll` does run, once per file under `--parallel`. It is now the primary
  cleanup; the `exit` handlers remain as a fallback. `tests/temp-sweep.ts`
  names directories `<prefix><pid>-<random>` and removes a directory only when
  its PID is dead and it is over the age limit.
- **Test isolation (T1, O12).**
  - `tests/isolate-worktree-dir.ts` gives every preload a per-process
    `ORKESTRATOR_WORKTREE_DIR`.
  - `tests/unit/electron/command-fixtures.ts` gives each test context its own
    `worktreeDir`.
  - The same fixtures point `DOCKER_HOST` at a socket that does not exist
    unless `RUN_LIVE_DOCKER_TESTS=1`, so a test whose fake `docker` was
    restored early cannot reach the real daemon. That is the likely origin of
    the O12 container.
- **Other test prefixes.**
  - `apps/backend/tests/standalone.test.ts` embeds the PID in its six prefixes,
    and now waits for its spawned backends to exit before deleting their
    directories.
  - Three pi-bridge MCP test files now delete their temporary directories.
  - `orkestrator-test-run.*` is unchanged: `scripts/test-all.ts` already keeps
    it for 7 days, because it holds failure logs.
  - Still leaking, as a follow-up: `pi-http-*`, `ork-journal-gc-*`,
    `ork-runtime-*`, `ork-preview-*`, `orkestrator-state-sync-*`,
    `orkestrator-activity-boot-*`, `ork-watch-*`, and
    `cursor-bridge-sdk-test-*`.
- **Code:** `apps/desktop/scripts/dev/profile-cleanup.ts`, `dev-prune.ts`,
  `apps/backend/src/core/environment-cleanup-reconciler.ts`,
  `scripts/disk-report.ts`, and the operator page
  `docs/development/disk-usage.md`.
