import { afterEach, expect, test } from "bun:test";
import type {
  MultiReviewActionResult,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";
import { intentFingerprint, requestKey } from "./operation-ledger.js";
import { reviewLaunchId } from "./review-recovery.js";
import type { PublicApiHarness } from "./test-support.js";

afterEach(cleanupSessionHarnesses);

function workflow(
  id = "review-1",
  phase: MultiReviewWorkflow["phase"] = "reviewing",
): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id,
    environmentId: "env-1",
    projectId: "p",
    targetBranch: "main",
    reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
    fixModel: { agent: "claude", model: "opus" },
    phase,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    backendRevision: 0,
  };
}

async function savedReview(
  harness: PublicApiHarness,
  phase: MultiReviewWorkflow["phase"] = "reviewing",
) {
  const saved = workflow("review-1", phase);
  await harness.storage.saveMultiReviewWorkflow(saved.id, saved.environmentId, 1, saved);
  return saved;
}

function result(saved: MultiReviewWorkflow, partial = false): MultiReviewActionResult {
  return {
    workflow: saved,
    reused: true,
    outcome: partial ? "partial" : "opened",
    ui: { status: partial ? "unavailable" : "opened" },
    ...(partial ? { recovery: "Open the saved review again" } : {}),
  };
}

test("review list/get return saved summaries and root/fix/address map surface results", async () => {
  const { harness } = await setup();
  const saved = await savedReview(harness);
  Object.assign(harness.context, { multiReviews: {} });
  const listed = await harness.call<{ items: Array<{ id: string; targetBranch: string }> }>(
    "review.list",
    { environmentId: "env-1" },
  );
  expect(listed.ok && listed.result.items).toEqual([
    expect.objectContaining({ id: saved.id, targetBranch: "main" }),
  ]);
  const get = await harness.call("review.get", { workflowId: saved.id });
  expect(get.ok && get.result).toMatchObject({ id: saved.id, targetBranch: "main", revision: 1 });
  const calls: unknown[] = [];
  harness.commands.set("controller_multi_review_surface", async (args) => {
    calls.push(args);
    return result(saved, args.surface === "fix");
  });
  for (const [action, surface] of [
    ["review.open", "root"],
    ["review.open", "fix"],
    ["review.address", "address"],
  ] as const) {
    const opened = await harness.call(
      action,
      { workflowId: saved.id, ...(action === "review.open" ? { surface } : {}) },
      { requestId: surface },
    );
    expect(opened.receipt?.state).toBe(surface === "fix" ? "partial" : "succeeded");
    expect(opened.receipt?.result).toMatchObject({
      workflowId: saved.id,
      reused: true,
      ui: surface === "fix" ? "unavailable" : "opened",
    });
    if (surface === "fix") expect(!opened.ok && opened.error.code).toBe("partial-failure");
  }
  expect(calls).toEqual(
    ["root", "fix", "address"].map((surface) => ({ workflowId: saved.id, surface })),
  );
});

for (const fails of [false, true]) {
  test(`review.cancel maps ${fails ? "failure" : "success"} without throwing or repeating`, async () => {
    const { harness } = await setup();
    const saved = await savedReview(harness);
    let cancels = 0;
    Object.assign(harness.context, {
      multiReviews: {
        cancel: async () => {
          cancels += 1;
          if (fails) throw new Error("cancellation unavailable");
          return { ...saved, phase: "cancelled" };
        },
      },
    });
    const input = { workflowId: saved.id };
    const first = await harness.call("review.cancel", input, { requestId: "cancel" });
    expect(first.receipt?.state).toBe(fails ? "failed" : "succeeded");
    if (fails)
      expect(!first.ok && first.error).toMatchObject({
        code: "operation-failed",
        message: "cancellation unavailable",
      });
    else expect(first.receipt?.result).toEqual({ workflowId: saved.id, phase: "cancelled" });
    await harness.call("review.cancel", input, { requestId: "cancel" });
    expect(cancels).toBe(1);
  });
}

for (const action of ["review.launch", "review.open", "review.address", "review.cancel"] as const) {
  for (const evidence of [true, false]) {
    for (const observation of ["run.get", "retry"] as const) {
      test(`${action} restart ${evidence ? "with saved evidence" : "without confirmation"} settles through ${observation} and same-key retry`, async () => {
        const { harness } = await setup();
        const effects: unknown[] = [];
        for (const name of ["launch_controller_multi_review", "controller_multi_review_surface"])
          harness.commands.set(name, async (args) => {
            effects.push(args);
            throw new Error("must not execute on retry");
          });
        const input =
          action === "review.launch" ? { environmentId: "env-1" } : { workflowId: "review-1" };
        const intent =
          action === "review.open"
            ? { ...input, surface: "root" }
            : action === "review.address"
              ? { ...input, surface: "address" }
              : input;
        const scope = action === "review.launch" ? "environment:env-1" : "review:review-1";
        const admitted = await harness.storage.publicOperations.admitPublicOperation({
          authority: "operator",
          action,
          scope,
          requestId: "restart",
          requestKey: requestKey("operator", action, scope, "restart"),
          fingerprint: intentFingerprint(action, intent),
          generation: harness.storage.getResourceGeneration(),
          resources: { environmentId: "env-1" },
          ...(observation === "retry" ? { resolved: { workflowId: "review-1" } } : {}),
        });
        const operationId = admitted.record.operationId;
        const saved = workflow(
          action === "review.launch" ? reviewLaunchId(operationId) : "review-1",
          action === "review.cancel" && evidence ? "cancelled" : "reviewing",
        );
        if (evidence)
          await harness.storage.saveMultiReviewWorkflow(saved.id, saved.environmentId, 1, saved);
        await harness.storage.publicOperations.updatePublicOperation(operationId, (record) => ({
          ...record,
          state: "running",
          stage:
            evidence && (action === "review.open" || action === "review.address")
              ? "review-success-saved"
              : "executing",
          ...(evidence && (action === "review.open" || action === "review.address")
            ? { result: { workflowId: saved.id, outcome: "opened" } }
            : {}),
        }));
        const restarted = await harness.restart();
        try {
          if (observation === "run.get") {
            const recovered = await restarted.call("run.get", { operationId });
            expect(recovered.receipt?.state).toBe(
              evidence ? (action === "review.launch" ? "partial" : "succeeded") : "interrupted",
            );
          }
          const replay = await restarted.call(action, input, { requestId: "restart" });
          expect(replay.receipt?.state).toBe(
            evidence ? (action === "review.launch" ? "partial" : "succeeded") : "interrupted",
          );
          const get = await restarted.call("run.get", { operationId });
          expect(get.receipt?.state).toBe(replay.receipt?.state);
          expect(replay.receipt?.replayed).toBe(true);
          expect(effects).toHaveLength(0);
        } finally {
          await restarted.cleanup();
        }
      });
    }
  }
}
