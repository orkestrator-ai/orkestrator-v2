# Multi Review panel value

Checked against `main` at `2459b05c` (2026-10-15).

The aim is more review value per token without losing findings. #833 shipped
two cost changes on the strength of deterministic tests alone: a compact
consolidation envelope and a stable prompt prefix. It also added
duplicate-reviewer warnings to the launcher. The next steps are to prove those
changes kept finding quality and actually save cost, then to measure how much
reviewers overlap. Only after that should presets, lenses, adaptive stopping or
a different default panel be decided.

## Current state

- **Compact consolidation.** `buildConsolidationEvidence`
  (`apps/backend/src/core/review-consolidation-evidence.ts`) builds
  `ReviewConsolidationEvidenceV1`. Scope, validation, test totals, change types
  and risk areas that every reviewer reported identically go under `shared`.
  Everything reviewer-specific stays on the reviewer, and source IDs keep
  configuration order. On the synthetic corpus the input was about 12% smaller
  at 32 reviewers, with every finding and source ID kept. The old full-report
  builder was replaced, not kept behind a flag. It survives only in history
  (`consolidationReports` in `review-fanout.ts` at `d680ccdb`, the pre-#833
  merge base).
- **Report budgets.** `packages/protocol/src/structured-review/budgets.ts`
  applies where a fan-out or consolidation answer is accepted
  (`parseStructuredReportResult` in `review-fanout.ts`), not in the base parser,
  so stored and other review reports stay readable. The provider JSON schema
  carries no `maxLength` / `maxItems`, because several providers reject or
  strip them; the repair feedback states the limits instead.
- **Stable prompt prefix.** `reviewerPanelSection`
  (`multi-review-prompts.ts`) is the only per-reviewer text, and it is the last
  section of the packaged, live-worktree and Build Pipeline reviewer prompts.
  The invariant prefix is therefore byte-identical across a panel. The section
  still says position carries no priority.
- **Launcher.** `packages/protocol/src/multi-review-launch.ts` provides
  `multiReviewDuplicateReviewerGroups`, `multiReviewDuplicateWarning` and a
  turn-count `multiReviewWorkEstimate` / `multiReviewWorkSummary`.
  `MultiReviewLaunchDialog.tsx` shows the warning in a polite live region
  without blocking or changing the launch.
- **Telemetry.** Both owners record `launch.duplicate_reviewers`
  (`multi-review-service.ts`, `build-pipeline-review-fanout.ts`), so
  coordinator and MCP launches are counted too. In production this goes to the
  no-op observer.
- **Usage data.** The shared protocol has `NativeAgentTurnUsage.cacheReadTokens`
  (`packages/protocol/src/native-agent.ts`), and every bridge and OpenCode's
  usage mapping fill it in some form. Reviewer records keep only `tokenCount`
  (`packages/protocol/src/review-fanout.ts`), so per-reviewer cache reads are
  not captured.
- **Not built.** There are no preset or lens protocol fields and no
  overlap or novelty metric. Consolidated issues and coverage gaps carry
  `reviewSourceIds`, which is enough to compute one.

## Outstanding work

### Code

1. **Content-free overlap metric.** From `reviewSourceIds`, count consolidated
   findings, source findings, and findings with a single source, per run and
   per reviewer position. IDs and counts only, never text. Every later decision
   depends on this number.
2. **Checked-in evaluation corpus**, synthetic or redacted, going beyond
   `multi-review-efficiency-fixtures.ts`. It should include: agreement on a
   finding with different severity; contradictory findings; late unique
   findings; duplicate locations with different reasoning; clean reviews,
   invalid reports and coverage gaps; Unicode, string and list limit
   boundaries; and adversarial text that imitates evidence-frame markup.
3. **Per-reviewer cache-read capture.** Record `cacheReadTokens` (count only)
   alongside `tokenCount` for reviewers, so the prefix change can be measured
   from real runs.

### Qualification

- **Full versus compact consolidation on real providers**, with fixed model
  settings over the corpus. Score finding recall, false merges and splits,
  final severity, location, provenance validity and verdict. The full builder
  has to be rebuilt from `d680ccdb` for the comparison. Keep model output out
  of CI logs and fixtures unless scrubbed; CI keeps testing the deterministic
  envelope and validator.
- **Prefix-cache measurement.** On providers that report cache reads, compare
  `cacheReadTokens` for reviewers 2..N of a panel against reviewer 1. Do not
  assume every provider caches prefixes.
- Both need provider credentials; batch them with
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

### Deferred until measured

These are product decisions gated on the overlap metric and the quality
results above:

- Quick, Balanced and Thorough presets that expand into ordinary, editable
  reviewer rows. Their reviewer counts and models are not assumed.
- Optional, non-exclusive review lenses (correctness, tests, security,
  maintainability, performance) as a shared-protocol enum. Consolidation sees
  the declared lens. Reviewers must still report critical issues outside their
  lens.
- Opt-in adaptive stopping, with a minimum panel and a measured novelty or
  confidence rule.
- Any change to the default two-reviewer panel.

## Constraints and rationale

- No currency or cost estimates without current provider pricing. The work
  estimate counts turns.
- Exact duplicate rows stay valid and only warn. They are independent samples of
  one configuration, which can be deliberate.
- The reviewer index carries no authority. A later reviewer must not defer to
  earlier ones, and reviewer sessions stay isolated.
- No dormant protocol fields. Add a preset or lens field only with the feature
  that uses it, and reject or drop unknown values safely.
- Never silently cancel reviewers the user selected. Novelty is unknowable
  before a report completes, so cancelling "low-value" reviewers would change
  quality semantics.
- Prompt-cache layout must not weaken the evidence frame or the
  prompt-injection boundary. The envelope serialises `<` and `>` as `<` and
  `>` so report text cannot close the frame.
- Compaction never truncates findings, gaps, locations, severities or source
  IDs. Over budget, only optional prose is removed, in a fixed order.
- Ship lenses or adaptive stopping only if recall does not regress on the
  fixed corpus.

## Open questions

- Is rebuilding the old full builder worth it, or is a fixed reference panel
  scored by hand enough to judge compact consolidation?
- Do all providers' `cacheReadTokens` values reflect prompt-prefix hits, or do
  some report only provider-side context caching?

## Needs verification

- Whether any real-provider consolidation comparison was ever run. None is
  recorded.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md): control-plane
  cost, rollback gates and hierarchical consolidation.
- [`review-preparation.md`](../../architecture/review-preparation.md#fan-out-budgets-and-benchmark):
  consolidation sizes and the reasoning behind the 640 KiB and per-report
  budgets.

## Replaces

- `docs/improvements/multi-review/README.md` (findings 7–9, phases 3–4)
- `docs/improvements/multi-review/plan/08-report-budgets-and-compact-consolidation.md`
- `docs/improvements/multi-review/plan/09-prompt-prefix-and-launcher-value.md`
- `docs/improvements/multi-review/plan/10-scale-validation-rollout-and-cleanup.md`
  (quality evaluation and cache-hit measurement)
