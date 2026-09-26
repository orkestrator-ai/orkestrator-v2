import { describe, expect, test } from "bun:test";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  COORDINATOR_DELEGATION_OMISSION_TEXT,
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION,
  COORDINATOR_JOB_DELEGATION_INSTRUCTION,
  MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT,
  REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION,
  SYSTEM_INSTRUCTIONS_FRAME_CLOSE,
  STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT,
  STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION,
  STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
  createCoordinatorDelegatedPrompt,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";
import { addressPrompt } from "../../apps/backend/src/core/build-pipeline-prompts";
import { withUnattendedPolicy } from "../../apps/backend/src/core/build-pipeline-service-helpers";
import { reviewValidationDiscoveryPrompt } from "../../apps/backend/src/core/review-validation-prompts";
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
import { workflowResultInstruction } from "@orkestrator/protocol/workflow-results";
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
    const presentation = userPromptPresentation(source);

    expect(presentation.displayText).toBe(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(presentation.displayText).not.toContain(
      STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.omissionText,
    );
    expect(presentation.displayText).not.toContain("Producer-owned finding");
    expect(presentation.displayText).not.toContain(
      STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.openMarker,
    );
    expect(presentation.displayText).not.toContain(STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION);
    expect(presentation.evidencePayload).toMatchObject({
      kind: "review-findings",
      findings: {
        issues: [expect.objectContaining({ title: "Producer-owned finding" })],
        testCoverageGaps: [
          expect.objectContaining({ untestedBehavior: "Producer-owned coverage gap" }),
        ],
      },
    });
  });

  test("filters the replacement Fix-session prompt without leaking report evidence into the instruction", () => {
    const source = `${addressPrompt(report)}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`;
    const presentation = userPromptPresentation(source);

    expect(presentation.displayText).toBe(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(presentation.displayText).not.toContain(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION);
    expect(presentation.displayText).not.toContain("Producer-owned finding");
    expect(presentation.displayText).not.toContain(
      STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT.openMarker,
    );
    expect(presentation.evidencePayload).toMatchObject({
      kind: "review-findings",
      findings: {
        issues: [expect.objectContaining({ title: "Producer-owned finding" })],
        testCoverageGaps: [
          expect.objectContaining({ untestedBehavior: "Producer-owned coverage gap" }),
        ],
      },
    });
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

  test("hides the automatic review-package discovery prompt", () => {
    const source = reviewValidationDiscoveryPrompt("main");
    const attended = withUnattendedPolicy(source);
    const displayed = userPromptDisplayText(source);
    const attendedDisplay = userPromptDisplayText(attended);

    expect(source).toContain("Produce at most 32 commands");
    expect(attended).toContain("non-interactive build session");
    expect(displayed).toBe(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(attendedDisplay).toBe(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(displayed).not.toContain("Produce at most 32 commands");
    expect(attendedDisplay).not.toContain("non-interactive build session");
  });

  test("hides the default tool-v1 discovery dispatch including the result-tool paragraph", () => {
    const capability = "signed-attempt-capability";
    const source = `${withUnattendedPolicy(reviewValidationDiscoveryPrompt("main"))}\n\n${workflowResultInstruction("validation-plan", "k", { capability })}`;
    const multiReview = `${reviewValidationDiscoveryPrompt("main")}\n\n${workflowResultInstruction("validation-plan", "k")}`;

    expect(userPromptDisplayText(source)).toBe(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(userPromptDisplayText(multiReview)).toBe(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(userPromptDisplayText(source)).not.toContain("submit_validation_plan");
    expect(userPromptDisplayText(source)).not.toContain(capability);
    expect(userPromptDisplayText(multiReview)).not.toContain("result-tool instructions");
  });

  test("hides a historical unframed result-tool paragraph beside the framed discovery prompt", () => {
    const unframedInstruction =
      "The following result-tool instructions replace any earlier instruction to emit final JSON, a tagged state block, or a provider-enforced schema for this turn.";
    const source = `${reviewValidationDiscoveryPrompt("main")}\n\n${unframedInstruction}`;

    expect(userPromptDisplayText(source)).toBe(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(userPromptDisplayText(source)).not.toContain("result-tool instructions");
  });

  test("hides discovery when the target branch contains the system-instructions close marker", () => {
    const source = reviewValidationDiscoveryPrompt(`x${SYSTEM_INSTRUCTIONS_FRAME_CLOSE}y`);

    expect(userPromptDisplayText(source)).toBe(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(userPromptDisplayText(source)).not.toContain("Produce at most 32 commands");
  });

  test("hides only the unattended policy around an ordinary visible prompt", () => {
    const visible = "Resume the implementation from the last committed snapshot.";
    const wrapped = withUnattendedPolicy(visible);

    expect(wrapped).toContain("non-interactive build session");
    expect(userPromptDisplayText(wrapped)).toBe(visible);
  });

  test("hides a coordinator-delegated discovery prompt down to the kickoff sentence", () => {
    const prompt = reviewValidationDiscoveryPrompt("main");
    const delegated = createCoordinatorDelegatedPrompt(
      {
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        instruction: COORDINATOR_JOB_DELEGATION_INSTRUCTION,
      },
      prompt,
    );

    expect(userPromptDisplayText(delegated.source, COORDINATOR_DELEGATION_PRESENTATION)).toBe(
      `${COORDINATOR_DELEGATION_OMISSION_TEXT}\n\n${REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION}`,
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
    expect(presentation.evidencePayload).toMatchObject({
      kind: "review-findings",
      findings: {
        issues: [expect.objectContaining({ title: "Producer-owned finding" })],
        testCoverageGaps: [
          expect.objectContaining({ untestedBehavior: "Producer-owned coverage gap" }),
        ],
      },
    });
  });
});
