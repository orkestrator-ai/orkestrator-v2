import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  attachToSpawnedBrowser,
  checkVisibleRetry,
  distinctAttempts,
  latestFailures,
  terminateChild,
} from "./background-tab-reconnect-support";
import type { LinkRequest, LinkRequestKind } from "./client-outage-support";

const request = (kind: LinkRequestKind, at: number): LinkRequest => ({
  owner: "background-tab",
  kind,
  at,
});

describe("distinct attempts", () => {
  test("folds a network resend into the attempt it repeats and honours the range", () => {
    const requests = [
      request("main-stream", 1_000),
      request("main-stream", 1_050),
      request("terminal-stream", 1_100),
      request("main-stream", 9_000),
      request("main-stream", 20_000),
    ];
    expect(distinctAttempts(requests, "main-stream", 0)).toEqual([1_000, 9_000, 20_000]);
    expect(distinctAttempts(requests, "main-stream", 1_000, 20_000)).toEqual([1_000, 9_000]);
  });
});

describe("latest failures", () => {
  test("needs every stream to have failed inside the window", () => {
    const requests = [request("main-stream", 10_000), request("terminal-stream", 2_000)];
    expect(latestFailures(requests, 0, 10_500, 3_000)).toBeNull();
    expect(
      latestFailures([...requests, request("terminal-stream", 9_000)], 0, 10_500, 3_000),
    ).toEqual({ "main-stream": 10_000, "terminal-stream": 9_000 });
  });

  test("a stream with no attempt since the outage began is not aligned", () => {
    expect(latestFailures([request("main-stream", 10_000)], 0, 10_100, 3_000)).toBeNull();
  });
});

describe("visible retry", () => {
  const rules = {
    restoredAt: 10_300,
    visibleAt: 10_600,
    rungFloorMs: 8_000,
    rungMarginMs: 2_000,
    budgetMs: 1_000,
    lastFailures: { "main-stream": 10_000, "terminal-stream": 9_500 },
  } as const;
  const failures = [request("main-stream", 10_000), request("terminal-stream", 9_500)];

  test("passes when both streams retry at once after the tab is shown", () => {
    const check = checkVisibleRetry({
      ...rules,
      requests: [...failures, request("main-stream", 10_650), request("terminal-stream", 10_700)],
    });
    expect(check.violations).toEqual([]);
    expect(check.streams["main-stream"].retryAfterVisibleMs).toBe(50);
    expect(check.streams["terminal-stream"].retryAfterVisibleMs).toBe(100);
  });

  test("a terminal reconnect before the tab is shown fails, however close to the edge", () => {
    // The ladder's rung, 100 ms before visibility, and nothing after it.
    const check = checkVisibleRetry({
      ...rules,
      requests: [...failures, request("main-stream", 10_650), request("terminal-stream", 10_500)],
    });
    expect(check.streams["terminal-stream"].retryAfterVisibleMs).toBe(-100);
    expect(check.violations).toEqual([
      "terminal-stream: attempted before the tab was shown",
      "terminal-stream: retried before the tab was shown",
    ]);
  });

  test("a stream whose last failure was long ago may have retried on its own rung", () => {
    const check = checkVisibleRetry({
      ...rules,
      lastFailures: { "main-stream": 10_000, "terminal-stream": 3_000 },
      requests: [
        request("main-stream", 10_000),
        request("terminal-stream", 3_000),
        request("main-stream", 10_650),
        request("terminal-stream", 10_700),
      ],
    });
    expect(check.violations).toEqual([
      "terminal-stream: the ladder's next rung may have been due when the tab was shown",
    ]);
  });

  test("a missing or late retry fails", () => {
    const check = checkVisibleRetry({
      ...rules,
      requests: [...failures, request("main-stream", 12_000)],
    });
    expect(check.violations).toEqual([
      "main-stream: retried 1400 ms after shown",
      "terminal-stream: no retry after the tab was shown",
    ]);
  });
});

/** A spawned browser stand-in: no real process, the same events and pipes. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  /** Whether SIGTERM ends it; otherwise only SIGKILL does. */
  constructor(private readonly exitsOnTerm = true) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.exitsOnTerm) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

describe("spawned browser startup", () => {
  test("attaches to the endpoint the browser prints and keeps it running", async () => {
    const child = new FakeChild();
    const attached = attachToSpawnedBrowser(child.asChild(), async (endpoint) => ({ endpoint }));
    child.stderr.write("noise\nDevTools listening on ws://127.0.0.1:9/devtools/browser/x\n");
    expect(await attached).toEqual({ endpoint: "ws://127.0.0.1:9/devtools/browser/x" });
    expect(child.signals).toEqual([]);
  });

  test("no endpoint in time: the child is terminated before startup rejects", async () => {
    const child = new FakeChild();
    let exitedBeforeReject = false;
    await attachToSpawnedBrowser(child.asChild(), async () => "browser", 10).catch((error) => {
      exitedBeforeReject = child.signalCode !== null;
      expect(String(error)).toContain("printed no DevTools endpoint");
    });
    expect(exitedBeforeReject).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("a refused attachment terminates the child before it rejects", async () => {
    const child = new FakeChild();
    const attached = attachToSpawnedBrowser(child.asChild(), async () => {
      throw new Error("CDP refused");
    });
    child.stderr.write("DevTools listening on ws://127.0.0.1:9/devtools/browser/x\n");
    await expect(attached).rejects.toThrow("CDP refused");
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("a spawn error rejects startup instead of crashing the runner", async () => {
    const child = new FakeChild();
    const attached = attachToSpawnedBrowser(child.asChild(), async () => "browser");
    child.emit("error", new Error("spawn ENOENT"));
    await expect(attached).rejects.toThrow("spawn ENOENT");
    // A later error, after startup has settled, has a listener too.
    expect(() => child.emit("error", new Error("late"))).not.toThrow();
  });

  test("an early exit rejects startup", async () => {
    const child = new FakeChild();
    const attached = attachToSpawnedBrowser(child.asChild(), async () => "browser");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(attached).rejects.toThrow("exited before it was ready");
    expect(child.signals).toEqual([]);
  });
});

describe("terminate child", () => {
  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const child = new FakeChild(false);
    await terminateChild(child.asChild(), 10);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("leaves an exited child alone", async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    await terminateChild(child.asChild());
    expect(child.signals).toEqual([]);
  });
});
