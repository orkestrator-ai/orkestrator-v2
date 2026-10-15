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
