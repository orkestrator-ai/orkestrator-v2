# Assessment

I reviewed `orkestrator-ai/orkestrator-v2` at current `main`, SHA `25e7ae65d27ce36b6f17bb8b9987447603a548b6`. I also aligned the investigation with Codex `0.144.1`, because the bridge SDK, download script, and Docker image all pin that version.

**The migration is feasible and is probably the right long-term architecture.** However, it should not be implemented as a direct replacement of:

```ts
thread.runStreamed(...)
```

with a few app-server calls.

The safe target is:

```text
CodexChatTab / CodexBuildChatTab
                │
          existing REST + SSE
                │
    Orkestrator Codex bridge
       one bridge per environment
                │
     JSONL RPC over private stdio
                │
   codex app-server --stdio
       one child per environment
                │
       multiple Codex threads
```

The existing Hono bridge should remain the browser-facing boundary. It should become the app-server supervisor, protocol adapter, session registry, event reducer, and recovery layer.

Do **not** connect the browser directly to Codex app-server. Its WebSocket transport is explicitly described as experimental and unsupported, whereas stdio is the default supported transport. The bridge also contains substantial Orkestrator-specific behavior that the raw app-server does not replace.

The Codex CLI still marks `app-server` as experimental, even though OpenAI describes it as the interface used to power rich clients such as the VS Code extension. That makes exact version pinning, generated protocol artifacts, contract tests, canary rollout, and a fallback engine essential.

---

# What happens today

The current execution chain is effectively:

```text
POST /session/:id/prompt
       │
       ▼
runPrompt()
       │
       ▼
session.thread.runStreamed()
       │
       ▼
spawn codex exec --experimental-json
       │
       ▼
read JSONL until that process exits
```

The TypeScript SDK’s `runStreamed` delegates to `CodexExec.run`, and `CodexExec.run` spawns a fresh `codex exec` process for each turn. The process receives the prompt over stdin, streams JSON lines over stdout, and is terminated through an `AbortSignal`.

That process-per-turn behavior has several important consequences:

* A Codex crash is isolated to one turn.
* Every turn inherits the bridge’s latest process environment.
* Interrupting a turn kills that turn’s Codex child.
* There is no persistent protocol connection to recover.
* Every turn pays process startup, config loading, model setup, and thread-resume overhead.

The bridge then adds a substantial amount of behavior around that stream:

* It creates separate Orkestrator session IDs and Codex thread IDs.
* It maintains optimistic user and assistant messages.
* It translates Codex items into Orkestrator’s native message parts.
* It guards against stale events after aborts.
* It reconstructs missing threads by prompting a fresh thread with prior transcript context.
* It scans persisted rollout JSONL files.
* It separately polls rollout files for subagent information that the current SDK event stream does not expose.
* It maintains custom titles and model caches.
* It publishes normalized updates over a global SSE endpoint.

The renderer adds more reconciliation:

* `CodexChatTab` listens for SSE updates but reconciles messages and status after disconnects.
* It has a stalled-turn watchdog.
* `CodexBuildChatTab` polls status and messages every second while a build phase is running.
* The build pipeline persists request IDs and retries failed dispatches after checking authoritative status and messages.

The backend already starts one long-lived Codex bridge process per Orkestrator environment, with a random loopback port locally or a mapped port in a container. Therefore, this migration does not require replacing the outer topology. It requires changing what that existing bridge process supervises internally.

---

# Recommended target architecture

## One app-server per environment

The bridge should supervise exactly one:

```text
codex app-server --stdio
```

child per Orkestrator environment.

It should not be:

* One global app-server shared across all environments, because environments have different filesystems, containers, PATHs, credentials, and runtime installations.
* One app-server per tab, because that loses most of the lifecycle and startup benefits.
* A browser-accessible WebSocket service.
* The Codex daemon/remote-control mode in the first implementation.

For local environments, the app-server runs on the host as a child of the local bridge. For container environments, it runs inside the container as a child of the container bridge.

## Preserve the existing REST/SSE API initially

The current frontend API should remain stable during the engine migration:

```text
/global/health
/global/models
/global/slash-commands

/session/create
/session/resume
/session/list
/session/:id/config
/session/:id/messages
/session/:id/status
/session/:id/prompt
/session/:id/abort
DELETE /session/:id

/event/subscribe
```

Internally, those routes will be backed by app-server requests instead of SDK `Thread` objects.

This avoids simultaneously rewriting:

* `CodexChatTab`
* `CodexBuildChatTab`
* the build-pipeline recovery logic
* the Codex store
* pane persistence
* resume dialogs
* model preferences
* the backend process-management API

## Keep Orkestrator’s normalized message model

The browser should not consume raw app-server protocol items. The bridge should continue exposing Orkestrator’s existing `CodexMessage` and native message-part representations.

This provides:

* A stable UI contract.
* Isolation from app-server protocol version changes.
* A place to merge subagent activity.
* Centralized diff and command-output normalization.
* Recovery and deduplication.
* Compatibility with both the SDK fallback and app-server engines.

## Use generated protocol artifacts from the exact binary

Codex app-server supports generating TypeScript bindings and JSON Schema from the installed binary. OpenAI explicitly says those artifacts match the version that generated them.

The repository should commit generated artifacts for `0.144.1` and fail CI if regenerating them produces a diff.

This is particularly important because the pinned README describes experimental methods and shapes that are absent from the generated stable request union, and the generated collaboration-item naming differs from some of the prose documentation. The implementation should treat the generated schema and live binary contract as authoritative, not handwritten examples.

---

# Expected benefits

The change should provide several material improvements:

1. **Reduced per-turn startup work.** A persistent app-server can retain model/config infrastructure and loaded threads instead of starting a fresh CLI process for every prompt. The actual latency improvement must be measured rather than assumed.

2. **First-class thread and turn lifecycle.** App-server exposes `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, thread status, turn status, and persisted thread reads.

3. **Richer native events.** The protocol includes item starts, deltas, item completions, command output, reasoning, file changes, MCP calls, collaboration calls, and subagent activity.

4. **Better subagent support.** The generated `ThreadItem` union includes `collabAgentToolCall` and `subAgentActivity`, including parent/receiver thread information and agent state. That can eventually replace most of the bridge’s current rollout-file polling.

5. **Native model and history APIs.** `model/list`, `thread/list`, and `thread/read` can replace several cache and filesystem-scanning paths.

6. **A path to future approvals and interaction.** App-server supports server-initiated approval and user-input requests, though those introduce significant client responsibilities and should not be enabled casually.

---

# Principal implications and risks

## Risk register

| Risk                                      |        Severity | Implication                                                                                                                                                          | Required mitigation                                                                                                                                        |
| ----------------------------------------- | --------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate turns or duplicate side effects |    **Critical** | A connection can fail after `turn/start` was written but before its response was received. Blind retries could execute commands or edits twice.                      | Stable request IDs, `clientUserMessageId`, a dispatch journal, and reconciliation through `thread/read` before retrying.                                   |
| Shared process failure domain             |    **Critical** | Today one failed Codex child affects one turn. A failed app-server affects every active Codex tab and build phase in that environment.                               | Supervisor generations, restart backoff, circuit breaker, per-thread recovery, and no automatic engine switching during active work.                       |
| Slow consumer blocking app-server stdout  |    **Critical** | If the JSONL reader waits for a slow SSE client or expensive message rebuild, app-server’s bounded outbound queue can fill and stall all threads.                    | Never await browser writes in the stdout reader. Use per-thread reducer queues, bounded subscriber queues, event coalescing, and slow-subscriber eviction. |
| Stale runtime environment                 |        **High** | The current bridge refreshes PATH-related variables before every turn, and every `codex exec` inherits them. A persistent child snapshots its environment at launch. | Fingerprint the refreshed environment and drain/restart app-server when it changes.                                                                        |
| Ambiguous abort semantics                 |        **High** | `turn/interrupt` is asynchronous. Treating its response as completed and immediately marking idle would permit overlapping turns and stale events.                   | Add a cancelling phase and wait for terminal `turn/completed` with `interrupted`.                                                                          |
| Background process cleanup                |        **High** | Interrupting a turn may not terminate every background terminal or descendant process.                                                                               | Contract-test current and new behavior; use supported cleanup APIs where available and process-tree cleanup as a supervised fallback.                      |
| Unanswered server requests                |        **High** | App-server can send requests back to the client. Ignoring one can leave a turn waiting forever.                                                                      | Exhaustive server-request router with explicit accept, decline, cancel, or protocol-error responses.                                                       |
| Protocol instability                      |        **High** | `app-server` remains experimental and experimental prose APIs do not all appear in stable generated types.                                                           | Exact version pinning, generated schemas, capability gating, unknown-event metrics, and binary contract tests.                                             |
| Same thread opened in multiple tabs       |        **High** | Notifications identify Codex `threadId`, not Orkestrator bridge session ID. Two tabs may resume the same persisted thread.                                           | Canonical `ThreadContext` keyed by thread ID, reference counting, fan-out, and one active writer per thread.                                               |
| Build-pipeline retry errors               |        **High** | The build pipeline can advance phases or retry prompts after reconnects. A false idle or duplicated prompt could produce incorrect PRs or edits.                     | Treat recovering/cancelling as nonterminal; reconcile by request/client ID rather than prompt text.                                                        |
| History sessions disappearing             |        **High** | `thread/list` defaults to interactive source kinds. Existing SDK sessions are `exec`; new sessions are `appServer`.                                                  | Explicitly request every compatible root source kind and filter out child threads.                                                                         |
| Configuration and trust side effects      |        **High** | App-server states that starting a thread under write/full sandbox can mark a project trusted in `config.toml`.                                                       | Diff config before/after in contract tests and deliberately preserve, avoid, or expose that behavior.                                                      |
| Orphan app-server children                |        **High** | Bridge SIGKILL, container stop, or Windows process behavior could leave a child running against the same `CODEX_HOME`.                                               | Graceful signal handling, process groups/job-tree termination, pidfiles, stale-child cleanup, and container init/signal tests.                             |
| Idle memory growth                        | **Medium–High** | Current Codex processes are short lived. A persistent Rust process and loaded threads consume memory while idle.                                                     | Measure idle memory, unsubscribe unused threads, add optional idle shutdown, and conduct long soak tests.                                                  |
| Event volume and browser churn            | **Medium–High** | Agent-message and command-output deltas can be far more frequent than current message snapshots.                                                                     | Coalesce UI snapshots, cap command output, and flush authoritatively on item/turn completion.                                                              |
| Session deletion mismatch                 |      **Medium** | Current bridge DELETE only removes the ephemeral bridge session. App-server `thread/delete` permanently deletes the rollout and descendants.                         | Keep “close bridge session” separate from archive/hard-delete operations.                                                                                  |
| Telemetry/compliance behavior changes     |      **Medium** | App-server uses `clientInfo.name` for compliance logs and has different analytics defaults.                                                                          | Identify as Orkestrator, coordinate enterprise client registration, and make analytics policy explicit.                                                    |
| Title generation remains a subprocess     |      **Medium** | Replacing `runStreamed` does not remove the separate hermetic `codex exec` title generator.                                                                          | Keep it initially and document the exception; migrate only when its isolation guarantees can be reproduced.                                                |

---

# The most important architectural issues

## 1. At-most-once prompt execution

This is the single most important correctness requirement.

The build pipeline already creates a stable request ID, stores it in pipeline state, and reuses it during reconnect. However, its final reconciliation currently falls back to finding a matching prompt and subsequent assistant response.

App-server gives Orkestrator a stronger mechanism:

* `turn/start` accepts `clientUserMessageId`.
* Persisted `userMessage` items expose that value as `clientId`.

The bridge should use the frontend request ID as `clientUserMessageId`.

The prompt flow should become:

```text
1. Receive requestId from browser.
2. Acquire the thread's dispatch lock.
3. Check whether requestId is already known.
4. Refresh runtime environment.
5. Ensure app-server is ready.
6. Ensure the Codex thread exists.
7. Atomically journal "dispatch prepared".
8. Send turn/start with clientUserMessageId=requestId.
9. Persist the returned turnId and "accepted" state.
10. Return HTTP 202 with threadId, turnId, requestId.
```

If the app-server connection disappears after step 8 but before step 9:

```text
1. Restart and initialize app-server.
2. thread/read(includeTurns=true).
3. Look for userMessage.clientId == requestId.
4. If found, attach to that existing turn.
5. If absent and the thread is not active, dispatch once.
```

Only an explicit `-32001` overload response is safe for automatic retry of the same request, because the server says it rejected the request. A transport failure is ambiguous and must be reconciled first. App-server documents bounded ingress queues and the `-32001` retryable overload response.

A request must never be deduplicated solely by prompt text. The same text with two different request IDs is two legitimate turns.

## 2. Process failure becomes an environment-wide event

With `runStreamed`, a CLI process exiting only rejects one generator. With app-server, every pending request and active thread shares one child.

The process supervisor must maintain an **engine generation**:

```ts
type EngineGeneration = number;
```

Every active turn, pending RPC request, queued event, and recovery operation records that generation. Events from an old generation are ignored after restart.

On unexpected exit:

1. Stop accepting new turns.
2. Increment the engine generation.
3. Reject all pending RPC promises with a typed process-exit error.
4. Mark active sessions `recovering`, not immediately `error`.
5. Restart with exponential backoff and jitter.
6. Run the initialize handshake.
7. Re-read or resume every referenced thread.
8. Reconcile each active request ID.
9. Emit recovered, interrupted, or failed status.
10. Resume accepting turns.

After repeated failures in a rolling window, enter a circuit-breaker state. `/global/health` should report a terminal app-server failure rather than spinning indefinitely.

Automatic switching from app-server back to SDK mid-thread is unsafe. It could create overlapping executions or interpret partial state differently. Rollback should be an explicit bridge restart under a feature flag.

## 3. Runtime environment refresh cannot be lost

Orkestrator deliberately refreshes selected runtime variables before prompt execution. Tests verify that refreshed `PATH`, `BUN_INSTALL`, and `BASH_ENV` values are visible when Codex starts.

A persistent child cannot receive changes to its parent’s environment after launch.

Before every thread/turn operation:

1. Run the existing `refreshRuntimeEnvironment`.
2. Compute a hash of the relevant environment values.
3. Compare it to the app-server generation’s launch hash.
4. If unchanged, continue.
5. If changed and no turns are active, restart before dispatch.
6. If changed while other threads are active, enter a draining state:

   * block new turn starts,
   * allow active turns to settle,
   * restart,
   * resume loaded threads,
   * dispatch queued prompts.

Never log the raw values used to create the fingerprint, since they may eventually include secrets.

A later optimization could run two generations briefly—old generation drains while new generation accepts new turns—but that should not be part of the first implementation.

## 4. App-server output must never wait on the browser

App-server uses bounded internal queues. The bridge’s stdout reader must therefore be treated as a latency-sensitive protocol loop.

The wrong design is:

```ts
for await (const message of stdout) {
  await updateSession(message);
  await sendToEverySseSubscriber(message);
}
```

One slow renderer would then stall every Codex thread in the environment.

The correct structure is:

```text
stdout reader
  ├─ resolves RPC responses immediately
  ├─ dispatches server requests immediately
  └─ appends notifications to per-thread serial queues
                 │
                 ▼
          thread event reducer
                 │
                 ▼
       coalesced normalized snapshots
                 │
                 ▼
      bounded per-subscriber SSE queues
```

Required properties:

* The stdout reader performs bounded synchronous parsing only.
* Each thread has ordered processing.
* Different threads can reduce events independently.
* Browser writes occur outside the protocol reader.
* Slow SSE consumers are disconnected or told to reconcile.
* Agent text and command output updates are coalesced.
* `item/completed` and `turn/completed` force an immediate final flush.

## 5. Interrupt is a lifecycle, not a boolean

The current abort route calls `AbortController.abort()` and immediately sets the session to idle. That works partly because the per-turn Codex process is being killed.

App-server specifies:

```text
turn/interrupt
     ↓
request response
     ↓
eventually turn/completed(status="interrupted")
```

The bridge must not accept a new prompt between the interrupt response and terminal event. Turn statuses include `inProgress`, `completed`, `interrupted`, and `failed`.

Recommended state mapping:

```text
Orkestrator state          Existing external status
----------------------------------------------------
starting                    running
running                     running
cancelling                  running
recovering                  running
idle                        idle
failed                      error
```

Initially, preserve the existing `idle | running | error` response contract and add a more detailed `phase` field:

```json
{
  "status": "running",
  "phase": "cancelling"
}
```

This avoids breaking the build pipeline while allowing the UI to show “Stopping…” and “Recovering…”.

## 6. Every server-initiated request needs a response

App-server is bidirectional. In addition to notifications, it can send requests for:

* command approval,
* file-change approval,
* permissions approval,
* user input,
* MCP elicitation,
* dynamic tool execution,
* authentication refresh,
* attestation,
* legacy approval paths.

Even though Orkestrator currently uses `approvalPolicy: "never"`, the bridge must not assume requests can never appear.

The initial server-request policy should be:

* Set `experimentalApi: false`.
* Set `requestAttestation: false`.
* Set `mcpServerOpenaiFormElicitation: false`.
* Explicitly pass approval policy and sandbox policy for every turn.
* Unexpected command/file approvals: decline or cancel, record an invariant violation.
* Unsupported user-input or MCP elicitation: cancel with a visible explanation rather than leave the turn hanging.
* Unknown requests: return a protocol error and increment a metric.
* Process request handling independently of the per-thread reducer lock.

A later approval UI can add:

```text
session.approval-requested SSE event
POST /session/:id/request/:requestId/respond
```

That should be a separate product feature, not silently introduced during the engine migration.

## 7. Same Codex thread in multiple tabs needs a canonical owner

App-server notifications contain `threadId` and `turnId`; they do not contain Orkestrator’s bridge session ID.

The bridge needs two layers:

```ts
interface BridgeSession {
  id: string;
  threadId: string | null;
  config: SessionConfig;
  lastAccessed: number;
}

interface ThreadContext {
  threadId: string;
  bridgeSessionIds: Set<string>;
  messages: CodexMessage[];
  activeTurn: TurnAccumulator | null;
  subscriptionRefCount: number;
}
```

When two tabs resume the same Codex thread:

* Both should attach to the same `ThreadContext`.
* Both receive canonical message updates.
* Only one turn may run on that thread.
* The tab sending the next turn supplies that turn’s complete configuration.
* Deleting one bridge session only decrements the reference count.
* `thread/unsubscribe` is sent only when no bridge session references the thread.

This also prevents two separate in-memory transcripts for the same persisted conversation.

## 8. History source filtering is a migration trap

The generated source kinds include:

```text
cli
vscode
exec
appServer
subAgent
...
```

Existing `runStreamed` sessions are generally `exec`; migrated sessions will be `appServer`.

`thread/list` defaults to interactive source kinds when `sourceKinds` is absent or empty. Therefore, a naïve migration can make both old and new Orkestrator sessions disappear from the resume dialog.

The bridge must explicitly query the compatible root source kinds, filter exact `cwd`, and exclude child threads through `parentThreadId`.

For migration safety:

1. Query app-server thread metadata first.
2. Use `thread/read(includeTurns=true)` for hydration.
3. Fall back to the current rollout parser for malformed, incomplete, archived, or legacy threads.
4. Compare results against the current session-list golden fixtures.
5. Retain the fallback parser until old session compatibility has been proven in production.

## 9. App-server can mutate project trust configuration

The pinned app-server documentation explicitly states that `thread/start` with a `cwd` and a resolved workspace-write or full-access sandbox marks the project trusted in the user’s `config.toml`.

This must be tested against the current `codex exec` behavior.

The contract test should:

1. Create a temporary `CODEX_HOME`.
2. Record `config.toml`.
3. Run the current SDK path in build mode.
4. Record the resulting config.
5. Repeat with app-server `thread/start`.
6. Compare the changes.

If app-server introduces a new mutation, choose deliberately between:

* accepting and documenting it,
* creating threads read-only and elevating only through turn policy, provided that is verified not to mark trust,
* or requiring explicit product consent.

## 10. The session-title process is a deliberate exception

`session-titles.ts` does not use `runStreamed`. It independently spawns `codex exec` with:

* a custom model catalog,
* a custom output schema,
* read-only sandbox,
* approval policy `never`,
* user config and rules ignored,
* tools and many features disabled,
* explicit timeout and process-group termination.

The core migration should **not** absorb this into the shared app-server immediately. Doing so risks allowing title generation to inherit user tools, instructions, plugins, or configuration.

Recommended policy:

* Migrate interactive/native turns to app-server.
* Keep title generation as the isolated subprocess initially.
* Use `thread/name/set` to apply the resulting title to the main Codex thread.
* Dual-write the existing Orkestrator title index for rollback.
* Revisit title generation only after app-server can reproduce all of its isolation guarantees.

Therefore, this migration removes the per-turn `runStreamed` process path but does not initially guarantee “only one Codex process ever exists.”

---

# Current-to-target protocol mapping

| Current behavior                      | App-server equivalent                           | Bridge responsibility                                                                        |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Codex.startThread()`                 | `thread/start`                                  | Keep lazy creation so an empty Orkestrator session does not create a persisted Codex thread. |
| `Codex.resumeThread(id)`              | `thread/resume`                                 | Bind returned thread ID to a canonical `ThreadContext`.                                      |
| `thread.runStreamed(input)`           | `turn/start` plus notifications                 | Pass request ID as `clientUserMessageId`; reduce notifications into existing messages.       |
| SDK `thread.started`                  | `thread/started` plus start response            | Buffer early notifications until the thread-to-session mapping exists.                       |
| SDK `item.started/updated/completed`  | `item/started`, item deltas, `item/completed`   | Maintain per-item accumulators; final item is authoritative.                                 |
| SDK `turn.completed`                  | `turn/completed`                                | Map completed/interrupted/failed and flush final state.                                      |
| SDK `turn.failed`/error string        | `error` plus failed `turn/completed`            | Preserve structured error codes internally and expose a compatible message.                  |
| `AbortController.abort()`             | `turn/interrupt`                                | Wait for terminal interruption; guard stale generations.                                     |
| Manual model cache/debug command      | `model/list`                                    | Paginate, cache, preserve advertised reasoning-order, retain fallback.                       |
| Manual session-index and rollout scan | `thread/list` and `thread/read`                 | Explicit source kinds, cwd filtering, legacy fallback.                                       |
| Custom title index only               | `thread/name/set` plus existing index           | Dual-read and dual-write during migration.                                                   |
| Rollout polling for subagents         | collaboration and subagent items/status         | Native primary source, rollout reconciliation fallback.                                      |
| Bridge session deletion               | `thread/unsubscribe` when last reference closes | Do not call hard `thread/delete`.                                                            |
| SDK fast-mode Codex instance          | `serviceTier` turn override                     | Pass explicit tier on every turn, including clearing it when disabled.                       |

---

# Detailed implementation plan

## Phase 0 — Freeze the existing behavioral contract

Before changing execution, capture what must remain true.

### Work

Create an architecture decision record covering:

* one app-server child per environment,
* stdio transport,
* unchanged browser-facing REST/SSE API,
* bridge session ID versus Codex thread ID,
* same-thread multi-tab behavior,
* abort/background-terminal semantics,
* ephemeral close versus permanent thread deletion,
* approval policy,
* app-server analytics policy,
* project-trust side effects,
* title-generator exception.

Capture golden fixtures from the current SDK engine for:

* simple text response,
* reasoning,
* command execution and output,
* file edits,
* web/MCP calls,
* plan mode,
* build mode,
* fast tier,
* every supported reasoning effort,
* images,
* slash commands,
* subagents,
* model errors,
* usage-limit errors,
* missing rollout recovery,
* abort mid-text,
* abort mid-command,
* stale events after abort,
* long histories.

### Exit gate

All existing bridge and UI tests pass unchanged, and golden normalized-message snapshots are committed.

---

## Phase 1 — Extract an engine interface without changing behavior

`bridges/codex-bridge/src/index.ts` currently mixes routes, session management, SDK execution, transcript parsing, message reduction, process lifecycle, and SSE publishing. The first implementation step should be a behavior-preserving extraction.

Suggested interface:

```ts
interface CodexEngine {
  start(): Promise<EngineInfo>;
  stop(): Promise<void>;

  listModels(): Promise<EngineModel[]>;

  startThread(options: StartThreadOptions): Promise<EngineThread>;
  resumeThread(
    threadId: string,
    options: ResumeThreadOptions,
  ): Promise<EngineThread>;

  readThread(
    threadId: string,
    options: ReadThreadOptions,
  ): Promise<EngineThread>;

  listThreads(
    options: ListThreadsOptions,
  ): Promise<ListThreadsResult>;

  startTurn(
    options: StartTurnOptions,
  ): Promise<EngineTurn>;

  interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<void>;

  setThreadName(
    threadId: string,
    name: string,
  ): Promise<void>;

  unsubscribeThread(threadId: string): Promise<void>;

  subscribe(
    listener: (event: EngineEvent) => void,
  ): () => void;
}
```

Create a temporary `SdkExecEngine` that wraps the existing `Codex`, `Thread`, and `runStreamed` implementation. It should convert current SDK events into the new internal `EngineEvent` representation.

The rest of the bridge should depend on `CodexEngine`, not `@openai/codex-sdk`.

### Exit gate

The SDK engine remains the default and every existing route, abort, recovery, subagent, and UI test passes.

This isolates the architectural change from the behavioral change.

---

## Phase 2 — Pin and generate the app-server protocol

Add one repository-level source of truth for the Codex version. Today the same version is represented in the bridge package, download script, and Docker build. Consolidating this prevents the app-server binary and generated protocol from drifting.

Suggested files:

```text
config/codex-version.json
scripts/generate-codex-app-server-protocol.ts
bridges/codex-bridge/src/app-server/generated/typescript/
bridges/codex-bridge/src/app-server/generated/schema/
```

CI should:

1. Install or locate the exact expected Codex binary.
2. Verify `codex --version`.
3. Run:

```text
codex app-server generate-ts --out ...
codex app-server generate-json-schema --out ...
```

4. Compare the generated output with committed files.
5. Fail on any diff.
6. Run a minimal initialize/shutdown contract test against the real binary.

At runtime, initialize with:

```json
{
  "clientInfo": {
    "name": "orkestrator",
    "title": "Orkestrator",
    "version": "<application version>"
  },
  "capabilities": {
    "experimentalApi": false,
    "requestAttestation": false,
    "mcpServerOpenaiFormElicitation": false
  }
}
```

Then send the required `initialized` notification. App-server rejects normal requests before this handshake and returns the actual `codexHome` and platform information in the initialize response.

Use `LOG_FORMAT=json` for structured stderr logs.

Do not pass `--analytics-default-enabled` without an explicit product decision. App-server analytics are disabled by default unless enabled by user configuration or that first-party-oriented flag.

### Exit gate

The generated schema matches the pinned binary, initialize works on every supported packaged platform, and a version mismatch causes a clear health failure.

---

## Phase 3 — Implement the process supervisor and RPC transport

Add:

```text
app-server/process-supervisor.ts
app-server/jsonl-rpc-client.ts
app-server/envelope-validation.ts
app-server/server-request-router.ts
app-server/errors.ts
```

### Process supervisor responsibilities

* Spawn without a shell.
* Explicitly use stdio transport.
* Supply the refreshed environment.
* Set process `cwd` to the environment workspace.
* Capture stdout and stderr independently.
* Maintain state:

```text
stopped
starting
ready
draining
restarting
backoff
failed
```

* Maintain a monotonically increasing generation.
* Restart after unexpected exit with exponential backoff and jitter.
* Enter a circuit breaker after repeated failures.
* Support graceful shutdown:

  * stop new turn starts,
  * interrupt or allow active turns to settle according to shutdown policy,
  * close stdin,
  * send SIGTERM,
  * send SIGKILL after a bounded grace period.
* Terminate descendants/process groups where supported.
* Record and clean up stale pidfiles.
* Expose health and metrics.

### RPC client responsibilities

* Monotonic request IDs.
* Pending request map.
* Per-method timeouts.
* Serialized writes with `drain`/backpressure handling.
* Maximum outbound line size.
* Maximum inbound line size.
* Correct handling of fragmented and combined stdout chunks.
* Classification of:

  * response,
  * notification,
  * server request.
* Immediate resolution of responses.
* Immediate routing of server requests.
* Per-thread serial queues for notifications.
* Rejection of all pending operations on process exit.
* Explicit retry classification.
* Runtime envelope validation.
* Unknown-method and unknown-notification metrics.

### Important queue rule

The protocol reader must not await:

* message normalization,
* transcript reads,
* filesystem diffs,
* SSE writes,
* title generation,
* browser state.

### Exit gate

A fake app-server harness passes tests for fragmented JSONL, concurrent requests, notifications before responses, server requests, overload, malformed messages, write backpressure, timeouts, child exit, restart, and stale-generation events.

---

## Phase 4 — Implement thread and bridge-session management

Add a canonical thread registry:

```text
session/session-registry.ts
session/thread-context.ts
session/turn-accumulator.ts
session/persistence.ts
```

### Preserve lazy thread creation

Current `/session/create` does not create a persisted Codex thread until the first prompt. Preserve that behavior:

```text
/session/create
    → BridgeSession(threadId=null)

/session/:id/prompt
    → thread/start if threadId is null
    → turn/start
```

This avoids empty threads appearing in history.

### Resume flow

`/session/resume` should:

1. Call `thread/resume`.
2. Validate returned thread ID and cwd.
3. Register or reuse the canonical `ThreadContext`.
4. Convert returned turns into normalized messages.
5. Merge custom Orkestrator title state.
6. Return the new bridge session ID and messages.

App-server resumes with reconstructed turn history by default in the pinned documentation.

### Persist bridge-session mappings

The existing bridge session IDs are stored in pane and build-pipeline state but are only in process memory. A bridge restart loses them.

Persist a versioned lightweight registry containing:

```ts
interface PersistedBridgeSession {
  bridgeSessionId: string;
  threadId: string;
  cwdHash: string;
  title?: string;
  config: SessionConfig;
  lastAcceptedRequestId?: string;
  lastAccessed: string;
}
```

Do not persist the transcript; the Codex rollout remains authoritative.

Store this in an Orkestrator-owned application-data location or a scoped `$CODEX_HOME/orkestrator-bridge/<cwd-hash>` directory. Use atomic replacement and locking because multiple application instances could theoretically share a `CODEX_HOME`.

### Same-thread handling

Maintain:

```text
threadId → ThreadContext
threadId → Set<bridgeSessionId>
bridgeSessionId → threadId
```

Reject overlapping turns on the same thread even when they originate from different bridge sessions.

### Exit gate

Creating, resuming, closing, reopening, bridge restarting, and opening the same thread in two tabs all produce one canonical transcript without duplicate turns.

---

## Phase 5 — Build the app-server event reducer

Add:

```text
app-server/event-reducer.ts
app-server/item-reducers/
app-server/subagent-graph.ts
app-server/diff-adapter.ts
```

Use an accumulator per active turn:

```ts
interface TurnAccumulator {
  threadId: string;
  turnId: string;
  requestId: string;
  engineGeneration: number;
  startedAt: string;
  status: "starting" | "running" | "cancelling" | "completed" | "interrupted" | "failed";

  itemOrder: string[];
  items: Map<string, ItemAccumulator>;

  assistantMessageId: string;
  usage?: Usage;
  finalDiff?: string;
}
```

### Event handling rules

* `turn/started`: mark running and bind the real turn ID.
* `item/started`: create or update the item and record ordering.
* Agent-message delta: append text to that item’s delta buffer.
* Reasoning deltas: append by summary/content index.
* Command-output delta: append with a configured UI cap.
* File-change update: update the in-progress diff.
* `item/completed`: replace the item with the complete authoritative object.
* `error`: store structured error information but do not necessarily mark terminal.
* `turn/completed`: map completed/interrupted/failed, reconcile final state, and flush immediately.

OpenAI’s app-server documentation describes `item/completed` as the authoritative item execution/result state.

### Idempotence and partial ordering

The reducer must tolerate:

* started notification repeated,
* completed without started,
* a delta before the start item is processed,
* duplicate final events,
* a stale event from an old engine generation,
* a stale turn event after a newer turn has started,
* notification arrival before `turn/start` response.

The existing stale-turn tests should be ported directly to the new engine-neutral reducer.

### UI update coalescing

Do not publish every token delta to React.

Recommended behavior:

* Internally consume every delta.
* Publish at a bounded cadence, such as once per animation-scale interval.
* Publish immediately on item completion, turn completion, error, approval request, or interruption.
* Use full normalized message snapshots so dropped intermediate events are recoverable.

### Exit gate

Every golden current-engine fixture and every app-server fixture produces equivalent normalized messages, apart from intentionally richer metadata.

---

## Phase 6 — Implement prompt dispatch, idempotency, and recovery

This phase should be treated as a separate reliability project, not just route wiring.

### Dispatch journal

Persist a small append-only or atomic journal:

```ts
interface PromptDispatchRecord {
  requestId: string;
  bridgeSessionId: string;
  threadId: string;
  turnId?: string;
  state: "prepared" | "accepted" | "terminal";
  createdAt: string;
  terminalStatus?: "completed" | "interrupted" | "failed";
}
```

Required behavior:

* Duplicate request while running returns the existing turn.
* Duplicate request after completion returns already processed.
* Same prompt with different ID runs again.
* Old records are garbage-collected with session retention.
* Journal writes occur before and after the ambiguity boundary.

### Process-exit recovery

For every active request:

1. Restart and initialize app-server.
2. `thread/read(includeTurns=true)`.
3. Find the user item by `clientId`.
4. If a terminal turn exists, rebuild and finalize.
5. If a turn is still reported active, reattach to the thread.
6. If the request is absent, classify whether dispatch was definitely rejected or ambiguous.
7. Retry only when absence makes it safe.
8. Preserve partial assistant/tool output when marking interrupted or failed.

### Missing rollout recovery

Retain the bridge’s current fresh-thread transcript-reconstruction fallback, but make it a last resort for a confirmed missing or unreadable persisted thread—not a response to a transient app-server process error.

### Environment restart

Integrate the environment fingerprint and draining behavior here so a prompt cannot dispatch under stale PATH values.

### Exit gate

Chaos tests prove no duplicate command or file-edit turn after failure at every dispatch boundary.

---

## Phase 7 — Implement interruption and server-request handling

### Interruption

Change `/session/:id/abort` to:

1. Validate an active turn exists.
2. Set phase to `cancelling`.
3. Emit a status update.
4. Send `turn/interrupt`.
5. Return HTTP `202` with `{status:"cancelling"}`.
6. Wait for terminal `turn/completed`.
7. Reconcile persisted state.
8. Set idle only after terminal interruption.

Add an interrupt timeout. If no terminal event arrives:

* query thread state,
* retry interrupt if the turn remains active,
* restart app-server only as a last resort,
* never silently accept a new turn while the previous turn may still be active.

### Server requests

Implement an exhaustive switch over the generated `ServerRequest` union.

For unsupported interactive requests, return an explicit decline/cancel response and surface a user-readable error in the transcript.

Track:

* request ID,
* method,
* thread ID,
* turn ID,
* item ID,
* received time,
* resolution,
* timeout.

Never hold a thread reducer lock while waiting for the browser.

### Exit gate

No supported or unknown server request can leave the app-server indefinitely waiting without a corresponding bridge-side record and timeout.

---

## Phase 8 — Migrate models, history, titles, diffs, and subagents

### Models

Use paginated `model/list`.

Preserve the server-provided order of `supportedReasoningEfforts`; the app-server documentation explicitly says clients should not derive order from the names.

Update the frontend model-source type from:

```ts
"cache" | "fallback"
```

to:

```ts
"app-server" | "cache" | "fallback"
```

Retain the current persisted model cache and fallback catalog for app-server startup failures.

### History

Explicitly request all compatible root sources, including at least:

```text
cli
vscode
exec
appServer
unknown
```

Then:

* exact-cwd filter,
* exclude child/subagent threads,
* query archived separately only if current UX includes archived sessions,
* read turns,
* preserve custom titles,
* fall back to current filesystem parser.

### Titles

Title precedence should be:

```text
explicit app-server thread name
→ explicit Orkestrator title
→ generated Orkestrator title
→ app-server preview
→ prompt fallback
```

When a generated title becomes available:

1. Call `thread/name/set`.
2. Persist the existing Orkestrator title entry.
3. Emit the existing `session.title-updated`.

This makes rollback to the SDK engine safe.

### Diffs

App-server file-change items already carry path, change kind, and unified diff.

Use the app-server diff as authoritative, but initially retain current baseline/file-reading logic to preserve the exact `toolDiff` UI shape:

* additions,
* deletions,
* before text,
* after text,
* file path,
* change type.

After parity is established, remove redundant git/filesystem reconstruction.

### Subagents

Use native collaboration items and thread-parent information as the primary source.

During rollout:

1. Continue running the existing rollout subagent reconciler in diagnostic mode.
2. Do not emit its result to the UI if the native reducer already emitted the same subagent.
3. Compare native and rollout-derived graphs.
4. Record missing, extra, and status-mismatch metrics.
5. Run a final transcript reconciliation after the parent turn settles.
6. Remove live rollout polling only after parity is demonstrated.

This is **dual reading**, not dual execution. Never run the user’s prompt in both engines as a shadow test.

### Exit gate

Old SDK threads and new app-server threads appear together, resume correctly, retain titles, show equivalent diffs, and produce complete subagent timelines.

---

## Phase 9 — Update the frontend and build pipeline

### `apps/web/src/lib/codex-client.ts`

Add:

* richer health payload,
* `phase`,
* `turnId`,
* `requestId`,
* `engineGeneration`,
* event revision,
* event replay cursor,
* app-server model source.

Ensure every prompt caller creates and retains a request ID.

The current client already supports an optional request ID but only treats the prompt response as a boolean.

Change prompt response handling to retain:

```ts
interface PromptAcceptedResponse {
  status: "processing" | "already-processed";
  requestId: string;
  threadId: string;
  turnId: string;
  duplicate?: boolean;
}
```

### Native chat

Update `CodexChatTab` to:

* store request ID until terminal completion,
* show starting/cancelling/recovering states,
* avoid optimistic duplicate messages after reconnect,
* reconcile by request ID,
* retain the current watchdog initially.

### Build pipeline

The pipeline already has the correct foundation: a persisted request ID and explicit reconnect ownership.

Change its reconciliation to:

* locate `userMessage.clientId`,
* identify the corresponding turn,
* wait for a terminal turn status,
* treat cancelling/recovering as running,
* never advance a phase based only on bridge-local idle state,
* preserve the same request ID for a retry,
* start a fresh stage only when the prior request is confirmed absent or terminal.

The build pipeline’s `sdkSessionId` is actually the Orkestrator bridge session ID. Preserve that serialized field during this migration; rename it only with a separate persisted-state migration.

### SSE reliability

Add a per-session or per-environment monotonic revision:

```text
event id: 1842
data: {
  sessionId,
  revision: 1842,
  engineGeneration: 3,
  ...
}
```

Maintain a bounded event ring buffer.

On reconnect:

* replay revisions after `Last-Event-ID` when available,
* otherwise emit `session.reconcile-required`,
* then use `/messages` and `/status`.

The current SSE endpoint is global and has no replay mechanism. The current client closes the EventSource on error and then relies on component-level reconciliation.

Keep polling/watchdog reconciliation until the replay path has proven reliable. It can be simplified later.

### Exit gate

Both native chat and the full build pipeline pass disconnect, bridge restart, app-server restart, duplicate request, abort, and same-thread multi-tab scenarios.

---

## Phase 10 — Packaging, lifecycle, and operations

### Local lifecycle

The existing backend should continue supervising the bridge. The bridge supervises app-server.

Ensure that stopping a local Codex server:

```text
backend
  → SIGTERM bridge
      → bridge drains/stops app-server
```

The backend should wait for `/global/health` to confirm both bridge and app-server readiness before reporting the Codex server started.

### Container lifecycle

The container bridge currently runs detached and is stopped through process matching. The new child makes explicit signal propagation more important.

Add:

* bridge SIGTERM/SIGINT handlers,
* app-server pidfile,
* process-tree termination,
* stale-child startup cleanup,
* tests for `docker stop`,
* tests for forceful bridge death,
* an init process such as `tini` if the image does not already reap orphaned descendants.

Avoid a broad `pkill codex` because the title generator or another legitimate Codex process may be active. Target the recorded app-server PID or process group.

### Health

Recommended health response:

```json
{
  "status": "ok",
  "bridgeVersion": "1.1.0",
  "engine": "app-server",
  "appServer": {
    "state": "ready",
    "generation": 4,
    "pid": 12345,
    "codexVersion": "0.144.1",
    "restartCount": 1
  },
  "activeThreads": 2,
  "activeTurns": 1,
  "queuedRequests": 0
}
```

Use `503` when the engine is terminally unavailable. A sleeping-but-restartable app-server may remain `200` with an explicit sleeping state.

### Resource management

Measure:

* app-server idle RSS,
* RSS per loaded thread,
* memory after hundreds of turns,
* file descriptors,
* child processes,
* queue lengths,
* cold initialize latency,
* first-event latency,
* concurrent-thread throughput.

Possible post-measurement policy:

* unsubscribe when the last bridge session releases a thread,
* stop app-server after an environment-wide idle interval,
* restart on the next health-sensitive operation,
* cap concurrent active turns per environment,
* prioritize interrupt and server-request responses over history/model reads.

### Observability

Record structured metrics for:

* process starts and restarts,
* restart reason,
* initialize latency,
* request latency by method,
* request errors by method/code,
* `-32001` overload count,
* pending request count,
* active thread and turn count,
* notification queue depth,
* reducer lag,
* coalesced/dropped UI update count,
* unknown notifications/items/requests,
* duplicate request suppression,
* ambiguous dispatch recovery,
* successful and failed turn recovery,
* abort latency,
* SSE disconnects and replay gaps,
* subagent native-versus-rollout mismatches,
* environment-triggered restarts,
* app-server RSS and child count.

Do not log prompts, command output, diffs, credentials, or server-request payloads by default. Retain the current opt-in raw-debug mechanism with explicit redaction and size limits.

### Exit gate

No orphan app-server process remains after normal shutdown, forced bridge termination, container stop, backend restart, or desktop exit on any supported platform.

---

## Phase 11 — Canary rollout and removal of the SDK path

Add a bridge-level flag:

```text
ORKESTRATOR_CODEX_ENGINE=sdk-exec
ORKESTRATOR_CODEX_ENGINE=app-server
```

The selected engine should be fixed for the lifetime of the bridge process.

Recommended rollout order:

1. App-server opt-in for a single local native chat.
2. Native chat create/resume/abort/config.
3. Multiple native tabs and same-thread resume.
4. Container environments.
5. Subagent-heavy turns.
6. Build pipeline for internal canaries.
7. Build pipeline reconnect and chaos testing.
8. App-server default-on with SDK rollback available.
9. Remove rollout subagent polling after parity.
10. Remove the SDK engine and `@openai/codex-sdk` only after a stable default-on period.
11. Retain old-thread parsing and title dual-read for longer than the SDK execution fallback.

Do not automatically fall back to the SDK engine after an app-server crash. That could execute the same pending turn through two different mechanisms. Rollback should stop the bridge, change the engine flag, and restart it.

Before making app-server the default, verify both directions:

* An existing `exec` thread can be resumed by app-server.
* An `appServer` thread can be resumed by the SDK/CLI rollback path.
* Titles remain visible in both modes.
* No rollout is rewritten destructively.

---

# Suggested bridge source layout

```text
bridges/codex-bridge/src/
├── index.ts                         # composition root only
├── routes/
│   ├── global.ts
│   ├── sessions.ts
│   └── events.ts
├── engine/
│   ├── types.ts
│   ├── sdk-exec-engine.ts          # temporary rollback engine
│   └── app-server-engine.ts
├── app-server/
│   ├── process-supervisor.ts
│   ├── jsonl-rpc-client.ts
│   ├── envelope-validation.ts
│   ├── server-request-router.ts
│   ├── event-reducer.ts
│   ├── subagent-graph.ts
│   ├── diff-adapter.ts
│   ├── recovery.ts
│   ├── errors.ts
│   └── generated/
├── sessions/
│   ├── bridge-session.ts
│   ├── thread-context.ts
│   ├── turn-accumulator.ts
│   ├── dispatch-journal.ts
│   └── persistence.ts
├── messages/
│   ├── normalization.ts
│   └── coalescer.ts
├── history/
│   ├── app-server-history.ts
│   └── rollout-fallback.ts
└── observability/
    ├── health.ts
    ├── metrics.ts
    └── logging.ts
```

`index.ts` should no longer contain the execution state machine itself.

---

# Required test matrix

| Area               | Required tests                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSONL transport    | Fragmented lines, multiple lines per chunk, CRLF, malformed JSON, oversized lines, stdout close, stderr noise, write backpressure.                     |
| RPC correlation    | Concurrent requests, out-of-order responses, timeouts, duplicate IDs, server requests interleaved with responses, notification before response.        |
| Process supervisor | Startup failure, initialize failure, normal exit, crash, repeated crash/circuit breaker, graceful stop, SIGKILL, environment-change restart.           |
| Reducer            | Every item type, every delta type, completed-without-started, duplicate completion, final-item replacement, stale engine generation, stale turn.       |
| Prompt idempotency | Duplicate ID while running, duplicate after completion, same text/different ID, lost HTTP response, lost app-server response, bridge restart.          |
| Abort              | Before turn starts, during text, during reasoning, during command, during file change, repeated abort, abort followed immediately by new prompt.       |
| Server requests    | Approval, file approval, permissions, user input, MCP elicitation, auth refresh, unknown request, timeout, request resolved during interrupt.          |
| History            | Legacy `exec`, new `appServer`, CLI, archived, missing rollout, corrupt rollout, long history, exact cwd, same name, parent/subagent filtering.        |
| Models/config      | Pagination, hidden models, reasoning order, default effort, fast tier set/clear, plan/build transitions, config changes while idle/running.            |
| Environment        | Tool installed after bridge start, PATH changed during another thread, BASH_ENV update, app-server restart, inline-command parity.                     |
| Subagents          | Spawn, send input, wait, close, multiple levels, parent abort, child completion after parent settlement, bridge reconnect.                             |
| Frontend           | Native chat, build pipeline, reconnect, status polling, SSE replay, same thread in two tabs, optimistic-message deduplication.                         |
| Packaging          | macOS/Linux/Windows, x64/arm64 where supported, local managed binary, Docker global binary, version mismatch.                                          |
| Chaos              | Kill before write, after write, after response, mid-delta, mid-command, mid-patch, during interrupt, during thread resume.                             |
| Performance        | Cold start, first event, sustained token stream, huge command output, many idle threads, concurrent turns, long soak.                                  |
| Security           | Path traversal, invalid attachment paths, malicious protocol fields, log redaction, CORS exposure, sandbox/approval regression, config trust mutation. |
| Rollback           | App-server thread resumed by SDK, SDK thread resumed by app-server, title compatibility, no duplicate turn after engine switch.                        |

---

# Definition of done

The migration should not be considered complete until all of the following are true:

* A single app-server child serves multiple independent Codex sessions in one environment.
* Two tabs cannot start overlapping turns on the same Codex thread.
* Every prompt has a stable request ID and is executed at most once.
* A lost `turn/start` response is reconciled without a blind retry.
* An app-server crash does not lose completed transcript data.
* Active sessions become recovering and eventually terminal; they do not falsely become idle.
* Abort waits for an interrupted terminal turn.
* No stale event from an old turn or process generation can overwrite a newer turn.
* A slow browser cannot block app-server stdout processing.
* Every server-initiated request receives a response or a bounded timeout.
* Runtime PATH changes are visible after a controlled app-server restart.
* Existing `exec` sessions remain listed and resumable.
* New `appServer` sessions remain compatible with rollback.
* Plan, build, fast tier, reasoning effort, images, slash commands, commands, file edits, MCP, and subagents retain UI parity.
* The build pipeline cannot advance on a recovering or ambiguously dispatched turn.
* No app-server process survives bridge or container shutdown.
* App-server memory is bounded during long-running soak tests.
* Unknown protocol events are visible in metrics instead of crashing the bridge.
* The SDK engine remains selectable until the canary criteria are satisfied.

---

# Final recommendation

Proceed with the migration, but treat it as an **engine and lifecycle rewrite behind the existing bridge**, not as an API-call substitution.

The safest first merge is limited to:

1. freezing the current normalized behavior,
2. extracting `CodexEngine`,
3. keeping the SDK implementation as default,
4. generating the pinned app-server protocol,
5. implementing and thoroughly testing the process supervisor and JSONL RPC client.

That first merge should not execute user turns through app-server yet. The second major merge can add thread/turn execution behind the feature flag, followed by idempotency/recovery, UI adoption, subagent migration, canary rollout, and finally SDK removal.

This investigation is based on the current repository source and the pinned Codex protocol/source. I did not execute a live app-server binary here, so the real-binary initialize, turn, interruption, environment, config-trust, and crash-recovery contract suite is a non-negotiable gate before enabling it for real workloads.
