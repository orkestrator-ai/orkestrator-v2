/**
 * Graph run status wakes (item 214, D6) on the real mail world: a coordinator
 * that launched a run hears once when it ends and once each time it waits for
 * a person. Storage, routes, budgets and the injection drain are production
 * code; only the agents, the clock and the timers are simulated.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import {
  COORDINATOR_STATUS_COALESCE_MS,
  graphRunStatus,
  type CoordinatorStatusWakeTimers,
} from "./coordinator-status-wakes.js";
import { graphActivationFixture, graphRunFixture } from "./graph-run-test-support.js";

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

function awaiting(run: GraphRun, attempt = 1, questionId?: string): NodeActivation {
  const nodeId = run.plan.nodes[0]!.id;
  return graphActivationFixture(
    nodeId,
    { attempt },
    {
      state: "awaiting-human",
      ...(questionId
        ? {
            session: {
              question: { id: questionId },
            } as unknown as NodeActivation["session"],
          }
        : {}),
    },
  );
}

describe("graphRunStatus", () => {
  test("reduces a run to ended and waiting only", () => {
    const run = graphRunFixture();
    expect(graphRunStatus(run, run.id)).toBeNull();
    expect(graphRunStatus({ ...run, status: "paused" }, run.id)).toBeNull();
    const failed = graphRunStatus(
      { ...run, status: "failed", error: "Node build failed", errorCause: "system-error" },
      run.id,
    )!;
    expect(failed).toMatchObject({
      key: "ended:failed",
      terminal: true,
      tone: "failure",
      mode: "off",
    });
    expect(failed.details.join("\n")).toContain("Node build failed (system-error)");
    expect(failed.tools).toEqual(['get_graph_run { "runId": "run-1" }']);
    expect(graphRunStatus({ ...run, status: "complete" }, run.id)).toMatchObject({
      key: "ended:complete",
      state: "completed",
      tone: "success",
    });
    expect(graphRunStatus({ ...run, status: "cancelled" }, run.id)?.key).toBe("ended:cancelled");

    const one = graphRunStatus(
      { ...run, status: "waiting", activations: [awaiting(run)] },
      run.id,
    )!;
    expect(one).toMatchObject({ state: "waiting", tone: "attention", terminal: false });
    expect(one.key).toMatch(/^waiting:/);
    // An awaiting activation is waiting even if the run status has not caught up.
    expect(graphRunStatus({ ...run, activations: [awaiting(run)] }, run.id)?.key).toBe(one.key);
    // A new wait (another attempt, another question) has another key.
    const again = graphRunStatus(
      { ...run, status: "waiting", activations: [awaiting(run, 2)] },
      run.id,
    )!;
    expect(again.key).not.toBe(one.key);
    const asked = graphRunStatus(
      { ...run, status: "waiting", activations: [awaiting(run, 1, "q-2")] },
      run.id,
    )!;
    expect(asked.key).not.toBe(one.key);
  });
});

describe("graph run status wakes", () => {
  test("one wake when the run waits for a person and one when it ends", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("graph-env");
    const started = await saveRun(current, worker, {});
    await associate(current, started.id);

    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    // Waiting for a person: one wake.
    await saveRun(current, worker, { status: "waiting", activations: [awaiting(started)] });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    const [carrier] = current.carriers(coordinator)[0]!;
    expect(carrier).toMatchObject({
      kind: "notice",
      notice: {
        resource: { kind: "graph-run", id: "run-1", environmentId: worker.environmentId },
        state: "waiting",
        tone: "attention",
      },
    });
    expect(carrier!.subject).toContain("Graph run");
    expect(carrier!.subject).toContain("is waiting for a person");
    expect(carrier!.body).toContain('`get_graph_run { "runId": "run-1" }`');

    // Saving the same wait again, or observing it again after the turn, is not news.
    await current.finishTurn(coordinator);
    await saveRun(current, worker, { status: "waiting", activations: [awaiting(started)] });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);

    // Resumed, then waiting again on a new position: a second wake.
    await saveRun(current, worker, { status: "running", activations: [] });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    await saveRun(current, worker, { status: "waiting", activations: [awaiting(started, 2)] });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(2);

    // Ended: exactly one more wake, then nothing.
    await current.finishTurn(coordinator);
    await saveRun(current, worker, {
      status: "complete",
      activations: [],
      finishedAt: new Date(timers.now()).toISOString(),
    });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(3);
    await current.finishTurn(coordinator);
    await settle(current);
    expect(current.wakes(coordinator)).toBe(3);
    const association = (
      await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
    ).find((item) => item.resourceId === "run-1");
    expect(association?.statusNotice?.key).toBe("ended:complete");
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
