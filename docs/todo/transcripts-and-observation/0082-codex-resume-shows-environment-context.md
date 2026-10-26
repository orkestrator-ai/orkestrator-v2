# A resumed Codex conversation shows Codex's environment context as a user message

Checked against `main` at `8454d18b8` (2026-10-24); fixed against `main` at
`930189337` (2026-10-26).

Found while qualifying design conversation links live
([0038-design-agent-conversation-links.md](../design-canvas/0038-design-agent-conversation-links.md)).
After a Codex conversation is resumed, the transcript gains a **You** message
holding Codex's synthetic `<environment_context>` block (working directory,
shell, date, timezone, sandbox). The live tab never showed it. A user can read
it as a prompt Orkestrator sent on their behalf; nothing was sent.

## Current state

- Observed 2026-10-24 on mbp3, disposable profile `qa-design-live-0038`: a
  Codex design conversation's live projection held one user message; after
  closing the tab and resuming the thread, the projection and the rendered
  transcript held two, the first being `<environment_context>…`. The rollout
  still held one turn (`task_started` once), so no prompt was dispatched. The
  live design spec (`e2e/agent-testing/design-live.spec.ts`) saw 3 user
  messages live and 4 after resume for the same reason.
- The **You** rows of a resumed thread come from the rollout, not from
  `thread/resume`'s turns: `reduceHistoricalTurns` skips `userMessage` items,
  and `hydrateMessagesFromPersistedSession`
  (`bridges/codex-bridge/src/history/rollout.ts`) builds every user row from
  the rollout's `response_item` user messages through
  `extractPersistedMessageContent`. The same path serves a tab's own **Resume
  Session** picker and every idle re-attach.
- A filter for a message that is exactly an `<environment_context>` block
  landed on `main` on 2026-10-25 in #1247 (`162584a52`), after this file was
  written. It did not cover Codex's other user blocks.
- Fixed 2026-10-26: `isSyntheticPersistedUserText` now drops every block
  Codex writes as a user message of its own (`CODEX_CONTEXT_FRAGMENTS`:
  `environment_context`, `skill`, `turn_aborted`, `subagent_notification`,
  `user_shell_command`, plus the AGENTS.md heading checks), and
  `extractPersistedMessageContent` judges each segment of a message, so a
  message is dropped only when every segment is such a block.

## Outstanding work

1. ~~In the Codex bridge, drop a historical user message whose whole text is
   an `<environment_context>` block (and check whether `<user_instructions>`
   and similar synthetic items need the same).~~ Done 2026-10-26.
   - The environment block alone was already dropped by #1247. Checked the
     rest against the pinned 0.164.0 binary (`strings` lists the open and
     close tags of `environment_context`, `skill`, `turn_aborted`,
     `subagent_notification` and `user_shell_command`; the 0.162.1, 0.159.2
     and 0.159.3 binaries list the same five) and against the 1,500 newest
     rollouts on arktech-mini: their user-message segments open with
     `<environment_context>` (1,511), `# AGENTS.md instructions for ` (752),
     `# AGENTS.md instructions` (744), `<skill>` (4) and `<turn_aborted>` (2).
     A skill turn and a pre-0.164 interrupt therefore still showed a **You**
     row the live tab never had; both are now dropped.
   - `<user_instructions>` is not in any of the four binaries and in none of
     the local rollouts, so it is not filtered (see decisions).
   - Code: `bridges/codex-bridge/src/history/rollout.ts`
     (`CODEX_CONTEXT_FRAGMENTS`, `isSyntheticPersistedUserText`, the
     per-segment check in `extractPersistedMessageContent`).
2. ~~Bridge test: a resumed thread whose turns start with an
   environment-context user item renders the same user messages as the live
   stream did.~~ Done 2026-10-26.
   - `app-server-runtime-sessions.test.ts` ("resumed transcript"): four
     prompts stream live, the tab is closed, and a fresh bridge resumes the
     thread from a rollout in Codex 0.164's shape (instructions and
     environment as one two-segment message, the environment alone after a
     cwd change, a `<skill>` block after the `$name` prompt, a user-role
     `<turn_aborted>`, and a prompt that starts with `<environment_context>`).
     The resumed **You** rows equal the live ones, each on its own turn. It
     fails against the old reader with the `<skill>` and `<turn_aborted>`
     rows.
   - `history/rollout.test.ts`: every block is dropped, judged per segment;
     a user's text that starts with or mentions a tag, or holds one beside
     their own segment, is kept.
   - `app-server/live-resume-context.test.ts` (gated by
     `RUN_LIVE_CODEX_APP_SERVER=1`, no credits): the real pinned 0.164.0
     binary against a loopback Responses endpoint runs a plain turn, a skill
     turn, an interrupted turn and a turn whose prompt starts with
     `<environment_context>`, with no AGENTS.md (the isolated-profile shape).
     It asserts the rollout holds `<environment_context>` and `<skill>` as
     user messages, and that the reload shows exactly the four prompts.
     Passed 2026-10-26 on arktech-mini; against the old reader it fails with
     the `<skill>` block as a **You** row. It also showed that 0.164.0 writes
     `<turn_aborted>` as a developer message, which never renders.
3. Then drop the environment-context exclusion from the resume step of
   `e2e/agent-testing/design-live.spec.ts`.
   - Code done 2026-10-26: dropped there and from
     `e2e/agent-testing/design-resume-clients-live.spec.ts`, which had the
     same exclusion. Both now count every user message.
   - Still owed: a live run of both specs for Codex without the exclusion.
     They spend real model turns and need a `dev:test --fixture` profile with
     Codex credentials, which this change did not run. Follow "Live
     design-tool cycle" in
     [`agent-testing.md`](../../development/agent-testing.md) and its
     two-client Resume run, with `ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS=codex`
     for both (`ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1` and
     `ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME=1`), and record the resume
     step's user message counts here (live and resumed should now be equal).
     The bridge behaviour they check is already proven against the real
     binary by item 2's live test.

## Assumptions and decisions

- **Which blocks to drop.** Options: only `<environment_context>` (what the
  file named); every block Codex writes as a user message of its own; or any
  message that starts with an XML-like tag. Chose Codex's own set, read from
  the pinned binary and confirmed in real rollouts. Why: a skill turn and an
  older interrupt had exactly the same bug, and the binary's tag list is
  evidence rather than a guess. Pros: resumed transcripts match live for every
  case seen; the list is short and checkable after a bump. Cons: a future
  Codex block is missed until someone adds it, so `upgrade-agents.md` now
  carries a step to list them.
- **How exact the match is.** Options: prefix only; open and close tag around
  the whole segment; full parse of the block. Chose open and close tag around
  the whole trimmed segment, the rule #1247 already used for the environment
  block. Pros: a prompt that starts with or quotes a tag still renders; cheap.
  Cons: a user whose whole message is a well-formed `<skill>…</skill>` block
  loses it on reload. That is an implausible prompt, and the live row still
  showed it.
- **Per segment or whole message.** Options: judge the joined text (as
  before), or each segment. Chose each segment, keeping the joined check too.
  Codex writes instructions and environment as two segments of one message;
  judging segments drops that message even when its first segment is not one
  of the AGENTS.md shapes, and keeps a message where any segment is the
  user's own text. Pros: robust to segment order. Cons: none seen; the joined
  check is kept only so behaviour for single-segment messages is unchanged.
- **`<user_instructions>`.** Options: add it pre-emptively, or leave it out.
  Left it out: no binary from 0.159.2 to 0.164.0 contains it and no local
  rollout uses it, and the rule is to filter only what Codex is known to
  write. Pros: no speculative matching. Cons: a thread written by a much
  older Codex could still show it; add it if one is seen.
- **Other resume mismatches.** A plan-mode prompt reloads with the bridge's
  `<system-reminder>` preamble, a skill command as `$name` instead of
  `/skill:name`, and a template as its expansion. These are the bridge's own
  wire text, not Codex's blocks, and need a different fix (strip the exact
  preamble, or record what was typed). Filed as
  [0211-codex-resume-shows-wire-prompt.md](0211-codex-resume-shows-wire-prompt.md)
  rather than widened here.
- **Live design spec rerun.** Not run here: it spends real Codex turns and
  needs a credentialed `dev:test` profile; the free loopback test covers the
  bridge behaviour against the real binary. Left open under item 3.

## Constraints and rationale

- Filter only exact synthetic blocks; a user prompt that mentions the tag must
  still render.

## Related

- [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md)
  (Codex history semantics).
- [0211-codex-resume-shows-wire-prompt.md](0211-codex-resume-shows-wire-prompt.md)
  (the bridge's own wire text on reload).
- The rule now lives in [`bridges/codex-bridge/AGENTS.md`](../../../bridges/codex-bridge/AGENTS.md)
  and the bump check in
  [`upgrade-agents.md`](../../development/upgrade-agents.md).
