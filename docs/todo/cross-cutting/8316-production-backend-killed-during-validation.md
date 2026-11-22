# Production backend killed during agent-run validation

## Task analysis

Analysed 2026-11-22 against `main` at `af78acfbf`. From the self-improvement
ticket for `backend:crashed` (digest 20261122T183223Z-99f9081d), which counted
two backend runs on omarchy-hp that ended without a clean-exit marker on
2026-11-15.

### Tasks

1. **Name the process that SIGKILLed the production backend on omarchy-hp**: an audit trail during a heavy validation plan. Status: open (needs the user's `sudo`; item in 7568).
2. **Keep validation commands out of the production backend's reach on Linux**: decide whether to run them in their own PID namespace. Status: open (depends on 1).

### 1. Name the process that SIGKILLed the production backend on omarchy-hp

**Problem.** On 2026-11-15 at 21:26:31 UTC the production backend on
omarchy-hp (app 2.38.2-beta) died with `SIGKILL` while its desktop survived.
The next start logged `previous-run outcome=crashed ranForMs=600304`. The same
thing happened three times on 2026-10-26, and the sender was never named.

**Context.** The app log (`~/.config/orkestrator-v2/logs/orkestrator-ai-2026-11-15.log`)
has `[desktop] backend.exited … signal SIGKILL` at 21:26:31.422 and nothing
from the backend in the seven minutes before it. The kernel journal has no OOM
kill. A build pipeline's review had submitted its validation plan at 21:19:00
in workspace `orkestrator-v2-20261115-154953-c67437548ea4`: `mise run
test:full`, `test:browser`, `test:agent:electron`, `test:package:security`
and `test:agent:browser:isolated`, run together as descendants of the
production backend. `coredumpctl` on omarchy-hp lists, all in the production
app's own cgroup (`app-orkestrator\x2dv2-4721.scope`):

- 21:26:30, one second before the kill: a Playwright Chromium
  (`/usr/lib/chromium/chromium --disable-field-trial-config …`) aborted
  itself (SIGABRT, `SI_TKILL`).
- 21:26:46, 21:27:07 and 21:27:24: three packaged `orkestrator-v2` processes
  from that workspace's `release/linux-unpacked`, launched by Playwright
  (`--ozone-platform=headless --disable-gpu --inspect=…`), died with SIGTRAP,
  each after another Playwright Chromium aborted.

A packaged Electron dies with SIGTRAP when its launcher dies under it
([process-crashes-and-kills.md](../../debugging/process-crashes-and-kills.md#5-headless-dev-profile-electron-sigtrap)),
which fits those dumps following the kill rather than causing it; the Chromium
abort just before it is unexplained. The workspace no longer exists, so its
test output cannot be read.

**Investigation.** The desktop spawns the backend without `detached`
(`apps/desktop/electron/backend-process.ts`), so the backend is in Electron's
process group. Electron survived, so the signal named the backend's pid, not
its group. The backend's own kill paths signal only their own children or
detached groups (`process-tree.ts`, `review/validation-worker.ts`), and the
stale-bridge reaper requires a positive identity before it signals
(`local-server-reaper.ts`). No test or script in the repository resolves a pid
from a port (`lsof`, `fuser`, `ss`). Linux does not record who sends a signal,
so only an audit rule can name the sender: the rules are in
[testing-guide.md](../../development/testing-guide.md#production-orkestrator-shares-this-host)
and [process-crashes-and-kills.md](../../debugging/process-crashes-and-kills.md#3-catching-the-sender-of-a-signal-needs-root).

**Decisions.**

- **How to catch the sender.**
  - **Audit rules on omarchy-hp while a pipeline runs the same plan (recommended).**
    - Pros: names the sender's pid, parent and command line; costs nothing until it fires.
    - Cons: needs `sudo` from the user, and the rules go at a reboot.
  - **Reproduce on purpose in a disposable environment with the same plan.**
    - Pros: no waiting for a recurrence.
    - Cons: the kill takes down every agent session on the host, including the one running it, and it has been seen only four times (three on 2026-10-26, one on 2026-11-15), so a run that does not reproduce it proves little.

### 2. Keep validation commands out of the production backend's reach on Linux

**Problem.** Every command a validation plan runs is a descendant of the
production backend and runs as the same user, so any of them can signal it.
The rules in the testing guide bind authors, but a single test that breaks
them ends every agent session on the host.

**Context.** `review/validation-worker.ts` spawns each command `detached`
with `bash -lc`. Containers already isolate agents that run in them; local
worktree environments do not.

**Investigation.** A process in a child PID namespace cannot name a pid
outside it, so a validation command started under `unshare --user --pid
--fork --mount-proc` could not reach the backend by pid. That changes what
the commands see (`/proc`, `ps`, pid files written by host services such as
Docker's), and the tests that check processes they spawned would see
namespace pids. Not tried.

**Decisions.**

- **Whether to isolate.**
  - **Decide after task 1 names the sender (recommended).**
    - Pros: a fix aimed at a named bug is smaller and certain.
    - Cons: the backend stays exposed until then.
  - **Run validation commands in their own PID namespace on Linux now.**
    - Pros: covers senders not yet found.
    - Cons: needs unprivileged user namespaces, changes `/proc` for every test, and does nothing on macOS.

## Current state

The other ending the digest counted was not a backend failure: omarchy-hp
itself stopped at about 16:23 UTC on 2026-11-15 (the boot's journal ends with
no shutdown record, and the machine booted again at 21:12), so its 38.5-hour
backend run could not write a marker. Since that fix, a backend records the
host's boot time on its `started` health row and reports such a run as
`previous-run outcome=host-restarted`, which self-improvement counts as
`backend:host-restarted` instead of `backend:crashed`
([logging.md](../../architecture/logging.md#health-summary-and-the-clean-exit-marker)).

## Needs verification

- After the release that carries the boot time, a host that loses power or is
  forced off logs `previous-run outcome=host-restarted` on its next start,
  and the digest shows `backend:host-restarted`. Self-improvement checks the
  `backend:crashed` rate on that release by itself.

## Related

- [process-crashes-and-kills.md](../../debugging/process-crashes-and-kills.md)
- [testing-guide.md, Production Orkestrator shares this host](../../development/testing-guide.md#production-orkestrator-shares-this-host)
- [self-improvement.md](../../architecture/self-improvement.md)
