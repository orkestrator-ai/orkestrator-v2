# Annotation source hints keep a client's `verified: true` and pass it to the agent

Checked against `main` at `863b5782` (2026-10-27).

A capture submitted to the backend may carry `evidence.sourceHints` whose
`verified` flag is `true`. The backend validates only that the flag is a
boolean, stores the evidence unchanged, and both the agent brief and the
`get_annotation_evidence` tool hand the hint to the agent as it arrived. So the
claim "this location was checked" comes from the client, against the rule that
the receiving boundary assigns provenance. Nothing produces hints today, so no
user hits it yet. It becomes reachable once development source hints
([0047](0047-web-annotation-extensions.md) code item 3) start arriving from page
data. Found in the task analysis of
[0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) (task 4).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the gap in a failing test**: a capture-input validation test that submits a hint with `verified: true` and expects refusal. Status: open.
2. **Assign `verified` at the receiver**: refuse a client-declared `verified: true` and keep hints to their known fields. Status: open.
3. **Brief and evidence-tool regression tests**: prove what the agent sees for a stored hint. Status: open.

### 1. Pin the gap in a failing test

**Problem.** No test covers `sourceHints` at all, so the gap is invisible to the
suite.

**Context.** `packages/protocol/src/web-annotations.test.ts` already pins the
other receiver-assigned fields: a capture naming `regionCrop` or
`producerSource` is refused with "Image relations and producer basis are
assigned by the receiver" (`:121`), and a payload declaring `provenance` is
refused (`:140-143`).

**Investigation.** Confirmed by reading the code and by evaluating the
validator directly. `isWebAnnotationEvidence`
(`packages/protocol/src/web-annotations-validation.ts:242-263`) checks each hint
for bounded `producer` and `path`, optional `line` and `component`, and
`typeof hint.verified === "boolean"` (`:262`). It does not reject unknown keys.
A one-off `bun -e` call with a hint of
`{ producer, path, verified: true, extra: "anything" }` returned `true`.
`validateWebAnnotationCaptureInput` (`:303-357`) returns the input object
itself (`:356`), so whatever passed is what is stored. There is no grep hit for
`sourceHints` in any test file. Certain.

**Decisions.**

- **Where does the first test go?**
  - **Next to the existing receiver-assigned cases in `web-annotations.test.ts` (recommended).**
    - Pros: the rule and its siblings are tested in one place; fast and pure.
    - Cons: proves only validation, not what the agent sees (task 3 covers that).
  - **A backend command test through `web_annotation_create`.**
    - Pros: exercises the zod `capture` schema (`apps/backend/src/core/commands-registry-web-annotations.ts:66-75`) as well.
    - Cons: heavier fixture for a check that lives in one pure function.

### 2. Assign `verified` at the receiver

**Problem.** The backend never sets `verified: true`, but it does not reset or
refuse a client's `true` either.

**Context.** `docs/architecture/web-page-annotations.md` says provenance is
assigned by the receiving boundary. 0047 says the backend must check
containment and existence (with `web-annotation-source-checks.ts`) before a hint
is marked verified, and that hints stay candidate locations.

**Investigation.** Confirmed by reading the code end to end.
- `WebAnnotationSourceHint` carries `verified: boolean`
  (`packages/protocol/src/web-annotations.ts:306-316`).
- `web_annotation_create`, `web_annotation_capture_replace` and
  `web_annotation_result_capture` validate the capture through the shared
  schema (`commands-registry-web-annotations.ts:66-75`), which rejects only a
  top-level `provenance` (`assertNoDeclaredProvenance`,
  `web-annotations-validation.ts:482-486`) and then calls
  `validateWebAnnotationCaptureInput`.
- `captureFromInput` passes `evidence: input.evidence`
  (`apps/backend/src/core/web-annotation-service-threads.ts:462`) and
  `writeCapture` stores it unchanged (`:415`). Archive copies the stored
  evidence to the continuation (`:1267-1280`), which is correct for a
  backend-owned record.
- The brief spreads each hint into the agent's evidence and adds a note:
  `{ ...hint, note: "candidate location only; verify in the repository" }`
  (`apps/backend/src/core/web-annotation-brief.ts:365-370`). The spread also
  copies any unknown key the client added.
- `get_annotation_evidence` returns the stored capture whole
  (`apps/backend/src/core/web-annotation-tools.ts:361`), so the agent sees the
  same `verified: true` there without the note.
- Who can submit it today: only an authenticated client of the backend. The
  desktop page parser builds evidence from named fields and drops
  `sourceHints` (`apps/desktop/electron/browser-preview-capture-parse.ts:170-189`),
  so a previewed page cannot inject a hint now. An authenticated client can
  already write `host-user` entries, which are trusted instructions, so a forged
  flag gives it nothing new. The exposure that matters is the future producer:
  hints read from the page by a dev-server convention, where the page controls
  the values.
- Both the brief section and the evidence tool sit inside the untrusted
  evidence envelope (`web-annotation-brief.ts:853`), which limits the harm.

**Decisions.**

- **What happens to a client-declared `verified: true`?**
  - **Refuse it in `validateWebAnnotationCaptureInput` with the existing "assigned by the receiver" error, and keep accepting `false` (recommended).**
    - Pros: the same pattern as `regionCrop` and `producerSource`, which are refused rather than rewritten; no wire change, because every valid producer sends `false`; a buggy client is visible.
    - Cons: the desktop also calls this validator on its spool (`browser-preview-capture-store.ts:502`, `:607`, `:844`), so a spooled capture with `true` would be refused there too. Nothing produces hints, so no such spool exists.
  - **Force `verified: false` on write in `captureFromInput`.**
    - Pros: never refuses a capture.
    - Cons: silently rewrites client data; a client that believes it is sending verified hints never learns otherwise.
  - **Drop `verified` from the client input type; the backend adds it when it stores the capture.**
    - Pros: the cleanest contract: the client cannot express the claim at all.
    - Cons: a `packages/protocol` contract change for a field nothing produces; it touches the shared type the desktop spool also validates.
- **What happens to unknown keys inside a hint?**
  - **Copy only the five known fields when storing, and build the brief entry from those fields rather than `...hint` (recommended).**
    - Pros: the stored record and the brief carry only what the contract defines; a future producer cannot smuggle extra fields to the agent.
    - Cons: two small edits instead of one.
  - **Refuse a hint with unknown keys.**
    - Pros: strict and explicit.
    - Cons: a newer producer adding an optional field would be refused by an older backend; the rest of the evidence validator does not refuse unknown keys either.
- **Where is the check placed?**
  - **In `validateWebAnnotationCaptureInput`, not in `isWebAnnotationEvidence` (recommended).**
    - Pros: `isWebAnnotationEvidence` stays usable for stored captures, which may later hold a backend-set `true`.
    - Cons: a caller that validates evidence alone does not get the rule.
  - **In `isWebAnnotationEvidence`.**
    - Pros: every evidence check applies it.
    - Cons: it would also refuse the backend's own verified hints once the 0047 check exists.

### 3. Brief and evidence-tool regression tests

**Problem.** Nothing shows what the agent receives for a stored hint.

**Context.** `apps/backend/src/core/web-annotation-brief.test.ts` and
`apps/backend/src/core/web-annotation-tools.test.ts` exist and cover other
evidence sections.

**Investigation.** Neither file mentions `sourceHints`. Certain.

**Decisions.**

- **What do the tests assert?**
  - **A brief built from a stored hint shows `verified: false`, the note and only the known fields; the evidence tool returns the stored hint unchanged (recommended).**
    - Pros: pins both paths to the agent; catches a later `...hint` regression.
    - Cons: the tool test needs a seeded capture with hints.
  - **Brief test only.**
    - Pros: smallest.
    - Cons: the evidence tool is the second path to the agent and stays unpinned.

## Current state

- Validation accepts any boolean `verified` and unknown keys in a hint
  (`packages/protocol/src/web-annotations-validation.ts:252-263`), and returns
  the input unchanged (`:356`).
- The backend stores capture evidence unchanged
  (`apps/backend/src/core/web-annotation-service-threads.ts:415`, `:462`).
- The brief passes every hint key through with a "candidate location only" note
  (`apps/backend/src/core/web-annotation-brief.ts:365-370`), and
  `get_annotation_evidence` returns the stored capture whole
  (`apps/backend/src/core/web-annotation-tools.ts:361`).
- The receiver already refuses `provenance`, `regionCrop`, `producerSource` and
  `target.parentCaptureId` (`web-annotations-validation.ts:324-333`, `:482-486`).
- The desktop page parser drops `sourceHints`
  (`apps/desktop/electron/browser-preview-capture-parse.ts:170-189`), and no
  code in `apps/` produces hints.

## Outstanding work

### Code

1. Add a test in `packages/protocol/src/web-annotations.test.ts` that a capture
   whose hint declares `verified: true` is refused, and that `false` is
   accepted.
2. Refuse `verified: true` in `validateWebAnnotationCaptureInput` with the
   "assigned by the receiver" wording.
3. Store hints with only `producer`, `path`, `line`, `component` and `verified`,
   and build the brief entry from those fields instead of `...hint`.
4. Add tests in `web-annotation-brief.test.ts` and `web-annotation-tools.test.ts`
   for a stored hint.

### Qualification

- None beyond the tests in Code. There is no producer to exercise live.

## Constraints and rationale

- Provenance and verification are assigned by the receiving boundary, never
  taken from the submitter (`docs/architecture/web-page-annotations.md`).
- When 0047's source-hint producer lands, the backend's containment and
  existence check is the only thing that may set `verified: true`. This file
  must land first, so the producer cannot inherit a client-trusted flag.
- Hints stay candidate locations inside the untrusted evidence envelope even
  when verified.

## Open questions

- None.

## Needs verification

- None. The behaviour was confirmed by reading the code and by calling the
  validator; it does not depend on a live run.

## Related

- [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) (task 4,
  development source hints, which this unblocks safely).
- [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md)
  (receiver-assigned `regionCrop` and `producerSource`).
- [web-page-annotations.md](../../architecture/web-page-annotations.md)

## Replaces

Nothing; new on 2026-10-27, split from
[0047-web-annotation-extensions.md](0047-web-annotation-extensions.md)'s task
analysis.
