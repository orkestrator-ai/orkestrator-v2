# Static HTML presentation follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, on the branch that added the static document view.

### Tasks

1. **Run static documents in the hosted client**: let `apps/web-public` display them rather than saved previews. Status: open.
2. **Include document text in Find**: text inside a static frame is not indexed. Status: open.
3. **Share one sanitizer with the design runtime**: remove the pinned copy. Status: open (do with the next intentional design-runtime change).
4. **Consider a thin visual publishing tool**: only if provider tests show the lifecycle is cumbersome. Status: open.

### 1. Run static documents in the hosted client

**Problem.** The hosted client shows static reports as saved previews, while desktop and gateway clients show the document.

**Context.** `apps/web-public/vercel.json` sets `script-src 'self'` and `frame-ancestors 'none'` on `/(.*)`, and its Vite build does not use `rendererSecurityPlugin`, so there is no emitted frame document. A `srcdoc` frame inherits the parent policy, so the bootstrap cannot run. The build declares `ORKESTRATOR_STATIC_HTML_PRESENTATION=unavailable`.

**Investigation.** Not attempted live. Whether a more specific Vercel header rule replaces the `/(.*)` policy for one path needs checking on a real deployment, which is outward-facing.

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

**Investigation.** None beyond reading `artifactBodySearchText`.

**Decisions.**

- **Where should the text come from?**
  - **Have the trusted runtime report bounded text through the channel (recommended).**
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

**Investigation.** No evidence yet that the lifecycle stops agents; only limited real-provider runs have been made.

**Decisions.**

- **Add a wrapper?**
  - **Wait for evidence from real sessions (recommended).**
    - Pros: no new protocol surface without a demonstrated need.
    - Cons: agents keep making four calls.
  - **Add a wrapper over the existing services.**
    - Pros: fewer calls.
    - Cons: must keep the inspect-and-repair step and honest pending states, or it reports visuals as finished before they are.
