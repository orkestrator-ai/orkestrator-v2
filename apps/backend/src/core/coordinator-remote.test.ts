/**
 * Coordinator work on another node, on the real mail world: delegations to a
 * leaf worker settle from that node's state, a held report is released as the
 * wake, and a leaf's workflow reaches the coordinator as a status wake. Only
 * the leaf is simulated (`FakeRemote`).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { AGENT_MAIL_LOOP_BUDGET_REASON } from "@orkestrator/protocol/agent-mail";
import type { AgentTabState } from "@orkestrator/protocol/agent-registry";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type {
  CoordinatorRemoteAccess,
  RemoteWorkerState,
  RemoteWorkflowRecord,
} from "./coordinator-remote.js";
import { NodeMailCollector } from "./nodes/node-mail-collector.js";
import { statusOnNode } from "./coordinator-status-wakes.js";

class FakeRemote implements CoordinatorRemoteAccess {
  available = true;
  environment: Exclude<RemoteWorkerState, "unavailable">["environment"] = "running";
  tab: AgentTabState | "unknown" = "working";
  workflows = new Map<string, RemoteWorkflowRecord>();
  excerpt: string | undefined;
  requestPending = false;
  backgroundWorkPending = false;
  collected: string[] = [];

  async workerState(): Promise<RemoteWorkerState> {
    if (!this.available) return "unavailable";
    return {
      environment: this.environment,
      tab: this.tab,
      name: "remote-worker",
      requestPending: this.requestPending,
      backgroundWorkPending: this.backgroundWorkPending,
    };
  }

  async collectMail(nodeId: string): Promise<boolean> {
    this.collected.push(nodeId);
    return true;
  }

  async lastAssistantExcerpt(): Promise<string | undefined> {
    return this.excerpt;
  }

  async workflow(_nodeId: string, _kind: string, id: string) {
    if (!this.available) return "unavailable" as const;
    return this.workflows.get(id) ?? null;
  }

  async environmentPr() {
    return {};
  }

  async nodeName(): Promise<string> {
    return "Build box";
  }
}

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  setSystemTime();
});

async function remoteWorld() {
  // Notices are delivered at once rather than after a coalescing window.
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
  await world.storage.coordinators.openCoordinatorDelegation(association.id, "startup-agent");
  return { world, remote, main, association };
}

async function delegationState(world: MailWorld, id: string) {
  const associations = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  return associations.find((entry) => entry.id === id)?.delegation;
}

describe("remote delegations", () => {
  test("close when the remote worker's turn ends, and wake the coordinator once", async () => {
    const { world, remote, main, association } = await remoteWorld();

    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    expect((await delegationState(world, association.id))?.state).toBe("running");

    remote.tab = "idle";
    remote.excerpt = "All green.";
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    await world.deliver();

    const delegation = await delegationState(world, association.id);
    expect(delegation).toMatchObject({ state: "completed", wakeKind: "notice" });
    expect(delegation?.wokenAt).toBeDefined();
    const [notice] = world.received(main);
    expect(notice).toContain("Worker environment leaf-env on Build box (nodeId bk_leaf)");
    expect(notice).toContain('"nodeId": "bk_leaf"');
    expect(notice).toContain("Last message: All green.");
    expect(world.wakes(main)).toBe(1);
  });

  test("idle remote turns hold while background work runs, then close when it ends", async () => {
    const { world, remote, main, association } = await remoteWorld();
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    remote.tab = "idle";
    remote.backgroundWorkPending = true;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    setSystemTime(new Date(Date.now() + 60_000));
    await world.coordinator.reconcileWorkerDelegations();
    expect((await delegationState(world, association.id))?.state).toBe("running");
    expect(world.wakes(main)).toBe(0);
    remote.backgroundWorkPending = false;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    expect((await delegationState(world, association.id))?.state).toBe("completed");
  });

  test("remote background holds restart on resumed work and expire after two minutes", async () => {
    const { world, remote, main, association } = await remoteWorld();
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    remote.tab = "idle";
    remote.backgroundWorkPending = true;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    setSystemTime(new Date(Date.now() + 60_000));
    remote.tab = "working";
    await world.coordinator.reconcileWorkerDelegations();
    setSystemTime(new Date(Date.now() + 40 * 60_000));
    remote.tab = "idle";
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    expect((await delegationState(world, association.id))?.state).toBe("running");
    setSystemTime(new Date(Date.now() + 120_000));
    await world.coordinator.reconcileWorkerDelegations();
    expect(await delegationState(world, association.id)).toMatchObject({
      state: "completed",
      backgroundWorkTimeoutMs: 120_000,
    });
    await world.deliver();
    expect(world.received(main)[0]).toContain("none of it reported for 2 minutes");
  });

  test("an unreachable node changes nothing, and a worker never seen working waits out the grace", async () => {
    const { world, remote, association } = await remoteWorld();
    remote.available = false;
    remote.environment = "missing";
    await world.coordinator.reconcileWorkerDelegations();
    expect((await delegationState(world, association.id))?.state).toBe("running");

    remote.available = true;
    remote.environment = "running";
    remote.tab = "idle";
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    expect((await delegationState(world, association.id))?.state).toBe("running");

    setSystemTime(new Date(Date.now() + 60_000));
    await world.coordinator.reconcileWorkerDelegations();
    expect((await delegationState(world, association.id))?.state).toBe("completed");
  });

  test("a deleted or failed remote environment closes the delegation", async () => {
    const { world, remote, association } = await remoteWorld();
    remote.environment = "error";
    await world.coordinator.reconcileWorkerDelegations();
    expect((await delegationState(world, association.id))?.state).toBe("failed");
  });

  test("a held report from the remote worker is released as the wake", async () => {
    const { world, remote, main, association } = await remoteWorld();
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
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    await world.deliver();
    expect(world.wakes(main)).toBe(0);

    remote.tab = "idle";
    remote.backgroundWorkPending = true;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    await world.deliver();

    expect((await delegationState(world, association.id))?.wakeKind).toBe("report");
    expect(world.received(main)).toEqual(["Finished: tests pass."]);
  });

  test("a request the worker has not read yet keeps it open, and its mail is collected before a close", async () => {
    const { world, remote, association } = await remoteWorld();
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    remote.tab = "idle";
    remote.requestPending = true;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    expect((await delegationState(world, association.id))?.state).toBe("running");
    remote.environment = "stopped";
    setSystemTime(new Date(Date.now() + 60_000));
    await world.coordinator.reconcileWorkerDelegations();
    expect((await delegationState(world, association.id))?.state).toBe("running");
    expect(remote.collected).toEqual([]);

    remote.environment = "running";
    remote.requestPending = false;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    expect((await delegationState(world, association.id))?.state).toBe("completed");
    expect(remote.collected).toEqual(["bk_leaf"]);
  });

  test("a new remote request starts a fresh budget for that worker's reports", async () => {
    const { world, main } = await remoteWorld();
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, autonomousWakeBudget: 2 },
    });
    const report = (requestId: string) =>
      world.storage.sendAgentMail(
        {
          kind: "node",
          nodeId: "bk_leaf",
          nodeName: "Build box",
          role: "agent",
          projectId: world.projectId,
          environmentId: "other-env",
          tabId: "startup-agent",
          title: null,
        },
        { requestId, toEnvironmentId: main.environmentId, toTabId: main.tabId, body: requestId },
      );
    await report("r1");
    await report("r2");
    expect((await report("r3")).placementReason).toBe(AGENT_MAIL_LOOP_BUDGET_REASON);
    await world.storage.startRemoteWorkerBudget(main, {
      nodeId: "bk_leaf",
      environmentId: "other-env",
      tabId: "startup-agent",
    });
    expect((await report("r4")).placement).toBe("pending-inject");
  });

  for (const failure of ["collect", "deliver", "ack"]) {
    test(`a failed outbox ${failure} keeps the delegation open until one report wake`, async () => {
      const { world, remote, main, association } = await remoteWorld();
      let failed = false;
      let queued = true;
      const collector = new NodeMailCollector({
        retryDelayMs: 60_000,
        selfId: async () => "bk_cmd" as never,
        nodeName: async () => "Build box",
        link: () => ({
          connected: true,
          invoke: async <T>(command: string) => {
            if (
              !failed &&
              command ===
                (failure === "collect"
                  ? "collect_node_outbox"
                  : failure === "ack"
                    ? "ack_node_outbox"
                    : "none")
            ) {
              failed = true;
              throw new Error("temporary");
            }
            if (command === "collect_node_outbox")
              return {
                items: queued
                  ? [
                      {
                        seq: 1,
                        requestId: "report",
                        createdAt: "",
                        fromEnvironmentId: "leaf-env",
                        fromTabId: "startup-agent",
                        body: "Tests pass.",
                        bytes: 11,
                      },
                    ]
                  : [],
                more: false,
              } as T;
            queued = false;
            return {} as T;
          },
        }),
        deliver: async (input) => {
          if (!failed && failure === "deliver") {
            failed = true;
            throw new Error("temporary");
          }
          await world.storage.sendAgentMail(
            {
              kind: "node",
              ...input.from,
              role: "agent",
              projectId: world.projectId,
              title: "worker",
            },
            {
              requestId: input.requestId,
              toEnvironmentId: main.environmentId,
              toTabId: main.tabId,
              body: input.body,
            },
          );
        },
      });
      remote.collectMail = (id) => collector.collect(id as never);
      try {
        await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
        remote.tab = "idle";
        await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
        await world.deliver();
        expect(failed).toBe(true);
        expect((await delegationState(world, association.id))?.state).toBe("running");
        expect(world.wakes(main)).toBe(0);
        await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
        await world.deliver();
        await world.coordinator.reconcileWorkerDelegations();
        await world.deliver();
        expect((await delegationState(world, association.id))?.wakeKind).toBe("report");
        expect(world.wakes(main)).toBe(1);
        expect(world.received(main).join(" ")).toContain("Tests pass.");
      } finally {
        collector.dispose();
      }
    });
  }

  test("a follow-up admitted while collecting outbox mail invalidates the idle outcome", async () => {
    const { world, remote, main, association } = await remoteWorld();
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    remote.tab = "idle";
    let release!: () => void;
    let collecting!: () => void;
    const started = new Promise<void>((resolve) => {
      collecting = resolve;
    });
    remote.collectMail = async () => {
      collecting();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    };
    const settling = world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    await started;
    // Admission uses a new identity even within the same clock millisecond.
    await world.storage.withAgentMailWorkerAdmission("node:bk_leaf:leaf-env", async () => {
      world.coordinator.noteRemoteRequest(association.id);
      remote.tab = "working";
    });
    release();
    await settling;
    expect((await delegationState(world, association.id))?.state).toBe("running");
    expect(world.wakes(main)).toBe(0);
    remote.collectMail = async () => true;
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    remote.tab = "idle";
    await world.coordinator.settleRemoteWorker("bk_leaf", "leaf-env");
    await world.deliver();
    expect((await delegationState(world, association.id))?.state).toBe("completed");
    expect(world.wakes(main)).toBe(1);
  });

  test("a local turn end never settles a remote delegation with the same environment ID", async () => {
    const { world, association } = await remoteWorld();
    await world.coordinator.settleWorkerDelegations({
      environmentId: "leaf-env",
      tabId: "startup-agent",
      state: "completed",
    });
    expect((await delegationState(world, association.id))?.state).toBe("running");
  });
});

describe("remote workflow status wakes", () => {
  test("a build pipeline on a leaf wakes the coordinator with calls that name the node", async () => {
    const { world, remote, main } = await remoteWorld();
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "remote-build",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: main.conversationId!,
      kind: "build-pipeline",
      resourceId: "pipeline-9",
      nodeId: "bk_leaf",
      requestId: "build-remote",
      createdAt: new Date().toISOString(),
    });
    remote.workflows.set("pipeline-9", {
      snapshot: {
        id: "pipeline-9",
        environmentId: "leaf-env",
        phase: "complete",
        verificationResult: "pass",
        taskTitle: "Fix the parser",
      },
      revision: 3,
      updatedAt: new Date().toISOString(),
    });

    await world.coordinator.statusWakes.observeWorkflow("build-pipeline", "pipeline-9", "bk_leaf");
    await world.deliver();

    const [notice] = world.carriers(main).flat();
    expect(notice?.notice).toMatchObject({ state: "completed", tone: "success" });
    expect(notice?.body).toContain("Runs on Build box (nodeId bk_leaf).");
    expect(notice?.body).toContain(
      'get_build_pipeline { "nodeId": "bk_leaf", "pipelineId": "pipeline-9" }',
    );
    expect(notice?.subject).toContain("remote-worker on Build box");
    // The same ID on this node is a different workflow.
    await world.coordinator.statusWakes.observeWorkflow("build-pipeline", "pipeline-9");
    await world.deliver();
    expect(world.wakes(main)).toBe(1);
  });

  test("statusOnNode names the node in every suggested call", () => {
    const status = statusOnNode(
      {
        key: "k",
        state: "ready",
        tone: "attention",
        terminal: false,
        headline: "is ready",
        details: ["3 findings"],
        tools: [
          'get_multi_review { "workflowId": "w" }',
          'address_multi_review { "workflowId": "w" }',
        ],
        mode: "settled",
      },
      "bk_leaf",
      "Build box",
    );
    expect(status.tools).toEqual([
      'get_multi_review { "nodeId": "bk_leaf", "workflowId": "w" }',
      'address_multi_review { "nodeId": "bk_leaf", "workflowId": "w" }',
    ]);
    expect(status.details[0]).toBe("Runs on Build box (nodeId bk_leaf).");
  });
});
