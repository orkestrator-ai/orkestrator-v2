import { describe, expect, test } from "bun:test";
import { waitForStandaloneBackendReady } from "./standalone-ready";

const encoder = new TextEncoder();

const hangingStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start() {
      // Never enqueue or close: models a child that ignores SIGTERM and keeps stdout open.
    },
  });

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const neverDrainingStderr = (chunk = "still starting\n"): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunk));
    },
  });

const readyLine = (authFile = "/tmp/ork-standalone-auth.json"): string =>
  `${JSON.stringify({
    type: "orkestrator-backend-ready",
    url: "http://127.0.0.1:9/",
    authFile,
  })}\n`;

describe("waitForStandaloneBackendReady", () => {
  test("times out with a named diagnostic without waiting for stdout to close", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = {
      stdout: hangingStream(),
      stderr: neverDrainingStderr(),
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
      },
    };
    const startedAt = performance.now();
    await expect(waitForStandaloneBackendReady(child, {
      readyTimeoutMs: 50,
      killGraceMs: 30,
      stderrDiagnosticTimeoutMs: 20,
    })).rejects.toThrow(
      "Timed out waiting for standalone backend after 50ms: <stderr not drained in time>",
    );
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(200);
    expect(signals[0]).toBe("SIGTERM");
  });

  test("escalates SIGTERM to SIGKILL after the grace period", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = {
      stdout: hangingStream(),
      stderr: hangingStream(),
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
      },
    };
    await expect(waitForStandaloneBackendReady(child, {
      readyTimeoutMs: 40,
      killGraceMs: 30,
      stderrDiagnosticTimeoutMs: 10,
    })).rejects.toThrow(/Timed out waiting for standalone backend after 40ms/);
    expect(signals).toEqual(["SIGTERM"]);
    await Bun.sleep(50);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("swallows the abandoned stdout read so it cannot become an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const child = {
        stdout: hangingStream(),
        stderr: hangingStream(),
        kill: () => undefined,
      };
      await expect(waitForStandaloneBackendReady(child, {
        readyTimeoutMs: 30,
        killGraceMs: 10,
        stderrDiagnosticTimeoutMs: 10,
      })).rejects.toThrow(/Timed out waiting for standalone backend after 30ms/);
      await Bun.sleep(40);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("does not kill a child whose ready line arrived before a slow auth-file read", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = {
      stdout: streamOf(`gateway listening\n${readyLine()}`),
      stderr: hangingStream(),
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
      },
    };
    const result = await waitForStandaloneBackendReady(child, {
      readyTimeoutMs: 80,
      killGraceMs: 40,
      readAuthFile: async () => {
        await Bun.sleep(120);
        return JSON.stringify({ token: "test-token" });
      },
    });
    expect(result).toEqual({
      url: "http://127.0.0.1:9/",
      token: "test-token",
      readyMessage: {
        type: "orkestrator-backend-ready",
        url: "http://127.0.0.1:9/",
        authFile: "/tmp/ork-standalone-auth.json",
      },
    });
    await Bun.sleep(60);
    expect(signals).toEqual([]);
  });

  test("fails immediately when the auth file has no token instead of waiting for the deadline", async () => {
    const child = {
      stdout: streamOf(readyLine()),
      stderr: hangingStream(),
      kill: () => {
        throw new Error("must not kill a backend that already printed ready");
      },
    };
    const startedAt = performance.now();
    await expect(waitForStandaloneBackendReady(child, {
      readyTimeoutMs: 5_000,
      readAuthFile: async () => JSON.stringify({}),
    })).rejects.toThrow("Backend auth file is missing its token");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
