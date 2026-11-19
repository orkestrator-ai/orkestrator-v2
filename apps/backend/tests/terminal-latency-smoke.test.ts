import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { LevelResult } from "../scripts/terminal-latency";
import { spawnPty } from "../src/core/pty";

const benchmark = path.resolve(import.meta.dir, "../scripts/terminal-latency.ts");
const client = path.resolve(import.meta.dir, "../scripts/terminal-latency/client.ts");
const producer = path.resolve(import.meta.dir, "../scripts/terminal-latency/producer.ts");
const encoder = new TextEncoder();

function runClient(
  role: "observer" | "typist",
  config: Record<string, unknown>,
  onReport: (report: Record<string, unknown>) => void = () => {},
) {
  const child = spawn(process.execPath, [client, role, JSON.stringify(config)], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const reports: Record<string, unknown>[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const report = JSON.parse(line) as Record<string, unknown>;
    reports.push(report);
    onReport(report);
    if (report.type === "measurement-ready") child.stdin.write("measure\n");
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, exited, reports };
}

describe("terminal latency benchmark", () => {
  test("measures the typing window with simultaneous PTY, transcript and snapshot load", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        benchmark,
        "--only",
        "light",
        "--settle-ms",
        "250",
        "--warmup-keystrokes",
        "6",
        "--keystrokes",
        "28",
        "--key-interval-ms",
        "50",
        "--tool-burst-bytes",
        "8192",
        "--tool-burst-every-ms",
        "100",
        "--build-bytes-per-second",
        "1048576",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) throw new Error(stderr);
      const {
        results: [result],
      } = JSON.parse(stdout) as { results: [LevelResult] };
      expect(result.timeouts).toBe(0);
      expect(result.keyToEchoMs.count).toBe(28);
      expect(result.backendEchoMs.count).toBe(28);
      expect(result.transcriptReadsPerSecond).toBeGreaterThan(0);
      expect(result.checkpointsPerSecond).toBeGreaterThan(0);
      expect(result.snapshotReadMs.count).toBeGreaterThan(0);
      expect(result.typistOutputBytes).toBeGreaterThan(1000);
      expect(result.typistParsedBytes).toBe(result.typistOutputBytes);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }, 15_000);

  test("parser toggle delivers the same filtered frames and only toggles xterm writes", async () => {
    const filters: string[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const frame = (id: string, text: string) =>
      encoder.encode(
        `data: ${JSON.stringify({ event: `terminal-output-${id}`, payload: { text } })}\n\n`,
      );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/events")) {
          filters.push(url.searchParams.get("includeEvents") ?? "");
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                controller.enqueue(encoder.encode(": connected\n\n"));
                controller.enqueue(frame("build", "test build output\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        const { args } = (await request.json()) as { args: { data: string } };
        stream.enqueue(frame("interactive", args.data));
        return Response.json({ result: { delivered: true } });
      },
    });
    try {
      const results = [];
      for (const parse of [true, false]) {
        const process = runClient("typist", {
          url: server.url.toString(),
          interactiveSessionId: "interactive",
          loadSessionIds: ["build"],
          keystrokes: 1,
          warmupKeystrokes: 0,
          keyIntervalMs: 0,
          echoTimeoutMs: 1_000,
          settleMs: 0,
          parse,
          cols: 40,
          rows: 8,
        });
        try {
          expect(await process.exited).toBe(0);
          results.push(process.reports.find((report) => report.type === "typist-result")!);
        } finally {
          if (process.child.exitCode === null) process.child.kill();
        }
      }
      expect(filters).toEqual(Array(2).fill("terminal-output-interactive,terminal-output-build"));
      expect(results[0]?.receivedOutputBytes).toBe("test build output\n[0]".length);
      expect(results[1]?.receivedOutputBytes).toBe(results[0]?.receivedOutputBytes);
      expect(results[0]?.parsedBytes).toBe(results[0]?.receivedOutputBytes);
      expect(results[1]?.parsedBytes).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  for (const phase of ["before ready", "after ready"] as const) {
    test(`reports an unexpected observer SSE disconnect ${phase}`, async () => {
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (phase === "before ready") controller.close();
                else {
                  stream = controller;
                  controller.enqueue(encoder.encode(": connected\n\n"));
                }
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const observer = runClient(
        "observer",
        { url: server.url.toString(), terminalSessionIds: ["build"] },
        (report) => {
          if (report.type === "ready") stream?.close();
        },
      );
      try {
        expect(await observer.exited).toBe(1);
        expect(observer.reports.some((report) => report.type === "ready")).toBe(
          phase === "after ready",
        );
        expect(observer.reports.at(-1)).toMatchObject({
          type: "error",
          message: "SSE stream closed unexpectedly",
        });
      } finally {
        if (observer.child.exitCode === null) observer.child.kill();
        await server.stop(true);
      }
    });
  }

  test("an observer exercises the snapshot invoke after a desync notice", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const invocation = Promise.withResolvers<unknown>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("/invoke")) {
          invocation.resolve(await request.json());
          return Response.json({ result: { output: "latest screen" } });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode(": connected\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const observer = runClient(
      "observer",
      { url: server.url.toString(), terminalSessionIds: ["build"] },
      (report) => {
        if (report.type === "ready") {
          stream?.enqueue(
            encoder.encode(
              'data: {"event":"terminal-output-build","payload":{"desynced":true}}\n\n',
            ),
          );
        }
      },
    );
    try {
      expect(await Promise.race([invocation.promise, observer.exited])).toEqual({
        command: "get_terminal_state_snapshot",
        args: { sessionId: "build" },
      });
      observer.child.stdin.write("report\n");
      expect(await observer.exited).toBe(0);
      expect(observer.reports.at(-1)).toMatchObject({ type: "observer-result", desyncs: 1 });
    } finally {
      if (observer.child.exitCode === null) observer.child.kill();
      await server.stop(true);
    }
  });

  test("build producer carries byte credit and leaves newline conversion to the PTY", async () => {
    const rate = 1_000;
    const at = performance.now();
    const pty = spawnPty(process.execPath, [producer, "build", String(rate)], {
      cols: 120,
      rows: 32,
    });
    let output = "";
    const received = Promise.withResolvers<void>();
    pty.onData((data) => {
      output += data;
      if (output.split("\r\n").length >= 4) received.resolve();
    });
    const outputDeadline = setTimeout(
      () => received.reject(new Error("Producer emitted no rows")),
      3_000,
    );
    try {
      await received.promise;
      const sourceBytes = Buffer.byteLength(output.replaceAll("\r\n", "\n"));
      const elapsedBudget = rate * ((performance.now() - at) / 1000);
      expect(sourceBytes).toBeLessThanOrEqual(elapsedBudget + 80);
      expect(output).not.toContain("\r\r\n");
      expect(output).toMatch(/\r\n/);
    } finally {
      clearTimeout(outputDeadline);
      await pty.terminate();
    }
  });
});
