import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, IncomingMessage, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";

import {
  encodePreviewTunnelFrame,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import {
  connectPreviewWebSocket,
  PreviewWebSocketHandshakeError,
  PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PreviewTunnelServer } from "./preview-tunnel-server.js";
import { PREVIEW_RELAY_SCRIPT } from "./preview-relay-script.js";
import { PreviewRelaySupervisor } from "./preview-relay-supervisor.js";

interface TunnelClient {
  ws: PreviewWebSocket;
  control: Array<Record<string, unknown>>;
  data: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  nextControl(type?: string): Promise<Record<string, unknown>>;
}

async function waitForTunnelCleanup(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for tunnel cleanup");
    await Bun.sleep(5);
  }
}

describe("PreviewTunnelServer", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let server: Server;
  let tunnel: PreviewTunnelServer;
  let port: number;
  let serviceId: string;
  const clients: PreviewWebSocket[] = [];
  const logs: unknown[][] = [];

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "tunnel-app" });
    harness = await createPreviewHarness({ env: { ORKESTRATOR_PREVIEW_TRANSPORT: "1" } });
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "app",
      targetKind: "backend-host",
      applicationPort: fixture.port,
      addressFamily: "ipv4",
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    serviceId = created.definition.serviceId;
    tunnel = new PreviewTunnelServer({
      runtime: harness.runtime,
      metrics: harness.runtime.metrics,
      logger: {
        debug: (...args: unknown[]) => void logs.push(args),
        warn: (...args: unknown[]) => void logs.push(args),
      },
      helloTimeoutMs: 200,
    });
    server = createServer((_request, response) => response.end("not a tunnel"));
    server.on("upgrade", (request, socket, head) => {
      if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    logs.length = 0;
    for (const client of clients.splice(0)) client.terminate();
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
    await harness.cleanup();
  });

  async function open(
    options: { protocol?: string; headers?: Array<[string, string]>; path?: string } = {},
  ): Promise<TunnelClient> {
    const ws = await connectPreviewWebSocket({
      url: `ws://127.0.0.1:${port}${options.path ?? PREVIEW_TUNNEL_PATH}`,
      protocol: options.protocol ?? PREVIEW_TUNNEL_SUBPROTOCOL,
      maxPayload: 1024 * 1024,
      connectTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
      headers: options.headers,
    });
    clients.push(ws);
    const control: Array<Record<string, unknown>> = [];
    const data: Buffer[] = [];
    const waiters: Array<{ type?: string; resolve: (frame: Record<string, unknown>) => void }> = [];
    ws.on("message", (payload, isBinary) => {
      if (isBinary) {
        data.push(payload);
        return;
      }
      const frame = JSON.parse(String(payload)) as Record<string, unknown>;
      const index = waiters.findIndex((waiter) => !waiter.type || waiter.type === frame.type);
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
      else control.push(frame);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason })),
    );
    ws.start();
    return {
      ws,
      control,
      data,
      closed,
      nextControl: (type) =>
        new Promise((resolve) => {
          const existing = control.find((frame) => !type || frame.type === type);
          if (existing) {
            control.splice(control.indexOf(existing), 1);
            resolve(existing);
          } else waiters.push({ type, resolve });
        }),
    };
  }

  async function rejectedStatus(options: Parameters<typeof open>[0]): Promise<number | null> {
    try {
      await open(options);
      return null;
    } catch (error) {
      return error instanceof PreviewWebSocketHandshakeError ? error.status : -1;
    }
  }

  async function attachment(): Promise<PreviewAttachmentDescriptor> {
    return harness.runtime.access.createAttachment({ serviceId, surface: "desktop-tunnel" });
  }

  async function ready(client: TunnelClient, descriptor?: PreviewAttachmentDescriptor) {
    const att = descriptor ?? (await attachment());
    client.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: att.tunnel!.credential,
      }),
    );
    expect(await client.nextControl("ready")).toMatchObject({
      serviceId,
      endpointGeneration: att.endpointGeneration,
    });
    return att;
  }

  async function exchange(client: TunnelClient, request: string): Promise<string> {
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(Buffer.from(request));
    await client.closed;
    return Buffer.concat(client.data).toString();
  }

  test("carries an HTTP exchange to exactly the authorized service", async () => {
    const client = await open();
    await ready(client);
    const response = await exchange(
      client,
      "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    );
    expect(response).toStartWith("HTTP/1.1 200");
    expect(response).toContain('"marker":"tunnel-app"');
    await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats()).toMatchObject({ sockets: 0, aggregateQueuedBytes: 0 });
  });

  test("OPEN frames naming a destination are protocol violations", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(JSON.stringify({ type: "open", host: "127.0.0.1", port: 22 }));
    expect((await client.closed).code).toBe(4400);
  });

  test("application bytes before OPEN_OK are refused", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    expect((await client.closed).code).toBe(4400);
  });

  test("wrong credentials, missing hello, and browser origins are rejected", async () => {
    const att = await attachment();
    const wrong = await open();
    wrong.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: "z".repeat(43),
      }),
    );
    expect((await wrong.closed).code).toBe(4401);

    const silent = await open();
    expect((await silent.closed).code).toBe(4408);

    expect(await rejectedStatus({ headers: [["origin", "https://evil.test"]] })).toBe(403);
    expect(await rejectedStatus({ protocol: "something-else" })).toBe(426);
  });

  test("oversized frames close the tunnel", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(Buffer.alloc(harness.runtime.limits.tunnelFrameMaxBytes + 1));
    expect((await client.closed).code).toBe(1009);
  });

  test("revocation and generation change close open tunnels; no replay on reconnect", async () => {
    const client = await open();
    const att = await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(Buffer.from("GET /sse HTTP/1.1\r\nhost: localhost\r\n\r\n"));
    while (!fixture.requests.some((request) => request.path === "/sse")) await Bun.sleep(5);
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    expect((await client.closed).code).toBe(4410);

    const again = await open();
    again.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: att.tunnel!.credential,
      }),
    );
    expect((await again.closed).code).toBe(4410);
    expect(fixture.requests.filter((request) => request.path === "/sse")).toHaveLength(1);
  });

  test("half-close delivers the request and the full response", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    client.ws.send(
      Buffer.from(
        "POST /echo HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello",
      ),
    );
    client.ws.send(encodePreviewTunnelFrame({ type: "eof" }));
    await client.closed;
    const response = Buffer.concat(client.data).toString();
    expect(response).toContain('"bytes":5');
  });

  test("a stopped reader cannot grow the queue without bound", async () => {
    const client = await open();
    await ready(client);
    client.ws.send(encodePreviewTunnelFrame({ type: "open" }));
    await client.nextControl("open-ok");
    // Stop reading at the TCP level: the server must pause the upstream before
    // one large upstream read queues past the bound, and keep the tunnel open.
    client.ws.pause();
    client.ws.send(Buffer.from("GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n"));
    await Bun.sleep(300);
    const queued = tunnel.stats().aggregateQueuedBytes;
    expect(queued).toBeLessThan(
      harness.runtime.limits.tunnelQueueMaxBytesPerDirection +
        harness.runtime.limits.tunnelFrameMaxBytes +
        14,
    );
    expect(tunnel.stats().sockets).toBe(1);
    client.ws.terminate();
    await client.closed;
    await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats()).toMatchObject({ sockets: 0, aggregateQueuedBytes: 0 });
  });

  async function controlledTunnel(
    upstream: Duplex = new PassThrough(),
    options: { pingIntervalMs?: number; highWaterMark?: number } = {},
  ) {
    const target = await harness.runtime.registry.acquireTarget(
      serviceId,
      (await attachment()).endpointGeneration,
    );
    const acquire = spyOn(harness.runtime.registry, "acquireTarget").mockResolvedValue({
      ...target,
      relay: { environmentId: "local", containerId: "controlled", port: fixture.port },
    });
    tunnel.close();
    tunnel = new PreviewTunnelServer({
      runtime: harness.runtime,
      metrics: harness.runtime.metrics,
      logger: console,
      upstream: { relayConnect: async () => upstream },
      pingIntervalMs: options.pingIntervalMs,
    });
    let blocked = false;
    let pending: (() => void) | undefined;
    let handshake = true;
    const downstream = new Duplex({
      writableHighWaterMark: options.highWaterMark,
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        if (handshake) {
          handshake = false;
          callback();
          return;
        }
        const flush = () => {
          peer.push(chunk);
          callback();
        };
        if (blocked) pending = flush;
        else flush();
      },
      // Ending a side reaches the other end only after its queued writes.
      final(callback) {
        peer.push(null);
        callback();
      },
    });
    const peer = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        downstream.push(chunk);
        callback();
      },
      final(callback) {
        downstream.push(null);
        callback();
      },
    });
    const ws = new PreviewWebSocket(peer, { role: "client", maxPayload: 1024 * 1024 });
    const data: Buffer[] = [];
    const controls: Array<Record<string, unknown>> = [];
    ws.on("message", (payload, binary) => {
      if (binary) data.push(payload);
      else controls.push(JSON.parse(payload.toString()));
    });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.start();
    const request = new IncomingMessage(downstream as Socket);
    request.method = "GET";
    request.url = PREVIEW_TUNNEL_PATH;
    request.headers = {
      upgrade: "websocket",
      "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": PREVIEW_TUNNEL_SUBPROTOCOL,
    };
    try {
      expect(tunnel.handleUpgrade(request, downstream, Buffer.alloc(0))).toBe(true);
      const descriptor = await attachment();
      ws.send(
        encodePreviewTunnelFrame({
          type: "hello",
          version: 1,
          attachmentId: descriptor.attachmentId,
          credential: descriptor.tunnel!.credential,
        }),
      );
      await waitForTunnelCleanup(() => controls.some((frame) => frame.type === "ready"));
      ws.send(encodePreviewTunnelFrame({ type: "open" }));
      await waitForTunnelCleanup(() => controls.some((frame) => frame.type === "open-ok"));
    } catch (error) {
      dispose();
      throw error;
    }
    function dispose() {
      ws.terminate();
      downstream.destroy();
      upstream.destroy();
      acquire.mockRestore();
    }
    return {
      ws,
      upstream,
      downstream,
      data,
      controls,
      closed,
      dispose,
      pauseReader() {
        blocked = true;
      },
      resumeReader() {
        blocked = false;
        const flush = pending;
        pending = undefined;
        flush?.();
      },
    };
  }

  test("an unanswered heartbeat cannot terminate a queued response during close drain", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    const controlled = await controlledTunnel(undefined, { pingIntervalMs: 1000 });
    const heartbeat = intervals.mock.calls.find(([, ms]) => ms === 1000)![0] as () => void;
    intervals.mockRestore();
    try {
      controlled.pauseReader();
      heartbeat(); // The ping is queued and cannot be answered by the peer yet.
      const body = Buffer.alloc(1024, 0x73);
      controlled.upstream.push(body);
      controlled.upstream.end();
      await waitForTunnelCleanup(() => controlled.upstream.destroyed);
      expect(controlled.downstream.writableLength).toBeGreaterThan(body.length);
      heartbeat(); // Next liveness interval, before the 30-second close drain bound.
      expect(controlled.downstream.destroyed).toBe(false);
      controlled.resumeReader();
      expect(await controlled.closed).toBe(1000);
      expect(Buffer.concat(controlled.data)).toEqual(body);
      expect(controlled.controls.map((frame) => frame.type)).toEqual(["ready", "open-ok", "eof"]);
      await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
    } finally {
      controlled.dispose();
    }
  });

  test("a stopped reader that still pings outlives the liveness interval; a silent one does not", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    const controlled = await controlledTunnel(undefined, { pingIntervalMs: 1000 });
    const heartbeat = intervals.mock.calls.find(([, ms]) => ms === 1000)![0] as () => void;
    intervals.mockRestore();
    try {
      controlled.pauseReader();
      controlled.upstream.push(Buffer.alloc(1024, 0x73));
      await waitForTunnelCleanup(() => controlled.downstream.writableLength > 1024);
      // Several liveness intervals: the server's pings wait behind the unread
      // data, but the client's own pings arrive.
      for (let round = 0; round < 3; round += 1) {
        heartbeat();
        controlled.ws.ping();
        await Bun.sleep(5);
      }
      heartbeat();
      expect(controlled.downstream.destroyed).toBe(false);
      expect(tunnel.stats().sockets).toBe(1);
      // No frame since the last interval: the client is presumed gone.
      heartbeat();
      await waitForTunnelCleanup(() => controlled.downstream.destroyed);
      await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
    } finally {
      controlled.dispose();
    }
  });

  test.each(["tcp", "relay"] as const)(
    "%s upstream preserves unshifted bytes and EOF across a stopped tunnel reader",
    async (kind) => {
      // Force reads from both production upstream types to cross the queue
      // ceiling, regardless of the platform's TCP read chunk size.
      harness.runtime = harness.newRuntime({
        limits: {
          ...harness.runtime.limits,
          tunnelFrameMaxBytes: 1024,
          tunnelQueueMaxBytesPerDirection: 16 * 1024,
        },
      });
      await harness.runtime.init();
      const peers = new Set<Socket>();
      let source!: Socket;
      const sourceServer = createTcpServer({ allowHalfOpen: true }, (socket) => {
        source = socket;
        socket.resume();
        peers.add(socket);
        socket.on("error", () => undefined);
        socket.on("close", () => peers.delete(socket));
      });
      await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
      const sourcePort = (sourceServer.address() as AddressInfo).port;
      const exits: Promise<void>[] = [];
      const relay = new PreviewRelaySupervisor({
        allowedPorts: () => [sourcePort],
        window: 64 * 1024,
        spawn: () => {
          const child = spawn(process.execPath, ["-e", PREVIEW_RELAY_SCRIPT], {
            stdio: ["pipe", "pipe", "ignore"],
          });
          exits.push(new Promise<void>((resolve) => child.once("exit", () => resolve())));
          return child;
        },
      });
      let controlled: Awaited<ReturnType<typeof controlledTunnel>> | undefined;
      try {
        const upstream =
          kind === "relay"
            ? await relay.connect(
                { environmentId: "local", containerId: "local-relay", port: sourcePort },
                new AbortController().signal,
              )
            : await new Promise<Socket>((resolve, reject) => {
                const socket = connect(sourcePort, "127.0.0.1", () => resolve(socket));
                socket.once("error", reject);
              });
        controlled = await controlledTunnel(upstream, { highWaterMark: 1024 });
        const unshift = spyOn(upstream, "unshift");
        const read = spyOn(upstream, "_read");
        try {
          const body = Buffer.alloc(512 * 1024);
          for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
          controlled.pauseReader();
          controlled.ws.send(encodePreviewTunnelFrame({ type: "eof" }));
          source.write(body);
          await waitForTunnelCleanup(
            () => upstream.isPaused() && upstream.readableLength >= upstream.readableHighWaterMark,
          );
          expect(unshift).toHaveBeenCalled();
          expect(upstream.destroyed).toBe(false);
          expect(controlled.downstream.writableLength).toBeLessThan(
            harness.runtime.limits.tunnelQueueMaxBytesPerDirection +
              harness.runtime.limits.tunnelFrameMaxBytes +
              14,
          );
          read.mockClear();
          controlled.resumeReader();
          await waitForTunnelCleanup(() => Buffer.concat(controlled!.data).length === body.length);
          // Keep EOF out of the readable queue until the consumer asks for
          // more. Otherwise a relay read containing the whole body and EOF
          // legitimately needs no further _read (and no returned credit).
          expect(read).toHaveBeenCalled();
          source.end();
          expect(await controlled.closed).toBe(1000);
          expect(Buffer.concat(controlled.data)).toEqual(body);
          expect(controlled.controls.map((frame) => frame.type)).toEqual([
            "ready",
            "open-ok",
            "eof",
          ]);
          await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
          expect(tunnel.stats().aggregateQueuedBytes).toBe(0);
        } finally {
          unshift.mockRestore();
          read.mockRestore();
        }
      } finally {
        controlled?.dispose();
        relay.dispose();
        for (const socket of Array.from(peers)) socket.destroy();
        await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
        await Promise.all(exits);
      }
    },
  );

  test("one large upstream read to a slow reader pauses at the queue bound instead of closing", async () => {
    const controlled = await controlledTunnel();
    try {
      const limits = harness.runtime.limits;
      const body = Buffer.alloc(limits.tunnelQueueMaxBytesPerDirection * 4);
      for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
      controlled.pauseReader();
      // One data event far larger than the queue, as Bun's 512 KiB reads are.
      controlled.upstream.push(body);
      await waitForTunnelCleanup(() => controlled.upstream.isPaused());
      expect(controlled.upstream.destroyed).toBe(false);
      expect(controlled.downstream.writableLength).toBeGreaterThanOrEqual(
        limits.tunnelQueueMaxBytesPerDirection,
      );
      expect(controlled.downstream.writableLength).toBeLessThan(
        limits.tunnelQueueMaxBytesPerDirection + limits.tunnelFrameMaxBytes + 14,
      );
      // The unsent rest of the read waits in the upstream, not in the tunnel queue.
      expect(controlled.upstream.readableLength).toBeGreaterThan(0);
      expect(tunnel.stats().aggregateQueuedBytes).toBe(controlled.downstream.writableLength);
      controlled.resumeReader();
      await waitForTunnelCleanup(() => Buffer.concat(controlled.data).length === body.length);
      expect(Buffer.concat(controlled.data).equals(body)).toBe(true);
      expect(controlled.data.every((frame) => frame.length <= limits.tunnelFrameMaxBytes)).toBe(
        true,
      );
      expect(controlled.controls.some((frame) => frame.type === "error")).toBe(false);
      expect(controlled.upstream.destroyed).toBe(false);
      expect(tunnel.stats()).toMatchObject({ sockets: 1, aggregateQueuedBytes: 0 });
    } finally {
      controlled.dispose();
    }
    await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().aggregateQueuedBytes).toBe(0);
  });

  test("a slow reader receives a large response, EOF and a normal close when the upstream ends", async () => {
    const controlled = await controlledTunnel();
    try {
      const body = Buffer.alloc(harness.runtime.limits.tunnelQueueMaxBytesPerDirection * 3, 0x62);
      controlled.pauseReader();
      controlled.upstream.push(body);
      controlled.upstream.end();
      await waitForTunnelCleanup(() => controlled.upstream.isPaused());
      expect(controlled.controls.some((frame) => frame.type === "eof")).toBe(false);
      controlled.resumeReader();
      expect(await controlled.closed).toBe(1000);
      expect(Buffer.concat(controlled.data).equals(body)).toBe(true);
      expect(controlled.controls.map((frame) => frame.type)).toEqual(["ready", "open-ok", "eof"]);
    } finally {
      controlled.dispose();
    }
    await waitForTunnelCleanup(() => tunnel.stats().sockets === 0);
  });

  test("a slow reader pauses the upstream and resumes without losing bytes after drain", async () => {
    const controlled = await controlledTunnel();
    const resume = spyOn(controlled.upstream, "resume");
    try {
      const first = Buffer.alloc(harness.runtime.limits.tunnelQueueMaxBytesPerDirection, 0x61);
      const second = Buffer.from("after-drain");
      controlled.pauseReader();
      controlled.upstream.push(first);
      await waitForTunnelCleanup(() => controlled.upstream.isPaused());
      expect(controlled.upstream.destroyed).toBe(false);
      expect(controlled.downstream.writableLength).toBeGreaterThanOrEqual(first.length);
      controlled.upstream.push(second);
      expect(controlled.data).toHaveLength(0);
      resume.mockClear();
      controlled.resumeReader();
      await waitForTunnelCleanup(
        () => Buffer.concat(controlled.data).length === first.length + second.length,
      );
      expect(resume).toHaveBeenCalled();
      expect(Buffer.concat(controlled.data)).toEqual(Buffer.concat([first, second]));
      expect(controlled.upstream.destroyed).toBe(false);
      expect(controlled.controls.some((frame) => frame.type === "error")).toBe(false);
      expect(tunnel.stats().aggregateQueuedBytes).toBe(0);
    } finally {
      resume.mockRestore();
      controlled.dispose();
    }
  });

  test("admission bounds tunnels per service and releases on close", async () => {
    const limit = harness.runtime.limits.tunnelsPerService;
    const descriptor = await attachment();
    const opened: TunnelClient[] = [];
    for (let index = 0; index < limit; index += 1) {
      const client = await open();
      await ready(client, descriptor);
      opened.push(client);
    }
    const extra = await open();
    extra.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: descriptor.attachmentId,
        credential: descriptor.tunnel!.credential,
      }),
    );
    expect((await extra.closed).code).toBe(4429);
    for (const client of opened) client.ws.close();
    await Promise.all(opened.map((client) => client.closed));
    await waitForTunnelCleanup(() => tunnel.stats().admission.active === 0);
    expect(tunnel.stats().admission.active).toBe(0);
  });

  test("logs, diagnostics, and events never carry credentials, app headers, paths, or queries", async () => {
    const good = await open();
    const att = await ready(good);
    const response = await exchange(
      good,
      "GET /app/private-route?token=QUERY_SECRET_1 HTTP/1.1\r\nhost: localhost\r\n" +
        "authorization: Bearer APP_SECRET_2\r\ncookie: sid=COOKIE_SECRET_3\r\nconnection: close\r\n\r\n",
    );
    expect(response).toStartWith("HTTP/1.1 200");
    const bad = await open();
    bad.ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: att.attachmentId,
        credential: "WRONG_CREDENTIAL_4".padEnd(43, "x"),
      }),
    );
    await bad.closed;
    await harness.runtime.registry.settle();
    harness.runtime.registry.flushEvent();

    const recorded = JSON.stringify({
      logs,
      diagnostics: harness.runtime.diagnostics(),
      events: harness.events,
      stats: tunnel.stats(),
    });
    for (const secret of [
      att.tunnel!.credential,
      "QUERY_SECRET_1",
      "APP_SECRET_2",
      "COOKIE_SECRET_3",
      "WRONG_CREDENTIAL_4",
      "private-route",
    ]) {
      expect(recorded).not.toContain(secret);
    }
    // The failure is still observable as a bounded category count.
    const counters = Object.keys(harness.runtime.metrics.snapshot().counters);
    expect(counters.some((name) => name.startsWith("tunnel.rejected"))).toBe(true);
  });

  test("unknown paths are not claimed", async () => {
    expect(await rejectedStatus({ path: "/__orkestrator/terminal" })).toBe(-1);
  });
});
