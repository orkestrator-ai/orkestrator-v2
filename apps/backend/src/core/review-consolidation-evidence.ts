/**
 * The compact evidence a consolidation turn receives.
 *
 * Consolidation used to receive every reviewer's complete report. Each report
 * repeats the same review scope — target branch, commit range, the reviewed
 * file list, validation commands, test totals — because every reviewer
 * examined the same pinned evidence. At 32 reviewers that repetition, not the
 * findings, dominated the prompt.
 *
 * {@link buildConsolidationEvidence} is a pure, deterministic transform:
 *
 * - A scope or validation fact that every reviewer reported identically is
 *   serialized once under `shared`. What a reviewer reported beyond that stays
 *   on the reviewer, so nothing a single reviewer claimed is lost.
 * - Findings, coverage gaps, strengths, limitations, verdicts and commentary
 *   are always per reviewer, with the backend-issued `reviewSourceIds` they
 *   were given. Source IDs come from the reviewer's configured position and
 *   are never renumbered here.
 * - Per-finding `reviewModels` is dropped: the reviewer's agent and model are
 *   stated once on the reviewer, and the backend re-derives provenance from
 *   the cited source IDs anyway.
 *
 * When the envelope exceeds the budget, only prose explicitly classified as
 * optional presentation is removed, in a fixed order. Findings, gaps, their
 * locations, severities and source IDs are never removed. If the required
 * content still does not fit, the caller gets a {@link ConsolidationBudgetError}
 * before anything is dispatched.
 */
import type {
  ReviewCommit,
  ReviewCoverageGap,
  ReviewIssue,
  ReviewTestResults,
  StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";

/** Serialized envelope bytes a single consolidation turn may receive. */
export const CONSOLIDATION_MAX_EVIDENCE_BYTES = 640 * 1024;

export interface ConsolidationSourceReport {
  reviewerId: string;
  agent: string;
  model: string;
  report: StructuredReviewReport;
}

type Finding<T> = Omit<T, "reviewModels">;

export interface ConsolidationReviewerEvidence {
  reviewerId: string;
  agent: string;
  model: string;
  verdict: StructuredReviewReport["verdict"];
  reviewSummary: string;
  summaryOfChange?: string;
  whatChanged?: Partial<StructuredReviewReport["whatChanged"]>;
  riskProfile: {
    overallRisk: StructuredReviewReport["riskProfile"]["overallRisk"];
    reasoning: string;
    /** Only labels not already listed under `shared`. */
    changeTypes: StructuredReviewReport["riskProfile"]["changeTypes"];
    riskAreas: string[];
  };
  /** Present only when this reviewer's totals differ from the shared totals. */
  testResults?: ReviewTestResults;
  /** Scope entries beyond what every reviewer reported identically. */
  reviewScope: {
    targetBranch?: string;
    baseRef?: string;
    commit?: ReviewCommit | null;
    filesReviewedCount: number;
    filesReviewed?: string[];
    filesSkipped: StructuredReviewReport["reviewScope"]["filesSkipped"];
    filesLeftUncommitted: StructuredReviewReport["reviewScope"]["filesLeftUncommitted"];
    commandsRun: StructuredReviewReport["reviewScope"]["commandsRun"];
    commandsNotRun: StructuredReviewReport["reviewScope"]["commandsNotRun"];
    limitations: string[];
  };
  strengths: StructuredReviewReport["strengths"];
  issues: Array<Finding<ReviewIssue>>;
  testCoverageGaps: Array<Finding<ReviewCoverageGap>>;
}

export interface ReviewConsolidationEvidenceV1 {
  version: 1;
  /** Facts every reviewer reported identically; stated once. */
  shared: {
    reviewerCount: number;
    reviewScope: {
      targetBranch?: string;
      baseRef?: string;
      commit?: ReviewCommit | null;
      filesReviewed: string[];
      filesSkipped: StructuredReviewReport["reviewScope"]["filesSkipped"];
      filesLeftUncommitted: StructuredReviewReport["reviewScope"]["filesLeftUncommitted"];
      commandsRun: StructuredReviewReport["reviewScope"]["commandsRun"];
      commandsNotRun: StructuredReviewReport["reviewScope"]["commandsNotRun"];
      limitations: string[];
    };
    changeTypes: StructuredReviewReport["riskProfile"]["changeTypes"];
    riskAreas: string[];
    testResults?: ReviewTestResults;
  };
  reviewers: ConsolidationReviewerEvidence[];
}

export interface ConsolidationEvidenceStats {
  reviewers: number;
  sourceFindings: number;
  /** Bytes the complete reports would have serialized to. */
  fullBytes: number;
  /** Bytes of the serialized envelope actually sent. */
  compactBytes: number;
  /** Optional-prose reduction steps applied to fit the budget. */
  reductions: number;
}

/** The required consolidation content does not fit its budget. */
export class ConsolidationBudgetError extends Error {
  constructor(readonly stats: ConsolidationEvidenceStats) {
    super(
      `The ${stats.reviewers} reviewer reports are too large to consolidate in one turn (${stats.compactBytes} bytes after removing optional prose; the limit is ${CONSOLIDATION_MAX_EVIDENCE_BYTES}). Restart the review with fewer reviewers, or stop reviewers whose reports are not needed, then retry consolidation.`,
    );
    this.name = "ConsolidationBudgetError";
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** Items (by canonical value) present in every list, in first-list order. */
function commonItems<T>(lists: readonly (readonly T[])[]): T[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  const restSets = rest.map((list) => new Set(list.map(canonical)));
  const seen = new Set<string>();
  return first!.filter((item) => {
    const key = canonical(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return restSets.every((set) => set.has(key));
  });
}

function without<T>(list: readonly T[], shared: readonly T[]): T[] {
  const sharedKeys = new Set(shared.map(canonical));
  return list.filter((item) => !sharedKeys.has(canonical(item)));
}

function allEqual<T>(values: readonly T[]): boolean {
  if (values.length === 0) return true;
  const first = canonical(values[0]);
  return values.every((value) => canonical(value) === first);
}

function stripModels<T extends { reviewModels?: string[] }>(finding: T): Omit<T, "reviewModels"> {
  const { reviewModels: _models, ...rest } = finding;
  return rest;
}

/**
 * Serializes JSON for an evidence frame. Every `<` and `>` is written as its
 * JSON unicode escape, which parsers decode identically, so no string inside
 * the frame can spell the frame's closing marker.
 */
export function serializeFramedEvidence(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(serializeFramedEvidence(value), "utf8");
}

/**
 * Optional presentation prose, removed in this order when over budget. Each
 * step is idempotent and deterministic.
 */
const REDUCTIONS: ReadonlyArray<(reviewer: ConsolidationReviewerEvidence) => void> = [
  // 1. Change narration detail: before/after prose and the key-change list.
  (reviewer) => {
    if (!reviewer.whatChanged) return;
    delete reviewer.whatChanged.before;
    delete reviewer.whatChanged.after;
    delete reviewer.whatChanged.keyCodeChanges;
  },
  // 2. The remaining change narration. The package defines the change.
  (reviewer) => {
    delete reviewer.whatChanged;
    delete reviewer.summaryOfChange;
  },
  // 3. Per-reviewer file lists beyond the shared set (the count remains).
  (reviewer) => {
    delete reviewer.reviewScope.filesReviewed;
  },
];

/**
 * Fills sections a report may lack. Accepted reports are complete, but the
 * envelope must never throw on a partial one: the full-report prompt it
 * replaced serialized whatever it was given.
 */
function normalizedReport(report: StructuredReviewReport): StructuredReviewReport {
  const partial = report as Partial<StructuredReviewReport>;
  return {
    ...report,
    reviewScope: {
      targetBranch: "",
      baseRef: "",
      commit: null,
      filesReviewed: [],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
      ...partial.reviewScope,
    },
    riskProfile: {
      changeTypes: [],
      riskAreas: [],
      overallRisk: "medium",
      reasoning: "",
      ...partial.riskProfile,
    },
    strengths: partial.strengths ?? [],
    issues: partial.issues ?? [],
    testCoverageGaps: partial.testCoverageGaps ?? [],
  };
}

export function buildConsolidationEvidence(
  sourceReports: readonly ConsolidationSourceReport[],
  maxBytes: number = CONSOLIDATION_MAX_EVIDENCE_BYTES,
): { evidence: ReviewConsolidationEvidenceV1; stats: ConsolidationEvidenceStats } {
  const reports = sourceReports.map((entry) => ({
    ...entry,
    report: normalizedReport(entry.report),
  }));
  const scopes = reports.map((entry) => entry.report.reviewScope);
  const risk = reports.map((entry) => entry.report.riskProfile);
  const shared: ReviewConsolidationEvidenceV1["shared"] = {
    reviewerCount: reports.length,
    reviewScope: {
      ...(allEqual(scopes.map((scope) => scope.targetBranch)) && scopes.length > 0
        ? { targetBranch: scopes[0]!.targetBranch }
        : {}),
      ...(allEqual(scopes.map((scope) => scope.baseRef)) && scopes.length > 0
        ? { baseRef: scopes[0]!.baseRef }
        : {}),
      ...(allEqual(scopes.map((scope) => scope.commit)) && scopes.length > 0
        ? { commit: scopes[0]!.commit }
        : {}),
      filesReviewed: commonItems(scopes.map((scope) => scope.filesReviewed)),
      filesSkipped: commonItems(scopes.map((scope) => scope.filesSkipped)),
      filesLeftUncommitted: commonItems(scopes.map((scope) => scope.filesLeftUncommitted)),
      commandsRun: commonItems(scopes.map((scope) => scope.commandsRun)),
      commandsNotRun: commonItems(scopes.map((scope) => scope.commandsNotRun)),
      limitations: commonItems(scopes.map((scope) => scope.limitations)),
    },
    changeTypes: commonItems(risk.map((profile) => profile.changeTypes)),
    riskAreas: commonItems(risk.map((profile) => profile.riskAreas)),
    ...(reports.length > 0 && allEqual(reports.map((entry) => entry.report.testResults))
      ? { testResults: reports[0]!.report.testResults }
      : {}),
  };

  const reviewers = reports.map((entry): ConsolidationReviewerEvidence => {
    const { report } = entry;
    const scope = report.reviewScope;
    const extraFiles = without(scope.filesReviewed, shared.reviewScope.filesReviewed);
    return {
      reviewerId: entry.reviewerId,
      agent: entry.agent,
      model: entry.model,
      verdict: report.verdict,
      reviewSummary: report.reviewSummary,
      summaryOfChange: report.summaryOfChange,
      ...(report.whatChanged ? { whatChanged: { ...report.whatChanged } } : {}),
      riskProfile: {
        overallRisk: report.riskProfile.overallRisk,
        reasoning: report.riskProfile.reasoning,
        changeTypes: without(report.riskProfile.changeTypes, shared.changeTypes),
        riskAreas: without(report.riskProfile.riskAreas, shared.riskAreas),
      },
      ...(shared.testResults ? {} : { testResults: report.testResults }),
      reviewScope: {
        ...(shared.reviewScope.targetBranch === undefined
          ? { targetBranch: scope.targetBranch }
          : {}),
        ...(shared.reviewScope.baseRef === undefined ? { baseRef: scope.baseRef } : {}),
        ...("commit" in shared.reviewScope ? {} : { commit: scope.commit }),
        filesReviewedCount: scope.filesReviewed.length,
        ...(extraFiles.length > 0 ? { filesReviewed: extraFiles } : {}),
        filesSkipped: without(scope.filesSkipped, shared.reviewScope.filesSkipped),
        filesLeftUncommitted: without(
          scope.filesLeftUncommitted,
          shared.reviewScope.filesLeftUncommitted,
        ),
        commandsRun: without(scope.commandsRun, shared.reviewScope.commandsRun),
        commandsNotRun: without(scope.commandsNotRun, shared.reviewScope.commandsNotRun),
        limitations: without(scope.limitations, shared.reviewScope.limitations),
      },
      strengths: report.strengths,
      issues: report.issues.map(stripModels),
      testCoverageGaps: report.testCoverageGaps.map(stripModels),
    };
  });

  const evidence: ReviewConsolidationEvidenceV1 = { version: 1, shared, reviewers };
  const stats: ConsolidationEvidenceStats = {
    reviewers: reports.length,
    sourceFindings: reports.reduce(
      (total, entry) => total + entry.report.issues.length + entry.report.testCoverageGaps.length,
      0,
    ),
    fullBytes: encodedBytes(sourceReports),
    compactBytes: encodedBytes(evidence),
    reductions: 0,
  };
  for (const reduce of REDUCTIONS) {
    if (stats.compactBytes <= maxBytes) break;
    reviewers.forEach(reduce);
    stats.reductions += 1;
    stats.compactBytes = encodedBytes(evidence);
  }
  if (stats.compactBytes > maxBytes) throw new ConsolidationBudgetError(stats);
  return { evidence, stats };
}
