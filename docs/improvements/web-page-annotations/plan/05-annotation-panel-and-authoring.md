# 05 — Annotation panel and authoring

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 03, 04. Milestone: A.

## Deliverable and component boundaries

Build the trusted browser-side home for saved feedback and discussion. Suggested
new components under `apps/web/src/components/browser/annotations/`:
`AnnotationPanel`, `AnnotationList`, `AnnotationThread`, `AnnotationEditor`,
`AnnotationCaptureCard`, and `AnnotationStatus`. Use existing UI primitives and
the store/client from step 03. Keep preview integration in a small controller
hook consumed by `BrowserTab.tsx`.

Do not put captured HTML, image bytes, thread history, or request execution
state into `BrowserTabData` or the pane-layout store. Store only panel visibility,
selected annotation ID, filter, and optional width there if persistence helps.

## Layout and native preview composition

- [ ] Add an annotations control showing the number of open notes for the current
  logical page, plus access to all environment annotations.
- [ ] Reserve an app-owned column beside the native preview. Resize its actual
  host bounds as the panel opens/resizes; a renderer overlay cannot be assumed
  to appear above an Electron native view.
- [ ] At narrow widths, switch between preview and discussion surfaces while
  preserving capture context. Hide the native view when an app modal/menu would
  otherwise be covered, following the existing blocking-overlay behavior.
- [ ] Recompute bounds through the existing preview sizing path and verify
  host zoom is applied once. Do not create a separate coordinate convention.
- [ ] Preserve page state when opening a thread; do not reload or navigate just
  because a user opens the panel.

## Authoring behavior

- [ ] Selecting an element opens a trusted editor with target label, capture
  thumbnail, saved/unsaved status, and multiline comment input.
- [ ] Autosave an unpublished backend draft after a short debounce; flush on
  explicit Save. Use revision/operation IDs so delayed saves cannot overwrite a
  newer draft. Never clear typed text because a background refresh completed.
- [ ] **Save note** creates/publishes feedback. **Save and add another** saves,
  then re-enters selection only after acknowledgement. **Done** exits selection
  without destroying a saved note or pending editor draft.
- [ ] Allow capture when no agent exists. Show **Choose an agent to discuss or
  request changes** on the saved thread; do not make session creation a condition
  of saving feedback.
- [ ] Support title edit, comment edit, individual delete, and explicit image
  exclusion/redaction. Keep destructive thread deletion separate from removing
  an item from an unsent request.
- [ ] A content conflict preserves local text, shows the server revision, and
  lets the user keep it as a new reply or reload. Do not auto-merge instructions
  whose meaning could conflict.
- [ ] An empty editor may save capture-only context as an unpublished draft;
  publishing a note or dispatching requires a non-empty host-authored message.

## Collection and thread behavior

Show a paginated list with concise labels: title, page/viewport, status, last
activity, and destination if assigned. Defaults are current page and open notes;
provide all pages and resolved filters. Do not show raw selector/HTML text as
the primary label.

- [ ] Thread rows distinguish human notes, agent response links, system lifecycle
  notices, and legacy page comments. Display provenance without requiring users
  to understand the serialized prompt envelope.
- [ ] Expand evidence details on demand. Load large DOM/style sections and images
  only when requested; keep list rendering independent of asset fetches.
- [ ] Preserve local editor selection/focus while progress updates arrive. A new
  entry may show an unread marker; do not force-scroll someone reading history.
- [ ] Display missing image, stale capture, disconnected backend, and unavailable
  agent response as different states with appropriate actions.
- [ ] Link a browser-originated native chat turn back to its annotation. Opening
  that link selects the same thread rather than copying its text into a draft.
- [ ] Read saved feedback when the original browser tab is gone. The annotation
  belongs to the environment and page identity, not one mounted tab instance.

## Interaction states

| State | Required UI |
| --- | --- |
| Capture pending locally | Thumbnail/descriptor where available, unsent editor, upload retry/discard; no false backend Saved label. |
| Saving | Keep text editable with serialized draft revisions; disable duplicate Save creation. |
| Saved, no destination | Discuss/Request changes leads to destination selection without another capture. |
| Save error | Retain editor/capture; inline cause and Retry. |
| Request in progress | Read existing thread; new replies create later content revisions. Execution controls arrive in step 08. |
| Resolved | Show accepted revision/result and Reopen; a new substantive reply reopens. |
| Thread at capacity | Explain archive/continuation path; never silently drop the next comment. |

## Accessibility

- [ ] All selection, list, editor, evidence, and thread actions work without
  hover. Pins and buttons have target-specific accessible labels.
- [ ] Define focus flow: select target → editor; save → saved thread; cancel →
  preview/previous control; close panel → annotations control.
- [ ] Escape closes the nearest transient editor/selection UI predictably and
  preserves acknowledged drafts. It does not cancel a running agent.
- [ ] Announce save errors and important state changes without reading every
  streaming token into a live region. Honor reduced-motion preferences.
- [ ] Test keyboard-only operation at desktop and narrow viewport sizes, long
  labels, multiline notes, and browser zoom.

## Verification and completion

- [ ] Component tests cover creating without an agent, repeated notes, individual
  editing/deletion, conflicts, offline recovery, filters, pagination, and missing
  assets. Verify ordinary transcript annotation UI remains unchanged.
- [ ] Real isolated Electron checks prove the native view cannot cover the
  editor, menus, dialogs, or focus indicators and that screenshot bounds agree.
- [ ] Reload/reopen the browser tab and switch environments while a save is in
  flight; return to the correct draft and committed thread.

Done when users can collect, revise, and find persistent feedback entirely in
the browser UI, with trusted authoring and no implicit distribution to agents.
