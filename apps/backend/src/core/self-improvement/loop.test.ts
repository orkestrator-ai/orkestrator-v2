import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadLedger, saveLedger } from "./ledger.js";
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

/** Two days of 2.31.0 after the kills stopped: KILLS verified, DISK sent back. */
const FIXED_RELEASE: FixtureBundle = {
  createdAt: NOW,
  appVersion: "2.31.0",
  essential: [
    ...BEFORE.essential!,
    starting(NOW - 3 * DAY, "2.31.0"),
    ...diskFull(NOW - 3 * DAY + HOUR, 6),
  ],
};

/** The kills are back on 2.31.0, more often than half the baseline. */
const KILLS_BACK: FixtureBundle = {
  createdAt: NOW + 3 * DAY,
  appVersion: "2.31.0",
  essential: [
    ...FIXED_RELEASE.essential!,
    ...repeat(NOW + HOUR, 30, DAY / 12, {
      level: "warn",
      area: "local-server",
      event: "bridge.exited",
      fields: { key: `codex:${ENV}`, signal: "SIGKILL", requested: false },
    }),
  ],
};

/** Files on `board`, marks both done and runs the release: KILLS ends verified. */
async function verifyKills(board: FakeBoard, stateDir: string, boardFor?: LoopBoards) {
  const run = (bundle: FixtureBundle, now: number) =>
    runLoop({
      stateDir,
      data: bundleData(bundle),
      board,
      boardFor,
      now: () => new Date(now),
      insights: false,
    });
  await run(BEFORE, NOW - 6 * DAY);
  board.ticketFor(KILLS).status = "done";
  board.ticketFor(DISK).status = "done";
  await run({ ...BEFORE, createdAt: NOW - 5 * DAY }, NOW - 5 * DAY);
  await run(FIXED_RELEASE, NOW);
  expect(loadLedger(stateDir).entries[KILLS]!.status).toBe("verified");
}

type LoopBoards = (projectId: string) => FakeBoard;

describe("tickets on another project's board", () => {
  function twoProjects() {
    const { dir, remove } = temporaryDirectory("self-improvement-projects-");
    cleanups.push(remove);
    const stateDir = path.join(dir, "state");
    const a = new FakeBoard("pA", 100);
    const b = new FakeBoard("pB", 500);
    const boards: LoopBoards = (projectId) => (projectId === "pA" ? a : b);
    const loop = (
      board: FakeBoard,
      bundle: FixtureBundle,
      now: number,
      reachable: "all-boards" | "this-board-only" = "all-boards",
    ) =>
      runLoop({
        stateDir,
        data: bundleData(bundle),
        board,
        boardFor: reachable === "all-boards" ? boards : undefined,
        now: () => new Date(now),
        insights: false,
      });
    return { stateDir, a, b, boards, loop };
  }

  test("switching the project keeps the old tickets tracked on their own board", async () => {
    const { stateDir, a, b, loop } = twoProjects();
    await loop(a, BEFORE, NOW - 6 * DAY);
    expect(loadLedger(stateDir).entries[KILLS]).toMatchObject({
      status: "tracking",
      projectId: "pA",
    });

    // New tickets go to B now; A's are neither ignored nor filed again.
    const switched = await loop(b, BEFORE, NOW - 6 * DAY + HOUR);
    expect(switched.ignoredDeleted).toEqual([]);
    expect(switched.created).toEqual([]);
    expect(b.tickets.size).toBe(0);
    expect(loadLedger(stateDir).entries[KILLS]!.status).toBe("tracking");

    // A ticket done on A is still seen while B is chosen.
    a.ticketFor(KILLS).status = "done";
    const marked = await loop(b, BEFORE, NOW - 6 * DAY + 2 * HOUR);
    expect(marked.markedFixed.map((item) => item.signature)).toEqual([KILLS]);

    // Back on A, nothing became ignored.
    await loop(a, BEFORE, NOW - 6 * DAY + 3 * HOUR);
    const statuses = Object.values(loadLedger(stateDir).entries).map((entry) => entry.status);
    expect(statuses).not.toContain("ignored");
  });

  test("without a way to reach the old board, its tickets are left as they are", async () => {
    const { stateDir, a, b, loop } = twoProjects();
    await loop(a, BEFORE, NOW - 6 * DAY);
    a.tickets.clear();
    const summary = await loop(b, BEFORE, NOW - 6 * DAY + HOUR, "this-board-only");
    expect(summary.ignoredDeleted).toEqual([]);
    expect(loadLedger(stateDir).entries[DISK]!.status).toBe("tracking");
  });

  test("a regression on a ticket from the old project is reported on that project", async () => {
    const { stateDir, a, b, boards, loop } = twoProjects();
    await verifyKills(a, stateDir, boards);
    const regressed = await loop(b, KILLS_BACK, NOW + 3 * DAY);
    expect(regressed.fixFailed).toContainEqual({
      ticket: a.ticketFor(KILLS).id,
      signature: KILLS,
      verdict: "regressed",
    });
    expect(a.ticketFor(KILLS).comments.at(-1)).toContain("the problem has come back");
    expect(a.ticketFor(KILLS).status).toBe("backlog");
    expect(loadLedger(stateDir).entries[KILLS]!.status).toBe("tracking");
  });

  test("an entry saved without a project is placed by where its ticket is", async () => {
    const { stateDir, a, b, loop } = twoProjects();
    await loop(a, BEFORE, NOW - 6 * DAY);
    const ledger = loadLedger(stateDir);
    for (const entry of Object.values(ledger.entries)) delete entry.projectId;
    saveLedger(stateDir, ledger);
    const ids = new Set(a.tickets.keys());
    b.locate = async (ticketId: string) => (ids.has(ticketId) ? "pA" : null);
    const summary = await loop(b, BEFORE, NOW - 6 * DAY + HOUR);
    expect(summary.ignoredDeleted).toEqual([]);
    expect(loadLedger(stateDir).entries[KILLS]).toMatchObject({
      status: "tracking",
      projectId: "pA",
    });
  });
});

describe("a verified fix on the board", () => {
  test("reopening its ticket by hand sends it back to tracking", async () => {
    const { board, loop, stateDir } = setup();
    await verifyKills(board, stateDir);
    board.ticketFor(KILLS).status = "in-progress";
    const summary = await loop(FIXED_RELEASE, NOW + HOUR);
    expect(summary.reopenedFromBoard.map((item) => item.signature)).toContain(KILLS);
    const entry = loadLedger(stateDir).entries[KILLS]!;
    expect(entry.status).toBe("tracking");
    expect(entry.fixedAfter).toBeUndefined();
    expect(entry.fixedIn).toBeUndefined();
  });

  test("deleting its ticket ignores the signal, and a later regression touches nothing", async () => {
    const { board, loop, stateDir } = setup();
    await verifyKills(board, stateDir);
    const deleted = board.ticketFor(KILLS).id;
    board.tickets.delete(deleted);
    const summary = await loop(KILLS_BACK, NOW + 3 * DAY);
    expect(summary.ignoredDeleted).toContainEqual({ ticket: deleted, signature: KILLS });
    expect(summary.fixFailed.map((item) => item.signature)).not.toContain(KILLS);
    expect(loadLedger(stateDir).entries[KILLS]!.status).toBe("ignored");
  });

  test("a verified fix that regresses goes back to the backlog", async () => {
    const { board, loop, stateDir } = setup();
    await verifyKills(board, stateDir);
    const summary = await loop(KILLS_BACK, NOW + 3 * DAY);
    expect(summary.fixFailed).toContainEqual({
      ticket: board.ticketFor(KILLS).id,
      signature: KILLS,
      verdict: "regressed",
    });
    expect(board.ticketFor(KILLS).status).toBe("backlog");
  });
});

describe("a run that fails part-way through filing", () => {
  test("keeps the tickets it filed, and the rerun files only the rest", async () => {
    const { board, loop, stateDir } = setup();
    board.failures.create = 2;
    await expect(loop(BEFORE, NOW - 6 * DAY)).rejects.toThrow("create failed");
    expect(board.tickets.size).toBe(1);
    const saved = loadLedger(stateDir).entries[KILLS]!;
    expect(saved.ticket).toBe(board.ticketFor(KILLS).id);
    expect(loadLedger(stateDir).entries[DISK]).toBeUndefined();

    const rerun = await loop(BEFORE, NOW - 6 * DAY + HOUR);
    expect(rerun.created.map((item) => item.signature)).toEqual([DISK]);
    expect(board.tickets.size).toBe(2);
    // Both count towards the day's limit.
    expect((await loop(BEFORE, NOW - 6 * DAY + 2 * HOUR)).created).toEqual([]);
  });

  test("does not post a verdict comment twice when the rerun repeats it", async () => {
    const { board, loop, stateDir } = setup();
    await loop(BEFORE, NOW - 6 * DAY);
    board.ticketFor(KILLS).status = "done";
    board.ticketFor(DISK).status = "done";
    await loop({ ...BEFORE, createdAt: NOW - 5 * DAY }, NOW - 5 * DAY);

    // DISK's verdict is commented, then moving its ticket fails.
    board.failures.moveToBacklog = 1;
    await expect(loop(FIXED_RELEASE, NOW)).rejects.toThrow("moveToBacklog failed");
    expect(board.ticketFor(DISK).comments).toHaveLength(1);
    expect(loadLedger(stateDir).entries[DISK]!.status).toBe("fixed");

    const rerun = await loop(FIXED_RELEASE, NOW);
    expect(rerun.fixFailed.map((item) => item.signature)).toEqual([DISK]);
    expect(board.ticketFor(DISK).comments).toHaveLength(1);
    expect(board.ticketFor(DISK).status).toBe("backlog");
    expect(board.ticketFor(KILLS).comments).toHaveLength(1);
    expect(loadLedger(stateDir).entries[DISK]!.status).toBe("tracking");
  });
});
