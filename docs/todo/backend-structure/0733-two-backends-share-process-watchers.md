# Two backends in one process share the OOM watcher, the login refreshers and the container log service

Checked against `main` at `863b5782` (2026-10-27).

When two `OrkestratorBackend` instances run in one process at the same time,
the second backend's OOM watcher is never started for its own containers. The
Claude and Codex login refreshers are registered last-writer-wins, and the
container log service is one per process. Whichever backend shuts down first
stops the watcher and the log followers and clears the refreshers for both.
Production and `dev:test` run one backend per process, so today only a test
that overlapped two backends could hit this, and no current test does. Found
in the task analysis of
[0133-backend-module-state-beyond-0066.md](0133-backend-module-state-beyond-0066.md#3-move-the-other-per-backend-rows).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the interference with a failing two-backend test**: add cases to `backend-runtime.test.ts` (or `index.test.ts`) that fail today. Status: open.
2. **Make the OOM watcher per backend**: own it from the backend instance or `BackendRuntime`, not a module variable. Status: open.
3. **Make the login refreshers per backend**: hold the three refreshers where each backend's callers reach their own. Status: open.
4. **Make the container log service per backend**: the same pattern, a row 0133 does not list. Status: open.

### 1. Pin the interference with a failing two-backend test

**Problem.** Nothing proves the shutdown interference, so a fix would have no regression test.

**Context.** `apps/backend/src/core/backend-runtime.test.ts:67` ("two BackendRuntimes in one process") has eight cases for state already moved by 0011 and 0066. 0133 task 5 asks for a two-backend case per moved row, including independent shutdown.

**Investigation.** No test runs two backends at once. `index.test.ts:1385-1435` builds a second backend only after the first has shut down, and every other test file that constructs `OrkestratorBackend` uses one at a time. The OOM watcher spawns `docker events` (`apps/backend/src/core/container-oom-events.ts:49-56`), so its test needs the watcher's `spawn` seam, as `apps/backend/tests/container-oom-events.test.ts` already uses.

**Decisions.**

- **At what level is the test written?**
  - **Two `OrkestratorBackend` instances on separate temporary data directories, started together, with docker and refresh stubbed; shut down the first and assert the second still counts OOM events and still refreshes (recommended).**
    - Pros: tests the real `init()`/`shutdown()` wiring in `core/index.ts`, which is where the bug is.
    - Cons: a heavier test; needs the startup reapers and docker stubbed, as `index.test.ts:1386-1397` does.
  - **Unit tests on the module functions only (`startOomEventWatcher` twice, `setLocalCodexLoginRefresher` twice).**
    - Pros: fast and small.
    - Cons: they test the current module shape, which the fix removes, so they would be rewritten anyway.

### 2. Make the OOM watcher per backend

**Problem.** `startOomEventWatcher(owner)` keeps one watcher per process and ignores later owners.

**Context.** The file's own header says "One `docker events` follower per backend" (`container-oom-events.ts:11`), but the code holds one per process.

**Investigation.** Confirmed in code.
- `let watcher` is module state (`container-oom-events.ts:130`). `startOomEventWatcher` returns early if one exists (`:133-134`), so a second backend's `owner` label filter (`dockerOwnerNamespace(dataDir)`, `apps/backend/src/core/docker-ownership.ts:9-11`) is never used.
- `containerOomEvents` (`:140-142`) answers from that one watcher. It returns `0`, not `null`, for any container it has not seen (`:72-78`). So the second backend reports "no OOM kills" for its own containers instead of "unknown", which is a wrong value rather than a missing one.
- `OrkestratorBackend.init()` starts it (`apps/backend/src/core/index.ts:1378`) and `shutdown()` stops it for everyone (`:2129`). The one reader is `container-resources.ts:425`.

**Decisions.**

- **Who owns the watcher?**
  - **`BackendRuntime`, started from `init()` with the owner and stopped from `shutdown()`, with readers going through `context.runtime` (recommended).**
    - Pros: matches 0133's suggested owner and the rules in `backend-runtime.md`; the `spawn` seam becomes a construction option.
    - Cons: `container-resources.ts` must reach the context at that call site.
  - **Keep a module map keyed by owner, started and stopped per owner.**
    - Pros: a small change; no new runtime member.
    - Cons: still module state, so the 0066 pattern is not followed; two backends sharing one data directory would still collide.

### 3. Make the login refreshers per backend

**Problem.** The three login refresh hooks are module variables. A second backend's registration replaces the first's, and either backend's shutdown clears them all.

**Context.** The backend registers `setHostClaudeLoginRefresher` and `setLocalClaudeLoginRefresher` around its own `ContainerClaudeLoginKeeper`, and `setLocalCodexLoginRefresher(createCodexLoginRefresher(this.context))` (`core/index.ts:1408-1420`). It clears all three in `shutdown()` (`:2124-2126`). 0133 lists only the two in `agent-accounts-active.ts`. The host Claude refresher is in `agent-accounts-containers.ts` and is not in 0133's table.

**Investigation.** Confirmed in code.
- `localClaudeLoginRefresher` (`apps/backend/src/core/agent-accounts-active.ts:285-291`) is read by `readUsableClaudeLogin` (`:310-330`). `localCodexLoginRefresher` (`:483-487`) is read by `readCoordinatorCodexLogin` (`:468-481`). `hostClaudeLoginRefresher` (`apps/backend/src/core/agent-accounts-containers.ts:948-952`) is read by `freshContainerClaudeCredentials` (`:955-966`).
- With two live backends, the first backend's callers use the second backend's keeper and context, so they may refresh the wrong account home. After either shuts down, neither refreshes on demand. The keepers' own periodic passes keep running, so the visible effect is a coordinator or container start that finds a lapsed token and starts signed out until the next pass.
- Under `runtimeFlavor: "agent-test"` both on-demand paths are already inert (`agent-accounts-active.ts:323`, `apps/backend/src/core/codex-host-login-refresh.ts:23`), so `dev:test` would not show this even with two backends.

**Decisions.**

- **Where do the refreshers live?**
  - **On the backend's context (a `loginRefreshers` member of `BackendRuntime` or `CommandContext`), passed to the three readers (recommended).** `readUsableClaudeLogin` and `freshContainerClaudeCredentials` already take a context. `readCoordinatorCodexLogin` gains one; it has three callers.
    - Pros: each backend reaches its own keeper; shutdown clears only its own; the setters and the test resets in `agent-accounts-active.test.ts` go away.
    - Cons: a signature change across eight call sites in accounts code.
  - **Keep the setters but have each return an unregister function that clears only its own registration.**
    - Pros: tiny change; shutdown no longer clears the other backend's hook.
    - Cons: still last-writer-wins while both run, so the first backend keeps using the second's keeper.

### 4. Make the container log service per backend

**Problem.** `containerLogService()` creates one service per process on first use, and `shutdownContainerLogService()` stops every follower in it.

**Context.** Not listed in 0133 or in `docs/architecture/backend-runtime.md`. Found while checking the shutdown sequence for this file.

**Investigation.** `let instance` at `apps/backend/src/core/container-log-service.ts:352`, created at `:355-358`, stopped and cleared at `:361-364`. Called from `commands-registry-docker.ts:341-357` and stopped from `core/index.ts:2128`. With two live backends, the first shutdown ends the second's log subscriptions.

**Decisions.**

- **Move it now or record it in 0133's table?**
  - **Move it in the same change as the OOM watcher; both are observers started and stopped with the backend (recommended).**
    - Pros: one two-backend shutdown test covers both; the same pattern.
    - Cons: widens this change slightly.
  - **Leave it for a later 0133-style sweep.**
    - Pros: a smaller change here.
    - Cons: the same shutdown bug stays, and it is not tracked anywhere else.

## Current state

- Production runs one backend per process: Electron spawns
  `apps/backend/src/main.ts` (or `backend/main.js`) as a separate `bun`
  process (`apps/desktop/electron/backend-process.ts:715-716`, `:798`), and
  `main.ts` constructs one `OrkestratorBackend` (`apps/backend/src/main.ts:87`).
  The Electron main process imports the backend only as types.
- `dev:test` (`apps/desktop/scripts/dev-test.ts`) goes through the same
  Electron launcher, and the qualification scripts
  (`scripts/qa-command-nodes.ts`, `scripts/qualify-backend-upgrade-rollback.ts`
  and others) spawn `main.ts` per backend. None runs two backends in one
  process.
- Tests construct `OrkestratorBackend` in nine files, one at a time; none
  overlaps two.
- The OOM watcher (`container-oom-events.ts:130-147`), the three login
  refreshers (`agent-accounts-active.ts:285`, `:483`;
  `agent-accounts-containers.ts:948`) and the container log service
  (`container-log-service.ts:352-364`) are module state started or set in
  `init()` and cleared in `shutdown()` (`core/index.ts:1378`, `:1414-1420`,
  `:2124-2129`).

## Outstanding work

### Code

1. Add a two-backend test that starts both, shuts down the first, and
   asserts the second still follows OOM events for its own owner, still
   refreshes logins through its own keeper, and keeps its log subscriptions.
   It fails today.
2. Move the OOM watcher and the container log service onto `BackendRuntime`
   (or the backend instance), with readers going through the context.
3. Move the three login refreshers onto the context and remove the module
   setters and their test resets.
4. Update `docs/architecture/backend-runtime.md` (clusters and shutdown) and
   remove the moved rows from 0133's table.

### Qualification

- None beyond the tests in Code.

## Constraints and rationale

- Follow `backend-runtime.md`: state is reached through the context at call
  time, and test seams are construction options, not setters.
- A watcher is a read-only observer; stopping it must never touch
  containers.
- No production path is affected today, which is why this is rated as a
  refactor that removes a latent risk, not as a user-facing bug.

## Open questions

- Should the backend instead refuse a second concurrent `init()` in one
  process, making "one backend per process" an enforced rule rather than
  isolating every row? That would contradict the stated goal in
  `backend-runtime.md` that two backends in one process never see each
  other's state.

## Needs verification

- None.

## Related

- [0133-backend-module-state-beyond-0066.md](0133-backend-module-state-beyond-0066.md): where this was found; owns the wider move.
- [0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
- [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
- [backend-runtime.md](../../architecture/backend-runtime.md)

## Replaces

Nothing; new on 2026-10-27, split from
[0133-backend-module-state-beyond-0066.md](0133-backend-module-state-beyond-0066.md)'s
task analysis.
