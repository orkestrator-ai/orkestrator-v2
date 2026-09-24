# Step 08 — Report budgets and compact consolidation

Status: 🟨 Budgets and compact envelope implemented on branch; quality evaluation pending

Depends on: Steps 01 and 04

## Outcome

Give every structured reviewer report and the aggregate consolidation input
explicit string, collection, encoded-byte, and source-count limits. Build a
compact consolidation evidence envelope that includes shared package facts once
and reviewer-specific analysis once, while preserving source provenance.

This step must preserve review quality. Payload reduction is accepted only when
the quality corpus shows equivalent finding recall, severity, file/line
accuracy, and provenance.

## Budget hierarchy

Step 01 supplies measured values. Define named constants for:

1. each free-form string and code/location field;
2. each list (`issues`, coverage gaps, strengths, limitations, files, tests,
   source finding IDs);
3. one parsed report's encoded UTF-8 bytes;
4. all accepted reviewer reports retained by one workflow;
5. compact consolidation evidence bytes;
6. final prompt bytes after fixed instructions/schema framing; and
7. structured-output repair attempts and repair input bytes.

All layers must agree: provider JSON schema `maxLength`/`maxItems`, runtime
parser, workflow validator, storage guard, and prompt builder. Runtime validation
is authoritative because provider schema enforcement can be absent or partial.
Measure encoded bytes with UTF-8, not JavaScript character count.

When a report exceeds a field/count budget, reject it with bounded actionable
feedback for the existing structured-output repair path. When it exceeds the
hard encoded-byte budget, do not echo the report into the error or repair
prompt; request a concise regeneration using counts only.

## Compact evidence contract

Add a versioned internal/protocol type such as
`ReviewConsolidationEvidenceV1`:

```text
generation: package/snapshot identity
shared: changed scope, validation summary, known evidence limitations
reviewers[]:
  reviewerId/sourceId, agent/model selection, verdict, summary,
  issues, coverage gaps, strengths, limitations, commentary
```

The backend derives `shared` facts from the verified package/manifest, not from
one model's prose. Omit report fields that merely repeat canonical package scope,
validation commands/results, or unchanged schema scaffolding. Preserve semantic
content unique to a reviewer.

Assign stable backend source IDs before serialization. Every consolidation issue
or gap must cite valid source finding IDs under the existing provenance rules.
Compact serialization must not renumber sources based on completion order.

## Implementation tasks

### Contract and validation

- [ ] Add shared budget constants and bounded schema construction in
  `packages/protocol/src/structured-review/schema.ts`, `types.ts`, and
  `validation.ts`.
- [ ] Reject duplicate source IDs, references to absent sources, excessive
  citations, and aggregate overflow.
- [ ] Add an encoded-byte check after parse and before persistence; object-shape
  validation alone cannot enforce it.
- [ ] Decide legacy behavior explicitly: previously stored oversized reports
  remain readable in a bounded migration mode, but cannot be fed unbounded into
  a new consolidation. Surface a limitation or request regeneration.
- [ ] Keep the 32 MiB workflow cap as a final storage defense, not the working
  report budget.

### Compaction

- [ ] Implement a pure, deterministic compacting function with fixture tests.
  It receives verified package facts and accepted reports and returns the V1
  envelope plus byte/count statistics.
- [ ] Update `multi-review-prompts.ts` to serialize the compact envelope inside
  the existing evidence frame. Keep instructions outside the untrusted JSON
  frame and preserve injection-resistant framing.
- [ ] Update Build Pipeline multi-review consolidation to use the same function.
- [ ] Validate the final prompt byte budget before dispatch. Never truncate raw
  JSON at a byte offset.
- [ ] If the envelope exceeds budget, first remove fields explicitly classified
  as optional presentation prose using deterministic rules. Never remove issue,
  gap, location, severity, or provenance fields silently.
- [ ] If required findings still exceed the budget, stop before dispatch with a
  recoverable bounded error offering fewer reviewers or explicit chunked
  consolidation. Do not silently drop the tail.

### Hierarchical fallback — gated follow-up

Implement map/reduce consolidation only if measured real workflows exceed the
single-pass budget often enough to justify it. Each chunk produces a bounded
intermediate with original source IDs; the final reducer validates that every
claim traces to those IDs. Bound chunk count, parallelism, intermediate bytes,
and additional turns. Do not make this the default before a quality evaluation.

## Quality evaluation

Build a checked-in synthetic/redacted corpus containing:

- agreement on the same finding with different severity;
- contradictory findings;
- unique findings from late reviewers;
- duplicate locations with different reasoning;
- clean reviews, invalid reports, and coverage gaps;
- maximum Unicode/string/list boundaries; and
- adversarial text containing evidence-frame-like markup.

Compare old full-report and new compact-envelope consolidation with fixed model
settings where a real-provider evaluation is permitted. Score finding recall,
false merge/split, final severity, location preservation, provenance validity,
and verdict. Keep model output out of ordinary CI logs and fixtures unless
scrubbed/approved; default CI tests the deterministic envelope and validator.

## Tests

- Boundary tests at limit minus one, exact limit, and limit plus one for every
  string/list/byte cap.
- Multibyte UTF-8 and nested aggregate-byte cases.
- Provider schema and runtime validator parity tests.
- Deterministic serialization and stable source ordering.
- No duplicated canonical validation/scope block per reviewer.
- Oversize rejection does not include content in errors/logs/metrics.
- Compact prompt framing resists embedded close tags/markup according to current
  evidence-frame escaping rules.
- Provenance rejects invented or dropped source IDs.
- Both workflow owners use identical compaction output for identical inputs.

## Acceptance criteria

- Every report and aggregate has explicit count and byte bounds before storage
  and model dispatch.
- Repeated shared evidence is serialized once.
- No required finding is silently truncated.
- Final source provenance remains complete and validator-enforced.
- Compact input meets the measured byte-reduction target and passes the agreed
  quality thresholds on the evaluation corpus.
- Oversize cases fail recoverably and content-free.

## Implementation record

- `packages/protocol/src/structured-review/budgets.ts` defines named limits:
  - 1 MiB per report;
  - 16 KiB per prose field;
  - 1 KiB per label or path;
  - 4 KiB per command;
  - 100 issues, 100 coverage gaps and 50 strengths;
  - 10,000 reviewed files;
  - 500 items in other lists;
  - 256 source IDs per finding and 10 alternative fixes.

  `structuredReviewReportBudgetIssues` measures UTF-8 bytes and reports at most
  20 content-free violations. Past the hard report budget it asks only for
  concise regeneration.
- Scope decision: budgets apply where a fan-out reviewer or consolidation
  answer is accepted (`parseStructuredReportResult`), through the existing
  bounded repair path. They are not added to the base parser, so reports
  already stored — including oversized ones from before this change — and
  other review features stay readable.
- Deviation: the provider JSON schema does not gain `maxLength`/`maxItems`.
  Several providers' structured-output paths reject or strip those keywords.
  Runtime enforcement is authoritative, as the plan notes, and the repair
  feedback states the limits.
- `apps/backend/src/core/review-consolidation-evidence.ts` builds
  `ReviewConsolidationEvidenceV1`, a pure, deterministic transform:
  - Scope, validation, test totals, change types and risk areas that every
    reviewer reported identically go under `shared`.
  - Everything reviewer-specific stays on the reviewer.
  - `reviewModels` is dropped per finding.
  - Source IDs come from configuration order and are never renumbered.
- Over the 640 KiB budget, optional prose is removed in a fixed order: change
  narration detail, then narration, then per-reviewer extra file lists.
  Findings, gaps, locations, severities and source IDs are never removed.
  Required content over budget throws a content-free
  `ConsolidationBudgetError` before dispatch.
- Framing hardening: the envelope serializes `<`/`>` as `\u003c`/`\u003e`, so
  report text can no longer spell the frame's closing marker.
- Both owners use the same prompt builder, and therefore the same compaction.
- Tests: `budgets.test.ts` (limit-1/exact/+1, UTF-8, labels, lists, oversize
  without content, bounded feedback, schema path parity);
  `review-consolidation-evidence.test.ts` (dedup, differing scope, source
  order, provenance accept/reject, determinism, reductions keep findings,
  content-free overflow, frame injection).
- Measured: about 12% smaller consolidation input at 32 reviewers on the
  synthetic corpus ([`baseline.md`](baseline.md)).
- Pending: the real-provider quality evaluation (recall, severity, location,
  provenance) comparing full and compact consolidation. The deterministic
  envelope keeps every finding field, but only a model evaluation can confirm
  no quality change.
- ⏸ Hierarchical consolidation: gated follow-up, not built. No measured
  workflow exceeds the single-pass budget.
