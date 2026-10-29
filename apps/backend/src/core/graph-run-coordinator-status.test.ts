/**
 * A graph run's coordinator notices (item 208): one notice per wait, then
 * one when the run ends, through the real mail world and status wakes.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { MailWorld } from "./agent-mail-world-test-support.js";
import {
  COORDINATOR_STATUS_COALESCE_MS,
  type CoordinatorStatusWakeTimers,
} from "./coordinator-status-wakes.js";
import { humanActivation, humanRun } from "./graph-node-human-test-support.js";
import {
  graphRunCoordinatorStatus,
  graphRunWaitNoticeIsNew,
} from "./graph-run-coordinator-status.js";

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
    const ready = this.due.filter((entry) => entry.at <= this.current);
    this.due = this.due.filter((entry) => entry.at > this.current);
    for (const entry of ready) entry.callback();
  }
}

const T1 = "2026-10-29T12:00:00.000Z";
const T2 = "2026-10-29T12:05:00.000Z";

let world: MailWorld | null = null;

afterEach(async () => {
  await world?.close();
  world = null;
  setSystemTime();
});

describe("graph run coordinator status", () => {
  test("waiting names the newest open wait; running is progress; endings are terminal", () => {
    const first = humanActivation("first", T1);
    const second = humanActivation("second", T2);
    const waiting = graphRunCoordinatorStatus(
      humanRun("e1", "p1", { activations: [first, second] }),
    )!;
    expect(waiting).toMatchObject({
      key: `waiting:${T2}:${second.human!.id}`,
      state: "waiting",
      tone: "attention",
      terminal: false,
      headline: "is waiting for a person",
    });
    expect(waiting.details[0]).toBe("Approve the brief (first) waits for an approval.");
    expect(waiting.details[1]).toBe("second waits for an approval.");
    expect(graphRunCoordinatorStatus(humanRun("e1", "p1", { status: "running" }))).toBeNull();
    expect(
      graphRunCoordinatorStatus(humanRun("e1", "p1", { status: "complete", activations: [] })),
    ).toMatchObject({ key: "complete", terminal: true, tone: "success" });
    expect(
      graphRunCoordinatorStatus(
        humanRun("e1", "p1", { status: "failed", error: "Node x failed", activations: [first] }),
      ),
    ).toMatchObject({ key: "failed", terminal: true, details: ["Error: Node x failed"] });
    // A stopping run waits on nobody.
    expect(
      graphRunCoordinatorStatus(
        humanRun("e1", "p1", { status: "cancelling", activations: [first] }),
      ),
    ).toBeNull();
  });

  test("a wait is news only when it opened after the one last reported", () => {
    const a = `waiting:${T1}:a`;
    const b = `waiting:${T2}:b`;
    expect(graphRunWaitNoticeIsNew(a, undefined)).toBe(true);
    expect(graphRunWaitNoticeIsNew(b, a)).toBe(true);
    expect(graphRunWaitNoticeIsNew(a, b)).toBe(false);
    expect(graphRunWaitNoticeIsNew("complete", b)).toBe(true);
    expect(graphRunWaitNoticeIsNew(a, "complete")).toBe(true);
  });

  test("the coordinator that launched a run hears once per wait and once at its end", async () => {
    const timers = new ManualTimers();
    world = await MailWorld.create({ statusWakes: { timers } });
    const mail = world;
    const coordinator = await mail.main();
    const worker = await mail.addEnvironment("graph-env");
    const first = humanActivation("first", T1);
    let run: GraphRun = await mail.storage.graphRuns.createGraphRun(
      humanRun(worker.environmentId, mail.projectId, { activations: [first] }),
    );
    await mail.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "association-graph",
      projectId: mail.projectId,
      coordinatorId: mail.coordinatorId,
      conversationId: coordinator.conversationId!,
      kind: "graph-run",
      resourceId: run.id,
      requestId: "request-graph",
      createdAt: new Date().toISOString(),
    });
    const settle = async () => {
      await mail.coordinator.reconcileWorkflowNotifications();
      await mail.deliver();
      await mail.coordinator.statusWakes.settled();
      timers.advance(COORDINATOR_STATUS_COALESCE_MS + 1);
      await mail.deliver();
    };
    const save = async (next: Partial<GraphRun>) => {
      run = await mail.storage.graphRuns.saveGraphRun({ ...run, ...next }, run.revision);
    };

    await settle();
    expect(mail.wakes(coordinator)).toBe(1);
    const [carrier] = mail.carriers(coordinator)[0]!;
    expect(carrier).toMatchObject({
      kind: "notice",
      subject: "Graph run People in graph-env is waiting for a person",
      notice: {
        resource: { kind: "graph-run", id: run.id, environmentId: worker.environmentId },
        state: "waiting",
        tone: "attention",
      },
    });
    expect(carrier!.body).toContain("Approve the brief (first) waits for an approval.");

    // Observed again, and after the coordinator's turn: the same wait is not news.
    await mail.finishTurn(coordinator);
    await settle();
    expect(mail.wakes(coordinator)).toBe(1);

    // A second wait opens: one more notice.
    const second = humanActivation("second", T2);
    await save({ activations: [first, second] });
    await settle();
    await mail.finishTurn(coordinator);
    expect(mail.wakes(coordinator)).toBe(2);

    // The first is answered while the second still waits: nothing new to say.
    await save({ activations: [humanActivation("first", T1, { answered: true }), second] });
    await settle();
    expect(mail.wakes(coordinator)).toBe(2);

    // The run ends: one terminal notice, and the association is closed.
    await save({
      status: "complete",
      finishedAt: T2,
      activations: [
        humanActivation("first", T1, { answered: true }),
        humanActivation("second", T2, { answered: true }),
      ],
    });
    await settle();
    expect(mail.wakes(coordinator)).toBe(3);
    expect(mail.carriers(coordinator).map((turn) => turn[0]!.notice?.state)).toEqual([
      "waiting",
      "waiting",
      "completed",
    ]);
    const association = (
      await mail.storage.coordinators.listCoordinatorWorkflowAssociations(mail.projectId)
    ).find((item) => item.id === "association-graph");
    expect(association?.terminalNotifiedAt).toBeDefined();
  });
});
