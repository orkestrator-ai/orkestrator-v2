import { describe, expect, mock, test } from "bun:test";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { renderHook } from "@testing-library/react";
import {
  MAX_ENVIRONMENT_HYDRATION_IDS,
  type EnvironmentHydrationBatch,
} from "@orkestrator/protocol/environment-hydration";
import type { PersistedPromptQueue, PersistedWorkflowRecord } from "@/types";
import { useHydrateOncePerEnvironment } from "@/hooks/useHydrateOncePerEnvironment";
import {
  EnvironmentHydrationBatcher,
  type EnvironmentHydrationDependencies,
} from "./boot-hydration";
import { HYDRATION_MAX_IN_FLIGHT, RequestLimiter } from "./hydration-request-limiter";

type Batch = EnvironmentHydrationBatch<PersistedPromptQueue, PersistedWorkflowRecord<unknown>>;

const queue = (environmentId: string) =>
  ({ queueKey: `q-${environmentId}`, environmentId }) as unknown as PersistedPromptQueue;
const workflow = (environmentId: string) =>
  ({ id: `w-${environmentId}`, environmentId }) as unknown as PersistedWorkflowRecord<unknown>;

const answer = (ids: string[], failing: ReadonlySet<string> = new Set()): Batch => ({
  environments: ids.map((environmentId) => ({
    environmentId,
    promptQueues: failing.has(environmentId)
      ? { status: "failed" }
      : { status: "ok", records: [queue(environmentId)] },
    multiReviewWorkflows: { status: "ok", records: [workflow(environmentId)] },
  })),
});

/** Flushes run when the test says so, as the zero-delay timer would. */
function manualSchedule() {
  const queued: Array<() => void> = [];
  return {
    schedule: (flush: () => void) => {
      queued.push(flush);
    },
    run: () => {
      for (const flush of queued.splice(0)) flush();
    },
  };
}

const settle = async () => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

function batcher(overrides: Partial<EnvironmentHydrationDependencies> = {}) {
  const scheduler = manualSchedule();
  const listBatch = mock(async (ids: string[]) => answer(ids));
  const listPromptQueues = mock(async (id: string) => [queue(id)]);
  const listMultiReviewWorkflows = mock(async (id: string) => [workflow(id)]);
  const instance = new EnvironmentHydrationBatcher({
    listBatch,
    listPromptQueues,
    listMultiReviewWorkflows,
    schedule: scheduler.schedule,
    ...overrides,
  });
  // The default mocks; a test that overrides one keeps its own reference.
  return { instance, scheduler, listBatch, listPromptQueues, listMultiReviewWorkflows };
}

describe("EnvironmentHydrationBatcher", () => {
  test("serves both lists for every environment requested in one task with one request", async () => {
    const { instance, scheduler, listBatch } = batcher();
    const queues = ["e1", "e2", "e3"].map((id) => instance.promptQueues(id));
    const workflows = ["e1", "e2", "e3"].map((id) => instance.multiReviewWorkflows(id));
    scheduler.run();

    expect(await Promise.all(queues)).toEqual([[queue("e1")], [queue("e2")], [queue("e3")]]);
    expect(await Promise.all(workflows)).toEqual([
      [workflow("e1")],
      [workflow("e2")],
      [workflow("e3")],
    ]);
    expect(listBatch.mock.calls).toEqual([[["e1", "e2", "e3"]]]);
  });

  test("splits a long list into calls of at most the backend's limit", async () => {
    const { instance, scheduler, listBatch } = batcher();
    const ids = Array.from({ length: MAX_ENVIRONMENT_HYDRATION_IDS * 2 + 5 }, (_, i) => `e${i}`);
    const reads = ids.map((id) => instance.promptQueues(id));
    scheduler.run();
    await Promise.all(reads);
    expect(listBatch.mock.calls.map(([chunk]) => chunk.length)).toEqual([
      MAX_ENVIRONMENT_HYDRATION_IDS,
      MAX_ENVIRONMENT_HYDRATION_IDS,
      5,
    ]);
  });

  test("a failed list rejects only that environment's list; its neighbours still load", async () => {
    const { instance, scheduler } = batcher({
      listBatch: async (ids) => answer(ids, new Set(["broken"])),
    });
    const broken = instance.promptQueues("broken").then(
      () => "loaded",
      (error: Error) => error.message,
    );
    const brokenWorkflows = instance.multiReviewWorkflows("broken");
    const healthy = instance.promptQueues("healthy");
    scheduler.run();
    expect(await broken).toContain("failed");
    expect(await brokenWorkflows).toEqual([workflow("broken")]);
    expect(await healthy).toEqual([queue("healthy")]);
  });

  test.each(["node unavailable", "invalid environment id"])(
    "a failed batch (%s) falls back with isolated lists and retries batching next time",
    async (message) => {
      let calls = 0;
      const listBatch = mock(async (ids: string[]) => {
        calls += 1;
        if (calls === 1) throw new Error(message);
        return answer(ids);
      });
      const listPromptQueues = mock(async (id: string) => {
        if (id === "broken-queue") throw new Error("queue unavailable");
        return [queue(id)];
      });
      const listMultiReviewWorkflows = mock(async (id: string) => {
        if (id === "broken-workflow") throw new Error("workflow unavailable");
        return [workflow(id)];
      });
      const { instance, scheduler } = batcher({
        listBatch,
        listPromptQueues,
        listMultiReviewWorkflows,
      });
      const ids = ["healthy", "broken-queue", "broken-workflow"];
      const reads = Promise.allSettled(
        ids.flatMap((id) => [instance.promptQueues(id), instance.multiReviewWorkflows(id)]),
      );
      scheduler.run();
      expect(await reads).toEqual([
        { status: "fulfilled", value: [queue("healthy")] },
        { status: "fulfilled", value: [workflow("healthy")] },
        { status: "rejected", reason: new Error("queue unavailable") },
        { status: "fulfilled", value: [workflow("broken-queue")] },
        { status: "fulfilled", value: [queue("broken-workflow")] },
        { status: "rejected", reason: new Error("workflow unavailable") },
      ]);
      expect(listPromptQueues.mock.calls).toEqual(ids.map((id) => [id]));
      expect(listMultiReviewWorkflows.mock.calls).toEqual(ids.map((id) => [id]));
      const next = instance.promptQueues("healthy");
      scheduler.run();
      expect(await next).toEqual([queue("healthy")]);
      expect(listBatch).toHaveBeenCalledTimes(2);
      expect(listPromptQueues).toHaveBeenCalledTimes(3);
    },
  );

  test("never joins a request already in flight, so no read predates its request", async () => {
    const gates: Array<(batch: Batch) => void> = [];
    const listBatch = mock(
      (_ids: string[]) => new Promise<Batch>((resolve) => gates.push(resolve)),
    );
    const { instance, scheduler } = batcher({ listBatch });
    const early = instance.promptQueues("e1");
    scheduler.run();
    const late = instance.promptQueues("e1");
    scheduler.run();
    expect(listBatch).toHaveBeenCalledTimes(2);
    for (const resolve of gates) resolve(answer(["e1"]));
    expect(await early).toEqual([queue("e1")]);
    expect(await late).toEqual([queue("e1")]);
  });

  test("falls back to the per-environment reads once an older backend refuses the command", async () => {
    const listBatch = mock(async (_ids: string[]): Promise<Batch> => {
      throw new Error(unknownBackendCommandMessage("list_environment_hydration"));
    });
    const { instance, scheduler, listPromptQueues, listMultiReviewWorkflows } = batcher({
      listBatch,
    });
    const first = Promise.all([instance.promptQueues("e1"), instance.multiReviewWorkflows("e1")]);
    scheduler.run();
    expect(await first).toEqual([[queue("e1")], [workflow("e1")]]);

    // Only the list asked for is read, and the batch is not tried again.
    const second = instance.multiReviewWorkflows("e2");
    scheduler.run();
    expect(await second).toEqual([workflow("e2")]);
    expect(listBatch).toHaveBeenCalledTimes(1);
    expect(listPromptQueues.mock.calls).toEqual([["e1"]]);
    expect(listMultiReviewWorkflows.mock.calls).toEqual([["e1"], ["e2"]]);
  });

  test("in fallback one environment's failed read does not block the others", async () => {
    const { instance, scheduler } = batcher({
      listBatch: async () => {
        throw new Error(unknownBackendCommandMessage("list_environment_hydration"));
      },
      listPromptQueues: async (id) => {
        if (id === "broken") throw new Error("queue unavailable");
        return [queue(id)];
      },
    });
    const broken = instance.promptQueues("broken").catch((error: Error) => error.message);
    const healthy = instance.promptQueues("healthy");
    scheduler.run();
    expect(await broken).toBe("queue unavailable");
    expect(await healthy).toEqual([queue("healthy")]);
  });
});

describe("boot fan-out", () => {
  /**
   * A cold boot of a node with 10 projects of 12 environments, the projects'
   * environment lists arriving one after another as `get_environments`
   * answers. Before: one `list_prompt_queues` and one
   * `list_multi_review_workflows` per environment, all at once. After: one
   * `list_environment_hydration` per project, never more than the bound in
   * flight.
   */
  test("restores every environment with far fewer requests, within the bound", async () => {
    const projects = 10;
    const perProject = 12;
    const limiter = new RequestLimiter(HYDRATION_MAX_IN_FLIGHT);
    let peak = 0;
    const gates: Array<() => void> = [];
    const listBatch = mock((ids: string[]) =>
      limiter.run(async () => {
        peak = Math.max(peak, limiter.inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        return answer(ids, new Set(["p3-e4"]));
      }),
    );
    const scheduler = manualSchedule();
    const instance = new EnvironmentHydrationBatcher({
      listBatch,
      listPromptQueues: mock(async () => []),
      listMultiReviewWorkflows: mock(async () => []),
      schedule: scheduler.schedule,
    });
    const restoredQueues = new Set<string>();
    const restoredWorkflows = new Set<string>();
    const queueErrors: string[] = [];
    const hydrateQueues = (id: string) =>
      instance.promptQueues(id).then(() => {
        restoredQueues.add(id);
      });
    const hydrateWorkflows = (id: string) =>
      instance.multiReviewWorkflows(id).then(() => {
        restoredWorkflows.add(id);
      });
    const onQueueError = (id: string) => {
      queueErrors.push(id);
    };
    const onWorkflowError = () => undefined;

    let environments: Array<{ id: string }> = [];
    const { rerender } = renderHook(
      ({ list }) => {
        useHydrateOncePerEnvironment(list, hydrateQueues, onQueueError);
        useHydrateOncePerEnvironment(list, hydrateWorkflows, onWorkflowError);
      },
      { initialProps: { list: environments } },
    );
    for (let project = 0; project < projects; project += 1) {
      environments = [
        ...environments,
        ...Array.from({ length: perProject }, (_, index) => ({ id: `p${project}-e${index}` })),
      ];
      rerender({ list: environments });
      scheduler.run();
    }
    while (gates.length > 0 || limiter.inFlight > 0 || limiter.queued > 0) {
      for (const release of gates.splice(0)) release();
      await settle();
    }
    await settle();

    const total = projects * perProject;
    const before = total * 2;
    const after = listBatch.mock.calls.length;
    expect(after).toBe(projects);
    expect(after).toBeLessThan(before / 10);
    expect(peak).toBeLessThanOrEqual(HYDRATION_MAX_IN_FLIGHT);
    // Same result as before: every list restored, the one failure isolated.
    expect(restoredWorkflows.size).toBe(total);
    expect(restoredQueues.size).toBe(total - 1);
    expect(queueErrors).toEqual(["p3-e4"]);
  });
});
