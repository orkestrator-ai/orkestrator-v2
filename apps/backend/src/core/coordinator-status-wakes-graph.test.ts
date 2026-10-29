/**
 * Graph run status wakes (items 208 and 214, D6) on the real mail world: a
 * coordinator that launched a run hears once when it ends, and nothing about
 * runs it did not launch. Waits are covered by
 * `graph-run-coordinator-status.test.ts`. Storage, routes, budgets and the injection drain are production
 * code; only the agents, the clock and the timers are simulated.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import {
  COORDINATOR_STATUS_COALESCE_MS,
  type CoordinatorStatusWakeTimers,
} from "./coordinator-status-wakes.js";
import { graphRunFixture } from "./graph-run-test-support.js";

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

async function settle(current: MailWorld): Promise<void> {
  await current.coordinator.reconcileWorkflowNotifications();
  await current.deliver();
  await current.coordinator.statusWakes.settled();
  timers.advance(COORDINATOR_STATUS_COALESCE_MS + 1);
  await current.deliver();
}

async function associate(current: MailWorld, runId: string): Promise<void> {
  const main = await current.main();
  await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: `association-${runId}`,
    projectId: current.projectId,
    coordinatorId: current.coordinatorId,
    conversationId: main.conversationId!,
    kind: "graph-run",
    resourceId: runId,
    requestId: `request-${runId}`,
    createdAt: new Date().toISOString(),
  });
}

/** Saves the run with `change` applied, creating it first. */
async function saveRun(
  current: MailWorld,
  worker: MailActor,
  change: Partial<GraphRun>,
): Promise<GraphRun> {
  const stored = await current.storage.graphRuns.getGraphRun("run-1");
  const now = new Date(timers.now()).toISOString();
  if (!stored) {
    return current.storage.graphRuns.createGraphRun(
      graphRunFixture({
        projectId: current.projectId,
        environmentId: worker.environmentId,
        createdAt: now,
        updatedAt: now,
        ...change,
      }),
    );
  }
  return current.storage.graphRuns.saveGraphRun(
    { ...stored, ...change, updatedAt: now },
    stored.revision,
  );
}

describe("graph run status wakes", () => {
  test("one wake when a run the coordinator launched ends, however often it is saved", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("graph-env");
    const started = await saveRun(current, worker, {});
    await associate(current, started.id);

    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    // Ended: exactly one wake, then nothing (waits are item 208's
    // graph-run-coordinator-status.test.ts).
    await saveRun(current, worker, {
      status: "complete",
      activations: [],
      finishedAt: new Date(timers.now()).toISOString(),
    });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    const [carrier] = current.carriers(coordinator)[0]!;
    expect(carrier).toMatchObject({
      kind: "notice",
      notice: {
        resource: { kind: "graph-run", id: "run-1", environmentId: worker.environmentId },
        state: "completed",
        tone: "success",
      },
    });
    expect(carrier!.subject).toContain("Graph run");
    await current.finishTurn(coordinator);
    await saveRun(current, worker, { finishedAt: new Date(timers.now()).toISOString() });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    const association = (
      await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
    ).find((item) => item.resourceId === "run-1");
    expect(association?.statusNotice?.key).toBe("complete");
    expect(association?.terminalNotifiedAt).toBeDefined();
  });

  test("a run nobody's coordinator launched wakes nobody", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("graph-env");
    await saveRun(current, worker, { status: "failed", error: "boom", errorCause: "system-error" });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
  });
});
