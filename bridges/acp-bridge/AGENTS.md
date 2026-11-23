# ACP bridge instructions

[`bridges/AGENTS.md`](../AGENTS.md) and the root [`AGENTS.md`](../../AGENTS.md)
still apply.

## One row per model response

Each model response is its own transcript row (`src/acp-rows.ts`). A provider
`messageId` marks a response when the agent sends one; without it, prose or
thinking that follows a tool call opens the next row, and tool calls join the
trailing row, the response that issued them, until it holds
`SOFT_PARTS_PER_ROW` (256) parts: calls issued back to back then open the next
row, so a row is never front-trimmed in normal operation. A subagent's calls
join the row holding its launch card, at most `MAX_CHILD_PARTS_PER_CALL` (128)
per launch; its oldest are shed (recorded like a trim) and the launch card
never is, so a long subagent cannot fail a structured turn. Never fold a whole turn back into
one row: a turn can run for hours, and a multi-megabyte row fits no transcript
window, so readers only get a trimmed copy and lose its start once newer rows
push it out of the live tail. The same row also failed structured turns on the
per-row part cap.

Older rows therefore change. A late `tool_call_update`, a nested call (on the
row holding its parent) and a turn's plan update find the row holding their
part, never only the trailing one. Every such change bumps `revision`, lowers
`mutatedMessageFloor`, which the incremental `/messages?fromIndex=` window
re-sends from, and notes the row in `revisedRows`, which the v2 transcript
carries as `revisedMessages` once the row has left the live window. Route row
changes through `noteMessageMutation` / `notePartMutation` (or
`commitToolPartMutation`) so they reach both. A late update for a part a trim
or eviction removed is dropped rather than rebuilt as an empty `Tool call`, on
every path (`tool_call_update`, `cursor/task`, `cursor/update_todos`).

Ids are reused across turns. A call missing from the current turn reattaches
to an earlier turn's card only while that work still runs (an unsettled card,
an active background subagent, or a call nested under one); otherwise it
starts a card of its own in the current turn.

## Change signal: state and transcript revisions

The backend learns a session moved without reading it (8102 task 2, D7;
`src/acp-state-revision.ts`).

- **One state revision covers the whole state read**: the `/status` body
  (composer, title, policy, usage, runtime, readiness, ...) and the
  `/approvals` and `/interactions` bodies, the three routes the backend reads
  for an ACP session. `/status` carries it as `stateRevision` and answers
  `{ unchanged: true, stateRevision }` to a still-current
  `?knownStateRevision=`; without the query the body is unchanged apart from
  the added field. The combined `revision` those bodies carry is left out of
  the digest, because it moves with every transcript chunk.
- **The transcript revision is `<process generation>:<state.revision>`.**
  Every transcript change moves `state.revision`, so it moves whenever a
  transcript route's answer would.
- **Every mutation goes through a helper**, never a bare
  `state.revision += 1`: `markSessionChanged` (state, and possibly the
  transcript), `markTranscriptChanged` (rows, chunks, tool cards, trims only)
  or `markStateChanged` (parked requests cleared, policy, read-only, runtime
  notices: sites that never moved `revision`). Each bumps and publishes a
  `session.changed` frame on `GET /event/subscribe?observe=1`
  synchronously, so it is safe inside an ACP listener. When unsure, use
  `markSessionChanged`: an extra bump costs a read, a missing one push latency.
  `acp-state-revision.test.ts` drives every mutation path and fails one whose
  state read changed without the state revision moving; add a step there for
  a new one.

## Sessions without a login

Grok's `authenticate` waits on an interactive sign-in instead of failing when
no login exists, so `acp-credentials.ts` checks for one first (a stored
`auth.json`, `XAI_API_KEY`, or an auth-provider command) and refuses with a
`CredentialError` (401, `kind: "authentication-required"`). A session created
without a login is *deferred*: no agent, an empty `acpSessionId`, and its
requested selection kept on its persisted composer. `spawnAndLoadSession`
creates the ACP session with that selection on the first attach or prompt
after a login exists, and `applyComposerPatch` only records a selection until
then. Code that reads `acpSessionId` must treat the empty string as "not
created yet", never as a session to load.

## Proving a prompt never arrived

`/dispatch` answers `absent` only while the session's prompt journal is
complete (`promptJournalComplete`): set on a session `session/new` created,
never on one adopted with `session/load`, restored only from a record that
carries it and whose journal loaded without a dropped entry, and cleared for
good when an entry is evicted at `MAX_PROMPT_JOURNAL` or left off disk by the
byte budget (`persistedSnapshot` clears it in the write that drops the
entry). It also holds because the prompt route journals the id in the same
synchronous step as its duplicate check and awaits the state-file write before
handing the prompt over; a new path that hands a prompt over must do both, or
leave the session incomplete. Unset means incomplete, so a constructor that
forgets the field fails safe. The write is a rename without fsync, so this
covers a bridge restart, not an OS crash.

## Standard ACP first

Implement standard ACP generically, so every ACP agent benefits; only a
provider quirk goes in `acp-provider-config.ts`, keyed by provider id (the
backend's serialized launcher record replaces the built-in one, so a quirk on
the record would be dropped).

- **`session_info_update` names the session.** `title` is folded to one line
  of at most `MAX_SESSION_TITLE_BYTES`, kept on the session, persisted, and
  reported on `/status`, `/session/:id` and the transcript source; `null`
  clears it, an absent or malformed `title` changes nothing. It is metadata,
  so a replay applies it too.
- **Session instructions use `systemPrompt` where advertised.** An agent whose
  `initialize` declares `sessionCapabilities.systemPrompt` (stable ACP since
  SDK 2.5.0) gets them as `systemPrompt` in `append` mode on `session/new` and
  again on `session/load`, as ACP asks. A provider with a verified vendor field
  (Grok's `_meta.rules`, on create only) keeps it, so they never arrive twice
  (`sessionInstructionsCarrier`).
- **A `speed` config option is the fast-mode toggle.** ACP's `speed` category
  wins over the older `model_config` guess; a `speed` select runs slowest to
  fastest, so off is its first value and on its last.
- **The `compact` action runs the agent's own `/compact`.** ACP has no
  compaction request. `POST /session/:id/compact` becomes a selected
  `/compact` on the prompt route, so it is journaled (optional `requestId`),
  busy-checked and revalidated after an attach like any selection. A live
  inventory without it answers 422 `command-unavailable` before journaling.
- **Every Grok child runs with `GROK_WORKTREE_INHERITS_MAIN_APPROVALS=false`**
  (`POLICY_ENV`), so a TUI "always allow" in the user's main checkout cannot
  skip the permission request the bridge answers from the policy, **and with
  `GROK_STORAGE_MODE=local`**, so a session is not synced to code.grok.com.
  `agent stdio` reads the variable, not the hidden `--storage-mode` flag.

## Grok extensions

Where standard ACP has no surface, Grok's own are used, each confirmed against
the real binary (see the Grok section of `docs/development/upgrade-agents.md`).

- **MCP elicitation is `_x.ai/mcp/elicit`.** `parkGrokElicitation` parks it as
  `mcp-form` or `mcp-url` and answers with `outcome`, never MCP's `action`, which
  Grok reads as malformed and cancels. A form the shared card cannot collect
  (`isSupportedMcpForm`, the rule Claude uses too) and a link that is not
  http(s) are declined on the spot with a notice. An answer that breaks the
  schema gets 400 and the card stays up. `interaction_resolved` for a request
  still parked withdraws it: the server gave up, and nothing is waiting.
- **A fork is `_x.ai/session/fork` plus `session/load`** (`acp-fork.ts`). Grok's
  index keeps whole turns and clamps silently, so `forkPromptIndex` never counts
  rows: it aligns the transcript's prompts with `_x.ai/rewind/points` from the
  newest backwards and refuses anything that does not line up, and any point
  before a compaction, whose fork would still hold what came after it. A message
  mid-turn therefore forks with the rest of its turn. A compaction Grok ran by
  itself leaves no row, so it cannot be refused. The fork takes the source's
  policy but not its per-tab MCP credential, and a read-only session is refused.

## Parked request deadlines

- **A pause only moves the deadline.** `POST .../approvals/:id/hold` and
  `.../interactions/:id/hold` re-arm the request's `InteractionDeadline`
  (`acp-interaction-hold.ts`) at the day-long hold ceiling or, for a
  question, Grok's own question timeout if sooner. Expiry still cancels; a
  hold never answers the request.
- **A held request stops the turn's clock.** The `session/prompt` timeout
  terminates the child that would answer a parked request, so it runs on a
  pausable clock (`acp-prompt-clock.ts`, `AcpProcess.request`'s
  `onTimeoutArmed`): it stops while any request is held, restarts with the
  time it had left when the last hold ends or the held request settles, and
  gives a resumed countdown at least its fresh window. Call
  `syncPromptTurnClock` wherever a parked request is removed or its hold
  changes. `promptDeadlineAt` still caps a countdown that is running.
- **Grok's question timeout is raised at launch, not guessed.** Grok
  abandons an `ask_user_question` on its own timer (30 minutes by default),
  and the request carries no deadline. `acp-question-timeout.ts` resolves it
  per key the way Grok does (`/etc/grok/requirements.toml`, then the
  environment, then `$GROK_HOME/config.toml`) when the child is spawned. If
  nothing sets the duration the child gets
  `GROK_ASK_USER_QUESTION_TIMEOUT_SECS` at the hold ceiling, so the bridge's
  deadline decides; a duration or off switch the user set is left alone and
  published as the request's provider limit.

## Transient provider errors

`requestPromptWithRetriableProviderRetries` continues a turn a transient
provider error ended (`[resource_exhausted]`, `[unavailable]`, Grok's own
overload sentence on a JSON-RPC error), on the shared capacity backoff
(`@orkestrator/protocol/capacity-retry`: five attempts, waits of about 2 to 54 s
with jitter). `ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS` overrides only the base
wait. The wait shows as a `retry` card settled in place, and anything that ends
the turn calls `state.wakeRetryWait`, so Stop never sits out a wait. An error
naming a usage or rate limit, quota or a login is never retried, whatever its
code (`namesLimitOrLogin`). See
[1010](../../docs/todo/agent-engines/1010-model-capacity-backoff-retry.md).

## Policy refusals

- **Refuse with `reject_once`, never `cancelled` or `reject_always`.** Under a
  `deny` policy `onPermission` answers with `policyDenialOutcome`. ACP's
  `cancelled` outcome means the prompt turn itself was cancelled. Grok's
  `reject_always` stores a "never allow" grant in the user's own per-project
  approvals. `cancelled` is used only when a request offers no `reject_once`.
- **A turn ended on that refusal is continued.** Grok 1.0.52 ends its turn on
  any answer except allow (`stopReason: "cancelled"`,
  `_meta.cancellationCategory` `PermissionRejected`), so a read-only
  coordinator or reviewer used to stop at its first refused write without
  reporting. `requestPromptWithRetriableProviderRetries` re-prompts the same
  session with `POLICY_DENIAL_CONTINUATION` when three things hold: the
  attempt ended `cancelled`, `state.policyDeniedRequests` rose during it, and
  the turn is still the bridge's (not cancelled or closed by the user). A turn
  gets at most `POLICY_DENIAL_MAX_CONTINUATIONS`. After that it is recorded as
  a failure. A cancellation naming another category (a hook, `MidTurnAbort`)
  is never continued.

- **Remove Grok mutation tools before prompting.** Every Grok child under a
  `deny` policy loads a private `--agent-profile` excluding `write`,
  `search_replace`, `run_terminal_cmd` and `Agent`, and uses `--no-leader`.
  Grok can run `touch` without requesting permission, so a bridge refusal
  alone cannot enforce read-only operation. Read-only transitions replace the
  child; close removes its temporary profile.
- **Usage belongs to attempts before turns.** Merge duplicate vendor and
  prompt-result carriers within an attempt, then sum consumption across
  continuations. Context occupancy, window and cost (ACP's cumulative session
  cost) retain the latest snapshot. A late carrier after a continued turn
  merges into its last attempt, not the summed turn.
  Reset partial structured output and cancel parked interactions before a
  continuation; an ended attempt cannot own a later attempt's interaction.

## Antigravity

The bridge also runs Google's `agy acp` as provider `antigravity`, a separate
process from Grok's with its own state. Its quirks live in
`src/antigravity-acp.ts`, keyed by provider id like Grok's; the launcher
record is the backend's `acp-provider-launch.ts`
([agent-engines.md](../../docs/architecture/agent-engines.md#antigravity)).

- **No `authenticate` for the Google login.** agy's `authenticate` starts an
  interactive browser sign-in and waits; a session request without a login
  fails at once with `Authentication required`. `AcpProcess.request` maps that
  (and an abandoned sign-in, and the stdout login banner, which is never
  recorded or logged) to a `CredentialError` with fixed text and records the
  refusal for `ANTIGRAVITY_SIGN_IN_RECHECK_MS`. Readiness reads that record;
  there is no file to check, because the login is in the OS keyring. A
  `session/new` refused that way gives the deferred session Grok's file check
  gives. `authenticate` runs only for a method the backend names.
- **Questions before approvals.** A permission request whose tool-call id
  starts `interaction_` is a person's question. `onPermission` parks it
  (`parkAntigravityQuestion`) before every policy branch, so no policy answers
  it; a malformed one is cancelled. It returns exactly one native option id.
- **Client method ceiling.** `ACP_CLIENT_METHOD_CEILINGS` withholds
  `fs/write_text_file` and `terminal/*` whatever the policy grants, so agy
  keeps its native edits. Enforce any new ceiling in the handlers as well as
  in what is advertised.
- **Resume, not replay.** `prefersSessionResume` reattaches a session with a
  retained transcript through `session/resume`; `session/load` is only for
  hydrating an empty one.
- **Instructions** ride `_meta.antigravity.systemPrompt.append` on new, load and
  resume (`sessionInstructionsCarrier`); the standard carrier wins when
  advertised.
- **Not inherited from Grok:** the policy-denial continuation, the read-only
  agent profile and its coordinator note, folder trust, network flags, the
  question timeout, x.ai extensions and Grok's MCP inventory. Add any of them
  for Antigravity only with evidence from the pinned binary.

