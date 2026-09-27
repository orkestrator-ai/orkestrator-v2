# 12 — Structured results and visual verification

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 08, 10, 11. Milestone: C.

## Deliverable

Improve result quality with optional scoped agent tools and comparable visual
evidence. Preserve the manual transcript/review path for providers without
these capabilities. A result tool reports work; it cannot accept it for the user.

## Existing integration points

Inspect `agent-tools.ts`, `workflow-result-service.ts`,
`workflow-result-tools.ts`, and the agent tool-configuration path before adding
new tools. Reuse revocable environment/tab credentials and bounded tool request
handling. Add a proposed `web-annotation-tools.ts` and result validator, with
minimal shared capability additions where needed.

For screenshots, reuse the native capture adapter. The design-canvas renderer
is a useful bounded-worker precedent, but its isolated authored HTML is not
the live application's authenticated session. Do not present a new headless
context as equivalent to the user's browser without proof of matching state.

## Optional agent tool surface

| Proposed tool | Allowed behavior |
| --- | --- |
| `get_annotation_request` | Read the caller's assigned request, immutable human brief, selected revisions, and evidence manifest. |
| `get_annotation_evidence` | Read bounded evidence for annotation/capture IDs already in that request; paginated/sectioned where needed. |
| `report_annotation_result` | Append/revise a bounded report for that request, including per-annotation outcomes and evidence references. |

No tool in this initial surface can create a user-authored comment, retarget a
request, dispatch another agent, resolve an annotation, or execute JavaScript in
the page. Questions use existing agent interactions; new implementation work
requires the existing human Send workflow.

- [ ] Validate environment, tab/session, request assignment, and revocation on
  every tool call. A valid environment credential alone is insufficient to
  read every annotation or report results for another session.
- [ ] Derive active request binding from backend state or a scoped server-issued
  capability; do not trust the model-supplied `requestId` as authorization.
- [ ] A persistent session may contain several historical requests. Explicitly
  validate which request a result refers to; reject cross-turn/stale assignment
  updates that would alter a newer request's result.
- [ ] Advertise tools only when installed/configured for that session. If tool
  configuration requires a new session, retain text output or offer that session;
  never restart a running agent to inject tools.
- [ ] Bound concurrent calls, input size, response size, result revisions, and
  timeouts. Agent tool failures degrade result enrichment, not the native session.

## Result schema

The report includes request ID/body hash, reporter provenance, result revision,
per-annotation outcomes, summary, repository-relative files, check claims,
evidence IDs, and limitations/unresolved questions. Validate references against
the frozen request and current environment.

- [ ] File paths are bounded, relative, and contained in the environment; page
  or agent strings cannot cause arbitrary file reads through result links.
- [ ] Separate `agent-reported` checks from `app-observed` checks and `user-reviewed`
  acceptance. An agent writing “tests passed” is not an app-run test artifact.
- [ ] Include check outcome `passed`, `failed`, `not-run`, or `unavailable` with
  a bounded description. No missing field defaults to passed.
- [ ] A report arriving before the turn ends is provisional. Show progress, but
  do not release dispatch ownership or resolve feedback on the tool call alone.
- [ ] Reports can supersede earlier reports with an expected result revision.
  Preserve history. Malformed output falls back to the transcript; it must not
  hide a completed response or mark every selected annotation addressed.
- [ ] A successful edit and a failed verification can coexist in one result.
  The UI exposes both rather than flattening them into a green success state.

## Before/after capture

Start with a user-triggered **Capture current result** action in the native
preview. Offer side-by-side original/current images and optional overlay once
coordinate compatibility is established. Automatic capture is a later capability
within this step and must never navigate/reload the user's active page silently.

- [ ] Record request/result ID, current annotation content/capture revision,
  logical route, document generation, viewport, scroll, zoom, device scale,
  capture time, and target resolution alongside the after-image.
- [ ] Verify the comparison route and viewport match or label the differences.
  An unmatched target is visible evidence of changed/missing identity, not proof
  that the target was removed as requested.
- [ ] Use a deadline and a bounded stable-geometry window before capture; if
  fonts, animations, or live data prevent stability, mark the capture unstable.
  Do not wait forever or disable application behavior globally to make a diff pass.
- [ ] User redactions apply to the after-image too. Store comparison masks and
  transformations with the result; never resurrect a redacted original image.
- [ ] Page access can require login/form state that the agent lacks. If automated
  capture cannot reproduce it, keep manual capture/review available and state
  exactly which verification was unavailable.
- [ ] Fresh captures are new immutable assets. Repeated review must not overwrite
  the original screenshot or another result's evidence.

## Functional verification and source attribution

Use the agent's existing repository tools/tests and normal review workflow to
verify behavior. The annotation feature records and links evidence; it does not
introduce an unrestricted remote shell to run check strings supplied in a report.

- [ ] Prompt for checks appropriate to intent: copy/layout, responsive overflow,
  click/save behavior, keyboard focus, or regression tests as relevant.
- [ ] Keep screenshots and functional outcomes independent. An unchanged image
  cannot establish functional equivalence; a passing test cannot prove visual
  acceptance at the user's viewport.
- [ ] Link diffs by known worktree/commit/turn information. If changes are shared
  with concurrent work, label the diff scope and do not claim exclusive attribution.
- [ ] Optional development source hints must identify their producer and project
  root and pass containment/existence checks. Use them as candidate locations;
  the agent still checks the actual repository. Do not depend on private React
  or another framework's runtime internals for core functionality.

## Controlled pixel differences

Add pixel/region diff display only after side-by-side comparison is reliable.
Gate it on matching capture metadata and an explicit unstable-region mask.
Display a difference measurement as evidence, never an automatic pass/fail or
resolution rule. Cap image decode memory and comparison time; reject incompatible
captures instead of resizing them in a way that hides layout differences.

## Verification and completion

- [ ] Test revoked credentials, forged request IDs, another session's annotation,
  stale result revisions, provisional reports, duplicate tool calls, and late
  reports after cancellation. None can resolve or dispatch work.
- [ ] Test unavailable tools/providers retain the full manual workflow.
- [ ] Compare synthetic pages with deterministic changes, animation, late fonts,
  mismatched viewport, expired login, and failed functional checks.
- [ ] Verify app-observed evidence requires a real artifact record; an agent's
  JSON claim cannot impersonate that provenance.
- [ ] Run gate C comparison/tool cases in step 14 and document supported providers
  and limitations in the living guide.

Done when results are easier to evaluate without conflating reported completion,
observed verification, and user acceptance.
