# Static HTML presentation follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, on the branch that added the static document view. Task 2 re-checked and done 2026-11-05 against `main` at `e1f4c875f`.

### Tasks

1. **Run static documents in the hosted client**: let `apps/web-public` display them rather than saved previews, by emitting the frame document in the hosted build with its own header rule. Status: blocked (waits on 7568: 4650 task 1, approval of the hosted policy change and the check on a real Vercel deployment).
2. **Include document text in Find**: text inside a static frame is not indexed. Status: done (2026-11-05); see Assumptions and decisions. What it leaves is in [5780](5780-find-inside-static-documents.md).
3. **Share one sanitizer with the design runtime**: remove the pinned copy. Status: open (do with the next intentional design-runtime change).
4. **Consider a thin visual publishing tool**: only if real provider sessions show the lifecycle is cumbersome. Status: blocked (waits on 7568: 4650 task 4, evidence from real provider sessions).

### 1. Run static documents in the hosted client

**Problem.** The hosted client shows static reports as saved previews, while desktop and gateway clients show the document.

**Context.** `apps/web-public/vercel.json` sets `script-src 'self'` and `frame-ancestors 'none'` on `/(.*)`, and its Vite build does not use `rendererSecurityPlugin`, so there is no emitted frame document. A `srcdoc` frame inherits the parent policy, so the bootstrap cannot run. The build declares `ORKESTRATOR_STATIC_HTML_PRESENTATION=unavailable`.

**Investigation.** Not attempted live. Whether a more specific Vercel header rule replaces the `/(.*)` policy for one path, and approval to relax the hosted policy for that path, are on the manual-test checklist (7568); the build change here waits on both.

**Decisions.**

- **How to enable it?**
  - **Emit `static-html-frame.html` in the hosted build with its own header rule (recommended).** It would need `sandbox allow-scripts; frame-ancestors 'self'` and to be excluded from the general rule.
    - Pros: the same document and policy as every other production surface.
    - Cons: changes a deployed policy that is deliberately stricter; needs a real deployment to qualify.
  - **Keep saved previews there.**
    - Pros: no policy change; honest and working today.
    - Cons: hosted readers do not get selectable reports.

### 2. Include document text in Find

**Problem.** Find matches a report's summary but not its body.

**Context.** Other artifact bodies publish searchable text through `rememberArtifactSearchBody`. A static document's text exists only inside its opaque frame, and artifact HTML must not be parsed in the privileged application DOM.

**Investigation.** Re-checked 2026-11-05 at `e1f4c875f`: the problem still held. `HtmlArtifactBody` published nothing to the search cache, and `artifactBodySearchText` had no branch for a static document. Find's index (`agent-chat-search-index.ts`) re-reads every row holding an artifact part on each pass, so text published later is picked up without any change there. One message under `FRAME_CHANNEL_POLICY.maxMessageBytes` (8 KiB) cannot carry a report of up to 256 KiB, so the report is split into chunks. Separately, `clearArtifactRequestsForConversation` and `clearArtifactRequestsForEnvironment` left the search cache untouched, so text would have outlived a revocation.

**Decisions.**

- **Where should the text come from?**
  - **Have the trusted runtime report bounded text through the channel (recommended, implemented).**
    - Pros: parsing stays inside the frame; bounded by the message size policy.
    - Cons: widens a deliberately narrow channel; only a mounted frame can report, so unvisited reports stay unindexed.
  - **Have the backend extract text at verification and store it.**
    - Pros: available without a frame, for every report.
    - Cons: adds a stored representation; does not cover existing publications without a backfill.

### 3. Share one sanitizer with the design runtime

**Problem.** `installStaticHtmlPresentationRuntime` carries a copy of the design runtime's sanitizer rules.

**Context.** `installDesignRuntime.toString()` feeds `STATIC_RENDERER_HASH`, compared at publication, and the preview worker's context digest. `static-html-presentation.test.ts` pins both to identical output.

**Investigation.** Refactoring it now would invalidate unpublished receipts and prepared worker images with no change in behaviour.

**Decisions.**

- **When to unify?**
  - **With the next intentional change to the design runtime (recommended).**
    - Pros: the invalidation is already being paid for.
    - Cons: the copy and its parity test remain until then.
  - **Now, in its own change.**
    - Pros: one copy immediately.
    - Cons: users rebuild preview workers and re-verify drafts for no visible benefit.

### 4. Consider a thin visual publishing tool

**Problem.** Publishing a visual takes four tool calls.

**Context.** The existing `create_artifact`, `preview_artifact`, `get_artifact_operation` and `publish_artifact` lifecycle is sufficient, and shared instructions now describe it.

**Investigation.** No evidence yet that the lifecycle stops agents; only limited real-provider runs have been made. Gathering that evidence from real provider sessions is on the manual-test checklist (7568); the decision below waits on it.

**Decisions.**

- **Add a wrapper?**
  - **Wait for evidence from real sessions (recommended).**
    - Pros: no new protocol surface without a demonstrated need.
    - Cons: agents keep making four calls.
  - **Add a wrapper over the existing services.**
    - Pros: fewer calls.
    - Cons: must keep the inspect-and-repair step and honest pending states, or it reports visuals as finished before they are.

## Assumptions and decisions

### Task 2: how the text crosses the channel

The file's recommended option still fitted and is what was built. After `rendered`, `installStaticHtmlPresentationRuntime` walks the sanitized document and posts a new `text` message; the host's `StaticHtmlFrameSession` reassembles it. Nothing in the host parses artifact HTML: the text reaches the application DOM only as a React text node in a hidden search mirror.

The file did not say how to carry a report larger than one message:

- **Chunks of 2 Ki characters, up to 64 Ki characters in total (chosen).**
  - Pros: `maxMessageBytes` keeps its value and meaning, even for three-byte characters; 32 chunks plus `ready` and `rendered` fit the channel's burst of 40, which a test pins.
  - Cons: reassembly code in the session; a chunk the rate limiter drops loses that mount's text. It is then abandoned, never indexed in part.
- **One message under a larger limit for this type.**
  - Pros: no reassembly.
  - Cons: a second, larger message limit on a channel whose policy says limits change only with qualification evidence.
- **One message under the existing 8 KiB.**
  - Pros: no channel policy change.
  - Cons: indexes only the start of most reports.

64 Ki characters is the limit other artifact bodies already have (`MAX_ARTIFACT_BODY_SEARCH_CHARACTERS`). Text beyond it is not searchable, and nothing in the card says so; `rich-transcripts.md` records it.

### Task 2: which text counts

The text is read from the sanitized tree, not from layout, so a frame in a hidden tab reports the same text as a visible one. A closed `<details>` counts because the reader can open it. `<style>`, `<noscript>`, the `hidden` attribute and anything in `<head>` do not. Text hidden only by CSS does count, because telling would mean computing styles for up to 5,000 elements. Inline elements join their neighbours, and any other element is a boundary a search does not match across.

### Task 2: when text is withdrawn

It follows the other bodies: scrolling away keeps it, and leaving the view that shows the body withdraws it. Saved preview and Source withdraw it, as do a frame failure and a failed read, since text from an earlier visit is not a fallback for a read that now fails. A deferred card keeps text it has already reported, as a scrolled-away one does.

### Task 2: clearing the search cache per conversation

This fixes a gap outside the file's wording, because document text would otherwise stay findable after a revocation. Each cache entry now names its conversation, and the conversation and environment clears remove matching entries. It applies to chart, workflow and Mermaid bodies as well. The cache also gained a total bound of 8 Mi characters, because 256 entries of 64 Ki characters would otherwise be its only limit.

### Task 2: what was not built

- A match inside a document scrolls to its card but is not highlighted inside the frame.
- Reports that were never shown stay unindexed, the cost this option accepts.
- An open Find bar does not refresh when text arrives; it updates on its next query or transcript change, as other artifact bodies do.

All three are in [5780](5780-find-inside-static-documents.md).

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: approving the hosted policy change and checking it on a real Vercel deployment; the user part of task 4: evidence from real provider sessions) moved there on 2026-11-10.
