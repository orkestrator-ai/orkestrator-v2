/**
 * Feature-plan status wakes (todo 0395 task 3) on the real mail world: a
 * coordinator that sent a planning message hears once when its reply is ready
 * and once per failure, nothing for a cancelled exchange or one it did not
 * start, and an association kind this backend does not know is kept and
 * skipped. Storage, routes, budgets and the injection drain are production
 * code; only the agents, the clock and the timers are simulated.
 */
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import { FEATURE_PLANNING_RECORD_VERSION } from "@orkestrator/protocol/feature-planning";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorRequestFlights } from "./coordinator-request-flights.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { featurePlanCoordinatorStatus } from "./coordinator-feature-plan-status.js";
import {
  COORDINATOR_STATUS_COALESCE_MS,
  type CoordinatorStatusWakeTimers,
} from "./coordinator-status-wakes.js";
import {
  COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS,
  selectCoordinatorWorkflowsToClear,
} from "./coordinator-workflow-retention.js";

class ManualTimers implements CoordinatorStatusWakeTimers {
  private current = Date.now();
  private nextId = 0;
  private due: Array<{ id: number; at: number; callback: () => void }> = [];

  constructor() {
    setSystemTime(new Date(this.current));
  }

  now = (): number => this.current;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    this.nextId += 1;
    this.due.push({ id: this.nextId, at: this.current + delayMs, callback });
    return this.nextId;
  };

  clearTimeout = (handle: unknown): void => {
    this.due = this.due.filter((entry) => entry.id !== handle);
  };

  advance(milliseconds: number): void {
    this.current += milliseconds;
    setSystemTime(new Date(this.current));
    const ready = this.due
      .filter((entry) => entry.at <= this.current)
      .sort((left, right) => left.at - right.at);
    this.due = this.due.filter((entry) => entry.at > this.current);
    for (const entry of ready) entry.callback();
  }
}

let world: MailWorld | null = null;
let timers: ManualTimers;

afterEach(async () => {
  world?.coordinator.stopStatusWakes();
  await world?.close();
  world = null;
  setSystemTime();
});

async function createWorld(): Promise<MailWorld> {
  timers = new ManualTimers();
  world = await MailWorld.create({
    statusWakes: {
      timers,
      workerActivity: async () => "working",
      lastAssistantExcerpt: async () => undefined,
      waitingBlocker: async () => undefined,
    },
  });
  return world;
}

/** The sweep path: reconcile, then let the coalescing window pass. */
async function settle(current: MailWorld): Promise<void> {
  await current.coordinator.reconcileWorkflowNotifications();
  await current.deliver();
  await current.coordinator.statusWakes.settled();
  timers.advance(COORDINATOR_STATUS_COALESCE_MS + 1);
  await current.deliver();
}

/** The live path: the plan's save event, its debounce, then the coalescing window. */
async function observeSaves(current: MailWorld): Promise<void> {
  timers.advance(2_001);
  await current.coordinator.statusWakes.settled();
  await current.deliver();
  timers.advance(COORDINATOR_STATUS_COALESCE_MS + 1);
  await current.deliver();
}

async function associate(current: MailWorld, featureId: string, operationId: string) {
  const main = await current.main();
  await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: `association-${operationId}`,
    projectId: current.projectId,
    coordinatorId: current.coordinatorId,
    conversationId: main.conversationId!,
    kind: "feature-plan",
    resourceId: featureId,
    requestId: `feature-plan:${operationId}`,
    featurePlan: { operationId },
    createdAt: new Date(timers.now()).toISOString(),
  });
}

async function startPlanning(current: MailWorld, featureId: string, operationId: string) {
  const now = new Date(timers.now()).toISOString();
  const { started } = await current.storage.kanban.startFeaturePlanning({
    version: FEATURE_PLANNING_RECORD_VERSION,
    operationId,
    featureId,
    projectId: current.projectId,
    kind: "feature",
    userMessage: "Add dark mode",
    phase: "running",
    startedAt: now,
    updatedAt: now,
    backendRevision: 0,
  });
  expect(started).toBe(true);
}

/** The planner's reply lands and is applied; the exchange detaches, as a real success does. */
async function reply(current: MailWorld, featureId: string, operationId: string) {
  await current.storage.kanban.mutateFeaturePlanning(featureId, operationId, (plan) => {
    plan.messages.push({
      id: `reply-${operationId}`,
      role: "assistant",
      content: "Which screens need it?",
      createdAt: new Date(timers.now()).toISOString(),
      stateApplication: "applied",
    });
    plan.title = "Dark mode";
  });
  await current.storage.kanban.clearFeaturePlanning(featureId, operationId);
}

async function fail(current: MailWorld, featureId: string, operationId: string) {
  await current.storage.kanban.mutateFeaturePlanning(featureId, operationId, (_plan, record) => {
    record.phase = "failed";
    record.failure = {
      code: "provider",
      message: "The provider refused the turn",
      occurredAt: new Date(timers.now()).toISOString(),
      retryPhase: "dispatching",
    };
  });
}

async function association(current: MailWorld, operationId: string) {
  return (
    await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
  ).find((item) => item.id === `association-${operationId}`);
}

/** Real launch/receipt/association code; only the planner is controlled. */
async function launcher(current: MailWorld, start: CommandHandler) {
  const commands = createCommandRegistry();
  commands.set("start_feature_planning", start);
  const main = await current.main();
  const context = {
    storage: current.storage,
    coordinators: current.coordinator,
    runtime: { coordinatorRequests: new CoordinatorRequestFlights() },
  } as CommandContext;
  return (requestId = "launch") =>
    commands.get("launch_coordinator_feature_plan")!(
      {
        scope: {
          projectId: current.projectId,
          coordinatorId: current.coordinatorId,
          conversationId: main.conversationId,
        },
        input: { requestId, message: "Add dark mode" },
      },
      context,
    );
}

for (const outcome of ["ready", "failed"] as const) {
  test(`startup reconciliation preserves the eventual ${outcome} wake`, async () => {
    const current = await createWorld();
    current.coordinator.startStatusWakes();
    const main = await current.main();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let featureId = "";
    let operationId = "";
    const launch = await launcher(current, async (args) => {
      featureId = args.featureId as string;
      operationId = args.operationId as string;
      entered.resolve();
      await resume.promise;
      await startPlanning(current, featureId, operationId);
      return { phase: "running" };
    });
    const launching = launch();
    try {
      await entered.promise;
      await settle(current);
      await observeSaves(current);
      const [pending] = await current.storage.coordinators.listCoordinatorWorkflowAssociations(
        current.projectId,
      );
      expect(pending).toMatchObject({ pending: true });
      expect(pending?.terminalNotifiedAt).toBeUndefined();
      expect(current.wakes(main)).toBe(0);
    } finally {
      resume.resolve();
      await launching;
    }
    if (outcome === "ready") await reply(current, featureId, operationId);
    else await fail(current, featureId, operationId);
    await settle(current);
    await current.finishTurn(main);
    await settle(current);
    expect(current.wakes(main)).toBe(1);
    expect(current.carriers(main)[0]![0]).toMatchObject({ notice: { state: outcome } });
  });

  test(`refused startup, reconciliation and a same-request retry deliver one ${outcome} wake`, async () => {
    const current = await createWorld();
    const main = await current.main();
    let featureId = "";
    let operationId = "";
    const start = mock(async (args: Record<string, unknown>) => {
      featureId = args.featureId as string;
      operationId = args.operationId as string;
      await startPlanning(current, featureId, operationId);
      return { phase: "running" };
    }).mockRejectedValueOnce(new Error("not ready"));
    const launch = await launcher(current, start);
    await expect(launch()).rejects.toThrow("not ready");
    await settle(current);
    expect(
      await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId),
    ).toHaveLength(0);
    await launch();
    expect(start.mock.calls[0]).toEqual(start.mock.calls[1]);
    if (outcome === "ready") await reply(current, featureId, operationId);
    else await fail(current, featureId, operationId);
    await settle(current);
    await current.finishTurn(main);
    await settle(current);
    expect(current.wakes(main)).toBe(1);
    expect(current.carriers(main)[0]![0]).toMatchObject({ notice: { state: outcome } });
  });
}

test("restart recovers an attached exchange whose association activation never landed", async () => {
  const current = await createWorld();
  const main = await current.main();
  let featureId = "";
  let operationId = "";
  const launch = await launcher(current, async (args) => {
    featureId = args.featureId as string;
    operationId = args.operationId as string;
    await startPlanning(current, featureId, operationId);
    return { phase: "running" };
  });
  const complete = spyOn(
    current.storage.coordinators,
    "completeCoordinatorWorkflowAssociation",
  ).mockRejectedValueOnce(new Error("activation write failed"));
  try {
    await expect(launch()).rejects.toThrow("activation write failed");
  } finally {
    complete.mockRestore();
  }
  const [pending] = await current.storage.coordinators.listCoordinatorWorkflowAssociations(
    current.projectId,
  );
  expect(pending?.pending).toBe(true);
  await current.restart();
  await reply(current, featureId, operationId);
  await settle(current);
  await current.finishTurn(main);
  await settle(current);
  expect(current.wakes(main)).toBe(1);
  const [recovered] = await current.storage.coordinators.listCoordinatorWorkflowAssociations(
    current.projectId,
  );
  expect(recovered).toMatchObject({ pending: false, statusNotice: { key: "ready" } });
});

test("tool-v1 reports an applied reply before result consumption, once", async () => {
  const current = await createWorld();
  const main = await current.main();
  const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "tool-plan");
  await associate(current, plan.id, "tool-op");
  await startPlanning(current, plan.id, "tool-op");
  await current.storage.kanban.mutateFeaturePlanning(plan.id, "tool-op", (plan, record) => {
    record.resultTransport = "tool-v1";
    record.phase = "persisting";
    plan.messages.push({
      id: "tool-reply",
      role: "assistant",
      content: "Ready",
      createdAt: new Date().toISOString(),
      stateApplication: "pending",
    });
  });
  await settle(current);
  expect(current.wakes(main)).toBe(0);
  await current.storage.kanban.mutateFeaturePlanning(plan.id, "tool-op", (plan, record) => {
    record.resultAppliedAt = new Date().toISOString();
    plan.messages.find((message) => message.id === "tool-reply")!.stateApplication = "applied";
  });
  await settle(current);
  expect(current.wakes(main)).toBe(1);
  expect((await current.storage.kanban.getFeaturePlan(plan.id))?.planning).toMatchObject({
    resultTransport: "tool-v1",
    phase: "persisting",
  });
  await current.finishTurn(main);
  await current.storage.kanban.mutateFeaturePlanning(plan.id, "tool-op", (_plan, record) => {
    record.phase = "complete";
  });
  await current.storage.kanban.clearFeaturePlanning(plan.id, "tool-op");
  await settle(current);
  expect(current.wakes(main)).toBe(1);
});

for (const status of ["building", "built"] as const) {
  test(`a reply superseded when the plan is ${status} never wakes ready`, async () => {
    const current = await createWorld();
    const main = await current.main();
    const plan = await current.storage.kanban.createFeaturePlan(
      current.projectId,
      "superseded-plan",
    );
    await associate(current, plan.id, "superseded-op");
    await startPlanning(current, plan.id, "superseded-op");
    await current.storage.kanban.mutateFeaturePlanning(plan.id, "superseded-op", (plan) => {
      plan.status = status;
      plan.messages.push({
        id: "superseded-reply",
        role: "assistant",
        content: "Old reply",
        createdAt: new Date().toISOString(),
        stateApplication: "superseded",
      });
    });
    await current.storage.kanban.clearFeaturePlanning(plan.id, "superseded-op");
    await settle(current);
    expect(current.wakes(main)).toBe(0);
    expect((await association(current, "superseded-op"))?.terminalNotifiedAt).toBeDefined();
  });
}

describe("feature plan status wakes", () => {
  test("one wake when the planning reply is ready, from the plan's own save", async () => {
    const current = await createWorld();
    current.coordinator.startStatusWakes();
    const coordinator = await current.main();
    const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-1");
    await associate(current, plan.id, "op-1");
    await startPlanning(current, plan.id, "op-1");
    await observeSaves(current);
    expect(current.wakes(coordinator)).toBe(0);

    await reply(current, plan.id, "op-1");
    await observeSaves(current);
    expect(current.wakes(coordinator)).toBe(1);
    const [carrier] = current.carriers(coordinator)[0]!;
    expect(carrier).toMatchObject({
      kind: "notice",
      notice: {
        resource: { kind: "feature-plan", id: "plan-1", label: "Dark mode" },
        state: "ready",
        tone: "attention",
      },
    });
    expect(carrier!.subject).toBe("Feature plan Dark mode has a planning reply ready");
    expect(carrier!.body).toContain('get_feature_plan { "featureId": "plan-1" }');
    // Content-free: the reply is read through get_feature_plan, never sent.
    expect(carrier!.body).not.toContain("Which screens");
    expect(carrier!.body).not.toContain("Add dark mode");

    await current.finishTurn(coordinator);
    await current.storage.kanban.updateFeaturePlan(plan.id, { summary: "later edit" });
    await observeSaves(current);
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    expect(await association(current, "op-1")).toMatchObject({
      statusNotice: { key: "ready" },
      terminalNotifiedAt: expect.any(String),
    });
  });

  test("a failure wakes once, and a retry's reply wakes again", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-1");
    await associate(current, plan.id, "op-1");
    await startPlanning(current, plan.id, "op-1");
    await fail(current, plan.id, "op-1");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    const [failed] = current.carriers(coordinator)[0]!;
    expect(failed).toMatchObject({
      notice: {
        resource: { kind: "feature-plan", id: "plan-1" },
        state: "failed",
        tone: "failure",
      },
    });
    expect(failed!.body).toContain("Error (provider): The provider refused the turn");
    await current.finishTurn(coordinator);
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    // A failure leaves the association open for the retry.
    expect((await association(current, "op-1"))?.terminalNotifiedAt).toBeUndefined();

    // The user retries from the Features board; the retry succeeds.
    await current.storage.kanban.mutateFeaturePlanning(plan.id, "op-1", (_plan, record) => {
      record.phase = "dispatching";
      delete record.failure;
    });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    await reply(current, plan.id, "op-1");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(2);
    expect(current.carriers(coordinator)[1]![0]).toMatchObject({ notice: { state: "ready" } });
  });

  test("a cancelled exchange, another exchange, and a plan nobody's coordinator asked about wake nobody", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-1");
    await associate(current, plan.id, "op-1");
    await startPlanning(current, plan.id, "op-1");
    // Cancelled: the exchange detaches without a reply.
    await current.storage.kanban.clearFeaturePlanning(plan.id, "op-1");
    // The user's next message is answered; it was not the coordinator's.
    await startPlanning(current, plan.id, "user-op");
    await reply(current, plan.id, "user-op");
    const other = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-2");
    await startPlanning(current, other.id, "other-op");
    await fail(current, other.id, "other-op");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    expect(await association(current, "op-1")).toMatchObject({
      terminalNotifiedAt: expect.any(String),
    });
    expect((await association(current, "op-1"))?.statusNotice).toBeUndefined();
  });

  test("a reply whose state block never applied is not reported as ready", () => {
    const now = new Date().toISOString();
    const plan = {
      id: "plan-1",
      projectId: "project-1",
      title: "Dark mode",
      status: "collecting" as const,
      summary: "",
      stories: [],
      createdAt: now,
      updatedAt: now,
      order: 0,
      messages: [
        { id: "op-1", role: "user" as const, content: "Add dark mode", createdAt: now },
        {
          id: "reply",
          role: "assistant" as const,
          content: "no state block",
          createdAt: now,
          stateApplication: "pending" as const,
        },
      ],
    };
    expect(featurePlanCoordinatorStatus(plan, "op-1")).toEqual({ ended: "cancelled" });
    expect(featurePlanCoordinatorStatus(null, "op-1")).toEqual({ ended: "missing" });
    expect(featurePlanCoordinatorStatus(plan, "never-sent")).toEqual({ ended: "missing" });
  });
});

describe("association kinds a reader does not know", () => {
  test("are kept, written back and skipped, never observed as another kind", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    // What a newer backend on the same data directory might write.
    const future = {
      id: "association-future",
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: coordinator.conversationId!,
      kind: "future-kind",
      resourceId: "resource-1",
      requestId: "future-request",
      createdAt: new Date(timers.now()).toISOString(),
    } as unknown as CoordinatorWorkflowAssociation;
    await current.storage.coordinators.saveCoordinatorWorkflowAssociation(future);
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    // Another write keeps it.
    await associate(current, "plan-x", "op-x");
    const workflows = await current.storage.coordinators.listCoordinatorWorkflowAssociations(
      current.projectId,
    );
    expect(workflows.find((item) => item.id === "association-future")).toEqual(future);

    // Retention never reclaims it on a guess: its resource state is unknown here.
    const old = { ...future, createdAt: new Date(0).toISOString() };
    expect(
      selectCoordinatorWorkflowsToClear({
        workflows: [old],
        environmentExists: () => false,
        resourceState: () => "unknown",
      }).size,
    ).toBe(0);
  });

  test("retention keeps a live planning exchange and reclaims a finished one", async () => {
    const current = await createWorld();
    const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-1");
    await associate(current, plan.id, "op-1");
    await startPlanning(current, plan.id, "op-1");
    const stored = (await association(current, "op-1"))!;
    const old = {
      ...stored,
      createdAt: new Date(timers.now() - COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS - 1).toISOString(),
    };
    const clearable = (state: "active" | "finished" | "missing" | "unknown") =>
      selectCoordinatorWorkflowsToClear({
        workflows: [old],
        environmentExists: () => false,
        resourceState: () => state,
      }).size;
    expect(clearable("active")).toBe(0);
    expect(clearable("unknown")).toBe(0);
    expect(clearable("missing")).toBe(1);
    expect(clearable("finished")).toBe(1);

    // The store reads a planning exchange's state for cleanup.
    const state = (item: CoordinatorWorkflowAssociation) =>
      (
        current.storage.coordinators as unknown as {
          workflowResourceState(item: CoordinatorWorkflowAssociation): string;
        }
      ).workflowResourceState(item);
    expect(state(stored)).toBe("active");
    await fail(current, plan.id, "op-1");
    // Failed and unreported: kept for a day after the plan last changed.
    expect(state(stored)).toBe("unknown");
    expect(state({ ...stored, terminalNotifiedAt: new Date().toISOString() })).toBe("finished");
    timers.advance(COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS + 1);
    expect(state(stored)).toBe("finished");
    expect(state({ ...stored, resourceId: "deleted-plan" })).toBe("missing");
  });
});

/*
 * Todo 0395 task 5: a feature plan the coordinator started is adopted like
 * any other workflow. Through the same `adopt_coordinator_workflow` command
 * the `adopt_workflow` tool calls, a conversation that did not start the plan
 * takes it over from a closed one and is told its planning reply is ready.
 */
describe("adopting a feature plan", () => {
  test("a reply that landed after its conversation closed reaches the adopter", async () => {
    const current = await createWorld();
    current.coordinator.startStatusWakes();
    const original = await current.main();
    const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-1");
    await associate(current, plan.id, "op-1");
    await startPlanning(current, plan.id, "op-1");
    await observeSaves(current);

    await current.closeMain();
    const created = await current.coordinator.createConversation(current.projectId, "Adopter");
    const adopterConversation = created.workspace.conversations.find((item) => !item.closedAt)!;
    await current.coordinator.assignConversationAgent(
      current.projectId,
      adopterConversation.id,
      "codex",
    );
    await current.storage.synchronizeAgentMailboxes();
    const adopter = await current.main();
    expect(adopter.conversationId).toBe(adopterConversation.id);

    const commands = createCommandRegistry();
    const context = {
      storage: current.storage,
      coordinators: current.coordinator,
      runtime: { coordinatorRequests: new CoordinatorRequestFlights() },
    } as CommandContext;
    const adopted = (await commands.get("adopt_coordinator_workflow")!(
      {
        projectId: current.projectId,
        coordinatorId: current.coordinatorId,
        conversationId: adopter.conversationId,
        associationId: "association-op-1",
      },
      context,
    )) as CoordinatorWorkflowAssociation;
    expect(adopted).toMatchObject({
      kind: "feature-plan",
      conversationId: adopter.conversationId,
      adoptedByConversationId: adopter.conversationId,
    });

    await reply(current, plan.id, "op-1");
    await observeSaves(current);
    await settle(current);
    expect(current.wakes(adopter)).toBe(1);
    expect(current.carriers(adopter)[0]![0]).toMatchObject({
      kind: "notice",
      notice: { resource: { kind: "feature-plan", id: "plan-1" }, state: "ready" },
    });
    expect(current.wakes(original)).toBe(0);
  });

  test("adopting after the reply was reported re-sends it to the adopter", async () => {
    const current = await createWorld();
    current.coordinator.startStatusWakes();
    const original = await current.main();
    const plan = await current.storage.kanban.createFeaturePlan(current.projectId, "plan-1");
    await associate(current, plan.id, "op-1");
    await startPlanning(current, plan.id, "op-1");
    await reply(current, plan.id, "op-1");
    await observeSaves(current);
    expect(current.wakes(original)).toBe(1);

    await current.closeMain();
    const created = await current.coordinator.createConversation(current.projectId, "Adopter");
    const adopterConversation = created.workspace.conversations.find((item) => !item.closedAt)!;
    await current.coordinator.assignConversationAgent(
      current.projectId,
      adopterConversation.id,
      "codex",
    );
    await current.storage.synchronizeAgentMailboxes();
    const adopter = await current.main();
    await current.storage.coordinators.adoptCoordinatorWorkflowAssociation(
      current.projectId,
      current.coordinatorId,
      "association-op-1",
      adopter.conversationId!,
    );
    await settle(current);
    expect(current.wakes(adopter)).toBe(1);
    expect(current.carriers(adopter)[0]![0]).toMatchObject({
      notice: { resource: { kind: "feature-plan", id: "plan-1" }, state: "ready" },
    });
  });
});
