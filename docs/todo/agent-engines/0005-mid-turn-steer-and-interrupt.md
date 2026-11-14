# Mid-turn steer and interrupt

Checked against `main` at `0658de646` (2026-11-01) for tasks 1, 2, 3 and 9,
at `c98b20e6f` (2026-11-10) for task 8, and at `17d28238c` (2026-11-13) for
task 7; the other tasks were last checked at `863b5782` (2026-10-27).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; tasks 1, 2, 3 and 9 rechecked
2026-11-01 against `0658de646` at Agent SDK and CLI `0.3.314` / `2.1.314`;
task 10 added and built 2026-11-08 against `02f55ea9b`; task 8 built and run
2026-11-10 against `c98b20e6f` at Agent SDK and CLI `0.3.319` / `2.1.319`;
task 7 built and run 2026-11-13 against `17d28238c`.

### Tasks

1. **Collapse Claude task-to-process maps**: move `backgroundTaskControls`, `backgroundTaskCandidates` and `settlingBackgroundTasks` into runtime state. Status: done (landed in #1331; rechecked 2026-11-01).
2. **Live Claude model catalogue**: read models from the live runtime instead of a separate control-only probe. Status: done (live read landed in #1331; the probe cache and its bound added 2026-11-01).
3. **Warm first Claude turn**: avoid the cold spawn on an environment's first turn, then measure. Status: closed, not adopted (measured 2026-11-01; see "`prewarm()` not adopted").
4. **Cursor `SendOptions.local.force`**: use it for a wedged agent. Status: deferred (until wedged agents are seen).
5. **OpenCode steer**: needs OpenCode 2.x. Status: done for OpenCode 2.x sessions (built by 0008 (retired) task 5 behind its opt-in preview, merged in #2009 on 2026-11-09; 0008 task 10, the steer spike, was done on 2026-11-08). OpenCode 1.x never could steer, and was retired on 2026-11-11, so every OpenCode session is a 2.x session and can steer (see 0008 "OpenCode 1.x retired (2026-11-11)"). Live qualification of 2.x steer belongs to 0008 task 7, done for host environments on 2026-11-11 (a composer steer through the app on a scripted model, and the live provider and steer tests on Linux). Since task 10 below, an expected-turn precondition is no longer needed: OpenCode 2.x starts a new run for a steer that reaches an idle session, which is the behaviour the owner wants everywhere.
6. **Grok steer**: ACP has no mid-turn input; interjection stays behind its unsafe flag. Status: blocked (ACP / Grok).
7. **Inactive-path steer qualification on Claude and Cursor**: parameterise the Codex inactive-path steer spec by platform for Claude and Cursor (steer, switch away, return, reload). Status: done (2026-11-13: `e2e/agent-testing/steer-inactive-live.spec.ts` runs it for Codex on a real model and for Claude and Cursor on scripted models; both passed; see "Inactive-path steer on scripted models"). The runs with real Claude and Cursor logins are in 7568.
8. **Warm Claude CLI app-path qualification**: follow-up, mode and permission changes, parked approval and MCP change on one CLI through the app. Status: done (2026-11-10, loopback model; see "One warm CLI through the app"). The same reads with a real login moved to 7568 (2026-11-10).
10. **A steer that misses its turn starts a new turn, on every provider**: the owner's rule (2026-11-08). Status: built (2026-11-08 against `main` at `02f55ea9b`; see "A missed steer becomes the next turn"); open for its live check on real bridges, which an agent can run with scripted models (see "Needs verification").

### 1. Collapse Claude task-to-process maps

**Problem.** Background-task stop and runtime teardown still go through per-control maps that, with one CLI per session, only ever name that session's runtime. The indirection is a source of ownership bugs.

**Context.** Decision 6 in "Warm Claude runtime" kept these maps because they carry the strict-owner stop rule. 0013 (Claude prompt-stream state) touches the same files; 0004 says mid-session parameter changes ride on this item.

**Recheck, 2026-11-01.** Done on `main`, so the rest of this section is history. None of the three names is left in the code. `runtime.tasks` (`ClaudeRuntimeTasks` in `session-manager-background-tasks.ts`) holds them, `backgroundTaskOwner` is the strict-owner rule and `endClaudeRuntime` settles them through `releaseClaudeRuntimeTasks`. The build took a third option to the two below: no generation counter, because a process releases everything it owned before a successor can start (see "Task ownership is the runtime's state"). No code changed here.

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

**Recheck, 2026-11-01.** The live read was on `main` already (`live-claude-control.ts`). It reads `initializationResult()` rather than `supportedModels()`, which at SDK 0.3.314 is still the same held promise (`supportedModels(){return(await this.initialization).models}` in `sdk.mjs`), so the two recommended options below give one answer. The cold probe was still uncached and unbounded. That part is now `claude-model-catalog.ts`; see "Model catalogue: what a read may reuse".

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

**Recheck, 2026-11-01.** Assessed at SDK `0.3.314` and closed without adopting either surface. The recommended `prewarm()` does not fit, for reasons the code and a measurement give; see "`prewarm()` not adopted". The surfaces are now at `sdk.d.ts:2904` (`prewarm`), `:9794` (`SpareProcess`), `:332` (`ClaimOptions`) and `:9970` (`startup`).

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

**Recheck, 2026-11-10** (against `main` at `04639b12b`). The paragraph above is history. 0008 built an `opencode2` provider behind an opt-in preview (#2009). The OpenCode platform table now offers `steer` (`packages/protocol/src/native-agent.ts`, the comment above OpenCode's actions), and each session answers through `steerSupported()`: true for a 2.x session (`apps/backend/src/core/opencode2/provider.ts`, routed by `opencode2/routing-provider.ts`), false for every 1.x session (`apps/backend/src/core/opencode-provider.ts`). Both of those 1.x-era files were retired with OpenCode 1.x on 2026-11-11 (`git show 5f4e27b1c:<path>`; the router is now `opencode2/environment-provider.ts`), and every OpenCode session now answers true. The steer guard 0008 task 10 proved on 2.2.6 is `opencode2/steer.ts`, with `opencode2-steer.live.test.ts` against the real binary.

**Decisions.** None: built in 0008 for 2.x sessions; 1.x had no steer to adopt and is retired. The file already rules out a coordinator-only workaround.

### 6. Grok steer

**Problem.** Grok users cannot steer.

**Context.** The interjection extension is gated by `GROK_UNSAFE_EXPERIMENTAL_INTERJECTION=1` (`bridges/acp-bridge/src/acp-session.ts:2042`).

**Investigation.** Still blocked. `@agentclientprotocol/sdk` is now `2.0.1` (v1 and v2 schemas under `dist/`), with no steer or mid-turn input surface found in its type declarations. The file's "Grok: `actions: {}`" is stale: Grok now declares `{ compact: true }` (`packages/protocol/src/native-agent.ts:1113`).

**Decisions.** None: blocked upstream; recheck on each ACP SDK or Grok bump.

### 7. Inactive-path steer qualification on Claude and Cursor

**Problem.** Steer recovery after switching away and reloading is unproven for Claude and Cursor.

**Context.** Batched in 0031 (Claude and Cursor rows). This task is the spec
work; running it with real Claude and Cursor logins is in the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md)
(2026-11-10).

**Investigation.** A real-stack spec existed for Codex only: "queued native steering survives a lost gateway response, inactive environment and reload" (then in `e2e/agent-testing/browser-gateway.spec.ts`, opt-in, `agent: "codex"`; now `e2e/agent-testing/steer-inactive-live.spec.ts`).

**Decisions.**

- **Manual run or extend the spec?**
  - **Parameterise the existing Codex spec by platform and run it for Claude and Cursor (recommended).**
    - Pros: repeatable; reuses a proven scenario.
    - Cons: needs Claude and Cursor credentials in the profile; Cursor queue semantics may differ.
  - **One-off manual run.**
    - Pros: faster today.
    - Cons: no regression guard.

**Done, 2026-11-13.** Built as the recommended option, with scripted models
in place of the Claude and Cursor credentials: the scenario moved into its
own spec, one case per platform, and the Claude and Cursor cases passed
three runs in a row on a credential-free profile. See "Inactive-path steer on
scripted models" under "Assumptions and decisions".

### 8. Warm Claude CLI app-path qualification

**Problem.** The warm CLI was qualified only at bridge level; the app path (composer changes, approvals, MCP changes on one process) is not.

**Context.** Decision 3 depends on live settings being restated on every join.

**Investigation.** Bridge tests cover join, window, cap, replacement and reclaim (`session-manager-runtime-idle.test.ts`). No browser or CLI scenario asserts the process id stays the same.

**Done, 2026-11-10.** Built as the recommended option and run through the app on a loopback model; see "One warm CLI through the app" under "Assumptions and decisions". Every step kept generation 1, and the launch-only switch to bypass mode moved it to 2.

**Decisions.**

- **How to prove "same process"?**
  - **Expose the runtime generation in the bridge's content-free runtime health and assert it is unchanged across the steps (recommended).**
    - Pros: observable from the app and CLI; no PID scraping.
    - Cons: small bridge change.
  - **Read the PID from `ps` during the run.**
    - Pros: no code.
    - Cons: fragile; PID checks conflict with the shared-host rules.

Users should be able to redirect or stop a running turn without losing work, on
every provider whose vendor surface allows it. Steer and the graceful abort
ladder are live on Claude, Codex, Cursor and Pi. Claude's CLI now stays warm
between turns and releases itself after an idle window, so a follow-up is
written into the running process. Background-task ownership is that
process's own state, and bridge-wide reads (models, account, plan usage) ask a
running CLI before spawning a probe. The inactive-path steer is proved
through the app for Codex, Claude and Cursor (task 7). What is left for
agents is the live check of the missed-steer rule and of a stop after several
turns, on real bridges with scripted models. OpenCode steer works on every OpenCode
session (OpenCode 2, the only line since 1.x was retired on 2026-11-11). Grok steer is
blocked upstream and is recorded here; the Cursor `force` send is deferred
until a wedged agent is seen.

### 10. A steer that misses its turn starts a new turn

**Problem.** A steer can lose the race with the end of its turn. The owner's
rule (2026-11-08) is that it must then start a new turn, on every provider,
rather than being refused and left for the user to resend.

**Context.** A provider answers `idle` (no turn is running) or `mismatch` (a
different turn is running), and both are definitive "not sent" answers. Each
entry point handles them differently:

| Entry point | `idle` today | `mismatch` today |
| --- | --- | --- |
| Agent mail (`agent-mail-service.ts`) | delivered as a turn at once | held, delivered after the running turn |
| Queue Steer button and Auto-steer (`steerQueuedPrompt`) | stays queued, sent when the queue drains | stays queued |
| Composer `/steer` (`AgentNativeTab.controller.tsx`) | error, draft restored | error, draft restored |
| Agent Info steer box (`AgentInfoButton.tsx`) | error | error |
| Public CLI steer (`public-api/actions-session-controls.ts`) | fails, `session-idle` | fails, `target-mismatch` |
| Recovery retry of a parked steer (`retryRecoverableDispatch`) | "There is no active turn to steer." | "The active turn changed…" |

Agent mail already follows the rule and is the model. The queue paths end up
there too.

**Built, 2026-11-08.** The table above is the state before the change. Every
row now delivers the text: the direct `/steer`, the Agent Info box, the CLI
and the recovery retry of a parked steer send it as a new turn on `idle` and
queue it on `mismatch`; the queue paths were checked and left as they were.
The rest of this section is the decision record it was built from.

**Investigation.** All the refusals come from one backend function,
`performProjectionSteer` (`native-agent-prompt-dispatch.ts`), and from the recovery
retry. That makes a backend-owned fix possible, which the renderer, Agent Info
and the CLI then share. `idle` and `mismatch` are both proven "not sent"
answers: the bridge clears its steer record before answering, and the
backend's pre-check sends nothing. So sending the text again cannot deliver it
twice, provided it goes out under its own request id through the ordinary
at-most-once dispatch.

**Decisions.**

- **Where does the fallback live?**
  - **In the backend, beside `performProjectionSteer` and the recovery retry (recommended).**
    - Pros: one rule for every caller, CLI and remote nodes included; reuses the mail path's "deliver it the ordinary way" dispatch.
    - Cons: the backend has to choose the turn's controls (model, effort, mode) itself, from the session's persisted controls, as mail does.
  - **In each caller.**
    - Pros: callers keep the composer's own controls.
    - Cons: four implementations; the CLI and remote nodes would each need their own.
- **What does `mismatch` do?**
  - **Queue the text as the next turn (recommended).**
    - Pros: never interrupts the turn that is now running, which the user may not have seen start; matches mail and the queue paths.
    - Cons: the message waits for that turn to finish.
  - **Steer it into the turn that is now running.**
    - Pros: delivered sooner.
    - Cons: the instruction lands in a turn it was not written for, which is what the expected-run check exists to prevent.
- **How is the result reported?**
  - **Keep `applied` and add an optional `deliveredAs: "new-turn" | "queued"` (recommended).**
    - Pros: older renderers and remote peers still see success; no new outcome variant to version.
    - Cons: an older client says "Sent to the active turn" for a message that started a new one.
  - **A new outcome variant.**
    - Pros: explicit.
    - Cons: a contract change that every peer in the support window must understand ([version-compatibility.md](../../architecture/version-compatibility.md)).
- **CLI.** The public steer action admits a request key and settles on its own records ([public-cli.md](../../architecture/public-cli.md)). Starting a turn under it means its receipt has to report the dispatched request, and the `session-idle`/`target-mismatch` failures change meaning. Recommended: do it in the same change, with the contract change recorded per version-compatibility.md, rather than leaving the CLI on the old rule.

## Current state

- Steer is on Codex, Claude, Cursor and Pi (`actions.steer` in
  `nativeAgentCapabilities()`, `packages/protocol/src/native-agent.ts`). The
  backend qualifies it at runtime with `HttpBridgeProvider.steerSupported`,
  which probes `/session/:id/steer/dispatch`. No platform is hard-coded.
- A steer that misses its turn becomes the next turn (task 10).
  `performProjectionSteer` hands an `idle` or `mismatch` answer to
  `deliverMissedSteer` (`native-agent-missed-steer.ts`): an ordinary turn now
  when nothing is running, the prompt queue otherwise, reported as `applied`
  with `deliveredAs: "new-turn" | "queued"`. `onMissedTurn: "refuse"` keeps
  the old answer for a caller bound to one run (the CLI's `--expect-run`).
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
    `claude-model-catalog.ts`) and the account (`probeAccount` in
    `claude-sign-in.ts`) ask an open runtime first
    (`live-claude-control.ts`), from its held initialize answer. A control-only probe runs only
    when no running CLI answers. For models it is shared, bounded and reused
    until the CLI file or the account changes; the static catalogue answers
    only when the probe fails. MCP actions already used the session's live
    control and probe only without one.
  - `startup()`, `WarmQuery` and `prewarm()` are not used: measured, what they
    save is small against a first turn, and a spare cannot resume or take a
    launch decided by the prompt (see "Assumptions and decisions").
  - Each CLI the bridge launches takes the next number from a bridge-wide
    counter. `/session/:id/runtime-health` serves it as
    `summary.runtimeGeneration` beside `attached`/`detached`, and Agent Info
    shows it as "process N" (task 8).
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
- OpenCode: `steer` on every session (OpenCode 2.x, the only line since
  2026-11-11; 0008).

## Outstanding work

### Deferred

- **Cursor `SendOptions.local.force`.** The SDK documents it as expiring the
  agent's active persisted run before a new follow-up, a recovery path for an
  agent left wedged by a crashed CLI. It stays unused until
  `recoverActiveRun` is seen re-adopting a run that never progresses; see
  "Assumptions and decisions".

### Blocked

- ~~**OpenCode steer** needs OpenCode 2.x: `POST /api/session/:id/prompt` with
  `delivery: steer`. Even 2.x has no expected-turn precondition, so a native
  `/steer` must not be advertised until one exists.~~ No longer blocked
  (2026-11-10): 0008 built it for OpenCode 2.x sessions behind the opt-in
  preview (#2009), with the backend-held guard of its task 10 in place of an
  upstream precondition. 1.x sessions could not steer; 1.x was retired on
  2026-11-11, so every OpenCode session can. Its live qualification is
  0008 (retired; `git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`) task 7 (host environments done
  2026-11-11, containers 2026-11-13). Steer through the public CLI and the
  coordinator's deliver-now was allowed for OpenCode on 2026-11-14, once a
  scripted-model CLI scenario qualified it
  ([7905](7905-opencode2-untested-paths.md) task 4).
- **Grok steer** stays off. ACP v1 has no mid-turn input, and the Grok
  interjection extension stays behind its unsafe flag until an ACP equivalent
  exists.
- Grok gets no coordinator-only workaround. Coordinators need nothing more:
  they do not opt out of `actions.steer`, so they get steer here once it
  exists. This is the only place the gap is tracked (moved from todo 0028,
  retired on 2026-10-29).

### Qualification

- ~~Browser, inactive path, on Claude and Cursor (task 7): start a long turn,
  steer it, switch environment, return and reload. The steered message and its
  outcome must come back from the snapshot.~~ Done 2026-11-13 on scripted
  models (`steer-inactive-live.spec.ts`); the runs with real logins are in the
  manual-test checklist.
- ~~Through the app, on one warm Claude CLI: a follow-up, a plan-mode toggle, a
  permission-mode change, a parked approval answered after a pause, and an MCP
  server added and removed between turns.~~ Done 2026-11-10 on a loopback model
  (task 8, `claude-warm-runtime-live.spec.ts`): one CLI took every step, and
  each change was seen where it acts.
- Through one warm CLI: stopping a background task started two turns earlier
  reaches it (see "Needs verification"). The real-login reads (model picker,
  account card, plan-usage panel) moved to the manual-test checklist on
  2026-11-10.

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
  A CLI launched under another account than the last account read saw no
  longer answers for models (2026-11-01), so the list lags a sign-in only until
  an account read notices it. A CLI launched
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

### Model catalogue: what a read may reuse (2026-11-01, task 2)

- **Options.** (a) No cache: a probe per read when no CLI runs. (b) Cache keyed
  by CLI and account, invalidated on change (the option marked recommended).
  (c) Rely on the backend's own 5-minute catalogue cache.
- **Choice: (b)**, in `claude-model-catalog.ts`. A read takes the first that
  answers: a running CLI, the kept answer, one shared probe, the static
  catalogue. The static answer reports `source: "fallback"` and is never kept.
- **Why.** The backend's cache still costs a process every 5 minutes for as long
  as a tab is open with no CLI running, and parallel reads each spawned their
  own. The read also had no time limit of its own, which sharing a probe would
  have made dangerous: a wedged CLI would have held every later read.
- **What differs from the recommendation.**
  - The key uses the CLI file's path, size and modified time instead of its
    version, so checking it runs nothing (`--version` is a process).
  - An hour's expiry is added as a backstop, because a terminal login with no
    account read in between reports nothing.
- **Decisions inside it.**
  - The account comes from the same initialize answer, so it costs no request.
    The answer is compared with the account the last account read saw, without
    starting a read. A failed read says nothing and keeps the answer.
  - Only a signed-in answer naming its account is kept. A signed-out list would
    otherwise have to wait for the login to be noticed.
  - A running CLI's answer is kept too, so the read after it is released spawns
    nothing. It carries the same launch-time staleness as the live read.
  - An explicit refresh (`POST /global/refresh-catalog`) drops the answer, and a
    probe already running at that moment answers its reader without being kept.
  - A probe gets 25 s, inside the backend's 30 s request limit.
- **Pros.** At most one probe an hour per account and CLI with no running CLI,
  against up to twelve; no process pile-up.
- **Cons.** A model added server-side with no CLI or account change reaches users
  after a refresh or within the hour. A coordinator's CLI is still skipped for
  reads, as before.

### `prewarm()` not adopted (2026-11-01, task 3)

- **Measured.** `mise run measure:claude:first-turn`
  (`claude-first-turn.live-probe.ts`): the pinned CLI and the real bridge against
  a local scripted model, with a fake key and a throwaway `HOME`. No login, no
  billed turn. The model answers at once, so each figure is what the turn pays
  *before* the model: milliseconds to the first model request, median of five.
  Two sessions on the same host: an earlier one (load not recorded) and one
  saturated by parallel builds (load about 43):

  | Case | Earlier: cold / spare / warm | Busy: cold / spare / warm |
  | --- | --- | --- |
  | SDK, bare | 128 / 54 / 8 | 986 / 355 / 66 |
  | SDK, 3 stdio MCP servers | 169 / 91 / 9 | 1,284 / 416 / 56 |
  | SDK, a 2 s MCP server, inline | 2,175 / 2,089 / – | 3,005 / 2,411 / 115 |
  | SDK, a 2 s MCP server in `.mcp.json` | 2,140 / 2,077 / – | 2,727 / 2,284 / 106 |
  | SDK, non-essential traffic on | 244–487 / 48–55 / – | 893 / 272 / 52 |
  | Bridge route, bare | 197 / – / 21 | 1,296 / – / 173 |
  | Bridge route, `.mcp.json` | 227 / – / 21 | 1,228 / – / 149 |

  The earlier column took five runs except the 2 s and traffic rows (three). A
  spare held 164–179 MB resident and was ready in about 100 ms (600 ms busy).
  The first exec of the binary this session, on an external volume, took 2,582 ms.
- **What a spare does.** It saves 75–630 ms: the process start. It made no model
  request while parked; with non-essential traffic on it sent one `HEAD /api/hello`,
  carrying only the fake key here.
- **What it does not do.** A slow MCP server holds the first model call either
  way: the spare's 2 s server still cost 2 s after 1.5 s parked, so it was not
  connected ahead of the claim, despite the SDK's description.
- **What the SDK refuses or fixes** (proved by `claude-first-turn.live.test.ts`,
  `mise run verify:claude:first-turn-live`). `prewarm({ resume })` throws: "a spare
  has none". A `sessionId` given at prewarm is kept, and `ClaimOptions` has no
  `sessionId`, so a spare keeping the bridge's deterministic id belongs to one
  session already, not to an environment.
- **Options.** (a) The recommended `prewarm()` spare, claimed by the first prompt.
  (b) `startup()` on tab open. (c) A spare only for a new session on a matching
  profile. (d) Do not adopt, and close with this evidence.
- **Choice: (d).**
- **Why not the recommendation.** Against `claudeQueryOptions`:
  - Every reopened conversation resumes, and a spare cannot.
  - The first turn's `agentMcp` URL and bearer token are resolved per dispatch
    (`resolveAgentMcp` in `native-agent-prompt-dispatch.ts`) and `mcpServers` is fixed at
    prewarm, so an ordinary first turn would miss the spare or start without the
    Orkestrator tools a workflow result needs.
  - `allowedTools`, `disallowedTools`, the read-only hook, the sandbox and
    `allowDangerouslySkipPermissions` are fixed at prewarm and follow the prompt's
    policy and approval mode. Claiming on a mismatch would run a turn with tools
    pre-approved that the user did not choose; a miss wastes the spare.
  - `env` carries the GitHub credential the turn's policy decides, also fixed.
  - The bridge has no tab-open signal, and `prepareDispatch` arrives immediately
    before the prompt, so it gives no lead time.
  - `prewarm()` is still `@alpha`.
  - (c) keeps all of this but the resume, for the same saving and a second launch
    path into the turn lifecycle.
- **Also tried, not adopted, one run each on the busy host, a 2 s server beside a
  fast one.** `MCP_CONNECTION_NONBLOCKING=true`: 2,833 ms against 2,862, no gain.
  `MCP_TIMEOUT=500`: 1,266 ms, but only by giving up on any server slower than
  that, which a real server can be.
- **The billing and account rule.** Nothing was built, so no warm process exists
  to start a turn or hold an account. A future spare would need the proof above
  that parking calls no model. It parks on the bridge's own login, and an account
  switch replaces the bridge, so the spare would go with it.
- **Pros.** No speculative 165–180 MB per tab, no second launch path, and no
  chance of a claim running under a boundary the prompt did not ask for.
- **Cons.** The first turn keeps its 0.1–0.6 s process start. The 4.3–5.2 s
  against about 1 s in the "Warm Claude runtime" table is **not explained** by this
  fixture: a no-login cold turn reached the model in about 0.2 s through the bridge.
  The rest is outside what can be measured without a login (see "Needs verification").
- **Reopen if** a real-login split shows a large part a spare would save, or the
  SDK makes `claim()` accept `resume` and inline MCP servers.

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

### A missed steer becomes the next turn (2026-11-08, task 10)

Built as the four recommended options above. What follows is each choice the
build had to make inside them.

- **Where the fallback lives.** In the backend, as the recommendation said.
  `performProjectionSteer` (`native-agent-prompt-dispatch.ts`) now calls the
  unchanged steer (`steerProjectionOnce`) and hands an `idle` or `mismatch`
  answer to `deliverMissedSteer`, a collaborator in
  `native-agent-missed-steer.ts`. It is a new file because the service is
  already over 4,600 lines. The composer, Agent Info, the CLI and the voice
  `steer_session` tool all reach it through `perform_native_agent_session_action`.
  The queue's own steer and a queued async-question answer
  (`dispatchQueuedAsyncQuestionAnswer`) call `steerProjectionOnce` directly:
  their text is already in the queue, so a fallback there would send it twice.
- **How the new turn is sent.** Through the ordinary dispatch path
  (`dispatchIntentInternal`, the composer's own journal), not
  `dispatchMailInject`. Options: (a) the mail path, which also holds for a
  composer draft and marks a coordinator turn as mail; (b) the ordinary path
  with an admission check under its fence. Chose (b): this is the user's own
  text, so it is a user turn and the user's draft must not hold it. The text
  is literal (`allowProviderCommands: false`), the model and effort come from
  the session's persisted controls, and no mode is sent, which is exactly what
  mail does. The admission check (a new optional `prepare` threaded through
  `attemptDispatch`) holds the turn when the queue has a backlog or the
  provider no longer reads `idle`; a held admission opens no journal entry.
- **When an `idle` miss is queued instead.** If, under the fence, a turn has
  started or a prompt is already queued, the text is queued behind them
  (`deliveredAs: "queued"`), FIFO. Options: append, or put it at the head.
  Appending keeps the order the user typed in and needs no whole-queue
  rewrite; the cost is that "the next turn" is the next after the backlog.
- **The queue item.** `{ id, requestId, text, command: { kind: "literal" },
  preserveSessionMode: true }`, the shape a goal continuation uses, added with
  `enqueuePromptQueueMessageIfAbsent` so a replay of the same id is never
  queued twice. It is an ordinary row: the user can edit, remove or steer it.
- **Request ids.** The new turn never reuses the steer's id: the bridge has
  already seen that one (Claude uses it as the message uuid). The backend
  mints one, or uses the action's new optional `turnRequestId`. The CLI
  passes its operation id, so the dispatch request, the queue item and the
  receipt share one identity and a replay finds the same turn.
- **Reporting.** `applied` with an optional `deliveredAs: "new-turn" |
  "queued"` on `NativeAgentSessionActionOutcome`, and the same optional field
  on the accepted `NativeAgentDispatchOutcome` for the recovery retry. Per
  version-compatibility.md a new optional field needs no domain bump; the
  contract manifest was regenerated (the result schemas of four commands
  changed; no argument schema did). An older renderer or peer reads plain success, so it says
  "Sent to the active turn" for a message that started a new one, the
  accepted cost of this option.
- **A caller bound to one run.** Added `onMissedTurn: "refuse"` to the steer
  action. The CLI sends it with `--expect-run`, whose documented meaning is
  "only steer if this run's turn is active"; delivering it as a new turn would
  break that promise, so those still fail `session-idle` / `target-mismatch`
  and send nothing. An older backend ignores the field and refuses anyway.
- **CLI receipt.** Converted, not left on the old rule. `session.steer`
  succeeds with `result.deliveredAs`, `resources.dispatchRequestId` set to the
  operation id, and `dispatch: accepted` (new turn) or `pending` (queued; the
  drainer sends it outside this operation, so the receipt is not updated
  later). It stays a receipt, not a run: making it a run would need the run
  observer to own a second action and a public action version bump, which a
  delivery report does not need. The public action version stays 1: the
  receipt's success still means "the text was delivered". Receipts stay
  content-free (tested).
- **Recovery retry of a parked steer.** If the retry's steer answers `idle` or
  `mismatch`, a steer from the composer is delivered the same way under a new
  id and the retry answers `accepted` with that id and `deliveredAs`;
  `run.retry` records both on the steer's receipt. A steer taken from the
  queue was put back there by the steer journal, so the retry only says so
  ("…returned to the queue and is sent as the next turn"). An `unknown`
  steer keeps today's handling everywhere.
- **Renderer.** The composer `/steer` and the Agent Info box clear the draft on
  every `applied` and show `directSteerNotice` (`auto-steer.ts`): "Sent to the
  active … turn", "… finished the turn first, so your message was sent as a
  new turn." or "Your message missed the active turn, so it was queued as the
  next turn." Their `idle`/`mismatch` errors stay for an older backend. Queue
  Steer and Auto-steer were checked, not changed: `steerQueuedPrompt` answers
  `idle` before reserving the item, and a `mismatch` restores it through
  `completePendingSteer`, so the message waits and the drainer sends it; their
  notes already say so.
- **Not changed.** A `/steer` typed while the composer itself shows no running
  turn is still answered locally (`idleSteerPromptReply`): that steer never
  had a turn to miss. Bridges are unchanged.

### One warm CLI through the app (2026-11-10, task 8)

Built as the recommended option: the bridge reports a runtime generation, and
an opt-in spec drives one Claude tab through the app and asserts it.

- **Where the number comes from.** `createClaudeRuntime`
  (`session-manager-runtime.ts`) takes the next value of a counter shared by
  the whole bridge process and keeps it on the runtime and on the session
  (`claudeRuntimeGeneration`), so a released CLI is still named. Options:
  (a) a per-session counter; (b) a bridge-wide counter. Chose (b): a session
  record dropped and rebuilt in the same process (close, then resume) can never
  show a number an earlier CLI had. The cost is that a session's first CLI may
  be "process 7". Either way the counter restarts with the bridge, which also
  ends every CLI (decision 5), so no two live processes share a number.
- **How it travels.** `summary.runtimeGeneration` in `/session/:id/runtime-health`,
  only once a CLI has launched; the backend copies a positive safe integer into
  `NativeAgentRuntimeSummary.runtimeGeneration`, unclamped because it is
  compared for equality. A new optional field, so no contract or domain bump.
  Agent Info shows it beside the state ("attached · process 1"). It is a bare
  counter: no PID, nothing about the host.
- **The app-path run.** `e2e/agent-testing/claude-warm-runtime-live.spec.ts`
  (opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_WARM_CLAUDE=1`) on a credential-free
  `dev:test` profile (`--no-agent-credentials --agent-platforms claude`), the
  real Claude CLI 2.1.319, bridge and backend, with only the model replaced by
  the scripted loopback endpoint (`mcp-fake-model.ts`). It drives the tab
  through the backend commands the composer and cards use
  (`update_native_agent_controls`, `dispatch_native_agent_intent`,
  `resolve_native_agent_interaction`, `mutate_mcp_definition`) and reads the
  generation from the session projection after waiting out the backend's
  30-second runtime-metadata cache. Passed on beelink2 (Linux) on 2026-11-10,
  profile `wrm8`:

  | Step | Generation | What showed the change took effect |
  | --- | --- | --- |
  | First turn, then a follow-up | 1, 1 | Both replies |
  | Plan mode on, then off (composer mode) | 1, 1 | The CLI sent the model its plan-mode notice, then stopped |
  | Bash approval parked 56 s, then approved | 1 (also 1 while parked) | One command approval; the command ran |
  | Approval mode to accept edits | 1 | A file write ran with no approval |
  | MCP server added (save and apply) | 1 | The probe server logged the call (accept edits asked once; approved) |
  | MCP server removed | 1 | No call logged |
  | Approval mode to bypass | 2 | Launch-only, so the idle CLI was replaced, as decision 3 says |

- **What the runs found.**
  - A session starts in bypass mode, and leaving bypass is launch-only
    (`allowDangerouslySkipPermissions` is fixed at launch). So switching a warm
    tab from Bypass to Default or Accept edits in the composer starts a new
    CLI; the first run did exactly that. The spec therefore picks the asking
    mode before the first prompt and checks the bypass switch separately.
    This is decision 3 working as designed, recorded here because it is the
    one composer change a user makes often that is not live.
  - The backend serves runtime health from a 30-second cache and refreshes it
    in the background, so a read just after a relaunch can show the previous
    number (the first run read 1 while generation 2 was running). The spec
    reads twice past the expiry; `agent-engines.md` says so.
  - CLI 2.1.319 sends its plan-mode notice as a `system`-role message after the
    prompt, not as a reminder inside it; the fake model reads it there.
- **Tests.** Bridge: `session-manager-runtime-idle.test.ts` (the number holds
  across a follow-up, a plan-mode and model change and a parked approval,
  survives release, and advances on release and on a launch-only replacement;
  two sessions never share one) and `routes/runtime-health-body.test.ts`.
  Backend: `http-bridge/runtime-health.test.ts`. Renderer:
  `AgentInfoButton.steer-rejection.test.tsx`. Fake model:
  `mcp-fake-model.test.ts`.
- **Not covered.** A real login and model (billed), a container environment
  (the fake-model wiring is local only), and a model change through the app
  (the loopback model answers any model name, so it would prove only that the
  turn ran; the bridge test covers `setModel` on the warm CLI).

### Inactive-path steer on scripted models (2026-11-13, task 7)

Built against `main` at `17d28238c`. The Codex scenario ("queued native
steering survives a lost gateway response, inactive environment and
reload") now has one case per platform in
`e2e/agent-testing/steer-inactive-live.spec.ts`. Each case starts a long
turn, queues two prompts, steers the first from the Queued Prompts dialog
while the browser drops the command's response, switches to another
environment until the steer has taken effect, then returns and reloads. The
queue must hold only the second prompt, from the backend's snapshot, and the
steer must have reached the agent exactly once.

- **Claude's model.** Options: (a) the profile's real Claude CLI and bridge
  on a scripted loopback Anthropic endpoint; (b) a fake Claude bridge. Chose
  (a), as the warm-CLI run (task 8) did: the CLI's own handling of a
  `priority: "now"` steer is part of what is proved. The script
  (`steer-inactive-fake-claude.ts`) writes the ready file, keeps the turn
  running with short `sleep` calls, and appends the steer's marker once per
  delivery, looking for the steer in every user text of the request because
  the CLI decides where mid-turn input goes. The request carries the whole
  conversation, so the number of steer texts in it is the number of
  deliveries; a duplicated steer makes a second append and the case's
  exactly-once check on `.qa-queued-received` fails (review round 1). Its
  decisions are pinned by `steer-inactive-fake-claude.test.ts`.
- **Cursor's engine.** Options: (a) swap the profile's Cursor bridge entry
  (`bridges/cursor-bridge/dist/index.js`, what the host launch runs) for a
  bundle of the bridge over its fake SDK for the length of the case, as the
  Docker cells swap the image's entry (0001 task 8); (b) a test-only launch
  override in the backend. Chose (a): production launch code stays unaware of
  the fake. The cost is a write to the checkout's build output; the real
  entry is kept beside it (`index.qa-real.js`) and put back in `finally`, a
  backup left by a killed run is kept and restored by the next run, and the
  profile's bridge-build check reports a stale entry before any later run.
  Every profile started from the checkout launches that one entry, so (review
  round 1) the swap holds an owner lock (`index.qa-lock.json`, created
  exclusively; a live owner refuses a second run, a dead owner's lock is taken
  over) and the bundle serves the fake only to bridges whose
  `CURSOR_BRIDGE_STATE_DIR` is inside the owner's data directory; any other
  launch imports the real entry. A per-profile bridge path would need a
  launch seam in the backend, which option (b) already rejected.
  The new host entry (`src/testing/host-fake-engine-server.ts`) keeps the
  fake's store in the environment's own `CURSOR_BRIDGE_STATE_DIR`, and the
  fake SDK now records each steer's text on the run, so the case counts what
  reached the vendor and checks the steer joined the held run rather than
  starting a turn.
- **Where the spec lives.** `browser-gateway.spec.ts` was over 3,000 lines,
  so the scenario moved to its own file instead of growing it. Codex keeps
  its real model and its `ORKESTRATOR_AGENT_TEST_REVIEW=1` opt-in; Claude and
  Cursor run behind `ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS=1`
  (`ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS` narrows them), or on the
  profile's real logins when `ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS`
  names them, which takes Codex's file-based path and is how the 7568 item
  runs. The real-model path for Claude and Cursor has not been run (billed).
- **What the runs found.** On a credential-free profile the startup "Claude
  Code Is Not Logged In" dialog can open while the case is choosing an
  environment, and it hides the sidebar from the accessibility tree, so the
  project's expand button read as absent. The case dismisses that dialog and
  retries the expand-and-select step.
- **Runs.** beelink (Linux), profile `steer7b6` (`--fixture
  --no-agent-credentials --no-host-seed --agent-platforms claude,cursor
  --headless`), 2026-11-13, with `--repeat-each=3`: Claude 3/3 and Cursor
  3/3 passed (21 to 37 s each), Codex skipped (not opted in). The same counts
  held on a second, fresh profile after the real-model opt-in was added.
  Each profile was stopped and reset, and the Cursor entry was back in place.
  While the dialog handling was being written, two earlier Cursor runs failed
  on that startup dialog (a wrong role for its locator, then the
  accessibility-tree race above). After the review round 1 fixes (per-delivery
  appends, the entry lock and owner-only fake), profile `steer7fix` with the
  same flags and `--repeat-each=2`: Claude 2/2 and Cursor 2/2 passed, Codex
  skipped; the real entry was back in place with no lock left, and the
  profile was stopped and reset.
- **Not covered.** Two overlapping live runs against one checkout (the lock's
  refusal and the owner-only fake are unit-tested in
  `steer-inactive-live-support.test.ts`, including a run of the built bundle).
  Real Claude and Cursor models (the 7568 item), a container
  environment, and Cursor's real SDK steer path, which the fake answers with
  `complete_delivered`.

### Task 5: OpenCode steer recorded as built for 2.x (2026-11-10 housekeeping)

Checked against `main` at `04639b12b`. Task 5 still said it was blocked on
0008 tasks 5 and 10, and the folder index still called OpenCode steer
blocked upstream. 0008 task 10 (the steer spike) was done on 2026-11-08, and
0008 task 5 built steer for 2.x sessions, merged in #2009. Chosen: mark task 5
done for 2.x sessions, keep 1.x as "cannot steer", and leave live
qualification to 0008 task 7 rather than adding a new item here, which the
to-do rules forbid. Grok steer stays blocked.

## Needs verification

- **A missed steer on a real bridge (task 10).** Built and tested against
  scripted providers only. On a throwaway profile, per provider with steer
  (Claude, Codex, Cursor, Pi): finish a turn, then `/steer` from a stale
  composer, and steer while a second turn has replaced the first; confirm one
  new turn or one queued row, with the session's model and mode, and that a
  reload shows the same.

- **Stop after several turns on a real CLI.** Start a background agent,
  send two follow-ups into the same warm CLI, then stop the agent: it must stop
  (`ok`) and its snapshot settle; after the CLI is released, a stop for a task
  it owned must answer `no_control_channel`.

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
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the real-login part of task 7, the real-login reads of task 8, task 9) moved there on 2026-11-10.

## Replaces

- `docs/plans/sdk-coverage/05-mid-turn-control-steer-and-interrupt.md`
- `docs/plans/sdk-coverage/15-adapter-simplification.md` (Claude warm query,
  model catalogue, background-task reconciliation)
- `docs/plans/sdk-coverage/10-composer-model-axes-and-settings.md`
  ("mid-session change via `setModel()`/`applyFlagSettings()`")
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.1; Cursor §6.3, §6.6;
  Pi §8.2; Tier 3 rows 25, 26 and 30)
