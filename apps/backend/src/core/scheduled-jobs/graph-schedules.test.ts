/**
 * Scheduled graph launches (item 214): the operator's `graph` action is
 * validated when it is created (the request's shape and a launchable
 * template), fires once through the graph launch service as
 * `requestedBy: "schedule"` under a per-fire request key, and a re-run of the
 * same fire replays rather than launching again. Other owners cannot use the
 * `graph` action. Real storage and scheduler; the launch service is scripted.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  GraphLaunchOptions,
  GraphLaunchOrigin,
  GraphLaunchRequest,
  GraphLaunchResult,
} from "@orkestrator/protocol/graphs/launch";
import type {
  ScheduleAction,
  ScheduleGraphLaunch,
  ScheduleOwner,
} from "@orkestrator/protocol/scheduled-jobs";
import { GraphLaunchError } from "../graph-run-launch.js";
import { StorageService } from "../storage.js";
import { ScheduledJobExecutor } from "./executor.js";
import { ScheduledJobService } from "./service.js";

const OPERATOR: ScheduleOwner = { kind: "operator" };
const T0 = Date.parse("2026-10-29T10:00:00Z");
const REQUEST: ScheduleGraphLaunch = {
  ref: { scope: "user", id: "nightly" },
  projectId: "project-1",
  environment: { kind: "new", create: "worktree" },
  params: { maxRounds: 2 },
};

/** A `graph` action as a caller sends it: untrusted until the service parses it. */
function graph(request: Record<string, unknown>): ScheduleAction {
  return { kind: "graph", request } as unknown as ScheduleAction;
}

let root: string | null = null;
let storage: StorageService | null = null;

afterEach(async () => {
  storage?.close();
  storage = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function world() {
  root = await mkdtemp(path.join(os.tmpdir(), "ork-graph-schedules-"));
  storage = new StorageService(root);
  await storage.init();
  const clock = { now: T0 };
  const launched = new Map<string, GraphLaunchResult>();
  const launch = mock(async (request: GraphLaunchRequest, _origin: GraphLaunchOrigin) => {
    if (request.ref.scope === "user" && request.ref.id === "gone") {
      throw new GraphLaunchError("not-found", "No user template gone");
    }
    const key = request.requestId!;
    const repeated = launched.has(key);
    const result: GraphLaunchResult = launched.get(key) ?? {
      runId: `launch-${launched.size + 1}`,
      projectId: request.projectId,
      status: "provisioning",
      template: { id: "nightly", revision: 1, name: "Nightly" },
      repeated: false,
    };
    launched.set(key, result);
    return { ...result, repeated };
  });
  const options = mock(
    async (input: { ref: { scope: string; id?: string } }): Promise<GraphLaunchOptions> =>
      ({
        launchable: input.ref.id !== "broken",
        ...(input.ref.id === "broken" ? { blockedReason: "The template does not compile" } : {}),
      }) as GraphLaunchOptions,
  );
  const service = new ScheduledJobService({
    store: storage.scheduledJobStore(),
    now: () => clock.now,
    defaultTimeZone: () => "UTC",
    executor: new ScheduledJobExecutor({
      invoke: async (command) => {
        throw new Error(`Unexpected command: ${command}`);
      },
      storage: {
        sendAgentMail: async () => {
          throw new Error("no mail here");
        },
        coordinators: { getCoordinatorWorkspace: async () => null },
      },
      graphs: { launch, options: options as never },
    }),
  });
  const fire = async () => {
    await service.tick();
    await service.idle();
  };
  return { service, clock, launch, options, fire };
}

describe("scheduled graph launches", () => {
  test("an operator's graph schedule fires once through the launch service as the schedule", async () => {
    const { service, clock, launch, options, fire } = await world();
    const { job } = await service.create(OPERATOR, {
      at: "+1h",
      action: graph({ ...REQUEST, requestId: "ignored", saveDefaults: true }),
    });
    expect(job.action).toEqual({ kind: "graph", request: REQUEST });
    expect(job.name).toBe("Graph nightly");
    expect(options).toHaveBeenCalledWith({
      ref: { scope: "user", id: "nightly" },
      projectId: "project-1",
      create: "worktree",
    });

    clock.now = T0 + 60 * 60 * 1000;
    await fire();
    expect(launch).toHaveBeenCalledTimes(1);
    const [request, origin] = launch.mock.calls[0]!;
    expect(origin).toEqual({ requestedBy: "schedule", scheduleId: job.id });
    expect(request).toEqual({ ...REQUEST, requestId: `sched:${job.id}@${T0 + 60 * 60 * 1000}` });
    const fired = service.get(OPERATOR, job.id)!;
    expect(fired.state).toBe("completed");
    expect(fired.fires.at(-1)).toMatchObject({
      state: "succeeded",
      outcome: { runId: "launch-1", summary: "graph run launched (provisioning)" },
    });

    // Nothing more fires for a one-shot.
    clock.now += 24 * 60 * 60 * 1000;
    await fire();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  test("a graph that cannot launch, a malformed request and non-operator owners are refused at creation", async () => {
    const { service, launch } = await world();
    await expect(
      service.create(OPERATOR, {
        at: "+1h",
        action: graph({ ...REQUEST, ref: { scope: "user", id: "broken" } }),
      }),
    ).rejects.toThrow("The template does not compile");
    await expect(
      service.create(OPERATOR, {
        at: "+1h",
        action: graph({ ...REQUEST, environment: { kind: "elsewhere" } }),
      }),
    ).rejects.toThrow("environment.kind");
    await expect(
      service.create(
        { kind: "agent", projectId: "project-1", environmentId: "env-1", tabId: "t1" },
        { at: "+1h", action: graph({ ...REQUEST }) },
      ),
    ).rejects.toThrow("launch_graph");
    await expect(
      service.create(
        { kind: "control-mcp", credentialId: "cred-1" },
        { at: "+1h", action: graph({ ...REQUEST }) },
      ),
    ).rejects.toThrow("launch_graph");
    expect(launch).not.toHaveBeenCalled();
    expect(service.list(OPERATOR)).toEqual([]);
  });

  test("a template removed since creation fails the fire and pauses the schedule", async () => {
    const { service, clock, fire, options } = await world();
    const { job } = await service.create(OPERATOR, {
      cron: "0 * * * *",
      action: graph({ ...REQUEST, ref: { scope: "user", id: "gone" } }),
    });
    expect(options).toHaveBeenCalled();
    clock.now = Date.parse("2026-10-29T11:00:00Z");
    await fire();
    const after = service.get(OPERATOR, job.id)!;
    expect(after.fires.at(-1)).toMatchObject({
      state: "failed",
      error: { code: "not-found" },
    });
    expect(after).toMatchObject({ state: "paused", pausedReason: "target-deleted" });
  });
});
