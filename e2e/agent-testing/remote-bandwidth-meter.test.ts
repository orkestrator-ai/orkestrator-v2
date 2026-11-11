import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import {
  MAX_QUEUED_BYTES,
  MAX_REQUEST_HEAD_BYTES,
  RequestStream,
  ShapedPipe,
  bytesPerMs,
  categorize,
  commandOf,
  linkDelta,
  numericDelta,
  percentile,
  startCountingLink,
  type CountingLink,
  type LinkCategory,
  type Segment,
} from "./remote-bandwidth-meter";

// The test preload replaces the global with happy-dom's, which applies a page's
// same-origin policy to these loopback requests.
const fetch = Bun.fetch;

let link: CountingLink | undefined;
let gateway: http.Server | net.Server | undefined;
const clientSockets = new Set<net.Socket>();
afterEach(async () => {
  for (const socket of Array.from(clientSockets)) socket.destroy();
  clientSockets.clear();
  await link?.close();
  link = undefined;
  if (gateway && "closeAllConnections" in gateway) gateway.closeAllConnections();
  await new Promise<void>((resolve) => (gateway ? gateway.close(() => resolve()) : resolve()));
  gateway = undefined;
});

/** A raw TCP client of the link, so a test chooses exactly how its bytes are split. */
async function rawClient(url: string): Promise<{
  socket: net.Socket;
  received: () => Buffer;
  ended: Promise<void>;
  /** Writes each part on its own, waiting between them so TCP cannot coalesce them. */
  writeParts: (parts: string[]) => Promise<void>;
  /** Resolves once `bytes` have arrived in total. */
  receivedAtLeast: (bytes: number) => Promise<void>;
}> {
  const { port } = new URL(url);
  const socket = net.connect({ port: Number(port), host: "127.0.0.1", allowHalfOpen: true });
  socket.setNoDelay(true);
  clientSockets.add(socket);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const chunks: Buffer[] = [];
  let total = 0;
  const waiters: Array<{ bytes: number; resolve: () => void }> = [];
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    total += chunk.byteLength;
    for (const waiter of waiters.splice(0)) {
      if (total >= waiter.bytes) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  const ended = new Promise<void>((resolve) => socket.once("end", () => resolve()));
  return {
    socket,
    received: () => Buffer.concat(chunks),
    ended,
    async writeParts(parts) {
      for (const part of parts) {
        socket.write(part);
        await Bun.sleep(15);
      }
    },
    receivedAtLeast: (bytes) =>
      new Promise<void>((resolve) => {
        if (total >= bytes) resolve();
        else waiters.push({ bytes, resolve });
      }),
  };
}

/** A gateway that answers every request with a fixed response, keeping the connection. */
async function startRawGateway(respond: (request: string) => string, closeAfter = false) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let held = "";
    // Half-open, so a test sees the relay's end of stream; tracked, so teardown can close it.
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
    socket.once("end", () => socket.end());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      held += chunk.toString("latin1");
      for (;;) {
        const end = held.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = held.slice(0, end);
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? "0");
        if (held.length < end + 4 + length) return;
        held = held.slice(end + 4 + length);
        socket.write(respond(head));
        if (closeAfter) {
          socket.end();
          return;
        }
      }
    });
  });
  gateway = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function response(body: string, headers = ""): string {
  return `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n${headers}\r\n${body}`;
}

/** Bytes per class of what a parser released. */
function bytesBy(segments: Segment[]): Partial<Record<LinkCategory, number>> {
  const totals: Partial<Record<LinkCategory, number>> = {};
  for (const segment of segments) {
    totals[segment.category] = (totals[segment.category] ?? 0) + segment.bytes.byteLength;
  }
  return totals;
}

async function startGateway(): Promise<string> {
  gateway = http.createServer((request, response) => {
    if (request.url?.startsWith("/__orkestrator/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${"e".repeat(1_000)}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
    response.end(JSON.stringify({ result: "r".repeat(500) }));
  });
  await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
}

describe("classification", () => {
  test("gateway routes map to their class; anything else is other", () => {
    expect(categorize("/__orkestrator/events?since=4")).toBe("events");
    expect(categorize("/__orkestrator/invoke")).toBe("invoke");
    expect(categorize("/__orkestrator/terminal", true)).toBe("websocket");
    expect(categorize("/src/main.tsx")).toBe("other");
  });

  test("an invoke body names its command, never more", () => {
    expect(commandOf(Buffer.from('{"command":"get_projects","args":{"secret":"x"}}'))).toBe(
      "get_projects",
    );
    expect(commandOf(Buffer.from('{"args":{}}'))).toBeUndefined();
  });

  test("kbit/s are 1,000 bits, as the in-process baseline's throttle counts them", () => {
    expect(bytesPerMs(512)).toBe(64);
    expect(bytesPerMs(64)).toBe(8);
    expect(bytesPerMs(0)).toBe(0);
    expect(bytesPerMs(undefined)).toBe(0);
  });
});

describe("request stream", () => {
  function feedAll(stream: RequestStream, parts: string[]): Segment[] {
    return parts.flatMap((part) => stream.feed(Buffer.from(part, "latin1")));
  }

  test("a request head split anywhere is held whole, then classified", () => {
    const requests: LinkCategory[] = [];
    const stream = new RequestStream({ onRequest: (category) => requests.push(category) });
    const head = "POST /__orkestrator/invoke HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n";
    const parts = [
      "PO",
      "ST /__orkestr",
      "ator/invoke HTTP/1.1\r",
      "\nhost: x\r\ncontent-length: 0\r\n\r",
      "\n",
    ];
    const released = parts.map((part) => stream.feed(Buffer.from(part)));
    // Nothing leaves before the head is complete; then all of it, as an invoke.
    expect(released.slice(0, -1).every((segments) => segments.length === 0)).toBe(true);
    expect(bytesBy(released.flat())).toEqual({ invoke: head.length });
    expect(requests).toEqual(["invoke"]);
  });

  test("an Upgrade header split across writes still makes the connection a WebSocket", () => {
    const stream = new RequestStream();
    const segments = feedAll(stream, [
      "GET /__orkestrator/terminal HTTP/1.1\r\nUpgr",
      "ade: webso",
      "cket\r\nConnection: Upgrade\r\n\r\n",
      "\x81\x05frame",
    ]);
    expect(stream.category).toBe("websocket");
    expect(Object.keys(bytesBy(segments))).toEqual(["websocket"]);
  });

  test("an invoke's command field split across body writes is still named", () => {
    const commands: string[] = [];
    const stream = new RequestStream({ onCommand: (name) => commands.push(name) });
    const body = '{"command":"get_projects","args":{}}';
    feedAll(stream, [
      `POST /__orkestrator/invoke HTTP/1.1\r\ncontent-length: ${body.length}\r\n\r\n{"comm`,
      'and":"get_pro',
      'jects","args":{}}',
    ]);
    expect(stream.command).toBe("get_projects");
    expect(commands).toEqual(["get_projects"]);
  });

  test("a body that looks like a request line never starts a request", () => {
    const requests: LinkCategory[] = [];
    const stream = new RequestStream({ onRequest: (category) => requests.push(category) });
    const body = "GET /__orkestrator/events HTTP/1.1\r\n\r\n";
    feedAll(stream, [
      `POST /__orkestrator/invoke HTTP/1.1\r\ncontent-length: ${body.length}\r\n\r\n`,
      body,
    ]);
    expect(requests).toEqual(["invoke"]);
    expect(stream.category).toBe("invoke");
  });

  test("sequential keep-alive requests are each charged to their own class", () => {
    const stream = new RequestStream();
    const body = '{"command":"get_projects"}';
    const invoke = `POST /__orkestrator/invoke HTTP/1.1\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
    const asset = "GET /src/main.tsx HTTP/1.1\r\nhost: x\r\n\r\n";
    // The second head arrives in the same write as the end of the first body.
    const segments = feedAll(stream, [
      invoke.slice(0, 60),
      invoke.slice(60) + asset.slice(0, 10),
      asset.slice(10),
    ]);
    expect(bytesBy(segments)).toEqual({ invoke: invoke.length, other: asset.length });
    expect(stream.category).toBe("other");
    expect(stream.command).toBeUndefined();
  });

  test("a chunked body is framed by its chunks, trailer included", () => {
    const requests: LinkCategory[] = [];
    const stream = new RequestStream({ onRequest: (category) => requests.push(category) });
    const invoke =
      "POST /__orkestrator/invoke HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\n" +
      '7\r\n{"comma\r\n13;ext=1\r\nnd":"get_projects"}\r\n0\r\nx-trailer: y\r\n\r\n';
    const next = "GET /__orkestrator/events HTTP/1.1\r\n\r\n";
    const text = invoke + next;
    const segments = feedAll(stream, text.match(/[\s\S]{1,9}/g)!);
    expect(requests).toEqual(["invoke", "events"]);
    expect(stream.command).toBeUndefined();
    expect(bytesBy(segments)).toEqual({ invoke: invoke.length, events: next.length });
  });

  test("a head past the bound is released as it stands, never held without limit", () => {
    const stream = new RequestStream();
    const segments = stream.feed(
      Buffer.from(`GET /x HTTP/1.1\r\nx-long: ${"a".repeat(MAX_REQUEST_HEAD_BYTES)}`),
    );
    expect(segments).toHaveLength(1);
    expect(stream.feed(Buffer.from("more"))).toEqual([
      { bytes: Buffer.from("more"), category: "other" },
    ]);
  });

  test("a partial head is released when the client ends its side", () => {
    const stream = new RequestStream();
    expect(stream.feed(Buffer.from("GET /x HT"))).toEqual([]);
    expect(stream.flush()).toEqual([{ bytes: Buffer.from("GET /x HT"), category: "other" }]);
    expect(stream.flush()).toEqual([]);
  });
});

describe("counting link", () => {
  test("counts each class's wire bytes, headers included", async () => {
    link = await startCountingLink(await startGateway());
    const before = link.snapshot();
    const invoke = await fetch(`${link.url}/__orkestrator/invoke`, {
      method: "POST",
      body: JSON.stringify({ command: "get_projects", args: {} }),
    });
    const invokeBody = await invoke.text();
    const events = await (await fetch(`${link.url}/__orkestrator/events`)).text();
    const delta = linkDelta(before, link.snapshot());
    expect(delta.requests.invoke).toBe(1);
    expect(delta.requests.events).toBe(1);
    // Body plus status line and headers.
    expect(delta.down.invoke).toBeGreaterThan(invokeBody.length);
    expect(delta.down.events).toBeGreaterThan(events.length);
    expect(delta.up.invoke).toBeGreaterThan(0);
    expect(delta.commands.get_projects?.requests).toBe(1);
    expect(delta.commands.get_projects?.down).toBe(delta.down.invoke);
    expect(delta.downBytes).toBe(delta.down.invoke + delta.down.events + delta.down.other);
    expect(link.snapshot().lastStreamDelivery).toBeGreaterThan(0);
  });

  test("the queue peak covers one window at a time", async () => {
    link = await startCountingLink(await startGateway(), { latencyMs: 5 });
    await (await fetch(`${link.url}/__orkestrator/events`)).text();
    expect(link.snapshot().peakQueuedBytes).toBeGreaterThan(0);
    link.resetPeak();
    expect(link.snapshot().peakQueuedBytes).toBe(0);
  });

  test("a shaped link delivers at its rate and latency", async () => {
    link = await startCountingLink(await startGateway(), { kbps: 64, latencyMs: 30 });
    const startedAt = Date.now();
    // About 1.2 KB down at 64 kbit/s (8,000 B/s) plus 30 ms each way.
    await (await fetch(`${link.url}/__orkestrator/events`)).text();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    link.shape({});
    const unshapedAt = Date.now();
    await (await fetch(`${link.url}/__orkestrator/events`)).text();
    expect(Date.now() - unshapedAt).toBeLessThan(150);
  });

  test("requests and commands split across TCP writes are counted exactly", async () => {
    const answer = response('{"result":"ok"}');
    link = await startCountingLink(await startRawGateway(() => answer));
    const client = await rawClient(link.url);
    const before = link.snapshot();
    const body = '{"command":"get_projects","args":{}}';
    await client.writeParts([
      "POST /__orkes",
      `trator/invoke HTTP/1.1\r\nhost: x\r\ncontent-len`,
      `gth: ${body.length}\r\n\r\n{"comm`,
      body.slice(6),
    ]);
    await client.receivedAtLeast(answer.length);
    const delta = linkDelta(before, link.snapshot());
    expect(delta.requests).toEqual({ events: 0, invoke: 1, websocket: 0, other: 0 });
    expect(delta.commands).toEqual({ get_projects: { requests: 1, down: answer.length } });
    expect(delta.down.invoke).toBe(answer.length);
  });

  test("an invoke then an asset on one keep-alive connection are charged apart", async () => {
    const invokeAnswer = response(`{"result":"${"r".repeat(300)}"}`);
    const assetAnswer = response("a".repeat(700));
    link = await startCountingLink(
      await startRawGateway((head) => (head.includes("/invoke") ? invokeAnswer : assetAnswer)),
    );
    const before = link.snapshot();
    const client = await rawClient(link.url);
    const body = '{"command":"get_projects"}';
    const invoke = `POST /__orkestrator/invoke HTTP/1.1\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
    const asset = "GET /src/main.tsx HTTP/1.1\r\nhost: x\r\n\r\n";
    await client.writeParts([invoke]);
    await client.receivedAtLeast(invokeAnswer.length);
    await client.writeParts([asset]);
    await client.receivedAtLeast(invokeAnswer.length + assetAnswer.length);
    const delta = linkDelta(before, link.snapshot());
    expect(delta.connections).toBe(1);
    expect(delta.requests).toEqual({ events: 0, invoke: 1, websocket: 0, other: 1 });
    expect(delta.down.invoke).toBe(invokeAnswer.length);
    expect(delta.down.other).toBe(assetAnswer.length);
    expect(delta.up.invoke).toBe(invoke.length);
    expect(delta.up.other).toBe(asset.length);
    expect(delta.commands.get_projects).toEqual({ requests: 1, down: invokeAnswer.length });
  });

  test("a finite response with Connection: close arrives whole before the link closes", async () => {
    const answer = response("b".repeat(20_000), "connection: close\r\n");
    link = await startCountingLink(await startRawGateway(() => answer, true), {
      kbps: 2_000,
      latencyMs: 30,
    });
    const client = await rawClient(link.url);
    const before = link.snapshot();
    await client.writeParts(["GET /src/main.tsx HTTP/1.1\r\nhost: x\r\n\r\n"]);
    // 20 KB at 250 B/ms is about 80 ms behind 30 ms of latency: the gateway
    // has long closed its side when the body is still queued.
    await client.ended;
    expect(client.received().toString("latin1")).toBe(answer);
    const after = link.snapshot();
    expect(linkDelta(before, after).down.other).toBe(answer.length);
    expect(after.droppedBytes).toBe(0);
  });

  test("a reset drops what is queued for the connection and counts it as dropped", async () => {
    const answer = response("c".repeat(50_000));
    link = await startCountingLink(await startRawGateway(() => answer), {
      kbps: 64,
      latencyMs: 30,
    });
    const client = await rawClient(link.url);
    await client.writeParts(["GET /src/main.tsx HTTP/1.1\r\nhost: x\r\n\r\n"]);
    // The answer is queued behind the 8 B/ms link: reset before it is delivered.
    for (let attempt = 0; attempt < 100 && link.snapshot().peakQueuedBytes === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(link.snapshot().peakQueuedBytes).toBeGreaterThan(0);
    client.socket.resetAndDestroy();
    for (let attempt = 0; attempt < 100 && link.snapshot().droppedBytes === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    const after = link.snapshot();
    expect(after.droppedBytes).toBeGreaterThan(0);
    expect(after.down.other + after.droppedBytes).toBeLessThanOrEqual(answer.length);
  });
});

describe("shaped pipe", () => {
  function fakeSocket() {
    const written: Buffer[] = [];
    const events: string[] = [];
    let paused = false;
    const emitter = new EventEmitter();
    const state = { flowing: true, writableLength: 0 };
    // A getter, not a copied value: the pipe reads the buffered length as it changes.
    Object.defineProperty(emitter, "writableLength", { get: () => state.writableLength });
    const socket = Object.assign(emitter, {
      destroyed: false,
      writable: true,
      write: (chunk: Buffer) => {
        written.push(chunk);
        events.push(`write:${chunk.toString()}`);
        return state.flowing;
      },
      end: () => {
        events.push("end");
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
    });
    return {
      written,
      events,
      state,
      get paused() {
        return paused;
      },
      drain() {
        state.flowing = true;
        state.writableLength = 0;
        emitter.emit("drain");
      },
      socket: socket as unknown as Socket,
    };
  }

  test("stops reading the sender past the byte bound and resumes once it drains", async () => {
    let now = 0;
    const pipe = new ShapedPipe({ latencyMs: 10 }, () => now);
    const from = fakeSocket();
    const to = fakeSocket();
    let delivered = 0;
    const chunk = Buffer.alloc(1024 * 1024);
    const total = MAX_QUEUED_BYTES + chunk.byteLength;
    let drained!: () => void;
    const allDelivered = new Promise<void>((resolve) => {
      drained = resolve;
    });
    for (let index = 0; index <= MAX_QUEUED_BYTES / chunk.byteLength; index += 1) {
      pipe.push(from.socket, to.socket, chunk, () => {
        delivered += chunk.byteLength;
        if (delivered === total) drained();
      });
    }
    expect(from.paused).toBe(true);
    expect(pipe.bytesQueued).toBeGreaterThan(MAX_QUEUED_BYTES);
    // Past every chunk's latency: the pending timer delivers them all.
    now = 20;
    await allDelivered;
    expect(pipe.bytesQueued).toBe(0);
    expect(delivered).toBe(total);
    expect(from.paused).toBe(false);
    expect(pipe.peakQueuedBytes).toBe(MAX_QUEUED_BYTES + chunk.byteLength);
    pipe.stop();
  });

  test("a destination that returned false gets nothing more until it drains", () => {
    const pipe = new ShapedPipe({});
    const from = fakeSocket();
    const to = fakeSocket();
    const other = fakeSocket();
    let accounted = 0;
    to.state.flowing = false;
    pipe.push(from.socket, to.socket, Buffer.from("a"), () => (accounted += 1));
    pipe.push(from.socket, to.socket, Buffer.from("b"), () => (accounted += 1));
    pipe.push(from.socket, to.socket, Buffer.from("c"), () => (accounted += 1));
    // Another connection on the same link is not held behind it.
    pipe.push(from.socket, other.socket, Buffer.from("x"), () => undefined);
    expect(to.events).toEqual(["write:a"]);
    expect(other.events).toEqual(["write:x"]);
    expect(accounted).toBe(1);
    expect(pipe.bytesQueued).toBe(2);
    to.drain();
    expect(to.events).toEqual(["write:a", "write:b", "write:c"]);
    expect(accounted).toBe(3);
    expect(pipe.bytesQueued).toBe(0);
    pipe.stop();
  });

  test("a blocked destination's buffered bytes count against the bound and pause the sender", () => {
    const pipe = new ShapedPipe({});
    const from = fakeSocket();
    const to = fakeSocket();
    to.state.flowing = false;
    to.state.writableLength = MAX_QUEUED_BYTES;
    pipe.push(from.socket, to.socket, Buffer.from("a"), () => undefined);
    expect(from.paused).toBe(false);
    pipe.push(from.socket, to.socket, Buffer.from("b"), () => undefined);
    expect(pipe.bytesQueued).toBe(MAX_QUEUED_BYTES + 1);
    expect(pipe.peakQueuedBytes).toBe(MAX_QUEUED_BYTES + 1);
    expect(from.paused).toBe(true);
    to.drain();
    expect(from.paused).toBe(false);
    expect(to.events).toEqual(["write:a", "write:b"]);
    pipe.stop();
  });

  test("an end of stream waits behind the connection's queued bytes", async () => {
    let now = 0;
    const pipe = new ShapedPipe({ latencyMs: 10 }, () => now);
    const from = fakeSocket();
    const to = fakeSocket();
    pipe.push(from.socket, to.socket, Buffer.from("a"), () => undefined);
    pipe.push(from.socket, to.socket, Buffer.from("b"), () => undefined);
    pipe.end(to.socket);
    expect(to.events).toEqual([]);
    now = 20;
    for (let attempt = 0; attempt < 50 && to.events.length < 3; attempt += 1) await Bun.sleep(5);
    expect(to.events).toEqual(["write:a", "write:b", "end"]);
    pipe.stop();
  });

  test("discarding a destination drops its queue and counts the bytes", () => {
    const pipe = new ShapedPipe({ latencyMs: 1_000 });
    const from = fakeSocket();
    const to = fakeSocket();
    const other = fakeSocket();
    pipe.push(from.socket, to.socket, Buffer.from("abc"), () => undefined);
    pipe.push(from.socket, other.socket, Buffer.from("xy"), () => undefined);
    pipe.discard(to.socket);
    expect(pipe.droppedBytes).toBe(3);
    expect(pipe.bytesQueued).toBe(2);
    pipe.stop();
  });

  test("a shaped pipe paces at kbps / 8 bytes per millisecond", () => {
    let now = 0;
    // 64 kbit/s is 8 bytes per ms: 80 bytes take 10 ms.
    const pipe = new ShapedPipe({ kbps: 64 }, () => now);
    const to = fakeSocket();
    pipe.push(fakeSocket().socket, to.socket, Buffer.alloc(80), () => undefined);
    // Reshaping to the same rate pumps the queue at the fake clock's time.
    now = 9;
    pipe.reshape({ kbps: 64 });
    expect(to.written).toHaveLength(0);
    now = 10;
    pipe.reshape({ kbps: 64 });
    expect(to.written).toHaveLength(1);
    pipe.stop();
  });

  test("an unshaped pipe writes at once, in order", () => {
    const pipe = new ShapedPipe({});
    const to = fakeSocket();
    pipe.push(fakeSocket().socket, to.socket, Buffer.from("a"), () => undefined);
    pipe.push(fakeSocket().socket, to.socket, Buffer.from("b"), () => undefined);
    expect(Buffer.concat(to.written).toString()).toBe("ab");
  });
});

describe("summaries", () => {
  test("percentiles use the nearest rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });

  test("numeric deltas ignore non-numbers and treat a missing prior as zero", () => {
    expect(
      numericDelta({ a: 1, b: "x" }, { a: 4, b: "y", c: 2 } as Record<string, unknown>),
    ).toEqual({ a: 3, c: 2 });
  });
});
