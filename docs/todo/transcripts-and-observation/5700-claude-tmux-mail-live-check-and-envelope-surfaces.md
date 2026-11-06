# Claude tmux mail: a live delivery check, and envelopes in resume titles and voice

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, while making the Claude tmux chat draw delivered mail as tiles (to-do 4360, since done and removed). Re-checked 2026-11-05 against `main` at `41f9eb638`: tasks 2 and 3 still held in the code (`titleFromTranscriptHead` and `read_session` had no mail handling, at `tmux-hooks.ts:1150` and `control-mcp-voice.ts:721`), and both were acted on that day.

### Tasks

1. **Observe one real Claude delivery**: confirm the stored row of a mail pasted into a real Claude CLI under tmux is the carrier, so the tmux chat draws it as tiles. Status: open.
2. **Resume dialog titles a session with the envelope**: a session whose first user row is mail is listed under the raw markup. Status: done (2026-11-05).
3. **Voice `read_session` speaks the envelope**: when the latest row is delivered mail, the spoken line is the raw markup. Status: done (2026-11-05).

### 1. Observe one real Claude delivery

**Problem.** The tmux chat draws mail from the row Claude Code writes to its JSONL transcript. That row's exact form has only been tested with fixtures, never observed from a real CLI.

**Context.** `dispatchMailInject` (`apps/backend/src/core/prompt-queue-drainer.ts:115`) sends the carrier through `claude_tmux_submit_queued` to `tmux paste-buffer -p` (`apps/backend/src/core/tmux-session-manager.ts:1122`). The transcript reader returns records as stored, and the chat presents them with `presentPeerMailRows` (`apps/web/src/lib/chat/client-only-messages.ts`).

**Investigation.** To-do 4360's ticket allowed no billed provider turns and no access to `~/.claude`, so this was covered by a fake tmux (`apps/backend/tests/tmux-mail-delivery.test.ts`), the real tab over fixture records (`e2e/TmuxMailTiles.spec.ts`) and unit tests covering a string row, a text-block row, and carriage returns in place of line feeds. If a real row differs in another way, for example with a prefix before the carrier, the row is not recognised and the tab shows it raw, as it did before this work: nothing is lost.

**Decisions.**

- **How to observe it?**
  - **One mail in an isolated `dev:test` profile, with a real Claude tab (recommended).**
    - Pros: it exercises the real paste and the real transcript in the same tab a user would see.
    - Cons: it needs the user's approval, because it may spend a provider turn.
  - **Rely on the fixtures.**
    - Pros: no cost.
    - Cons: the stored form stays an assumption.

### 2. Resume dialog titles a session with the envelope

**Problem.** `titleFromTranscriptHead` (`apps/backend/src/core/tmux-hooks.ts:1150`) returned the first user row's text. Mail can reach a running tab before anyone types, because `dispatchMailInject` only needs the session running and idle, and then the resume dialog shows up to 80 characters of `<orkestrator-peer-message …`. This comes from reading the code; it has not been observed in a running tab.

**Context.** The function already skips a prompt that is only an annotation block, through `stripTranscriptAnnotations`. The backend's naming path is not affected: `claude_tmux_submit_queued` claims the first prompt for naming and does not use its text.

**Investigation.** The carrier parser lives in the renderer (`client-only-messages.ts`), while `renderAgentMailCarrier` is in `packages/protocol/src/agent-mail.ts`, so the backend would need a shared check for a carrier's opening.

**Decisions.**

- **What should the title be?**
  - **Skip mail rows, as annotation-only rows are skipped (recommended).**
    - Pros: the title stays the user's own words, and the next real prompt titles the session; a session with only mail has no title, which the dialog already handles.
    - Cons: a shared opening check has to move into the protocol package.
  - **Title the session from the mail's subject.**
    - Pros: a mail-only session gets a useful name.
    - Cons: an untrusted sender then chooses text in the user's session list.

### 3. Voice `read_session` speaks the envelope

**Problem.** `read_session` (`apps/backend/src/core/control-mcp-voice.ts:689`) built its `say` line from the newest row of `session.transcript`, so when that row is delivered mail a person hears the raw markup. This comes from reading the code; it has not been observed.

**Context.** To-do 4360 decided that `session.transcript` keeps returning stored rows, because agents need the message id and the framing. The `say` line is different: it is for a person. A turn usually answers mail straight away, so the newest row is mail mainly while that turn is starting.

**Investigation.** The tool's `messages` field can keep the stored text; only the spoken line needs changing.

**Decisions.**

- **What should the spoken line say?**
  - **A short phrase naming the sender and subject, read from the payload (recommended).**
    - Pros: a person hears what happened, and the structured result is unchanged.
    - Cons: a third reader of the payload, on the backend, unless task 2's shared helper is extended to cover it.
  - **Leave it.**
    - Pros: no change.
    - Cons: a person occasionally hears markup.

## Assumptions and decisions

### Task 2: the row a session is titled from

Took the recommended option. `titleFromTranscriptHead` skips a row `isPeerMailCarrierContent` accepts, so the next real prompt titles the session. A session holding only mail has a null title, and the dialog already shows `Session <id>` for that. No subject reaches the title. A row that only names the tag still titles the session. A row a person pasted an envelope into, with words after it, is skipped too; those words are not used as a title.

The check moved from the renderer to `packages/protocol/src/agent-mail.ts`, and the renderer, the native tab and the mail-tiles check import it from there, so there is one shared implementation. Title and voice opt into `requirePayloadFrame`: a closed-tag prompt without a payload remains user text, while the renderer retains its malformed-carrier handling. As the renderer does, the row is checked after `stripSystemInstructions`.

### Task 3: the shared reader, and what is spoken

Took the recommended option: a short phrase read from the payload, with the stored text kept in `messages`. Only a `user` row counts, as in the renderer, so an assistant quoting an envelope reads as before.

- **Where the payload is read.** The carrier scan and payload validation moved to the protocol package as `readAgentMailCarriers`, and the renderer now builds its rows from it. A separate backend reader was not written, because it would be a third copy of the validation.
- **A carrier the read's cap cut.** `session.transcript` caps text at 20,000 characters and may hide whole later carriers. Voice now reports that the latest sender and batch size cannot be determined. Recovering an earlier heading with `keepCutBody` would risk naming an older mail as newest; the unused partial-body reader and its option were removed in review.
- **How the sender is named.** Voice has its own wording rather than the renderer's `agentMailSenderLabel`. A carrier has no environment name for a tab, and that label falls back to the short environment id, which is poor to say aloud.
- **What else is said.** A complete batch names its final message and counts the others; an unreadable final carrier uses the unreadable-mail fallback rather than an earlier sender. Trailing user words are spoken within a 400-character bound, excluding the structured-prompt transport suffix. A sender outside the project is called untrusted, because the carrier's own warning is not spoken. A carrier that cannot be read says so and never speaks markup.

Neither task has been seen in a running tab: no real mail was delivered, because that needs a provider turn (task 1). The tests use carriers from `renderAgentMailCarrier`. A row stored in a different form, for example with a prefix before the carrier, would not be recognised and would title or be spoken as before.

### Tasks 2 and 3: wrapped frames and transport suffix (review repair)

Title eligibility and rendering now use the same system-frame-stripped text. Voice also strips system frames from its fallback excerpt, while leaving returned messages unchanged. The schema-instruction suffix prefix lives in the protocol package and is imported by both surfaces, so their handling cannot drift. The existing wrapped-title assertion and an exact spoken-fallback assertion cover the two leaks.

## Related

- [docs/architecture/agent-messaging.md](../../architecture/agent-messaging.md#how-a-message-moves)
- [5120-tmux-transcript-reopen-live-evidence.md](5120-tmux-transcript-reopen-live-evidence.md)
