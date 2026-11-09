# Container terminal shells outlive a backend exit

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`, while doing
[7081](7081-container-claude-cli-tab-leftovers.md) tasks 1 and 2 on beelink
(rootful Docker Engine 29.9.2).

### Tasks

1. **End a container's orphaned terminal shells after a backend exit**: when a backend exits without closing its container terminals (a quit with tabs open, a crash, an update restart), their shells and programs, a Claude CLI tab's `claude` included, keep running in the container until it stops. Status: done (2026-11-09).

### 1. End a container's orphaned terminal shells after a backend exit

**Problem.** Since 7081 task 1, closing a container terminal ends its shell in
the container. That close is triggered by the backend dropping the terminal's
PTY. A backend that exits never drops them: `BackendRuntime.shutdown` clears
only the terminal runtime's timers, and the host `docker exec -it` clients die
with the backend's PTY masters, which Docker does not pass on to the exec. The
next backend reopens each tab with a new shell, so every quit or restart with
container terminals open leaves one more shell, and whatever it was running,
in each container.

**Context.** Each shell carries a random per-PTY token in
`ORKESTRATOR_TERMINAL_SESSION` and records its PID as
`/tmp/orkestrator-terminals-<uid>/<token>.pid`
(`CONTAINER_TERMINAL_PID_RECORD_COMMAND` in
`apps/backend/src/core/container-scripts.ts`); the close is
`CONTAINER_TERMINAL_CLOSE_SCRIPT`, run by `closeContainerTerminalShell`
(`container-terminal-shell.ts`). Tokens live only in the backend's memory
(`TerminalRuntime.recordContainerShell`), so a new backend cannot name the old
shells. The records survive, and each shell start already sweeps records whose
PID no longer carries its token, but it leaves live ones alone. The behaviour
is described in
[container-lifecycle.md](../../architecture/container-lifecycle.md#terminal-close).

**Investigation.** Originally read from the code on 2026-11-06. Implemented and
reproduced with Docker Desktop 29.9.2 on mini on 2026-11-09.
`apps/backend/src/core/backend-runtime.ts` `shutdown()` calls
`terminals.shutdown()`, which clears timers and aborts in-flight closes but
kills no PTY. Local terminals do not have this problem: their PTYs are the
shells, and they end with the backend.

**Decisions.**

- **How should a new backend find the old shells?**
  - **Prefix each token with a per-process backend instance id, and have a shell start (or the backend's first terminal into a container) close every live record whose prefix is not the current one (recommended).**
    - Pros: needs no persisted state; a container belongs to exactly one backend (owner label), so a different prefix always means an orphan; reuses the close script.
    - Cons: a long job a user left running in a tab is ended at the next terminal start rather than at the container's stop, which changes behaviour users may rely on; the prefix must stay shell-safe for the close script's token check.
  - **Close every container terminal on an orderly backend shutdown.**
    - Pros: simplest; matches what a closed tab already does.
    - Cons: misses crashes and SIGKILLs; adds one `docker exec` per open terminal to shutdown, which is bounded by Electron's quit deadline.
  - **Persist tokens with the terminal history and close them at the next start.**
    - Pros: exact; covers crashes.
    - Cons: durable state for something the records already hold; needs a migration and a cleanup path.

## Assumptions and decisions

### Task 1: process-prefixed tokens and startup reaping

Chose the recommended UUID instance prefix plus `--` plus per-shell UUID.
All characters pass the existing close script's hexadecimal-and-dash check.
The startup sweep invokes that exact script in a subshell for each different
prefix, including legacy unprefixed tokens; same-instance shells are preserved.
The sweep is per uid, matching PID-directory ownership and the existing root
boundary. It closes orphans when a new shell starts, covering crashes as well
as orderly exits without extending the shutdown deadline.

A long job in an orphaned tab now ends at the next terminal start for that uid
rather than at container stop. The existing SIGHUP semantics remain: detached
sessions and programs explicitly ignoring HUP survive.

Measured live with `ORKESTRATOR_TEST_TERMINAL_IMAGE=orkestrator-v2:dev-753752826dcb
mise run test:logged -- --name terminal-orphan-docker -- bun test --cwd
apps/backend ./tests/container-terminal-orphan-docker.test.ts --parallel=1
--only-failures`: passed, one test. The fixture starts a real BackendRuntime
and Docker PTY in one Bun process, exits it, proves its shell and `sleep` still
live, then starts a second process and terminal. Both old processes disappear;
a further terminal from the second process preserves its first shell and job.
No provider turns, host mounts or bound ports. The exact fixture container and
Bun processes were removed through their owned handles.

Unit coverage also checks the shell-safe shared prefix and unique suffixes;
Linux `/proc` cases cover legacy/current/orphan records and PID reuse. The live
container case exercises those scripts on mini, where host `/proc` is absent.

## Related

- [7081-container-claude-cli-tab-leftovers.md](7081-container-claude-cli-tab-leftovers.md) (the close this extends).

## Replaces

- Number 7520, renumbered on 2026-11-06. Three pull requests merged a 7520 the same day; the earliest to merge, [7520](../agent-engines/7520-message-rewind-and-branch-switch-have-no-client-surface.md) (#1957), kept it.
