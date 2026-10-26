# A resumed Codex conversation shows the prompt as sent, not as typed

Checked against `main` at `930189337` (2026-10-26).

Found while fixing
[0082-codex-resume-shows-environment-context.md](0082-codex-resume-shows-environment-context.md).
The live tab shows the user's message as they typed it; a reload rebuilds the
**You** row from the rollout, which holds the text the bridge sent to Codex.
The two differ in the cases below, so a resumed transcript shows text the user
never typed.

## Current state

- **Plan mode.** `wrapPromptForConversationMode`
  (`bridges/codex-bridge/src/prompts/slash-commands.ts`) puts a
  `<system-reminder>You are in Orkestrator plan mode…</system-reminder>`
  preamble before the prompt. The live row shows the prompt alone
  (`appendUserMessage`, `app-server-runtime-prompt.ts`). A reload keeps the
  preamble: `extractPersistedMessageContent` (`history/rollout.ts`) strips
  only the coordinator context. Checked 2026-10-26 by passing a wrapped
  prompt through `extractPersistedMessageText`; the result starts with
  `<system-reminder>`. The local rollouts on arktech-mini hold ten such user
  messages.
- **Skills.** A typed `/skill:tidy the header` is sent as `$tidy the header`
  plus a skill input (`app-server-runtime-prompt.ts`, `withSkillInput`). The
  live row shows `/skill:tidy the header`; a reload shows `$tidy the header`.
  (The `<skill>` block Codex adds after it is dropped since 0082.)
- **Prompt templates.** A `/template args` command is sent as the expanded
  template text. The live row shows the command; a reload shows the whole
  expansion.
- **Recovered context.** The first prompt after a session whose
  `recoveredContextPending` is set carries the replayed transcript
  (`buildRecoveredContextPrompt`, `app-server-runtime-base.ts`); a reload
  shows that whole block as the user's message. Found by reading the code,
  not observed.

## Outstanding work

1. Make a reloaded user row match the live one in each case. Options:
   strip the exact plan-mode preamble on reload, the way
   `stripCoordinatorContext` strips the coordinator block; or record what the
   user typed (for example in the dispatch journal or a bridge-side index
   keyed by turn) and prefer it on reload. Read `bridges/AGENTS.md` and
   `bridges/codex-bridge/AGENTS.md` first.
2. Bridge tests: a resumed plan-mode, skill, template and recovered-context
   turn each render the same user message the live stream did.

## Constraints and rationale

- Strip only the exact preamble the bridge wrote; a user who types
  `<system-reminder>` must still see it.
- A thread resumed from the Codex CLI or another client has no Orkestrator
  record of what was typed; it must still render the rollout's text.

## Related

- [0082-codex-resume-shows-environment-context.md](0082-codex-resume-shows-environment-context.md)
  (Codex's own user blocks on reload).
- [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md)
  (Codex history semantics).
