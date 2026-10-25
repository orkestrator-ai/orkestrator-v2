# OpenCode prompt attachment never reaches the provider

Found 2026-10-25 by the OpenCode `live-session` run in
[0014-cli-qualification.md](0014-cli-qualification.md) (branch
`todo-0014-cli-qualification-060fd6539163` on `00a0cb82`).

## Current state

- `session prompt --attach <text file> --wait` on a live OpenCode session
  (local environment, OpenCode 1.19.0, model `opencode-go/gpt-5.6-luna`,
  API-key credentials) settled `unknown` after about 18 s and exited 7
  (`run-unknown`, "The turn ended but its outcome was not recorded"). It
  happened on both runs that day.
- The disposable OpenCode database for that run held only three user
  messages: the start turn, the follow-up and the `--literal` prompt. The
  attached prompt never became an OpenCode message, so
  `readOpenCodeTurnTerminalError` (`apps/backend/src/core/opencode-turn-outcome.ts`)
  never found an assistant reply whose `parentID` carries the request marker.
  It retried three times and `sessionTurnOutcome`
  (`native-agent-service.ts`) settled `unknown`. That is the safe answer, not
  a false success, but the prompt was lost without saying so.
- Attachments are staged under `.orkestrator/prompt-attachments/<operation>/`
  (`stageAttachments`, `public-api/prompt-delivery.ts`) and sent to OpenCode
  as `file` parts with a `file://` URL (`openCodePromptParts`,
  `opencode-provider-helpers.ts`; `promptAttachmentUrl`,
  `prompt-attachments.ts`). The backend log showed no error.
- Claude passes the same step: the agent quoted the attached file. Todo 0017
  only qualified it on Claude. Codex, Cursor and Grok refuse non-image files
  before admission.

## Outstanding work

### Code

1. Find where the OpenCode prompt with a `file` part is dropped: the
   asynchronous prompt call accepting it and then failing in the background
   (an unreadable or ignored path, an unsupported MIME type), or the dispatch
   never being sent. Make the failure reach the run: settle `failed` with
   the provider's reason instead of `unknown`. If OpenCode cannot take text
   files this way, refuse them before admission as Codex does
   (`assertAttachmentSupport`).
2. Add a regression test for the provider path that failed.

### Qualification

1. Re-run `mise run test:cli:scenarios -- --scenario live-session --provider
   opencode` (managed `opencode` on `PATH`) until it passes the attach step,
   local and container.

## Constraints and rationale

- A dropped prompt must never look like a completed one; `unknown` is
  correct until the cause is known, but it is not an answer to ship.

## Open questions

- None yet.

## Related

- [0017-cli-command-surface.md](0017-cli-command-surface.md) (prompt
  attachments, item 3).
- [0014-cli-qualification.md](0014-cli-qualification.md) evidence log,
  2026-10-25.
