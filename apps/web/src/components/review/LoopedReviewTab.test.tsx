import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { LoopedReviewTab } from "./LoopedReviewTab";
import {
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";

const data = {
  environmentId: "env-review",
  workflowId: "workflow-review",
  isLocal: true,
};

function seedWorkflow(
  updates: Partial<LoopedReviewWorkflow>,
): LoopedReviewWorkflow {
  const id = useLoopedReviewStore.getState().createWorkflow({
    environmentId: data.environmentId,
    projectId: "project-1",
    agent: "codex",
    model: "codex-model",
    targetBranch: "main",
    allowance: 6,
  });
  const created = useLoopedReviewStore.getState().workflows.get(id)!;
  const workflow = { ...created, ...updates, id: data.workflowId };
  useLoopedReviewStore.setState({
    workflows: new Map([[data.workflowId, workflow]]),
  });
  return workflow;
}

beforeEach(() => {
  useLoopedReviewStore.setState({ workflows: new Map() });
});

afterEach(() => {
  cleanup();
  useLoopedReviewStore.setState({ workflows: new Map() });
});

describe("LoopedReviewTab states", () => {
  test("shows a paused workflow with preserved pool and resume controls", () => {
    seedWorkflow({
      phase: "paused",
      pausedFromPhase: "discovering",
      activePool: {
        issues: [],
        coverageGaps: [{
          poolId: "gap-stable",
          file: "src/recovery.test.ts",
          untestedBehavior: "Inactive-tab recovery.",
        }],
      },
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("Workflow paused")).toBeTruthy();
    expect(screen.getByText("Inactive-tab recovery.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
    expect(screen.getByText((content) => content.includes("Round 1 · pass —/6")))
      .toBeTruthy();
  });

  test("shows retry and cancellation controls for a failed phase", () => {
    seedWorkflow({
      phase: "failed",
      failure: {
        code: "structured-output",
        message: "Schema retries exhausted",
        retryPhase: "discovering",
        occurredAt: "2026-07-25T00:00:00.000Z",
      },
    });
    render(<LoopedReviewTab data={data} isActive />);

    expect(screen.getByRole("alert").textContent).toContain("Schema retries exhausted");
    expect(screen.getByRole("button", { name: /Retry phase/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
  });

  test("renders a completed PR and retains archived round pools", () => {
    seedWorkflow({
      phase: "completed",
      pr: {
        status: "created",
        sessionId: "pr-session",
        url: "https://github.com/org/repo/pull/42",
      },
      archivedPools: [{
        round: 1,
        fixedAt: "2026-07-25T00:00:00.000Z",
        fixSessionId: "fix-session",
        pool: {
          issues: [],
          coverageGaps: [{
            poolId: "gap-1",
            file: "src/review.test.ts",
            untestedBehavior: "The restart path.",
          }],
        },
      }],
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("Review complete and PR created")).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: (name) => name.includes("pull/42"),
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /Archived pool · round 1/ }),
    ).toBeTruthy();
    expect(screen.getByText("The restart path.")).toBeTruthy();
  });
});
