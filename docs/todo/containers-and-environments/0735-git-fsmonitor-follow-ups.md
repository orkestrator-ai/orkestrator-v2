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
- `removeLegacyWorktreeFsmonitor` unsets an application-owned linked worktree's
  `core.fsmonitor=true` and stops its daemon. Project homes, including linked
  user checkouts, are excluded. Successful attempts are cached per backend
  process; failures can retry on later diff-stats passes.
- The cleanup ledger's `worktree` step, `removeLocalWorktree`,
  `cleanupFailedLocalWorktree` and a move's quiesce step stop the daemon first.
- Diff stats, the project home's status, the review package status, the
  validation worker's drift check and the fingerprint probe retry once with
  `-c core.fsmonitor=false` after a timeout.
- The Node test preload sets `core.fsmonitor=false` in the isolated global
  config.

## Automated coverage

- `git-fsmonitor.test.ts`: preload and scan-cache settings, worktree-only
  migration, preservation of main/shared/user config and a linked project home,
  daemon shutdown (real builtin daemon where supported), concurrent and
  once-per-process migration, retries after rev-parse/config read/unset failures,
  status/diff and project-home toolbar fallback wiring, non-timeout failures,
  cancellation and second-attempt failures. Host timeout paths inject a
  structured timeout; the Git repositories and fallback reads are real.
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
`mise run test:logged`.

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

- [ ] **Windows process cleanup.** Qualify the fingerprint probe's bounded
  `taskkill /t /f` branch on Windows; blocking-hook process-group regressions
  currently run on POSIX hosts.

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
- Migration requires established application ownership, excludes project homes,
  and touches only the linked worktree's own `config.worktree`, by
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
