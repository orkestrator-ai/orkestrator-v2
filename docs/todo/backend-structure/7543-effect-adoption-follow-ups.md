# Effect adoption follow-ups

## Task analysis

Analysed 2026-11-08 against `main` at `df1815e98`, with the Effect adoption
change on branch `effect-ts-review-f8e88fe1638c-r1` applied. That change is
described in [effect-usage.md](../../development/effect-usage.md). It moved
backend startup, shutdown and the container reachability check onto Effect,
added registered error codes for four domains, and fixed the defects the review
found. These tasks are what the review left for later.

### Tasks

1. **Register the remaining message-marker error conventions**: Status: open.
2. **Decide how renderer screens show a registered-code IPC error**: Status: open.
3. **Shared abort-aware timeout, sleep and retry in the backend**: Status: open.
4. **One bounded-wait helper for the bridges**: Status: open.
5. **Parked cancels and prompt timeouts as `acquireUseRelease` in the Cursor bridge**: Status: open (depends on recurrence; see Decisions).

### 1. Register the remaining message-marker error conventions

**Problem.** Electron IPC carries only an error's message, so several domains
still put their code in the message text and readers match it:
`ContainerLifecycleError:<code>:` (`packages/protocol/src/container-lifecycle.ts`),
`McpManagementError:<code>:` (`apps/backend/src/core/mcp-management/service.ts`),
`Pane layout revision conflict:` (`pane-layout.ts`), `Design revision conflict:`
(`design-canvas.ts`), `Prompt queue message conflict:` (`storage-prompts.ts`),
and the desktop node refusal codes (`contract/node-refusal.ts`).

**Context.** `REGISTERED_ERROR_CODES` in `packages/protocol/src/contract/ipc-error.ts`
already carries any registered code with bounded details over IPC and the
gateway, and `errorCode(error)` reads it. Rules are in
[version-compatibility.md](../../architecture/version-compatibility.md#registered-error-codes).

**Investigation.** Each convention has its own encoder and reader, and older
peers match the old text. A registered code keeps the original message after
its prefix, so old readers still match.

**Decisions.**

- One domain per change, registering its code and moving readers to `errorCode` with a text fallback (recommended). Pros: small reviewable steps, each with its own compatibility test. Cons: the conventions coexist for a while.
- All at once. Pros: one convention sooner. Cons: a large change touching the desktop, web and backend at once, with several wire formats to keep compatible.

### 2. Decide how renderer screens show a registered-code IPC error

**Problem.** Over Electron IPC a registered-code error reaches the renderer as
`[code k=v] text`, because only the message crosses the context bridge. Any
screen that shows `error.message` directly shows the prefix. The session hook
strips it with `ipcErrorText`, and incompatibility errors already behave this
way.

**Context.** The new codes are Kanban request-id conflicts, receipt capacity and
provider session missing. The first two are handled inside the backend, so few
users should see them.

**Investigation.** Not yet measured: which renderer error displays can receive
a registered code.

**Decisions.**

- Strip the prefix in the shared renderer error formatter, keeping the code on `error.code` (recommended). Pros: one place, every screen benefits. Cons: has to find the formatter every display goes through.
- Strip it per screen as codes are added. Pros: no shared change. Cons: easy to miss a screen.

### 3. Shared abort-aware timeout, sleep and retry in the backend

**Problem.** About 40 inline `Promise.race` timeouts in `apps/backend/src` stop
the caller waiting without stopping the work. Six abortable sleeps disagree on
whether abort resolves or rejects (`host-standalone-updater.ts`,
`native-agent-goal-verifier.ts`, `native-agent-goal-check.ts`,
`opencode-agent-tools.ts` resolve; `opencode-provider-helpers.ts` rejects).
`graph-agent-guards.ts` (`listRemote`) retries every error immediately,
including authentication failures. The reconnect `delay` in
`http-bridge/observation-stream.ts` ignores `close()`, and
`commands-servers.ts` checks `isShuttingDown()` and then sleeps.

**Context.** The backend now runs Effect for startup, shutdown and the
reachability check, so a runtime is already in the process.

**Investigation.** The review counted these sites but did not change them. The
limiter case (`WebAnnotationToolLimiter`) is fixed in plain code.

**Decisions.**

- Effect helpers: `Effect.tryPromise({ try: (signal) => … })` with `Effect.timeoutFail` for timeouts that must cancel, and `Effect.retry` with a jittered, capped `Schedule` and a `while` predicate, adopted site by site and tested with `TestClock` (recommended). Pros: cancellation reaches the work where the callee takes a signal, one retry vocabulary, deterministic tests. Cons: callers are promise-based, so each site needs an `Effect.runPromise` edge.
- Plain helpers (`timers/promises.setTimeout` with a signal, a `boundedWait`). Pros: no runtime boundary. Cons: a second idiom beside the Effect one already in the backend.

### 4. One bounded-wait helper for the bridges

**Problem.** The same "timer, race, `finally clearTimeout`" helper is copied
about 20 times across the bridges (Pi `timeout.ts`, Cursor `prompt.ts`,
`models.ts`, `cursor-runs.ts`, `session-tombstones.ts`, `session-close.ts`,
`credentials.ts`, ACP `acp-session-close.ts`, Claude `session-manager-close.ts`,
`session-manager-core.ts`). Late-result disposal is duplicated in Cursor and Pi
`mcp.ts`.

**Context.** The timers that were not unref'd were fixed in the adoption change.
Bridges carry no Effect (see effect-usage.md).

**Investigation.** The copies differ in unref and late-result handling only.

**Decisions.**

- An Effect-free `boundedWait(work, ms, { onLate })` in `packages/protocol`, next to `EventRing` (recommended). Pros: one tested copy, no runtime in the bridges. Cons: touches five bridges.
- Leave the copies. Pros: no churn in invariant-dense code. Cons: the next copy may forget to unref or dispose the late result.

### 5. Parked cancels and prompt timeouts as `acquireUseRelease` in the Cursor bridge

**Problem.** Cursor (`pendingCancelPromptSequence`, `followRun` in `prompt.ts`),
Pi (`cancelRequestedClaim`, `abortPromptStartup`) and ACP each hand-build "a
cancel before the run handle exists is honoured once it exists" and "a timeout
cancels the run". Pi's `await state.cancelTurn?.(...)` has no bound while
Cursor's has `cancelAckTimeoutMs`.

**Context.** `acquireUseRelease(send, follow, release)` with an uninterruptible
`send` gives the parked-cancel invariant by construction, and a timeout becomes
an interrupt that cancels the run.

**Investigation.** The three-valued route answers and journal ordering stay
manual either way. The review judged a conversion large and high-risk per
bridge.

**Decisions.**

- Pilot in Cursor only if parked-cancel or timeout bugs recur (recommended). Pros: spends the risk only where evidence asks for it. Cons: the three copies stay.
- Convert all three bridges now. Pros: one model. Cons: high risk at the at-most-once boundary for no current bug.
- Separately, bound Pi's cancel acknowledgement like Cursor's. Pros: small. Cons: needs a timeout value chosen with Pi's abort semantics in mind.

## Related

- [effect-usage.md](../../development/effect-usage.md): where Effect is used and why.
- [version-compatibility.md](../../architecture/version-compatibility.md#registered-error-codes): the registered error codes.
