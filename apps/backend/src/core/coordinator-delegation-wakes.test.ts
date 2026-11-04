/**
 * The delegation wake pass on the real mail world: a failing delegation costs
 * only itself, one that keeps failing is retired with one notice, and a call
 * made while a pass runs is not left for the next sweep.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";

import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import { CoordinatorService } from "./coordinator-service.js";
import { runCommand } from "./shell.js";
import { createEnvironment, createProject } from "./storage.js";

const worlds: MailWorld[] = [];
const roots: string[] = [];
let now: number;
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  now = Date.now();
  clock = spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  clock.mockRestore();
  for (const world of worlds.splice(0)) await world.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const RETIRE_ATTEMPTS = 10;

async function create(options: Parameters<typeof MailWorld.create>[0] = {}): Promise<MailWorld> {
  const world = await MailWorld.create(options);
  worlds.push(world);
  return world;
}

async function delegation(world: MailWorld, worker: MailActor) {
  const associations = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  return associations.find((item) => item.id === `launch-${worker.environmentId}`)!.delegation!;
}

function closeDelegation(world: MailWorld, worker: MailActor) {
  return world.storage.coordinators.closeCoordinatorDelegation(
    `launch-${worker.environmentId}`,
    "completed",
  );
}

/** Refuse wake notices for these workers; everything else goes through. */
function failNoticesFor(world: MailWorld, workers: MailActor[]) {
  const send = world.storage.sendAgentMail.bind(world.storage);
  const failing = new Set(workers.map((worker) => `launch-${worker.environmentId}`));
  return spyOn(world.storage, "sendAgentMail").mockImplementation((async (
    sender: Parameters<typeof send>[0],
    input: Parameters<typeof send>[1],
    options: Parameters<typeof send>[2],
  ) => {
    const request = input.requestId ?? "";
    if ([...failing].some((id) => request.startsWith(`delegation-${id}-`))) {
      throw new Error("wake refused");
    }
    return send(sender, input, options);
  }) as typeof world.storage.sendAgentMail);
}

/**
 * What reached the coordinator's inbox. A drain can dispatch mid-assertion and
 * leave the main busy, so tests with more than one message read this rather
 * than what has been delivered so far.
 */
async function inboxBodies(world: MailWorld, main: MailActor): Promise<string> {
  const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
  return inbox.messages.map((message) => message.body).join("\n");
}

async function runPasses(world: MailWorld, passes: number): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) await world.coordinator.deliverDelegationWakes();
}

describe("one failing delegation", () => {
  test("does not stop the wakes behind it", async () => {
    const world = await create();
    const main = await world.main();
    const failing = await world.addEnvironment("failing", { launched: true });
    const healthy = await world.addEnvironment("healthy", { launched: true });
    await closeDelegation(world, failing);
    await closeDelegation(world, healthy);
    const spy = failNoticesFor(world, [failing]);

    await world.coordinator.deliverDelegationWakes();
    await world.deliver();

    expect(world.received(main)).toHaveLength(1);
    expect(world.received(main)[0]).toContain(healthy.environmentId);
    expect((await delegation(world, healthy)).wokenAt).toBeString();
    expect((await delegation(world, failing)).wokenAt).toBeUndefined();

    // Once the fault clears the next pass finishes the job.
    spy.mockRestore();
    await world.coordinator.deliverDelegationWakes();
    expect((await delegation(world, failing)).wokenAt).toBeString();
    expect(await inboxBodies(world, main)).toContain(failing.environmentId);
  });

  test("in one project does not stop another project's wakes", async () => {
    const world = await create();
    const failing = await world.addEnvironment("failing", { launched: true });
    await closeDelegation(world, failing);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-second-project-"));
    roots.push(root);
    await runCommand("git", ["init", "-b", "main"], { cwd: root });
    const other = await world.storage.addProject(
      createProject("https://example.invalid/other.git", root),
    );
    const snapshot = await world.coordinator.ensure(other.id);
    const otherMain = coordinatorMainConversation(snapshot.workspace)!;
    await world.coordinator.assignConversationAgent(other.id, otherMain.id, "codex");
    const worker = createEnvironment(other.id, { name: "other", environmentType: "local" });
    worker.status = "running";
    await world.storage.addEnvironment(worker);
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "other-delegation",
      projectId: other.id,
      coordinatorId: snapshot.workspace.id,
      conversationId: otherMain.id,
      kind: "environment",
      resourceId: worker.id,
      requestId: "other-launch",
      createdAt: new Date().toISOString(),
      delegation: {
        requestedAt: new Date().toISOString(),
        workerTabId: "startup-agent",
        state: "completed",
      },
    });

    const ensure = world.coordinator.ensureMainConversation.bind(world.coordinator);
    const spy = spyOn(world.coordinator, "ensureMainConversation").mockImplementation(
      (projectId) => {
        if (projectId === world.projectId) throw new Error("this project cannot open a main");
        return ensure(projectId);
      },
    );

    await world.coordinator.deliverDelegationWakes();
    spy.mockRestore();

    expect(await world.storage.coordinators.listUnwokenCoordinatorDelegations()).toMatchObject([
      { id: `launch-${failing.environmentId}` },
    ]);
    const inbox = await world.storage.getAgentMailMailbox(
      coordinatorRuntimeId(snapshot.workspace.id, otherMain.id),
      otherMain.tabId,
    );
    expect(inbox.messages).toHaveLength(1);
  });

  test("does not stop the sweep's other delegations, or its later steps", async () => {
    const failing = { environmentId: "" };
    const world = await create({
      statusWakes: {
        workerActivity: async (environmentId) => {
          if (environmentId === failing.environmentId) throw new Error("unreadable");
          return "idle";
        },
      },
    });
    const main = await world.main();
    const bad = await world.addEnvironment("bad", { launched: true });
    failing.environmentId = bad.environmentId;
    const good = await world.addEnvironment("good", { launched: true });
    now += 60_000;

    const sync = world.storage.synchronizeAgentMailboxes.bind(world.storage);
    let syncs = 0;
    const syncSpy = spyOn(world.storage, "synchronizeAgentMailboxes").mockImplementation(() => {
      syncs += 1;
      return syncs === 1 ? Promise.reject(new Error("store busy")) : sync();
    });
    const release = spyOn(world.storage, "releaseOrphanedDelegationHolds");

    await world.coordinator.reconcileWorkerDelegations();
    syncSpy.mockRestore();

    expect((await delegation(world, bad)).state).toBe("running");
    expect((await delegation(world, good)).state).toBe("completed");
    expect(release).toHaveBeenCalledTimes(1);
    release.mockRestore();
    expect(await inboxBodies(world, main)).toContain(good.environmentId);
  });

  test("does not stop a turn-end edge settling the worker's other tabs", async () => {
    const world = await create();
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    const environmentId = worker.environmentId;
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "second-tab",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: main.conversationId!,
      kind: "environment",
      resourceId: environmentId,
      requestId: "second-tab-request",
      createdAt: new Date().toISOString(),
      delegation: {
        requestedAt: new Date().toISOString(),
        workerTabId: "second-tab",
        state: "running",
      },
    });
    const undelivered = world.storage.hasUndeliveredCoordinatorRequest.bind(world.storage);
    const spy = spyOn(world.storage, "hasUndeliveredCoordinatorRequest").mockImplementation(
      (id, tabId) =>
        tabId === "startup-agent"
          ? Promise.reject(new Error("unreadable"))
          : undelivered(id, tabId),
    );

    await world.coordinator.settleWorkerDelegations({ environmentId, state: "completed" });
    spy.mockRestore();

    expect((await delegation(world, worker)).state).toBe("running");
    const others = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
      world.projectId,
    );
    expect(others.find((item) => item.id === "second-tab")?.delegation?.state).toBe("completed");
  });

  test("on the remote path does not stop the worker's other delegations", async () => {
    const world = await create();
    const main = await world.main();
    for (const tab of ["first", "second"]) {
      await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
        id: `remote-${tab}`,
        projectId: world.projectId,
        coordinatorId: world.coordinatorId,
        conversationId: main.conversationId!,
        kind: "environment",
        resourceId: "leaf-env",
        nodeId: "bk_leaf",
        requestId: `remote-${tab}`,
        createdAt: new Date().toISOString(),
        delegation: {
          requestedAt: new Date().toISOString(),
          workerTabId: tab,
          state: "running",
        },
      });
    }
    world.coordinator.setRemoteAccess({
      workerState: async () => ({ environment: "missing", tab: "unknown" }),
      lastAssistantExcerpt: async () => undefined,
      workflow: async () => "unavailable",
      environmentPr: async () => ({}),
      nodeName: async () => "Leaf",
    });
    const close = world.storage.coordinators.closeCoordinatorDelegation.bind(
      world.storage.coordinators,
    );
    const spy = spyOn(world.storage.coordinators, "closeCoordinatorDelegation").mockImplementation(
      (id, ...rest) =>
        id === "remote-first" ? Promise.reject(new Error("store busy")) : close(id, ...rest),
    );

    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    spy.mockRestore();

    const associations = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
      world.projectId,
    );
    expect(associations.find((item) => item.id === "remote-first")?.delegation?.state).toBe(
      "running",
    );
    expect(associations.find((item) => item.id === "remote-second")?.delegation?.state).toBe(
      "stopped",
    );
  });
});

describe("a delegation that keeps failing", () => {
  test("is retired with one notice, keeping how the worker ended", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const spy = failNoticesFor(world, [worker]);

    await runPasses(world, RETIRE_ATTEMPTS - 1);
    expect((await delegation(world, worker)).wokenAt).toBeUndefined();
    await world.deliver();
    expect(world.wakes(main)).toBe(0);

    await runPasses(world, 1);
    const retired = await delegation(world, worker);
    expect(retired).toMatchObject({ state: "completed" });
    expect(retired.wokenAt).toBeString();
    expect(retired.wakeFailedAt).toBe(retired.wokenAt!);
    expect(await world.storage.coordinators.listUnwokenCoordinatorDelegations()).toEqual([]);

    // Nothing further is tried, however long the fault lasts.
    const attempts = spy.mock.calls.length;
    await runPasses(world, 3);
    expect(spy.mock.calls.length).toBe(attempts);
    spy.mockRestore();

    await world.deliver();
    expect(world.wakes(main)).toBe(1);
    expect(world.received(main)).toHaveLength(1);
    expect(world.received(main)[0]).toContain(`failed ${RETIRE_ATTEMPTS} times`);
    expect(world.received(main)[0]).toContain("will not be tried again");
    expect(world.carriers(main)[0]![0]!.notice).toMatchObject({
      state: "completed",
      tone: "failure",
    });
  });

  test("a burst of passes on a short fault does not retire it", async () => {
    const world = await create();
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const spy = failNoticesFor(world, [worker]);

    await runPasses(world, RETIRE_ATTEMPTS * 2);
    expect((await delegation(world, worker)).wokenAt).toBeUndefined();

    spy.mockRestore();
    await runPasses(world, 1);
    expect((await delegation(world, worker)).wakeFailedAt).toBeUndefined();
    await world.deliver();
    expect(world.received(main)[0]).toContain("without sending a report");
  });

  test("past the time bound it is retired on the next failure", async () => {
    const world = await create();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const spy = failNoticesFor(world, [worker]);

    await runPasses(world, RETIRE_ATTEMPTS);
    now += 10 * 60_000;
    await runPasses(world, 1);
    spy.mockRestore();

    expect((await delegation(world, worker)).wakeFailedAt).toBeString();
  });

  test("a success resets the count", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const first = await world.addEnvironment("first", { launched: true });
    await closeDelegation(world, first);
    const spy = failNoticesFor(world, [first]);
    await runPasses(world, RETIRE_ATTEMPTS - 1);
    spy.mockRestore();
    await runPasses(world, 1);

    const woken = await delegation(world, first);
    expect(woken.wokenAt).toBeString();
    expect(woken.wakeFailedAt).toBeUndefined();
  });

  test("is retired even when the notice cannot be sent", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const spy = spyOn(world.storage, "sendAgentMail").mockRejectedValue(new Error("store full"));

    await runPasses(world, RETIRE_ATTEMPTS);
    spy.mockRestore();

    expect((await delegation(world, worker)).wakeFailedAt).toBeString();
  });

  test("a report still held for it is released as ordinary mail on the sweep", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.send(worker, main, "My report.");
    await closeDelegation(world, worker);
    const spy = spyOn(world.storage, "releaseDelegationHeldAgentMail").mockRejectedValue(
      new Error("mail store fault"),
    );

    await runPasses(world, RETIRE_ATTEMPTS);
    spy.mockRestore();
    expect((await delegation(world, worker)).wakeFailedAt).toBeString();

    await world.coordinator.reconcileWorkerDelegations();
    const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
    const report = inbox.messages.find((message) => message.body === "My report.");
    expect(report?.placement).not.toBe("inject-held");
  });

  test("with messaging off it is held, not retired, and delivered when it returns", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, enabled: false },
    });

    await runPasses(world, RETIRE_ATTEMPTS * 2);
    now += 24 * 60 * 60_000;
    await runPasses(world, 1);
    const held = await delegation(world, worker);
    expect(held.wokenAt).toBeUndefined();
    expect(held.wakeFailedAt).toBeUndefined();

    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, enabled: true },
    });
    await runPasses(world, 1);
    expect((await delegation(world, worker)).wokenAt).toBeString();
    await world.deliver();
    expect(world.received(main)[0]).toContain("without sending a report");
  });

  test("with no room to open a main it is held, not retired", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    // The open-conversation limit, full of side agents, with the main closed.
    await world.coordinator.closeConversation(world.projectId, main.conversationId!);
    await world.storage.coordinators.mutateCoordinatorWorkspace(world.projectId, (current) => ({
      ...current!,
      conversations: [
        ...current!.conversations,
        ...Array.from({ length: 16 }, (_, index) => ({
          ...current!.conversations[0]!,
          id: `side-${index}`,
          tabId: `side-tab-${index}`,
          logicalSessionKey: `side-key-${index}`,
          closedAt: undefined,
          role: "side" as const,
          sideOrdinal: index + 1,
        })),
      ],
    }));

    await runPasses(world, RETIRE_ATTEMPTS * 2);

    const held = await delegation(world, worker);
    expect(held.wokenAt).toBeUndefined();
    expect(held.wakeFailedAt).toBeUndefined();
  });
});

describe("a delegation closing during a pass", () => {
  /** Hold the running pass inside its first send until `release` resolves. */
  function holdFirstSend(world: MailWorld) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = world.storage.sendAgentMail.bind(world.storage);
    const spy = spyOn(world.storage, "sendAgentMail").mockImplementation((async (
      ...args: Parameters<typeof send>
    ) => {
      entered.resolve();
      await release.promise;
      return send(...args);
    }) as typeof world.storage.sendAgentMail);
    return { entered, release, spy };
  }

  test("is delivered by the running pass's promise, not the next sweep", async () => {
    const world = await create();
    const main = await world.main();
    const first = await world.addEnvironment("first", { launched: true });
    const second = await world.addEnvironment("second", { launched: true });
    await closeDelegation(world, first);
    const { entered, release, spy } = holdFirstSend(world);

    const running = world.coordinator.deliverDelegationWakes();
    await entered.promise;
    await closeDelegation(world, second);
    const joined = world.coordinator.deliverDelegationWakes();
    release.resolve();
    await Promise.all([running, joined]);
    spy.mockRestore();

    expect((await delegation(world, first)).wokenAt).toBeString();
    expect((await delegation(world, second)).wokenAt).toBeString();
    expect(await inboxBodies(world, main)).toContain(second.environmentId);
  });

  test("any number of calls during a pass run one more pass", async () => {
    const world = await create();
    const first = await world.addEnvironment("first", { launched: true });
    await closeDelegation(world, first);
    const { entered, release, spy } = holdFirstSend(world);
    const passes = spyOn(
      world.coordinator as unknown as { deliverDelegationWakesOnce(): Promise<void> },
      "deliverDelegationWakesOnce",
    );

    const running = world.coordinator.deliverDelegationWakes();
    await entered.promise;
    const joined = Array.from({ length: 5 }, () => world.coordinator.deliverDelegationWakes());
    release.resolve();
    await Promise.all([running, ...joined]);

    expect(passes).toHaveBeenCalledTimes(2);
    // The extra pass found nothing left, so the wake was not sent twice.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    passes.mockRestore();
  });

  test("a call with nothing running starts a pass of its own", async () => {
    const world = await create();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    await world.coordinator.deliverDelegationWakes();
    expect((await delegation(world, worker)).wokenAt).toBeString();

    const next = await world.addEnvironment("next", { launched: true });
    await closeDelegation(world, next);
    await world.coordinator.deliverDelegationWakes();
    expect((await delegation(world, next)).wokenAt).toBeString();
  });

  test("a pass that cannot read its list rejects its callers and frees the next call", async () => {
    const world = await create();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const list = spyOn(
      world.storage.coordinators,
      "listUnwokenCoordinatorDelegations",
    ).mockRejectedValueOnce(new Error("store busy"));

    await expect(world.coordinator.deliverDelegationWakes()).rejects.toThrow("store busy");
    list.mockRestore();

    await world.coordinator.deliverDelegationWakes();
    expect((await delegation(world, worker)).wokenAt).toBeString();
  });
});

test("a new service forgets the count: a restart only restarts it", async () => {
  const world = await create({ delegations: { wakeRetireMinMs: 0 } });
  const worker = await world.addEnvironment("worker", { launched: true });
  await closeDelegation(world, worker);
  const spy = failNoticesFor(world, [worker]);
  await runPasses(world, RETIRE_ATTEMPTS - 1);
  spy.mockRestore();

  const restarted = new CoordinatorService(
    world.storage,
    () => ({ enabled: true, running: true, error: null }),
    undefined,
    undefined,
    { wakeRetireMinMs: 0 },
  );
  const failing = failNoticesFor(world, [worker]);
  await restarted.deliverDelegationWakes();
  failing.mockRestore();

  expect((await delegation(world, worker)).wakeFailedAt).toBeUndefined();
});
