# A resumed Codex conversation shows the prompt as sent, not as typed

Checked against `main` at `930189337` (2026-10-26); fixed against `main` at
`ce205ad34` (2026-10-26).

Found while fixing
[0082-codex-resume-shows-environment-context.md](0082-codex-resume-shows-environment-context.md).
The live tab shows the user's message as they typed it; a reload rebuilt the
**You** row from the rollout, which holds the text the bridge sent to Codex.
The two differed in the cases below, so a resumed transcript showed text the
user never typed.

## Current state

What a reload showed before the fix, per case:

- **Plan mode.** `wrapPromptForConversationMode`
  (`bridges/codex-bridge/src/prompts/slash-commands.ts`) puts a
  `<system-reminder>You are in Orkestrator plan mode…</system-reminder>`
  preamble before the prompt. The live row shows the prompt alone
  (`appendUserMessage`, `app-server-runtime-prompt.ts`). A reload kept the
  preamble: `extractPersistedMessageContent` (`history/rollout.ts`) stripped
  only the coordinator context. A content-free count on 2026-10-26 of the
  2,478 rollouts under `~/.codex/sessions` on arktech-mini found 479 user
  messages holding the preamble, every one a single segment that starts with
  the exact current preamble and its blank-line separator; none held a
  variant. (The first version of this file said ten; that was a smaller
  sample.) The preamble's text has not changed since it was added in #125.
- **Skills.** A typed `/skill:tidy the header` is sent as `$tidy the header`
  plus a skill input (`app-server-runtime-prompt.ts`, `withSkillInput`). The
  live row shows `/skill:tidy the header`; a reload showed `$tidy the header`.
  (The `<skill>` block Codex adds after it is dropped since 0082.)
- **Prompt templates.** A `/template args` command is sent as the expanded
  template text. The live row shows the command; a reload showed the whole
  expansion.
- **Recovered context.** The first prompt after a session whose
  `recoveredContextPending` is set carries the replayed transcript
  (`buildRecoveredContextPrompt`, `app-server-runtime-base.ts`); a reload
  showed that whole block as the user's message. The count above found no
  such message in local rollouts, so this case was reproduced only in tests.

Fixed 2026-10-26:

- `stripPlanModePreamble` (`prompts/slash-commands.ts`) removes the exact
  `PLAN_MODE_PREAMBLE` plus its `\n\n` separator from the start of a
  persisted user message, before the coordinator context is stripped (the
  order the bridge wrapped them in). Anything else, including a
  `<system-reminder>` the user typed or a reworded copy, is left as written.
- For the three cases that cannot be read back from what was sent, the
  runtime records the live row's text once the turn is accepted
  (`recordTypedPrompt`, `sessions/typed-prompts.ts`): one sparse JSONL file
  per thread under the bridge state directory (`typed-prompts/<thread>.jsonl`),
  holding the turn id, a sha256 of the sent text item and the typed text.
  It is written only when the sent prompt differs from the typed one for a
  reason other than the plan preamble.
- `replayPersistedRollout` (`history/rollout.ts`) reads that file once per
  replay and passes `extractPersistedMessageContent` a `typedPrompt` resolver:
  a user message shows the recorded text only when it belongs to the
  recorded turn and its joined text hashes to the recorded digest.
  Attachments still come from the sent text's `<attached-files>` marker.
  Anything else, a thread from the Codex CLI included, shows the rollout's
  text (with the exact plan preamble stripped).
- A fork copies its parent's records before its first replay
  (`inheritTypedPrompts`, called from `forkSession`).
- The rule is in [`bridges/codex-bridge/AGENTS.md`](../../../bridges/codex-bridge/AGENTS.md)
  beside the 0082 rule.

## Outstanding work

1. ~~Make a reloaded user row match the live one in each case.~~ Done
   2026-10-26: exact plan-preamble strip on reload, plus a per-thread record
   of the typed text for skill, template and recovered-context turns (see
   above and the decisions below).
2. ~~Bridge tests: a resumed plan-mode, skill, template and recovered-context
   turn each render the same user message the live stream did.~~ Done
   2026-10-26.
   - `app-server-runtime-typed-prompts.test.ts`: one live session recovers a
     thread whose rollout app-server cannot resume, then sends a
     recovered-context turn, `/skill:tidy the header`, `/review src/a.ts`
     (template), a plan-mode turn, a plan-mode turn and a build turn that
     each hold a `<system-reminder>` the user typed, and a template in plan
     mode. The rollout is built from the exact `turn/start` text items the
     bridge sent, plus Codex's `<skill>` block and a turn continued from the
     CLI. After closing the tab and resuming from a fresh bridge, the **You**
     rows equal the live ones, turn ids included, and the CLI turn shows its
     rollout text. Further cases: a record never applies to a steer in its
     turn, to the same text in another turn or to a rewritten turn; a fork
     keeps its parent's typed prompts. All three tests fail against the old
     reader; the fork test also fails without `inheritTypedPrompts`.
   - `history/rollout-typed-prompts.test.ts`: the extraction rules
     (preamble with coordinator context inside it, user reminders kept, an
     attachment-only plan prompt, attachments kept under a typed answer,
     Codex blocks dropped before the resolver is asked, assistant rows never
     ask).
   - `sessions/typed-prompts.test.ts`: digest matching, what is not
     recorded, malformed lines, newest-wins, compaction bounds, fork
     inheritance, unusable thread ids. `prompts/slash-commands.test.ts`:
     exact-strip cases.
   - `app-server/live-resume-context.test.ts` (gated by
     `RUN_LIVE_CODEX_APP_SERVER=1`, no credits) gained a second test: the
     real pinned 0.164.0 binary against the loopback Responses endpoint runs
     a recovered-context, skill, template and two plan-mode turns with the
     bridge's own wire text, the typed text is recorded as the runtime does,
     and the reload shows each prompt as typed. Passed 2026-10-26 on
     arktech-mini (2 pass, including the 0082 test); against the old reader
     the new test fails. This proves Codex writes the text item verbatim, so
     the digest matches a real rollout.

## Needs verification

- **Real-stack reload.** Not run: a disposable `dev:test --fixture` profile
  with Codex, sending a plan-mode prompt, a `/skill:` command and a template
  from the composer, then reloading the tab and resuming the thread from the
  picker, checking the **You** rows match. The runtime path that writes the
  record is covered by the scripted-child test and the reader by the real
  binary, but no test drives a real composer send through the runtime into
  the real binary and back. This needs model credits (real turns) and a
  browser; it was not done in this build session.
- **Recovered context in the wild.** No local rollout holds a
  recovered-context turn, so that case is proven only by the tests above.

## Constraints and rationale

- Strip only the exact preamble the bridge wrote; a user who types
  `<system-reminder>` must still see it.
- A thread resumed from the Codex CLI or another client has no Orkestrator
  record of what was typed; it must still render the rollout's text.

## Assumptions and decisions

- **Mechanism.** Options: (a) strip every bridge wrapper on reload from the
  rollout text alone; (b) record what was typed for every rewritten turn and
  prefer it on reload; (c) both: strip the deterministic plan preamble,
  record only what cannot be derived. Chose (c). Why: the plan preamble is
  fixed text, so stripping it needs no state and also fixes every plan-mode
  turn written before this change (479 locally); a skill's `$name`, a
  template expansion and the recovered block cannot be inverted (`$name` is
  also what a CLI user types, and an expansion loses its command), so they
  need a record. Pros: old plan-mode turns are fixed; the record stays small
  (commands are short) and only exists for rewritten turns. Cons: two
  mechanisms; skill, template and recovered turns sent before this change
  still reload as sent.
- **Where the record lives.** Options: the dispatch journal (keyed by
  request, kept 24 h, 500 records per workspace); the bridge-session record
  (`PersistedBridgeSession`, like `confirmedModelsByTurn`); a per-thread
  sidecar file like `command-changes/`. Chose the per-thread sidecar under
  the bridge state directory. Why: the journal forgets after a day; a
  session record is per tab, so a resume from the picker in a new tab, after
  the old one closed, would not find it; a thread-keyed file is found by
  every tab, after any restart, on every account sharing the state
  directory. Pros: same lifetime as the rollout's usefulness; failure-silent
  (a lost file costs only the typed form). Cons: one more file per rewritten
  thread, never deleted (as with `command-changes/`, since the bridge never
  deletes a thread); the typed text sits beside the rollout in plain JSON,
  which is the same exposure as the rollout itself (mode 0600).
- **How a record is matched.** Options: turn id alone; sent-text digest
  alone; both. Chose both. Why: a turn can hold more than one user message
  (a steer), and the same sent text can occur in another turn from another
  client; requiring the turn and a sha256 of the trimmed sent text means a
  record applies only to the exact message the bridge wrote. Pros: a CLI
  turn, a steer or a rewritten rollout always shows its own text; only a
  digest of the sent text is stored, never the (possibly large) recovered
  transcript. Cons: if a future Codex rewrote the text item before
  persisting it, records would stop matching and reloads would fall back to
  the sent text; the gated loopback test would catch that on a bump.
- **What is recorded.** The live row's text (`userMessage.content`, the
  prompt with the coordinator context already removed), not `input.prompt`.
  Why: the reader then shows it verbatim, so a forged coordinator block the
  user typed is not stripped a second time. A typed prompt over 32,000
  characters is not recorded (its reload shows what was sent); 500 turns per
  thread are kept, newest first, compacted on write.
- **When it is written.** Right after `markAccepted`, without awaiting it on
  the prompt response; writes are serialized per thread and a reload's read
  waits for pending writes in the same process. A turn whose `turn/start`
  answer was lost and was later reconciled from `thread/read` is not
  recorded, because that path no longer has the typed text. Pros: nothing
  added to the dispatch's ambiguous window. Cons: that rare turn reloads as
  sent.
- **Plan-mode match.** Exact current preamble plus `\n\n` at the very start,
  or the whole trimmed text equal to the preamble (an attachment-only prompt
  whose separator the trim dropped). Options considered: a regex over any
  `<system-reminder>` block, or matching only on turns recorded as plan
  mode. Rejected the regex because it would eat a user's own reminder;
  rejected recording plan mode because it would leave every earlier turn
  unfixed. Cons: a Codex CLI user who pastes the exact twelve-line preamble
  at the start of a prompt would see it stripped; that text is only ever
  written by this bridge.
- **Recovered context on reload.** The recovered thread's first **You** row
  now shows only the typed prompt, as live. The block used to be the only
  place a reload showed the lost thread's history; that history is still
  readable from the old thread, which stays in the resume list. Not adding a
  separate rendering of it here.
- **Forks.** The parent's records are copied into the fork's file before the
  fork's first replay; a record for a turn the fork dropped matches nothing.
- **Session titles** read from the first user message
  (`getSessionMetaFromTranscriptPath`) now lose the plan preamble too; they
  do not consult the typed record, because that fallback only applies when
  the title index has no generated or explicit title. Left as is.
- **Flake seen while validating.** The focused parallel run hit
  [0492](../../tests/flaky-tests/agent-bridges/0492-codex-deleted-session-initial-retry-race.md)
  in a new shape; the owner passed alone three times. Recorded there.

## Related

- [0082-codex-resume-shows-environment-context.md](0082-codex-resume-shows-environment-context.md)
  (Codex's own user blocks on reload).
- [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md)
  (Codex history semantics).
