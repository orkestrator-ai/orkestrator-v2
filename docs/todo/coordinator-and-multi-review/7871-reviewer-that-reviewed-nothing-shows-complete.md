# A reviewer that could not review shows as complete with no issues

## Task analysis

Analysed 2026-11-12 against `main` at `dc8803a8c`.

### Tasks

1. **Tell a reviewer that reviewed nothing from one that found nothing**. Status: open.

### 1. Tell a reviewer that reviewed nothing from one that found nothing

**Problem.** On 2026-11-12 a Codex reviewer in a container environment could not run a single shell command, because Codex's `read-only` sandbox could not create its user namespace there. It submitted a valid report saying it was blocked: `ready: "no"`, no issues, no coverage gaps, high risk. The flow graph showed the reviewer as Complete with "no issues", and consolidation went on with the other two reviewers' findings. A user reading the graph sees a reviewer that approved nothing and found nothing as if it had reviewed the change.

**Context.** The sandbox cause is fixed in the same change that added this file: a Codex read-only turn in a container now runs without Codex's sandbox ("Codex read-only turns in a container" in `docs/architecture/coordinator.md`). Other causes remain possible: a package the reviewer cannot read, a provider whose shell is broken, a model that gives up. `StructuredReviewReport` (`packages/protocol/src/structured-review/types.ts`) has no "blocked" or "could not review" state. A blocked report differs from a clean one only by `verdict.ready`, an empty or short `reviewScope.filesReviewed` and the reason in `reviewScope.limitations`. Consolidation already reads `filesReviewed` per reviewer (`review-consolidation-evidence.ts`, `filesReviewedCount`).

**Investigation.** Not started beyond the above. Unknown: whether plan reviews (which review a plan, not files) also report `filesReviewed: []` legitimately, and how the graph's reviewer status (`multi-review-graph-projection.ts`) and `ReviewerRecord` decide "Complete".

**Decisions.**

- **How should a reviewer say it could not review?**
  - **Add an explicit outcome to the reviewer report, such as `reviewScope.outcome: "reviewed" | "blocked"` with a reason, and treat `blocked` as a failed reviewer (recommended).**
    - Pros: the reviewer states it rather than the backend guessing; the existing failed-reviewer path (restart, consolidation without it) applies; the reason is shown.
    - Cons: a schema change across the protocol, every provider's structured output and the contract manifest; older reports lack the field.
  - **Infer it: a report with no files reviewed, no issues and `ready: "no"` is a failed reviewer.**
    - Pros: no schema change.
    - Cons: a heuristic; may misfire on plan reviews or a review of a tiny change, and failing a real review is worse than mislabelling one.
  - **Only change the display: show "Could not review" instead of "no issues" when `filesReviewed` is empty.**
    - Pros: smallest change; no change to pipeline behaviour.
    - Cons: the panel still counts the reviewer as a full opinion.

## Related

- `docs/architecture/coordinator.md`, "Codex read-only turns in a container".
