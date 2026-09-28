import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { queueAutoPr, supersedePendingAutoPr } from "./multi-review-auto-pr.js";

function workflow(fields: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return { id: "workflow-1", ...fields } as unknown as MultiReviewWorkflow;
}

describe("queueAutoPr", () => {
  test("queues nothing unless auto-PR is on", () => {
    for (const autoPr of [undefined, false]) {
      const target = workflow({ autoPr });
      queueAutoPr(target);
      expect(target.autoPrLaunch).toBeUndefined();
    }
  });

  test("queues one stable request and never repeats a pending or delivered launch", () => {
    const target = workflow({ autoPr: true });
    queueAutoPr(target);
    expect(target.autoPrLaunch).toEqual({
      state: "pending",
      requestId: "multi-review-pr:workflow-1",
    });

    const launched = workflow({
      autoPr: true,
      autoPrLaunch: { state: "launched", requestId: "multi-review-pr:workflow-1", tabId: "tab" },
    });
    queueAutoPr(launched);
    expect(launched.autoPrLaunch?.state).toBe("launched");
  });

  test.each(["skipped", "failed"] as const)("re-queues a %s launch after a later Fix", (state) => {
    const target = workflow({
      autoPr: true,
      autoPrLaunch: { state, requestId: "multi-review-pr:workflow-1", message: "earlier" },
    });
    queueAutoPr(target);
    expect(target.autoPrLaunch).toEqual({
      state: "pending",
      requestId: "multi-review-pr:workflow-1",
    });
  });
});

describe("supersedePendingAutoPr", () => {
  test("drops only an undelivered launch", () => {
    const pending = workflow({ autoPrLaunch: { state: "pending", requestId: "pr" } });
    supersedePendingAutoPr(pending);
    expect(pending.autoPrLaunch).toBeUndefined();

    const launched = workflow({ autoPrLaunch: { state: "launched", requestId: "pr" } });
    supersedePendingAutoPr(launched);
    expect(launched.autoPrLaunch?.state).toBe("launched");
  });
});
