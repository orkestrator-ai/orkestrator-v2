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
evidence. A child's progress reaches only its own rollout, so while any card of
a running turn is unsettled each publish arms one follow-up publish a probe
interval later (`scheduleSubagentProbe`); never make a card's hydration wait on
the next parent event, which may not come until the turn ends.

A command still `in_progress` when its turn ends is left running, not
running: a unified-exec process the model did not wait for (a dev server, a
watcher) outlives its `exec_command` call, and app-server reports nothing for
it after `turn/completed` (verified on 0.166.0), so nothing will settle it.
`effectiveItem` marks it `left_running` once the turn is terminal and
`commandExecutionParts` renders it with `toolLeftRunning` and no `toolState`;
the renderer reads "left running" with no spinner. A reported end still wins.
`settleEndedAttempt` touches such an item even when app-server had completed
it while in progress, so its row is tracked again however far back it is.
Never render a terminal turn's command as `pending`: the card would contradict
an idle thread for good. Covered by `app-server-runtime-left-running.test.ts`.

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
locks the tab's composer. The notice names the login `account/read` last
reported (`getAccountLoginKind`); a kind that arrives after the refusal
rewords it in place through `account.loginKind`, keeping its occurrence.

A turn the model refused for capacity (`codexErrorInfo: "serverOverloaded"`,
"Selected model is at capacity", or `"policyCapacityUnavailable"`, its 503 for
policy-restricted capacity) is not failed: the bridge continues it
(`app-server-runtime-capacity-retry.ts`, policy in `sessions/capacity-retry.ts`)
with backoff and jitter, as the same `TurnAccumulator` under the same request
id, and shows a `retry` card instead of the refusal line. Keep the session
`running` and the journal record `accepted` from the refusal until the last
attempt ends: unattended workflows fail on the first status read that says
`error`. Never widen it to a code that is not capacity (usage and rate limits,
flex capacity, login refusals and bad requests must fail at once), never send the user's prompt
again, and never interrupt the refused turn on Stop — it has already ended.
A continuation's user message starts with `[Orkestrator automatic retry]`;
replay shows it as the card, never as a message the user typed. See
[1010](../../docs/todo/agent-engines/1010-model-capacity-backoff-retry.md).

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
- On Linux, never give a coordinator profile a deny entry inside another deny
  entry, or one around a read grant. Codex's bubblewrap cannot create the
  nested mask's mount point, so every sandboxed call fails, AGENTS.md
  loading included. It also mounts the mask over the grant, so the grant
  becomes unreadable. `codexCoordinatorTmpDenials` leaves out the
  `:tmpdir`/`:slash_tmp` denials that would; `":root" = "deny"` still
  hides them. Re-prove on Linux with `live-contract.test.ts`,
  `live-refused-calls.test.ts` and `live-coordinator-skills.test.ts` (no
  credits).

- Never let the stdout read loop await a render, an SSE write, or the browser —
  app-server's outbound queue is bounded, so that stalls **every** thread.
- The notification queue (`SerialQueue`) is that loop's overflow, so it is
  bounded by count and bytes. Past a bound it drops what has not started and
  the supervisor replaces the child, because a stream with a dropped
  notification cannot be trusted. A key's tasks drain together, so never rely
  on order across keys.
- Every accumulator mutation that changes what an item renders moves its
  `version` (`ensureItem` or `touch`): a running item's parts are reused while
  it stands still (`runningItemParts`), so a change that skips it never shows.
- A `message.patched` frame carries `content` only when the body changed. It
  applies at `revision - 1`, so absent means unchanged, never empty.
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
- Never send a `readOnly` turn to Codex's `read-only` sandbox where that
  sandbox cannot run. In an environment's container bubblewrap cannot create
  its user namespace, so every command fails and a reviewer reads nothing.
  There the turn runs `danger-full-access` under `untrusted`. Codex 0.167.0
  asks for every command no exec-policy rule allows, so before the thread
  starts the bridge writes `CODEX_HOME/rules/orkestrator-read-only.rules`
  (`codex-read-only-exec-rules.ts`), allowing only programs none of whose
  options writes a file or runs another program (a prefix rule admits any
  arguments: never add `rg`, `sed`, `find`, `git diff`/`show`/`log` or a
  launcher). The router declines every approval the turn asks for at once
  (`refuseApproval`), MCP tool-approval elicitations included. Never approve
  one from the bridge, and never let such a turn's approvals reach a tab or
  the default auto-approve path. Decide the sandbox once per dispatch, so
  the thread and the turn agree, and keep the decision in
  `promptThreadConfig`. Arm the thread's refusal before every `turn/start`
  (a retry may dispatch on a replacement context), and key a legacy
  approval by its `conversationId`.
  The decision is `codexReadOnlyCommandSandboxOff` (`codex-read-only-sandbox.ts`),
  which counts the container marker files (`/.dockerenv`,
  `/run/.containerenv`) for every session, whatever sandbox its policy names,
  as well as a container session policy; keep the coordinator and
  permission-profile exclusions. The session reports it as `readOnlyCommandSandbox` on
  `/session/:id/status`. See "Codex read-only turns in a container" in
  [`coordinator.md`](../../docs/architecture/coordinator.md).
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
  Why each of those choices was made, and which cells become rows: "Codex
  refused cells" in
  [`coordinator-read-only-decisions.md`](../../docs/architecture/coordinator-read-only-decisions.md).
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
  records before its first replay. Records are keyed by thread in the bridge
  state directory, not by tab session, so a resume from any tab finds them.
  Each matches on the turn id and a sha256 of the sent text, so a steer or
  identical text in another turn never borrows it. Like rollouts, records
  are never deleted.
- Agent version bumps follow [`docs/development/upgrade-agents.md`](../../docs/development/upgrade-agents.md);
  the generated protocol under `app-server/generated/` is a lockfile.
- Every session's commands lose the bridge-control credentials: the process
  unions configured shell exclusions with `CODEX_SESSION_SHELL_EXCLUDE` in
  `shell_environment_policy.exclude`
  (bridge tokens, the agent MCP credential, `CODEX_API_KEY`), and a
  coordinator widens it to `CODEX_COORDINATOR_SHELL_EXCLUDE` under `core`
  inheritance. Preserve user, system and ancestor project exclusions, including
  profile exclusions; unreadable or invalid config must refuse launch. Do not add the broad `*_TOKEN`/`*_KEY`/`*_SECRET` families
  for ordinary sessions: their commands use `GH_TOKEN` to push and the
  project's own variables. Re-prove with `live-github-credential.test.ts`.
- A thread whose policy denies `github.write` (every graph agent node) gets a
  `shell_environment_policy` that keeps the GitHub credential out of its
  commands (`github-credential-config.ts`); app-server itself keeps it. Set it
  with dotted keys only, and repeat the process's own `exclude` list
  (`codexProcessShellExclude`): a thread value replaces the process value, so
  dropping it would hand a coordinator's commands the secrets its process
  excludes, and any session's commands the bridge-control credentials. Number the helper resets from 0 and exclude the inherited
  `GIT_CONFIG_*` entries rather than copying them into the request. Re-prove
  after a Codex bump with `live-github-credential.test.ts` (no credits).
- Never resolve an approval to "approved" by default. Every timeout, disconnect,
  generation death and unparseable answer denies. Approving on a technicality would
  run a command the user never saw.
- Never offer or send an exec-policy or network-policy amendment
  (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`). Codex
  writes an accepted one into `CODEX_HOME/rules/`, where it applies to every
  later Codex session on the host, and app-server 0.166.0 has no method to
  list or remove it. The one rules file the bridge writes itself,
  `orkestrator-read-only.rules`, is bridge-owned (rewritten whenever it
  differs), written only for a sandbox-off read-only turn in a container, and
  allows reads only. `approvals.ts` drops the amendments from the descriptor
  and the backend ignores `amendments` from an older bridge. The exec-policy
  prefix alone is forwarded as `proposedCommandPrefix`, a preselection hint
  for an Orkestrator rule (todo 0723 (retired)) that no answer carries back.
- Mark `ruleEligible` only on the v2 command method with app-server's own
  `command` and `kind` `command` (never `writeStdin`, a `commandActions`
  fallback or a legacy argv join), a managed-network host, or a file change
  without `grantRoot`. `live-policy-amendment.test.ts` proves an Orkestrator
  rule answers the identical command and `CODEX_HOME/rules/` stays empty.
  `live-policy-amendment.test.ts` proves Approve saves no rule (no credits).
- A managed-network approval has `networkApprovalContext` and no `command`
  (0.166.0), so the host alone is what a person approves. Codex raises it only
  when `/etc/codex/requirements.toml` enables its proxy, so
  `mise run verify:codex:network-approval` proves it in a disposable container,
  and `mise run verify:codex:network-card` proves the card the app shows for it
  (only under Codex's own sandbox; the host default skips the proxy, 8085).
- Every turn runs in Codex's Default collaboration mode, which refuses
  `request_user_input`. Threads of a watched session (any policy but
  `pipeline`) carry `features.default_mode_request_user_input = true`
  (`codexRequestUserInputConfig`) so the question parks as a card; a pipeline
  keeps the refusal, because nobody would answer it. Verified against 0.164.0
  and 0.166.0 by `live-request-user-input.test.ts` (no credits).
- Never publish a parked question as non-blocking. Codex sends a Default-mode
  question with `isBlocking: false`, but its core awaits the answer with no
  timeout of its own (`is_blocking` only tells a client it may auto-resolve;
  the TUI sends an empty answer after two minutes). `describeInteraction`
  publishes every question `isBlocking: true` and uses the wire flag only for
  the deadline: `true` waits indefinitely, otherwise the bounded, pausable
  one (5 minutes, 24 h when paused), whose expiry cancels with the same empty
  answer. `fake-question-deadline.test.ts` holds one past it on a manual clock
  through the fake app-server's `question` script, which sends what 0.166.0
  sends; keep that script in step on a Codex bump.
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
  **client's own cursor**, not the latest revision: a client adopts every id it
  sees, so anchoring at the latest would let a socket that died mid-handshake
  reconnect looking caught up, never told of its gap. The stream keeps no
  replay, so a cursor that is not current gets `session.reconcile-required`.
- Subscribe *before* checking the cursor, buffering into an array, then flush
  past it. Checking first and subscribing second drops anything emitted in
  between — the exact gap the cursor exists to detect.
- Recordings (`CODEX_BRIDGE_RECORD_NOTIFICATIONS`, armed by
  `CODEX_BRIDGE_RECORD_CONFIRM=1`) contain prompts, file contents and absolute
  paths. Always run `scripts/scrub-codex-recording.ts` and read the diff before
  committing one as a fixture; a test scrubs the fixtures directory and fails on
  any hit, but the scrubber only catches secrets and identity — it does not
  redact prompt or file content unless you pass `--strip-content`. The recorder
  itself must stay O(1) in the read loop — buffer and flush off-loop, never await
  a write.

## Goals stay off

`features.goals=false` stays in `codexAppServerConfigOverrides`. Orkestrator's
goal loop runs in the backend on every provider
([goals.md](../../docs/architecture/goals.md); decisions D1 and D2 of the retired
goal plan, `git show 2b876486b:plans/goals.md`).
Codex's own loop starts turns with no `turn/start`, which the runtime drops
because it handles only the turn it dispatched.
