# Session titles show the transcript-annotation fence

Checked against `main` at `8454d18b8` (2026-10-24).

Found while qualifying design conversation links live
([0038-design-agent-conversation-links.md](../design-canvas/0038-design-agent-conversation-links.md)).
When a conversation's first prompt carries transcript annotations (a design
context, a quoted transcript excerpt), the title the backend falls back to,
and so the tab label, ends in the start of the inert annotation block: a Codex
tab read `Codex 3 · Let's discuss the design "Untitled design" in the attached
design context. <orke`.

## Current state

- `buildPromptWithTranscriptAnnotations` (`apps/web/src/lib/chat/transcript-annotations.ts`)
  appends a `<orkestrator_transcript_annotations>` block to the prompt; the
  renderer parses it back out for display (`parsePromptTranscriptReferences`).
  The parser exists only in the web app.
- The projection's `fallbackTitle` (`apps/backend/src/core/native-agent-transcript-projection.ts`,
  "Name the session after the user's own words") strips provider system
  instructions from the first user message, then takes its first 80
  characters, fence included. It is used while the provider has no title of
  its own.
- Codex's bridge fallback (`buildFallbackSessionTitle`,
  `bridges/codex-bridge/src/session-titles.ts`) already removes tags, so this
  is the backend projection fallback, not the bridge.
- Not new with 0038: the design dialog used to write the same block into a
  new tab's text, and any first prompt with a transcript excerpt does the same.

## Outstanding work

1. Move the prompt-side envelope parser (or a `stripTranscriptAnnotations`
   helper) into `packages/protocol/src/` so the backend can use it, and strip
   the block in `fallbackTitle` before truncating.
2. Test: a first prompt of request text plus an annotation block titles the
   session after the request text alone.

## Constraints and rationale

- The block is user content quoted as inert context; a title is the user's own
  words, so the block never belongs in it.

## Related

- [0006-session-titles-and-history.md](0006-session-titles-and-history.md)
  (backend-owned title generation).
