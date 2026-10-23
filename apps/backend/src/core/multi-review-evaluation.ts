/**
 * Scoring and prompt variants for evaluating Multi Review consolidation over
 * the checked-in corpus (`multi-review-evaluation-corpus.ts`).
 *
 * Nothing here runs in production. The real-provider comparison sends each
 * case's full and compact consolidation prompts to fixed model settings and
 * scores the answers with {@link scoreConsolidation}; CI checks the scorer
 * and both prompts deterministically. Every score is a count or a flag, so it
 * can be printed and stored without model output.
 */
import {
  MULTI_REVIEW_REPORTS_FRAME_CLOSE,
  MULTI_REVIEW_REPORTS_FRAME_OPEN,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  pipelineIndependentReviewSlot,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { ReviewPanelOverlapV1 } from "@orkestrator/protocol/review-fanout";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { EvaluationCase, EvaluationFindingKind } from "./multi-review-evaluation-corpus.js";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import { serializeFramedEvidence } from "./review-consolidation-evidence.js";
import {
  consolidationOverlap,
  consolidationReports,
  deriveConsolidatedProvenance,
} from "./review-fanout-provenance.js";

export type ConsolidationEvidenceVariant = "compact" | "full";

const COMPACT_EVIDENCE_NOTE = "The evidence is compact:";

/**
 * The consolidation prompt for one corpus case.
 *
 * `compact` is the production prompt. `full` rebuilds the pre-#833 evidence
 * (`d680ccdb`): every reviewer's complete report, serialized as one JSON
 * array, with the rest of the prompt unchanged so the evidence is the only
 * variable. The note that explains the compact `shared` section is dropped
 * because the full evidence has none.
 */
export function evaluationConsolidationPrompt(
  evaluation: EvaluationCase,
  variant: ConsolidationEvidenceVariant,
): string {
  const reports = consolidationReports(evaluation.reviewers);
  const prompt = createMultiReviewConsolidationPrompt({ targetBranch: "main", reports });
  if (variant === "compact") return prompt;
  const open = prompt.indexOf(MULTI_REVIEW_REPORTS_FRAME_OPEN);
  const close = prompt.indexOf(MULTI_REVIEW_REPORTS_FRAME_CLOSE);
  const note = prompt.indexOf(COMPACT_EVIDENCE_NOTE);
  if (open < 0 || close < open || note < 0 || note > open) {
    throw new Error("The consolidation prompt layout changed; update the full-evidence variant.");
  }
  const noteEnd = prompt.indexOf("\n\n", note) + 2;
  return `${prompt.slice(0, note)}${prompt.slice(noteEnd, open + MULTI_REVIEW_REPORTS_FRAME_OPEN.length)}\n${serializeFramedEvidence(reports)}\n${prompt.slice(close)}`;
}

/**
 * The consolidation the corpus case expects, as a model would return it: each
 * expected finding copies its first source finding, with the expected
 * severity and location and every expected source ID.
 */
export function referenceConsolidation(evaluation: EvaluationCase): StructuredReviewReport {
  const sources = new Map<string, { kind: EvaluationFindingKind; finding: object }>();
  for (const entry of consolidationReports(evaluation.reviewers)) {
    for (const issue of entry.report.issues) {
      sources.set(issue.reviewSourceIds![0]!, { kind: "issue", finding: issue });
    }
    for (const gap of entry.report.testCoverageGaps) {
      sources.set(gap.reviewSourceIds![0]!, { kind: "coverage-gap", finding: gap });
    }
  }
  const base = evaluation.reviewers.find((reviewer) => reviewer.report)!.report!;
  const strip = <T extends { reviewModels?: string[] }>(finding: T) => {
    const { reviewModels: _models, ...rest } = finding;
    return rest;
  };
  const findings = evaluation.expected.findings.map((expected) => {
    const source = sources.get(expected.sources[0]!);
    if (!source || source.kind !== expected.kind) {
      throw new Error(`Corpus case ${evaluation.id} names an unknown source finding.`);
    }
    return { expected, finding: strip(source.finding as { reviewModels?: string[] }) };
  });
  return {
    ...base,
    issues: findings
      .filter(({ expected }) => expected.kind === "issue")
      .map(({ expected, finding }) => ({
        ...(finding as StructuredReviewReport["issues"][number]),
        severity: expected.severity!,
        file: expected.file,
        line: expected.line ?? null,
        reviewSourceIds: [...expected.sources],
      })),
    testCoverageGaps: findings
      .filter(({ expected }) => expected.kind === "coverage-gap")
      .map(({ expected, finding }) => ({
        ...(finding as StructuredReviewReport["testCoverageGaps"][number]),
        file: expected.file,
        reviewSourceIds: [...expected.sources],
      })),
    verdict: { ...base.verdict, ready: evaluation.expected.verdict },
  };
}

export interface ConsolidationScore {
  caseId: string;
  expectedFindings: number;
  actualFindings: number;
  /** Expected findings at least one actual finding of the same kind cites a source of. */
  recalled: number;
  /** Actual findings whose sources span two or more expected findings. */
  falseMerges: number;
  /** Expected findings whose sources are spread over two or more actual findings. */
  splits: number;
  /** Actual findings citing no source of any expected finding (droppable sources excepted). */
  unexpected: number;
  /** Expected source IDs no actual finding cites. */
  droppedSources: number;
  /** Recalled issues whose best match keeps the expected severity. */
  severityMatches: number;
  recalledIssues: number;
  /** Recalled findings whose best match keeps the expected file and line. */
  locationMatches: number;
  /** Every citation names a source finding of the right kind. */
  provenanceValid: boolean;
  verdictMatches: boolean;
}

/**
 * Scores a consolidation answer, as returned by the model (with source IDs),
 * against the case's expectation. Content-free: only counts and flags.
 */
export function scoreConsolidation(
  evaluation: EvaluationCase,
  report: StructuredReviewReport,
): ConsolidationScore {
  const expected = evaluation.expected.findings;
  const owner = new Map<string, number>();
  expected.forEach((finding, index) => {
    for (const source of finding.sources) owner.set(`${finding.kind}\0${source}`, index);
  });
  const droppable = new Set(evaluation.expected.droppable ?? []);
  const actual = [
    ...report.issues.map((finding) => ({ kind: "issue" as const, finding })),
    ...report.testCoverageGaps.map((finding) => ({ kind: "coverage-gap" as const, finding })),
  ];
  /** For each expected finding, the actual findings that cite one of its sources. */
  const matches = expected.map(() => [] as number[]);
  const citedSources = new Set<string>();
  let falseMerges = 0;
  let unexpected = 0;
  actual.forEach(({ kind, finding }, actualIndex) => {
    const owners = new Set<number>();
    const sourceIds = finding.reviewSourceIds ?? [];
    for (const source of sourceIds) {
      citedSources.add(`${kind}\0${source}`);
      const index = owner.get(`${kind}\0${source}`);
      if (index !== undefined) owners.add(index);
    }
    const onlyDroppable =
      sourceIds.length > 0 && sourceIds.every((source) => droppable.has(source));
    if (owners.size > 1) falseMerges += 1;
    if (owners.size === 0 && !onlyDroppable) unexpected += 1;
    for (const index of owners) matches[index]!.push(actualIndex);
  });

  let recalled = 0;
  let splits = 0;
  let severityMatches = 0;
  let recalledIssues = 0;
  let locationMatches = 0;
  expected.forEach((finding, index) => {
    const candidates = matches[index]!;
    if (candidates.length === 0) return;
    recalled += 1;
    if (candidates.length > 1) splits += 1;
    // The best match is the actual finding citing the most of its sources.
    const overlap = (actualIndex: number) =>
      (actual[actualIndex]!.finding.reviewSourceIds ?? []).filter((source) =>
        finding.sources.includes(source),
      ).length;
    const best = actual[candidates.reduce((a, b) => (overlap(b) > overlap(a) ? b : a))]!;
    if (best.finding.file === finding.file) {
      if (finding.kind === "coverage-gap") locationMatches += 1;
      else if ((best.finding as { line: number | null }).line === (finding.line ?? null)) {
        locationMatches += 1;
      }
    }
    if (finding.kind === "issue") {
      recalledIssues += 1;
      if ((best.finding as { severity: string }).severity === finding.severity) {
        severityMatches += 1;
      }
    }
  });

  const droppedSources = expected
    .flatMap((finding) => finding.sources.map((source) => `${finding.kind}\0${source}`))
    .filter((key) => !citedSources.has(key)).length;
  return {
    caseId: evaluation.id,
    expectedFindings: expected.length,
    actualFindings: actual.length,
    recalled,
    falseMerges,
    splits,
    unexpected,
    droppedSources,
    severityMatches,
    recalledIssues,
    locationMatches,
    provenanceValid: deriveConsolidatedProvenance(report, evaluation.reviewers).issues.length === 0,
    verdictMatches: report.verdict.ready === evaluation.expected.verdict,
  };
}

/** Overlap counts the case's reference consolidation produces. */
export function referenceOverlap(evaluation: EvaluationCase) {
  return consolidationOverlap(referenceConsolidation(evaluation), evaluation.reviewers);
}

export interface PanelValueReviewer {
  /** One-based configured position. */
  position: number;
  agent?: string;
  model?: string;
  tokenCount?: number;
  cacheReadTokens?: number;
  /** cacheReadTokens / tokenCount, when both are known and tokenCount > 0. */
  cacheReadShare?: number;
}

/** One consolidated panel from a stored workflow: counts and model settings only. */
export interface PanelValueSummary {
  source: "multi-review" | "build-pipeline";
  /** Build Pipeline review iteration; absent for Multi Review. */
  iteration?: number;
  overlap?: ReviewPanelOverlapV1;
  reviewers: PanelValueReviewer[];
  /**
   * Mean cache-read share of reviewers 2..N on reviewer 1's agent and model,
   * minus reviewer 1's share. Positive when later reviewers were served more
   * of their prompt from cache. Absent without comparable data.
   */
  laterCacheReadShareDelta?: number;
}

function panelReviewer(
  position: number,
  fields: { agent?: string; model?: string; tokenCount?: number; cacheReadTokens?: number },
): PanelValueReviewer {
  const { agent, model, tokenCount, cacheReadTokens } = fields;
  return {
    position,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(tokenCount && cacheReadTokens !== undefined
      ? { cacheReadShare: cacheReadTokens / tokenCount }
      : {}),
  };
}

function shareDelta(reviewers: readonly PanelValueReviewer[]): number | undefined {
  const first = reviewers.find((reviewer) => reviewer.position === 1);
  if (first?.cacheReadShare === undefined) return undefined;
  const later = reviewers.filter(
    (reviewer) =>
      reviewer.position > 1 &&
      reviewer.cacheReadShare !== undefined &&
      reviewer.agent === first.agent &&
      reviewer.model === first.model,
  );
  if (later.length === 0) return undefined;
  const mean =
    later.reduce((total, reviewer) => total + reviewer.cacheReadShare!, 0) / later.length;
  return mean - first.cacheReadShare;
}

/**
 * Reads the overlap and per-reviewer cache counts out of a stored Multi Review
 * workflow or Build Pipeline record, for the prefix-cache and overlap
 * measurements. Text, paths and findings are never copied out.
 */
export function summarizePanelValue(
  record: MultiReviewWorkflow | BuildPipeline,
): PanelValueSummary[] {
  if ("reviewers" in record && Array.isArray(record.reviewers)) {
    const workflow = record as MultiReviewWorkflow;
    const reviewers = workflow.reviewers.map((reviewer, index) =>
      panelReviewer(index + 1, reviewer),
    );
    return [
      {
        source: "multi-review",
        ...(workflow.consolidationOverlap ? { overlap: workflow.consolidationOverlap } : {}),
        reviewers,
        ...withDelta(reviewers),
      },
    ];
  }
  const pipeline = record as BuildPipeline;
  const iterations = new Map<number, PanelValueSummary>();
  for (const session of pipeline.sessions ?? []) {
    if (session.phase !== "review") continue;
    const slot = pipelineIndependentReviewSlot(session.label);
    if (slot === null && !session.reviewOverlap) continue;
    let summary = iterations.get(session.iteration);
    if (!summary) {
      summary = { source: "build-pipeline", iteration: session.iteration, reviewers: [] };
      iterations.set(session.iteration, summary);
    }
    if (session.reviewOverlap) summary.overlap = session.reviewOverlap;
    if (slot !== null) {
      // A retry can leave an earlier tile in the same slot; the newest wins.
      summary.reviewers = summary.reviewers.filter((reviewer) => reviewer.position !== slot + 1);
      summary.reviewers.push(panelReviewer(slot + 1, session));
    }
  }
  return [...iterations.values()].map((summary) => {
    const reviewers = summary.reviewers.sort((a, b) => a.position - b.position);
    return { ...summary, reviewers, ...withDelta(reviewers) };
  });
}

function withDelta(reviewers: readonly PanelValueReviewer[]) {
  const delta = shareDelta(reviewers);
  return delta === undefined ? {} : { laterCacheReadShareDelta: delta };
}
