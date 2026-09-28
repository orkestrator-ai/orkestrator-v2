# Disk usage from Orkestrator work

Environments, dev profiles, agent sessions, test runs and image builds all
write to disk outside the repository. This page lists where that state
collects, what prunes it, and what to run when a machine fills up. The design
and the evidence behind it are in
[orphaned-disk-state-cleanup.md](../plans/orphaned-disk-state-cleanup.md).

## See what is using space

```bash
mise run disk:report          # table: location, size, orphaned entries, owner, cleanup
mise run disk:report -- --json
```

The report is read-only. It needs no root access, so Docker's own directory is
measured through `docker system df` rather than walked.

## What prunes itself

| Location | Pruned by | When |
| --- | --- | --- |
| `<main checkout>/.turbo/cache` (shared by every worktree) | Turborepo, `cacheMaxAge` 7 days and `cacheMaxSize` 10 GB in `turbo.json` | Start of each `turbo run` |
| `~/.config/orkestrator-v2-dev/profiles/*` (Linux; `~/Library/Application Support/orkestrator-v2-dev` on macOS) | `dev`/`dev:test` start | Stopped profiles whose checkout no longer exists |
| Worktrees a dev profile registered in an outside repository | `dev:reset`, `dev:prune`, start-up pruning | With the profile; branches only when merged |
| `orkestrator-v2:dev-<hash>` images of a deleted checkout | Start-up pruning, `dev:prune` | With the last profile that used them |
| Per-environment bridge state, worktrees, local branches | Environment deletion and its reconciler | See [environment-deletion-cleanup.md](../plans/environment-deletion-cleanup.md) |
| Empty workspace directories, merged branches of deleted environments, abandoned store temp files | Backend start-up sweep | At start-up; branches at most daily per project |
| Test temporary directories in the system temp dir | The next test run | Once the creating process has exited and the directory is over an hour old |
| Managed agent toolchains | `toolchain-manager.ts` | Superseded versions after 14 days |

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

## Commands

```bash
mise run dev:prune --dry-run            # list profiles that would be removed
mise run dev:prune                      # remove stopped profiles whose checkout is gone
mise run dev:prune --older-than 14      # ... and stopped profiles idle for 14 days
mise run dev:prune --force              # explicitly discard changes in linked worktrees
mise run dev:reset --profile <name>     # remove one stopped profile (--stop-first stops it)
```

`dev:prune` never touches a running profile, a directory without a valid
profile sentinel, or a `profile.json` that describes another directory.
Automatic pruning and ordinary `dev:prune` keep a profile if a linked worktree
has modified or untracked files. Inspect the reported path before using
`dev:prune --force` or `dev:reset`, which can discard those files.
