import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadLedger } from "./ledger.js";
import { MAX_NEW_TICKETS, runLoop } from "./loop.js";
import { FakeBoard } from "./testing/fake-board.js";
import {
  bundleData,
  DAY,
  type EssentialLine,
  type FixtureBundle,
  HOUR,
  temporaryDirectory,
} from "./testing/fixtures.js";

const NOW = Date.parse("2026-11-09T09:00:00.000Z");
const ENV = "6e0a6a7e-1111-4222-8333-944445555666";
const KILLS = "local-server:bridge.exited:codex:SIGKILL";
const DISK = "storage:snapshot.failed:ENOSPC";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function starting(at: number, version: string): EssentialLine {
  return { at, level: "info", area: "backend", event: "starting", fields: { version } };
}

function repeat(from: number, count: number, spacing: number, line: Omit<EssentialLine, "at">) {
  return Array.from({ length: count }, (_, index) => ({ ...line, at: from + index * spacing }));
}

const kill = (from: number, count: number) =>
  repeat(from, count, DAY / 6, {
    level: "warn",
    area: "local-server",
    event: "bridge.exited",
    fields: { key: `codex:${ENV}`, signal: "SIGKILL", requested: false },
  });
const diskFull = (from: number, count: number) =>
  repeat(from, count, DAY / 2, {
    level: "error",
    area: "storage",
    event: "snapshot.failed",
    fields: { "error.code": "ENOSPC" },
  });

const BEFORE: FixtureBundle = {
  createdAt: NOW - 6 * DAY,
  appVersion: "2.30.0",
  essential: [
    starting(NOW - 13 * DAY, "2.30.0"),
    ...kill(NOW - 13 * DAY + HOUR, 42),
    ...diskFull(NOW - 13 * DAY + HOUR, 14),
  ],
};

function setup() {
  const { dir, remove } = temporaryDirectory("self-improvement-loop-");
  cleanups.push(remove);
  const board = new FakeBoard();
  const stateDir = path.join(dir, "state");
  const loop = (bundle: FixtureBundle, now: number, dryRun = false) =>
    runLoop({
      stateDir,
      data: bundleData(bundle),
      board,
      dryRun,
      now: () => new Date(now),
      insights: false,
    });
  return { board, stateDir, loop };
}

describe("a self-improvement run", () => {
  test("files labelled tickets for the worst signals, and nothing twice", async () => {
    const { board, loop, stateDir } = setup();
    const steps: string[] = [];
    const summary = await runLoop({
      stateDir,
      data: bundleData(BEFORE),
      board,
      now: () => new Date(NOW - 6 * DAY),
      onStep: (step) => steps.push(step),
    });
    expect(steps).toEqual(["board", "digesting", "filing"]);
    expect(summary.created.map((item) => item.signature)).toEqual([KILLS, DISK]);
    const ticket = board.ticketFor(KILLS);
    expect(ticket.title).toBe("[improvement] local-server bridge.exited (codex): SIGKILL");
    expect(ticket.labels).toEqual(["improvement"]);
    expect(board.labels).toEqual(new Set(["insight", "improvement"]));
    expect(ticket.description).not.toContain(ENV);
    expect(loadLedger(stateDir).entries[KILLS]).toMatchObject({
      status: "tracking",
      ticket: ticket.id,
    });
    expect(loadLedger(stateDir).entries[KILLS]!.baseline?.value).toBe(6);

    const again = await loop(BEFORE, NOW - 6 * DAY + HOUR);
    expect(again.created).toEqual([]);
    expect(board.tickets.size).toBe(2);
  });

  test("a done ticket is watched on newer versions, then confirmed or sent back", async () => {
    const { board, loop, stateDir } = setup();
    await loop(BEFORE, NOW - 6 * DAY);
    board.ticketFor(KILLS).status = "done";
    board.ticketFor(DISK).status = "done";

    const marked = await loop({ ...BEFORE, createdAt: NOW - 5 * DAY }, NOW - 5 * DAY);
    expect(marked.markedFixed.map((item) => item.signature).sort()).toEqual([KILLS, DISK].sort());
    expect(loadLedger(stateDir).entries[KILLS]).toMatchObject({
      status: "fixed",
      fixedAfter: "2.30.0",
    });

    // 2.31.0 has run for three days: the kills stopped, the disk failures did not.
    const judged = await loop(
      {
        createdAt: NOW,
        appVersion: "2.31.0",
        essential: [
          ...BEFORE.essential!,
          starting(NOW - 3 * DAY, "2.31.0"),
          ...diskFull(NOW - 3 * DAY + HOUR, 6),
        ],
      },
      NOW,
    );
    expect(judged.verified.map((item) => item.signature)).toEqual([KILLS]);
    expect(judged.fixFailed).toEqual([
      { ticket: board.ticketFor(DISK).id, signature: DISK, verdict: "unchanged" },
    ]);
    expect(board.ticketFor(KILLS).comments[0]).toContain("the fix is verified");
    expect(board.ticketFor(DISK).status).toBe("backlog");
    expect(board.ticketFor(DISK).comments[0]).toContain("did not change the rate");
    const ledger = loadLedger(stateDir);
    expect(ledger.entries[KILLS]!.status).toBe("verified");
    expect(ledger.entries[DISK]).toMatchObject({ status: "tracking" });
    expect(ledger.entries[DISK]!.fixedAfter).toBeUndefined();
  });

  test("a deleted ticket ignores its signal, and a reopened one goes back to tracking", async () => {
    const { board, loop, stateDir } = setup();
    await loop(BEFORE, NOW - 6 * DAY);
    board.tickets.delete(board.ticketFor(DISK).id);
    board.ticketFor(KILLS).status = "done";
    await loop(BEFORE, NOW - 6 * DAY + HOUR);
    expect(loadLedger(stateDir).entries[DISK]!.status).toBe("ignored");
    expect(loadLedger(stateDir).entries[KILLS]!.status).toBe("fixed");

    board.ticketFor(KILLS).status = "in-progress";
    const reopened = await loop(BEFORE, NOW - 6 * DAY + 2 * HOUR);
    expect(reopened.reopenedFromBoard.map((item) => item.signature)).toEqual([KILLS]);
    expect(loadLedger(stateDir).entries[KILLS]!.status).toBe("tracking");
    expect(board.tickets.size).toBe(1);
  });

  test("files at most a few tickets a day and links to an open ticket with the same title", async () => {
    const { board, loop } = setup();
    const many: EssentialLine[] = [starting(NOW - 5 * DAY, "2.30.0")];
    for (const code of ["EIO", "ENOSPC", "EACCES", "EPERM", "ENOENT", "EBUSY"]) {
      many.push(
        ...repeat(NOW - 5 * DAY + HOUR, 10, DAY / 2, {
          level: "error",
          area: "storage",
          event: "snapshot.failed",
          fields: { "error.code": code },
        }),
      );
    }
    board.tickets.set("7", {
      id: "7",
      title: "[improvement] storage snapshot.failed: EIO",
      status: "in-progress",
      comments: [],
      description: "",
      criteria: "",
      labels: [],
    });
    const bundle: FixtureBundle = { createdAt: NOW, appVersion: "2.30.0", essential: many };
    const summary = await loop(bundle, NOW);
    // Six equal signals rank by name: EACCES, EBUSY and EIO make the cut.
    expect(summary.linked).toEqual([{ ticket: "7", signature: "storage:snapshot.failed:EIO" }]);
    expect(summary.created.map((item) => item.signature)).toEqual([
      "storage:snapshot.failed:EACCES",
      "storage:snapshot.failed:EBUSY",
    ]);
    expect(summary.heldForTomorrow).toBe(6 - MAX_NEW_TICKETS);

    expect((await loop(bundle, NOW + HOUR)).created).toEqual([]);
    expect((await loop(bundle, NOW + DAY + HOUR)).created).toHaveLength(MAX_NEW_TICKETS);
  });

  test("a dry run reports what it would file but changes nothing", async () => {
    const { board, loop, stateDir } = setup();
    const summary = await loop(BEFORE, NOW - 6 * DAY, true);
    expect(summary.wouldCreate.map((item) => item.signature)).toEqual([KILLS, DISK]);
    expect(board.tickets.size).toBe(0);
    expect(existsSync(path.join(stateDir, "ledger.json"))).toBe(false);
  });
});
