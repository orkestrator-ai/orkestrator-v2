# tmux 3.8 "no server" is treated as failed cleanup

Status: Fixed — 2026-10-15. All three sites now use `isTmuxNoServerMessage`
in `tmux-shared.ts`. Since #967, `environment-move.test.ts` stubs
`list-sessions`, which hid this failure; the stub now returns the
absent-socket message. Run against real host tmux 3.8, the suite fails 23 of
35 cases without the fix and passes all of them with it.

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

The fix reverses #967's choice to fail closed on the absent-socket message,
because that choice refused every move after a reboot. The remaining risk
is the third row. Orkestrator cannot reach or kill those sessions anyway,
but a move then goes ahead while they still run in the old worktree, and
their runtime roots are removed, so a later reaper cannot attribute them if
the socket is restored (`pkill -USR1 tmux`). A process check before trusting
the message would close that gap if it ever matters.

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

1. Put one shared predicate in `tmux-shared.ts`, for example
   `isTmuxNoServerMessage(text)`. It should match the old wordings and the 3.8
   form: `error connecting to <socket> (No such file or directory)`, and
   probably `(Connection refused)` for a stale socket. Use it from all three
   sites.
2. Keep the existing rule that a timeout, missing executable or any other
   unexpected failure is **not** "no server". Only ENOENT or ECONNREFUSED on
   the socket counts as no server.
3. Tests: add the tmux 3.8 stderr string to the unit tests for each site.
   `environment-move.test.ts` should then pass on tmux 3.8 hosts. Today it can
   only pass where tmux prints the old wording or a server is running.

The flake index has no entry for this, correctly: it fails deterministically.
The only `environment-move.test.ts` entry, 0201, is an unrelated, resolved
fixture race.
