/**
 * The coordinator-repair sweep and coordinator reads on the real mail world:
 * the sweep does its global work once however many coordinators there are, a
 * read writes nothing, every path that opens a main takes over what a closed
 * main left, and a delegation wake costs two coordinator writes and one
 * announcement, in an order that survives a crash.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorConversation,
} from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import { runCommand } from "./shell.js";
import { createEnvironment, createProject } from "./storage.js";

const worlds: MailWorld[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function create(): Promise<MailWorld> {
  const world = await MailWorld.create();
  worlds.push(world);
  return world;
}

type Coordinator = { projectId: string; coordinatorId: string; main: MailActor };

function actor(coordinatorId: string, conversation: CoordinatorConversation): MailActor {
  return {
    name: conversation.title,
    environmentId: coordinatorRuntimeId(coordinatorId, conversation.id),
    tabId: conversation.tabId,
    logicalSessionKey: conversation.logicalSessionKey,
    role: "coordinator",
    conversationId: conversation.id,
  };
}

/** The world's own coordinator, in the shape `addProject` returns. */
async function own(world: MailWorld): Promise<Coordinator> {
  return {
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    main: await world.main(),
  };
}

/** Another project on the same backend, with its own assigned main coordinator. */
async function addProject(world: MailWorld, name: string): Promise<Coordinator> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ork-sweep-${name}-`));
  roots.push(root);
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  const project = await world.storage.addProject(
    createProject(`https://example.invalid/${name}.git`, root),
  );
  await world.storage.patchRepositorySettings(project.id, { coordinatorOtherEnvironments: true });
  const snapshot = await world.coordinator.ensure(project.id);
  const main = coordinatorMainConversation(snapshot.workspace)!;
  const assigned = await world.coordinator.assignConversationAgent(project.id, main.id, "codex");
  return {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    main: actor(assigned.workspace.id, coordinatorMainConversation(assigned.workspace)!),
  };
}

/** A worker environment with one native tab and a delegation its coordinator opened. */
async function addWorker(
  world: MailWorld,
  owner: Coordinator,
  name: string,
  conversationId = owner.main.conversationId!,
): Promise<MailActor & { associationId: string }> {
  const environment = createEnvironment(owner.projectId, { name, environmentType: "local" });
  environment.status = "running";
  environment.setupPhase = "ready";
  environment.setupScriptsComplete = true;
  await world.storage.addEnvironment(environment);
  await world.storage.savePaneLayout(
    environment.id,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: { environmentId: environment.id, platform: "codex" },
          },
        ],
        activeTabId: "startup-agent",
      },
    },
    0,
  );
  const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: `launch-${environment.id}`,
    projectId: owner.projectId,
    coordinatorId: owner.coordinatorId,
    conversationId,
    kind: "environment",
    resourceId: environment.id,
    requestId: `launch-${name}`,
    createdAt: new Date().toISOString(),
  });
  await world.storage.coordinators.openCoordinatorDelegation(
    world.coordinatorRequests.workerTabs,
    association.id,
    "startup-agent",
  );
  await world.storage.synchronizeAgentMailboxes();
  return {
    name,
    environmentId: environment.id,
    tabId: "startup-agent",
    logicalSessionKey: `env-${environment.id}:startup-agent`,
    role: "worker",
    associationId: association.id,
  };
}

/** A worker's report to its coordinator, as its mail tool sends it. */
function report(world: MailWorld, owner: Coordinator, worker: MailActor, body: string) {
  return world.storage.sendAgentMail(
    {
      kind: "tab",
      projectId: owner.projectId,
      environmentId: worker.environmentId,
      tabId: worker.tabId,
    },
    {
      requestId: `report-${worker.environmentId}-${body.length}`,
      toEnvironmentId: owner.main.environmentId,
      toTabId: owner.main.tabId,
      body,
    },
  );
}

/**
 * Close the main and open the next one by a path that moves nothing, as a
 * restored or migrated store would, so only the sweep can carry the mail.
 */
async function replaceMainWithoutRepair(world: MailWorld, owner: Coordinator): Promise<MailActor> {
  await world.coordinator.closeConversation(owner.projectId, owner.main.conversationId!);
  const before = (await world.storage.coordinators.getCoordinatorWorkspace(owner.projectId))!;
  await world.storage.coordinators.mutateCoordinatorWorkspace(owner.projectId, (current) => {
    const template = current!.conversations.find((item) => item.id === owner.main.conversationId)!;
    const id = `next-${before.conversations.length}`;
    return {
      ...current!,
      conversations: [
        ...current!.conversations,
        {
          ...template,
          id,
          tabId: `coordinator-${id}`,
          logicalSessionKey: `env-${coordinatorRuntimeId(current!.id, id)}:coordinator-${id}`,
          closedAt: undefined,
          providerSessionId: undefined,
        },
      ],
    };
  });
  await world.storage.synchronizeAgentMailboxes();
  const workspace = (await world.storage.coordinators.getCoordinatorWorkspace(owner.projectId))!;
  return actor(workspace.id, coordinatorMainConversation(workspace)!);
}

/** A mailbox's messages, bodies included. */
async function inbox(world: MailWorld, mailbox: MailActor) {
  const page = await world.storage.getAgentMailMailbox(mailbox.environmentId, mailbox.tabId);
  return Promise.all(
    page.messages.map((message) =>
      world.storage.getAgentMailMessage(mailbox.environmentId, mailbox.tabId, message.id),
    ),
  );
}

async function delegationOf(world: MailWorld, associationId: string) {
  const all = (await world.storage.coordinators.getCoordinatorReconciliationState()).workflows;
  return all.find((item) => item.id === associationId)!.delegation!;
}

function countCalls<T extends object>(target: T, method: keyof T & string) {
  return spyOn(target, method as never);
}

describe("the sweep's global work", () => {
  test("runs the mailbox sync and the delegation scans once for several coordinators", async () => {
    const world = await create();
    const coordinators = [
      await own(world),
      await addProject(world, "second"),
      await addProject(world, "third"),
    ];
    for (const [index, owner] of coordinators.entries()) {
      await addWorker(world, owner, `worker-${index}-a`);
      await addWorker(world, owner, `worker-${index}-b`);
    }
    // The setup's pane-layout and environment writes arm the mail service's
    // debounced presence sync (250 ms). Under load the sweep outlasts it and
    // that unrelated sync was counted as the sweep's own (flaky-test 9844).
    await world.mail.shutdown();
    const sync = countCalls(world.storage, "synchronizeAgentMailboxes");
    const perProject = countCalls(
      world.storage.coordinators,
      "listCoordinatorWorkflowAssociations",
    );
    const state = countCalls(world.storage.coordinators, "getCoordinatorReconciliationState");
    const owed = countCalls(world.storage.coordinators, "listOwedCoordinatorDelegationIds");
    const open = countCalls(world.storage.coordinators, "listOpenCoordinatorDelegations");
    try {
      await world.coordinator.reconcileWorkerDelegations();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(perProject).not.toHaveBeenCalled();
      expect(state).toHaveBeenCalledTimes(1);
      // Once for the mail moves and once, after the wakes, for orphaned holds.
      expect(owed).toHaveBeenCalledTimes(2);
      // Six open delegations and nothing written: the list is read once, and
      // the re-check under each worker's lock does not read it again.
      expect(open).toHaveBeenCalledTimes(1);
      expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(6);
    } finally {
      for (const spy of [sync, perProject, state, owed, open]) spy.mockRestore();
    }
  });

  test("delivers owed wakes across workspaces and measures their extra repair syncs", async () => {
    const world = await create();
    const owners = [await own(world), await addProject(world, "owed-second")];
    const workers = [];
    for (const owner of owners) {
      for (let index = 0; index < 2; index++) {
        const worker = await addWorker(world, owner, `owed-${index}`);
        await report(world, owner, worker, `Report ${index}`);
        await world.storage.coordinators.closeCoordinatorDelegation(
          worker.associationId,
          "completed",
        );
        workers.push(worker);
      }
    }
    await world.mail.shutdown();
    const sync = countCalls(world.storage, "synchronizeAgentMailboxes");
    try {
      await world.coordinator.reconcileWorkerDelegations();
      // The global repair is once; each wake still performs its own lifecycle
      // repair, tracked separately in follow-up 6660 task 2.
      expect(sync).toHaveBeenCalledTimes(1 + workers.length);
    } finally {
      sync.mockRestore();
    }
    for (const worker of workers) {
      expect((await delegationOf(world, worker.associationId)).wokenAt).toBeString();
    }
    for (const owner of owners) {
      const messages = await inbox(world, owner.main);
      expect(messages).toHaveLength(2);
      expect(messages.every((message) => message.placement !== "inject-held")).toBe(true);
    }
  });

  test("remote re-check sees a follow-up committed during mail collection", async () => {
    const world = await create();
    const owner = await own(world);
    const id = "remote-revision";
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id,
      projectId: owner.projectId,
      coordinatorId: owner.coordinatorId,
      conversationId: owner.main.conversationId!,
      kind: "environment",
      resourceId: "leaf-env",
      nodeId: "leaf",
      requestId: id,
      createdAt: new Date().toISOString(),
      delegation: {
        requestedAt: new Date(0).toISOString(),
        workerTabId: "worker",
        state: "running",
      },
    });
    world.coordinator.setRemoteAccess({
      workerState: async () => ({ environment: "running", tab: "idle" }),
      collectMail: async () => {
        await world.storage.coordinators.updateCoordinatorWorkflowAssociation(id, (current) => {
          current.delegation!.requestedAt = new Date(Date.now() + 60_000).toISOString();
          return true;
        });
        return true;
      },
      lastAssistantExcerpt: async () => undefined,
      workflow: async () => "unavailable",
      environmentPr: async () => ({}),
      nodeName: async () => "Leaf",
    });
    await world.coordinator.reconcileWorkerDelegations();
    expect((await delegationOf(world, id)).state).toBe("running");
    expect(await inbox(world, owner.main)).toHaveLength(0);
  });

  test("re-checks a delegation against a fresh read once the store has changed", async () => {
    const world = await create();
    const owner = await own(world);
    const first = await addWorker(world, owner, "first");
    const second = await addWorker(world, owner, "second");
    // The first delegation's environment is gone, so the sweep closes it; the
    // second is then re-checked against the store that close produced.
    await world.storage.removeEnvironment(first.environmentId);
    const open = countCalls(world.storage.coordinators, "listOpenCoordinatorDelegations");
    try {
      await world.coordinator.reconcileWorkerDelegations();
      expect(open.mock.calls.length).toBeGreaterThan(1);
    } finally {
      open.mockRestore();
    }
    expect((await delegationOf(world, first.associationId)).state).toBe("stopped");
    expect((await delegationOf(world, second.associationId)).state).toBe("running");
  });

  test("moves each closed main's mail to its own next main in one pass", async () => {
    const world = await create();
    const coordinators = [await own(world), await addProject(world, "second")];
    const workers = [];
    for (const [index, owner] of coordinators.entries()) {
      const worker = await addWorker(world, owner, `worker-${index}`);
      await report(world, owner, worker, `Report from worker ${index}.`);
      workers.push(worker);
    }
    const nexts = [];
    for (const owner of coordinators) nexts.push(await replaceMainWithoutRepair(world, owner));
    for (const next of nexts) expect(await inbox(world, next)).toHaveLength(0);

    await world.coordinator.reconcileWorkerDelegations();

    for (const [index, next] of nexts.entries()) {
      const moved = await inbox(world, next);
      // Only its own coordinator's mail, still held for the delegation that owes it.
      expect(moved.map((message) => message.body)).toEqual([`Report from worker ${index}.`]);
      expect(moved[0]!.placement).toBe("inject-held");
    }
    // Once the workers finish, each report is its coordinator's one wake.
    for (const [index, worker] of workers.entries()) {
      await world.coordinator.settleWorkerDelegations({
        environmentId: worker.environmentId,
        tabId: worker.tabId,
        state: "completed",
      });
      expect((await delegationOf(world, worker.associationId)).wakeKind).toBe("report");
      const delivered = await inbox(world, nexts[index]!);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.placement).not.toBe("inject-held");
    }
  });
});

describe("a coordinator read", () => {
  /** A closed side conversation still owing work, which only a repair would adopt. */
  async function pendingRepair(world: MailWorld) {
    const owner = await own(world);
    const side = await world.addSide();
    const worker = await addWorker(world, owner, "side-worker", side.conversationId!);
    await world.storage.coordinators.mutateCoordinatorWorkspace(world.projectId, (current) => ({
      ...current!,
      conversations: current!.conversations.map((item) =>
        item.id === side.conversationId ? { ...item, closedAt: new Date().toISOString() } : item,
      ),
    }));
    return { owner, side, worker };
  }

  test("repairs nothing and writes nothing; the sweep still does the repair", async () => {
    const world = await create();
    const { owner, worker } = await pendingRepair(world);
    // Isolate reads from the independent mail delivery service.
    await world.mail.shutdown();
    const commands = createCommandRegistry();
    const context = { storage: world.storage, coordinators: world.coordinator } as CommandContext;
    const announced: string[] = [];
    const stop = world.storage.addResourceChangeListener((change) => {
      announced.push(change.resource);
    });
    const sync = countCalls(world.storage, "synchronizeAgentMailboxes");
    const move = countCalls(world.storage, "moveClosedCoordinatorMail");
    const before = world.storage.coordinators.coordinatorStoreRevision();
    try {
      await world.coordinator.get(world.projectId);
      await commands.get("get_project_coordinator")!({ projectId: world.projectId }, context);
      await commands.get("get_project_coordinator_view")!({ projectId: world.projectId }, context);
      expect(world.storage.coordinators.coordinatorStoreRevision()).toBe(before);
      expect(announced).toEqual([]);
      expect(sync).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
    } finally {
      sync.mockRestore();
      move.mockRestore();
      stop();
    }
    const association = (
      await world.storage.coordinators.getCoordinatorReconciliationState()
    ).workflows.find((item) => item.id === worker.associationId)!;
    expect(association.conversationId).not.toBe(owner.main.conversationId);

    await world.coordinator.reconcileWorkerDelegations();
    const adopted = (
      await world.storage.coordinators.getCoordinatorReconciliationState()
    ).workflows.find((item) => item.id === worker.associationId)!;
    expect(adopted.conversationId).toBe(owner.main.conversationId);
  });

  test("a new unassigned side has a mailbox before any read or assignment", async () => {
    const world = await create();
    const snapshot = await world.coordinator.createConversation(world.projectId);
    const side = snapshot.workspace.conversations.find(
      (item) => item.role === "side" && !item.closedAt,
    )!;
    expect(side.agent).toBeUndefined();
    expect(await inbox(world, actor(snapshot.workspace.id, side))).toEqual([]);
  });

  test("closing a side conversation still moves its open work to the main at once", async () => {
    const world = await create();
    const owner = await own(world);
    const side = await world.addSide();
    const worker = await addWorker(world, owner, "side-worker", side.conversationId!);
    await world.coordinator.closeConversation(world.projectId, side.conversationId!);
    const adopted = (
      await world.storage.coordinators.getCoordinatorReconciliationState()
    ).workflows.find((item) => item.id === worker.associationId)!;
    expect(adopted.conversationId).toBe(owner.main.conversationId);
  });
});

describe("a main opened after the last one closed", () => {
  test("from New conversation takes over the held report, unassigned", async () => {
    const world = await create();
    const owner = await own(world);
    const worker = await addWorker(world, owner, "worker");
    await report(world, owner, worker, "The report.");
    await world.closeMain();

    const snapshot = await world.coordinator.createConversation(world.projectId);
    const main = coordinatorMainConversation(snapshot.workspace)!;
    expect(main.agent).toBeUndefined();
    const moved = await inbox(world, actor(snapshot.workspace.id, main));
    expect(moved.map((message) => message.body)).toEqual(["The report."]);
    expect(moved[0]!.placement).toBe("inject-held");
  });

  test("every path that opens a main goes through ensureMainConversation", async () => {
    const world = await create();
    const opens = spyOn(world.coordinator, "ensureMainConversation");
    try {
      const other = await addProject(world, "opened");
      expect(opens).toHaveBeenCalledWith(other.projectId, { opened: true });
      opens.mockClear();

      const owner = await own(world);
      const side = await world.addSide();
      const worker = await addWorker(world, owner, "side-worker", side.conversationId!);
      await world.closeMain();
      opens.mockClear();
      const snapshot = await world.coordinator.createConversation(world.projectId);
      expect(opens).toHaveBeenCalledTimes(1);
      expect(opens).toHaveBeenCalledWith(world.projectId, { opened: true });
      // A main the user just opened stays unassigned, and an open side keeps
      // its own work.
      expect(coordinatorMainConversation(snapshot.workspace)!.agent).toBeUndefined();
      const association = (
        await world.storage.coordinators.getCoordinatorReconciliationState()
      ).workflows.find((item) => item.id === worker.associationId)!;
      expect(association.conversationId).toBe(side.conversationId);
    } finally {
      opens.mockRestore();
    }
  });

  test("a failed replacement-main repair cannot turn a held report into a silent-worker notice", async () => {
    const world = await create();
    const owner = await own(world);
    const worker = await addWorker(world, owner, "worker");
    await report(world, owner, worker, "Recovered report.");
    await world.closeMain();
    const sync = spyOn(world.storage, "synchronizeAgentMailboxes").mockRejectedValueOnce(
      new Error("temporary mailbox failure"),
    );
    let snapshot;
    try {
      snapshot = await world.coordinator.createConversation(world.projectId);
    } finally {
      sync.mockRestore();
    }
    await world.coordinator.settleWorkerDelegations({
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      state: "completed",
    });
    const main = coordinatorMainConversation(snapshot.workspace)!;
    const messages = await inbox(world, actor(snapshot.workspace.id, main));
    expect(messages.map((message) => message.body)).toEqual(["Recovered report."]);
    expect(messages[0]!.placement).not.toBe("inject-held");
    expect((await delegationOf(world, worker.associationId)).wakeKind).toBe("report");
  });

  test("from a wake takes over the held report", async () => {
    const world = await create();
    const owner = await own(world);
    const worker = await addWorker(world, owner, "worker");
    await report(world, owner, worker, "The report.");
    await world.closeMain();

    await world.coordinator.settleWorkerDelegations({
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      state: "completed",
    });
    const next = await world.main();
    expect(next.conversationId).not.toBe(owner.main.conversationId);
    const delivered = await inbox(world, next);
    expect(delivered.map((message) => message.body)).toEqual(["The report."]);
    expect((await delegationOf(world, worker.associationId)).wakeKind).toBe("report");
  });
});

describe("one delegation wake", () => {
  /** Coordinator-store writes and coordinator announcements while `work` runs. */
  async function observe(world: MailWorld, work: () => Promise<void>) {
    const coordinators = world.storage.coordinators;
    const start = coordinators.coordinatorStoreRevision() ?? 0;
    const announced: number[] = [];
    const stop = world.storage.addResourceChangeListener((change) => {
      if (change.resource === "coordinator") {
        announced.push((coordinators.coordinatorStoreRevision() ?? 0) - start);
      }
    });
    try {
      await work();
    } finally {
      stop();
    }
    return { writes: (coordinators.coordinatorStoreRevision() ?? 0) - start, announced };
  }

  test("a silent worker after a repaired replacement main still writes twice", async () => {
    const world = await create();
    const previous = await own(world);
    await world.closeMain();
    const snapshot = await world.coordinator.createConversation(world.projectId);
    const main = coordinatorMainConversation(snapshot.workspace)!;
    await world.coordinator.assignConversationAgent(world.projectId, main.id, "codex");
    const owner = await own(world);
    expect(owner.main.conversationId).not.toBe(previous.main.conversationId);
    const worker = await addWorker(world, owner, "silent-after-replacement");
    const observed = await observe(world, () =>
      world.coordinator.settleWorkerDelegations({
        environmentId: worker.environmentId,
        tabId: worker.tabId,
        state: "completed",
      }),
    );
    expect(observed).toEqual({ writes: 2, announced: [2] });
    expect(await delegationOf(world, worker.associationId)).toMatchObject({
      wakeKind: "notice",
      wokenAt: expect.any(String),
    });
    expect(await inbox(world, owner.main)).toHaveLength(1);
  });

  test("with no open main defers kind selection until delivery opens one", async () => {
    const world = await create();
    const owner = await own(world);
    const worker = await addWorker(world, owner, "silent-without-main");
    await world.closeMain();
    const coordinators = world.storage.coordinators;
    const prepare = coordinators.prepareCoordinatorDelegationWake.bind(coordinators);
    const seen: Array<{ state: string; wakeKind?: string }> = [];
    const spy = spyOn(coordinators, "prepareCoordinatorDelegationWake").mockImplementation(
      async (...args) => {
        const delegation = await delegationOf(world, worker.associationId);
        seen.push({ state: delegation.state, wakeKind: delegation.wakeKind });
        return prepare(...args);
      },
    );
    try {
      await world.coordinator.settleWorkerDelegations({
        environmentId: worker.environmentId,
        tabId: worker.tabId,
        state: "completed",
      });
      expect(seen).toEqual([{ state: "completed", wakeKind: undefined }]);
      expect(spy).toHaveBeenCalledWith(worker.associationId, "notice");
    } finally {
      spy.mockRestore();
    }
    const replacement = await world.main();
    expect(replacement.conversationId).not.toBe(owner.main.conversationId);
    expect(await delegationOf(world, worker.associationId)).toMatchObject({
      wakeKind: "notice",
      wokenAt: expect.any(String),
    });
    expect(await inbox(world, replacement)).toHaveLength(1);
  });

  for (const kind of ["report", "notice"] as const) {
    test(`with a ${kind} writes close and kind, delivers, then stamps, announcing once`, async () => {
      const world = await create();
      const owner = await own(world);
      const worker = await addWorker(world, owner, "worker");
      if (kind === "report") await report(world, owner, worker, "The report.");
      const coordinators = world.storage.coordinators;
      const start = coordinators.coordinatorStoreRevision() ?? 0;
      const seen: Array<{ writes: number; state: string; wakeKind?: string; woken: boolean }> = [];
      const method = kind === "report" ? "releaseDelegationHeldAgentMail" : "sendAgentMail";
      const deliver = world.storage[method].bind(world.storage) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const spy = spyOn(world.storage, method).mockImplementation((async (...args: unknown[]) => {
        const delegation = await delegationOf(world, worker.associationId);
        seen.push({
          writes: (coordinators.coordinatorStoreRevision() ?? 0) - start,
          state: delegation.state,
          ...(delegation.wakeKind ? { wakeKind: delegation.wakeKind } : {}),
          woken: delegation.wokenAt !== undefined,
        });
        return deliver(...args);
      }) as never);
      try {
        const observed = await observe(world, () =>
          world.coordinator.settleWorkerDelegations({
            environmentId: worker.environmentId,
            tabId: worker.tabId,
            state: "completed",
          }),
        );
        // Delivery sits between the two writes: closed with its kind, not yet woken.
        expect(seen).toEqual([{ writes: 1, state: "completed", wakeKind: kind, woken: false }]);
        expect(observed.writes).toBe(2);
        // One announcement, after the final write.
        expect(observed.announced).toEqual([2]);
      } finally {
        spy.mockRestore();
      }
      expect((await delegationOf(world, worker.associationId)).wokenAt).toBeString();
      expect(await inbox(world, owner.main)).toHaveLength(1);
    });

    test(`with a ${kind}, a crash between delivery and its stamp wakes once`, async () => {
      const world = await create();
      const owner = await own(world);
      const worker = await addWorker(world, owner, "worker");
      if (kind === "report") await report(world, owner, worker, "The report.");
      // The process dies once the wake is in the mail store, before `wokenAt`.
      const crash = spyOn(
        world.storage.coordinators,
        "markCoordinatorDelegationWoken",
      ).mockRejectedValueOnce(new Error("process killed"));
      await world.coordinator.settleWorkerDelegations({
        environmentId: worker.environmentId,
        tabId: worker.tabId,
        state: "completed",
      });
      crash.mockRestore();
      const after = await delegationOf(world, worker.associationId);
      expect(after).toMatchObject({ state: "completed", wakeKind: kind });
      expect(after.wokenAt).toBeUndefined();

      await world.restart();
      await world.coordinator.deliverDelegationWakes();
      expect((await delegationOf(world, worker.associationId)).wokenAt).toBeString();
      const messages = await inbox(world, owner.main);
      expect(messages).toHaveLength(1);
      if (kind === "report") expect(messages[0]!.body).toBe("The report.");
      else expect(messages[0]!.body).toContain("without sending a report");
    });
  }

  test("that cannot be delivered still announces its close once", async () => {
    const world = await create();
    const owner = await own(world);
    const worker = await addWorker(world, owner, "worker");
    const refuse = spyOn(world.storage, "sendAgentMail").mockRejectedValue(
      new Error("mail store unavailable"),
    );
    try {
      const observed = await observe(world, () =>
        world.coordinator.settleWorkerDelegations({
          environmentId: worker.environmentId,
          tabId: worker.tabId,
          state: "completed",
        }),
      );
      expect(observed.writes).toBe(1);
      expect(observed.announced).toEqual([1]);
      // A retry that fails again announces nothing more.
      const retried = await observe(world, () => world.coordinator.deliverDelegationWakes());
      expect(retried).toEqual({ writes: 0, announced: [] });
    } finally {
      refuse.mockRestore();
    }
    expect((await delegationOf(world, worker.associationId)).wakeKind).toBe("notice");
  });
});
