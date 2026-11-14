import { describe, expect, test } from "bun:test";
import type { ModelRunner } from "./insights/model.js";
import { RunProgress } from "./progress.js";

const START = Date.parse("2026-11-14T10:00:00.000Z");

function tracker(plan: { conversations?: boolean; dryRun?: boolean } = {}) {
  const clock = { now: START };
  const progress = new RunProgress(
    { conversations: true, dryRun: false, modelTimeoutMs: 600_000, ...plan },
    () => new Date(clock.now),
  );
  return { progress, clock };
}

const states = (progress: RunProgress) =>
  Object.fromEntries(progress.snapshot().stages.map((stage) => [stage.step, stage.state]));

describe("RunProgress stages", () => {
  test("starts on exporting with every later stage pending", () => {
    const { progress } = tracker();
    expect(states(progress)).toEqual({
      exporting: "running",
      board: "pending",
      "reading-conversations": "pending",
      "grouping-themes": "pending",
      digesting: "pending",
      filing: "pending",
    });
  });

  test("moving on finishes the stage that was running and stamps its times", () => {
    const { progress, clock } = tracker();
    clock.now += 4000;
    progress.begin("board");
    const [exporting, board] = progress.snapshot().stages;
    expect(exporting).toEqual({
      step: "exporting",
      state: "done",
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date(START + 4000).toISOString(),
    });
    expect(board).toMatchObject({ step: "board", state: "running" });
  });

  test("a stage the run passes without doing is skipped, not left pending", () => {
    const { progress } = tracker();
    progress.begin("board");
    progress.begin("reading-conversations");
    // No saved notes needed grouping, so the loop goes straight to digesting.
    progress.begin("digesting");
    expect(states(progress)).toMatchObject({
      "reading-conversations": "done",
      "grouping-themes": "skipped",
      digesting: "running",
      filing: "pending",
    });
  });

  test("with the review off its stages are skipped from the start", () => {
    const { progress } = tracker({ conversations: false });
    expect(states(progress)).toMatchObject({
      "reading-conversations": "skipped",
      "grouping-themes": "skipped",
    });
    expect(progress.snapshot().conversations).toBeUndefined();
  });

  test("a preview never files", () => {
    const { progress } = tracker({ dryRun: true });
    expect(states(progress).filing).toBe("skipped");
  });
});

describe("RunProgress heartbeat and counts", () => {
  test("every sign of life moves lastActivityAt", () => {
    const { progress, clock } = tracker();
    const at = () => progress.snapshot().lastActivityAt;
    expect(at()).toBe(new Date(START).toISOString());
    progress.begin("board");
    progress.begin("reading-conversations");
    for (const act of [
      () => progress.fileChecked(1, 10),
      () => progress.scanned(3, 0),
      () => progress.partRead(2),
      () => progress.partFailed(),
    ]) {
      clock.now += 1000;
      act();
      expect(at()).toBe(new Date(clock.now).toISOString());
    }
  });

  test("counts the conversation review as it goes", () => {
    const { progress } = tracker();
    progress.begin("board");
    progress.begin("reading-conversations");
    expect(progress.snapshot().conversations).toEqual({
      filesChecked: 0,
      files: null,
      parts: null,
      read: 0,
      failed: 0,
      notesAdded: 0,
      waiting: 0,
    });
    progress.fileChecked(40, 120);
    progress.scanned(5, 2);
    progress.partRead(3);
    progress.partRead(0);
    progress.partFailed();
    expect(progress.snapshot().conversations).toEqual({
      filesChecked: 40,
      files: 120,
      parts: 5,
      read: 2,
      failed: 1,
      notesAdded: 3,
      waiting: 2,
    });
  });

  test("a snapshot is a copy: later progress does not change it", () => {
    const { progress } = tracker();
    const before = progress.snapshot();
    progress.begin("board");
    expect(before.stages[0]!.state).toBe("running");
  });
});

describe("RunProgress model calls", () => {
  test("counts a call in flight with when it began, and clears it on success and on failure", async () => {
    const { progress, clock } = tracker();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner = progress.track((async () => {
      await gate;
      return { output: {}, costUsd: 0 };
    }) as ModelRunner);
    const call = { model: "m", system: "s", prompt: "p", schema: {} };

    const pending = runner(call);
    expect(progress.snapshot().modelCalls).toEqual({
      inFlight: 1,
      oldestStartedAt: new Date(START).toISOString(),
      timeoutMs: 600_000,
    });
    clock.now += 2000;
    const second = runner(call);
    expect(progress.snapshot().modelCalls).toMatchObject({
      inFlight: 2,
      oldestStartedAt: new Date(START).toISOString(),
    });
    release();
    await Promise.all([pending, second]);
    expect(progress.snapshot().modelCalls).toMatchObject({ inFlight: 0, oldestStartedAt: null });

    const failing = progress.track((async () => {
      throw new Error("boom");
    }) as ModelRunner);
    await expect(failing(call)).rejects.toThrow("boom");
    expect(progress.snapshot().modelCalls.inFlight).toBe(0);
  });
});
