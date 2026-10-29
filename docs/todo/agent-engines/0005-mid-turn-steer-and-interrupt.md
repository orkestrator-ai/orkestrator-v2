# Mid-turn steer and interrupt

Checked against `main` at `863b5782` (2026-10-27).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Collapse Claude task-to-process maps**: move `backgroundTaskControls`, `backgroundTaskCandidates` and `settlingBackgroundTasks` into runtime state. Status: open.
2. **Live Claude model catalogue**: read models from the live runtime instead of a separate control-only probe. Status: open (the file's description of the probe is out of date).
3. **Warm first Claude turn**: avoid the cold spawn on an environment's first turn, then measure. Status: open.
4. **Cursor `SendOptions.local.force`**: use it for a wedged agent. Status: deferred (until wedged agents are seen).
5. **OpenCode steer**: needs OpenCode 2.x and an expected-turn precondition. Status: blocked (OpenCode 2.x; pin is `1.19.4`).
6. **Grok steer**: ACP has no mid-turn input; interjection stays behind its unsafe flag. Status: blocked (ACP / Grok).
7. **Inactive-path steer qualification on Claude and Cursor**: steer, switch away, return, reload. Status: open.
8. **Warm Claude CLI app-path qualification**: follow-up, mode and permission changes, parked approval and MCP change on one CLI through the app. Status: open.
9. **Re-measure the first turn**: after task 3. Status: blocked (on task 3).

### 1. Collapse Claude task-to-process maps

**Problem.** Background-task stop and runtime teardown still go through per-control maps that, with one CLI per session, only ever name that session's runtime. The indirection is a source of ownership bugs.

**Context.** Decision 6 in "Warm Claude runtime" kept these maps because they carry the strict-owner stop rule. 0013 (Claude prompt-stream state) touches the same files; 0004 says mid-session parameter changes ride on this item.

**Investigation.** Still accurate. `backgroundTaskControls` is a `Map<string, ClaudeQueryControl>` on the session (`bridges/claude-bridge/src/types/index.ts:782`), filled at `services/session-manager-background-tasks.ts:449` and `services/session-manager-prompt-handlers/system-tasks.ts:162`; `backgroundTaskCandidates` at `session-manager-background-tasks.ts:91-119`. The three maps are referenced 37 times in `session-manager-background-tasks.ts` (792 lines) plus `session-manager-persistence.ts`, `session-manager-prompt-hooks.ts` and `session-manager-prompt-turn-lifecycle.ts`. `stopBackgroundTask` is at `session-manager-background-tasks.ts:623`, `endClaudeRuntime` at `session-manager-prompt-launch.ts:103`. Recent related work: #1264 (`e2130297`, resume cleanup of orphaned tasks).

**Decisions.**

- **How to keep the strict-owner rule once the maps go?**
  - **Record the owning runtime generation on each task entry inside the runtime, and refuse a stop whose generation differs (recommended).**
    - Pros: one source of truth; a replaced CLI cannot receive a stop for a task it did not start.
    - Cons: a generation counter must survive the launch-only retire path.
  - **Keep a single task-id set on the runtime and rely on "one CLI per session".**
    - Pros: simplest.
    - Cons: a retire-and-relaunch window could route a stop to the new process.
- **Order relative to 0013?**
  - **Do this first, then 0013's stream-state refactor (recommended).**
    - Pros: shrinks the state 0013 has to move.
    - Cons: two changes to the same files in sequence.
  - **Fold it into 0013.**
    - Pros: one review.
    - Cons: a larger, riskier diff in the turn lifecycle.

### 2. Live Claude model catalogue

**Problem.** Every model-catalogue read starts a separate Claude CLI, even when a warm CLI is running, costing a process (about 230-340 MB and seconds) per read.

**Context.** The catalogue route is `bridges/claude-bridge/src/routes/config.ts:12`. AGENTS.md notes `createProbe()` spawns a whole CLI and is cached for commands and MCP.

**Investigation.** Partly out of date. The probe is no longer a `maxTurns: 0` query: `getAvailableModelCatalog` (`services/session-manager-interactions.ts:226`) now uses `controlOnlyQuery` (`services/control-only-query.ts`), whose header records that `maxTurns: 0` was dropped by SDK 0.3.309 and an empty prompt ran real model turns. The read is still a fresh CLI per call, uncached, and never consults a live runtime. `createProbe` is at `services/session-manager-catalog.ts:222`. Command discovery already reads `initializationResult()` from its probe for the version (`services/session-manager-commands.ts:511-514`), so the pattern exists.

**Decisions.**

- **Where should a live runtime's models come from?**
  - **`supportedModels()` on the live control when `readableControl` returns one, else the control-only probe, cached by CLI version (recommended).**
    - Pros: zero extra processes in the common warm case; the cache bounds the cold case like `commandInventory`.
    - Cons: a control read on a draining control must fall back correctly (the `queryControlDraining` rule).
  - **`initializationResult()` models only.**
    - Pros: no control round trip.
    - Cons: the initialize snapshot may predate account or plan changes during a long-lived CLI.
- **Cache the probe result?**
  - **Yes, keyed by CLI version and account, invalidated on sign-in change (recommended).**
    - Pros: the catalogue changes rarely; removes spawns.
    - Cons: a new model reaches users only on invalidation.
  - **No cache.**
    - Pros: always fresh.
    - Cons: keeps the per-read spawn.

### 3. Warm first Claude turn

**Problem.** The first turn in an environment pays a cold CLI spawn (4.3-5.2 s to first text in the recorded measurements) against about 1 s warm.

**Context.** The file names `startup()` / `WarmQuery`; the memory budget is bounded by decision 2 (three idle CLIs).

**Investigation.** Still unused. Pinned SDK `0.3.309` has `startup()` (`bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:9882`), `WarmQuery` (:10269) and a newer `prewarm()` (:2889) that parks a spare process before its session is known and binds it with `SpareProcess.claim` (cwd, model, permission mode, settings overlay); it notes about 230-260 MB while parked and needs `options.cwd` for containerised hosts.

**Decisions.**

- **Which SDK surface?**
  - **`prewarm()` spare per environment, claimed by the first prompt (recommended).**
    - Pros: covers the case where no session exists yet; claim options match the live-settings set.
    - Cons: launch-only settings (plugins, policy) must match at prewarm time or the spare is wasted; extra 250 MB per environment.
  - **`startup()` / `WarmQuery` when a tab opens.**
    - Pros: bound to a known session.
    - Cons: warms only after the user opens a tab, a smaller win.
- **When to prewarm?**
  - **On tab open for a Claude tab with no live CLI, released by the existing idle window (recommended).**
    - Pros: spends memory only where a turn is likely.
    - Cons: a tab opened and left idle costs one CLI for 10 minutes.
  - **On environment start.**
    - Pros: earliest.
    - Cons: pays for environments never used for Claude.

### 4. Cursor `SendOptions.local.force`

**Problem.** A wedged Cursor agent cannot be forced past.

**Context.** Explicitly low priority; gated on evidence from `recoverActiveRun`.

**Investigation.** `local.force?: boolean` is still in `@cursor/sdk` `1.0.40` (`bridges/cursor-bridge/node_modules/@cursor/sdk/dist/cjs/options.d.ts:281`) and unused; `recoverActiveRun` is at `bridges/cursor-bridge/src/agent-session.ts:1014`. No telemetry exists for wedged recoveries.

**Decisions.**

- **How will wedged agents be noticed?**
  - **Add a content-free runtime-health counter when `recoverActiveRun` finds a run it cannot re-adopt (recommended).**
    - Pros: turns "if seen in practice" into a measurable trigger.
    - Cons: a small code change for a deferred item.
  - **Wait for a user report.**
    - Pros: no work.
    - Cons: the trigger may never be observed.

### 5. OpenCode steer

**Problem.** OpenCode users cannot steer.

**Context.** Needs OpenCode 2.x `delivery: steer`, and even then no expected-turn precondition; 0008 owns the 2.x move.

**Investigation.** Still blocked: the SDK and CLI are pinned at `1.19.4` (`packages/toolchain/src/manifest.ts:10`, `@opencode-ai/sdk`). OpenCode's actions remain `{ compact, undo, redo }` (`packages/protocol/src/native-agent.ts`, OpenCode branch).

**Decisions.** None: blocked on 0008 and an upstream precondition; the file already rules out a coordinator-only workaround.

### 6. Grok steer

**Problem.** Grok users cannot steer.

**Context.** The interjection extension is gated by `GROK_UNSAFE_EXPERIMENTAL_INTERJECTION=1` (`bridges/acp-bridge/src/acp-session.ts:2042`).

**Investigation.** Still blocked. `@agentclientprotocol/sdk` is now `2.0.1` (v1 and v2 schemas under `dist/`), with no steer or mid-turn input surface found in its type declarations. The file's "Grok: `actions: {}`" is stale: Grok now declares `{ compact: true }` (`packages/protocol/src/native-agent.ts:1113`).

**Decisions.** None: blocked upstream; recheck on each ACP SDK or Grok bump.

### 7. Inactive-path steer qualification on Claude and Cursor

**Problem.** Steer recovery after switching away and reloading is unproven for Claude and Cursor.

**Context.** Batched in 0031 (Claude and Cursor rows).

**Investigation.** A real-stack spec exists for Codex only: "queued native steering survives a lost gateway response, inactive environment and reload" (`e2e/agent-testing/browser-gateway.spec.ts:967`, opt-in, `agent: "codex"`).

**Decisions.**

- **Manual run or extend the spec?**
  - **Parameterise the existing Codex spec by platform and run it for Claude and Cursor (recommended).**
    - Pros: repeatable; reuses a proven scenario.
    - Cons: needs Claude and Cursor credentials in the profile; Cursor queue semantics may differ.
  - **One-off manual run.**
    - Pros: faster today.
    - Cons: no regression guard.

### 8. Warm Claude CLI app-path qualification

**Problem.** The warm CLI was qualified only at bridge level; the app path (composer changes, approvals, MCP changes on one process) is not.

**Context.** Decision 3 depends on live settings being restated on every join.

**Investigation.** Bridge tests cover join, window, cap, replacement and reclaim (`session-manager-runtime-idle.test.ts`). No browser or CLI scenario asserts the process id stays the same.

**Decisions.**

- **How to prove "same process"?**
  - **Expose the runtime generation in the bridge's content-free runtime health and assert it is unchanged across the steps (recommended).**
    - Pros: observable from the app and CLI; no PID scraping.
    - Cons: small bridge change.
  - **Read the PID from `ps` during the run.**
    - Pros: no code.
    - Cons: fragile; PID checks conflict with the shared-host rules.

### 9. Re-measure the first turn

**Problem.** The benefit of task 3 needs evidence.

**Context.** The table in "Warm Claude runtime" is the baseline.

**Investigation.** Nothing to measure until task 3 lands.

**Decisions.** None: follows task 3 with the same method (haiku, prompt to first assistant text, bridge level).

Users should be able to redirect or stop a running turn without losing work, on
every provider whose vendor surface allows it. Steer and the graceful abort
ladder are live on Claude, Codex, Cursor and Pi. Claude's CLI now stays warm
between turns and releases itself after an idle window, so a follow-up is
written into the running process. Background-task ownership is that
process's own state, and bridge-wide reads (models, account, plan usage) ask a
running CLI before spawning a probe. What is left is live qualification
through the app and the browser. OpenCode and Grok steer are blocked upstream
and are recorded here; the Cursor `force` send is deferred until a wedged
agent is seen.

## Current state

- Steer is on Codex, Claude, Cursor and Pi (`actions.steer` in
  `nativeAgentCapabilities()`, `packages/protocol/src/native-agent.ts`). The
  backend qualifies it at runtime with `HttpBridgeProvider.steerSupported`,
  which probes `/session/:id/steer/dispatch`. No platform is hard-coded.
- Abort ladder (`apps/backend/src/core/native-agent-service.ts`): it
  calls `provider.abort`, waits up to `abortGraceMs` (default 5 s), then calls
  `hardAbort`, and records a stop notice naming the rung that fired.
- Claude (`bridges/claude-bridge/src/services/`):
  - `/abort` → `gracefulInterruptClaudeSession` (`Query.interrupt()`, returns
    `stillQueued`) in `session-manager-catalog.ts`. `/hard-abort` is the kill
    rung (`routes/session.ts`). `perTaskStopAffordance: true` is declared
    (`session-manager-prompt-query.ts`).
  - `steerClaudeSession` writes into the running CLI's input through
    `pushInput`, with a steer journal.
  - `session-manager-runtime.ts` owns one CLI per session. It stays open
    after every turn, warm or owning background work. A follow-up is written
    into that process, frames are routed to the turn that owns them, and
    `applyClaudeLiveSettings` restates model, permission mode, thinking budget
    and flag settings on the live process.
  - A prompt settles at its own result (`endTurnOnWarmRuntime` in
    `session-manager-prompt-turn-lifecycle.ts`), not when the process exits.
    The runtime closes its own input after `CLAUDE_BRIDGE_RUNTIME_IDLE_MS`
    (default 10 minutes) of silence with no foreground turn, live task or
    parked card, and at most `CLAUDE_BRIDGE_MAX_IDLE_RUNTIMES` (default 3) idle
    CLIs stay warm per bridge (`session-manager-runtime-idle.ts`). A window of
    0 restores closing input at turn end.
  - Launch-only settings (`claudeLaunchProfile`) that differ from a CLI that
    still owes work are refused with a `conflict` (409) rather than starting a
    second process (#950). A warm CLI that owes nothing is retired and the
    turn launches a new one (`joinableRuntime` in
    `session-manager-prompt-launch.ts`).
  - The continuation a task notification owes is a flag on the latest turn
    (`awaitingContinuation`) that stretches the idle window to
    `CONTINUATION_SILENCE_MS`; `retainedContinuationRequestIds` still reports it
    to backend workflows.
  - Background work belongs to the runtime (`runtime.tasks`,
    `ClaudeRuntimeTasks` in `session-manager-background-tasks.ts`): the live
    tasks that process started, its unresolved Bash candidates and the
    snapshots a level signal parked before their edge. The task hooks
    (`TaskCreated`, `TaskCompleted`, `SubagentStart`), the `task_*` and
    `background_tasks_changed` frames and the Bash calls feed it.
    `stopBackgroundTask` reaches only the CLI that owns the task
    (`backgroundTaskOwner`), and `endClaudeRuntime` settles what the process
    owned through `releaseClaudeRuntimeTasks`. Nothing about task ownership is
    kept on the session any more.
  - The model catalogue (`getAvailableModelCatalog` in
    `session-manager-interactions.ts`), the account (`probeAccount` in
    `claude-sign-in.ts`) and the plan-usage windows (`readClaudePlanUsage` in
    `session-manager-catalog.ts`) ask an open runtime first
    (`live-claude-control.ts`): models and account from its held initialize
    answer, plan usage over its control channel. A control-only probe runs only
    when no running CLI answers. MCP actions already used the session's live
    control and probe only without one.
  - `startup()` / `WarmQuery` are not used: measured, the spawn and initialize
    they save is about 0.2 s (see "Assumptions and decisions").
  - Bridge tests cover an idle steer reading back as `absent` and the
    interrupt receipt (`session-manager-catalog-steer.test.ts`,
    `routes/session.test.ts`), the warm runtime's join, window, cap,
    replacement and reclaim (`session-manager-runtime-idle.test.ts`), and the
    live reads with their probe fallbacks (`live-claude-control.test.ts`).
- Cursor: `Run.steer` with a bounded `steer-journal.ts`. Status comes from
  `onDidChangeStatus` (`prompt.ts`). `recoverActiveRun` (`agent-session.ts`)
  re-adopts a surviving run, and `cancelSurvivingRuns` (`cursor-runs.ts`)
  cleans up after a closed session.
- Pi: `steer(text, images)` and `followUp(text, images)` (`http.ts`), with
  `setSteeringMode` / `setFollowUpMode` from Pi's settings
  (`agent-session.ts`). The backend reads `/session/:id/queue` into
  `providerQueue` (`http-bridge-provider.ts`), and
  `mergeNativeAgentQueueItems` (`native-agent-transcript-projection.ts`) merges it
  into the projection queue.
- Grok: `actions: {}`. The dormant interjection extension
  (`bridges/acp-bridge/src/grok-interjection.ts`) runs only with
  `GROK_UNSAFE_EXPERIMENTAL_INTERJECTION=1` (`applyVendorUpdate` in
  `acp-session.ts`).
- OpenCode: no `steer` in its actions.

## Outstanding work

### Deferred

- **Cursor `SendOptions.local.force`.** The SDK documents it as expiring the
  agent's active persisted run before a new follow-up, a recovery path for an
  agent left wedged by a crashed CLI. It stays unused until
  `recoverActiveRun` is seen re-adopting a run that never progresses; see
  "Assumptions and decisions".

### Blocked

- **OpenCode steer** needs OpenCode 2.x: `POST /api/session/:id/prompt` with
  `delivery: steer`. Even 2.x has no expected-turn precondition, so a native
  `/steer` must not be advertised until one exists. See
  [0008-opencode-v2.md](0008-opencode-v2.md).
- **Grok steer** stays off. ACP v1 has no mid-turn input, and the Grok
  interjection extension stays behind its unsafe flag until an ACP equivalent
  exists.
- Neither gets a coordinator-only workaround. Coordinators need nothing more:
  they do not opt out of `actions.steer`, so they get steer here once it
  exists. This is the only place the gap is tracked (moved from todo 0028,
  retired on 2026-10-29).

### Qualification

- Browser, inactive path, on Claude and Cursor: start a long turn, steer it,
  switch environment, return and reload. The steered message and its outcome
  must come back from the snapshot.
- Through the app, on one warm Claude CLI: a follow-up, a plan-mode toggle, a
  permission-mode change, a parked approval answered after a pause, and an MCP
  server added and removed between turns. Confirm the process id stays the
  same and the composer changes take effect. The bridge-level runs are below;
  the app path is not yet qualified.
- With a real login on a throwaway profile, through one warm CLI: the model
  picker, the account card and the plan-usage panel answer without a probe
  process appearing, and stopping a background task started two turns earlier
  reaches it (see "Needs verification").

## Constraints and rationale

### Warm Claude runtime (decided 2026-10-17)

Measured on this host with haiku, prompt to first assistant text. Bridge
level, through `POST /session/:id/prompt` (four or five follow-ups each):

| Build | First turn | Follow-up (median) | CLI between turns |
| --- | --- | --- | --- |
| `main` `31d0fb06` | 5.2 s | 3.5 s | none |
| This change, window 0 | 4.3 s | 3.5 s | a new process each turn |
| This change, default window | 4.6–5.2 s | 0.9–1.0 s | the same process |

A bare SDK probe (no settings, MCP or plugins) gave 2.1 s for a resumed cold
follow-up and 1.2 s for a warm one; the bridge's real launch options make the
cold path dearer. A launch-only change on a warm CLI (prompt suggestions on)
was accepted, the old process exited and one new process took over. With a
15 s window the CLI was gone 20 s after the last turn. Each warm Claude CLI
here held about 300–340 MB resident.

Decisions, each the option built:

1. **Idle window: 10 minutes, environment-configurable, 0 disables.**
   Cursor and Pi already detach after 10 minutes (`BridgeLifecycle`); Codex
   uses 30. Seconds would miss most conversational follow-ups, which arrive
   after the user reads an answer; 30 minutes would hold about 300 MB per tab
   long after anyone is looking. The window measures CLI silence. No route
   read extends it, because the backend polls `GET /session/:id` and
   `/activity`. `CLAUDE_BRIDGE_RUNTIME_IDLE_MS` is an operator knob and a kill
   switch, not a user setting yet.
2. **At most 3 idle warm CLIs per bridge, the one idle longest released
   first.** One bridge serves one environment, so this bounds memory per
   environment without backend coordination. A CLI owing a continuation is
   never released for capacity. `CLAUDE_BRIDGE_MAX_IDLE_RUNTIMES`; 0 means no
   warm CLIs.
3. **Live settings are restated; launch-only changes retire an idle CLI.**
   Model, mode, effort, thinking, fast mode, Ultracode and MCP servers already
   go through control requests on every join. A launch-only difference
   (policy, plugins, credentials, structured output, prompt suggestions, 1M
   context, agent, settings sources) retires a CLI that owes nothing and
   launches a new one after the old one exits. A CLI that owes work still
   answers 409, because replacing it would kill that work and running two would
   duplicate the conversation.
4. **No memory limit beyond the window and the cap.** About 300 MB per CLI
   times 3 is the per-environment ceiling for idle CLIs. Watching RSS would
   need a sampling loop for a bound the cap already gives.
5. **Restart forgets warm CLIs.** Nothing is persisted. A bridge that exits
   takes its CLIs with it (they read its stdio and exit on EOF), and the next
   prompt cold-starts from the rollout. A backend restart leaves a bridge that
   survives it running its own windows.
6. **Per-turn bookkeeping: retired now where the warm runtime replaces it.**
   Deleted: the turn-end drain (`closeTurnInput`, `closeSdkInput`), the
   continuation watchdog and its timer (`armContinuationWatchdog`,
   `RETAINED_CONTINUATION_TIMEOUT_MS`, the `retainedContinuationTimeoutMs`
   test hook), control retention (`retainQueryControl`,
   `retainedQueryControls`) and `closeQueryControlIfUnused`: 277 lines out of
   existing sources, against a new 215-line `session-manager-runtime-idle.ts`.
   Kept: the owed-continuation flag and `retainedContinuationRequestIds`,
   which backend workflows read to keep supervising a released dispatch, and
   the task-to-process maps, which carried the strict-owner stop rule. Those
   maps were collapsed into the runtime on 2026-10-27 (see "Assumptions and
   decisions").
7. **A prompt settles at its result.** `sendPrompt` no longer waits for the
   process to exit. A root loop the CLI resumes on its own later (a
   continuation it owed) reclaims the foreground through the latest turn and
   publishes its own idle edge; if the process ends under it, the foreground
   is handed back (`releaseOrphanedForeground`).
8. **A hard abort with nothing running leaves a warm CLI alone.** It answers
   `not_running` instead of killing the process and writing an interruption
   into the transcript. A CLI that owns live work or an owed continuation is
   still stopped.

### Standing constraints

- At-most-once dispatch holds for a prompt written into a warm CLI exactly as
  for a new one. The journal records a message write: the prompt's client uuid
  rides on the input message, and `result.user_message_uuid` stays the
  reconciliation link. A lost acknowledgement must never be left neither
  provably sent nor provably unsent. A join that fails before the write
  (settings, MCP, closed input) is a definitive 409 with nothing written; the
  idle window never fires while a prompt holds `abortController`.
- `rejected` is only a definitive refusal; ambiguity stays `unknown`.
- Unmount is not cancel.
- Never run two CLIs resumed from one rollout. Each would answer its own task
  notifications as the coordinator and duplicate agents; that is why
  launch-only differences get a 409 instead of a second process.
- An interrupt must not kill background tasks (`perTaskStopAffordance`).
- Missing steer is a `false` capability bit, not an error.

## Assumptions and decisions

### Task ownership is the runtime's state (2026-10-27, was Code item 1)

- **Options.** (a) Move the three session maps onto the runtime unchanged,
  still keyed task id → control. (b) Make ownership implicit in the runtime:
  `runtime.tasks` holds a set of live task ids, a set of Bash candidates and a
  map of parked snapshots, and the owner of a task is the session's runtime if
  that set names it. (c) Leave the maps on the session.
- **Choice: (b).**
- **Why.** With one CLI per session every map entry named the same control,
  so the value carried no information. A process that ends releases what it
  owned (`releaseClaudeRuntimeTasks`) before a successor can start
  (`retireDrainingClaudeRuntime` waits for `runtime.ended`), so "the session's
  runtime, if it names the task" is exactly the strict owner: a successor's
  sets are empty, and a stop for an older task answers `no_control_channel`
  instead of reaching a CLI that never started it.
- **Pros.** The state lives and dies with the process; the transcript
  eviction guard no longer needs three map checks (the runtime check covers
  them); `claudeRuntimeOwnsLiveWork` takes the runtime alone; no session field
  can outlive its CLI.
- **Cons.** A turn with no runtime (unit tests that drive handlers on a bare
  session) records no ownership at all, where the old maps recorded an
  `undefined` owner. Teardown (`takeQueryControls`) still clears the sets
  immediately, as it cleared the maps, so a stop between a close and the
  process exit answers `no_control_channel` as before. Tests that read the
  maps now read `runtime.tasks`; the "owned by another query" test simulates
  that by removing the id from the CLI's set.

### Live reads before probes (2026-10-27, was Code item 2)

- **Options.** (a) Models only, from `initializationResult()` of the open
  runtime. (b) Models, account and plan usage from any open runtime on the
  bridge, most recently active first, falling back to the probe. (c) Re-send
  `initialize` (`reinitialize()`) for a fresh answer.
- **Choice: (b).** `live-claude-control.ts`. Models and account come from the
  SDK's held initialize answer (`supportedModels()` and `accountInfo()` are
  the same cached promise in Agent SDK 0.3.309, so nothing is sent). Plan
  usage sends `/usage` on the live control channel, as each turn's own refresh
  already does. Each live answer is bounded (5 s; plan usage keeps its 10 s
  probe bound) and any failure or empty answer moves on to the probe.
- **Why.** The account read is cached for only 30 s, so a tab that polls it
  spawned a CLI every 30 s while a warm one was already running. `reinitialize`
  re-registers hooks and resolves any hook the CLI is waiting on, so it is not
  a read.
- **Pros.** No probe process while a session's CLI is warm; a draining or
  aborted runtime is never asked; no read is a frame, so none extends the idle
  window.
- **Cons.** The answer is from the CLI's launch. A sign-in since then shows up
  only once that CLI is released or no CLI answers: for the account, only a
  signed-in live answer counts, because a signed-out one would keep the
  composer locked after a terminal login only a probe can see; a login revoked
  since is caught by the turn that fails (`noteClaudeAuthenticationFailure`).
  The model list may lag a sign-in by up to the idle window. A CLI launched
  without user and project settings (a coordinator) is skipped, because a
  probe reads those settings and they can narrow `availableModels`; one
  launched without local settings is accepted.

### `startup()` / `WarmQuery` not adopted (2026-10-27, was Code item 3)

- **Measured.** Agent SDK 0.3.309 with its bundled CLI 2.1.309, a throwaway
  `HOME` and `CLAUDE_CONFIG_DIR`, no login, no prompt sent: `query()` to a
  resolved `initializationResult()` took 2,991 ms on the first exec after the
  binary left the page cache, then 211–264 ms (four runs). `startup()` took
  210–235 ms, after which the same read on `warm.query()` resolved in 0 ms. So
  `startup()` saves only the spawn and initialize handshake, about 0.2 s; the
  2026-10-17 table puts a first turn at 4.3–5.2 s against 0.9–1.0 s warm.
- **Options.** (a) Call `startup()` when a session is created. (b) Pre-spawn on
  some earlier signal (tab open, bridge start). (c) `prewarm()` spares. (d) Do
  not adopt.
- **Choice: (d).**
- **Why.** `startup()` fixes every option at spawn, and a Claude launch's
  options come with the prompt: the resumed session id, the turn's abort
  controller, hooks and `canUseTool` bound to that turn, its MCP servers,
  plugins, policy and model. (a) has no lead time, because the backend creates
  a session on its first prompt. (b) has no signal on the bridge surface: the
  backend polls `GET /session/:id` all the time, and catalogue reads must not
  re-attach; and a speculative CLI holds about 300 MB. (c) is `@alpha`, its
  `claim()` cannot resume a session, and it fixes hooks, MCP servers and
  plugins at prewarm. The rest of the cold first turn (resume, MCP connects,
  plugins, the first model call) is paid after the prompt either way.
- **Pros.** No speculative process or second launch path.
- **Cons.** The first turn in an environment still pays its spawn; with
  the bridge's own probes paging the binary in, that part is about 0.2 s.

### Cursor `force` deferred (2026-10-27, was Code item 4)

- **Options.** (a) Send with `local.force` whenever a send finds an active
  run. (b) Only after `recoverActiveRun` re-adopts a run that never
  progresses. (c) Leave it unused until a wedged agent is seen.
- **Choice: (c).**
- **Why.** `force` expires the agent's active persisted run. `recoverActiveRun`
  re-adopts a run that survived a bridge restart and tails it; forcing past it
  would cancel live work, which interrupt and unmount must never do. No wedged
  agent has been observed, and there is no field evidence here to tell a
  wedged run from a slow one.
- **Pros.** Nothing can expire a working run.
- **Cons.** An agent wedged by a crashed CLI still needs the user to stop it.

## Needs verification

- **Live reads with a real login.** The live-first model, account and plan
  usage reads are proven against the SDK source (the cached initialize promise)
  and mocked controls only. On a throwaway profile with a real login, confirm
  that with one warm CLI the model picker, the account card and the plan-usage
  panel answer without a new `claude` process, and that a probe still runs once
  the CLI is released.
- **Stop after several turns on a real CLI.** Start a background agent,
  send two follow-ups into the same warm CLI, then stop the agent: it must stop
  (`ok`) and its snapshot settle; after the CLI is released, a stop for a task
  it owned must answer `no_control_channel`.
- **First-turn cost split.** The 0.2 s spawn measurement used a bare
  configuration with no MCP servers, plugins or login. How much of a 4–5 s
  first turn with the bridge's real launch options is resume, MCP connects and
  the first model call is not measured.

## Related

- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md) (steer
  history, close and cancel alignment).
- [`bridges/claude-bridge/AGENTS.md`](../../../bridges/claude-bridge/AGENTS.md#one-row-per-model-response)
  (the same Claude prompt files; from todo 0013, retired on 2026-10-29).
- [0004-composer-model-parameters.md](0004-composer-model-parameters.md) (mid-session
  parameter changes ride on item 1).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for the Claude and Cursor runs.
- [platform-inconsistencies.md](../../architecture/platform-inconsistencies.md).

## Replaces

- `docs/plans/sdk-coverage/05-mid-turn-control-steer-and-interrupt.md`
- `docs/plans/sdk-coverage/15-adapter-simplification.md` (Claude warm query,
  model catalogue, background-task reconciliation)
- `docs/plans/sdk-coverage/10-composer-model-axes-and-settings.md`
  ("mid-session change via `setModel()`/`applyFlagSettings()`")
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.1; Cursor §6.3, §6.6;
  Pi §8.2; Tier 3 rows 25, 26 and 30)
