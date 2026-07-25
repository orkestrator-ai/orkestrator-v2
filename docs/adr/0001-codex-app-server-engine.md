# ADR 0001 — Codex app-server as a bridge-internal engine

- **Status:** Accepted, implemented, and now the only engine. The per-turn
  `codex exec` path, the `ORKESTRATOR_CODEX_ENGINE` flag and the
  `@openai/codex-sdk` dependency have all been removed.
- **Date:** 2026-07-25
- **Supersedes:** nothing
- **Context document:** [`docs/app-server-upgrade.md`](../app-server-upgrade.md)

## Decision

The per-turn `codex exec` execution path has been replaced by a persistent
`codex app-server --stdio` child, supervised **inside the existing Orkestrator
Codex bridge**. It is the only engine.

```
CodexChatTab / CodexBuildChatTab
          │  unchanged REST + SSE
   Orkestrator Codex bridge          ← one per environment
          │  JSON-RPC over private stdio
   codex app-server --stdio          ← one child per environment
          │
   many Codex threads
```

### What we explicitly did not do

| Rejected | Why |
| --- | --- |
| Browser connects directly to app-server | Its WebSocket transport is documented as experimental and unsupported; stdio is the supported default. The bridge also holds substantial Orkestrator-specific behaviour that app-server does not replace. |
| One global app-server for all environments | Environments differ in filesystem, container, PATH, credentials and installed toolchains. |
| One app-server per tab | Loses the lifecycle and startup benefit that motivates the change. |
| Swap `thread.runStreamed(...)` for a few RPC calls | The change is an engine **and lifecycle** rewrite, not an API substitution. |
| Automatic fallback to `codex exec` after a crash | Would execute the same pending turn through two mechanisms. The bridge restarts app-server instead. |
| Keeping both engines permanently behind a flag | Two live execution paths is standing complexity and a second thing to keep at parity. The flag existed only to de-risk the cutover and was removed once app-server reached parity. |
| Daemon / remote-control mode | Not needed for the first implementation. |

## Frozen behavioural contract

The acceptance criteria for the migration, not aspirations. Each is covered by a
test.

1. **One app-server child per environment**, stdio transport, spawned without a
   shell, in its own process group.
2. **The browser-facing REST/SSE API is unchanged**, apart from additive fields
   (`phase`, `turnId`, `requestId`, `engineGeneration`, richer health).
3. **Bridge session id ≠ Codex thread id.** Two tabs may resume one thread; the
   thread is the canonical owner of the transcript.
4. **Lazy thread creation.** `/session/create` must not create a persisted Codex
   thread, or abandoned sessions pollute the resume dialog.
5. **At most one turn per Codex thread**, even across different bridge sessions.
6. **Every prompt has a stable request id and executes at most once.**
7. **Abort waits for a terminal interrupted turn.** `cancelling` and `recovering`
   report `running` externally.
8. **Closing a session unsubscribes; it never deletes.** `thread/delete` destroys
   the rollout and its descendants and is not wired up.
9. **`approvalPolicy: "never"`**, with `experimentalApi`, `requestAttestation`
   and `mcpServerOpenaiFormElicitation` all declined at initialize.
10. **Analytics stay at their default.** `--analytics-default-enabled` is not
    passed; app-server analytics remain off unless user config enables them.
11. **Session-title generation stays a separate hermetic `codex exec`.**
12. **Runtime PATH changes must become visible** through a controlled restart.

## Empirical findings

Two open questions from the context document were settled against the pinned
binary (`codex 0.145.0`). Both are pinned by
`bridges/codex-bridge/src/app-server/live-contract.test.ts`
(`RUN_LIVE_CODEX_APP_SERVER=1`).

### Project trust mutation is pre-existing, not an app-server regression

`thread/start` with a writable sandbox writes into the user's `config.toml`:

```toml
[projects."/path/to/workspace"]
trust_level = "trusted"
```

`read-only` does not. **Critically, `codex exec --sandbox danger-full-access` —
which the previous engine used for build mode — writes the identical entry.** So
app-server introduced no new configuration side effect.

**Decision: accept and document.** No consent flow is added, because migrating
changes nothing about this behaviour. The contract test will fail if a future
version broadens or removes the mutation.

### `thread/read(includeTurns=true)` rejects unmaterialized threads

On a thread whose first turn never materialized, the call does **not** return an
empty turn list. It fails:

```
-32600  thread <id> is not materialized yet;
        includeTurns is unavailable before first user message
```

This lands exactly on the ambiguous-dispatch recovery path. Recovery must read
this specific error as *"no user message was ever persisted"* — which proves the
turn did not start and makes a single clean re-dispatch safe. Treating it as a
generic failure would strand the prompt; treating it as ambiguous would deadlock
the session. Encoded as `isUnmaterializedThreadError`.

### `thread/list` hides everything by default

Confirmed live: with no `sourceKinds`, `thread/list` returned **0** threads; with
explicit kinds it returned the existing `exec` threads. A naive migration empties
the resume dialog for both legacy and new sessions. The engine always sends
`["cli", "vscode", "exec", "appServer", "unknown"]`, filters `cwd` exactly, and
drops anything with a `parentThreadId`.

## The four hard problems

### 1. At-most-once dispatch

A connection can die *after* `turn/start` is written but *before* its response is
read. A turn runs commands and edits files, so a blind retry is destructive.

```
journal("prepared")        ← before the write
  write turn/start          ← ambiguity begins
journal("accepted", turnId) ← ambiguity ends
```

Recovery keys on `clientUserMessageId`: the browser's request id is echoed back on
the persisted `userMessage` item as `clientId`, so `thread/read` answers *"did
this exact request run?"*. **Never deduplicate on prompt text** — the same text
under a different request id is a legitimately different turn.

Only an explicit `-32001` overload response is safe to retry immediately, because
the server states it did not accept the request. Everything else — timeout,
process exit, write failure — is `ambiguous` and must be reconciled first.

### 2. A shared failure domain

With the old per-turn child, a crash rejected one generator. Now one child serves
every tab and build phase in the environment. Mitigations: monotonic **generations** that
invalidate stale events and requests; ambiguous rejection of in-flight requests;
`recovering` (never `idle`, never `error`) for affected sessions; exponential
backoff with full jitter; and a **circuit breaker** so `/global/health` reports
terminal failure instead of restarting forever.

### 3. The transport must never wait on the browser

app-server uses bounded outbound queues. If the stdout reader awaited an SSE write
or a message rebuild, that back-pressure would stall **every** thread.

```
stdout reader (bounded, synchronous)
  ├─ resolve RPC promise
  ├─ hand server request to router (fire-and-forget)
  └─ append notification to per-thread serial queue
                     └─▶ reduce → coalesce → bounded SSE queues
```

### 4. Interrupt is a lifecycle

`turn/interrupt` only *asks*. The turn is over when a terminal
`turn/completed(interrupted)` arrives. Escalation: re-ask once, then consult
persisted state, then restart the child as a last resort. It never reports `idle`
on a timeout — that is what would let a new prompt overlap a live turn.

## Version pinning

`config/codex-version.json` is the single source of truth.
`scripts/download-codex.sh`, `toolchain-manifest.ts` and `docker/Dockerfile` must
all agree; `tests/unit/version-drift.test.ts` enforces it — and also asserts the
bridge has **no** `@openai/codex-sdk` dependency, so a stray reinstall cannot
resurrect a second execution path.

Protocol bindings are generated from the binary and committed as a lockfile:

```bash
bun run codex:protocol         # regenerate
bun run codex:protocol:check   # CI: fails on any drift
```

The TypeScript bindings are committed (617 files, imported by the bridge). The
3.5MB JSON Schema bundle is **not** — nothing reads it at runtime — but its digest
is, so a schema change still fails the check. Digests canonicalize JSON first:
`generate-json-schema` serializes `definitions` from a Rust `HashMap`, so two runs
of the same binary emit different key order.

## How it is wired

```
index.ts (routes, SSE, composition root)
   └─ AppServerRuntime
        ├─ ThreadRegistry     canonical thread ↔ bridge sessions, detach/re-attach
        ├─ DispatchJournal    at-most-once prompt dispatch
        ├─ AppServerEngine    supervisor + JSONL RPC + reducer
        └─ renderTurn         normalized-message renderer
```

The pieces that are not app-server-specific live outside the runtime and are
imported by it: `messages/` (item rendering, diff budget, coalescer), `prompts/`
(slash commands, prompt shaping), `history/` (rollout parsing). Keeping that seam
is what let the engine be replaced underneath them without touching the renderer
or its tests.

`codex-item-types.ts` holds the thread-item vocabulary that used to come from
`@openai/codex-sdk`. `app-server/item-adapter.ts` converts app-server's camelCase
protocol into it, so a protocol change is absorbed in one adapter rather than
spreading through the bridge.

### Using it

Nothing to configure. The bridge starts its app-server child on boot.
`CODEX_BRIDGE_NO_ENGINE=1` suppresses that, for consumers that import the module
only for its helpers.

Verify with `/global/health`:

```json
{
  "status": "ok",
  "engine": "app-server",
  "appServer": { "state": "ready", "generation": 1, "codexVersion": "0.145.0", "pid": 93240 },
  "storage": { "threads": 2, "detachedThreads": 7, "transcriptCache": { "bytes": 5121 } }
}
```

A terminally failed engine answers **503**, and the backend's health probe requires
a 2xx — so a dead app-server blocks "Codex server started" instead of being
reported as healthy.

### Storage and resume

Everything the bridge holds in memory is a cache; the Codex rollout on disk is the
authoritative transcript. That makes bounded caching safe:

- Threads idle for 30 minutes are **detached** — `thread/unsubscribe` plus their
  transcript, render state and event buffers freed — and re-attached transparently
  on the next request. Detaching an **unmaterialized** thread clears its id, because
  it has no rollout and `thread/resume` would fail forever.
- Metadata scans read only the head of each rollout. Reading them whole cost ~5.3GB
  of retained heap against a 1.6GB Codex home; it is now ~12MB.
- The transcript cache is LRU-capped by bytes; diff baselines are capped by count
  and bytes, and files over 256KB keep the diff but drop `before`/`after`.

### What the UI gains

`/session/:id/status` keeps the `idle | running | error` contract and adds `phase`
(`starting`, `running`, `cancelling`, `recovering`, `idle`, `failed`) plus
`threadId`, `turnId`, `requestId` and `engineGeneration`. `cancelling` and
`recovering` both report `status: "running"`, which is what stops the build
pipeline advancing a phase on a turn that may still be executing — the pipeline
needed no change.

`/session/:id/prompt` answers `202` with `{status, requestId, threadId, turnId,
duplicate?}`. `/session/:id/abort` answers `202 {status: "cancelling"}` rather than
claiming the turn stopped.

## Rollback

There is no engine flag to flip. Reverting means reverting the commit — the normal
mechanism for any change of this size.

Note that `config.toml` project-trust entries and rollouts written by app-server
are **not** reverted. Rollouts stay readable by the CLI (verified: a CLI-created
thread resumes under app-server and vice versa), so a revert does not orphan
conversations.

## Consequences

**Gained:** persistent process (no per-turn startup), first-class thread/turn
lifecycle, native model and history APIs, native subagent items, richer streaming,
and a path to real approvals.

**Accepted costs:** a shared failure domain per environment; a resident Rust
process instead of a per-turn one; substantially higher event volume needing
coalescing; and a dependency on an interface the Codex CLI still labels
experimental — which is why the version pinning, generated protocol lockfile and
real-binary contract tests are mandatory rather than optional. With no second
engine, those are the safety net.

**Not removed:** `session-titles.ts` still spawns its own hermetic `codex exec`
with a custom model catalog, output schema, read-only sandbox and user config
ignored. Folding it into the shared app-server would let title generation inherit
user tools, instructions and plugins. So "only one Codex process exists" is still
not true — there is one persistent child plus a short-lived title generator.

## Known gaps

Nothing here blocks turning the engine on for a canary. Each item is either work
the plan itself deferred, or something that can only be closed by running real
workloads.

**Unverified against real usage** — implemented, but only exercised by tests:

- **Container shutdown.** Process-group termination, pidfile reaping and the
  SIGTERM drain are unit-tested, but `docker stop` against a live container bridge
  has not been run.
- **Per-feature UI parity.** One renderer serves everything, so parity is
  structural rather than coincidental — but plan mode, fast tier, each reasoning
  effort, images, MCP calls and subagent-heavy turns have not each been clicked
  through against a real model.
- **A real multi-turn conversation.** Every turn-level path is covered by tests
  against a scripted app-server and by credit-free contract tests against the real
  binary; a long conversation with real model output has not been run.

**Closed after the initial migration** (see "Follow-up work" below):

- **SSE replay.** Implemented: a bridge-wide revision counter, `id:` on every
  frame, a 512-entry ring, `?since=`/`Last-Event-ID` replay, and a
  `session.reconcile-required` fallback when the cursor has aged out.
- **Approval UI.** Implemented: the four approval methods are offered to the
  renderer and parked pending a human, with a five-minute auto-deny.
- **Golden fixtures.** Partially closed, and *not* in the form the plan described —
  see below.

**Deliberately deferred**, in rough priority order:

- **Fixture coverage.** The record/replay harness exists and is wired into the
  upgrade guide, but only a synthetic fixture is committed. The scenarios in
  `bridges/codex-bridge/src/testing/fixtures/README.md` each need one real model
  run (i.e. credit) to record.
- **Idle shutdown / soak numbers.** The resident child's idle RSS and long-run
  memory profile are unmeasured, so no idle-shutdown policy is implemented.
- **Subagent parity metrics.** Native `collabAgentToolCall` items are reconciled
  against rollout transcripts, but the
  native-versus-rollout mismatch counters the plan describes are not emitted, so
  rollout polling cannot be retired yet.

## Follow-up work

Three of the gaps above were closed after the initial migration landed. The
decisions worth recording:

### SSE replay

`emit()` assigns a monotonic revision before fan-out; each frame carries it as the
SSE `id:`. `/event/subscribe` accepts the client's cursor via `?since=` (our client)
or `Last-Event-ID` (a browser reconnecting on its own) and replays from a 512-entry
ring.

Three decisions that are not obvious:

- **An aged-out cursor is reported, not served.** `EventRing.since()` returns
  `complete: false` and *no events* rather than a partial history, and the endpoint
  answers with `session.reconcile-required`. A truncated replay would look complete
  to the client and leave a permanent hole in the transcript.
- **The listener is registered before the replay is computed**, buffering into an
  array which is flushed afterwards past the replayed range. Replay-then-subscribe
  would drop anything emitted in between — precisely the gap the cursor exists to
  close.
- **The `connected` frame echoes the client's own cursor**, not the latest
  revision. A browser EventSource adopts the id of every frame it sees; anchoring
  at the latest would mean a socket dying mid-handshake reconnects asking for
  everything after the newest event, permanently skipping the frames it had just
  asked to be replayed. Found by a live run against 0.145.0, not by a unit test.

The full status+messages reconciliation was **kept**, not replaced. It is still the
recovery path when the ring cannot help, and the client now resyncs only when it
received no frames at all (a failed connection) rather than on every blip.

### Approvals

The four approval methods (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`, and the two
legacy paths) are offered to the renderer. If it takes ownership the request is
parked; otherwise the router falls through to exactly the previous auto-decline, so
attaching a UI is purely additive.

- **`approvalPolicy: "never"` is unchanged.** This closes the gap where an approval
  that *does* arrive — plan-mode escalation, MCP, a future Codex version — was
  declined rather than shown. Whether to *ask* for approvals is a separate product
  question and was not decided here.
- **Deny is the default in every ambiguous case:** timeout (5 minutes), session
  close, a `presentApproval` that throws, a thread with no addressable session.
- **A dead generation is withdrawn, not answered.** app-server has forgotten the
  request, so the card is retracted and the transcript says why. A *live* child is
  always answered — closing a session declines on the way out, rather than leaving
  the turn waiting on a prompt whose UI has gone.
- **The fast 10s backstop stands down while parked.** It exists for a branch that
  failed to answer; a request awaiting a human has legitimately not answered yet.
- **`/session/:id/approvals` is the authoritative rehydration path.** A tab
  unmounted when the request arrived never saw the SSE frame, and the turn is
  blocked until someone answers — so reconcile fetches rather than trusting events.

Not made interactive: `item/tool/requestUserInput` and
`mcpServer/elicitation/request` need arbitrary-schema form UI, and `item/tool/call`
would require us to execute a tool. These still cancel with an explanation.

### Fixtures: what was achievable, and what was not

**The plan's original purpose is unachievable.** Phase 0 wanted golden snapshots
captured from the SDK engine so the app-server engine could be proven to render
identically. `sdk-exec-engine.ts` is deleted; there is no second engine to compare
against. Cross-engine parity can no longer be tested at all.

What replaced it is a single-engine **regression** harness:
`CODEX_BRIDGE_RECORD_NOTIFICATIONS` captures the raw inbound stream verbatim, and
`replay-recording.ts` drives it back through the production pipeline
(`parseInboundLine` → `reduceNotification` → `TurnAccumulator` → `renderTurn`),
snapshotting the structure and asserting no unknown methods or unrenderable items.

This is arguably more useful than the original: it targets the failure the next
Codex bump actually causes — a renamed field that renders as nothing — rather than
a parity question that no longer exists. It is also weaker in one respect, and the
distinction matters: every other reducer test uses hand-authored notifications, so
it encodes what we *believe* app-server emits. Only a recorded fixture tests what it
*does*. Writing the synthetic fixture immediately surfaced two of my own wrong
assumptions about `CodexErrorInfo` and the legacy approval params, both caught by
reading the generated bindings.

The recorder is O(1) in the read loop (buffer plus an off-loop flush) for the same
reason as everything else on that path: awaiting a disk write there would stall
every thread in the environment.
