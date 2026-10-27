import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { act } from "react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";
import { build, session, validationRun } from "./pipeline-test-fixture";
import {
  graphNode,
  inspector,
  renderPipelineTab,
  restoreBuildChatTabMocks,
  selectNode,
} from "./build-chat-tab-test-support";

afterAll(restoreBuildChatTabMocks);
afterEach(() => {
  cleanup();
  useFlowGraphViewStore.setState({ views: new Map(), collapsed: new Set() });
});

const reviewing = () =>
  build({
    phase: "reviewing",
    reviewers: [
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt" },
    ],
    reviewFanout: {
      reviewers: [
        { id: "r1", agent: "claude", model: "opus", status: "failed", error: "Failed" },
        { id: "r2", agent: "codex", model: "gpt", status: "running" },
      ],
    },
  });

describe("pipeline inspector controls", () => {
  test.each(["cancelled", "interactive-request", "consolidated", "other-stage"])(
    "does not offer reviewer retry for %s",
    (reason) => {
      const pipeline = reviewing();
      if (reason === "cancelled") {
        pipeline.phase = "failed";
        pipeline.error = "Build cancelled by user";
      } else if (reason === "interactive-request") {
        pipeline.phase = "failed";
        pipeline.failureContext = { phase: "reviewing", kind: "interactive-request" };
      } else if (reason === "other-stage") {
        pipeline.phase = "failed";
        pipeline.failureContext = { phase: "verifying", kind: "stage-transition" };
      } else {
        pipeline.reviewFanout!.report = TEST_STRUCTURED_REVIEW_REPORT;
      }
      renderPipelineTab(pipeline);
      selectNode("Reviewer 1");
      expect(within(inspector()).queryByRole("button", { name: "Retry reviewer" }) === null).toBe(
        true,
      );
      fireEvent.contextMenu(graphNode("Reviewer 1"));
      expect(screen.queryByRole("menuitem", { name: "Retry reviewer" }) === null).toBe(true);
    },
  );

  test.each(["reviewing", "paused", "failed"] as const)(
    "offers retry for a failed reviewer in %s review",
    (phase) => {
      const pipeline = reviewing();
      pipeline.phase = phase;
      if (phase === "paused") pipeline.pausedFromPhase = "reviewing";
      if (phase === "failed")
        pipeline.failureContext = { phase: "reviewing", kind: "stage-transition" };
      renderPipelineTab(pipeline);
      selectNode("Reviewer 1");
      expect(
        within(inspector())
          .getByRole("button", { name: "Retry reviewer" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  test.each(["verifying", "creating-pr"] as const)(
    "a %s startup failure remains visible and retryable after a reviewer failure",
    (phase) => {
      renderPipelineTab(
        build({
          phase: "failed",
          error: "Could not launch the next stage",
          failureContext: { phase, kind: "stage-transition" },
          reviewers: reviewing().reviewers,
          sessions: [
            session("build", "build", 0),
            session("review", "rev-1", 60, {
              label: "Review 1",
              reviewerOutcome: "failed",
              error: "Historical reviewer failure",
            }),
            session("review", "rev-2", 60, { label: "Review 2", reviewerOutcome: "completed" }),
            session("review", "consolidation", 120, { label: "Consolidation" }),
            ...(phase === "creating-pr" ? [session("verify", "verify", 180)] : []),
          ],
        }),
      );
      selectNode(phase === "verifying" ? "Verify" : "Ship");
      expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Failed");
      expect(graphNode(phase === "verifying" ? "Verify" : "Ship").textContent).toContain(
        "Could not launch the next stage",
      );
      expect(
        within(inspector())
          .getByRole("button", { name: "Retry failed step" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  test("validation keeps Prepare running until terminal evidence arrives", () => {
    const pipeline = build({
      phase: "reviewing",
      sessions: [
        session("build", "build", 0),
        session("fix", "prep", 60, { label: "Package Preparation Session" }),
      ],
      validationRun: validationRun({ status: "running", completedAt: undefined }),
    });
    renderPipelineTab(pipeline, { isActive: true });
    selectNode("Prepare");
    expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Running");
    act(() =>
      useBuildPipelineStore.setState({
        pipelines: new Map([[pipeline.id, { ...pipeline, validationRun: validationRun() }]]),
      }),
    );
    expect(screen.getByTestId("pipeline-inspector-status").textContent).toBe("Complete");
  });
});

describe("pipeline zoom controls", () => {
  const largePanel = () => {
    const reviewers = Array.from({ length: 16 }, (_, index) => ({
      id: `r${index + 1}`,
      agent: "claude" as const,
      model: "opus",
      status: "running" as const,
    }));
    return build({
      phase: "reviewing",
      reviewers: reviewers.map(({ agent, model }) => ({ agent, model })),
      reviewFanout: { reviewers },
    });
  };

  test("offer Fit, which zooms the whole graph into view and back from 100%", () => {
    renderPipelineTab(largePanel());
    const controls = screen.getByRole("group", { name: "Zoom" });
    const level = screen.getByTestId("pipeline-zoom-level");
    expect(level.textContent).toBe("100%");
    fireEvent.click(within(controls).getByRole("button", { name: "Fit the whole pipeline" }));
    const fitted = Number.parseInt(level.textContent!, 10);
    expect(fitted).toBeLessThan(100);
    expect(fitted).toBeGreaterThanOrEqual(20);
    fireEvent.click(level);
    expect(level.textContent).toBe("100%");
  });
});
