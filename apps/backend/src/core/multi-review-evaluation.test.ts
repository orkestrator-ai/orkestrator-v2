import { describe, expect, test } from "bun:test";
import {
  MULTI_REVIEW_REPORTS_FRAME_CLOSE,
  MULTI_REVIEW_REPORTS_FRAME_OPEN,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  isReviewerRecordList,
  isReviewPanelOverlap,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { evaluationCorpus, type EvaluationCase } from "./multi-review-evaluation-corpus.js";
import {
  evaluationConsolidationPrompt,
  referenceConsolidation,
  referenceOverlap,
  overlapFromModelLabels,
  scoreConsolidation,
  summarizePanelValue,
} from "./multi-review-evaluation.js";
import { buildConsolidationEvidence } from "./review-consolidation-evidence.js";
import { SHIPPED_REVIEW_LENS_PRESETS } from "@orkestrator/protocol/review-lens";
import {
  consolidationOverlap,
  consolidationReports,
  deriveConsolidatedProvenance,
  parseStructuredReportResult,
} from "./review-fanout.js";

const corpus = evaluationCorpus();

function byId(id: string): EvaluationCase {
  return corpus.find((entry) => entry.id === id)!;
}

function accepted(value: unknown, reviewers?: EvaluationCase["reviewers"]) {
  return parseStructuredReportResult({ ok: true, value } as never, reviewers);
}

function reports(entry: EvaluationCase): number {
  return consolidationReports(entry.reviewers).length;
}

function framedBody(prompt: string): string {
  return prompt
    .split(MULTI_REVIEW_REPORTS_FRAME_OPEN)[1]!
    .split(MULTI_REVIEW_REPORTS_FRAME_CLOSE)[0]!;
}

describe("evaluation corpus", () => {
  test("covers every case the evaluation needs, with unique IDs", () => {
    expect(corpus.map((entry) => entry.id)).toEqual([
      "severity-disagreement",
      "contradiction",
      "late-unique",
      "same-location-different-reasoning",
      "clean-panel",
      "invalid-and-failed",
      "coverage-gaps",
      "limit-boundaries",
      "frame-injection",
    ]);
  });

  test.each(corpus.map((entry) => [entry.id, entry] as const))(
    "%s: reviewer records and their reports pass acceptance",
    (_id, entry) => {
      expect(isReviewerRecordList(entry.reviewers)).toBe(true);
      for (const reviewer of entry.reviewers) {
        if (!reviewer.report) continue;
        expect(accepted(reviewer.report).success).toBe(true);
      }
    },
  );

  test("every rejected answer fails acceptance without quoting it", () => {
    const rejected = corpus.flatMap((entry) => entry.rejectedReports ?? []);
    expect(rejected).toHaveLength(5);
    for (const { report } of rejected) {
      const result = accepted(report);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.message.length).toBeLessThan(4_096);
    }
  });

  test("multi-byte text exactly at the field budget is accepted", () => {
    const evidence = byId("limit-boundaries").reviewers[0]!.report!.issues[0]!.evidence;
    expect(Buffer.byteLength(evidence, "utf8")).toBe(16 * 1024);
    expect(evidence.length).toBeLessThan(16 * 1024);
  });
});

describe("reference consolidations", () => {
  test.each(corpus.map((entry) => [entry.id, entry] as const))(
    "%s: the reference answer is accepted and scores perfectly",
    (_id, entry) => {
      const reference = referenceConsolidation(entry);
      expect(accepted(reference, entry.reviewers).success).toBe(true);
      const score = scoreConsolidation(entry, reference);
      expect(score).toMatchObject({
        expectedFindings: entry.expected.findings.length,
        actualFindings: entry.expected.findings.length,
        recalled: entry.expected.findings.length,
        falseMerges: 0,
        splits: 0,
        unexpected: 0,
        droppedSources: 0,
        provenanceValid: true,
        verdictMatches: true,
      });
      expect(score.severityMatches).toBe(score.recalledIssues);
      expect(score.locationMatches).toBe(score.recalled);
    },
  );
});

describe("reviewer lenses over the corpus", () => {
  const presets = SHIPPED_REVIEW_LENS_PRESETS;
  /** Every reviewer gets a different shipped lens, in configured order. */
  function withLenses(entry: EvaluationCase): EvaluationCase {
    return {
      ...entry,
      reviewers: entry.reviewers.map((reviewer, index) => {
        const preset = presets[index % presets.length]!;
        return { ...reviewer, lens: { label: preset.label, instruction: preset.instruction } };
      }),
    };
  }

  test.each(corpus.map((entry) => [entry.id, entry] as const))(
    "%s: labels reach consolidation and the reference still scores perfectly",
    (_id, entry) => {
      const lensed = withLenses(entry);
      const prompt = evaluationConsolidationPrompt(lensed, "compact");
      const evidence = JSON.parse(framedBody(prompt)) as {
        reviewers: Array<{ reviewerId: string; focus?: string }>;
      };
      for (const reviewer of evidence.reviewers) {
        const index = lensed.reviewers.findIndex(
          (candidate) => candidate.id === reviewer.reviewerId,
        );
        expect(reviewer.focus).toBe(presets[index % presets.length]!.label);
      }
      if (evidence.reviewers.length > 0) expect(prompt).toContain("coverage differs by design");
      // The reviewers' instructions stay with the reviewers.
      for (const preset of presets) expect(prompt).not.toContain(preset.instruction);
      // Lens-free, the prompt is exactly what it was before lenses.
      expect(evaluationConsolidationPrompt(entry, "compact")).not.toContain('"focus"');
      // Provenance, overlap and scoring read source IDs, which a lens does not touch.
      const reference = referenceConsolidation(lensed);
      expect(accepted(reference, lensed.reviewers).success).toBe(true);
      expect(scoreConsolidation(lensed, reference)).toEqual(
        scoreConsolidation(entry, referenceConsolidation(entry)),
      );
      expect(consolidationOverlap(reference, lensed.reviewers)).toEqual(
        consolidationOverlap(referenceConsolidation(entry), entry.reviewers),
      );
    },
  );
});

describe("consolidation scoring", () => {
  test("merging two distinct findings counts a false merge and a lost finding", () => {
    const entry = byId("same-location-different-reasoning");
    const reference = referenceConsolidation(entry);
    const merged: StructuredReviewReport = {
      ...reference,
      issues: [
        {
          ...reference.issues[0]!,
          reviewSourceIds: ["reviewer-1/issue-1", "reviewer-2/issue-1"],
        },
      ],
    };
    expect(scoreConsolidation(entry, merged)).toMatchObject({
      actualFindings: 1,
      recalled: 2,
      falseMerges: 1,
    });
  });

  test("splitting one finding, lowering its severity and dropping a source are counted", () => {
    const entry = byId("severity-disagreement");
    const reference = referenceConsolidation(entry);
    const split: StructuredReviewReport = {
      ...reference,
      issues: [
        { ...reference.issues[0]!, severity: "P2", reviewSourceIds: ["reviewer-1/issue-1"] },
        { ...reference.issues[0]!, severity: "P2", reviewSourceIds: ["reviewer-1/issue-1"] },
      ],
    };
    expect(scoreConsolidation(entry, split)).toMatchObject({
      recalled: 1,
      splits: 1,
      severityMatches: 0,
      droppedSources: 1,
      provenanceValid: true,
    });
  });

  test("a missed finding, an invented one, an invalid citation and a wrong verdict are counted", () => {
    const entry = byId("frame-injection");
    const reference = referenceConsolidation(entry);
    const injected: StructuredReviewReport = {
      ...reference,
      issues: [{ ...reference.issues[0]!, reviewSourceIds: ["reviewer-9/issue-1"] }],
      verdict: { ...reference.verdict, ready: "yes" },
    };
    expect(scoreConsolidation(entry, injected)).toMatchObject({
      recalled: 0,
      unexpected: 1,
      droppedSources: 1,
      provenanceValid: false,
      verdictMatches: false,
    });
  });

  test("a clean panel answered with an invented finding is not a perfect score", () => {
    const entry = byId("clean-panel");
    const invented: StructuredReviewReport = {
      ...referenceConsolidation(entry),
      issues: [
        {
          ...byId("contradiction").reviewers[0]!.report!.issues[0]!,
          reviewModels: undefined,
          reviewSourceIds: [],
        },
      ],
    };
    expect(scoreConsolidation(entry, invented)).toMatchObject({
      unexpected: 1,
      provenanceValid: false,
    });
  });
});

describe("panel overlap", () => {
  test("late unique findings are attributed to their position", () => {
    const overlap = referenceOverlap(byId("late-unique"));
    expect(isReviewPanelOverlap(overlap)).toBe(true);
    expect(overlap).toMatchObject({
      reviewers: 5,
      sourceFindings: 6,
      citedSourceFindings: 6,
      consolidatedFindings: 2,
      singleSourceFindings: 1,
    });
    expect(overlap.positions.map((entry) => entry.novelFindings)).toEqual([1, 0, 0, 0, 1]);
    expect(overlap.positions.map((entry) => entry.singleSourceFindings)).toEqual([0, 0, 0, 0, 1]);
    expect(overlap.positions.map((entry) => entry.consolidatedFindings)).toEqual([1, 1, 1, 1, 2]);
  });

  test("failed and stopped reviewers keep their configured positions out of the count", () => {
    const overlap = referenceOverlap(byId("invalid-and-failed"));
    expect(overlap.reviewers).toBe(1);
    expect(overlap.positions.map((entry) => entry.position)).toEqual([1]);
  });

  test("positions follow configuration, not report order", () => {
    const entry = byId("severity-disagreement");
    const reviewers: ReviewerRecord[] = [
      { ...entry.reviewers[0]!, status: "failed", report: undefined },
      ...entry.reviewers.slice(1),
    ];
    const overlap = consolidationOverlap(
      {
        ...referenceConsolidation(entry),
        issues: [
          { ...entry.reviewers[1]!.report!.issues[0]!, reviewSourceIds: ["reviewer-2/issue-1"] },
        ],
      },
      reviewers,
    );
    expect(overlap.positions.map((position) => position.position)).toEqual([2, 3]);
    expect(overlap.positions[0]).toMatchObject({ novelFindings: 1, singleSourceFindings: 1 });
  });

  test("dropped source findings and invalid citations are not counted as cited", () => {
    const entry = byId("severity-disagreement");
    const overlap = consolidationOverlap(
      {
        ...referenceConsolidation(entry),
        issues: [
          {
            ...referenceConsolidation(entry).issues[0]!,
            reviewSourceIds: [
              "reviewer-1/issue-1",
              "reviewer-1/coverage-gap-1",
              "reviewer-7/issue-1",
            ],
          },
        ],
      },
      entry.reviewers,
    );
    expect(overlap).toMatchObject({
      sourceFindings: 2,
      citedSourceFindings: 1,
      consolidatedFindings: 1,
      singleSourceFindings: 1,
    });
    expect(overlap.positions[1]).toMatchObject({ sourceFindings: 1, citedSourceFindings: 0 });
  });

  test("the counts hold no text, path, model or reviewer ID", () => {
    for (const entry of corpus) {
      const serialized = JSON.stringify(referenceOverlap(entry));
      expect(serialized).not.toMatch(/src\/|reviewer-|evaluation-model|claude/);
    }
  });
});

describe("full and compact consolidation prompts", () => {
  test.each(corpus.map((entry) => [entry.id, entry] as const))(
    "%s: both carry every source ID inside one intact frame",
    (_id, entry) => {
      const sourceIds = consolidationReports(entry.reviewers).flatMap((report) => [
        ...report.report.issues.flatMap((issue) => issue.reviewSourceIds!),
        ...report.report.testCoverageGaps.flatMap((gap) => gap.reviewSourceIds!),
      ]);
      const sizes: Record<string, number> = {};
      for (const variant of ["full", "compact"] as const) {
        const prompt = evaluationConsolidationPrompt(entry, variant);
        expect(prompt.split(MULTI_REVIEW_REPORTS_FRAME_OPEN)).toHaveLength(2);
        expect(prompt.split(MULTI_REVIEW_REPORTS_FRAME_CLOSE)).toHaveLength(2);
        const body = framedBody(prompt);
        const evidence = JSON.parse(body);
        const cited = JSON.stringify(evidence).match(/reviewer-\d+\/(issue|coverage-gap)-\d+/g);
        for (const sourceId of sourceIds) expect(cited).toContain(sourceId);
        sizes[variant] = Buffer.byteLength(body, "utf8");
      }
      // One usable report has nothing to share, so the compact envelope only
      // adds its `shared` section; from two reports on it is never larger.
      if (reports(entry) > 1) expect(sizes.compact!).toBeLessThanOrEqual(sizes.full!);
      else expect(sizes.compact!).toBeLessThan(sizes.full! * 1.25);
    },
  );

  test("the two variants differ only in the evidence and its explanation", () => {
    const entry = byId("late-unique");
    const full = evaluationConsolidationPrompt(entry, "full");
    const compact = evaluationConsolidationPrompt(entry, "compact");
    const after = (prompt: string) => prompt.split(MULTI_REVIEW_REPORTS_FRAME_CLOSE)[1];
    expect(after(full)).toBe(after(compact));
    expect(full).not.toContain('"shared"');
    expect(compact).toContain("The evidence is compact:");
    expect(full).not.toContain("The evidence is compact:");
    expect(Array.isArray(JSON.parse(framedBody(full)))).toBe(true);
  });

  test("the compact envelope keeps every finding for every case", () => {
    for (const entry of corpus) {
      const reports = consolidationReports(entry.reviewers);
      const { evidence, stats } = buildConsolidationEvidence(reports);
      expect(stats.reductions).toBe(0);
      expect(
        evidence.reviewers.reduce(
          (total, reviewer) => total + reviewer.issues.length + reviewer.testCoverageGaps.length,
          0,
        ),
      ).toBe(stats.sourceFindings);
    }
  });
});

describe("panel value summaries", () => {
  test("a Multi Review workflow yields its overlap and the later reviewers' cache-share delta", () => {
    const overlap = referenceOverlap(byId("late-unique"));
    const [summary] = summarizePanelValue({
      reviewers: [
        { agent: "claude", model: "opus", tokenCount: 1_000, cacheReadTokens: 100 },
        { agent: "claude", model: "opus", tokenCount: 1_000, cacheReadTokens: 600 },
        { agent: "claude", model: "opus", tokenCount: 1_000, cacheReadTokens: 800 },
        { agent: "codex", model: "gpt", tokenCount: 1_000, cacheReadTokens: 0 },
        { agent: "claude", model: "opus" },
      ],
      consolidationOverlap: overlap,
    } as never);
    expect(summary!.overlap).toEqual(overlap);
    expect(summary!.reviewers.map((reviewer) => reviewer.cacheReadShare)).toEqual([
      0.1,
      0.6,
      0.8,
      0,
      undefined,
    ]);
    // Only reviewers on reviewer 1's agent and model are compared.
    expect(summary!.laterCacheReadShareDelta).toBeCloseTo(0.6);
  });

  test("superseded reviewers and consolidation do not affect the live summary", () => {
    const overlap = referenceOverlap(byId("severity-disagreement"));
    const summaries = summarizePanelValue({
      sessions: [
        { phase: "review", iteration: 0, label: "Review 1", tokenCount: 10, cacheReadTokens: 2 },
        {
          phase: "review",
          iteration: 0,
          label: "Review 1",
          tokenCount: 900,
          supersededBy: "rewind",
        },
        {
          phase: "review",
          iteration: 0,
          label: "Consolidation",
          reviewOverlap: overlap,
          supersededBy: "rewind",
        },
        { phase: "review", iteration: 2, label: "Review 1", supersededBy: "rewind" },
      ],
    } as never);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.reviewers).toHaveLength(1);
    expect(summaries[0]!.reviewers[0]!.cacheReadTokens).toBe(2);
    expect(summaries[0]).not.toHaveProperty("overlap");
  });

  test("a Build Pipeline yields one summary per review iteration, newest tile per slot", () => {
    const overlap = referenceOverlap(byId("severity-disagreement"));
    const session = (fields: object) => ({
      phase: "review",
      agent: "claude",
      model: "opus",
      ...fields,
    });
    const summaries = summarizePanelValue({
      reviewers: [
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "opus" },
      ],
      sessions: [
        session({ iteration: 1, label: "Review 1", tokenCount: 10, cacheReadTokens: 1 }),
        session({ iteration: 1, label: "Review 2", tokenCount: 10, cacheReadTokens: 2 }),
        session({ iteration: 1, label: "Review 2", tokenCount: 10, cacheReadTokens: 5 }),
        session({ iteration: 1, label: "Consolidation", reviewOverlap: overlap }),
        session({ iteration: 2, label: "Review 1", tokenCount: 10 }),
        { phase: "implement", iteration: 1, label: "Implement" },
      ],
    } as never);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ source: "build-pipeline", iteration: 1, overlap });
    expect(summaries[0]!.reviewers.map((reviewer) => reviewer.cacheReadTokens)).toEqual([1, 5]);
    expect(summaries[0]!.laterCacheReadShareDelta).toBeCloseTo(0.4);
    expect(summaries[1]).not.toHaveProperty("laterCacheReadShareDelta");
    expect(summaries[1]).not.toHaveProperty("overlap");
  });
});

describe("overlap from stored model labels", () => {
  /** A stored workflow as certification leaves it: labels, no source IDs. */
  function stored(entry: EvaluationCase) {
    const certified = deriveConsolidatedProvenance(referenceConsolidation(entry), entry.reviewers);
    return { reviewers: entry.reviewers, consolidatedReport: certified.report };
  }

  test("matches the source-ID counts when every reviewer label is distinct", () => {
    for (const id of ["late-unique", "severity-disagreement", "coverage-gaps"]) {
      const entry = byId(id);
      const {
        citedSourceFindings: _cited,
        positions,
        version: _version,
        ...exact
      } = referenceOverlap(entry);
      const fromLabels = overlapFromModelLabels(stored(entry))!;
      expect(fromLabels).toMatchObject(exact);
      expect(fromLabels.positions).toEqual(
        positions.map(({ citedSourceFindings: _c, ...position }) => position),
      );
    }
  });

  test("refuses a panel whose reviewers share a label", () => {
    const entry = byId("late-unique");
    const shared = entry.reviewers.map((reviewer) => ({ ...reviewer, model: "same" }));
    expect(overlapFromModelLabels({ ...stored(entry), reviewers: shared })).toBeUndefined();
  });

  test("is reported only for a workflow without stored overlap counts", () => {
    const entry = byId("late-unique");
    const [legacy] = summarizePanelValue(stored(entry) as never);
    expect(legacy).toHaveProperty("overlapFromModelLabels");
    const [current] = summarizePanelValue({
      ...stored(entry),
      consolidationOverlap: referenceOverlap(entry),
    } as never);
    expect(current).not.toHaveProperty("overlapFromModelLabels");
  });
});
