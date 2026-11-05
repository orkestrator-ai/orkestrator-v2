import { expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { MultiReviewWorkerMail } from "./multi-review-worker-mail.js";
import {
  combineWorkerMailPorts,
  type PipelineWorkerMailPort,
} from "./build-pipeline-worker-mail.js";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";

test("mail ports route every operation to the owning pipeline or Multi Review", async () => {
  const calls: string[] = [];
  const port = (address: string): PipelineWorkerMailPort => ({
    state: async (_env, tab) => (tab === address ? "running" : null),
    steer: async () => {
      calls.push(address + ":steer");
      return { outcome: "applied" };
    },
    reconcileDelivery: async () => {
      calls.push(address + ":delivery");
      return "dispatched";
    },
    reconcileSteer: async () => {
      calls.push(address + ":reconcile");
      return "not-dispatched";
    },
  });
  const combined = combineWorkerMailPorts([port("pipeline"), port("review")]);
  for (const tabId of ["pipeline", "review"]) {
    expect(await combined.state("env", tabId)).toBe("running");
    expect(
      await combined.steer({ environmentId: "env", tabId, requestId: "request", text: "mail" }),
    ).toEqual({ outcome: "applied" });
    expect(await combined.reconcileDelivery("env", tabId, "request")).toBe("dispatched");
    expect(await combined.reconcileSteer("env", tabId, "request")).toBe("not-dispatched");
  }
  expect(calls).toEqual([
    "pipeline:steer",
    "pipeline:delivery",
    "pipeline:reconcile",
    "review:steer",
    "review:delivery",
    "review:reconcile",
  ]);
  expect(await combined.reconcileDelivery("env", "missing", "request")).toBe("unknown");
  expect(
    (
      await combined.steer({
        environmentId: "env",
        tabId: "missing",
        requestId: "request",
        text: "",
      })
    ).outcome,
  ).toBe("refused");
});

test("reviewer steering uses current run identity and reconciles interrupted claims conservatively", async () => {
  const workflow = {
    id: "review",
    environmentId: "env",
    phase: "reviewing",
    reviewers: [
      {
        id: "r",
        agent: "claude",
        model: "opus",
        status: "running",
        sessionKey: "key",
        providerSessionId: "session",
        dispatchState: "sent",
        requestId: "delivery",
      },
    ],
  } as MultiReviewWorkflow;
  let outcome = "rejected";
  let status = "absent";
  let throwAction = false;
  const provider = {
    steerSupported: async () => true,
    activeSteerRun: async () => ({ state: "running", runId: "current-run" }),
    performSessionAction: async (_id: string, action: { expectedRunId: string }) => {
      expect(action.expectedRunId).toBe("current-run");
      if (throwAction) throw new Error("transport lost");
      return { outcome };
    },
    steerStatus: async () => status,
  } as unknown as BuildPipelineProvider;
  const mail = new MultiReviewWorkerMail({
    storage: { listMultiReviewWorkflows: async () => [{ snapshot: workflow }] } as never,
    withLock: async (_id, run) => run(),
    provider: async () => provider,
  });
  const tabId = pipelineWorkerTabId("key");
  const input = { environmentId: "env", tabId, requestId: "steer", text: "mail" };
  expect((await mail.steer(input)).outcome).toBe("refused");
  outcome = "unknown";
  expect((await mail.steer(input)).outcome).toBe("unknown");
  throwAction = true;
  expect((await mail.steer(input)).outcome).toBe("unknown");
  expect(await mail.reconcileDelivery("env", tabId, "delivery")).toBe("dispatched");
  expect(await mail.reconcileDelivery("env", tabId, "other")).toBe("not-dispatched");
  expect(await mail.reconcileSteer("env", tabId, "steer")).toBe("not-dispatched");
  status = "dispatched";
  expect(await mail.reconcileSteer("env", tabId, "steer")).toBe("dispatched");
  status = "unknown";
  expect(await mail.reconcileSteer("env", tabId, "steer")).toBe("unknown");
  workflow.reviewers[0]!.sessionKey = "new-attempt";
  expect((await mail.steer(input)).outcome).toBe("refused");
  expect(await mail.reconcileDelivery("env", tabId, "delivery")).toBe("unknown");
});
