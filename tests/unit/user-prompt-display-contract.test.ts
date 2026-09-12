import { describe, expect, test } from "bun:test";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  COORDINATOR_DELEGATION_OMISSION_TEXT,
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION,
  COORDINATOR_JOB_DELEGATION_INSTRUCTION,
  MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT,
  STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT,
  STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION,
  STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
  createCoordinatorDelegatedPrompt,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";
import { addressPrompt } from "../../apps/backend/src/core/build-pipeline-prompts";
import {
  buildReviewHandoffPrompt,
  prependReviewHandoff,
} from "../../apps/backend/src/core/build-pipeline-handoff";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION } from "@orkestrator/protocol/multi-review";
import { createMultiReviewConsolidationPrompt } from "../../apps/backend/src/core/multi-review-prompts";
import { TEST_STRUCTURED_REVIEW_REPORT } from "../../apps/web/src/components/build-pipeline/structured-review-test-fixture";
import {
  userPromptDisplayText,
  userPromptPresentation,
} from "../../apps/web/src/lib/chat/user-prompt-display";
import { multiReviewCustomFixPrompt } from "../../apps/web/src/lib/review-actions";

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
  test("filters both coordinator delegation producer variants only with trusted provenance", () => {
    const prompt = "Implement the requested behavior.";
    const variants = [
      createCoordinatorDelegatedPrompt(
        {
          projectId: "project-1",
          coordinatorId: "coordinator-1",
          conversationId: "conversation-1",
          instruction: COORDINATOR_JOB_DELEGATION_INSTRUCTION,
        },
        prompt,
      ),
      createCoordinatorDelegatedPrompt(
        {
          projectId: "project-1",
          coordinatorId: "coordinator-1",
          conversationId: "conversation-1",
          baseBranch: "main",
          baseCommit: "0123456789abcdef0123456789abcdef01234567",
          instruction: COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION,
        },
        prompt,
      ),
    ];

    for (const variant of variants) {
      expect(userPromptDisplayText(variant.source)).toBe(variant.source);
      expect(userPromptDisplayText(variant.source, COORDINATOR_DELEGATION_PRESENTATION)).toBe(
        `${COORDINATOR_DELEGATION_OMISSION_TEXT}\n\n${prompt}`,
      );
    }
  });

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

    expect(displayed).toBe(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(displayed).not.toContain(STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.omissionText);
    expect(displayed).not.toContain("Producer-owned finding");
    expect(displayed).not.toContain(STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.openMarker);
    expect(displayed).not.toContain(STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION);
  });

  test("filters the replacement Fix-session prompt without leaking report evidence", () => {
    const source = `${addressPrompt(report)}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`;
    const presentation = userPromptPresentation(source);

    expect(presentation.evidencePayload).toBeNull();
    expect(presentation.displayText).toBe(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(presentation.displayText).not.toContain(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION);
    expect(presentation.displayText).not.toContain("Producer-owned finding");
    expect(presentation.displayText).not.toContain(
      STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.openMarker,
    );
  });

  test("renders evidence from the exact custom-fix prompt producer", () => {
    const source = multiReviewCustomFixPrompt(
      TEST_STRUCTURED_REVIEW_REPORT,
      "Preserve the public API.",
    );
    const presentation = userPromptPresentation(source);

    expect(presentation.displayText).toContain("Preserve the public API.");
    expect(presentation.displayText).not.toContain(
      STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.omissionText,
    );
    expect(presentation.evidencePayload?.kind).toBe("structured-review");
    expect(presentation.evidencePayload?.source).toBe(
      JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT, null, 2),
    );
  });

  test("hides the injected review handoff and keeps only the address instruction", () => {
    const session: PipelineSession = {
      phase: "review",
      agent: "codex",
      iteration: 0,
      sessionKey: "pipeline:review:0:session-key",
      sdkSessionId: "review-session",
      status: "idle",
      startedAt: "2026-08-07T10:00:00.000Z",
      label: "Review Session",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Review the range boundary.",
          createdAt: "2026-08-07T10:01:00.000Z",
        },
      ],
    };
    const handoff = buildReviewHandoffPrompt({
      environmentId: "env-1",
      sourceAgent: "codex",
      destinationAgent: "claude",
      sourceSession: session,
    });
    const source = prependReviewHandoff(handoff, addressPrompt(report));
    const presentation = userPromptPresentation(source);

    expect(presentation.displayText).toBe(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(presentation.displayText).not.toContain("Review the range boundary.");
    expect(presentation.displayText).not.toContain("orkestrator-handoff");
    expect(presentation.evidencePayload).toBeNull();
  });
});
