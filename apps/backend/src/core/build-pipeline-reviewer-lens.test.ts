import { describe, expect, test } from "bun:test";
import {
  BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE,
  BUILD_STEP_INSTRUCTIONS_FRAME_OPEN,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import {
  REVIEW_LENS_FRAME_OPEN,
  reviewLensSection,
  type ReviewLens,
} from "@orkestrator/protocol/review-lens";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { pipeline, startInput, withService } from "./build-pipeline-service-test-support.js";
import {
  advanceUntil,
  reportFor,
  startInput as fanoutStartInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";
import { reviewerPanelSection } from "./multi-review-prompts.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";

/**
 * Reviewer lenses in the Build Pipeline: each panel reviewer's focus is stored
 * on its row, copied onto its fan-out record and rendered after its panel
 * position and before its own instructions; the single-reviewer stage renders
 * the review step's lens before the step's instructions.
 */

const SECURITY: ReviewLens = {
  label: "Security",
  instruction: "LENS-SECURITY: trace untrusted input to its sinks.",
};
const TESTS: ReviewLens = {
  label: "Tests and coverage",
  instruction: "LENS-TESTS: name the missing cases.",
};

function framed(text: string): string {
  return `${BUILD_STEP_INSTRUCTIONS_FRAME_OPEN}\n${text}\n${BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE}`;
}

describe("the review panel's lenses", () => {
  test("each reviewer renders its lens after its position and before its instructions", async () => {
    await withPipeline(async ({ service, createService, provider, read }) => {
      const started = await service.start({
        ...fanoutStartInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
        reviewers: [
          {
            agent: "claude",
            model: "opus",
            lens: { label: ` ${SECURITY.label} `, instruction: `${SECURITY.instruction}\n` },
            instructions: "REVIEWER-1-RULES",
          },
          { agent: "claude", model: "sonnet" },
        ],
      });
      // Stored trimmed on the row the fan-out reads.
      expect(started.reviewers?.[0]?.lens).toEqual(SECURITY);
      expect(started.reviewers?.[1]).not.toHaveProperty("lens");
      // A fresh service is the backend after a restart: it reads the record.
      const restarted = createService();
      try {
        const addressing = await advanceUntil(restarted, read, started.id, "addressing");
        expect(addressing.phase).toBe("addressing");
      } finally {
        await restarted.shutdown();
      }
      const openings = new Map<string, string>();
      for (const entry of provider.sent) {
        if (!openings.has(entry.sessionId)) openings.set(entry.sessionId, entry.prompt);
      }
      const bySession = (prefix: string) =>
        [...openings].filter(([id]) => id.startsWith(prefix)).map(([, prompt]) => prompt);
      const [one] = bySession("review-1-");
      const [two] = bySession("review-2-");
      expect(one).toContain(
        `${reviewerPanelSection(1, 2)}\n\n${reviewLensSection(SECURITY)}\n\n**Additional instructions`,
      );
      expect(one!.trimEnd().endsWith(framed("REVIEWER-1-RULES"))).toBe(true);
      expect(two).not.toContain(REVIEW_LENS_FRAME_OPEN);
      // Everything before the panel position is shared, byte for byte.
      expect(one!.slice(0, one!.indexOf(reviewerPanelSection(1, 2)))).toBe(
        two!.slice(0, two!.indexOf(reviewerPanelSection(2, 2))),
      );
      // The consolidator sees the label, not the instruction.
      const [consolidation] = bySession("review-·-consolidation-");
      expect(consolidation).toContain('"focus":"Security"');
      expect(consolidation).not.toContain("LENS-SECURITY");
    });
  });

  test("a retried reviewer keeps its lens", async () => {
    await withPipeline(async ({ service, read, provider }) => {
      provider.failingModels.add("sonnet");
      provider.runningModels.add("opus");
      const started = await service.start({
        ...fanoutStartInput(),
        reviewers: [
          { agent: "claude", model: "opus", lens: SECURITY },
          { agent: "claude", model: "sonnet", lens: TESTS },
        ],
      });
      await advanceUntil(service, read, started.id, "reviewing");
      let reviewing = await read(started.id);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (reviewing.reviewFanout?.reviewers[1]?.status === "failed") break;
        await service.advanceNow(started.id);
        reviewing = await read(started.id);
      }
      expect(reviewing.reviewFanout!.reviewers.map((reviewer) => reviewer.lens)).toEqual([
        SECURITY,
        TESTS,
      ]);
      const failed = reviewing.reviewFanout!.reviewers[1]!;
      expect(failed.status).toBe("failed");
      const sentBefore = provider.sent.length;
      provider.failingModels.delete("sonnet");
      const retried = await service.retryReviewer(started.id, failed.id);
      expect(retried.reviewFanout!.reviewers[1]!.lens).toEqual(TESTS);
      provider.runningModels.delete("opus");
      await advanceUntil(service, read, started.id, "addressing", 20);
      const retriedPrompts = provider.sent
        .slice(sentBefore)
        .map((entry) => entry.prompt)
        .filter((prompt) => prompt.includes(reviewerPanelSection(2, 2)));
      expect(retriedPrompts.length).toBeGreaterThan(0);
      expect(retriedPrompts[0]!.endsWith(reviewLensSection(TESTS))).toBe(true);
    });
  });
});

describe("the single reviewer's lens", () => {
  test("renders before the review step's instructions, and other steps drop a lens", async () => {
    await withService(async (service, storage, provider) => {
      provider.structured = async <T>(
        sessionId: string,
        requestId: string,
      ): Promise<StructuredOutputResult<T>> => {
        const phase = provider.phases.get(sessionId);
        const value =
          phase === "review"
            ? reportFor("One finding.", "Inverted branch")
            : TEST_REVIEW_PREPARATION;
        return { ok: true, provider: "claude", requestId, value: value as T };
      };
      const started = await service.start(
        startInput({
          steps: {
            review: { agent: "claude", lens: SECURITY, instructions: "REVIEW-RULES" },
            address: { agent: "claude", lens: TESTS },
          },
        }),
      );
      expect(started.steps?.review?.lens).toEqual(SECURITY);
      expect(started.steps?.address).toEqual({ agent: "claude" });
      for (let pass = 0; pass < 40; pass += 1) {
        const snapshot = await pipeline(storage, started.id);
        if (snapshot.phase === "addressing" || snapshot.phase === "failed") break;
        await service.advanceNow(started.id);
      }
      const review = provider.sent.find(
        (entry) => provider.phases.get(entry.sessionId) === "review",
      );
      expect(review).toBeDefined();
      const lensAt = review!.prompt.indexOf(reviewLensSection(SECURITY));
      expect(lensAt).toBeGreaterThan(0);
      expect(lensAt).toBeLessThan(review!.prompt.indexOf(framed("REVIEW-RULES")));
      for (const entry of provider.sent) {
        if (provider.phases.get(entry.sessionId) !== "review") {
          expect(entry.prompt).not.toContain(REVIEW_LENS_FRAME_OPEN);
        }
      }
    });
  });
});
