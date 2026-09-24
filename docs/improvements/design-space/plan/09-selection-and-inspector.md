# 09 — Selection and inspector

Status: Planned.  
Dependencies: [03](03-client-controller-and-reconciliation.md),
[06](06-validation-deletion-and-recovery.md),
[07](07-history-and-document-lifecycle.md).  
Findings: R1, U3.

## Outcome

Users can make several style edits to one element without repeatedly selecting
it, while structural changes still invalidate stale intent. Inspector values
explain authored overrides versus computed results and report invalid CSS
instead of pretending an ignored value was applied.

## Owners and runtime contract

Extend `design-runtime.ts`, `design-canvas.ts`, `frame-bridge.ts`,
`DesignFrameView.tsx`, `DesignInspector.tsx`, the controller, and backend style
validation. Keep inspect and mutation contracts shared by UI and MCP.

Proposed `DesignElementReference` contains canvas/frame identity, observed frame
revision, structure identity, selector, and an element key scoped to that
structure identity. It is a reference, not authority to bypass current CAS.

### Identity policy

- [ ] Begin with conservative structure-scoped identity: derive keys from a
  validated DOM path or a verified unique authored ID, always paired with the
  backend structure identity. Do not pretend an HTML `id` alone proves continuity
  across whole-document replacement.
- [ ] Preserve structure identity through known style-only and frame-geometry
  changes. Replace/append/move/restore/raw HTML operations invalidate it unless
  the backend explicitly proves continuity for a narrower supported operation.
- [ ] On structure change, clear the active edit target and retain its draft as
  stale. Reselection is required even if a positional selector still resolves.
- [ ] Avoid injecting persistent editor attributes into portable HTML for this
  first release. If later cross-structural identity is needed, specify collision,
  import/export, and authored-attribute rules in a separate format decision.
- [ ] Verify iframe response source, request identity, and rendered content
  identity before applying an asynchronous selection/inspection result.

## Inspect response

- [ ] Return a bounded list of supported properties with computed value, inline
  authored override when present, and whether reset removes an inline override.
  Do not claim complete cascade/source-rule attribution unless implemented.
- [ ] Include bounds in frame coordinates, tag, bounded label/text, bounded
  attributes, and overflow/truncation metadata.
- [ ] Add an inspect refresh operation that can preserve a draft while updating
  computed values after an acknowledged style or viewport change.
- [ ] Use request epochs so slower previous inspections cannot replace the
  newest target's properties.

## Editing and validation

1. User modifies a local draft; the committed inspection remains visible as the
   baseline. Input fields distinguish changed values.
2. Validate property syntax, supported units/ranges, and value size locally for
   immediate feedback. The shared runtime/backend remains authoritative.
3. Validate the whole proposed property set before applying any of it. Reject
   unsupported syntax explicitly; CSS custom properties need their own policy
   because accepting their token syntax does not prove a visible effect.
4. Prepare/execute a revision-checked style operation. Group a deliberate Apply
   or resize gesture into one history entry.
5. After acknowledgment, re-inspect the same structure-scoped element and keep
   it selected. Clear only successfully applied draft fields.
6. If the frame changed structurally or the reference is no longer unique,
   retain the draft and expose Reselect/Discard; do not auto-apply to a substitute.

- [ ] Report values that were invalid/ignored rather than incrementing revisions
  and showing success for a silently ignored CSS assignment.
- [ ] Distinguish removing an inline declaration from assigning the currently
  computed value. Reset returns to the cascade, not an invented default.
- [ ] Define behavior for `!important`, shorthand expansion, CSS variables,
  empty values, and SVG elements; do not silently reinterpret them.
- [ ] A valid declaration can still have no visible effect due to layout/cascade.
  Show accepted authored value plus actual computed value; do not label this a
  transport failure or promise pixel results.

## Inspector UI

- [ ] Group controls into Layout, Size/Spacing, Typography, and Appearance.
- [ ] Add unit-aware numeric controls, color inputs with text alternatives,
  enum controls where constrained, per-property reset, and an advanced field
  path for supported custom properties.
- [ ] Preserve draft values through inspection refresh, temporary disconnection,
  and recoverable failures. A target switch with unsent values must have a
  deliberate draft retention/discard policy rather than accidental remount loss.
- [ ] Show a concise pending/failed/changed-elsewhere state near Apply. Keep
  controls labeled and errors associated with the relevant field.
- [ ] Add a read-only attributes/details section with bounded content and safe
  wrapping; no credential/resource data enters diagnostic logs.
- [ ] Restore keyboard focus after acknowledgment and after stale-target recovery.

## Selection continuity tests

| Scenario | Expected |
| --- | --- |
| Apply color, then padding, then radius | Same valid selection; three correct acknowledged edits |
| Move frame without changing HTML | Selection stays; bounds transform with frame position |
| Resize viewport | Reinspect bounds/computed layout; no old rectangle asserted as current |
| Agent changes styles on same frame | Refresh inspection; user draft does not silently overwrite external change |
| Agent replaces HTML with identical IDs | Structure invalidation requires reselect |
| Duplicate IDs or ambiguous selector | No guessed target |
| Invalid CSS among multiple values | Atomic rejection/explicit per-policy result; no hidden partial application |
| Slow inspection returns after target switch | Result ignored |
| Apply response lost | Controller reconciles receipt; selection rehydrates correctly |

Review slices: identity/revision metadata; inspect schema; backend validation;
selection continuation; grouped inspector and focus behavior. Browser-test actual
computed styles and SVG behavior rather than relying solely on a DOM emulator.
