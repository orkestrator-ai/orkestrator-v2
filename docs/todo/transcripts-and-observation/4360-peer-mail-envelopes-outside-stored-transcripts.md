# Agent mail envelopes in the views the pipeline fix did not cover

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, while making stored pipeline, Multi Review and graph-run transcripts draw delivered mail as tiles.

### Tasks

1. **Claude tmux chat shows the raw envelope**: draw delivered mail as tiles in `ClaudeTmuxChatTab`. Status: open.
2. **Native tabs hide a malformed envelope without a trace**: show the same notice stored transcripts show. Status: done (review fix routes native rows through the shared presenter).
3. **Agent and CLI transcript reads return raw envelopes**: decide whether `get_tab_transcript` and `session.transcript` should keep doing so. Status: open.

### 1. Claude tmux chat shows the raw envelope

**Problem.** A `claude-tmux` tab can receive injected mail (`agentMailCapabilities`), and its chat view has no carrier handling, so the delivered prompt should appear as a user bubble of XML and JSON. This comes from reading the code; it has not been observed in a running tab.

**Context.** `ClaudeTmuxChatTab.tsx` builds its rows with `normalizeClaudeMessagesForDisplay` and never calls the mail helpers. It does not use `toPipelineTranscript`, so the pipeline fix does not reach it.

**Investigation.** `presentPeerMailCarrierRow` (`apps/web/src/lib/chat/client-only-messages.ts`) takes only an id, content and time, so it can run over the tab's user rows before display normalization. The tmux path may store the pasted prompt differently from a bridge. Check one live delivery in an isolated `dev:test` profile first.

**Decisions.**

- **Where to convert the rows?**
  - **In `displayMessages`, with `presentPeerMailCarrierRow` (recommended).**
    - Pros: one parser and one tile; rows stay a pure function of the transcript, so a reload is correct.
    - Cons: the tmux tab has its own message pipeline to test.
  - **In the backend tmux transcript reader.**
    - Pros: every client gets the tile data.
    - Cons: the reader would have to invent a display row type, and agent reads of the transcript need the real row.

### 2. Native tabs hide a malformed envelope without a trace

**Problem.** `AgentNativeTab.controller.tsx` replaces a carrier row with `createPeerMailNativeMessagesFromCarrier`, which returns nothing for a carrier it cannot read. No raw markup appears, but a delivered message disappears from the transcript and a reader cannot tell. A pasted envelope followed by a question loses the question the same way.

**Context.** The pipeline path uses `presentPeerMailCarrierRow`, which puts a plain notice in that position and keeps trailing text as an ordinary row. The native behaviour is documented as deliberate on the helper, and native tabs were outside the ticket, so it was left alone.

**Investigation.** The change is one call in the controller's `normalizedMessages`. The notice's id has the client-only `system-` prefix, so it does not disturb the authoritative id set built just below it. `AgentNativeTab.test.tsx` and `e2e/agent-testing/coordinator-mail-tiles.ts` assert on tile counts and would need checking.

**Decisions.**

- **Should native tabs show the notice?**
  - **Yes, through the shared helper (recommended).**
    - Pros: one behaviour everywhere; an unreadable delivery is visible.
    - Cons: a batch with a bad carrier gains a row that the live coordinator tile check must allow.
  - **Keep dropping it.**
    - Pros: no change.
    - Cons: a delivered message can vanish unnoticed.

### 3. Agent and CLI transcript reads return raw envelopes

**Problem.** `get_tab_transcript`, `get_build_pipeline_worker_transcript` and the public `session.transcript` action return stored rows unchanged, so a reader sees the envelope.

**Context.** These are not display surfaces. An agent reading a worker's transcript can use the message id in the envelope to reply. The ticket asked to report this rather than change it.

**Investigation.** `readPipelineWorkerTranscript` (`apps/backend/src/core/build-pipeline-worker-transcript.ts`) passes `read.messages` straight through. The public action has a content contract of its own (`docs/architecture/public-cli.md`).

**Decisions.**

- **Should these reads present mail differently?**
  - **Leave them returning stored rows (recommended).**
    - Pros: no contract change; agents keep the ids and the framing that tells them the text is untrusted.
    - Cons: a person reading CLI output sees the envelope.
  - **Have the CLI's human output format mail, keeping `--json` as it is.**
    - Pros: readable output for people.
    - Cons: a second presentation of the envelope to keep in step.

## Assumptions and decisions

### Task 2: shared native presentation

Chose `presentPeerMailCarrierRow` for native tabs during review fixes. Unsupported
versions and damaged envelopes now remain visible as the same fixed notice as
stored transcripts, and trailing human text is preserved. Native component
regressions cover unsupported versions, malformed headers and ordinary tag mentions.
No live provider turn was used.

## Related

- [docs/architecture/coordinator.md](../../architecture/coordinator.md#pipeline-worker-mailboxes)
