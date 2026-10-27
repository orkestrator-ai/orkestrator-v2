# A resumed Codex conversation shows Codex's environment context as a user message

Checked against `main` at `8454d18b8` (2026-10-24); fixed against `main` at
`930189337` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

The file is Finished: all three items are done and verified at HEAD.

1. **Drop Codex's own user blocks on resume**: filter `CODEX_CONTEXT_FRAGMENTS`, judged per segment. Status: done.
2. **Bridge, rollout and loopback tests**: the resumed rows equal the live ones. Status: done.
3. **Remove the design specs' exclusion and rerun them live**: 1/1 and 3/3 live/resumed user rows. Status: done.
4. **What to do with the file**: delete it under the README rules, or keep it. Status: open (the only decision left).

### 4. What to do with the file

**Problem.** The folder index marks the file Finished, but it is still in `todo/`. The README says that once the last item is done, its durable behaviour moves into `architecture/` or `development/` and the file is deleted.

**Context.** The rule already lives outside the file: `bridges/codex-bridge/AGENTS.md:193` describes the dropped user-role blocks, and `docs/development/upgrade-agents.md:837` carries the bump step that lists them from the binary. 0211, which followed on from this file, also landed (`863b5782`, #1319).

**Investigation.** The code matches the file at HEAD. `CODEX_CONTEXT_FRAGMENTS` is at `bridges/codex-bridge/src/history/rollout.ts:871`, `isSyntheticPersistedUserText` at `:879`, and the per-segment `extractPersistedMessageContent` at `:912`. The "resumed transcript" suite is at `bridges/codex-bridge/src/app-server-runtime-sessions.test.ts:2791`, and `app-server/live-resume-context.test.ts` exists. Neither design spec still mentions an `environment_context` exclusion. The pinned Codex is still 0.164.0 (`packages/toolchain/src/manifest.ts:8`), so the tag list checked against that binary is still current. Inbound links that a deletion must update: `docs/todo/design-canvas/0038-design-agent-conversation-links.md:142` and `:398`, and this folder's 0211 (Related) and index row 9. The decisions section (why each tag, why per segment, why not `<user_instructions>`) has no durable home yet.

**Decisions.**

- **Delete the file now, or keep it?**
  - **Delete it now, moving the rationale for the tag list and the per-segment rule into `bridges/codex-bridge/AGENTS.md` (recommended).** Update the links from 0038 and 0211 and remove index row 9 in the same change.
    - Pros: follows the README rule; the AGENTS.md note and the upgrade step already carry the behaviour; nothing is waiting on a branch.
    - Cons: the live qualification narrative (profile names, row counts) is lost unless it is summarised in the AGENTS.md note.
  - **Delete it together with 0211 in one change.**
    - Pros: one link-update pass, since 0211 links here and both are Finished.
    - Cons: couples this deletion to 0211's own review follow-ups being confirmed.
  - **Keep it as a historical record.**
    - Pros: no link edits.
    - Cons: goes against the README rule, and a Finished row stays in the ranked index for no reason.

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
     Review regressions cover extraction and hydration with user text between
     two matching context blocks (all five tags), and after either AGENTS.md
     heading or the recommended-plugins prefix. The joined-text recheck now
     applies only to a single segment, so it cannot override a mixed message's
     per-segment classification.
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
3. ~~Then drop the environment-context exclusion from the resume step of
   `e2e/agent-testing/design-live.spec.ts`.~~ Done and qualified 2026-10-26.
   - Code done 2026-10-26: dropped there and from
     `e2e/agent-testing/design-resume-clients-live.spec.ts`, which had the
     same exclusion. Both now count every user message.
   - Two-client live run passed 2026-10-26 on this Mac, disposable fixture
     profile `qa-resume-context-0082`, pinned Codex 0.164.0, model
     `gpt-6.1-sol`: **1 user row live, 1 resumed**. The bridge restarted;
     both resume requests overlapped (0/30 ms start, 2872/2874 ms finish),
     converged on one tab and session, and sent nothing. Results:
     `output/agent-testing/qa-resume-context-0082-resume-verified/browser/results.json`
     (1 passed, 0 skipped).
   - Full design cycle passed with the same profile, binary and model:
     **3 user rows live, 3 resumed**, with no exclusion. Launch, stale
     selection, approval across an environment switch/reload, handoff and
     close/resume all passed; 13 design MCP calls, 0 failed. Results:
     `output/agent-testing/qa-resume-context-0082-cycle-verified/browser/results.json`
     (1 passed, 0 skipped).
   - The fixture's default `gpt-5.4` was rejected by this ChatGPT account
     before either first attempt reached resume. The reruns use
     `ORKESTRATOR_AGENT_TEST_DESIGN_MODELS=codex=gpt-6.1-sol`, selected from
     the account's model catalog. Both specs log content-free live/resumed
     row counts after their assertions.
   - The qualification profile was stopped and reset after both passing runs;
     `dev:status` confirms it is missing, with no live processes.

## Review validation

The focused rollout regressions, real-binary loopback resume test
(`RUN_LIVE_CODEX_APP_SERVER=1`), formatting, lint and typechecking passed.
The live browser results above use this checkout with the multipart fix.

The repository aggregate was also run through `test:logged`. Its root group
failed the existing malformed `0887` flake-register entry (missing its required
ID line); the owning register test also fails alone. Its bridge group hit the
catalogue race tracked in [0791](../../tests/flaky-tests/agent-bridges/0791-codex-command-catalogue-stale-race.md)
and the persistence timeout tracked in [0947](../../tests/flaky-tests/agent-bridges/0947-claude-stale-list-tombstone-timeout.md);
both unchanged complete owners passed alone. These failures do not involve
the history reader. No assertions or deadlines were relaxed.
The backend group also repeated the nested-submodule timeout in
[0621](../../tests/flaky-tests/environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md)
and the exec restart cleanup failure in
[0341](../../tests/flaky-tests/backend-services-and-tooling/0341-public-exec-restart-cleanup-eperm.md).
Both complete unchanged owners passed alone (42.2 s and 13.5 s respectively).
The activity batch sweep also repeated [0247](../../tests/flaky-tests/native-agents-and-transcripts/0247-activity-batch-sweep-no-requests.md)
and passed its complete unchanged owner alone in 1.7 s. Backend totals were
11,196 passed, 95 skipped, three failed and one error across 655 files;
root/support reported 3,471 passed and one failed. Every other workspace
package and the protocol lockfile check passed. The aggregate exited 1 after
1010.2 s; retained evidence is in the host temporary directories
`orkestrator-test-run.unZQTH` (group logs and summary) and
`orkestrator-test-run.2JILAH` (outer log).

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
  before), or each segment. Chose each segment, keeping the joined check only
  for single-segment messages after stripping injected wrappers.
  Codex writes instructions and environment as two segments of one message;
  judging segments drops that message even when its first segment is not one
  of the AGENTS.md shapes, and keeps a message where any segment is the
  user's own text. Pros: robust to segment order, including user text between
  matching blocks or after a synthetic prefix. The joined check preserves
  existing single-segment behaviour without discarding mixed messages.
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
- **Live design spec rerun.** Uses a disposable `dev:test --fixture` profile
  with only Codex credentials/platform enabled, the two live opt-in flags,
  and `ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS=codex`. The issue's regression
  checks and real-binary loopback test also passed on this Mac.

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
