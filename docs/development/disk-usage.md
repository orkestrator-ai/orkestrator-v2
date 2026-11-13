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
is retried for one more cycle when a backend version that has never attempted
it starts (usually after an upgrade), so it may then move back to `retrying`
or disappear. Otherwise nothing removes it, so it stays in this row after you
have cleaned up by hand until the next new version retries it and finds
nothing left to do; see
[environment-deletion.md](../architecture/environment-deletion.md#reconciler).

The `git-mirrors` row is the per-project Git mirrors under that directory of the
data directory, and how many belong to projects that no longer exist. See [Project Git mirrors](#project-git-mirrors) for what they cost.

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

The same page has a **Project Git mirrors** section: one line per project with
a [Git mirror](#project-git-mirrors) or a build of one, with its size, measured
each time the page opens. A mirror whose project has gone shows as *Removed
project* until the hourly sweep takes it.

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

- On the same disk this is `git worktree move` (a rename). git will not move
  a worktree with submodules, so that one is renamed directly, then
  `git worktree repair` points the repository at it and its nested submodule
  Git links are repaired; nothing is copied. Across disks (the rename reports
  `EXDEV`) the worktree is copied to a staging folder next to the destination,
  renamed into place and repaired the same way, and only then is the old
  folder removed.
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

## Project Git mirrors

Each project with a container environment gets one bare mirror of its branches,
at `<data dir>/git-mirrors/<project id>/mount-<access kind>/mirror.git`, so that later
environments do not download the repository again
([container-lifecycle.md](../architecture/container-lifecycle.md#project-git-mirror)).

What it costs, on the two repositories measured:

| Repository | Mirror on the host | Each environment's Git directory, blobless clone | The same, cloned from the mirror | Each environment's download, blobless | The same, from the mirror |
| --- | --- | --- | --- | --- | --- |
| `orkestrator-ai/orkestrator-v2` | 86 MiB | 45 MiB | 87 MiB | 43 MiB | 0.01 MiB |
| `git/git` | 322 MiB | 131 MiB | 323 MiB | 124 MiB | 0.01 MiB |

- **It saves network, not disk.** A clone from the mirror is self-contained, so
  every environment holds its own copy of the history, in its workspace volume.
  That is more than a blobless clone, which leaves file history on the remote and
  fetches it on demand. Budget one mirror per project, plus one copy per
  environment.
- **At most 2 GiB per project** (`GIT_MIRROR_MAX_BYTES`). A larger repository gets
  no mirror, is looked at again after a week, and its environments keep the
  blobless clone. A build needs 3 GiB free on the data directory's disk and a
  fetch 1 GiB; otherwise it is skipped and logged. Fetches compact themselves past
  30 packs.
- **A first build reuses the host checkout.** A project with a host checkout
  downloads only what the checkout lacks, on 7 GiB free or more; with less, or if
  the checkout cannot help, the build downloads everything. The result is the same
  mirror either way
  ([how](../architecture/container-lifecycle.md#project-git-mirror)). What the
  remote sent for this repository, from a local bare clone at 76 MiB: 72 MiB with
  no checkout, 6 MiB from a checkout 50 commits behind, nothing from a current one.
  On that same disk, with no network to wait for, a seeded build took longer: 16 s
  without a checkout, 36 s and 55 s with one, one run each. It was not measured
  against a real network remote. It runs in the background either way.
- **It is only a cache.** To reclaim it by hand, delete only
  `<project id>/mount-<kind>/mirror.git` (or `mount/mirror.git`, left by an
  older version), keeping the project directory and every `mount*/` directory.
  Existing clones are self-contained and the next creation rebuilds the mirror.
  Removing a `mount-<kind>/` directory also permits automatic recovery while its project parent
  remains writable by the backend.
  Do not delete the project parent while containers still reference it: rootful
  Docker recreates missing bind sources and parents as root on restart. Existing
  environments still start and new ones fall back to remote clones, but refresh
  and cleanup then need host operator intervention. Restore ownership of that
  exact `git-mirrors/<project id>` tree to the backend user's uid and gid
  (including every `mount*/` directory), and restore the project directory to mode `0700`.
  The next creation can then rebuild; the orphan sweep can retry cleanup.
  Permission failures log this remediation hint. The backend does not elevate
  privileges to change ownership.
- **Removed with its project**, in the project's own cleanup. The hourly sweep
  retries removal of any whose project no longer exists. Ownership failures
  require the host repair described above before a retry can succeed. Nothing removes one by age, and Settings > Disk usage does not list
  them: use `mise run disk:report`.

## What prunes itself

| Location | Pruned by | When |
| --- | --- | --- |
| `<main checkout>/.turbo/cache` (shared by every worktree) | Turborepo, `cacheMaxAge` 7 days and `cacheMaxSize` 10 GB in `turbo.json` | Start of each `turbo run` |
| `~/.config/orkestrator-v2-dev/profiles/*` (Linux; `~/Library/Application Support/orkestrator-v2-dev` on macOS) | `dev`/`dev:test` start; `dev:prune --older-than` for the empty directories a reset or prune leaves | Stopped profiles whose checkout no longer exists |
| Worktrees a dev profile registered in an outside repository | `dev:reset`, `dev:prune`, start-up pruning | With the profile; branches only when merged |
| A profile's macOS `safeStorage` key, the login Keychain item `<electronTitle> Safe Storage` | `dev:reset`, `dev:prune`, start-up pruning | After the profile state is gone; only the title `dev:test` gives that profile id, and only for the profile under the default development root. Matched by service alone: Electron 45.2.3 names the account `<electronTitle> Key`, earlier builds `<electronTitle>` (checked live on macOS 27.2 on 2026-11-13, when the old account match was found to remove nothing). Only `development` profiles make one: agent-test profiles use Chromium's mock Keychain on macOS |
| `orkestrator-v2:dev-<hash>` images of a deleted checkout | Start-up pruning, `dev:prune` | With the last profile that used them |
| Per-environment bridge state, worktrees, local branches, containers, volumes and networks | Environment deletion and its reconciler | At deletion; failed steps retried with backoff. See [environment-deletion.md](../architecture/environment-deletion.md) |
| Isolated graph branch worktrees, `<environment>/.orkestrator/graph-branches/<run>/…`, and their branches `orkestrator-graph/<run>/…` (item 403) | The graph run service's branch janitor; `select-workspace`; environment deletion | A branch's worktree when its activation finishes (complete, failed, cancelled or superseded); the run's branches and anything left when the run ends; a select's candidates at once; finished runs that still list some at backend start-up. At most 16 branch worktrees run at once per environment |
| Orphaned bridge state, empty workspace directories, merged branches of deleted environments, abandoned store temp files | Backend orphan sweeps | At start-up and hourly; branches at most daily per project |
| `<data dir>/legacy-json/<timestamp>/` (JSON stores archived by the one-time SQLite import) | Backend database open | 14 days after the import |
| `<data dir>/backups/` (database snapshots) | The backend's snapshot rotation | Newest 6 hourly (taken only after a change), one about 1 and one about 3 days old, and 2 pre-migration kept; of the change-tracking ledger, 2 daily and 2 pre-migration; none older than 7 days; at most 16 GiB together (the newest hourly always kept, ledger copies give way first). No copy when the disk lacks the live-page copy estimate plus equal headroom (at least 2 GiB). Existing non-incremental databases reuse freed pages without shrinking. Temporary copies of dead processes removed at start-up and before each copy |
| Superseded change-tracking measurements in `change-tracking.sqlite` (`change_measurements`, `change_measurement_files`) | Measurement publication and the change-tracking retention pass | On each publication (bounded) and two minutes after start, then hourly, in batches; the newest two per owner and scope, and any selected or restorable one, stay |
| The rest of the change ledger, its objects and its evidence bodies (`change-tracking.sqlite`, `<data dir>/change-tracking/`) | Deleting an environment and the change-tracking retention pass | A deleted environment's rows within a minute or so of the delete and its content past the orphan grace, except what another environment still names; everything of finished work past `archivedBodyRetentionDays` (30), except turn boundary rows and open thread segments |
| Artifact preview worker scratch, `ork-artifact-preview-<pid>-*` in the system temp dir | The job itself after a verified exit (which includes any Chromium still running with the scratch as its profile, even one the worker was still launching); otherwise the next backend start with process isolation | At start-up, once the owner has exited or its recorded process start identity differs from the current PID, and the directory is over an hour old. Scratch without a recorded identity uses a day-long limit if its PID is live; names without a PID also use a day. An inspection failure retains recorded scratch for a live PID. |
| Design renderer browser profiles, `playwright_chromiumdev_profile-*` in the backend's temp dir | Playwright, when the browser exits; otherwise the next backend start, from the ledger in `<data dir>/design-browser-profiles/` | At start-up, only for profiles that ledger recorded, once their backend and browser have both exited (recorded start identities), the profile is over an hour old, and no live process names it. Profiles of other tools share the prefix and are never touched |
| Design renderer artifacts directories, `<data dir>/design-browser-profiles/artifacts-<pid>-*` (Playwright's `artifactsDir`, so no `playwright-artifacts-*` in the temp dir) | The backend, with the browser's ledger record; a failed launch at once | With its record, as for the profile; one without a record (its backend was killed while launching) at start-up once that backend has exited and the directory is over an hour old |
| Test temporary directories in the system temp dir | The next test run | Once the creating process has exited and the directory is over an hour old |
| Test processes' private `TMPDIR`, `ork-test-tmp-<pid>-*` in the system temp dir, or `/private/tmp` on macOS (holds the browser profiles and anything else a test leaves) | The process itself when its preload's `afterAll` (Bun) or `exit` (Playwright runner) runs; otherwise the next test process | Once the owner has exited, the directory is over an hour old, and no live process names it on its command line |
| Managed agent toolchains | `manager.ts` | Superseded versions after 14 days |
| `<data dir>/git-mirrors/<project id>` | The project's removal; the backend's orphan sweep; its own refresh when it passes 2 GiB | With the project; hourly for one whose project is gone, once over an hour old. See [Project Git mirrors](#project-git-mirrors) |
| Self-improvement state, `<data dir>/self-improvement/` | The self-improvement service | After each run: the newest 120 digests and 60 observations per tracked problem are kept; under `insights/`, conversation notes for 90 days (at most 3,000) and read positions for conversations touched in the last 90 days. See [self-improvement.md](../architecture/self-improvement.md) |

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
- **Disposable Docker daemons** for the live container suites, under
  `${XDG_STATE_HOME:-~/.local/state}/orkestrator-disposable-docker/`, one
  directory per checkout (instances started before 2026-11-11 are under the
  checkout's `output/disposable-docker/`). A run that does not reach `stop`
  leaves a full container runtime there, often over 10 GB. The report's row
  counts the roots whose checkout is gone. Their files belong to RootlessKit's
  mapped users, so remove an instance with
  `bun scripts/disposable-docker-daemon.ts stop --name <n> --root <dir>`
  rather than `rm`; see
  [container qualification](container-qualification.md#disposable-docker-daemon).
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
  cannot belong to a running one (todo 0241). Each probe network and container
  also carries an `orkestrator-creator` label, `<runtime flavor>/<temporary|persistent>`
  (for example `agent-test/temporary` for a disposable test backend), and the
  row counts the stale ones by it; `unlabelled` ones predate the label
  (todo 7470). The value never names a path, a user or a spec, because anyone
  who can reach the daemon can read it. Electron specs and the CLI harnesses
  run their backends with the boot probe off, so a new `…/temporary` leak
  points at a harness that does not.

  The sweep also requires the `host-reachability-probe` role label and a name
  of the exact form `ork-<16 hex>-reach-probe-net`, and keeps any network
  Docker cannot answer about. On a shared daemon it removes networks other
  runs created, so running it is the host owner's decision: an agent or
  harness removes only what it created itself (by its owner label) or what its
  own owner's reaper finds, and runs the sweep only with the owner's explicit
  go-ahead. While the pools are full, the shim for manual container profiles
  in [container qualification](container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06)
  gives a profile's own networks explicit subnets.

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

## A development profile's macOS Keychain item

Electron keeps a profile's `safeStorage` key in the login Keychain as the
generic password `<electronTitle> Safe Storage`, where the title is
`Orkestrator AI — DEV [<profile id>]`. Only `development` profiles (started
with `bun run --cwd apps/desktop dev --profile <id>`; `mise run dev --profile`
passes `--profile` to turbo instead) create one: `dev:test` profiles run with
Chromium's mock Keychain on macOS. `removeProfileKeychainItem`
(`apps/desktop/scripts/dev/profile-cleanup.ts`) deletes it after the profile
state is gone, on `dev:reset`, `dev:prune` and start-up pruning, matching the
service alone. It runs only on macOS, only when the stored title is the one
that id gets, and only for the profile under the default development root.
Each `security` call is bounded to 15 s, and any answer other than "deleted"
or "not found" (exit 44) becomes a warning that does not fail the removal.

The account cannot be part of the match. Electron 45.2.3 names it
`<electronTitle> Key`; earlier builds used `<electronTitle>`. The code
first shipped (to-do 0023, retired) matched the old account, so every reset
reported success and left the item behind.

Checked live on 2026-11-13 on macOS 27.2 (26B123, arm64) with Electron
45.2.3, with throwaway profile `qa-keychain-0023-125021`. Its item was
created by real Electron with `app.setName(<title>)` (as `main.ts` does) and
`safeStorage`, without the full app, because a fresh development profile's
first start waits on the platform chooser and the macOS privacy prompts.

- Before the fix, `mise run dev:reset --profile <id>` exited 0, printed no
  Keychain text and no warning, and left the item.
- After it, the reset printed `Removed 1 login Keychain item(s).`, and
  `security find-generic-password -s "<title> Safe Storage"` exited 44.
- No macOS prompt appeared at any step.

To check by hand:

```bash
security find-generic-password -s "Orkestrator AI — DEV [<id>] Safe Storage"  # exit 0, attributes only
mise run dev:reset --profile <id>                                             # "Removed 1 login Keychain item(s)."
security find-generic-password -s "Orkestrator AI — DEV [<id>] Safe Storage"  # exit 44
```
