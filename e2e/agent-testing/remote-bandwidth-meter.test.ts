import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  MAX_QUEUED_BYTES,
  ShapedPipe,
  categorize,
  commandOf,
  linkDelta,
  numericDelta,
  percentile,
  requestStart,
  startCountingLink,
  type CountingLink,
} from "./remote-bandwidth-meter";

// The test preload replaces the global with happy-dom's, which applies a page's
// same-origin policy to these loopback requests.
const fetch = Bun.fetch;

let link: CountingLink | undefined;
let gateway: http.Server | undefined;
afterEach(async () => {
  await link?.close();
  link = undefined;
  await new Promise<void>((resolve) => (gateway ? gateway.close(() => resolve()) : resolve()));
  gateway = undefined;
});

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

  test("a request line starts an exchange; a body chunk does not", () => {
    expect(
      requestStart(Buffer.from("POST /__orkestrator/invoke HTTP/1.1\r\nhost: x\r\n\r\n")),
    ).toEqual({ category: "invoke" });
    expect(
      requestStart(
        Buffer.from(
          "GET /__orkestrator/terminal HTTP/1.1\r\nUpgrade: websocket\r\nhost: x\r\n\r\n",
        ),
      ),
    ).toEqual({ category: "websocket" });
    expect(requestStart(Buffer.from('{"command":"GET / HTTP/1.1"}'))).toBeNull();
  });

  test("an invoke body names its command, never more", () => {
    expect(commandOf(Buffer.from('{"command":"get_projects","args":{"secret":"x"}}'))).toBe(
      "get_projects",
    );
    expect(commandOf(Buffer.from('{"args":{}}'))).toBeUndefined();
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
    // About 1.2 KB down at 64 kbit/s (8 KB/s) plus 30 ms each way.
    await (await fetch(`${link.url}/__orkestrator/events`)).text();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    link.shape({});
    const unshapedAt = Date.now();
    await (await fetch(`${link.url}/__orkestrator/events`)).text();
    expect(Date.now() - unshapedAt).toBeLessThan(150);
  });
});

describe("shaped pipe", () => {
  function fakeSocket() {
    const written: Buffer[] = [];
    let paused = false;
    return {
      written,
      get paused() {
        return paused;
      },
      socket: {
        destroyed: false,
        write: (chunk: Buffer) => written.push(chunk),
        pause: () => {
          paused = true;
        },
        resume: () => {
          paused = false;
        },
      } as unknown as Socket,
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
