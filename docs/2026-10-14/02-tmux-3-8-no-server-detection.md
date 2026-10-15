# tmux 3.8 "no server" is treated as failed cleanup

Status: Fixed — 2026-10-15. Cleanup, session stop, reconciliation and startup
reaping use `confirmTmuxSessionGone` in `tmux-shared.ts`. A missing socket
alone is not evidence that sessions exited. On connection failures, a successful
process census must also show no tmux processes before attribution is removed.
Real private-socket lifecycle tests cover a never-started server and a live
server with its socket unlinked, including move refusal and retry after exit.

**Correction to the root cause below.** tmux did not change its wording.
Checked on tmux 3.8 with a private socket, and in `client.c` (unchanged
since at least 3.5a):

| Situation | tmux prints |
| --- | --- |
| A server ran and exited; its socket file is left over | `no server running on <socket>`, which was already matched |
| No server has used the socket since `/tmp` was last cleared, as after a reboot | `error connecting to <socket> (No such file or directory)` |
| A server is still running but its socket file was deleted | the same `error connecting to … (No such file or directory)` |

This host printed the second form because `/private/tmp/tmux-501/default`
did not exist; no tmux server was running. The bug therefore probably
affects any tmux version until tmux is first started after a reboot, not
only 3.8. (`Connection refused` is never printed in the `error connecting
to` form; it is matched anyway.)

The initial diagnostic-only fix allowed moves while an unreachable live server
still ran in the old worktree and deleted the roots needed for later cleanup.
The process check closes that gap. Without a saved server identity, any tmux
process in the host/container process namespace makes absence ambiguous,
including an unrelated server or transient client. Cleanup then remains
incomplete, moves fail, and runtime roots and failed managed sessions remain
available for retry. No process is signalled by this check. A never-started
server or reboot with no tmux processes still permits cleanup. An unreadable,
failed or malformed process census fails closed.

**Severity: high.** On a host with tmux 3.8 and no tmux server running,
moving a local environment fails, and deleting one leaves Claude Tmux runtime
files behind.

## Symptom

`apps/backend/src/core/environment-move.test.ts` fails 22 of 34 cases with:

```
error: claude-tmux cleanup incomplete for environment <id>
```

It fails identically on the base commit `d4dfa11d` (12 pass / 22 fail on both),
so this predates the OpenCode boundary branch. The aggregate suite also logs
`[backend] claude-tmux cleanup failed during environment deletion` from the
deletion tests.

## Root cause

tmux changed its "no server" wording. On this host (Homebrew tmux 3.8, no
server running):

```
$ tmux list-sessions -F '#{session_name}'
error connecting to /private/tmp/tmux-501/default (No such file or directory)
$ echo $?
1
```

Older tmux printed `no server running on …` or `failed to connect to server`.
Three matchers recognise only the old wording:

| Location | Effect of the miss |
| --- | --- |
| `apps/backend/src/core/tmux-session-manager.ts:1589-1594` (`killEnvironmentTmuxSessions`) | Returns `complete: false`, so `cleanupEnvironmentTmux` throws `claude-tmux cleanup incomplete`. |
| `apps/backend/src/core/local-server-reaper.ts:111-118` | Rethrows instead of returning `[]`, so startup reaping preserves runtime roots and retries on every start. |
| `apps/backend/src/core/tmux-shared.ts:116-124` (`isMissingTmuxSessionError`) | A kill that races a server exit is counted as a failure instead of "already gone". |

## User impact

- **Environment move** (`apps/backend/src/core/environment-move.ts:378`) calls
  `cleanupEnvironmentTmux(..., { requireStopped: true })` and propagates the
  error, so the move is refused for anyone on tmux 3.8 who has no tmux server
  running. That is the common case for users who do not use Claude Tmux.
- **Environment deletion** (`apps/backend/src/core/commands-servers.ts:1629`)
  catches and logs the error, so deletion completes. But
  `cleanupEnvironmentTmux` skips removing the settings backup and the runtime
  hook root when cleanup is "incomplete" (`tmux-commands.ts:182-187`), so those
  files are left behind.
- **Startup reaping** never clears stale runtime roots on these hosts.

## Fix

1. `isTmuxNoServerMessage` classifies connection diagnostics only.
   `isMissingTmuxSessionError` accepts explicit missing-session replies;
   `confirmTmuxSessionGone` additionally checks process absence for unavailable
   servers. All destructive connection-error paths use the asynchronous check.
2. Timeouts, missing executables, permission errors and failed process probes
   remain incomplete. Process probes read only PID and executable names, never
   user command arguments.
3. Unit tests cover diagnostics and census failures. Lifecycle tests use real
   tmux servers on private sockets and scope their injected process census to
   the fixture's PID so parallel tests and developer servers cannot interfere.
   They check stop, cleanup, move, reconciliation and startup root retention,
   followed by successful cleanup after proven exit.

The flake index has no entry for this, correctly: it fails deterministically.
The only `environment-move.test.ts` entry, 0201, is an unrelated, resolved
fixture race.
