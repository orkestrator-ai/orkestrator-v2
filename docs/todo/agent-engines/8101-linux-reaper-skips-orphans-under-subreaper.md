# On Linux the reaper skips a killed backend's orphan that a subreaper adopted

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Reap an orphaned local server whose new parent is a subreaper, not a backend**: on Linux a killed backend's servers are adopted by `systemd --user`, which the startup reaper reads as a live owner. Status: open.

### 1. Reap an orphaned local server whose new parent is a subreaper, not a backend

**Problem.** `reapOrphanedLocalServers` (`apps/backend/src/core/local-server-reaper.ts`) skips a recorded server as `skipped-live-owner` when its parent PID is above 1 and alive, meaning another backend sharing the data directory owns it. On a Linux desktop session an orphan is not reparented to PID 1 but to the session's subreaper, `systemd --user`, which is always alive. So after a backend is killed, the next backend never reaps that backend's servers: it keeps the stale record, starts a new server and overwrites the record, and the old process runs on with nothing tracking it.

**Context.** The bridges are not affected in practice: each watches `ORKESTRATOR_PARENT_PID` (`@orkestrator/protocol` `parent-watchdog.ts`) and drains itself. `opencode serve` is the one reapable server with no watch of its own. Since 2026-11-14 the backend's host OpenCode plugin carries the same watch (`OPENCODE2_PARENT_WATCH_SOURCE` in `apps/backend/src/core/opencode2/server.ts`, 8045 (retired)), but 2.2.6 loads a plugin only when a location first runs a turn, so a server that never ran a turn is still left running. On macOS an orphan goes to `launchd` (PID 1), so the reaper works there, which is why 8045 was reproduced on a Mac without this.

**Investigation.** Found on 2026-11-14 on beelink2 (Linux x86_64) while turning on the OpenCode target of `suborks-restart-live.spec.ts`. Before the plugin watch, the killed backend's `opencode serve` was still alive after the profile restarted: it read the scripted model's answer to the held request (the fake counted one abandoned request where it expected two), so two OpenCode servers ran on the same database. A plain `sh -c 'sleep 5 &'` on the same host showed the orphan's parent as `/usr/lib/systemd/systemd --user` (PID 1069). With the plugin watch the spec passed (both held requests abandoned, both targets finished on the continuation).

**Decisions.**

- **How should the reaper tell a subreaper from a live owner?**
  - **Count the parent as an owner only when it looks like a backend: read its command line and require the backend's own markers, as the reaper already does for the server itself (recommended).**
    - Pros: fixes every server kind at once, macOS behaviour unchanged; the reaper already has `readProcessIdentity`.
    - Cons: needs the backend's command line pinned for each way it runs (Electron's backend child, `dev:test`, the CLI's `serve`); a wrong marker set either skips a real orphan (today's behaviour) or reaps a live owner's server, so it needs tests for each launcher.
  - **Record the owning backend's PID and start time beside each server PID, and count only that process as its owner.**
    - Pros: exact; independent of command lines.
    - Cons: a storage field per server kind and a migration; a record written before the change still needs the old rule.
  - **Rely on parent watches only (add one to anything without).**
    - Pros: no reaper change.
    - Cons: OpenCode's watch arms only after a turn, so an idle orphan still leaks; the reaper stays wrong for any future server.

## Related

- 8045 (retired): the restart case this was found in; its final state is in Git history at `dc90609bf`.
- [Background work and transport invariants](../../../AGENTS.md#background-work-and-transport-invariants), invariant 15.
