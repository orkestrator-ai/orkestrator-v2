import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedSelfImprovementSettings } from "@orkestrator/protocol/self-improvement";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import {
  DAILY_RUN_INTERVAL_MS,
  type SelfImprovementDeps,
  SelfImprovementService,
} from "./service.js";
import { FakeBoard } from "./testing/fake-board.js";
import {
  bundleArchive,
  DAY,
  type EssentialLine,
  HOUR,
  temporaryDirectory,
} from "./testing/fixtures.js";

const NOW = Date.parse("2026-11-09T09:00:00.000Z");
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ESSENTIAL: EssentialLine[] = [
  {
    at: NOW - 5 * DAY,
    level: "info",
    area: "backend",
    event: "starting",
    fields: { version: "2.30.0" },
  },
  ...Array.from({ length: 10 }, (_, index): EssentialLine => ({
    at: NOW - 4 * DAY + index * HOUR,
    level: "error",
    area: "storage",
    event: "snapshot.failed",
    fields: { "error.code": "ENOSPC" },
  })),
];

interface Harness {
  service: SelfImprovementService;
  board: FakeBoard;
  timers: Array<{ ms: number; callback: () => void; cancelled: boolean }>;
  config: { enabled: boolean; settings: ResolvedSelfImprovementSettings };
  clock: { now: number };
  exportCalls: number;
  failExport: boolean;
}

function harness(overrides: Partial<SelfImprovementDeps> = {}): Harness {
  const { dir, remove } = temporaryDirectory("self-improvement-service-");
  const board = new FakeBoard();
  const state: Harness = {
    service: undefined as never,
    board,
    timers: [],
    config: {
      enabled: true,
      settings: { projectId: "p1", conversationReview: false, dailyRun: false },
    },
    clock: { now: NOW },
    exportCalls: 0,
    failExport: false,
  };
  state.service = new SelfImprovementService({
    dataDir: dir,
    config: async () => state.config,
    projectName: async (id) => (id === "p1" ? "orkestrator-v2" : null),
    exportBundle: async () => {
      state.exportCalls += 1;
      if (state.failExport) throw new Error("/home/someone/secret path");
      return bundleArchive({
        createdAt: state.clock.now,
        appVersion: "2.30.0",
        essential: ESSENTIAL,
      });
    },
    board: () => board,
    claudeLaunch: async () => {
      throw new Error("not used: the conversation review is off");
    },
    now: () => new Date(state.clock.now),
    setTimer: (callback, ms) => {
      const timer = { ms, callback, cancelled: false };
      state.timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    ...overrides,
  });
  cleanups.push(remove, () => state.service.stop());
  return state;
}

async function settle(service: SelfImprovementService): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await service.status()).running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the run did not finish");
}

describe("starting a run", () => {
  test("refuses while the switch is off, and without a project that exists", async () => {
    const h = harness();
    h.config.enabled = false;
    expect(await h.service.run({ trigger: "manual" })).toMatchObject({
      started: false,
      refusal: "disabled",
    });
    h.config.enabled = true;
    h.config.settings = { ...h.config.settings, projectId: null };
    expect(await h.service.run({ trigger: "manual" })).toMatchObject({
      started: false,
      refusal: "no-project",
    });
    h.config.settings = { ...h.config.settings, projectId: "gone" };
    expect(await h.service.run({ trigger: "manual" })).toMatchObject({
      started: false,
      refusal: "no-project",
    });
    expect(h.exportCalls).toBe(0);
  });

  test("runs in the background, one at a time, and reports what it filed", async () => {
    const h = harness();
    const started = await h.service.run({ trigger: "manual" });
    expect(started.started).toBe(true);
    expect(started.status.running).toMatchObject({ trigger: "manual" });
    expect(await h.service.run({ trigger: "manual" })).toMatchObject({
      started: false,
      refusal: "already-running",
    });
    await settle(h.service);

    const status = await h.service.status();
    expect(status.project).toEqual({ id: "p1", name: "orkestrator-v2" });
    expect(status.lastRun).toMatchObject({ trigger: "manual", outcome: "succeeded" });
    expect(status.lastRun!.created.map((item) => item.signature)).toEqual([
      "storage:snapshot.failed:ENOSPC",
    ]);
    expect(status.tracked).toEqual([
      expect.objectContaining({
        signature: "storage:snapshot.failed:ENOSPC",
        kind: "diagnostics",
        status: "tracking",
        ticket: status.lastRun!.created[0]!.ticket,
      }),
    ]);
    expect(h.board.tickets.size).toBe(1);
  });

  test("a failed export is recorded with a fixed reason, never the error text", async () => {
    const h = harness();
    h.failExport = true;
    await h.service.run({ trigger: "manual" });
    await settle(h.service);
    const { lastRun } = await h.service.status();
    expect(lastRun).toMatchObject({
      outcome: "failed",
      error: "Could not export this machine's diagnostics.",
    });
    expect(JSON.stringify(lastRun)).not.toContain("secret path");
  });

  test("the failure log names the step and the error type, never its text", async () => {
    const capture = captureLogs();
    cleanups.push(() => capture.restore());
    const h = harness();
    h.failExport = true;
    await h.service.run({ trigger: "manual" });
    await settle(h.service);
    const failed = capture.records().find((record) => record.event === "run.failed");
    expect(failed?.fields).toMatchObject({ reason: "exporting" });
    expect(capture.lines.join("\n")).not.toContain("secret path");
  });

  test("a backend without the data directory's writer lease never runs", async () => {
    let writer = false;
    const h = harness({ isWriter: () => writer });
    h.config.settings = { ...h.config.settings, dailyRun: true };
    expect(await h.service.run({ trigger: "manual" })).toMatchObject({
      started: false,
      refusal: "not-writer",
    });
    await h.service.checkDaily();
    expect(h.exportCalls).toBe(0);
    expect((await h.service.status()).running).toBeNull();

    writer = true;
    await h.service.checkDaily();
    await settle(h.service);
    expect(h.exportCalls).toBe(1);
  });
});

describe("the daily run", () => {
  test("runs only while the switch and the daily run are on, then waits a day", async () => {
    const h = harness();
    h.service.start();
    expect(h.timers).toHaveLength(1);

    await h.service.checkDaily();
    expect(h.exportCalls).toBe(0);

    h.config.settings = { ...h.config.settings, dailyRun: true };
    h.config.enabled = false;
    await h.service.checkDaily();
    expect(h.exportCalls).toBe(0);

    h.config.enabled = true;
    await h.service.checkDaily();
    await settle(h.service);
    expect(h.exportCalls).toBe(1);
    expect((await h.service.status()).lastRun?.trigger).toBe("daily");

    h.clock.now += DAILY_RUN_INTERVAL_MS - HOUR;
    await h.service.checkDaily();
    expect(h.exportCalls).toBe(1);
    expect((await h.service.status()).nextDailyRunAt).toBe(
      new Date(NOW + DAILY_RUN_INTERVAL_MS).toISOString(),
    );

    h.clock.now += HOUR;
    await h.service.checkDaily();
    await settle(h.service);
    expect(h.exportCalls).toBe(2);
  });

  test("a dry run does not move the daily schedule and files nothing", async () => {
    const h = harness();
    h.config.settings = { ...h.config.settings, dailyRun: true };
    await h.service.run({ trigger: "dry-run" });
    await settle(h.service);
    const status = await h.service.status();
    expect(status.lastRun).toMatchObject({ trigger: "dry-run", outcome: "succeeded" });
    expect(status.lastRun!.wouldCreate).toHaveLength(1);
    expect(h.board.tickets.size).toBe(0);
    expect(status.nextDailyRunAt).toBe(new Date(NOW).toISOString());
  });

  test("stop cancels the timer and refuses new runs", async () => {
    const h = harness();
    h.service.start();
    await h.service.stop();
    expect(h.timers[0]!.cancelled).toBe(true);
    expect(await h.service.run({ trigger: "manual" })).toMatchObject({
      started: false,
      refusal: "disabled",
    });
  });
});
