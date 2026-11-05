# Claude tmux mail: a live delivery check, and envelopes in resume titles and voice

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, while making the Claude tmux chat draw delivered mail as tiles (to-do 4360, since done and removed).

### Tasks

1. **Observe one real Claude delivery**: confirm the stored row of a mail pasted into a real Claude CLI under tmux is the carrier, so the tmux chat draws it as tiles. Status: open.
2. **Resume dialog titles a session with the envelope**: a session whose first user row is mail is listed under the raw markup. Status: open.
3. **Voice `read_session` speaks the envelope**: when the latest row is delivered mail, the spoken line is the raw markup. Status: open.

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

**Problem.** `titleFromTranscriptHead` (`apps/backend/src/core/tmux-hooks.ts:1143`) returns the first user row's text. Mail can reach a running tab before anyone types, because `dispatchMailInject` only needs the session running and idle, and then the resume dialog shows up to 80 characters of `<orkestrator-peer-message …`. This comes from reading the code; it has not been observed in a running tab.

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

**Problem.** `read_session` (`apps/backend/src/core/control-mcp-voice.ts:689`) builds its `say` line from the newest row of `session.transcript`, so when that row is delivered mail a person hears the raw markup. This comes from reading the code; it has not been observed.

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

## Related

- [docs/architecture/agent-messaging.md](../../architecture/agent-messaging.md#how-a-message-moves)
- [5120-tmux-transcript-reopen-live-evidence.md](5120-tmux-transcript-reopen-live-evidence.md)
