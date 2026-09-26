import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { multiReviewDiscovery, multiReviewObligation } from "./multi-review-scheduling.js";

function workflow(fields: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return {
    id: "workflow",
    environmentId: "env-1",
    phase: "reviewing",
    reviewers: [],
    ...fields,
  } as unknown as MultiReviewWorkflow;
}

describe("multi review obligations", () => {
  test("name every runnable state, not only running phases", () => {
    expect(multiReviewObligation(workflow({ phase: "reviewing" }), true)).toBe("reviewers");
    expect(multiReviewObligation(workflow({ phase: "consolidating" }), true)).toBe("step");
    expect(multiReviewObligation(workflow({ phase: "cancelling" }), true)).toBe("cancelling");
    expect(
      multiReviewObligation(
        workflow({ phase: "completed", pendingResultConsumptions: ["k"] }),
        true,
      ),
    ).toBe("result-consumption");
    // The durable interactive handoff is owed only when a dispatcher exists.
    const handoff = workflow({ phase: "interactive", addressPromptPending: true });
    expect(multiReviewObligation(handoff, true)).toBe("address-handoff");
    expect(multiReviewObligation(handoff, false)).toBeNull();
    const fix = workflow({
      phase: "interactive",
      fixSession: { status: "running" } as MultiReviewWorkflow["fixSession"],
    });
    expect(multiReviewObligation(fix, true)).toBe("interactive-fix");
    const pausedStop = workflow({
      phase: "paused",
      pausedStep: "fix",
      fixSession: { status: "running" } as MultiReviewWorkflow["fixSession"],
    });
    expect(multiReviewObligation(pausedStop, true)).toBe("paused-stop");
    expect(multiReviewObligation(workflow({ phase: "paused" }), true)).toBeNull();
    expect(multiReviewObligation(workflow({ phase: "ready" }), true)).toBeNull();
    expect(multiReviewObligation(workflow({ phase: "completed" }), true)).toBeNull();
  });

  test("discovery skips unreadable and settled records without hiding others", () => {
    const records = [
      { id: "a", snapshot: workflow({ id: "a", phase: "completed" }) },
      { id: "b", snapshot: { garbage: true } },
      { id: "c", snapshot: workflow({ id: "c", phase: "reviewing", environmentId: "env-9" }) },
    ];
    const isWorkflow = (value: unknown): value is MultiReviewWorkflow =>
      typeof value === "object" && value !== null && "phase" in value;
    expect(multiReviewDiscovery(records, isWorkflow, true)).toEqual({
      entries: [{ key: "c", obligation: "reviewers", target: "env-9" }],
      scanned: 3,
      complete: true,
    });
  });
});
