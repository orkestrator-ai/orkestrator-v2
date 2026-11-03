/**
 * Feature-plan status wakes (todo 0395 task 3) on the real mail world: a
 * coordinator that sent a planning message hears once when its reply is ready
 * and once per failure, nothing for a cancelled exchange or one it did not
 * start, and an association kind this backend does not know is kept and
 * skipped. Storage, routes, budgets and the injection drain are production
 * code; only the agents, the clock and the timers are simulated.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import { FEATURE_PLANNING_RECORD_VERSION } from "@orkestrator/protocol/feature-planning";
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
