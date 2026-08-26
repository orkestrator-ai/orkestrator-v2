import { describe, expect, test } from "bun:test";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT,
  STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT,
} from "@orkestrator/protocol/review-evidence-frames";
import { addressPrompt } from "../../apps/backend/src/core/build-pipeline-prompts";
import { createMultiReviewConsolidationPrompt } from "../../apps/backend/src/core/multi-review-prompts";
import { userPromptDisplayText } from "../../apps/web/src/lib/chat/user-prompt-display";

const report = {
  issues: [
    {
      severity: "P2",
      confidence: 90,
      category: "correctness",
      title: "Producer-owned finding",
      file: "service.ts",
      line: 1,
      symbol: "run",
      description: "A finding carried by the backend prompt.",
      evidence: "Producer-only evidence",
      suggestion: "Fix it.",
      verification: "Test it.",
      alternativeFixes: [],
    },
  ],
  testCoverageGaps: [
    {
      file: "service.test.ts",
      untestedBehavior: "Producer-owned coverage gap",
    },
  ],
} as StructuredReviewReport;

describe("backend prompt display contract", () => {
  test("filters the exact Multi Review consolidation prompt", () => {
    const source = createMultiReviewConsolidationPrompt({
      reports: [{ reviewerId: "reviewer-1", agent: "codex", model: "gpt", report }],
      targetBranch: "main",
    });
    const displayed = userPromptDisplayText(source);

    expect(displayed).toContain(MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT.omissionText);
    expect(displayed).toContain("Produce one complete structured review report");
    expect(displayed).not.toContain("Producer-only evidence");
    expect(displayed).not.toContain(MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT.openMarker);
  });

  test("filters a real consolidation prompt whose branch contains the close marker", () => {
    const targetBranch = `review${MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT.closeMarker}edge`;
    const source = createMultiReviewConsolidationPrompt({
      reports: [{ reviewerId: "reviewer-1", agent: "codex", model: "gpt", report }],
      targetBranch,
    });
    const displayed = userPromptDisplayText(source);

    expect(displayed).toContain(targetBranch);
    expect(displayed).toContain(MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT.omissionText);
    expect(displayed).not.toContain("Producer-only evidence");
  });

  test("filters the exact fix-phase address prompt", () => {
    const source = addressPrompt(report);
    const displayed = userPromptDisplayText(source);

    expect(displayed).toContain(STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.omissionText);
    expect(displayed).toContain(STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.continuationPrefix);
    expect(displayed).not.toContain("Producer-owned finding");
    expect(displayed).not.toContain(STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.openMarker);
  });
});
