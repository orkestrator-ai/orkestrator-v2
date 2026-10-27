import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrkestratorGateway } from "./gateway.js";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import {
  aggregateArrivals,
  openTerminalSocket,
  parseOptions,
  rawWebSocket,
  runCase,
  WORKLOADS,
} from "../scripts/remote-bandwidth-baseline.js";
import { startThrottle } from "../scripts/remote-bandwidth-throttle.js";
import { TERMINAL_WEBSOCKET_SUBPROTOCOL } from "@orkestrator/protocol/terminal-websocket";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function protocolServer(
  handler: (
    ws: import("ws").WebSocket,
    frame: { type: string; requestId: number; sessionId: string },
  ) => void,
) {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: () => TERMINAL_WEBSOCKET_SUBPROTOCOL,
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on("connection", (ws) =>
    ws.on("message", (data) => handler(ws, JSON.parse(data.toString()))),
  );
  return { server, port: (server.address() as { port: number }).port };
}

function subscribed(ws: import("ws").WebSocket, frame: { requestId: number; sessionId: string }) {
  ws.send(
    JSON.stringify({
      type: "subscribed",
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      channelId: frame.requestId,
      targetGeneration: 1,
      targetRevision: 0,
      recovery: "snapshot-required",
      baseGeneration: null,
      baseRevision: null,
    }),
  );
}

describe("bandwidth options", () => {
  test("accepts the channel boundary and reports per-socket and aggregate limits", () => {
    expect(parseOptions(["--sessions", "256"]).sessions).toEqual([256]);
    expect(() => parseOptions(["--sessions", "257"])).toThrow("per-socket limit");
    expect(() => parseOptions(["--sessions", "256", "--clients", "16"])).toThrow(
      "aggregate capacity",
    );
    expect(() => parseOptions(["--clients", "65"])).toThrow("aggregate capacity");
    expect(parseOptions(["--transports", "body", "--sessions", "257"]).sessions).toEqual([257]);
  });
  for (const args of [
    ["--unknown"],
    ["--clients"],
    ["--clients", "0"],
    ["--sessions", "1.5"],
    ["--seed", "9007199254740992"],
    ["--transports", "bad"],
    ["--workloads", "bad"],
  ]) {
    test(`rejects invalid options ${args.join(" ")}`, () =>
      expect(() => parseOptions(args)).toThrow());
  }
});

describe("completion aggregation", () => {
  const emitted = new Map([
    ["terminal:1", 10],
    ["terminal:2", 20],
    ["agent:1", 30],
  ]);
  const finals = ["terminal:2", "agent:1"];
  const complete = [
    { key: "terminal:1", at: 12 },
    { key: "terminal:2", at: 50 },
    { key: "agent:1", at: 35 },
  ];
  test("requires every healthy client and deduplicates first arrivals", () => {
    expect(aggregateArrivals(emitted, [complete, complete.slice(0, 2)], finals, 30)).toMatchObject({
      missing: 1,
      completion: null,
    });
    expect(
      aggregateArrivals(emitted, [[...complete, { key: "agent:1", at: 99 }], complete], finals, 30),
    ).toEqual({ firstUpdate: [2, 30, 5, 2, 30, 5], missing: 0, completion: 20 });
  });
  test("a fast agent final cannot hide queued terminal output or a missing session", () => {
    expect(
      aggregateArrivals(emitted, [[{ key: "agent:1", at: 35 }]], finals, 30).completion,
    ).toBeNull();
    expect(
      aggregateArrivals(emitted, [complete], [...finals, "other-terminal:1"], 30).completion,
    ).toBeNull();
    expect(aggregateArrivals(new Map(), [[]], [], 0).completion).toBeNull();
  });
});

describe("subscription startup", () => {
  test("256 subscriptions succeed, 257 receive a prompt protocol denial", async () => {
    const { port, server } = await protocolServer((ws, frame) => {
      if (frame.type === "authenticate")
        ws.send(JSON.stringify({ type: "ready", version: 1, socketId: "test-socket" }));
      else if (frame.requestId <= 256) subscribed(ws, frame);
      else
        ws.send(
          JSON.stringify({
            type: "error",
            code: "subscription-denied",
            message: "capacity",
            requestId: frame.requestId,
          }),
        );
    });
    const ids = Array.from({ length: 256 }, (_, index) => `session-${index}`);
    const connection = await openTerminalSocket(
      port,
      "synthetic-token",
      ids,
      false,
      () => undefined,
      500,
    );
    connection.close();
    await expect(
      openTerminalSocket(port, "synthetic-token", [...ids, "extra"], false, () => undefined, 500),
    ).rejects.toThrow("subscription-denied");
    await sleep(20);
    expect(server.clients.size).toBe(0);
  });
  for (const mode of ["denial", "close", "timeout", "malformed"] as const) {
    test(`cleans up on ${mode} before all subscribed replies`, async () => {
      const { port, server } = await protocolServer((ws, frame) => {
        if (frame.type === "authenticate")
          ws.send(JSON.stringify({ type: "ready", version: 1, socketId: "test-socket" }));
        else if (frame.requestId === 1) subscribed(ws, frame);
        else if (mode === "denial")
          ws.send(
            JSON.stringify({
              type: "error",
              code: "subscription-denied",
              message: "aggregate capacity",
            }),
          );
        else if (mode === "close") ws.close();
        else if (mode === "malformed") ws.send("invalid control");
      });
      await expect(
        openTerminalSocket(port, "synthetic-token", ["one", "two"], false, () => undefined, 100),
      ).rejects.toThrow();
      await sleep(20);
      expect(server.clients.size).toBe(0);
    });
  }
  test("aggregate refusal after partial startup releases the real gateway and temporary data", async () => {
    const start = OrkestratorGateway.prototype.start;
    let captured: { dataDir: string; port: number; clients: Map<unknown, unknown> } | undefined;
    const spy = spyOn(OrkestratorGateway.prototype, "start").mockImplementation(async function (
      this: OrkestratorGateway,
    ) {
      const info = await start.call(this);
      const internal = this as unknown as {
        context: { dataDir: string };
        terminalWebSocket: { maxChannels: number };
        clients: Map<unknown, unknown>;
      };
      // Simulate capacity being consumed elsewhere after option validation.
      internal.terminalWebSocket.maxChannels = 1;
      captured = {
        dataDir: internal.context.dataDir,
        port: Number(new URL(info!.url).port),
        clients: internal.clients,
      };
      return info;
    });
    cleanups.push(() => spy.mockRestore());
    const options = parseOptions(["--clients", "1", "--no-slow-client", "--duration-ms", "50"]);
    await expect(runCase(options, "websocket", WORKLOADS[0]!, 2)).rejects.toThrow(
      "subscription-denied",
    );
    expect(captured!.clients.size).toBe(0);
    await expect(access(captured!.dataDir)).rejects.toThrow();
    await expect(rawWebSocket(captured!.port, () => undefined)).rejects.toThrow();
  });

  test("real gateway supports the 256-channel boundary and rejects overcapacity before allocation", async () => {
    const options = parseOptions([
      "--clients",
      "1",
      "--no-slow-client",
      "--duration-ms",
      "50",
      "--idle-ms",
      "0",
    ]);
    expect((await runCase(options, "websocket", WORKLOADS[0]!, 256)).framesMissing).toBe(0);
    await expect(runCase(options, "websocket", WORKLOADS[0]!, 257)).rejects.toThrow(
      "per-socket limit",
    );
  });
});

describe("real gateway metric aggregation", () => {
  test("a fast agent final cannot complete a case with terminal output still on the link", async () => {
    const options = parseOptions([
      "--clients",
      "1",
      "--no-slow-client",
      "--duration-ms",
      "160",
      "--idle-ms",
      "30",
      "--rate-kbps",
      "512",
    ]);
    const result = await runCase(
      options,
      "websocket",
      {
        id: "queued-terminal-fast-agent",
        description: "One large terminal frame with fast independent agent events",
        terminalIntervalMs: 100,
        terminalChunk: () => "x".repeat(32 * 1024),
        agentIntervalMs: 20,
        agentPayload: (_random, revision) => ({ revision }),
      },
      1,
    );
    expect(result.framesTimed).toBeGreaterThan(0);
    expect(result.framesMissing).toBeGreaterThan(0);
    expect(result.latencyMs.completion).toBeNull();
  });

  for (const transport of ["body", "on", "websocket"] as const) {
    test(`${transport} measures both producers at every healthy client`, async () => {
      const options = parseOptions([
        "--transports",
        transport,
        "--clients",
        "2",
        "--no-slow-client",
        "--duration-ms",
        "140",
        "--idle-ms",
        "200",
      ]);
      const result = await runCase(
        options,
        transport,
        WORKLOADS.find((workload) => workload.id === "agent-build")!,
        2,
      );
      expect(result.framesTimed).toBeGreaterThan(0);
      expect(result.framesMissing).toBe(0);
      expect(result.latencyMs.completion).not.toBeNull();
      expect(result.wire.healthyBytesPerClient).toBeGreaterThan(0);
      expect(result.gateway.sseSourceBytes).toBeGreaterThan(0);
      if (transport === "websocket")
        expect(result.gateway.websocketOutputPayloadBytes).toBeGreaterThan(0);
    });
  }
});

describe("raw socket and link", () => {
  test("upgrade close, timeout and socket errors reject promptly", async () => {
    const peers = new Set<Socket>();
    const server = createServer((peer) => {
      peers.add(peer);
      peer.on("close", () => peers.delete(peer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    cleanups.push(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await expect(
      rawWebSocket(
        port,
        () => undefined,
        () => undefined,
        30,
      ),
    ).rejects.toThrow("timed out");
    server.on("connection", (peer) => peer.destroy());
    await expect(rawWebSocket(port, () => undefined)).rejects.toThrow();
  });
  test("parses split binary and extended-length text frames", async () => {
    const { port } = await protocolServer((ws) => {
      ws.send("x".repeat(130));
      ws.send(Buffer.alloc(70_000, 1));
    });
    const messages: Array<{ bytes: number; binary: boolean }> = [];
    const connection = await rawWebSocket(port, (data, binary) =>
      messages.push({ bytes: data.length, binary }),
    );
    cleanups.push(() => connection.socket.destroy());
    connection.send(JSON.stringify({ type: "trigger" }));
    for (let i = 0; i < 50 && messages.length < 2; i++) await sleep(5);
    expect(messages).toEqual([
      { bytes: 130, binary: false },
      { bytes: 70_000, binary: true },
    ]);
  });
  test("a constrained stopped reader reaches the real gateway's slow-consumer limit", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-bandwidth-test-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const token = randomBytes(24).toString("hex");
    const gateway = new OrkestratorGateway({
      backend: {
        invoke: async (command) =>
          command === "get_terminal_session"
            ? { running: true }
            : { output: "", generation: 1, revision: 0, truncated: false },
      },
      dataDir,
      rendererRoot: dataDir,
      bindAddress: "127.0.0.1",
      port: 0,
      allowNonTailscaleBind: true,
      env: { ORKESTRATOR_GATEWAY_TOKEN: token },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    cleanups.push(() => gateway.stop());
    const info = await gateway.start();
    const throttle = await startThrottle(Number(new URL(info!.url).port), 512, 2);
    cleanups.push(() => throttle.close());
    const client = await openTerminalSocket(
      throttle.port,
      token,
      ["stopped-reader"],
      true,
      () => undefined,
    );
    cleanups.push(() => client.close());
    for (let revision = 1; revision <= 512; revision++) {
      gateway.emit("terminal-output-stopped-reader", {
        text: "x".repeat(16 * 1024),
        generation: 1,
        revision,
      });
      if (revision % 16 === 0) await sleep(1);
    }
    await sleep(100);
    const metrics = (
      gateway as unknown as { metrics: { snapshot(): { terminalWebSocket: { desyncs: number } } } }
    ).metrics.snapshot();
    expect(metrics.terminalWebSocket.desyncs).toBeGreaterThan(0);
    expect(throttle.peakBufferedBytes()).toBeLessThanOrEqual(128 * 1024);
  });

  test("paces output at the configured rate and cancels delayed writes on close", async () => {
    let peer: Socket | undefined;
    const server = createServer((socket) => {
      peer = socket;
      socket.write(Buffer.alloc(32 * 1024));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const throttle = await startThrottle((server.address() as { port: number }).port, 512, 20);
    cleanups.push(() => throttle.close());
    const client = connect(throttle.port, "127.0.0.1");
    cleanups.push(() => client.destroy());
    let received = 0;
    const started = performance.now();
    await new Promise<void>((resolve) =>
      client.on("data", (chunk) => {
        received += chunk.length;
        if (received === 32 * 1024) resolve();
      }),
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    peer!.write(Buffer.alloc(32 * 1024));
    await sleep(5);
    await throttle.close();
    expect(throttle.bufferedBytes()).toBe(0);
  });

  test("blocked downstream stays bounded and backpressures the producer", async () => {
    let produced = 0;
    let source: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((peer) => {
      source = peer;
      const write = () => {
        if (peer.destroyed) return;
        for (let i = 0; i < 32; i++) {
          produced += 16 * 1024;
          if (!peer.write(Buffer.alloc(16 * 1024))) {
            peer.once("drain", write);
            return;
          }
        }
        timer = setTimeout(write, 0);
      };
      write();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      if (timer) clearTimeout(timer);
      source?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const throttle = await startThrottle((server.address() as { port: number }).port, 100_000, 1);
    cleanups.push(() => throttle.close());
    const client = connect(throttle.port, "127.0.0.1");
    client.pause();
    cleanups.push(() => client.destroy());
    await sleep(500);
    const before = produced;
    await sleep(200);
    expect(produced).toBe(before);
    // 64 KiB queue + one incoming socket chunk, in each direction.
    expect(throttle.peakBufferedBytes()).toBeLessThanOrEqual(256 * 1024);
    expect(throttle.bufferedBytes()).toBeGreaterThan(0);
    client.resume();
    await sleep(150);
    expect(produced).toBeGreaterThan(before);
  });
});
