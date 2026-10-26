import { describe, expect, mock, test } from "bun:test";
import { BrowserTarget, summarizeRuns } from "../../e2e/perf/hidden-resume-perf";
import { installControlledTimeout } from "../helpers/controlled-timeout";

type Run = Parameters<typeof summarizeRuns>[0][number];
const missing = (): Run => ({
  ready: { kind: "ready", messages: 3000, transcriptMiB: 8 },
  sawHidden: true,
  shown: null,
  shownReported: false,
  shownReportAfterRestoreMs: null,
  trail: [],
});
const completed = (): Run => ({
  ...missing(),
  shownReported: true,
  shownReportAfterRestoreMs: 3500,
  shown: {
    kind: "shown",
    ticksWhileHidden: 200,
    firstFrameMs: 120,
    longTasks: [120],
    longAnimationFrames: [[150, 100]],
    heapBeforeMiB: 180,
    heapAfterMiB: 190,
  },
});

function expectFiniteSummary(summary: ReturnType<typeof summarizeRuns>) {
  for (const value of Object.values(summary)) {
    if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  }
  expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
}

describe("hidden resume benchmark summary", () => {
  test("missing reports cannot lower completed metrics", () => {
    const summary = summarizeRuns([completed(), missing(), missing()]);
    expect(summary).toMatchObject({
      allHidden: true,
      allReported: false,
      reportedRuns: 1,
      unreportedRuns: 2,
      maxShownReportAfterRestoreMs: 3500,
      medianTicksWhileHidden: 200,
      medianFirstFrameMs: 120,
      medianShownLongTaskMs: 120,
      maxShownLongTaskMs: 120,
      medianShownLoafBlockingMs: 100,
      medianHeapBeforeMiB: 180,
      medianHeapAfterMiB: 190,
    });
    expectFiniteSummary(summary);
  });

  test("all missing reports have explicit null metrics", () => {
    const summary = summarizeRuns([missing(), missing()]);
    expect(summary).toEqual({
      allHidden: true,
      allReported: false,
      reportedRuns: 0,
      unreportedRuns: 2,
      maxShownReportAfterRestoreMs: null,
      medianTicksWhileHidden: null,
      medianFirstFrameMs: null,
      medianShownLongTaskMs: null,
      maxShownLongTaskMs: null,
      medianShownLoafBlockingMs: null,
      medianHeapBeforeMiB: null,
      medianHeapAfterMiB: null,
      messages: 3000,
      transcriptMiB: 8,
    });
    expectFiniteSummary(summary);
  });

  test("unavailable optional metrics stay null while observed empty task lists cost zero", () => {
    const run = completed();
    run.shown = {
      kind: "shown",
      firstFrameMs: Number.NaN,
      heapBeforeMiB: null,
      longTasks: [],
      longAnimationFrames: [],
    };
    const summary = summarizeRuns([run]);
    expect(summary).toMatchObject({
      allReported: true,
      medianFirstFrameMs: null,
      medianHeapBeforeMiB: null,
      medianHeapAfterMiB: null,
      medianShownLongTaskMs: 0,
      maxShownLongTaskMs: 0,
      medianShownLoafBlockingMs: 0,
    });
    expectFiniteSummary(summary);
  });
});

function fakeSocket() {
  return {
    onmessage: null,
    onclose: null,
    onerror: null,
    send: mock((_data: string) => {}),
    close: mock(() => {}),
  } as unknown as WebSocket;
}

const DEADLINE = 12_345;

describe("browser CDP requests", () => {
  for (const event of ["onclose", "onerror", "close"] as const) {
    test(`${event} rejects every pending command and clears its deadlines`, async () => {
      const clock = installControlledTimeout(DEADLINE, { maxPending: 2 });
      const socket = fakeSocket();
      const browser = new BrowserTarget(socket, DEADLINE);
      try {
        const first = browser.send("Target.getTargets").catch((error: unknown) => error);
        const second = browser.send("Browser.getWindowForTarget").catch((error: unknown) => error);
        expect(clock.pendingCount()).toBe(2);
        if (event === "close") browser.close();
        else if (event === "onclose") socket.onclose!(new CloseEvent("close"));
        else socket.onerror!(new Event("error"));
        for (const error of await Promise.all([first, second])) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/closed|error/);
        }
        expect(browser["pending"].size).toBe(0);
        expect(clock.pendingCount()).toBe(0);
        await expect(browser.send("Target.getTargets")).rejects.toThrow(/closed|error/);
        expect(clock.pendingCount()).toBe(0);
      } finally {
        browser.close();
        clock.restore();
      }
    });
  }

  test("a nonreplying command times out and a late response cannot settle another command", async () => {
    const clock = installControlledTimeout(DEADLINE);
    const socket = fakeSocket();
    const browser = new BrowserTarget(socket, DEADLINE);
    try {
      const timedOut = browser.send("Target.getTargets").catch((error: unknown) => error);
      expect(clock.advance()).toBe(1);
      expect(await timedOut).toBeInstanceOf(Error);
      expect(((await timedOut) as Error).message).toContain("timed out");
      expect(browser["pending"].size).toBe(0);
      const next = browser.send("Browser.getVersion");
      socket.onmessage!(
        new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { stale: true } }) }),
      );
      expect(browser["pending"].size).toBe(1);
      socket.onmessage!(
        new MessageEvent("message", {
          data: JSON.stringify({ id: 2, result: { product: "Chrome" } }),
        }),
      );
      expect(await next).toEqual({ product: "Chrome" });
      expect(browser["pending"].size).toBe(0);
      expect(clock.pendingCount()).toBe(0);
    } finally {
      browser.close();
      clock.restore();
    }
  });

  test("protocol failures and synchronous send failures clear their deadlines", async () => {
    const clock = installControlledTimeout(DEADLINE);
    const socket = fakeSocket();
    const browser = new BrowserTarget(socket, DEADLINE);
    try {
      const failed = browser.send("Invalid.command").catch((error: unknown) => error);
      socket.onmessage!(
        new MessageEvent("message", {
          data: JSON.stringify({ id: 1, error: { message: "unknown method" } }),
        }),
      );
      expect(await failed).toBeInstanceOf(Error);
      expect(((await failed) as Error).message).toContain("Invalid.command");
      socket.send = () => {
        throw new Error("send failed");
      };
      await expect(browser.send("Browser.getVersion")).rejects.toThrow("send failed");
      expect(browser["pending"].size).toBe(0);
      expect(clock.pendingCount()).toBe(0);
    } finally {
      browser.close();
      clock.restore();
    }
  });
});
