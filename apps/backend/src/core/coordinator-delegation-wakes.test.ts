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

import { captureLogs } from "@orkestrator/protocol/testing/log-capture";

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
 * The subjects in the coordinator's inbox. A drain can dispatch mid-assertion and
 * leave the main busy, so tests with more than one message read this rather
 * than what has been delivered so far.
 */
async function inboxSubjects(world: MailWorld, main: MailActor): Promise<string> {
  const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
  return inbox.messages.map((message) => message.subject).join("\n");
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
    expect(await inboxSubjects(world, main)).toContain("Worker failing finished");
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
    expect(await inboxSubjects(world, main)).toContain("Worker good finished");
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

  for (const restart of [false, true]) {
    test(`retirement receipt failure resumes only retirement (restart=${restart})`, async () => {
      const world = await create({ delegations: { wakeRetireMinMs: 0 } });
      const main = await world.main();
      const worker = await world.addEnvironment("worker", { launched: true });
      await closeDelegation(world, worker);
      const ordinary = failNoticesFor(world, [worker]);
      const receipt = spyOn(
        world.storage.coordinators,
        "markCoordinatorDelegationWakeFailed",
      ).mockRejectedValueOnce(new Error("receipt write failed"));
      await runPasses(world, RETIRE_ATTEMPTS);
      ordinary.mockRestore();
      receipt.mockRestore();
      expect((await delegation(world, worker)).wakeRetirement).toBeDefined();
      expect((await delegation(world, worker)).wokenAt).toBeUndefined();
      if (restart) await world.restart();
      await world.coordinator.deliverDelegationWakes();
      expect((await delegation(world, worker)).wakeFailedAt).toBeString();
      await world.deliver();
      expect(world.received(main)).toHaveLength(1);
      expect(world.received(main)[0]).toContain("will not be tried again");
    });
  }

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

  test("keeps the wake owed when the retirement notice fails, then delivers on recovery", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const spy = spyOn(world.storage, "sendAgentMail").mockRejectedValue(new Error("store full"));

    await runPasses(world, RETIRE_ATTEMPTS);
    spy.mockRestore();

    expect((await delegation(world, worker)).wakeFailedAt).toBeUndefined();
    expect((await delegation(world, worker)).wokenAt).toBeUndefined();
    const main = await world.main();
    await runPasses(world, 1);
    expect((await delegation(world, worker)).wokenAt).toBeString();
    expect(await inboxSubjects(world, main)).toContain("wake failed");
  });

  test("keeps the wake owed without a main, then notifies a later main", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    await world.coordinator.closeConversation(world.projectId, main.conversationId!);
    const ensure = spyOn(world.coordinator, "ensureMainConversation").mockRejectedValue(
      new Error("cannot open main"),
    );
    await runPasses(world, RETIRE_ATTEMPTS);
    expect((await delegation(world, worker)).wokenAt).toBeUndefined();
    expect((await delegation(world, worker)).wakeFailedAt).toBeUndefined();
    ensure.mockRestore();
    await world.coordinator.ensureMainConversation(world.projectId);
    const later = await world.main();
    await runPasses(world, 1);
    expect((await delegation(world, worker)).wokenAt).toBeString();
    expect(await inboxSubjects(world, later)).toContain("wake failed");
  });

  test("a report still held for it is released as ordinary mail on the sweep", async () => {
    const world = await create({ delegations: { wakeRetireMinMs: 0 } });
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    const sent = await world.send(worker, main, "My report.");
    expect(sent.placement).toBe("inject-held");
    await closeDelegation(world, worker);
    const spy = spyOn(world.storage, "releaseDelegationHeldAgentMail").mockRejectedValue(
      new Error("mail store fault"),
    );

    await runPasses(world, RETIRE_ATTEMPTS);
    spy.mockRestore();
    expect((await delegation(world, worker)).wakeFailedAt).toBeString();

    await world.coordinator.reconcileWorkerDelegations();
    const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
    const report = inbox.messages.find((message) => message.id === sent.id);
    expect(report).toBeDefined();
    expect(report!.placement).not.toBe("inject-held");
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
    expect(await inboxSubjects(world, main)).toContain("Worker second finished");
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

  test("a request between the last pass and promise cleanup starts a new pass", async () => {
    const world = await create();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    const internal = world.coordinator as unknown as {
      deliverDelegationWakesOnce(): Promise<void>;
    };
    let next!: Promise<void>;
    const pass = spyOn(internal, "deliverDelegationWakesOnce");
    pass.mockImplementationOnce(() =>
      Promise.resolve().then(() => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            next = world.coordinator.deliverDelegationWakes();
          }),
        );
      }),
    );
    await world.coordinator.deliverDelegationWakes();
    await next;
    expect(pass).toHaveBeenCalledTimes(2);
    expect((await delegation(world, worker)).wokenAt).toBeString();
    pass.mockRestore();
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

describe("a main closed while its wake is on the way", () => {
  test("a close during main reconciliation leaves report kind unselected until adoption", async () => {
    const world = await create();
    const main = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.send(worker, main, "The report.");
    await closeDelegation(world, worker);
    const ensure = world.coordinator.ensureMainConversation.bind(world.coordinator);
    let closed = false;
    const spy = spyOn(world.coordinator, "ensureMainConversation").mockImplementation(
      async (...args) => {
        const result = await ensure(...args);
        if (!closed) {
          closed = true;
          await world.coordinator.closeConversation(world.projectId, main.conversationId!);
        }
        return result;
      },
    );
    await world.coordinator.deliverDelegationWakes();
    spy.mockRestore();
    expect((await delegation(world, worker)).wakeKind).toBeUndefined();
    await world.coordinator.deliverDelegationWakes();
    expect((await delegation(world, worker)).wakeKind).toBe("report");
    const next = await world.main();
    await world.deliver();
    expect(world.received(next)).toEqual(["The report."]);
    expect(world.wakes(main)).toBe(0);
  });

  /** Close the main just before, or just after, the wake reaches the mail store. */
  function closeDuringWake(
    world: MailWorld,
    main: MailActor,
    method: "sendAgentMail" | "releaseDelegationHeldAgentMail",
    when: "before" | "after",
  ) {
    const original = (world.storage[method] as (...args: unknown[]) => Promise<unknown>).bind(
      world.storage,
    );
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await world.coordinator.closeConversation(world.projectId, main.conversationId!);
    };
    return spyOn(world.storage, method).mockImplementation((async (...args: unknown[]) => {
      if (when === "before") await close();
      try {
        return await original(...args);
      } finally {
        if (when === "after") await close();
      }
    }) as never);
  }

  for (const when of ["before", "after"] as const) {
    test(`a notice sent ${when} the close reaches the next main once`, async () => {
      const world = await create();
      const main = await world.main();
      const worker = await world.addEnvironment("worker", { launched: true });
      await closeDelegation(world, worker);
      // Mid-turn, so the drain leaves what is placed here waiting in the inbox.
      world.startTurn(main);
      const spy = closeDuringWake(world, main, "sendAgentMail", when);

      await world.coordinator.deliverDelegationWakes();
      spy.mockRestore();
      expect((await delegation(world, worker)).wokenAt).toBeUndefined();

      await world.coordinator.deliverDelegationWakes();
      const woken = await delegation(world, worker);
      expect(woken.wokenAt).toBeString();
      expect(woken.wakeFailedAt).toBeUndefined();

      const next = await world.main();
      expect(next.conversationId).not.toBe(main.conversationId);
      await world.deliver();
      expect(world.received(next)).toHaveLength(1);
      expect(world.received(next)[0]).toContain("without sending a report");
      expect(world.wakes(main)).toBe(0);
    });

    test(`a report released ${when} the close reaches the next main`, async () => {
      const world = await create();
      const main = await world.main();
      const worker = await world.addEnvironment("worker", { launched: true });
      await world.send(worker, main, "The report.");
      await closeDelegation(world, worker);
      world.startTurn(main);
      const spy = closeDuringWake(world, main, "releaseDelegationHeldAgentMail", when);

      await world.coordinator.deliverDelegationWakes();
      spy.mockRestore();
      expect((await delegation(world, worker)).wokenAt).toBeUndefined();

      await world.coordinator.deliverDelegationWakes();
      expect((await delegation(world, worker)).wokenAt).toBeString();

      const next = await world.main();
      await world.deliver();
      expect(world.received(next)).toEqual(["The report."]);
      expect(world.wakes(main)).toBe(0);
    });
  }

  test("a main still open is stamped as before", async () => {
    const world = await create();
    const worker = await world.addEnvironment("worker", { launched: true });
    await closeDelegation(world, worker);
    await world.coordinator.deliverDelegationWakes();
    expect((await delegation(world, worker)).wokenAt).toBeString();
  });
});

describe("close, select and pause on the project's queue", () => {
  for (const operation of ["close", "select", "pause"] as const) {
    test(`${operation} waits for a create already running`, async () => {
      const world = await create();
      const main = await world.main();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const prune = world.storage.coordinators.pruneCoordinatorAttachmentDirectories.bind(
        world.storage.coordinators,
      );
      const spy = spyOn(
        world.storage.coordinators,
        "pruneCoordinatorAttachmentDirectories",
      ).mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return prune(...args);
      });
      const creating = world.coordinator.createConversation(world.projectId);
      await entered.promise;

      const order: string[] = [];
      const mutate = world.storage.coordinators.mutateCoordinatorWorkspace.bind(
        world.storage.coordinators,
      );
      const mutateSpy = spyOn(
        world.storage.coordinators,
        "mutateCoordinatorWorkspace",
      ).mockImplementation((...args) => {
        order.push("write");
        return mutate(...args);
      });
      const pending =
        operation === "close"
          ? world.coordinator.closeConversation(world.projectId, main.conversationId!)
          : operation === "select"
            ? world.coordinator.selectConversation(world.projectId, main.conversationId!)
            : world.coordinator.setPaused(world.projectId, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual([]);

      release.resolve();
      await creating;
      await pending;
      expect(order).toEqual(["write"]);
      mutateSpy.mockRestore();
      spy.mockRestore();
    });
  }

  test("a close's refusal still reaches its caller, and frees the queue", async () => {
    const world = await create();
    await expect(
      world.coordinator.closeConversation(world.projectId, "no-such-conversation"),
    ).rejects.toThrow("Coordinator conversation was not found");
    const main = await world.main();
    const snapshot = await world.coordinator.selectConversation(
      world.projectId,
      main.conversationId!,
    );
    expect(snapshot.workspace.selectedConversationId).toBe(main.conversationId!);
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

test("reconcile and wake-pass logs report scoped recovery", async () => {
  const world = await create();
  const worker = await world.addEnvironment("worker", { launched: true });
  const logs = captureLogs();
  const read = spyOn(world.storage, "getEnvironment").mockRejectedValueOnce(
    new Error("read fault"),
  );
  const sync = spyOn(world.storage, "synchronizeAgentMailboxes").mockRejectedValueOnce(
    new Error("mail fault"),
  );
  const list = spyOn(world.coordinator, "deliverDelegationWakes").mockRejectedValueOnce(
    new Error("list fault"),
  );
  try {
    await world.coordinator.reconcileWorkerDelegations();
    await world.coordinator.reconcileWorkerDelegations();
    expect(logs.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "throttle.recovered",
          // The sweep's mailbox sync is global: one site, not one per coordinator.
          fields: expect.objectContaining({ site: "mail.reconcile-failed" }),
        }),
        expect.objectContaining({
          event: "throttle.recovered",
          fields: expect.objectContaining({
            site: "delegation.reconcile-failed",
            scope: `launch-${worker.environmentId}`,
          }),
        }),
        expect.objectContaining({
          event: "throttle.recovered",
          fields: expect.objectContaining({ site: "delegation.wake-pass-failed" }),
        }),
      ]),
    );
  } finally {
    read.mockRestore();
    list.mockRestore();
    sync.mockRestore();
    logs.restore();
  }
});
