# Session titles show the transcript-annotation fence

Checked against `main` at `8454d18b8` (2026-10-24). Both outstanding items
done on `ce205ad34` (2026-10-26); what is left is a live look at a real tab.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Shared strip and the backend fallback title**: items 1 and 2, the parser moved to the protocol package and the fallback title stripped, with tests. Status: done (merged as `9791a425`, #1318).
2. **Live tab label check**: the first "Needs verification" item, a real tab opened with annotations on its first prompt shows a label made from the request text alone. Status: open.
3. **Truncated first message**: the second "Needs verification" item, whether any provider stores a long first user message truncated so the closing fence is lost. Status: open.

### 1. Shared strip and the backend fallback title

**Problem.** None left.

**Context.** Decisions 1-5 record the choices.

**Investigation.** Merged on `main` as `9791a425`. The line "done on `ce205ad34`" names the base commit the branch was built on, not the merge.
- `stripTranscriptAnnotations` is at `packages/protocol/src/transcript-annotations.ts:225`.
- It is used by the projection's `fallbackTitle` (`apps/backend/src/core/native-agent-transcript-projection.ts:5067-5076`), the Codex bridge fallback (`bridges/codex-bridge/src/session-titles.ts:66`) and the tmux resume list (`apps/backend/src/core/tmux-hooks.ts:1064`).
- `generateAndSetSessionTitle` (`bridges/claude-bridge/src/services/session-manager-core.ts:1556`) still has no caller, as decision 4 says.

**Decisions.** None: done. The remaining choice, whether the file can close, is under task 2.

### 2. Live tab label check

**Problem.** Only unit tests show a clean tab label; no real provider tab has been looked at.

**Context.** The defect was found while qualifying 0038, whose live run opens a Codex tab from the design dialog.

**Investigation.** The unit tests run the real projection code with Codex and Claude shapes (`native-agent-service-projection.test.ts`), including provider title pushes. What a live look adds is the provider's own stored form of the first message, and the tab-label path in the renderer.

**Decisions.**

- **How and when is it checked?**
  - **Fold it into 0038's next live design-link run and record the label there (recommended).**
    - Pros: no separate run; the same scenario that found the defect.
    - Cons: closure waits for 0038's run.
  - **A dedicated `dev:test` run with a transcript excerpt on a first Codex prompt.**
    - Pros: can be done at once.
    - Cons: spends a live run on a cosmetic fix the unit tests already cover.
  - **Close the file on the unit tests.**
    - Pros: the file rates Low and the code path is proved.
    - Cons: the live look was the stated condition for closing.

### 3. Truncated first message

**Problem.** If a provider or the transcript window trims a long first user message, the closing fence is lost. The strict strip (decision 2) then leaves the envelope in the title.

**Context.** Decision 2 chose the parser's strict `cleanPrompt` on purpose, so a malformed tag cannot hide the user's words.

**Investigation.** An envelope can be large: up to 20 annotations (`MAX_TRANSCRIPT_ANNOTATIONS`, `packages/protocol/src/transcript-annotations.ts:7`) of up to 12,000 characters of text and 2,000 of comment each (`:8-9`), about 280,000 characters. `fallbackTitle` reads `transcript.messages`, the displayed window, so it would see any per-message display trim. This analysis did not confirm whether a trim can apply to a user message's `content`. A short request with a large excerpt is the case to check.

**Decisions.**

- **How is it settled?**
  - **Add a projection test with a first message at the annotation limits, through the real display bounding, and assert the title (recommended).**
    - Pros: answers the question deterministically, without a provider; pins the behaviour.
    - Cons: needs a fixture large enough to reach the bound.
  - **Relax the strip to drop an unterminated trailing fence for titles only.**
    - Pros: the title is clean even after a trim.
    - Cons: reverses decision 2 for a case nobody has seen; a hand-typed tag could then hide the end of a title.
  - **Leave it until a case is reported.**
    - Pros: no work.
    - Cons: the question stays open with no evidence either way.

Found while qualifying design conversation links live
([0038-design-agent-conversation-links.md](../design-canvas/0038-design-agent-conversation-links.md)).
When a conversation's first prompt carries transcript annotations (a design
context, a quoted transcript excerpt), the title the backend falls back to,
and so the tab label, ended in the start of the inert annotation block: a Codex
tab read `Codex 3 · Let's discuss the design "Untitled design" in the attached
design context. <orke`.

## Current state

- The annotation envelope now lives in
  `packages/protocol/src/transcript-annotations.ts` (export
  `@orkestrator/protocol/transcript-annotations`): the draft type and limits,
  `buildPromptWithTranscriptAnnotations`, `parsePromptTranscriptReferences`
  and the new `stripTranscriptAnnotations` (the parser's `cleanPrompt`).
  `apps/web/src/lib/chat/transcript-annotations.ts` re-exports them and keeps
  only the UI label `transcriptAnnotationSourceLabel`, so every web import
  path and the renderer's behaviour are unchanged.
- The projection's fallback title (`sessionTitleSourceText` in
  `apps/backend/src/core/session-title-text.ts` since 0006 moved title
  generation into the backend, 2026-10-27) strips the coordinator preamble,
  provider system instructions and then annotation envelopes from the first
  user message before collapsing whitespace and taking 80 characters. A first message that
  is only annotations yields no fallback, so the next user message is used.
  Test: "titles a session from the request, not the transcript-annotation
  block after it" in `native-agent-service-projection.test.ts`, which also
  asserts the old fallback would have ended in `<orke`.
  Follow-up projection tests cover Codex and Claude with an annotation-only
  first message followed by a user request (including provider title updates),
  and all-annotation transcripts that retain the provider placeholder rather
  than deriving a title from annotation text.
- Other title fallbacks checked:
  - Codex bridge `buildFallbackSessionTitle`
    (now `bridges/codex-bridge/src/session-title-index.ts`, only the resume
    list's label since 0006): its tag pass removed the fence but kept the
    quoted instruction and JSON, so a prompt of only annotations was titled
    "The user attached the following quoted reference". It now strips the
    envelope first (test in `session-title-index.test.ts`).
  - Claude tmux resume list `titleFromTranscriptHead`
    (`apps/backend/src/core/tmux-hooks.ts`): took the first 80 characters of
    the first user message, the same defect. It now strips the envelope and
    skips a message that is only annotations (`tmux-transcript-title.test.ts`).
  - Claude bridge text fallback in `generateAndSetSessionTitle`
    (`bridges/claude-bridge/src/services/session-manager-core.ts`): nothing
    calls it since #599 (`5df7dec67`), so it was left alone; see decision 4.
  - Cursor, Pi and the ACP bridge (Grok, OpenCode) derive no title from the
    prompt; the backend projection covers them.
  - `fallbackFeatureTitle` (`apps/backend/src/core/feature-build.ts`) titles a
    feature from its description, which never carries the envelope.

## Outstanding work

1. ~~Move the prompt-side envelope parser (or a `stripTranscriptAnnotations`
   helper) into `packages/protocol/src/` so the backend can use it, and strip
   the block in `fallbackTitle` before truncating.~~ Done 2026-10-26 (see
   Current state).
2. ~~Test: a first prompt of request text plus an annotation block titles the
   session after the request text alone.~~ Done 2026-10-26: the projection
   test above, plus `packages/protocol/src/transcript-annotations.test.ts`
   for the helper. The existing web parser tests
   (`apps/web/src/lib/chat/transcript-annotations.test.ts`) run unchanged
   against the shared code.

## Constraints and rationale

- The block is user content quoted as inert context; a title is the user's own
  words, so the block never belongs in it.

## Needs verification

- A real Codex (or any provider) tab opened from the design dialog, or with a
  transcript excerpt on its first prompt, shows a tab label made from the
  request text alone. Only unit tests prove this so far; no live app or
  provider was run for this change.
- Whether any provider stores a long first user message truncated, so the
  closing fence is lost. The strip only removes envelopes the parser accepts
  (decision 2), so such a message would still show the fence in its title,
  as it already would in the transcript. No case is known.

## Assumptions and decisions

Decisions made on 2026-10-26 while doing the items.

1. **What moves to the protocol package.** Options: (a) only a
   `stripTranscriptAnnotations` helper with its own copy of the fence
   pattern; (b) the parser alone; (c) the whole envelope (types, limits,
   builder and parser), with the web module re-exporting it; (d) the whole
   envelope and rewrite every web import to the protocol path. Chose (c).
   The builder and parser share the instruction strings, so splitting them
   would let the two drift and break display of older prompts. Pros: one
   source for the envelope; no churn in the twenty-odd web importers; the
   web display code is byte-identical. Cons: the web module is now mostly a
   re-export layer, and `transcriptAnnotationSourceLabel` stays behind in the
   web app because it is UI wording.
2. **How strict the strip is.** Options: (a) reuse the parser's
   `cleanPrompt`, which removes only envelopes with the exact instruction and
   a valid payload; (b) remove anything between the fence tags, and an
   unterminated trailing fence, whatever is inside. Chose (a). Pros: the
   title is exactly the start of the text the transcript shows, and a
   hand-typed or malformed tag cannot hide part of the user's words, the same
   rule the renderer documents. Cons: a malformed or truncated envelope still
   reaches the title (see Needs verification).
3. **Annotation-only first prompts.** Options: title from the instruction
   text, fall back to the provider's placeholder, or use the next user
   message. Chose to treat the message as having no words of the user's: the
   projection and the tmux list move on to the next user message, and Codex's
   bridge fallback returns its existing "Codex session". Pros: no quoted
   material ever names a session. Cons: until a second message arrives such a
   session keeps the provider's placeholder.
4. **Claude bridge text fallback.** Options: add the strip to it, delete the
   uncalled function, or leave it. Chose to leave it. It has had no caller
   since #599, so it cannot produce a title, and deleting the bridge's title
   generation belongs to item 1 of
   [0006-session-titles-and-history.md](0006-session-titles-and-history.md).
   Pros: no change to dead code outside this file's scope. Cons: if someone
   wires it up again it would need the strip.
5. **Model-generated titles.** Options: strip the envelope from the source
   the Codex and Claude title models summarise, or leave their input whole.
   Chose to leave it. The models are told to treat the source as untrusted
   data and to write a short title, and changing what they see changes title
   quality in a way only live runs can judge. Pros: no unproven change to
   generation. Cons: a generated title can still draw on quoted material; if
   that shows up, strip it in the backend-owned title service 0006 plans.

## Related

- [0006-session-titles-and-history.md](0006-session-titles-and-history.md)
  (backend-owned title generation).
- [0038-design-agent-conversation-links.md](../design-canvas/0038-design-agent-conversation-links.md)
  (where the defect was found).
