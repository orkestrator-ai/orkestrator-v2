# Disk usage from Orkestrator work

Environments, dev profiles, agent sessions, test runs and image builds all
write to disk outside the repository. This page lists where that state
collects, what prunes it, and what to run when a machine fills up. How
environment deletion, its cleanup ledger and the orphan sweeps decide what to
remove is in
[environment-deletion.md](../architecture/environment-deletion.md).

## See what is using space

```bash
mise run disk:report          # table: location, size, orphaned entries, owner, cleanup
mise run disk:report -- --json
```

The report is read-only. It needs no root access, so Docker's own directory is
measured through `docker system df` rather than walked.

The `environment cleanup ledger` row counts deletions whose cleanup is still
owed: `retrying` entries are retried with backoff, and `stopped retrying`
entries reached `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS` (8) and are kept for
inspection. For those it lists the pending steps, the redacted last errors (a
step and an error code) and the first environment ids. Entries whose
environment record still exists are left to interrupted-deletion recovery and
not counted. To clear a stuck entry, remove what that environment's deletion
left behind by hand: the pending steps say which of its worktree, branch
(only once you have checked it is merged), container, volumes, network or
bridge state directories remain. The backend log names the environment once
per start (`Cleanup for deleted environment ... is still failing`). The entry
itself is not retried again, and nothing removes it, so it stays in this row
after you have cleaned up by hand (whether to retry or clear such entries is an
open question in todo 0023); see
[environment-deletion.md](../architecture/environment-deletion.md#reconciler).

A graph run whose replicated builder uses `isolation: "worktree"` (item 403)
checks out one worktree per branch inside the environment, under
`.orkestrator/graph-branches/`. Each holds a full checkout (plus whatever the
branch's agent installs, such as `node_modules`) only while its branch runs.
The report's `isolated graph branches` row sums them across local
environments and counts leftovers the repository no longer lists as
worktrees; a container's branches are in its storage volume.

In the app, **Settings > Disk usage** lists every environment's size: its
worktree (largest top-level entries) or its container (writable layer,
recovery copies and storage volumes; the shared image is not counted), plus
the dev worktrees of development profiles started from that checkout. A
profile belongs to an environment when its `profile.json` `repositoryRoot` is
the environment's worktree. The same breakdown is under the environment's own
settings, in General. Sizes are allocated bytes from `du -x`, kept for five
minutes unless refreshed.

## Where new worktrees go

| Worktree | Default | Changed by |
| --- | --- | --- |
| Local environment | `~/orkestrator-v2/workspaces/<project>-<branch>` | The folder button next to the name when creating a local environment; otherwise Settings > Disk usage > New environment worktrees |
| Dev profile | `<profile>/worktrees/` | Settings > Disk usage > New dev worktrees, as `<folder>/<profile id>` (`dev:test` only with `--use-dev-worktree-folder`) |

A backend started with `--worktree-dir` or `ORKESTRATOR_WORKTREE_DIR` (dev
profiles, tests) always uses that directory. Each environment records the
folder its worktree was created in (`worktreeBaseDir`), and deletion only
removes the worktree from inside that folder, so changing the setting never
moves or orphans existing environments. A dev profile keeps the folder it was
created with; the setting places new profiles, read from the production
`config.json` when `dev` creates one (or `dev:test --use-dev-worktree-folder`). A folder outside the profile
carries a `.orkestrator-dev-worktrees` sentinel and is removed with the
profile only while that sentinel names it.

## Moving an existing environment

A local environment's worktree can be moved later, for example to a larger
disk: environment settings > General > **Move environment**. Choose the
destination folder; the worktree keeps its folder name inside it, and every
file moves with it, including uncommitted changes, `node_modules` and other
ignored files. The project home cannot be moved.

- On the same disk this is `git worktree move` (a rename). Across disks the
  worktree is copied to a staging folder next to the destination, renamed into
  place, `git worktree repair` points the repository at it, and only then is
  the old folder removed. Worktrees with submodules use this copy path even
  on the same disk; nested submodule Git links are repaired at the destination.
- The move is refused while an agent in the environment is working or waiting
  for input, while setup runs, and while another lifecycle operation (delete,
  merge, rebuild) is in progress. An admitted file write or worker start must
  finish before a move can begin. While it runs, file mutations, new exec and
  validation workers, prompts and new terminals are refused; its terminals, Claude tmux sessions and
  local agent bridges are stopped first and start again on demand in the new
  folder.
- Agents key their saved conversations by folder, so that state moves too,
  before any bridge restarts (`environment-move-sessions.ts`): Claude
  transcripts move to the new folder's `~/.claude/projects/<slug>` with a
  `relocated` line appended (what Claude Code does itself) and the
  `~/.claude.json` project entry is copied; the Codex bridge's registry and
  dispatch journal in `~/.codex` and every account home are re-keyed to the
  new folder's hash; Cursor's stored agent `cwd` is rewritten. Pi reopens
  sessions by file and needs nothing. OpenCode and Grok keep sessions in
  their own stores keyed by folder, which Orkestrator does not rewrite: their
  earlier conversations are not resumed in the new folder.
- The environment records the new folder as its `worktreeBaseDir`, so
  deletion removes the worktree from there.
- Progress is recorded on the environment (`worktreeMove`). If Orkestrator
  stops mid-move, the next start adopts a move that completed and otherwise
  leaves the worktree where it was and removes the unfinished copy. Once the
  destination is committed, it stays authoritative even if later bookkeeping
  fails. The move record remains until conversation relocation and old-copy
  cleanup finish. Partial completion names affected providers in settings and
  retries on the next backend start; edits, agent work and another move are
  refused until it settles. A rejected path commit restores the original
  worktree when storage confirms that it still owns the source. Ambiguous
  failures keep the environment fenced for recovery. Cleanup records the
  original source directory identity and its completion, so retries preserve
  unrelated directories subsequently created at the old pathname. Legacy
  journals without source identity retain an existing source for manual cleanup.

## What prunes itself

| Location | Pruned by | When |
| --- | --- | --- |
| `<main checkout>/.turbo/cache` (shared by every worktree) | Turborepo, `cacheMaxAge` 7 days and `cacheMaxSize` 10 GB in `turbo.json` | Start of each `turbo run` |
| `~/.config/orkestrator-v2-dev/profiles/*` (Linux; `~/Library/Application Support/orkestrator-v2-dev` on macOS) | `dev`/`dev:test` start; `dev:prune --older-than` for the empty directories a reset or prune leaves | Stopped profiles whose checkout no longer exists |
| Worktrees a dev profile registered in an outside repository | `dev:reset`, `dev:prune`, start-up pruning | With the profile; branches only when merged |
| A profile's macOS `safeStorage` key, the login Keychain item `<electronTitle> Safe Storage` | `dev:reset`, `dev:prune`, start-up pruning | After the profile state is gone; only the title `dev:test` gives that profile id |
| `orkestrator-v2:dev-<hash>` images of a deleted checkout | Start-up pruning, `dev:prune` | With the last profile that used them |
| Per-environment bridge state, worktrees, local branches, containers, volumes and networks | Environment deletion and its reconciler | At deletion; failed steps retried with backoff. See [environment-deletion.md](../architecture/environment-deletion.md) |
| Isolated graph branch worktrees, `<environment>/.orkestrator/graph-branches/<run>/…`, and their branches `orkestrator-graph/<run>/…` (item 403) | The graph run service's branch janitor; `select-workspace`; environment deletion | A branch's worktree when its activation finishes (complete, failed, cancelled or superseded); the run's branches and anything left when the run ends; a select's candidates at once; finished runs that still list some at backend start-up. At most 16 branch worktrees run at once per environment |
| Orphaned bridge state, empty workspace directories, merged branches of deleted environments, abandoned store temp files | Backend orphan sweeps | At start-up and hourly; branches at most daily per project |
| `<data dir>/legacy-json/<timestamp>/` (JSON stores archived by the one-time SQLite import) | Backend database open | 14 days after the import |
| `<data dir>/backups/` (database snapshots) | The backend's snapshot rotation | Newest 6 hourly (taken only after a change), one about 1 and one about 3 days old, and 2 pre-migration kept; none older than 7 days; at most 16 GiB together (the newest hourly always kept). No copy when the disk lacks the live-page copy estimate plus equal headroom (at least 2 GiB). Existing non-incremental databases reuse freed pages without shrinking. Temporary copies of dead processes removed at start-up and before each copy |
| Superseded change-tracking measurements in `orkestrator.sqlite` (`change_measurements`, `change_measurement_files`) | Measurement publication and the change-tracking retention pass | On each publication (bounded) and two minutes after start, then hourly, in batches; the newest two per owner and scope, and any selected or restorable one, stay |
| Artifact preview worker scratch, `ork-artifact-preview-<pid>-*` in the system temp dir | The job itself after a verified exit (which includes any Chromium still running with the scratch as its profile, even one the worker was still launching); otherwise the next backend start with process isolation | At start-up, once the owner has exited or its recorded process start identity differs from the current PID, and the directory is over an hour old. Scratch without a recorded identity uses a day-long limit if its PID is live; names without a PID also use a day. An inspection failure retains recorded scratch for a live PID. |
| Design renderer browser profiles, `playwright_chromiumdev_profile-*` in the backend's temp dir | Playwright, when the browser exits; otherwise the next backend start, from the ledger in `<data dir>/design-browser-profiles/` | At start-up, only for profiles that ledger recorded, once their backend and browser have both exited (recorded start identities), the profile is over an hour old, and no live process names it. Profiles of other tools share the prefix and are never touched |
| Design renderer artifacts directories, `<data dir>/design-browser-profiles/artifacts-<pid>-*` (Playwright's `artifactsDir`, so no `playwright-artifacts-*` in the temp dir) | The backend, with the browser's ledger record; a failed launch at once | With its record, as for the profile; one without a record (its backend was killed while launching) at start-up once that backend has exited and the directory is over an hour old |
| Test temporary directories in the system temp dir | The next test run | Once the creating process has exited and the directory is over an hour old |
| Test processes' private `TMPDIR`, `ork-test-tmp-<pid>-*` in the system temp dir, or `/private/tmp` on macOS (holds the browser profiles and anything else a test leaves) | The process itself when its preload's `afterAll` (Bun) or `exit` (Playwright runner) runs; otherwise the next test process | Once the owner has exited, the directory is over an hour old, and no live process names it on its command line |
| Managed agent toolchains | `manager.ts` | Superseded versions after 14 days |

## What you clean yourself

These belong to other tools. Orkestrator reports them and never deletes them.

- **Docker build cache.** It is shared with every other project on the
  machine, so nothing here prunes it. Cap it once in the daemon configuration
  (`/etc/docker/daemon.json` on Linux, Settings > Docker Engine in Docker
  Desktop) and restart the daemon:

  ```json
  { "builder": { "gc": { "enabled": true, "defaultKeepStorage": "15GB" } } }
  ```

  For an immediate cut: `docker builder prune --max-used-space 15GB`.
  `dev:test` and `docker:build:dev` warn before an image build when the cache
  is over 25 GB.
- **Development profiles you still have a checkout for.**
  `mise run dev:prune --older-than 14` removes stopped ones idle for two weeks.
  Add `--dry-run` to list them first.
- **Claude Code isolation worktrees in `<project>/.claude/worktrees`.** Claude
  Code keeps any that contain commits. Remove merged, clean ones with
  `git worktree remove <path>`.
- **Agent transcripts for deleted worktrees**, in `~/.claude/projects`. Claude
  Code deletes them after `cleanupPeriodDays` (default 30) in
  `~/.claude/settings.json`; lower it to keep less. Codex keeps sessions under
  `~/.codex/sessions/<year>/<month>`.
- **Superseded tool versions installed by mise:** `mise prune`.
- **Legacy Turbo artifacts** at the top of `.turbo/` from an older layout:
  `mise run disk:report -- --fix legacy-turbo`.
- **Leaked host-reachability probe networks**, `ork-<owner>-reach-probe-net`.
  They hold no data, but each takes one of Docker's address pools; once the
  pools are full no environment network can be created (`resource-exhausted`).
  A backend's check removes its own network, and its next check reaps its own
  owner's leftovers, but a test backend killed mid-check under a one-off data
  directory leaves one nobody revisits. The report's `probe networks` row
  counts them, and `mise run disk:report -- --fix probe-networks` removes,
  one at a time by network id, only those with no container in any state and
  created more than a day ago, whatever their owner. A check lasts seconds, so such a network
  cannot belong to a running one (todo 0241).

## Commands

```bash
mise run dev:prune --dry-run            # list profiles that would be removed
mise run dev:prune                      # remove stopped profiles whose checkout is gone
mise run dev:prune --older-than 14      # ... and stopped profiles idle for 14 days
mise run dev:prune --force              # explicitly discard changes in linked worktrees
mise run dev:reset --profile <name>     # remove one stopped profile (--stop-first stops it)
```

`dev:prune` never touches a running profile or a `profile.json` that
describes another directory. Directories without a valid profile sentinel
are kept, except for empty reset skeletons: `--older-than` can remove the
profile root and its empty `data` and `data/portable-inputs` directories
after that age. Other entries disqualify a directory from this exception.
Automatic pruning and ordinary `dev:prune` keep a profile if a linked worktree
has modified or untracked files. Inspect the reported path before using
`dev:prune --force` or `dev:reset`, which can discard those files.
