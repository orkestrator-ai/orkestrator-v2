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
- **The `compact` action runs the agent's own `/compact`.** ACP has no
  compaction request. `POST /session/:id/compact` becomes a selected
  `/compact` on the prompt route, so it is journaled (optional `requestId`),
  busy-checked and revalidated after an attach like any selection. A live
  inventory without it answers 422 `command-unavailable` before journaling.
- **Every Grok child runs with `GROK_WORKTREE_INHERITS_MAIN_APPROVALS=false`**
  (`POLICY_ENV`), so a TUI "always allow" in the user's main checkout cannot
  skip the permission request the bridge answers from the policy.

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
