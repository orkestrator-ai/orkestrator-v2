import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  encodePreviewTunnelFrame,
  parsePreviewTunnelClientFrame,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  PREVIEW_TUNNEL_CLOSE,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import { PREVIEW_TUNNEL_MUX } from "@orkestrator/protocol/preview-tunnel-mux";
import {
  PREVIEW_LIMITS,
  previewError,
  previewErrorFromUnknown,
} from "@orkestrator/protocol/preview-services";
import {
  acceptPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import {
  createPreviewHarness,
  type PreviewHarness,
} from "../../backend/src/core/preview-test-support";
import { PreviewTunnelServer } from "../../backend/src/preview-tunnel-server";
import { PreviewTunnelStream } from "../electron/preview-tunnel-client";
import {
  PreviewTunnelConnector,
  PreviewTunnelMuxStream,
  PreviewTunnelSession,
  PREVIEW_TUNNEL_SESSION_MISSED_PINGS,
} from "../electron/preview-tunnel-session";
import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server";

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

function readAll(stream: Duplex): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

describe("PreviewTunnelConnector (tunnel v2)", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  let gateway: Server;
  let tunnel: PreviewTunnelServer;
  let url: string;
  let serviceId: string;
  let upgrades: number;
  let connector: PreviewTunnelConnector;

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "session-app" });
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
    });
    upgrades = 0;
    gateway = createServer((_request, response) => response.end());
    gateway.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      if (!tunnel.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}${PREVIEW_TUNNEL_PATH}`;
    connector = new PreviewTunnelConnector({ sessionIdleMs: 50 });
  });

  afterEach(async () => {
    connector.close();
    tunnel.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await fixture.close();
    await harness.cleanup();
  });

  async function attachment(): Promise<PreviewAttachmentDescriptor> {
    return harness.runtime.access.createAttachment({ serviceId, surface: "desktop-tunnel" });
  }

  function open(att: PreviewAttachmentDescriptor) {
    return connector.open(
      { url, attachmentId: att.attachmentId, credential: att.tunnel!.credential },
      att.tunnel!.multiplexSubprotocol !== undefined,
    );
  }

  test("parallel opens share one handshake and HELLO, and the session closes once idle", async () => {
    const att = await attachment();
    const streams = await Promise.all([open(att), open(att), open(att)]);
    expect(upgrades).toBe(1);
    for (const stream of streams) expect(stream).toBeInstanceOf(PreviewTunnelMuxStream);
    expect(connector.stats()).toEqual({ sessions: 1, streams: 3 });
    const responses = streams.map((stream) => {
      const body = readAll(stream);
      stream.end("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
      return body;
    });
    for (const response of await Promise.all(responses)) {
      expect(response.toString()).toStartWith("HTTP/1.1 200");
      expect(response.toString()).toContain('"marker":"session-app"');
    }
    await until(() => connector.stats().sessions === 0);
    await until(() => tunnel.stats().sockets === 0);
    expect(tunnel.stats().admission).toMatchObject({ admitted: 3, active: 0 });
  });

  test("a stopped reader stalls only its own stream, and resumes with credit", async () => {
    const att = await attachment();
    const stalled = await open(att);
    stalled.write("GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n");
    await until(() => stalled.readableLength > 0);
    // Nothing is reading: the backend stops at one window for this stream.
    await Bun.sleep(150);
    expect(stalled.readableLength).toBeLessThanOrEqual(PREVIEW_TUNNEL_MUX.windowBytes);

    const other = await open(att);
    expect(upgrades).toBe(1);
    const body = readAll(other);
    other.end("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
    expect((await body).toString()).toStartWith("HTTP/1.1 200");

    let read = 0;
    stalled.on("data", (chunk: Buffer) => (read += chunk.length));
    await until(() => read >= 4 * PREVIEW_TUNNEL_MUX.windowBytes);
    stalled.destroy();
    await until(() => tunnel.stats().admission.active === 0);
  });

  test("concurrent joiners all reject a failed connection and a later attempt recovers", async () => {
    const att = await attachment();
    const bad = { url, attachmentId: att.attachmentId, credential: "invalid" };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => connector.open(bad, true)),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(upgrades).toBe(1);
    await until(() => connector.stats().sessions === 0);
    const recovered = await open(att);
    expect(upgrades).toBe(2);
    recovered.destroy();
  });

  test("an upload larger than the window reaches the upstream intact", async () => {
    const att = await attachment();
    const stream = await open(att);
    const payload = Buffer.alloc(PREVIEW_TUNNEL_MUX.windowBytes * 3 + 17);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 239;
    const response = readAll(stream);
    stream.write(
      `POST /echo HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncontent-length: ${payload.length}\r\n\r\n`,
    );
    stream.end(payload);
    const text = (await response).toString();
    expect(text).toStartWith("HTTP/1.1 200");
    expect(text).toContain(`"bytes":${payload.length}`);
    expect(text).toContain(createHash("sha256").update(payload).digest("hex"));
  });

  test("revocation fails the session's streams and the next open is refused", async () => {
    const att = await attachment();
    const stream = await open(att);
    const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
    harness.runtime.access.revokeServices([serviceId], "operator-revoked");
    expect(previewErrorFromUnknown(await failed)?.category).toBe("access-expired");
    await until(() => connector.stats().sessions === 0);
    const refused = await open(att).catch((error: unknown) => error);
    expect(previewErrorFromUnknown(refused)?.category).toBe("access-expired");
  });

  test("a cancelled open releases its upstream", async () => {
    const att = await attachment();
    await (await open(att)).destroy();
    const controller = new AbortController();
    const pending = connector.open(
      {
        url,
        attachmentId: att.attachmentId,
        credential: att.tunnel!.credential,
        signal: controller.signal,
      },
      true,
    );
    controller.abort();
    const error = await pending.catch((failure: unknown) => failure);
    expect(previewErrorFromUnknown(error)?.category).toBe("access-expired");
    await until(() => tunnel.stats().admission.active === 0);
  });
});

describe("PreviewTunnelConnector against a v1-only backend", () => {
  test("an attachment without v2, or a server answering v1, gets one v1 socket per connection", async () => {
    let upgrades = 0;
    const backends: PreviewWebSocket[] = [];
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      const backend = acceptPreviewWebSocket(request, socket, head, {
        protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
        maxPayload: PREVIEW_LIMITS.tunnelFrameMaxBytes,
      });
      if (!backend) return;
      backends.push(backend);
      backend.on("message", (data, binary) => {
        if (binary) return;
        const frame = parsePreviewTunnelClientFrame(data.toString());
        if (frame?.type === "open") backend.send(encodePreviewTunnelFrame({ type: "open-ok" }));
      });
      backend.start();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connector = new PreviewTunnelConnector();
    const options = {
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      attachmentId: "att_test",
      credential: "test-credential",
    };
    try {
      // The attachment advertised v2, but this server only speaks v1.
      const first = await connector.open(options, true);
      expect(first).toBeInstanceOf(PreviewTunnelStream);
      const [second, third] = await Promise.all([
        connector.open(options, true),
        connector.open(options, false),
      ]);
      expect(second).toBeInstanceOf(PreviewTunnelStream);
      expect(third).toBeInstanceOf(PreviewTunnelStream);
      expect(upgrades).toBe(3);
      expect(connector.stats()).toEqual({ sessions: 0, streams: 0 });
      for (const stream of [first, second, third]) stream.destroy();
    } finally {
      connector.close();
      for (const backend of backends) backend.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** An authenticated session over a scripted WebSocket. */
async function fakeSession() {
  const ws = new EventEmitter() as EventEmitter & {
    isOpen: boolean;
    send: () => boolean;
    start: () => void;
    ping: () => void;
    close: (code: number) => void;
  };
  ws.isOpen = true;
  ws.send = () => true;
  ws.start = () => {};
  ws.ping = () => {};
  const closed: number[] = [];
  ws.close = (code) => {
    closed.push(code);
    ws.isOpen = false;
    ws.emit("close", code);
  };
  const session = new PreviewTunnelSession(ws as unknown as PreviewWebSocket, {
    attachmentId: "att_test",
    credential: "credential",
    idleMs: 30_000,
    onClosed: () => {},
  });
  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "ready",
        serviceId: "service",
        endpointGeneration: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    ),
    false,
  );
  await session.ready;
  return { ws, session, closed };
}

test("a session error frame fails its streams before the close frame arrives", async () => {
  const { ws, session, closed } = await fakeSession();
  const opening = session.openStream(undefined, performance.now());
  ws.emit("message", Buffer.from(JSON.stringify({ type: "open-ok", stream: 1 })), false);
  const stream = await opening;
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  ws.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "error", error: previewError("access-expired") })),
    false,
  );
  // A caller checking this stream in the gap must not find it reusable.
  expect(closed).toEqual([]);
  expect(stream.destroyed).toBe(true);
  expect(session.size).toBe(0);
  expect(session.canOpen).toBe(false);
  expect(previewErrorFromUnknown(await failed)?.category).toBe("access-expired");
  ws.close(PREVIEW_TUNNEL_CLOSE.revoked);
  expect(closed).toEqual([PREVIEW_TUNNEL_CLOSE.revoked]);
});

test.each(["generation-changed", "access-expired"] as const)(
  "OPEN_FAILED %s retires a session while existing streams drain",
  async (category) => {
    const { ws, session, closed } = await fakeSession();
    const active = session.openStream(undefined, performance.now());
    ws.emit("message", Buffer.from(JSON.stringify({ type: "open-ok", stream: 1 })), false);
    const stream = await active;
    const pending = Array.from({ length: 31 }, () =>
      session.openStream(undefined, performance.now()),
    );
    expect(session.size).toBe(32);
    await expect(session.openStream(undefined, performance.now())).rejects.toThrow();
    for (let i = 0; i < 31; i++)
      ws.emit("message", Buffer.from(JSON.stringify({ type: "open-ok", stream: i + 2 })), false);
    const extra = await Promise.all(pending);
    for (const item of extra) item.destroy();
    expect(session.size).toBe(1);
    const refused = session.openStream(undefined, performance.now());
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "open-failed", stream: 33, error: previewError(category) }),
      ),
      false,
    );
    await expect(refused).rejects.toThrow();
    expect(session.canOpen).toBe(false);
    expect(closed).toEqual([]);
    stream.destroy();
    expect(closed).toEqual([PREVIEW_TUNNEL_CLOSE.normal]);
  },
);

test("a session-level error fails open streams before the socket finishes closing", async () => {
  const ws = new EventEmitter() as EventEmitter & {
    isOpen: boolean;
    send: () => boolean;
    start: () => void;
    ping: () => void;
    close: (code: number) => void;
  };
  ws.isOpen = true;
  ws.send = () => true;
  ws.start = () => {};
  ws.ping = () => {};
  ws.close = () => {};
  const session = new PreviewTunnelSession(ws as unknown as PreviewWebSocket, {
    attachmentId: "att_test",
    credential: "credential",
    idleMs: 30_000,
    onClosed: () => {},
  });
  const receive = (frame: unknown) => ws.emit("message", Buffer.from(JSON.stringify(frame)), false);
  receive({
    type: "ready",
    serviceId: "service",
    endpointGeneration: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await session.ready;
  const opening = session.openStream(undefined, performance.now());
  receive({ type: "open-ok", stream: 1 });
  const stream = await opening;
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));

  // No `close` event yet: the socket is still finishing when this frame arrives.
  receive({ type: "error", error: previewError("access-expired") });

  expect(stream.destroyed).toBe(true);
  expect(previewErrorFromUnknown(await failed)?.category).toBe("access-expired");
  expect(session.canOpen).toBe(false);
  expect(session.size).toBe(0);
});

/** A session over a scripted WebSocket that pings every 20 ms and records the outcome. */
async function heartbeatSession(answer: "pong" | "nothing") {
  const ws = new EventEmitter() as EventEmitter & {
    isOpen: boolean;
    send: () => boolean;
    start: () => void;
    ping: () => void;
    close: (code: number) => void;
    terminate: () => void;
  };
  const events: string[] = [];
  ws.isOpen = true;
  ws.send = () => true;
  ws.start = () => {};
  ws.ping = () => {
    events.push("ping");
    if (answer === "pong") queueMicrotask(() => ws.emit("pong"));
  };
  let closeCode = 0;
  // A dead peer never answers the close frame: only `terminate` ends the socket.
  ws.close = (code) => {
    events.push(`close ${code}`);
    closeCode = code;
  };
  ws.terminate = () => {
    events.push("terminate");
    ws.isOpen = false;
    ws.emit("close", closeCode);
  };
  const closedSessions: PreviewTunnelSession[] = [];
  const session = new PreviewTunnelSession(ws as unknown as PreviewWebSocket, {
    attachmentId: "att_test",
    credential: "credential",
    idleMs: 30_000,
    pingIntervalMs: 20,
    onClosed: (closed) => closedSessions.push(closed),
  });
  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "ready",
        serviceId: "service",
        endpointGeneration: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ),
    false,
  );
  await session.ready;
  return { ws, session, events, closedSessions };
}

test("a session whose pings go unanswered is destroyed, failing its streams", async () => {
  const { ws, session, events, closedSessions } = await heartbeatSession("nothing");
  const opening = session.openStream(undefined, performance.now());
  ws.emit("message", Buffer.from(JSON.stringify({ type: "open-ok", stream: 1 })), false);
  const stream = await opening;
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  await until(() => closedSessions.length === 1, 1_000);
  // One ping, then two that nothing answered; the third tick ends it.
  expect(events.filter((event) => event === "ping").length).toBe(
    PREVIEW_TUNNEL_SESSION_MISSED_PINGS,
  );
  expect(events.slice(-2)).toEqual([`close ${PREVIEW_TUNNEL_CLOSE.timeout}`, "terminate"]);
  expect(previewErrorFromUnknown(await failed)?.category).toBe("backend-unavailable");
  expect(session.canOpen).toBe(false);
  expect(closedSessions[0]).toBe(session);
});

test("a session that answers its pings stays open", async () => {
  const { session, events, closedSessions } = await heartbeatSession("pong");
  await until(() => events.filter((event) => event === "ping").length >= 6, 1_000);
  expect(closedSessions).toEqual([]);
  expect(events.some((event) => event.startsWith("close") || event === "terminate")).toBe(false);
  expect(session.canOpen).toBe(true);
  session.close();
});

test("Node pull-mode reads replenish a fully buffered receive window", async () => {
  // Bun's stream implementation does not reproduce Node/Electron's _read timing.
  const build = await Bun.build({
    entrypoints: [new URL("../electron/preview-tunnel-session.ts", import.meta.url).pathname],
    target: "node",
  });
  expect(build.success).toBe(true);
  const script = await build.outputs[0]!.text();
  const child = Bun.spawn(["node", "--input-type=module"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(
    script +
      `
{
  const assert = (await import("node:assert/strict")).default;
  const credits = [];
  const session = { sendFrame: frame => credits.push(frame), cancel() {}, violation() { throw new Error("credit overflow"); } };
  const stream = new PreviewTunnelMuxStream(session, 1, 0);
  const windowBytes = 256 * 1024;
  // How much one read() returns varies by Node version (one chunk on Node 26).
  const drain = () => {
    let bytes = 0;
    for (let chunk = stream.read(); chunk !== null; chunk = stream.read()) bytes += chunk.length;
    return bytes;
  };
  for (let i = 0; i < 4; i++) stream.receive(Buffer.alloc(windowBytes / 4));
  assert.equal(stream.readableLength, windowBytes);
  assert.equal(credits.length, 0);
  assert.equal(drain(), windowBytes);
  assert.equal(credits.reduce((n, frame) => n + frame.bytes, 0), windowBytes);
  stream.receive(Buffer.alloc(windowBytes / 4));
  assert.equal(drain(), windowBytes / 4);
  assert.equal(credits.reduce((n, frame) => n + frame.bytes, 0), windowBytes * 1.25);
  stream.destroy();
}
`,
  );
  child.stdin.end();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
});
