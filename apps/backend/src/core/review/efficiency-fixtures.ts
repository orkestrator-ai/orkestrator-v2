/**
 * Synthetic, content-free fixtures for Multi Review efficiency tests and the
 * control-plane benchmark. Field lengths and list sizes are representative of
 * real reports; the text is filler.
 */
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

const REVIEW_HEAD = "1".repeat(40);

/** Synthetic report whose field sizes, not content, match a real review. */
export function syntheticReport(issueCount: number, reviewerSalt: number): StructuredReviewReport {
  const text = (label: string, bytes: number) => `${label} ${"x".repeat(Math.max(0, bytes))}`;
  const files = Array.from({ length: 40 }, (_, index) => `src/module-${index}/file-${index}.ts`);
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef: "origin/main...HEAD",
      commit: { sha: REVIEW_HEAD, subject: "Synthetic change" },
      filesReviewed: files,
      filesSkipped: [{ file: "package-lock.json", reason: text("generated", 40) }],
      filesLeftUncommitted: [],
      commandsRun: [
        { command: "bun test ./src", result: "passed", summary: text("tests", 120) },
        { command: "bun run typecheck", result: "passed", summary: text("types", 80) },
      ],
      commandsNotRun: [{ command: "mise run test:browser", reason: text("browser", 60) }],
      limitations: [text("shared-limitation", 120), text(`reviewer-${reviewerSalt}`, 60)],
    },
    whatChanged: {
      overview: text("overview", 600),
      before: text("before", 400),
      after: text("after", 400),
      keyCodeChanges: files
        .slice(0, 6)
        .map((file, index) => ({ file, line: index + 1, description: text("change", 160) })),
      userImpact: text("impact", 300),
    },
    riskProfile: {
      changeTypes: ["feature", "refactor"],
      riskAreas: ["concurrency", "persistence"],
      overallRisk: "medium",
      reasoning: text("risk", 300),
    },
    testResults: { total: 120, passed: 118, failed: 0, notRun: 2, failures: [] },
    strengths: Array.from({ length: 3 }, (_, index) => ({
      description: text("strength", 200),
      file: files[index]!,
      line: index + 10,
    })),
    issues: Array.from({ length: issueCount }, (_, index) => ({
      severity: index === 0 ? ("P1" as const) : ("P2" as const),
      confidence: 80 + (index % 20),
      category: "correctness" as const,
      title: `Synthetic issue ${reviewerSalt}-${index}`,
      file: files[index % files.length]!,
      line: 10 + index,
      symbol: `symbol${index}`,
      description: text("description", 300),
      evidence: text("evidence", 600),
      suggestion: text("suggestion", 250),
      verification: text("verification", 120),
    })),
    testCoverageGaps: [{ file: files[1]!, untestedBehavior: text("gap", 200) }],
    verdict: { ready: "with-fixes", reasoning: text("verdict", 200) },
    summaryOfChange: text("summary", 900),
    reviewSummary: text("review", 500),
  };
}
