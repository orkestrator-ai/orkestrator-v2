# Codex bridge

The bridge supervises one persistent `codex app-server --stdio` child per
environment and talks to it over JSON-RPC on private stdio. There is no second
engine and no feature flag: the per-turn `codex exec` path and the
`@openai/codex-sdk` dependency were both removed once app-server reached parity.
See [`docs/architecture/agent-engines.md`](../../docs/architecture/agent-engines.md).
The rules in [`bridges/AGENTS.md`](../AGENTS.md) and the root
[`AGENTS.md`](../../AGENTS.md) also apply.

The bridge generates no session titles: the backend does
(`apps/backend/src/core/session-title-service.ts`) and renames the thread
through `POST /session/:id/title`. `session-title-index.ts` only persists
titles beside Codex's own index.

| File                                    | Purpose                                            |
| --------------------------------------- | -------------------------------------------------- |
| `src/index.ts`                          | Routes, SSE, composition root                      |
| `src/app-server-runtime.ts`             | Session surface for the app-server engine          |
| `src/app-server-runtime-context.ts`     | State shared by the runtime's collaborators        |
| `src/app-server-runtime-rows.ts`        | A turn's assistant rows: open, render, publish     |
| `src/event-ring.ts`                     | Bounded SSE replay buffer + cursor parsing         |
| `src/app-server/process-supervisor.ts`  | Child lifecycle, generations, restart policy       |
| `src/app-server/jsonl-rpc-client.ts`    | Transport; must never await consumer work          |
| `src/app-server/approvals.ts`           | Approval descriptors + per-method response mapping |
| `src/app-server/server-request-router.ts` | Answers every server request, exactly once       |
| `src/app-server/notification-recorder.ts` | Opt-in capture of the inbound stream for fixtures |
| `src/sessions/dispatch-journal.ts`      | At-most-once prompt dispatch                       |
| `src/bridge-state-dir.ts`               | Where session records live; shared across accounts |
| `src/sessions/refused-cell-tail.ts`     | Refused code-mode cells, read from the rollout     |
| `src/sessions/typed-prompts.ts`         | What was typed for a rewritten prompt, per thread  |
| `src/history/code-mode-mcp-calls.ts`    | A reload's code-mode MCP calls, rendered as live   |
| `src/messages/normalization.ts`         | Item → normalized part rendering                   |
| `src/messages/diff-budget.ts`           | Caps the diff state, the largest memory consumer   |
| `src/messages/file-change-diff.ts`      | Decodes app-server's per-file `fileChange` payload |
| `src/change-evidence.ts`                | Change-tracking adapter and its evidence spool     |
| `src/codex-item-types.ts`               | Local thread-item types (was the Codex SDK)        |
| `src/testing/replay-recording.ts`       | Replays a recording through the real pipeline      |

## One row per model response

A turn renders as one assistant row per model response, plus a row after each
steer (`TurnAccumulator.opensModelStep`, `app-server-runtime-rows.ts`). Live
items name no response, so the boundary is inferred: a new reasoning or agent
message item after a tool call in the live row opens the next row, and so does
a new tool call after app-server reported a finished response. That report is
`thread/tokenUsage/updated`, sent once per Responses API completion, tool-only
responses included (`model.response.completed`; `rawResponse/completed` names
the response but needs the experimental API). Without it a model reading files
one call at a time with no reasoning item grew one row for the whole run. A
code-mode cell's own calls stream after its response's report, so a cell making
several calls can split once inside itself; rows stay bounded by responses. A
reload splits at the same places, using the rollout's `token_usage_record` (or
the older `token_count` event) after each response (`history/rollout.ts`).
Replayed rows are named by their place in the rollout (`replayedRowId`), so
every replay — an idle re-attach or a bridge restart — gives each row the same
id; only the first replay after live streaming re-keys them, because live rows
are minted before app-server names their turn. Never fold a whole turn back
into one row: a turn can run for hours, and a single multi-megabyte row fits no
transcript window, so readers can only show a trimmed copy and lose it once a
newer row pushes it out of the live tail. A late change to an item (a command
finishing, its measured line changes, a sub-agent reporting back) re-renders the
row holding it, not the newest one; a sub-agent's card stays on the row whose
item spawned it. Rows keep render state up to `MAX_TRACKED_ASSISTANT_ROWS`
(plus up to `MAX_HELD_ASSISTANT_ROWS` still waiting on a sub-agent); a row let
go is tracked again when one of its items changes, the turn ending included,
so never make a late change depend on its row still being tracked. A row let
go keeps its rendered file changes and sub-agent cards (`ReleasedAssistantRow`)
and, tracked again, re-renders only the items that changed. The turn's end also tracks
again every row let go while a card could still read as running. A publish
tick renders only the rows that moved, and a row whose sub-agents have all
finished (a failed spawn waits for none) is probed again only on new lifecycle
evidence.

A steer goes above every row whose items all followed it — the next response
can open its row while `turn/steer` is in flight — and never freezes an empty
row. A row that changes while a newer row follows it is noted in the
session's `revisedRows`, which the transcript routes pass as
`revisedMessageIds` so a late change to a row outside the live window still
reaches readers; clear it whenever the history is replaced. Note through
`bumpMessageRevision(context, rows)`, in the step that bumps the revision,
never when the change is sent: a send waits for the coalesced flush and can be
dropped, and a note that lands after a read bumps nothing. Never note the
newest row, which every window holds.

A turn app-server reports failed (`turn/completed` with `status: "failed"`)
ends with an error `status` line on its last row saying why
(`messages/turn-failure.ts`; the provider's JSON body is reduced to its
`error.message`). A refused model fails the turn before anything streams, so
without it the turn read as idle with an empty reply. The rollout keeps the
same error on `task_complete`, and the replay adds the same line. The bridge's
own verdicts (a rejected structured result, a lost rebind) add none. A turn
failed for its login (`unauthorized`, or a 401 `toTurnError` keeps as
`httpStatusCode`) also raises the thread's `needs-auth` notice
(`refusedLoginNotice`); never raise it on a failure without a 401, because it
locks the tab's composer.

## File changes and change evidence

- A `fileChange` row is rendered only from app-server's own per-change `diff`
  (`messages/file-change-diff.ts`): whole content for add/delete, headerless
  hunks plus a `Moved to:` note for update. Never reconstruct it from the
  worktree or `git show HEAD:`; that shows whatever the file holds when the
  row renders. A change with no payload (older history) is path-only, counts
  unknown. Keep the real status: `in_progress` is a proposal (pending row),
  `declined` never ran; neither is folded into `completed`.
- `change-evidence.ts` records the live item lifecycle on one per-process
  spool (`GET /change-evidence`, `/body`, `POST /ack`, beside the transcript
  routes). `conversationId` is the bridge session id the backend addresses in
  `/session/:id` (one frame per session bound to the thread), `callId` the
  item id (the row's `toolUseId`), `turnId` the Codex turn id. Calls are
  synchronous spool appends from the notification path; never await there.
  A reload from the rollout emits nothing.

## When touching the app-server engine

- A coordinator's skills widen what it reads, never what it runs
  (`codexLoadsProjectSkills`, `codexCoordinatorSkillExtraRoots`,
  `codexCoordinatorSkillReadRoots`). The checkout stays pinned untrusted; only
  its skills stop being disabled. A read grant follows only the user's own
  skill roots and a linked target that holds a `SKILL.md` and is not HOME, `/`
  or an ancestor, never a link in the checkout. Extra roots live in the child,
  so a new generation gets them again before it lists skills or starts a
  thread. Re-prove with `live-coordinator-skills.test.ts`.

- Never let the stdout read loop await a render, an SSE write, or the browser —
  app-server's outbound queue is bounded, so that stalls **every** thread.
- Never auto-retry an ambiguous dispatch. Only an explicit `-32001` overload means
  the turn definitely did not run; anything else must reconcile via `thread/read`.
- `/dispatch` answers `absent` only from the journal, never from `thread/read`:
  the journal must be *tracked* (kept by this version since its file was
  created; an older bridge's rewrite drops the `completeness` block and
  untracks it for good), the session created fresh by `createSession` (never
  resumed, forked or a marker evicted), no record of the id under any session,
  the id not in the journal's fixed 16 KiB filter of removed and steered ids,
  and no prompt for it in flight. Every removal of a record, whatever its
  state, goes into that filter, and `turn/steer` writes the id there before it
  is sent, so never remove a record or send a request id to app-server any
  other way. There is no fsync: this holds across a bridge restart, not an OS
  crash or a deleted state directory.
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
- Never treat the permission profile's `network.enabled = false` as "no network".
  It stops commands; hosted web search (`web__run` in code mode) runs on
  OpenAI's servers. A network-denied thread gets `codexNetworkDeniedConfig`:
  `disabled`, or `cached` when the policy allows search. Never `live`, which
  opens any URL the model names. A coordinator thread is refused unless
  `config/read` reads the expected mode back (`assertHostedNetworkLock`).
  A `readOnly` turn adds the denial (`codexReadOnlyTurnPolicy`), and the
  runtime reloads the thread whenever the search setting changes between
  turns (`promptThreadConfig`); a resume that names no mode restores Codex's
  own (verified against 0.164.0 by the loopback test). Never let a
  search-denied turn run on a history that declares tools: with
  `features.incremental_tools` (default-on since 0.164.0) each turn's tools,
  `web__run` included, are written into the history and replayed on resume,
  and thread config cannot turn it off. Every bridge runs app-server with it
  off (`codexAppServerConfigOverrides`); the engine reads that back
  (`codexToolHistoryGaps`, and for coordinators `codexHostedNetworkLockGaps`)
  and refuses a search-denied resume or fork whose rollout, or fork ancestor,
  holds an `additional_tools` record (`sessions/tool-history-guard.ts`). The
  loopback test asserts no `web__run` anywhere in a resumed read-only request. After a Codex bump, run `live-network-lock.test.ts` with
  `RUN_LIVE_CODEX_APP_SERVER=1` (no credits), and once with
  `RUN_LIVE_CODEX_WEB_SEARCH_CANARY=1`, which spends a few turns proving
  `cached` still refuses a page `live` opens.
- Never read a missing tool row as "the model did not try". Under a sandbox
  (`read-only` or `workspace-write`), app-server emits no item for a call the
  sandbox refuses: a rejected `apply_patch`, or a failing command whose output
  looks like a denial ("Operation not permitted", "Permission denied",
  "Read-only file system"…). The model still gets the refusal; only the
  rollout keeps the code-mode `exec` cell and its output. `RefusedCellTail`
  reads the active turn's rollout records (path from `thread.path`) from the
  file size captured before `turn/start`, so a fast turn's cells are not
  skipped. It polls every 200 ms, and the turn's events are applied in order
  behind a read before each new model response and before `turn.completed`,
  so a cell lands in the row of the response that ran it. It shows a cell as
  a failed `exec` row when no item of the turn started while it ran, or its
  output reports a refusal, but never for a cell an interrupt stopped
  (`code_mode_interrupt`, output "aborted by user after …"). `fs.watch` cannot replace the poll: on macOS it
  reports nothing for Codex's appends through its open descriptor. Raw
  response events cannot either: `experimentalRawEvents` exists only on
  `thread/start`, so a thread resumed in a new app-server never gets them.
  Verified against 0.164.0 by `live-refused-calls.test.ts` (no credits).
- Never reload a code-mode MCP call from its `exec` cell when the rollout
  recorded it. Each call is an `event_msg` `item_completed` record with an
  `McpToolCall` item; `history/code-mode-mcp-calls.ts` renders it through the
  live adapter and `mcpToolCallParts`, so the reloaded part (id, arguments,
  outcome, output) matches live and anchors an artifact publication. As live,
  a cell whose only recorded work was MCP calls loses its `exec` row unless its
  output reports a refusal. Only a cell with no record falls back to its
  source: strict-JSON single-argument `tools.mcp__<server>__<tool>(…)` calls,
  bounded, never evaluated, and never claimed successful.
- Never reload a user message Codex wrote itself as a **You** row. The live
  tab shows only what the user sent, but the rollout also holds Codex's own
  user-role blocks: AGENTS.md instructions, `<environment_context>`, a
  skill's `<skill>` instructions, `<turn_aborted>`, `<subagent_notification>`
  and `<user_shell_command>`. `isSyntheticPersistedUserText`
  (`history/rollout.ts`) drops a message only when every segment is such a
  block, framed by its own open and close tags, so a prompt that mentions a
  tag still renders. A Codex bump re-checks the list (`upgrade-agents.md`;
  `live-resume-context.test.ts`, no credits).
- Never reload a prompt the bridge rewrote as the text it sent. The live row
  shows what the user typed; the rollout holds the wire form. The reader
  strips the exact plan-mode preamble (`stripPlanModePreamble`, so a
  `<system-reminder>` the user typed stays), and for a `/skill:` command, a
  template and a recovered-context turn the runtime records the live row's
  text after `markAccepted` (`sessions/typed-prompts.ts`). A record applies
  only to the first matching user message of its turn, before synthetic-block
  heuristics are applied. Independent per-turn files retain every record, and
  replay loads one turn at a time. Codex's
  balanced image framing is excluded from matching an attached prompt;
  anything else, a thread from the Codex CLI included, shows the rollout's
  text. Changing `PLAN_MODE_PREAMBLE` needs the old wording stripped too, or
  every earlier plan-mode turn reloads with it. A fork copies its parent's
  records before its first replay.
- Agent version bumps follow [`docs/development/upgrade-agents.md`](../../docs/development/upgrade-agents.md);
  the generated protocol under `app-server/generated/` is a lockfile.
- Never resolve an approval to "approved" by default. Every timeout, disconnect,
  generation death and unparseable answer denies. Approving on a technicality would
  run a command the user never saw.
- Never offer or send an exec-policy or network-policy amendment
  (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`). Codex
  writes an accepted one into `CODEX_HOME/rules/`, where it applies to every
  later Codex session on the host, and app-server 0.164.0 has no method to
  list or remove it. `approvals.ts` drops the proposals from the descriptor
  and the backend ignores `amendments` from an older bridge.
  `live-policy-amendment.test.ts` proves Approve saves no rule (no credits).
- Every turn runs in Codex's Default collaboration mode, which refuses
  `request_user_input`. Threads of a watched session (any policy but
  `pipeline`) carry `features.default_mode_request_user_input = true`
  (`codexRequestUserInputConfig`) so the question parks as a card; a pipeline
  keeps the refusal, because nobody would answer it. Verified against 0.164.0
  by `live-request-user-input.test.ts` (no credits).
- A pause (`POST …/approvals/:id/hold`, `…/interactions/:id/hold`) only moves the
  parked request's `InteractionDeadline` to its hold ceiling (24 h, or a
  question's `autoResolutionMs`); expiry still declines or cancels. A hold never
  answers the request, and the GET rehydration routes publish the moved
  `expiresAt` and `hold` at once.
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
