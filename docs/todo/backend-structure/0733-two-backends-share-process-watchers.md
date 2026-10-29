# Two backends in one process share the OOM watcher, the login refreshers and the container log service

Checked against `main` at `863b5782` (2026-10-27). Done on
`todo-0733-per-backend-watchers-0fc0ebf50061` from `31b9c972`
(2026-10-28): every item is finished. Kept until the branch merges for its
decisions, then deleted.

When two `OrkestratorBackend` instances run in one process at the same time,
the second backend's OOM watcher is never started for its own containers. The
Claude and Codex login refreshers are registered last-writer-wins, and the
container log service is one per process. Whichever backend shuts down first
stops the watcher and the log followers and clears the refreshers for both.
Production and `dev:test` run one backend per process, so today only a test
that overlapped two backends could hit this, and no current test does. Found
in the task analysis of todo 0133 (finished and deleted; see
[backend-runtime.md](../../architecture/backend-runtime.md)).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the interference with a failing two-backend test**: add cases to `backend-runtime.test.ts` (or `index.test.ts`) that fail today. Status: done (the log-service part failed before the fix; see Current state).
2. **Make the OOM watcher per backend**: own it from the backend instance or `BackendRuntime`, not a module variable. Status: done by 0133 (#1335, `runtime.containerOom`) before this branch; this branch adds the full-backend test.
3. **Make the login refreshers per backend**: hold the three refreshers where each backend's callers reach their own. Status: done by 0133 (#1335, `runtime.accounts`) before this branch; this branch adds the full-backend test.
4. **Make the container log service per backend**: the same pattern, a row 0133 does not list. Status: done (`runtime.containerLogs`).

The analysis below is as written on 2026-10-27, against `863b5782`; its line
references predate 0133's merge.

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

- The OOM follower is `runtime.containerOom` (`ContainerOomEvents`) and the
  three login refreshers are construction options of `runtime.accounts`
  (`AgentAccountsRuntime`), both from 0133 (#1335), which merged after this
  file was written. This branch found them already moved and did not change
  them beyond a `spawn` construction option for the OOM follower.
- The container log service is `runtime.containerLogs` (`ContainerLogService`,
  `apps/backend/src/core/backend-runtime.ts`). The module `instance`,
  `containerLogService()` and `shutdownContainerLogService()` are gone. The
  four log commands (`open_`, `read_`, `close_`, `stream_container_logs` in
  `commands-registry-docker.ts`) reach it through `context.runtime`.
  `BackendRuntime.shutdown()` stops it, and so does the backend's own
  `shutdown()` next to the OOM follower (`core/index.ts`); both stops are
  idempotent. Its lease sweep now starts with the first subscription, so
  building a runtime (every command fixture does) starts no timer.
- Test seams are construction options: `BackendRuntimeOptions.containerOom`
  (`spawn`) and `.containerLogs` (`spawn`, `now`), and the backend option
  `dockerFollowers`, which passes those two to the runtime the backend
  builds and keeps its refresher wiring.
- `backend-runtime.test.ts` has two new cases. "two OrkestratorBackends in
  one process (todo 0733)" starts two real `OrkestratorBackend`s on separate
  temporary data directories with fake Docker followers, checks each follows
  its own owner label, counts its own OOM events, refreshes through its own
  keeper and Codex refresher and spawns its own log follower, then shuts the
  first down and checks the second's OOM follower and log follower still
  run, its subscription still reads, and it still refreshes, while the
  first's refreshers answer "nothing asked". "container log followers are
  per backend and stop with it" covers the same at runtime level.
- Before the fix, the full-backend log case failed: after the first backend's
  shutdown, the second's `read_container_logs` rejected with
  `ContainerLifecycleError:operation-unknown: The log subscription has
  expired.` (run on this branch before the code change, with the real
  `docker logs` spawn because the seam did not exist yet). The OOM and
  refresher assertions pass on the base commit, since 0133 had moved them.

## Outstanding work

### Code

1. **Done — Two-backend test.** See Current state.
2. **Done — OOM watcher and log service on `BackendRuntime`.** The OOM
   watcher by 0133; the log service here.
3. **Done — Login refreshers on the context.** By 0133
   (`AgentAccountsRuntime`); no module setters or test resets remain.
4. **Done — Docs.** `docs/architecture/backend-runtime.md` lists
   `containerLogs`, the new test seams and the shutdown behaviour; the log
   service row is gone from 0390's table (0133's table already listed the
   OOM and refresher moves).

### Qualification

- None beyond the tests in Code. See Validation evidence.

## Validation evidence

Run on omarchy-hp (Linux) on 2026-10-28.

- `mise run format:check`: passed. `mise run lint`: exit 0, no findings in
  changed files.
- `mise run typecheck`: exit 1, from 5 errors in one file this branch does
  not touch (`apps/backend/tests/commands-environment-image-download.test.ts`,
  lines 134–180, added by #1391). A clean `origin/main` worktree at
  `31b9c972` shows the same 5 errors. Every other package and the root, e2e
  and agent-testing projects typecheck clean.
- Focused: `backend-runtime.test.ts`, `backend-runtime-wiring.test.ts`,
  `index.test.ts`, `commands-process-coverage`, `commands-registry-coverage`,
  `container-benchmarks`, `container-live-network`, `container-log-service`,
  `container-oom-events`, `container-resources`, `agent-accounts-active`,
  `agent-accounts-containers` at `--parallel=4`: 302 pass, 6 skip, 0 fail.
- `mise run test` (on commit `e5b807a2`): exit 0 in 800.8 s after 402 s
  queued for host capacity; workspace (web, backend, desktop, web-public,
  CLI, protocol, toolchain), root and agent-support, bridges and the codex
  protocol lockfile groups all passed. No flaky test was seen, so no case
  was recorded.

## Assumptions and decisions

1. **Tasks 2 and 3 were already done; add tests, not code.**
   - Options: re-do the OOM and refresher moves to this file's plan; leave
     them untested here; keep 0133's code and add the full-backend test this
     file asked for.
   - Chosen: keep 0133's code and add the test.
   - Why: 0133 (#1335) moved both into `BackendRuntime` exactly as this
     file recommended (owner on the runtime, construction options, no
     setters). Its tests were runtime-level, so nothing exercised two real
     backends' `init()`/`shutdown()`.
   - Pros: no churn; the wiring in `core/index.ts` is now covered. Cons:
     those parts of the test passed before this change, so only the log
     service part was a failing test first.
2. **The test runs two real `OrkestratorBackend`s (this file's recommended
   level), plus one runtime-level case.**
   - Options: two backends; module-level unit tests; runtime-level only.
   - Chosen: two backends on separate temporary data directories, started
     together with `Promise.all`, with the startup reapers, agent tools and
     Docker followers faked. The control MCP binds port 0 under `bun test`,
     so no fixed port is used. Plus a runtime case alongside the other
     two-runtime cases.
   - Pros: tests the wiring where the bug was. Cons: heavier than a
     runtime case (two full `init()`s and `shutdown()`s).
3. **The log service is a `BackendRuntime` member, built eagerly, with a
   lazy lease sweep.**
   - Options: a lazy getter creating the service on first use (the old
     module behaviour, per runtime); a module map keyed by owner; an eager
     member whose constructor starts nothing.
   - Chosen: eager member; the lease sweep starts on the first `open()`.
   - Why: matches `containerOom` and the other owners; a lazy getter would
     need its own "closed" state to avoid recreating the service after
     shutdown; a module map is still module state.
   - Pros: no timer for fixtures that never open a log; simple shutdown.
     Cons: a small behaviour change inside `ContainerLogService` (the sweep
     no longer runs before the first subscription, when there is nothing
     to sweep).
4. **After shutdown, opening a log subscription is refused.**
   - Options: recreate a fresh service on next use (the old module
     behaviour); refuse.
   - Chosen: refuse with the existing `resource-exhausted` "Log following is
     shutting down." error.
   - Why: a backend that has shut down should not start Docker followers;
     the gateway stops accepting commands first, so no client sees this.
5. **Follower seams are construction options, reached from the backend as
   `dockerFollowers`.**
   - Options: `mock.module` on `shell.js`; pass a whole `runtime` to
     `OrkestratorBackend`; a narrow backend option forwarded to the runtime.
   - Chosen: `BackendRuntimeOptions.containerOom`/`containerLogs`, and
     `OrkestratorBackend`'s `dockerFollowers`
     (`Pick<BackendRuntimeOptions, "containerOom" | "containerLogs">`).
   - Why: `backend-runtime.md` asks for construction options; a whole
     `runtime` would drop the backend's own refresher closures, which the
     test must exercise; `mock.module` leaks across files.
   - Pros: no real `docker` process in the test. Cons: one more backend
     test option.
6. **Isolate every row rather than refuse a second backend per process (the
   open question).**
   - Options: make `init()` refuse a second concurrent backend; isolate.
   - Chosen: isolate.
   - Why: `backend-runtime.md` states two backends in one process never see
     each other's state, and the remaining rows are tracked in 0390. A
     refusal would also stop tests from running two backends.
   - Pros: consistent with 0011/0066/0133. Cons: the guarantee holds only as
     far as 0390 is done.
7. **0133 and 0390 updates.** 0133 is finished and its table already lists
   the OOM and refresher moves, so only its link to this file now says what
   was done. 0390's container log service row is removed, with a note
   pointing here.

## Open questions

- None. The question of refusing a second concurrent `init()` is decision 6.

## Needs verification

- A live backend run showing container logs still follow and stop (not
  done: this host runs the user's live Orkestrator, and the constraints for
  this work forbid live runs). Production runs one backend per process, and
  the change only moves where the one service is held, so no behaviour
  change is expected.

## Constraints and rationale

- Follow `backend-runtime.md`: state is reached through the context at call
  time, and test seams are construction options, not setters.
- A watcher is a read-only observer; stopping it must never touch
  containers.
- No production path is affected today, which is why this is rated as a
  refactor that removes a latent risk, not as a user-facing bug.

## Related

- [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md): the remaining per-backend module state, after 0133 (finished and deleted).
- [backend-runtime.md](../../architecture/backend-runtime.md)

## Replaces

Nothing; new on 2026-10-27, split from todo
0133's task analysis (finished and deleted).
