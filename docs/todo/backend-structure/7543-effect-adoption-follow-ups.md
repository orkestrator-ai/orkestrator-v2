# Effect adoption follow-ups

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`. Previously analysed
2026-11-10 against `main` at `04639b12b`. First analysed 2026-11-08
against `main` at `df1815e98`, with the Effect adoption change on branch
`effect-ts-review-f8e88fe1638c-r1` applied. That change is described in
[effect-usage.md](../../development/effect-usage.md). It moved backend
startup, shutdown and the container reachability check onto Effect, added
registered error codes for four domains, and fixed the defects the review
found. These tasks are what the review left for later.

### Tasks

1. **Register the remaining message-marker error conventions**: Status: done (2026-11-10).
2. **Decide how renderer screens show a registered-code IPC error**: Status: done (2026-11-10).
3. **Shared abort-aware timeout, sleep and retry in the backend**: Status: done (2026-11-10); the timeouts whose callee takes no signal are task 6.
4. **One bounded-wait helper for the bridges**: Status: done (2026-11-10).
5. **Parked cancels and prompt timeouts as `acquireUseRelease` in the Cursor bridge**: Status: open (depends on recurrence; see Decisions).
6. **Give the remaining backend timeouts a signal to cancel**: Status: open; the content and media loads, the MCP apply reads and the MCP inventory reads were done 2026-11-11, and only the command invoker family is left (see its Decisions).

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

**Investigation.** Measured 2026-11-10: there is no shared renderer error
formatter; about 218 sites in `apps/web` show `error.message` directly. Every
desktop command rejection passes through one of two invoke clients
(`command-client.ts`, `desktop-node-client.ts`), so any of those displays can
receive a registered code, and normalising there covers all of them (see
Assumptions and decisions, task 2).

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
limiter case (`WebAnnotationToolLimiter`) is fixed in plain code. On
2026-11-10 five abortable sleeps were found at the named files, not six. Only
one `Promise.race` timeout raced work that already took a signal; the other
timeouts race work that takes none (task 6), and the remaining races are not
timeouts.

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

### 6. Give the remaining backend timeouts a signal to cancel

**Problem.** About 28 inline `Promise.race` timeouts in `apps/backend/src`
stopped the caller waiting without stopping the work, because the work they
raced took no `AbortSignal`: `ControlMcpInvoker` and `CommandInvoker`,
`ProjectGitService.fetch`, the provider `mcpServers`, `commandCatalogue` and
`send` calls, the content and media `load` and `resolve` callbacks, and the
MCP management reload calls. A media `resolve` that opened its file after the
route gave up also leaked the file handle, because nothing was left to close
it.

**Context.** Task 3 added `runWithTimeout` (`abortable-timing.ts`), which
aborts the work's signal when its deadline fires. It only cancels work that
accepts that signal, so these sites were left on their races rather than
converted to a helper that could not cancel them either.

**Investigation.** Task 3 surveyed every race in `apps/backend/src`. About 15
are not timeouts at all (drain waits, process-exit waits, supersession races,
soft budgets after which the work is meant to keep running) and stay as they
are. `opencode-commands.ts` must not abort on timeout, because the command may
already have been sent. `change-tracking/worktree-owner.ts` resolves an
outcome rather than throwing. `web-annotation-tools.ts` was fixed in plain
code by the adoption change.

On 2026-11-11 each named family was checked against its callee. No bridge
route observes a client disconnect (only the SSE routes read
`c.req.raw.signal`), so aborting a bridge request ends the backend's request
and its body read, not the bridge's own work. What each family got:

- **Content `load` and media `resolve`** take a signal. The content load's
  asset read (`TranscriptArtifactStore.readAsset`) stops on it, and the media
  route (`resolveMediaWithin`) closes a handle that opens after its deadline.
- **MCP apply reads** (`mcpConfigEvidence`, `openCodeMcpServerNames`) and the
  **MCP inventory read after an action** (`mcpServers`) take a signal through
  `ProviderReadOptions`, which the HTTP bridges and both OpenCode providers
  pass to their request.
- **Kept as races, with the reason beside each:** the command catalogue read
  (its concurrency slot bounds bridge-side probes, which a client abort does
  not stop); provider `send` (prompt dispatch is at most once, and an aborted
  dispatch is ambiguous rather than cancelled); the MCP reloads (mutations an
  abort cannot undo); `ProjectGitService.fetch` (one coalesced fetch shared by
  every caller, bounded by its own 60 s git timeout, so one caller's short
  budget must not kill it); and the content and media `authorize` checks
  (in-process reads whose bound decides the answer).
- **Left open:** the `ControlMcpInvoker` and `CommandInvoker` family
  (`control-mcp-machine-load.ts`, `agent-accounts-machines.ts`,
  `ticket-criteria-head.ts`). A command handler receives no signal, and a
  command routed to another node has no cancel message on the node link.

**Decisions.**

- Thread a signal through each callee, then move its race to `runWithTimeout`, one callee family per change (recommended). Pros: the timeout then actually stops the work; each change is small and testable. Cons: touches provider and invoker interfaces.
- Convert the races to `runWithTimeout` now without callee signals. Pros: one idiom sooner. Cons: no behaviour gained, and it reads as if the work were cancelled when it is not.

For the invoker family that is left:

- Give `CommandContext` an optional `signal` that local handlers may honour, and add a cancel message for commands routed over a node link, declared in the domain contract with an older-peer fallback (recommended). Pros: a timed-out command stops on this node and on the node that runs it. Cons: a protocol addition with its own compatibility tests, and a signal most of several hundred handlers would ignore at first.
- Leave the three invoker timeouts as bounded waits. Pros: no protocol change. Cons: a slow remote command keeps running after the caller has answered "unavailable".

## Current state

- **Registered codes (task 1).** `REGISTERED_ERROR_CODES`
  (`packages/protocol/src/contract/ipc-error.ts`) now also lists
  `container-lifecycle` and `mcp-management` (each with a `reason` detail
  naming the domain's own code), `pane-layout-revision-conflict`,
  `design-revision-conflict`, `prompt-queue-message-conflict` and desktop
  main's `unknown-node`, `node-admin-refused`, `node-scope-closed` and
  `node-unavailable`. Every thrower keeps its old message marker. Readers use
  `hasErrorCode(error, code, legacyMarker)` or the domain parser
  (`parseContainerLifecycleError`, `mcpManagementErrorFromUnknown`,
  `isPaneLayoutRevisionConflict`, `isPromptQueueMessageConflict`,
  `nodeRefusalCode`), which read the code first and the marker only when no
  registered code is present. The table is in
  [version-compatibility.md](../../architecture/version-compatibility.md#registered-error-codes).
- **Renderer display (task 2).** The renderer's two desktop invoke clients
  (`command-client.ts`, `desktop-node-client.ts`) pass every rejection through
  `readableCodedError`, which turns a `[code …] ` prefix into the error's own
  `code` and `details` and leaves the thrower's text as the message.
- **Backend timing (task 3).** `apps/backend/src/core/abortable-timing.ts`:
  `abortableSleep`, `runWithTimeout`, `retryWithBackoff` and their Effect forms,
  tested on `TestClock`. Adopted by the five abortable sleeps, graph guards'
  `ls-remote`, the bridge observation stream's reconnect delay, the OpenCode
  locked-database retry wait and the provider tab session request.
- **Bridge waits (task 4).** `@orkestrator/protocol/node/bounded-wait`
  (`boundedWait`, `boundedWaitOrThrow`) replaces 21 copies across the Pi,
  Cursor, ACP, Claude and Codex bridges.
- **Backend timeouts with a signal (task 6).** `ProviderReadOptions`
  (`agent-provider-contract.ts`) carries a signal into `mcpServers` and
  `mcpConfigEvidence`; the HTTP bridge catalog and evidence readers, the
  OpenCode 1.x capabilities reader and the OpenCode 2.x client's MCP list
  pass it to their request. `runWithTimeout` now bounds the MCP apply
  scheduler's evidence read and OpenCode server-name listing, the agent
  panel's MCP re-read after an action, the artifact content server's load
  (whose asset read honours the signal) and the media route's file open
  (`resolveMediaWithin`, which also closes a handle opened too late).

## Outstanding work

- Task 5, only if parked-cancel or prompt-timeout bugs recur.
- Task 6, the command invoker family only: a cancellation path through the
  command registry and node links (see its Decisions).
- Three bridge waits keep their own code on purpose (see Assumptions and
  decisions, task 4).
- Non-invoke desktop IPC channels (`orkestrator:nodes:open`, `…:gateway` and
  the other `orkestrator:*` handlers) are not passed through
  `readableCodedError`. Their errors are read by code (`nodeRefusalCode`), and
  no screen was found that shows their message; a new screen that does should
  call `readableCodedError` or `ipcErrorText`.

## Needs verification

- None of this changes a live provider turn or Docker behaviour; it was
  verified with focused unit and integration tests only (no `dev:test`
  profile, no Docker run). Task 6's aborts were checked against fake bridges,
  a local OpenCode 2.x HTTP stub and real files, not a running bridge. A desktop window showing a container lifecycle or
  MCP refusal after this change should show the text without a `[code …]`
  prefix; that was checked at the renderer client level, not in a running
  Electron window.

## Assumptions and decisions

### Task 1: all six domains in one change

The to-do recommended one domain per change. This pipeline was asked to do
the task as a whole, so the six domains landed in one commit, each with its own
compatibility tests (code over the gateway body, rebuilt by desktop main, and
in the IPC message form; marker-only errors from an older peer; a different
registered code deciding against).

### Task 1: one code per domain, the domain's own code as a `reason` detail

Container lifecycle and MCP management each have about twenty codes of their
own. Registering each as a wire code would have added forty codes that only
those two domains read. One code per domain with a bounded `reason` detail
keeps the registry small and lets the domain parser return its own code as
before. A relay that keeps the code but drops details still works, because
the message keeps its marker.

### Task 1: where the throwers live

`ContainerLifecycleError` moved from the backend to
`packages/protocol/src/container-lifecycle.ts` as a `Data.TaggedError`, so the
protocol's own request validators and the 32 backend sites that threw
`new Error(formatContainerLifecycleError(...))` throw the coded class. The
backend re-exports it. Its `code` is now `container-lifecycle` and its domain
code is `reason`; `operationFailureCode` reads `reason`. Four backend `Error`
subclasses that carry the marker (`ContainerInitializationError`, the two
registry writer lease errors, the rebuild cancellation) gained `code` and
`details` rather than changing base class. `McpManagementFailure` stays a
plain `Error` with `code` and `details`, because the bridges import
`mcp-management.ts` and carry no Effect. `DesignError.code` returns
`design-revision-conflict` for a revision conflict; backend code that branches
on the design failure code (`isDesignError`) now reads `failure.code`.

### Task 1: the fallback ignores an unregistered code

`hasErrorCode` falls back to the marker whenever no *registered* code is
present, not only when `errorCode()` is `undefined`. An older backend answered
any code-form `code` over the gateway (a design conflict arrived as `code:
"conflict"`), and treating that as "a code is present" would have dropped the
fallback for exactly the peers it exists for.

### Task 1: design conflicts are decided before transport classification

The web design client classified a thrown conflict after
`classifyTransportError`, which reads the gateway's HTTP 500 and the
conflict's "Fetch the latest snapshot" text as a disconnect, so the conflict
branch was unreachable. It now checks the code (or marker) first.

### Task 1: desktop main sends an already-coded error unchanged

Main's `NodeRefusal` messages were already `[code] text`. Now that those codes
are registered, `orkestrator:invoke` would have replaced the error with a fresh
one of the same message; it now rethrows it, keeping its class and `code` for
in-process callers.

### Task 2: normalise at the invoke clients, not per screen

There is no shared renderer error formatter: about 218 sites in `apps/web`
show `error instanceof Error ? error.message : String(error)` directly. The
one place every desktop command rejection passes is the two renderer invoke
clients, so `readableCodedError` runs there. The code moves onto the error
(`code`, `details`), so `errorCode()`, `incompatibility()` and the domain
readers still read it, and the message is the thrower's own text. The browser
gateway path never had the prefix.

### Task 3: the sleep resolves on abort

`abortableSleep` resolves `false` on abort and never rejects: abort is how an
owner stops a wait, and a rejecting sleep would make every abort of a shared
signal a rejection each waiter must handle. The one caller whose contract is to
reject (OpenCode's retry wait) adapts at its call site. `runWithTimeout` and
`retryWithBackoff` have no value to return on abort, so they reject with the
signal's reason, as `fetch` does.

### Task 3: Effect's timers are not unref'd

The helpers sleep on the Effect clock, whose timers are not unref'd, while the
goal verifier, agent tools and observation stream sleeps they replace were.
Each of those owners aborts its wait on stop, and the backend exits
explicitly, so no wait outlives its owner.

### Task 3: `ls-remote` stops on credentials, permissions and missing repositories

`lsRemoteRetryable` reuses `classifyFetchFailure` and also treats GitHub's
"Repository not found" (its answer for a private repository the credentials
cannot see) as final. Other failures get three attempts, backed off 250 ms to
1 s with jitter.

### Task 4: the copies left alone

Codex `interruptForParentExit` keeps its ref'd timer on the parent-exit
shutdown path, where unref'ing it could let the process exit before the steps
that follow. Codex `process-supervisor.ts` races a shared unref'd sleep and is
not a copy of the helper. Claude `rewindViaTransientQuery`'s timer aborts the
query rather than ending a race.

### Task 6: only reads take a signal

`ProviderReadOptions` is accepted by `mcpServers` and `mcpConfigEvidence`
only. A mutation (`send`, the MCP reloads, a tab close) may already have
reached the bridge when its deadline fires; aborting the request would not
undo it and would hide whether it ran, so those keep a plain bounded wait
with a comment saying so.

### Task 6: the command catalogue read keeps its race

`NativeAgentCommandCatalogue` holds one of four service-wide slots until the
provider read settles, because a Claude cold probe spawns a CLI. The bridge
does not stop that probe when the backend disconnects, so aborting the read
at its deadline would free the slot while the probe still runs and let more
than four run at once. The read keeps its race and its slot.

### Task 6: `ProjectGitService.fetch` is a soft budget

Coordinator message checks wait a short time for `ProjectGitService.fetch`,
but the fetch is coalesced per project, shared by every caller and bounded by
its own 60 s `git fetch` timeout. Aborting it for one caller's budget would
fail the fetch for the others, and a fetch that finishes later still serves
the next check through its cooldown. The race stays, as a soft budget.

### Task 6: the media route closes a late handle

`runWithTimeout` drops a value that arrives after its deadline. For media
`resolve` that value is an open file, so `resolveMediaWithin` records the
handle and closes it when the route has already given up, whichever side of
the deadline it lands on. The host-file resolver also checks the signal before
opening, so a resolver that is still reading its roots opens nothing.

### Task 6: `authorize` checks stay bounded races

The content and media `authorize` callbacks read in-process state (live
sessions, the environment record) and hold nothing to release. Their deadline
decides the answer (deny) rather than cancelling work, so passing them a signal
would gain nothing; a comment at each says so.

### Task 6: the invoker family is left open

`ControlMcpInvoker` and `CommandInvoker` run registry commands that receive no
signal, and a command routed to another node has no cancel message on the node
link. Cancelling them means a `CommandContext` signal and a contract-declared
cancel message with an older-peer fallback
([version-compatibility.md](../../architecture/version-compatibility.md#domain-contracts)),
which is a protocol change of its own rather than a follow-up to this one.

## Related

- [effect-usage.md](../../development/effect-usage.md): where Effect is used and why.
- [version-compatibility.md](../../architecture/version-compatibility.md#registered-error-codes): the registered error codes.
