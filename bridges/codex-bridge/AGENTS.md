# Codex bridge

The bridge supervises one persistent `codex app-server --stdio` child per
environment and talks to it over JSON-RPC on private stdio. There is no second
engine and no feature flag: the per-turn `codex exec` path and the
`@openai/codex-sdk` dependency were both removed once app-server reached parity.
See [`docs/architecture/agent-engines.md`](../../docs/architecture/agent-engines.md).
The rules in [`bridges/AGENTS.md`](../AGENTS.md) and the root
[`AGENTS.md`](../../AGENTS.md) also apply.

`session-titles.ts` is the deliberate exception — it still spawns its own hermetic
`codex exec` with a custom model catalog, read-only sandbox and user config
ignored, so title generation cannot inherit the user's tools or instructions.

| File                                    | Purpose                                            |
| --------------------------------------- | -------------------------------------------------- |
| `src/index.ts`                          | Routes, SSE, composition root                      |
| `src/app-server-runtime.ts`             | Session surface for the app-server engine          |
| `src/event-ring.ts`                     | Bounded SSE replay buffer + cursor parsing         |
| `src/app-server/process-supervisor.ts`  | Child lifecycle, generations, restart policy       |
| `src/app-server/jsonl-rpc-client.ts`    | Transport; must never await consumer work          |
| `src/app-server/approvals.ts`           | Approval descriptors + per-method response mapping |
| `src/app-server/server-request-router.ts` | Answers every server request, exactly once       |
| `src/app-server/notification-recorder.ts` | Opt-in capture of the inbound stream for fixtures |
| `src/sessions/dispatch-journal.ts`      | At-most-once prompt dispatch                       |
| `src/messages/normalization.ts`         | Item → normalized part rendering                   |
| `src/messages/diff-budget.ts`           | Caps the diff state, the largest memory consumer   |
| `src/codex-item-types.ts`               | Local thread-item types (was the Codex SDK)        |
| `src/testing/replay-recording.ts`       | Replays a recording through the real pipeline      |

## When touching the app-server engine

- Never let the stdout read loop await a render, an SSE write, or the browser —
  app-server's outbound queue is bounded, so that stalls **every** thread.
- Never auto-retry an ambiguous dispatch. Only an explicit `-32001` overload means
  the turn definitely did not run; anything else must reconcile via `thread/read`.
- Never report `idle` for `cancelling`/`recovering`. Both map to `running`, which
  is what stops the build pipeline advancing on a turn that may still be executing.
- Never call `thread/delete`. Closing a session unsubscribes; deleting would
  destroy the user's rollout and its descendants.
- Never let a metadata scan read whole rollout files. `getSessionMetaFromTranscriptPath`
  reads only the head; full reads are for hydrating one specific thread. A 1.6GB
  Codex home cost ~5.3GB of retained heap before this.
- Idle threads are detached (`thread/unsubscribe` + state freed) and re-attached
  transparently on the next request. Detaching an **unmaterialized** thread must
  clear its id: it has no rollout, so `thread/resume` would fail forever.
- Never rely on `thread/resume` to change a **loaded** thread's configuration.
  app-server rejoins it and ignores every override, `mcp_servers.*` included, so
  the thread keeps the previous attempt's workflow-result MCP credential.
  `reloadThread` unsubscribes first so the resume rebuilds it from its rollout;
  an unmaterialized thread is replaced instead. A result turn whose thread
  still does not list its submit tool is refused with 424 before journaling.
  Verified against codex 0.158.0.
- Agent version bumps follow [`docs/development/upgrade-agents.md`](../../docs/development/upgrade-agents.md);
  the generated protocol under `app-server/generated/` is a lockfile.
- Never resolve an approval to "approved" by default. Every timeout, disconnect,
  generation death and unparseable answer denies. Approving on a technicality would
  run a command the user never saw.
- Never answer an approval belonging to a **dead generation**. app-server has
  forgotten the request; withdraw the card and say so in the transcript instead
  (`abandonGeneration`). Conversely a *live* child must always be answered —
  closing a session declines on the way out rather than just forgetting.
- Never let the fast server-request backstop fire on a parked approval. It exists
  for a branch that failed to answer; a request awaiting a human has legitimately
  not answered yet, and answering there resolves a prompt the user is reading.
- Never treat an approval as visible just because the SSE frame was emitted. The
  tab may have been unmounted; `/session/:id/approvals` is the authoritative
  rehydration path and reconcile must call it.
- SSE frames carry `id: <revision>`. The `connected` frame must echo the
  **client's own cursor**, not the latest revision: a browser EventSource adopts
  every id it sees, so anchoring at the latest would permanently skip the frames it
  just asked to be replayed if the socket died mid-handshake.
- Subscribe *before* computing an SSE replay, buffering into an array, then flush
  past the replayed range. Replaying first and subscribing second drops anything
  emitted in between — the exact gap the cursor exists to close.
- Recordings (`CODEX_BRIDGE_RECORD_NOTIFICATIONS`, armed by
  `CODEX_BRIDGE_RECORD_CONFIRM=1`) contain prompts, file contents and absolute
  paths. Always run `scripts/scrub-codex-recording.ts` and read the diff before
  committing one as a fixture; a test scrubs the fixtures directory and fails on
  any hit, but the scrubber only catches secrets and identity — it does not
  redact prompt or file content unless you pass `--strip-content`. The recorder
  itself must stay O(1) in the read loop — buffer and flush off-loop, never await
  a write.
