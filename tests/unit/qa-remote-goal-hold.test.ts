/**
 * The path `scripts/qa-remote-goal-hold.ts` (to-do 4860 (retired) task 2)
 * relies on, in process: the goal it seeds into a leaf's data directory, read
 * the way the leaf's own registry reads a tab's goal (`AgentRegistry` with the
 * goal source `core/index.ts` gives it), routed through the production
 * `NodeCoordinatorRemote` to the production coordinator on a real mail store
 * (`MailWorld`). Only the node link is replaced: each routed read is answered
 * from the seeded store. A change to the session key, the registry's goal
 * read, `NodeCoordinatorRemote` or the coordinator's goal hold fails here,
 * without the two backends the script needs. The script itself runs weekly in
 * `.github/workflows/mixed-version-qualification.yml` (`mise run qa:remote-goal-hold`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { goalStatusSummary, sessionGoal } from "@orkestrator/protocol/native-agent-goal";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";

import { MailWorld } from "../../apps/backend/src/core/agent-mail-world-test-support";
import { AgentRegistry } from "../../apps/backend/src/core/agent-registry";
import { nativeAgentSessionStorageKey } from "../../apps/backend/src/core/native-agent-service-shared";
import { NodeCoordinatorRemote } from "../../apps/backend/src/core/nodes/index.js";
import { StorageService } from "../../apps/backend/src/core/storage";
import { WorkerTabCloseAdmission } from "../../apps/backend/src/core/worker-tab-close-admission";
import { seedGoal, waitForFileCheck, workerSessionKey } from "../../scripts/qa-remote-goal-hold";

const WORKER = { environmentId: "leaf-env", tabId: "worker-tab" };
const LEAF_ID = "bk_leaf";
const PROJECT_ID = "leaf-project";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The leaf's tab layout: one native Claude tab, as the fixtures' worker has. */
const layout = {
  version: 1,
  containerId: null,
  activePaneId: "pane",
  root: {
    kind: "leaf",
    id: "pane",
    activeTabId: WORKER.tabId,
    tabs: [{ id: WORKER.tabId, type: "agent-native", nativeAgentData: { platform: "claude" } }],
  },
};

/** A stand-in leaf whose goal reads come from the seeded data directory. */
async function seededLeaf() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-goal-hold-unit-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  // The leaf's own records, as the fixtures' create_environment leaves them.
  const setup = new StorageService(dataDir);
  await setup.init();
  try {
    await setup.addProject({
      id: PROJECT_ID,
      name: "Project",
      gitUrl: "https://example.invalid/project.git",
      localPath: dataDir,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    await setup.addEnvironment({
      id: WORKER.environmentId,
      projectId: PROJECT_ID,
      name: "Worker",
      branch: "main",
      environmentType: "local",
      worktreePath: dataDir,
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
    });
  } finally {
    setup.close();
  }
  // Seeded with the leaf stopped, as the script does.
  const seeded = await seedGoal(dataDir, WORKER, waitForFileCheck(path.join(dataDir, "never")));
  const storage = new StorageService(dataDir);
  await storage.init();
  cleanups.push(async () => storage.close());

  const leaf: { tab: AgentActivityState } = { tab: "working" };
  const registry = new AgentRegistry(
    {
      loadProjects: () => storage.loadProjects(),
      loadEnvironments: () => storage.loadEnvironments(),
      // The tab layout the renderer would have committed for the worker.
      loadPaneLayoutsForReconciliation: async () =>
        ({ available: true, layouts: { [WORKER.environmentId]: layout } }) as never,
      coordinators: { listCoordinatorWorkspaces: async () => [] },
    },
    {
      native: () => leaf.tab,
      // As `core/index.ts` wires it.
      goal: async (environmentId, agent, logicalSessionKey) => {
        const session = await storage.getNativeAgentSession(
          nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
        );
        const goal = session ? sessionGoal(session) : undefined;
        return goal ? goalStatusSummary(goal) : undefined;
      },
    },
  );
  const answer = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (command) {
      case "get_environment":
        return {
          id: WORKER.environmentId,
          projectId: PROJECT_ID,
          name: "Worker",
          status: "running",
        };
      case "get_worker_request_state":
        return { requestPending: false, backgroundWorkPending: false };
      case "get_agent_registry":
        return registry.snapshot({ environmentId: String(args.environmentId) });
      case "get_pane_layout":
        return layout;
      default:
        throw new Error(`unexpected ${command}`);
    }
  };
  const remote = new NodeCoordinatorRemote({
    invokeOnNode: async ({ nodeId, command, args }) =>
      nodeId === LEAF_ID
        ? { outcome: "ok", result: await answer(command, args) }
        : { outcome: "unavailable" },
    summaries: async () =>
      ({
        nodes: [{ nodeId: LEAF_ID, available: true, view: { displayName: "Leaf" } }],
      }) as unknown as NodeSummariesResult,
    collectMail: async () => true,
  });
  const complete = () =>
    storage.updateNativeAgentGoal(workerSessionKey(WORKER).key, (goal) => ({
      ...goal!,
      status: "complete",
      updatedAt: new Date().toISOString(),
    }));
  return { seeded, storage, registry, remote, leaf, complete };
}

describe("the remote goal hold's seeded goal", () => {
  test("is the goal the leaf's registry reports for the worker tab, running", async () => {
    const { seeded, registry, leaf } = await seededLeaf();
    leaf.tab = "idle";
    const snapshot = await registry.snapshot({ environmentId: WORKER.environmentId });
    const entry = snapshot.entries.find((candidate) => candidate.tabId === WORKER.tabId);
    expect(seeded.status).toBe("checking");
    expect(entry).toMatchObject({ state: "idle", goal: { status: "checking", running: true } });
  });

  test("holds a coordinator past its worker's idle reads, then wakes it once when the goal ends", async () => {
    const { remote, leaf, complete } = await seededLeaf();
    const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
    cleanups.push(() => world.close());
    world.coordinator.setRemoteAccess(remote);
    const main = await world.main();
    const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "remote-goal-hold",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: main.conversationId!,
      kind: "environment",
      resourceId: WORKER.environmentId,
      nodeId: LEAF_ID,
      requestId: "remote-goal-hold-launch",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      createdAt: new Date().toISOString(),
    });
    await world.storage.coordinators.openCoordinatorDelegation(
      new WorkerTabCloseAdmission(),
      association.id,
      WORKER.tabId,
    );
    const delegation = async () =>
      (await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)).find(
        (entry) => entry.id === association.id,
      )?.delegation;
    const settle = async () => {
      await world.coordinator.settleRemoteWorker(LEAF_ID, WORKER.environmentId);
      await world.coordinator.reconcileWorkflowNotifications();
      await world.deliver();
    };

    // Seen working first, so the start-up grace no longer keeps an idle worker open.
    await settle();
    leaf.tab = "idle";
    for (let read = 0; read < 3; read++) await settle();
    expect((await delegation())?.state).toBe("running");
    expect(world.wakes(main)).toBe(0);
    expect(world.received(main)).toHaveLength(0);

    await complete();
    await settle();
    expect((await delegation())?.state).toBe("completed");
    expect(world.wakes(main)).toBe(1);
    const received = world.received(main);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain(`on Leaf (nodeId ${LEAF_ID})`);
  });
});
