/**
 * A many-iteration goal wakes its coordinator once. Real coordinator service,
 * mail store, storage and goal service; the provider's turns are scripted. The
 * turn-end edge and the goal's release run the two decisions `index.ts` makes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { goalContinuationRequestId, sessionGoal } from "@orkestrator/protocol/native-agent-goal";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { CoordinatorService } from "./coordinator-service.js";
import { NativeAgentGoalService, type GoalCheckRun } from "./native-agent-goal-service.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { runCommand } from "./shell.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { workerSessionGoal } from "./worker-session-activity.js";

const TAB = "startup-agent";

let root: string;
let storage: StorageService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "ork-goal-wake-"));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
});

afterEach(async () => {
  storage.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: { holdOnGoal?: boolean; check?: GoalCheckRun } = {}) {
  const checkout = path.join(root, "checkout");
  await fs.mkdir(checkout);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
    ["commit", "--allow-empty", "-m", "fixture"],
  ])
    await runCommand("git", args, { cwd: checkout });
  const project = await storage.addProject(
    createProject("https://example.invalid/repo.git", checkout),
  );
  const coordinator = new CoordinatorService(
    storage,
    () => ({ enabled: true, running: true, error: null }),
    undefined,
    // Between iterations the tab really does read idle; this is the sweep's view.
    async () => "idle",
    {
      ...(options.holdOnGoal === false
        ? {}
        : {
            workerGoal: (environmentId, tabId) => workerSessionGoal(storage, environmentId, tabId),
          }),
    },
  );
  const initial = await coordinator.ensure(project.id);
  const conversation = initial.workspace.conversations[0]!;
  await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
  const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
  Object.assign(worker, { status: "running", setupPhase: "ready", setupScriptsComplete: true });
  await storage.addEnvironment(worker);
  await storage.savePaneLayout(
    worker.id,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: TAB,
            type: "agent-native",
            nativeAgentData: { environmentId: worker.id, platform: "claude" },
          },
        ],
        activeTabId: TAB,
      },
    },
    0,
  );
  await storage.synchronizeAgentMailboxes();
  const logicalSessionKey = `env-${worker.id}:${TAB}`;
  const key = nativeAgentSessionStorageKey(worker.id, "claude", logicalSessionKey);
  await storage.adoptNativeAgentSession({
    key,
    environmentId: worker.id,
    agent: "claude",
    logicalSessionKey,
    providerSessionId: "provider-1",
  });
  const association = await storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "delegation",
    coordinatorId: initial.workspace.id,
    projectId: project.id,
    conversationId: conversation.id,
    kind: "environment",
    resourceId: worker.id,
    requestId: "delegation:goal",
    createdAt: new Date().toISOString(),
  });
  // Old enough that the sweep's idle grace is over from the first look.
  await storage.coordinators.openCoordinatorDelegation(
    association.id,
    TAB,
    new Date(0).toISOString(),
  );

  const settle = () =>
    coordinator.settleWorkerDelegations({
      environmentId: worker.id,
      tabId: TAB,
      state: "completed",
    });
  const goals = new NativeAgentGoalService({
    storage: storage as never,
    now: () => Date.now(),
    isStopped: () => false,
    trackScan: (task: Promise<void>) => task,
    requestOutcome: async () => ({ outcome: "completed" }),
    turnActivity: () => "idle",
    stoppedMidTurn: () => false,
    environmentRunning: async () => true,
    notifyQueue: () => undefined,
    sessionTokens: async () => undefined,
    workspaceFingerprint: async () => undefined,
    runCheck: async () =>
      options.check ?? {
        kind: "finished",
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        outputTail: "",
      },
    announce: () => undefined,
    ringAttention: async () => undefined,
    // `onGoalReleasedTurnEnd`.
    releaseTurnEnd: async () => settle(),
    supportsGoals: () => true,
    supportsTokenBudget: () => true,
  } as never);

  const goal = async () => {
    const session = await storage.getNativeAgentSession(key);
    return session ? sessionGoal(session) : undefined;
  };
  /** One turn of the loop: its turn runs, ends, and the sweep looks in. */
  const runTurn = async () => {
    const current = (await goal())!;
    const requestId = goalContinuationRequestId(current.goalId, current.iterations - 1);
    await storage.dispatchNativeAgentPromptOnce(key, requestId, async () => {});
    await storage.removePromptQueueMessage(`claude\0${logicalSessionKey}`, worker.id, requestId);
    // `index.ts`: read the hold first, because the loop reacts to this same edge.
    const held = goals.holdsTurnEnd(key);
    goals.noteTurnEnded(key);
    await goals.settled();
    if (!held) await settle();
    await coordinator.reconcileWorkerDelegations();
  };
  const wakes = async () =>
    (await storage.listPendingAgentMailInjects()).filter(
      ({ message }) => message.from.kind === "system",
    );
  const report = async (status: "done" | "blocked" | "progress") =>
    goals.report(
      { environmentId: worker.id, tabId: TAB },
      { goalId: (await goal())!.goalId, status, message: "note" },
    );
  const set = async (fields: { maxIterations: number; check?: string }) => {
    const session = (await storage.getNativeAgentSession(key))!;
    await goals.perform(
      session,
      { kind: "set", objective: "Make it pass", ...fields },
      { busy: false },
    );
    await goals.settled();
  };
  return {
    coordinator,
    goals,
    goal,
    runTurn,
    wakes,
    report,
    set,
    key,
    associationId: association.id,
  };
}

async function openCount() {
  return (await storage.coordinators.listOpenCoordinatorDelegations()).length;
}

describe("a coordinator's wake for a worker's goal", () => {
  test("many iterations, one wake, when the check passes", async () => {
    const { goal, runTurn, wakes, report, set, coordinator } = await fixture();
    await set({ maxIterations: 20, check: "bun test" });
    for (let turn = 0; turn < 12; turn += 1) {
      await runTurn();
      expect(await wakes()).toHaveLength(0);
      expect(await openCount()).toBe(1);
      expect((await goal())?.status).toBe("active");
    }
    await report("done");
    await runTurn();
    expect((await goal())?.status).toBe("complete");
    const delivered = await wakes();
    expect(delivered).toHaveLength(1);
    expect(await openCount()).toBe(0);
    const { subject, body } = delivered[0]!.message;
    expect(subject).toContain("finished");
    expect(body).toContain("Its goal is complete (check-passed) after 13 of 20 iterations");
    expect(body).toContain("get_worker_goal");

    await coordinator.reconcileWorkerDelegations();
    await coordinator.deliverDelegationWakes();
    expect(await wakes()).toHaveLength(1);
  });

  test("the sweep's idle reading is what would otherwise wake it early", async () => {
    const { runTurn, wakes, set } = await fixture({ holdOnGoal: false });
    await set({ maxIterations: 20 });
    await runTurn();
    expect(await wakes()).toHaveLength(1);
  });

  test("one wake when a goal stops at its cap", async () => {
    const { goal, runTurn, wakes, set } = await fixture();
    await set({ maxIterations: 3 });
    await runTurn();
    await runTurn();
    expect(await wakes()).toHaveLength(0);
    await runTurn();
    expect((await goal())?.status).toBe("limited");
    const delivered = await wakes();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.message.body).toContain("limited (iteration-cap) after 3 of 3");
  });

  test("one wake when the agent says it needs a person", async () => {
    const { goal, runTurn, wakes, report, set } = await fixture();
    await set({ maxIterations: 10 });
    await runTurn();
    await report("blocked");
    await runTurn();
    expect((await goal())?.status).toBe("blocked");
    expect(await wakes()).toHaveLength(1);
  });

  test("one wake when a claim ends a goal with no check", async () => {
    const { goal, runTurn, wakes, report, set } = await fixture();
    await set({ maxIterations: 10 });
    await report("done");
    await runTurn();
    expect((await goal())?.status).toBe("claimed");
    const delivered = await wakes();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.message.body).toContain("claimed (agent-claimed)");
  });

  test("a failed check keeps the loop, and the wake, going", async () => {
    const { goal, runTurn, wakes, report, set } = await fixture({
      check: { kind: "finished", exitCode: 1, timedOut: false, durationMs: 1, outputTail: "no" },
    });
    await set({ maxIterations: 10, check: "bun test" });
    await report("done");
    await runTurn();
    expect((await goal())?.status).toBe("active");
    expect(await wakes()).toHaveLength(0);
    expect(await openCount()).toBe(1);
  });

  test("clearing a running goal ends the wait, with one wake", async () => {
    const { wakes, set, goals, key, runTurn, goal } = await fixture();
    await set({ maxIterations: 10 });
    await runTurn();
    expect(await wakes()).toHaveLength(0);
    await goals.perform(
      (await storage.getNativeAgentSession(key))!,
      { kind: "clear" },
      {
        busy: false,
      },
    );
    await goals.settled();
    expect(await goal()).toBeUndefined();
    expect(await wakes()).toHaveLength(1);
    expect(await openCount()).toBe(0);
  });

  test("a pause wakes once, and resuming later does not owe another", async () => {
    const { goal, wakes, set, goals, key, runTurn } = await fixture();
    await set({ maxIterations: 10 });
    await runTurn();
    const session = (await storage.getNativeAgentSession(key))!;
    await goals.perform(session, { kind: "pause" }, { busy: false });
    await goals.settled();
    expect((await goal())?.status).toBe("paused");
    expect(await wakes()).toHaveLength(1);
    expect(await openCount()).toBe(0);
    const paused = (await storage.getNativeAgentSession(key))!;
    await goals.perform(paused, { kind: "resume" }, { busy: false });
    await goals.settled();
    await runTurn();
    expect(await wakes()).toHaveLength(1);
  });
});
