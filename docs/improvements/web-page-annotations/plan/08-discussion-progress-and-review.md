# 08 — Discussion, progress, and manual review

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 05–07. Milestone: A.

## Deliverable

Complete the first point → discuss → implement → review cycle. Users can read
agent replies in context, answer existing questions/approvals, inspect changes,
and resolve the correct annotation revision without losing history.

## Ownership

Add a proposed backend `web-annotation-request-projection.ts` adapter and small
thread request/result components. Reuse the native transcript/message contracts,
interaction adapters, session actions, and existing diff/file navigation.
Avoid provider-specific renderers in the annotation panel.

## Transcript correlation

- [ ] Link each request to native tab/session identity, dispatch request ID,
  provider generation, and provider turn ID where available. Use existing
  normalized transcript IDs rather than matching prompt text heuristically.
- [ ] If an adapter lacks stable request-to-turn correlation, add a normalized
  backend correlation boundary or show pending linkage. Do not attach “the latest
  assistant message” from a concurrently used session by guesswork.
- [ ] Store entry references to the canonical transcript. Render a bounded
  response excerpt and **Open full conversation**, with message/turn navigation.
- [ ] Keep a persisted, explicitly attributed final excerpt/result snapshot so
  a removed/unavailable source session does not erase the thread's usefulness.
  The snapshot is historical evidence, not a separately editable live transcript.
- [ ] Rehydrate missing completion/message links from existing authoritative
  transcript/status interfaces on demand. Backend monitoring must use no-touch
  activity paths and avoid hydrating every idle session.

## Discussion and clarification

- [ ] A saved reply is published to the thread first. Sending it creates an
  explicit discussion or implementation request against selected revisions.
  Saving a comment alone must never start agent work.
- [ ] Keep **Discuss** and **Request changes** visible as separate actions, with
  selected destination and queue state. Reuse the original target when discussing
  alternatives; allow later evidence replacement without overwriting history.
- [ ] Link pending native questions and approvals to the relevant request. Use
  existing authoritative interaction IDs/answer commands and renderers, or deep
  link to their canonical UI. Do not synthesize a second approval object.
- [ ] Answering a question from either surface resolves it in both after refresh.
  Dead-generation approvals are withdrawn; timeout/disconnect/malformed answers
  never become implicit approval.
- [ ] Responses arriving while hidden produce unread/request badges, not forced
  navigation or a foreground tab switch. Preserve user focus and draft text.

## Progress projection

Derive request status from native acceptance, queue, activity, interactions,
and terminal outcome. An agent becoming idle is insufficient proof that this
particular request completed successfully. Correlate terminal evidence first.

- [ ] Show blocked, queued, running, needs-input, cancelling, unconfirmed,
  failed/cancelled, discussion-completed, and implementation-awaiting-review
  states using step 01's lifecycle.
- [ ] Distinguish infrastructure error from the agent reporting an unmet
  requirement. Preserve both the response and retryable request context.
- [ ] A generic completed implementation turn becomes **Review response** if no
  reliable result summary exists. It does not claim files changed or tests passed.
- [ ] Snapshot request state and current interactions on mount/activation and
  after reconnection. Missing live events cannot leave permanent “Running.”

## Manual review in milestone A

Display the original capture, the agent response/result excerpt, changed-file
links when available, validation statements with provenance, and unresolved
questions. Make **Open updated page**, **Open changes**, **Accept and resolve**,
and **Reply / request another change** the primary review actions.

- [ ] Opening the updated page uses the logical service/route identity and current
  environment routing. Validate the target and do not navigate outside allowed
  preview scope because a page/agent supplied a URL.
- [ ] Navigate/reload only on the user's review action. Preserve an existing
  form/page state until then; explain unavailable route or expired login instead
  of taking a new screenshot and claiming equivalence.
- [ ] Where the existing diff surface cannot isolate a turn's changes, label it
  as the current workspace diff. Do not attribute unrelated concurrent changes
  to this annotation. Later structured results can improve attribution.
- [ ] Acceptance checks expected content/capture/result revisions. A new note or
  replacement capture after dispatch makes the old result historical; offer
  **Review older result** but do not silently resolve newer requirements.
- [ ] Allow partial outcomes as unresolved notes/criteria even in a single
  annotation. Resolution requires an explicit human action; a tool result or
  agent statement cannot resolve it.
- [ ] Reopen appends a lifecycle entry and preserves all prior requests, results,
  evidence, and acceptance records. Further implementation uses a new request ID
  only after previous execution is settled.

## Cancellation, deletion, and unavailable history

- [ ] Thread dismissal/panel close does not stop execution. A separate Stop
  action follows step 07's current-turn identity check.
- [ ] Hide/archive does not delete a request or release an active reservation.
  Deletion rejects active work and explains the corresponding cancel/recovery
  action without pretending that uncertainty can be erased.
- [ ] Deleted agent sessions show the retained historical response and unavailable
  link state. Do not call provider thread-delete APIs to clean up annotations.
- [ ] Fork/rewind/handoff of native conversations does not rewrite historical
  annotation request identity. New work chooses its destination explicitly.

## Verification and completion

- [ ] Exercise a discussion response, a clarification, implementation, failure,
  cancellation, no-summary completion, acceptance, and reopen through fixtures.
- [ ] Race a new comment/recapture against acceptance; stale resolution must
  conflict without hiding the new requirement.
- [ ] Answer an approval/question from chat and then from the annotation panel;
  duplicate/stale answers cannot execute or approve anything twice.
- [ ] Run the full flow while switching environments, unmounting the browser,
  disconnecting SSE, restarting the backend, and returning after completion.
- [ ] Verify result links survive loss of the original preview tab and that
  unavailable transcript/diff evidence is labelled rather than fabricated.

Done when a user can complete the whole workflow and review the correct result
without requiring automatic screenshots or provider-specific result tools.
