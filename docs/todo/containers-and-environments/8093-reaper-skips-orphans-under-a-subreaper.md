# The local-server reaper skips orphans reparented to a subreaper

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Reap a crashed backend's bridges on hosts with a subreaper**: on Linux under a systemd user manager, an orphaned local bridge is reparented to `systemd --user`, so the reaper reads it as owned by a live backend and never stops it. Status: open.

### 1. Reap a crashed backend's bridges on hosts with a subreaper

**Problem.** A backend that dies without its shutdown path (crash, SIGKILL)
leaves its local bridges running. `local-server-reaper.ts` is meant to stop
them at the next startup, but it skips any recorded PID whose parent is a
live process other than PID 1 (`identity.parentPid > 1 &&
isPidAlive(identity.parentPid)`, recorded as `skipped-live-owner`), on the
grounds that another backend sharing the data directory owns it. On a Linux
desktop the user's `systemd --user` is a child subreaper, so every orphan of
a process in that session is reparented to it rather than to PID 1. The
orphan then looks owned forever: nothing stops it, deleting its environment
does not either (the new backend never tracked it), and `dev:stop` and
`dev:reset` of an agent-test profile leave it running.

**Context.** The reaper's safety rules (marker match, orphaned, group leader)
are in the header of `apps/backend/src/core/local-server-reaper.ts`; each
prefers leaking a process to killing someone else's. To-do 8045 saw the
reaper stop an orphaned `opencode2 serve` on macOS, where orphans go to
launchd (PID 1).

**Investigation.** Seen on beelink (Arch Linux, systemd 258 user session) on
2026-11-14 during to-do 5160 task 4's OpenCode `restart` case
(`failed-turn-bell-live.spec.ts`), which SIGKILLs a throwaway profile's
backend under a held turn. An `opencode2 serve` started at 03:31:02, from that
profile's toolchain with its working directory in the turn's environment
worktree, was still running at 04:13 after the environment was deleted and
the profile stopped and reset. Its parent was PID 1063,
`/usr/lib/systemd/systemd --user`. It was stopped by hand after its identity
was checked. Which backend started it (the one killed, or one the profile's
Electron supervisor brought back before `dev:stop`) was not established.
Claude, Codex and Pi bridges left no such process in the same runs; they run
under a lifetime wrapper that ends the bridge when its stdin closes.

**Decisions.**

- **How to tell a subreaper's orphan from a live backend's bridge?**
  - **Treat the parent as an owner only when its command line is an Orkestrator backend (the same marker approach the reaper uses for bridges), so a parent that is the session's subreaper counts as orphaned (recommended).**
    - Pros: keeps the live-owner protection for the case it exists for (two backends on one data directory); fixes every Linux desktop.
    - Cons: needs the backend's own markers to be stable across packaging (development, packaged app, `orkestrator` CLI service).
  - **Run OpenCode under the same stdin lifetime wrapper as the bridges.**
    - Pros: the orphan never outlives its backend, whoever its parent is.
    - Cons: covers only what is wrapped; a wrapped process killed with its wrapper still leaves the reaper's blind spot for anything else.
  - **Read `/proc/<pid>/status` for the parent's `PR_SET_CHILD_SUBREAPER` role.**
    - Pros: exact on Linux.
    - Cons: Linux-only and not exposed directly; needs a heuristic anyway.

## Related

- [5160](../cross-cutting/5160-silent-failures-live-evidence.md) task 4, where this was found.
- [8045](../agent-engines/8045-opencode-turn-cut-by-backend-restart-stays-busy.md), whose run saw the reaper work on macOS.
