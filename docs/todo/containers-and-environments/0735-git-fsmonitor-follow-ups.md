# Git fsmonitor: live evidence, orphaned daemons and other hosts

Checked against `main` at `68c84506c` (2026-10-28).

Orkestrator no longer turns on git's fsmonitor daemon. It removes the setting
it wrote to older worktrees, stops a worktree's daemon before removing or
moving it, and retries timed-out status and diff reads without the daemon. The
design and the arktech-mini evidence are in
[git-scan-caches.md](../../architecture/git-scan-caches.md). This file holds
what that change could not prove or did not cover.

## Current state

- `enableGitScanCaches` writes only `core.untrackedCache=true`.
- `removeLegacyWorktreeFsmonitor` unsets a linked worktree's own
  `core.fsmonitor=true` and stops its daemon on the first diff-stats pass per
  backend process.
- The cleanup ledger's `worktree` step, `removeLocalWorktree`,
  `cleanupFailedLocalWorktree` and a move's quiesce step stop the daemon first.
- Diff stats, the project home's status, the review package status, the
  validation worker's drift check and the fingerprint probe retry once with
  `-c core.fsmonitor=false` after a timeout.
- The Node test preload sets `core.fsmonitor=false` in the isolated global
  config. `git-fsmonitor.test.ts` covers all of the above with real git, except
  the timeout fallback, which uses an injected timeout.

## Outstanding work

### Code

- [ ] **Daemons already orphaned.** A daemon whose worktree was deleted before
  this change is stopped by nothing: there is no path left to send `stop` to.
  They exit on reboot. Decide whether a one-off sweep is worth it (the watched
  path is not on the daemon's command line; `lsof` on its IPC socket finds it)
  or record that a reboot is the answer.
- [ ] **Other git calls have no fallback.** Only the reads listed above retry.
  Any other git call against a worktree whose user enabled fsmonitor still
  waits for its own timeout and then fails.

### Qualification

- [ ] **arktech-mini after upgrade.** With the new backend on the real data
  directory, confirm that existing environment worktrees lose
  `core.fsmonitor` from `config.worktree` after their first diff-stats pass,
  that their daemons exit, and that a git call in one is back to about 0.1 s.
  Count `git fsmonitor--daemon` processes before and after.
- [ ] **Other hosts.** Measure per-call git latency with and without
  fsmonitor on an internal APFS volume, Linux and Windows. If a large
  repository shows a real win, revisit an opt-in setting.
- [ ] **A real hung daemon.** The fallback has not been seen recovering from
  one. Capture timings if it recurs.

## Constraints and rationale

- Removed, not made opt-in: no existing per-project git-tuning setting fits,
  and an opt-in that is slow on the main host would be a trap.
- Migration touches only the linked worktree's own `config.worktree`, by
  explicit path, and only the exact value Orkestrator wrote (`true`).

## Open questions

- Whether a user-level fsmonitor (in `~/.gitconfig`) should also be overridden
  for Orkestrator's own reads, the way `change-tracking/capture.ts` already
  does. Today only timeouts trigger that.

## Needs verification

- The 1.1 s penalty was measured on one host only.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)

## Replaces

Numbered 0734 on its branch until `main` took 0734 for the Codex MCP
handshake todo; renamed before merge.
