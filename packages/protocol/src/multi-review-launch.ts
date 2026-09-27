/**
 * Launch-time facts about a Multi Review panel, shared by the launcher and the
 * backend so both describe the same selection the same way.
 *
 * Nothing here rejects a selection. Exact duplicates can be intentional — a
 * second independent sample of the same configuration — so they are reported
 * as a warning, never as an error, and the protocol keeps accepting them.
 */
import { REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS } from "./review-fanout.js";

export interface MultiReviewLaunchSelectionIdentity {
  agent: string;
  model: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  modelUnpinned?: boolean;
}

/**
 * The behaviour-affecting identity of one reviewer selection: platform, model,
 * reasoning effort, speed, and whether the model was left to the provider.
 * Display labels play no part, so two rows that read differently but launch
 * identically are still the same configuration.
 */
export function multiReviewSelectionKey(selection: MultiReviewLaunchSelectionIdentity): string {
  return JSON.stringify([
    selection.agent,
    selection.model.trim(),
    selection.reasoningEffort?.trim() || null,
    typeof selection.fastMode === "boolean" ? selection.fastMode : null,
    selection.modelUnpinned === true,
  ]);
}

/**
 * Groups of reviewer positions (1-based, ascending) that share an exact
 * configuration. Only groups of two or more are returned, in order of their
 * first member.
 */
export function multiReviewDuplicateReviewerGroups(
  reviewers: readonly MultiReviewLaunchSelectionIdentity[],
): number[][] {
  const groups = new Map<string, number[]>();
  reviewers.forEach((reviewer, index) => {
    const key = multiReviewSelectionKey(reviewer);
    const group = groups.get(key) ?? [];
    group.push(index + 1);
    groups.set(key, group);
  });
  return Array.from(groups.values()).filter((group) => group.length > 1);
}

/** Count of reviewers that repeat an earlier reviewer's exact configuration. */
export function multiReviewDuplicateReviewerCount(
  reviewers: readonly MultiReviewLaunchSelectionIdentity[],
): number {
  return multiReviewDuplicateReviewerGroups(reviewers).reduce(
    (total, group) => total + group.length - 1,
    0,
  );
}

function positions(group: readonly number[]): string {
  if (group.length <= 1) return String(group[0] ?? "");
  return `${group.slice(0, -1).join(", ")} and ${group.at(-1)}`;
}

/** Factual, non-blocking warning for one duplicate group. */
export function multiReviewDuplicateWarning(group: readonly number[]): string {
  const turns = group.length === 2 ? "two" : String(group.length);
  const samples = group.length === 2 ? "a second sample" : "additional samples";
  return `Reviewers ${positions(group)} use the same configuration. This may provide ${samples} of that configuration, but often produces overlapping findings and approximately ${turns} review turns.`;
}

/**
 * Deterministic work implied by a launch — turns, not currency. Pricing,
 * caching and account terms are unknown here, so no cost is estimated.
 */
export interface MultiReviewWorkEstimate {
  reviewerTurns: number;
  preparationTurns: number;
  consolidationTurns: number;
  /** Validation commands run once and are shared by every reviewer. */
  validationRuns: number;
  /** Fix turns included in this launch (auto-fix only). */
  fixTurns: number;
  /** Structured-output repairs each model step may add, at most. */
  maxRepairTurnsPerStep: number;
}

export function multiReviewWorkEstimate(input: {
  reviewerCount: number;
  autoFix: boolean;
}): MultiReviewWorkEstimate {
  return {
    reviewerTurns: Math.max(0, Math.floor(input.reviewerCount)),
    preparationTurns: 1,
    consolidationTurns: 1,
    validationRuns: 1,
    fixTurns: input.autoFix ? 1 : 0,
    maxRepairTurnsPerStep: REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS,
  };
}

/** One-sentence summary of {@link multiReviewWorkEstimate} for the launcher. */
export function multiReviewWorkSummary(estimate: MultiReviewWorkEstimate): string {
  const reviewers = `${estimate.reviewerTurns} reviewer turn${estimate.reviewerTurns === 1 ? "" : "s"}`;
  const fix =
    estimate.fixTurns > 0
      ? ", then 1 fix turn"
      : "; a fix is launched separately and is not included";
  return `Expected work: 1 preparation turn, validation run once and shared, ${reviewers}, and 1 consolidation turn${fix}. Each model step may add up to ${estimate.maxRepairTurnsPerStep} repair turns if its structured output is invalid.`;
}
