/**
 * Coordinator work on a node that leaves this registry (forgotten or handed
 * over) or stays unreachable for a day, on the real mail world. Only the leaf
 * is simulated (`FakeRemote`).
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { AgentTabState } from "@orkestrator/protocol/agent-registry";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CoordinatorRemoteAccess, RemoteWorkerState } from "./coordinator-remote.js";
import { selectCoordinatorWorkflowsToClear } from "./coordinator-workflow-retention.js";
import { seedStore } from "./storage-test-support.js";
import { MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS } from "./coordinator-workflow-retention.js";
import { NODE_OFFLINE_NOTICE_MS, CoordinatorNodeReleases } from "./coordinator-node-release.js";
import { WorkerTabCloseAdmission } from "./worker-tab-close-admission.js";

class FakeRemote implements CoordinatorRemoteAccess {
  available = true;
  tab: AgentTabState | "unknown" = "working";
  registered: Set<string> | null = null;
  reads = 0;
  collected: string[] = [];

  async workerState(): Promise<RemoteWorkerState> {
    this.reads += 1;
    if (!this.available) return "unavailable";
    return { environment: "running", tab: this.tab, name: "remote-worker" };
  }

  async collectMail(nodeId: string): Promise<boolean> {
    this.collected.push(nodeId);
    return true;
  }

  async lastAssistantExcerpt(): Promise<string | undefined> {
    return undefined;
  }

  async workflow() {
    this.reads += 1;
    if (!this.available) return "unavailable" as const;
    return null;
  }

  async environmentPr() {
    return {};
  }

  async nodeName(): Promise<string> {
    return "Build box";
  }

  async registeredNodeIds(): Promise<ReadonlySet<string>> {
    if (!this.registered) throw new Error("registry unavailable");
    return this.registered;
  }
}

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  setSystemTime();
});

async function remoteWorld() {
  const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
  worlds.push(world);
  const remote = new FakeRemote();
  world.coordinator.setRemoteAccess(remote);
  const main = await world.main();
  const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "remote-delegation",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
    kind: "environment",
    resourceId: "leaf-env",
    nodeId: "bk_leaf",
    requestId: "launch-remote",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    createdAt: new Date().toISOString(),
  });
  await world.storage.coordinators.openCoordinatorDelegation(
    new WorkerTabCloseAdmission(),
    association.id,
    "startup-agent",
  );
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "remote-pipeline",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
    kind: "build-pipeline",
    resourceId: "leaf-pipeline",
    nodeId: "bk_leaf",
    requestId: "launch-remote-pipeline",
    createdAt: new Date().toISOString(),
  });
  return { world, remote, main };
}

async function record(world: MailWorld, id: string) {
  return (
    await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
  ).find((entry) => entry.id === id);
}

test("failed release mail survives actual capacity cleanup and retries exactly once", async () => {
  const { world, remote, main } = await remoteWorld();
  remote.registered = new Set(["bk_leaf"]);
  const old = new Date(Date.now() - 26 * 3600_000).toISOString();
  const records = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  for (const item of records)
    await world.storage.coordinators.updateCoordinatorWorkflowAssociation(item.id, (current) => {
      current.createdAt = old;
      return true;
    });
  const send = spyOn(world.storage, "sendAgentMail").mockRejectedValue(
    new Error("temporary mail failure"),
  );
  await world.coordinator.nodesReleased([{ nodeId: "bk_leaf" }], "forgotten");
  send.mockRestore();
  const released = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  const filler = Array.from(
    { length: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - released.length },
    (_, i) => ({
      ...released[1]!,
      id: `history-${i}`,
      requestId: `history-${i}`,
      nodeRelease: { ...released[1]!.nodeRelease!, notifiedAt: old },
    }),
  );
  seedStore(`${world.root}/data`, "coordinators.json", {
    version: 1,
    workspaces: { [world.projectId]: (await world.coordinator.get(world.projectId))!.workspace },
    workflows: [...released, ...filler],
  });
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    ...released[1]!,
    id: "next",
    requestId: "next",
  });
  expect((await record(world, "remote-delegation"))?.nodeRelease?.notifiedAt).toBeUndefined();
  await world.coordinator.reconcileWorkerDelegations();
  await world.coordinator.reconcileWorkerDelegations();
  await world.deliver();
  expect(world.received(main)).toHaveLength(1);
});

test("released unresolved pipeline is never polled again", async () => {
  const { world, remote } = await remoteWorld();
  await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
    "remote-pipeline",
    (item) => {
      item.createsEnvironment = true;
      return true;
    },
  );
  await world.coordinator.nodesReleased([{ nodeId: "bk_leaf" }], "handed-over");
  const reads = remote.reads;
  await world.coordinator.reconcileWorkflowNotifications();
  await world.coordinator.reconcileWorkflowNotifications();
  expect(remote.reads).toBe(reads);
});

test("a new coordinator waiting during an already-noticed outage gets one notice", async () => {
  const { world } = await remoteWorld();
  const recipients: string[] = [];
  const release = new CoordinatorNodeReleases({
    storage: world.storage,
    mainAddress: async (id) => {
      recipients.push(id);
      return null;
    },
    nodeName: async () => "leaf",
    offlineNoticeMs: 0,
  });
  await release.noteRead("bk_leaf", false);
  const old = (await record(world, "remote-delegation"))!;
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    ...old,
    id: "second",
    requestId: "second",
    coordinatorId: "second-coordinator",
  });
  await release.noteRead("bk_leaf", false);
  await release.noteRead("bk_leaf", false);
  expect(recipients).toEqual([world.coordinatorId, "second-coordinator"]);
});

test("a report held before release is delivered as ordinary mail", async () => {
  const { world, main } = await remoteWorld();
  const report = await world.storage.sendAgentMail(
    {
      kind: "node",
      nodeId: "bk_leaf",
      nodeName: "Build box",
      role: "agent",
      projectId: world.projectId,
      environmentId: "leaf-env",
      tabId: "startup-agent",
      title: "worker",
    },
    {
      requestId: "held-before-release",
      toEnvironmentId: main.environmentId,
      toTabId: main.tabId,
      body: "Report before release.",
    },
  );
  expect(report.placement).toBe("inject-held");
  await world.coordinator.nodesReleased([{ nodeId: "bk_leaf" }], "forgotten");
  await world.coordinator.reconcileWorkerDelegations();
  await world.deliver();
  await world.finishTurn(main);
  expect(world.received(main).join("\n")).toContain("Report before release.");
});

test("partial and unsupported registries never close open work", async () => {
  const { world, remote, main } = await remoteWorld();
  remote.registeredNodeIds = async () => {
    const registry = await world.storage.nodes.getNodeRegistry(true);
    return new Set(registry.nodes.map((node) => node.nodeId));
  };
  for (const value of [
    { version: 2, nodes: [] },
    { version: 1, nodes: [{}] },
  ]) {
    seedStore(`${world.root}/data`, "node-registry.json", value);
    await world.coordinator.reconcileWorkerDelegations();
    expect((await record(world, "remote-delegation"))?.nodeRelease).toBeUndefined();
    expect((await record(world, "remote-delegation"))?.delegation?.state).toBe("running");
  }
  await world.deliver();
  expect(world.received(main)).toHaveLength(0);
});

describe("a released node", () => {
  test("forgetting closes its delegations as stopped, marks its workflows reported, and sends one notice", async () => {
    const { world, remote, main } = await remoteWorld();
    // The snapshot says how close the shared store is to its limit.
    expect((await world.coordinator.get(world.projectId))?.workflowStore).toBe("ok");

    await world.coordinator.nodesReleased([{ nodeId: "bk_leaf", name: "Build box" }], "forgotten");
    await world.deliver();

    const delegation = await record(world, "remote-delegation");
    expect(delegation?.delegation).toMatchObject({ state: "stopped" });
    expect(delegation?.delegation?.wokenAt).toBeDefined();
    expect(delegation?.nodeRelease).toMatchObject({ reason: "forgotten" });
    expect(delegation?.nodeRelease?.notifiedAt).toBeDefined();
    const pipeline = await record(world, "remote-pipeline");
    expect(pipeline?.terminalNotifiedAt).toBeDefined();
    expect(pipeline?.nodeRelease?.reason).toBe("forgotten");

    // One notice, naming both, in place of a per-worker wake.
    const received = world.received(main);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("The user forgot Machine Build box (nodeId bk_leaf)");
    expect(received[0]).toContain("closed as stopped");
    expect(received[0]).toContain("worker environment leaf-env (tab startup-agent)");
    expect(received[0]).toContain("build-pipeline leaf-pipeline");

    // Nothing on the node is read again, and nothing more is said.
    const reads = remote.reads;
    await world.coordinator.reconcileWorkflowNotifications();
    await world.coordinator.reconcileWorkerDelegations();
    await world.coordinator.nodesReleased([{ nodeId: "bk_leaf" }], "forgotten");
    await world.deliver();
    expect(remote.reads).toBe(reads);
    expect(world.received(main)).toHaveLength(1);
  });

  test("its records become clearable once the replay window passes", async () => {
    const { world } = await remoteWorld();
    const before = (
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
    ).filter((entry) => entry.nodeId);
    const later = Date.now() + 25 * 60 * 60 * 1000;
    // What the store's resource lookup answers: a remote resource is unknown
    // until its node is released (`workflowResourceState`).
    const resourceState = (entry: { nodeRelease?: unknown }) =>
      entry.nodeRelease ? ("missing" as const) : ("unknown" as const);
    // A remote record is never clearable while its node is controlled here.
    expect(
      selectCoordinatorWorkflowsToClear({
        workflows: before.map((entry) => ({ ...entry, terminalNotifiedAt: "x" })),
        environmentExists: () => false,
        resourceState,
        now: later,
      }).size,
    ).toBe(0);

    await world.coordinator.nodesReleased([{ nodeId: "bk_leaf" }], "forgotten");
    const after = (
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
    ).filter((entry) => entry.nodeId);
    expect(
      selectCoordinatorWorkflowsToClear({
        workflows: after,
        environmentExists: () => false,
        resourceState,
        now: later,
      }),
    ).toEqual(new Set(["remote-delegation", "remote-pipeline"]));
  });

  test("a handover says the work is no longer controlled here, not that it stopped", async () => {
    const { world, main } = await remoteWorld();

    await world.coordinator.nodesReleased(
      [{ nodeId: "bk_leaf", name: "Build box" }],
      "handed-over",
    );
    await world.deliver();

    expect((await record(world, "remote-delegation"))?.nodeRelease?.reason).toBe("handed-over");
    const [notice] = world.received(main);
    expect(notice).toContain("no longer controlled here");
    expect(notice).toContain("may still be running under that command node");
    expect(notice).not.toContain("stopped");
    expect(world.received(main)).toHaveLength(1);
  });

  test("records of a node forgotten before release existed are released on the sweep", async () => {
    const { world, remote, main } = await remoteWorld();
    // An unreadable registry proves nothing.
    await world.coordinator.reconcileWorkerDelegations();
    expect((await record(world, "remote-delegation"))?.delegation?.state).toBe("running");
    // A registered node is left alone.
    remote.registered = new Set(["bk_leaf"]);
    await world.coordinator.reconcileWorkerDelegations();
    expect((await record(world, "remote-delegation"))?.nodeRelease).toBeUndefined();

    remote.registered = new Set(["bk_other"]);
    await world.coordinator.reconcileWorkerDelegations();
    await world.deliver();
    expect(await record(world, "remote-delegation")).toMatchObject({
      delegation: { state: "stopped" },
      nodeRelease: { reason: "unregistered" },
    });
    const received = world.received(main);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("no longer registered on this command node");
  });
});

describe("a long-unreachable node", () => {
  test("one notice per offline episode after a day; the delegation stays open and its report still arrives", async () => {
    const { world, remote, main } = await remoteWorld();
    const start = Date.now();
    remote.available = false;

    await world.coordinator.reconcileWorkerDelegations();
    setSystemTime(new Date(start + NODE_OFFLINE_NOTICE_MS - 60_000));
    await world.coordinator.reconcileWorkerDelegations();
    await world.deliver();
    expect(world.received(main)).toHaveLength(0);

    setSystemTime(new Date(start + NODE_OFFLINE_NOTICE_MS + 60_000));
    await world.coordinator.reconcileWorkerDelegations();
    await world.coordinator.reconcileWorkerDelegations();
    await world.deliver();
    const received = world.received(main);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("Machine Build box (nodeId bk_leaf) has not answered since");
    expect(received[0]).toContain("Your delegation to worker environment leaf-env");
    expect(received[0]).toContain("stays open");
    expect((await record(world, "remote-delegation"))?.delegation?.state).toBe("running");

    await world.finishTurn(main);
    // An answer ends the episode; the next one is told again after another day.
    remote.available = true;
    await world.coordinator.reconcileWorkerDelegations();
    remote.available = false;
    const second = start + NODE_OFFLINE_NOTICE_MS + 120_000;
    setSystemTime(new Date(second));
    await world.coordinator.reconcileWorkerDelegations();
    setSystemTime(new Date(second + NODE_OFFLINE_NOTICE_MS + 60_000));
    await world.coordinator.reconcileWorkerDelegations();
    await world.deliver();
    expect(world.received(main)).toHaveLength(2);
    await world.finishTurn(main);

    // The worker's report is collected when the node comes back, and is the wake.
    const report = await world.storage.sendAgentMail(
      {
        kind: "node",
        nodeId: "bk_leaf",
        nodeName: "Build box",
        role: "agent",
        projectId: world.projectId,
        environmentId: "leaf-env",
        tabId: "startup-agent",
        title: "remote-worker",
      },
      {
        requestId: "report",
        toEnvironmentId: main.environmentId,
        toTabId: main.tabId,
        body: "Finished: tests pass.",
      },
    );
    expect(report.placement).toBe("inject-held");
    remote.available = true;
    remote.tab = "idle";
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    await world.deliver();
    expect(remote.collected).toContain("bk_leaf");
    expect((await record(world, "remote-delegation"))?.delegation).toMatchObject({
      state: "completed",
      wakeKind: "report",
    });
    expect(world.received(main).at(-1)).toBe("Finished: tests pass.");
  });
});
