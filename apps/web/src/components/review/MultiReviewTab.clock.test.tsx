/**
 * WEB-17: the Multi Review clock ticks in the leaves that print a time. The
 * tab root used to hold `now` in its own state, so every second a review ran
 * re-rendered the whole tab: header, graph, inspector and transcripts.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { MultiReviewTabData } from "@/types/paneLayout";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { MultiReviewTab } from "./MultiReviewTab";
import { appCommandStore } from "@/test/app-command-store";

const startedAt = "2026-08-14T00:00:00.000Z";

function reviewingWorkflow(): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-clock",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "running",
        providerSessionId: "provider-reviewer-1",
        dispatchState: "sent",
        startedAt,
        tokenCount: 1_200,
      },
    ],
    stepRuntimes: {
      prepare: { startedAt, completedAt: "2026-08-14T00:00:20.000Z" },
    },
    fixModel: { agent: "codex", model: "gpt-5.6" },
    createdAt: startedAt,
    updatedAt: startedAt,
    backendRevision: 3,
  };
}

/**
 * Tab data whose `workflowId` read is counted. Only the tab root's render
 * reads it (the leaves get plain values), so the count moves exactly when the
 * root renders.
 */
function countedData(workflowId: string) {
  const reads = { count: 0 };
  const data = {
    environmentId: "env-1",
    isLocal: true,
    get workflowId() {
      reads.count += 1;
      return workflowId;
    },
  } as MultiReviewTabData;
  return { data, reads };
}

let originalNow: typeof Date.now;
let originalSetInterval: typeof window.setInterval;
let originalClearInterval: typeof window.clearInterval;
let now = 0;
let ticks: Array<() => void> = [];

beforeEach(() => {
  appCommandStore(multiReviewStore).setState({ workflows: new Map() });
  useMessagePartExpansionStore.getState().reset();
  originalNow = Date.now;
  originalSetInterval = window.setInterval;
  originalClearInterval = window.clearInterval;
  now = Date.parse("2026-08-14T00:01:35.000Z");
  ticks = [];
  Date.now = () => now;
  // Captured, so each second is a deterministic `tick()` call.
  window.setInterval = ((callback: TimerHandler) => {
    ticks.push(callback as () => void);
    return ticks.length;
  }) as typeof window.setInterval;
  window.clearInterval = mock(() => undefined) as typeof window.clearInterval;
});

afterEach(() => {
  cleanup();
  Date.now = originalNow;
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
});

function tick() {
  now += 1_000;
  act(() => {
    for (const callback of ticks) callback();
  });
}

test("a running review's clock ticks without re-rendering the tab root", () => {
  const workflow = reviewingWorkflow();
  appCommandStore(multiReviewStore).getState().replaceWorkflow(workflow);
  const { data, reads } = countedData(workflow.id);
  renderInAppCommandScope(
    <MultiReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />,
  );

  const headerElapsed = () => screen.getByTestId("multi-review-elapsed").textContent;
  const reviewerRuntime = () =>
    screen.getByLabelText("Reviewer 1 runtime and token usage").textContent;
  const prepareRuntime = () =>
    screen.getByLabelText("Review package generation runtime").textContent;
  expect(headerElapsed()).toBe(" · 1m 35s");
  expect(reviewerRuntime()).toBe("1m 35s · 1.2k tokens");
  expect(prepareRuntime()).toBe("20s");
  expect(ticks.length).toBeGreaterThan(0);

  const rootRenders = reads.count;
  tick();
  expect(headerElapsed()).toBe(" · 1m 36s");
  expect(reviewerRuntime()).toBe("1m 36s · 1.2k tokens");
  tick();
  tick();
  expect(headerElapsed()).toBe(" · 1m 38s");
  expect(reviewerRuntime()).toBe("1m 38s · 1.2k tokens");
  // The selected reviewer's inspector line follows the same clock.
  expect(screen.getByText(/Read only · 1m 38s · 1\.2k tokens$/)).toBeTruthy();
  // A settled step's runtime does not move.
  expect(prepareRuntime()).toBe("20s");
  expect(reads.count - rootRenders).toBe(0);

  // The counter does see the root render: a new workflow snapshot renders it,
  // and the values it computes agree with the leaves' clock.
  act(() => {
    appCommandStore(multiReviewStore)
      .getState()
      .replaceWorkflow({ ...workflow, backendRevision: 4, updatedAt: startedAt });
  });
  expect(reads.count).toBeGreaterThan(rootRenders);
  expect(headerElapsed()).toBe(" · 1m 38s");
  expect(reviewerRuntime()).toBe("1m 38s · 1.2k tokens");
});
