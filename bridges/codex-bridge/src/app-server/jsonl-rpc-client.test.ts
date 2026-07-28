import { describe, test, expect } from "bun:test";
import {
  JsonlRpcClient,
  SerialQueue,
  METHOD_TIMEOUTS_MS,
  type JsonlRpcClientOptions,
} from "./jsonl-rpc-client.js";
import {
  AppServerProcessExitError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
  classifyDispatchFailure,
  isSafeToRetryImmediately,
} from "./errors.js";
import { FakeReadable, FakeWritable, ScriptedAppServer } from "./testing/fake-app-server.js";
import type { InboundNotification, InboundServerRequest } from "./envelope-validation.js";

interface Harness {
  client: JsonlRpcClient;
  stdout: FakeReadable;
  stdin: FakeWritable;
  notifications: Array<{ notification: InboundNotification; threadId: string | null }>;
  serverRequests: InboundServerRequest[];
  violations: Array<{ detail: string; preview: string }>;
}

function harness(overrides: Partial<JsonlRpcClientOptions> = {}, stdin?: FakeWritable): Harness {
  const stdout = new FakeReadable();
  const writable = stdin ?? new FakeWritable();
  const notifications: Harness["notifications"] = [];
  const serverRequests: InboundServerRequest[] = [];
  const violations: Harness["violations"] = [];

  const client = new JsonlRpcClient({
    generation: 1,
    stdin: writable,
    stdout,
    onNotification: (notification, threadId) => notifications.push({ notification, threadId }),
    onServerRequest: (request) => serverRequests.push(request),
    onProtocolViolation: (detail, preview) => violations.push({ detail, preview }),
    ...overrides,
  });

  return { client, stdout, stdin: writable, notifications, serverRequests, violations };
}

/** Lets queued microtasks settle without depending on wall-clock timing. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("JSONL framing", () => {
  test("reassembles a message split across many chunks", async () => {
    const h = harness();
    const promise = h.client.request("thread/read", { threadId: "t1" });
    const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    // One byte at a time: the reader must hold state across chunks.
    for (const char of response) h.stdout.push(char);
    h.stdout.push("\n");

    expect(await promise).toEqual({ ok: true });
  });

  test("handles several messages plus a partial tail in one chunk", async () => {
    const h = harness();
    const first = h.client.request("a");
    const second = h.client.request("b");

    const line1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 });
    const line2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: 2 });
    const tail = JSON.stringify({ jsonrpc: "2.0", method: "warning", params: {} });
    h.stdout.push(`${line1}\n${line2}\n${tail.slice(0, 10)}`);

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    // The partial tail must not have been dispatched yet.
    expect(h.notifications).toHaveLength(0);

    h.stdout.push(`${tail.slice(10)}\n`);
    expect(h.notifications).toHaveLength(1);
  });

  test("a buffered partial tail is completed by a chunk carrying more lines", async () => {
    // The scan resumes at the buffered tail's end rather than offset 0, so this
    // sequence — partial tail, then a chunk that completes it and adds whole
    // lines plus a new partial — exercises every offset transition.
    const h = harness();
    const first = h.client.request("a");
    const second = h.client.request("b");
    const note = JSON.stringify({ jsonrpc: "2.0", method: "warning", params: {} });

    const line1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "one" });
    h.stdout.push(line1.slice(0, 12));
    h.stdout.push(
      `${line1.slice(12)}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: "two" })}\n${note.slice(0, 8)}`,
    );

    expect(await first).toBe("one");
    expect(await second).toBe("two");
    expect(h.notifications).toHaveLength(0);

    h.stdout.push(`${note.slice(8)}\n`);
    expect(h.notifications).toHaveLength(1);
  });

  test("CRLF split across chunks still strips the carriage return", async () => {
    const h = harness();
    const promise = h.client.request("a");
    h.stdout.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "split" })}\r`);
    h.stdout.push("\n");
    expect(await promise).toBe("split");
  });

  test("tolerates CRLF framing", async () => {
    const h = harness();
    const promise = h.client.request("a");
    h.stdout.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "crlf" })}\r\n`);
    expect(await promise).toBe("crlf");
  });

  test("ignores blank lines and stderr-style noise without JSON", () => {
    const h = harness();
    h.stdout.push("\n\n   \n");
    expect(h.violations).toHaveLength(0);

    h.stdout.push("not json at all\n");
    expect(h.violations[0]?.detail).toBe("line is not valid JSON");
  });

  test("a malformed line does not break the messages around it", async () => {
    const h = harness();
    const promise = h.client.request("a");
    h.stdout.push("{ broken\n");
    h.stdout.push(`${JSON.stringify({ jseonrpc: "2.0", id: 1, result: "recovered" })}\n`);

    expect(await promise).toBe("recovered");
    expect(h.violations).toHaveLength(1);
  });

  test("discards an oversized partial line and resyncs at the next newline", async () => {
    const h = harness({ maxInboundLineBytes: 128 });
    const promise = h.client.request("a");

    h.stdout.push("x".repeat(200));
    expect(h.violations[0]?.detail).toContain("exceeded 128 bytes");
    expect(h.client.getMetrics().oversizedInboundLines).toBe(1);

    // The reader is still usable.
    h.stdout.push(`\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "alive" })}\n`);
    expect(await promise).toBe("alive");
  });

  test("discards an oversized partial line that follows a consumed one", async () => {
    // The overflow path after partial consumption: `lineStart > 0`, so the buffer
    // has already been sliced and the scan offset reset before the size check
    // runs. Getting that wrong drops the wrong prefix and desynchronises framing.
    const h = harness({ maxInboundLineBytes: 128 });
    const first = h.client.request("a");

    h.stdout.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "consumed" })}\n${"x".repeat(200)}`,
    );

    expect(await first).toBe("consumed");
    expect(h.client.getMetrics().oversizedInboundLines).toBe(1);
    expect(h.violations[0]?.detail).toContain("exceeded 128 bytes");

    const second = h.client.request("b");
    h.stdout.push(`\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: "alive" })}\n`);
    expect(await second).toBe("alive");
  });

  test("measures the inbound budget in bytes, not UTF-16 code units", async () => {
    // "→" is one code unit but three UTF-8 bytes. A budget compared against
    // `String#length` lets a peer buffer three times the memory it was allowed.
    const h = harness({ maxInboundLineBytes: 128 });
    const promise = h.client.request("a");

    // 60 code units, 180 bytes: over the byte budget, under the length budget.
    h.stdout.pushBytes(Buffer.from("→".repeat(60), "utf8"));

    expect(h.client.getMetrics().oversizedInboundLines).toBe(1);
    h.stdout.push(`\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "alive" })}\n`);
    expect(await promise).toBe("alive");
  });

  test("reassembles a multi-byte character split across a chunk boundary", async () => {
    // A real pipe splits on bytes. Decoding each chunk independently turns the
    // straddling sequence into U+FFFD — and because U+FFFD is a legal JSON string
    // character, `JSON.parse` still succeeds and the corruption reaches the user's
    // transcript silently.
    const h = harness();
    const promise = h.client.request("thread/read");
    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "→ 日本語 🙂 ✓" } })}\n`,
      "utf8",
    );

    // Split at every byte offset so at least one cut lands mid-sequence.
    for (const byte of line) h.stdout.pushBytes(Buffer.from([byte]));

    expect(await promise).toEqual({ text: "→ 日本語 🙂 ✓" });
    expect(h.violations).toHaveLength(0);
  });

  test("a dispatch handler that feeds the reader back does not lose frames", async () => {
    // Re-entrancy: `pushMessage → emit → handleChunk` is synchronous for every
    // scripted transport in this suite, so a handler that pushes a follow-up
    // notification re-enters the scan. Without a guard the inner call restarts at
    // offset 0 over a buffer that still holds dispatched lines, emits a "line"
    // spanning two records, and the outer slice then discards the rest.
    const stdout = new FakeReadable();
    const notifications: string[] = [];
    const violations: Array<{ detail: string; preview: string }> = [];
    const note = (method: string) =>
      `${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`;

    new JsonlRpcClient({
      generation: 1,
      stdin: new FakeWritable(),
      stdout,
      onNotification: (notification) => {
        notifications.push(notification.method);
        if (notification.method === "a") stdout.push(note("d"));
      },
      onServerRequest: () => undefined,
      onProtocolViolation: (detail, preview) => violations.push({ detail, preview }),
    });

    stdout.push(`${note("a")}${note("b")}${note("c")}`);

    expect(notifications).toEqual(["a", "b", "c", "d"]);
    expect(violations).toEqual([]);
  });

  test("a throwing protocol-violation handler does not re-dispatch consumed lines", async () => {
    // The only path that throws out of the scan loop. The `finally` has to leave
    // the buffer past the lines already dispatched — otherwise the next chunk
    // replays them — while resetting the scan offset, because an interrupted scan
    // never proved the remainder holds no newline.
    const stdout = new FakeReadable();
    const notifications: string[] = [];
    let thrown = 0;

    const client = new JsonlRpcClient({
      generation: 1,
      stdin: new FakeWritable(),
      stdout,
      onNotification: (notification) => notifications.push(notification.method),
      onServerRequest: () => undefined,
      onProtocolViolation: () => {
        thrown += 1;
        throw new Error("violation handler exploded");
      },
    });

    const note = (method: string) =>
      `${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`;

    expect(() => stdout.push(`${note("first")}not json\n${note("never-reached")}`)).toThrow(
      "violation handler exploded",
    );
    expect(thrown).toBe(1);
    expect(notifications).toEqual(["first"]);

    // The next chunk resumes from the surviving remainder: "first" is not
    // dispatched twice, and the line the throw interrupted still lands.
    stdout.push(note("after"));
    expect(notifications).toEqual(["first", "never-reached", "after"]);
    expect(client.getMetrics().notificationsReceived).toBe(3);
  });

  test("a multi-megabyte line spread over many chunks is assembled once", async () => {
    // The exact `thread/read` shape the scan offset exists for: no newline until
    // the very end, so a scan that restarted at offset 0 per chunk would be
    // O(n²) over ~2MB delivered in 64KB pipe-sized pieces.
    const h = harness({ maxInboundLineBytes: 16 * 1024 * 1024 });
    const promise = h.client.request("thread/read");
    const payload = "abcdefgh".repeat(256 * 1024); // 2MB
    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: payload } })}\n`,
      "utf8",
    );

    const chunkSize = 64 * 1024;
    expect(line.length / chunkSize).toBeGreaterThan(30);
    for (let offset = 0; offset < line.length; offset += chunkSize) {
      h.stdout.pushBytes(line.subarray(offset, offset + chunkSize));
    }

    expect(await promise).toEqual({ text: payload });
    expect(h.violations).toHaveLength(0);
    expect(h.client.getMetrics().oversizedInboundLines).toBe(0);
  });
});

describe("request correlation", () => {
  test("resolves concurrent requests by id, out of order", async () => {
    const h = harness();
    const first = h.client.request("first");
    const second = h.client.request("second");
    const third = h.client.request("third");

    h.stdout.pushMessage({ jsonrpc: "2.0", id: 3, result: "c" });
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 1, result: "a" });
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 2, result: "b" });

    expect(await Promise.all([first, second, third])).toEqual(["a", "b", "c"]);
  });

  test("assigns monotonically increasing ids", async () => {
    const h = harness();
    void h.client.request("a").catch(() => undefined);
    void h.client.request("b").catch(() => undefined);
    await settle();

    expect(h.stdin.parsed().map((message) => message.id)).toEqual([1, 2]);
  });

  test("an error response rejects with the code preserved", async () => {
    const h = harness();
    const promise = h.client.request("turn/start");
    h.stdout.pushMessage({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "bad params" },
    });

    await expect(promise).rejects.toBeInstanceOf(AppServerRpcError);
    await promise.catch((error: AppServerRpcError) => {
      expect(error.code).toBe(-32602);
      expect(error.method).toBe("turn/start");
    });
  });

  test("overload is flagged retryable; other errors are not", async () => {
    const h = harness();
    const promise = h.client.request("turn/start");
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "full" } });

    const error = await promise.catch((caught: AppServerRpcError) => caught);
    expect(error).toBeInstanceOf(AppServerRpcError);
    expect((error as AppServerRpcError).isOverload()).toBe(true);
    expect(isSafeToRetryImmediately(error)).toBe(true);
    expect(h.client.getMetrics().overloadResponses).toBe(1);
  });

  test("a response for an unknown id is reported, not thrown", () => {
    const h = harness();
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 999, result: "stray" });
    expect(h.violations[0]?.detail).toContain("unknown request id 999");
  });

  test("a duplicate response for the same id is ignored the second time", async () => {
    const h = harness();
    const promise = h.client.request("a");
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 1, result: "first" });
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 1, result: "second" });

    expect(await promise).toBe("first");
    expect(h.violations.some((entry) => entry.detail.includes("unknown request id"))).toBe(true);
  });

  test("times out per method and marks the failure ambiguous", async () => {
    const h = harness();
    const promise = h.client.request("slow", undefined, { timeoutMs: 5 });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppServerTimeoutError);
    // A timeout must never be treated as "did not execute".
    expect(classifyDispatchFailure(error)).toBe("ambiguous");
    expect(h.client.getMetrics().timeouts).toBe(1);
  });

  test("interrupt has a short budget so a hung interrupt cannot look idle", () => {
    const h = harness();
    expect(h.client.timeoutFor("turn/interrupt")).toBe(METHOD_TIMEOUTS_MS["turn/interrupt"]);
    expect(h.client.timeoutFor("turn/interrupt")).toBeLessThan(h.client.timeoutFor("thread/read"));
    // Unknown methods fall back to the default rather than hanging forever.
    expect(h.client.timeoutFor("some/other")).toBeGreaterThan(0);
  });
});

describe("notifications and server requests", () => {
  test("routes a notification with its thread id without awaiting the consumer", () => {
    const h = harness();
    h.stdout.pushMessage({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-7", turnId: "turn-1", itemId: "i1", delta: "hi" },
      emittedAtMs: 1234,
    });

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.threadId).toBe("thread-7");
    expect(h.notifications[0]!.notification.emittedAtMs).toBe(1234);
  });

  test("extracts the thread id nested inside thread/started", () => {
    const h = harness();
    h.stdout.pushMessage({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "nested-thread" } },
    });

    expect(h.notifications[0]!.threadId).toBe("nested-thread");
  });

  test("a notification arriving before its request's response is not misrouted", async () => {
    const h = harness();
    const promise = h.client.request("turn/start", { threadId: "t1" });

    // app-server legitimately emits turn/started before answering turn/start.
    h.stdout.pushMessage({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    h.stdout.pushMessage({ jsonrpc: "2.0", id: 1, result: { turn: { id: "turn-1" } } });

    expect(h.notifications).toHaveLength(1);
    expect(await promise).toEqual({ turn: { id: "turn-1" } });
  });

  test("a message with both id and method is a server request, not a response", () => {
    const h = harness();
    h.stdout.pushMessage({
      jsonrpc: "2.0",
      id: "srv-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1" },
    });

    expect(h.serverRequests).toHaveLength(1);
    expect(h.serverRequests[0]!.id).toBe("srv-1");
    expect(h.notifications).toHaveLength(0);
  });

  test("a throwing consumer cannot kill the read loop", async () => {
    const stdout = new FakeReadable();
    const client = new JsonlRpcClient({
      generation: 1,
      stdin: new FakeWritable(),
      stdout,
      onNotification: () => {
        throw new Error("consumer exploded");
      },
      onServerRequest: () => {
        throw new Error("router exploded");
      },
    });

    stdout.pushMessage({ jsonrpc: "2.0", method: "warning", params: {} });
    stdout.pushMessage({ jsonrpc: "2.0", id: "s1", method: "attestation/generate", params: {} });

    // Still able to correlate a normal response afterwards.
    const promise = client.request("a");
    stdout.pushMessage({ jsonrpc: "2.0", id: 1, result: "still working" });
    expect(await promise).toBe("still working");
  });

  test("responds to a server request and can reply with an error", async () => {
    const h = harness();
    await h.client.respond("srv-1", { decision: "denied" });
    await h.client.respondWithError("srv-2", -32601, "unsupported");

    const written = h.stdin.parsed();
    expect(written[0]).toEqual({ jsonrpc: "2.0", id: "srv-1", result: { decision: "denied" } });
    expect(written[1]).toEqual({
      jsonrpc: "2.0",
      id: "srv-2",
      error: { code: -32601, message: "unsupported" },
    });
  });

  test("notifications carry no id", async () => {
    const h = harness();
    await h.client.notify("initialized");
    expect(h.stdin.parsed()[0]).toEqual({ jsonrpc: "2.0", method: "initialized" });
  });
});

describe("write path", () => {
  test("waits for drain before resolving a back-pressured write", async () => {
    const stdin = new FakeWritable({ applyBackpressure: (_line, index) => index === 0 });
    const h = harness({}, stdin);

    let resolved = false;
    void h.client.notify("initialized").then(() => {
      resolved = true;
    });
    await settle();

    // The line is buffered but the write has not completed.
    expect(stdin.isAwaitingDrain()).toBe(true);
    expect(resolved).toBe(false);

    stdin.drain();
    await settle();
    expect(resolved).toBe(true);
    expect(h.client.getMetrics().writeBackpressureEvents).toBe(1);
  });

  test("serializes writes so concurrent requests cannot interleave lines", async () => {
    const stdin = new FakeWritable({ applyBackpressure: (_line, index) => index === 0 });
    const h = harness({}, stdin);

    void h.client.request("first").catch(() => undefined);
    void h.client.request("second").catch(() => undefined);
    await settle();

    // The second write must not land until the first drains.
    expect(stdin.lines).toHaveLength(1);
    stdin.drain();
    await settle();
    expect(stdin.lines).toHaveLength(2);

    const ids = stdin.parsed().map((message) => message.id);
    expect(ids).toEqual([1, 2]);
    for (const line of stdin.lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("rejects an outbound message over the size cap without writing it", async () => {
    const h = harness({ maxOutboundLineBytes: 64 });
    await expect(
      h.client.request("turn/start", { input: "x".repeat(500) }),
    ).rejects.toBeInstanceOf(AppServerProtocolError);
    expect(h.stdin.lines).toHaveLength(0);
  });

  test("a failed write rejects the request and clears its pending entry", async () => {
    const stdin = new FakeWritable({ failWith: () => new Error("EPIPE") });
    const h = harness({}, stdin);

    await expect(h.client.request("turn/start")).rejects.toThrow("EPIPE");
    expect(h.client.getMetrics().pendingRequests).toBe(0);
  });

  test("later writes still succeed after one fails", async () => {
    let failNext = true;
    const stdin = new FakeWritable({
      failWith: () => {
        if (!failNext) return null;
        failNext = false;
        return new Error("transient");
      },
    });
    const h = harness({}, stdin);

    await expect(h.client.notify("initialized")).rejects.toThrow("transient");
    await h.client.notify("initialized");
    expect(stdin.lines).toHaveLength(1);
  });

  test("refuses to write once stdin is gone", async () => {
    const stdin = new FakeWritable();
    const h = harness({}, stdin);
    stdin.destroyed = true;

    await expect(h.client.request("a")).rejects.toBeInstanceOf(AppServerProcessExitError);
  });
});

describe("process exit", () => {
  test("rejects every in-flight request with an ambiguous, per-method error", async () => {
    const h = harness();
    const first = h.client.request("turn/start");
    const second = h.client.request("thread/read");

    h.stdout.end();

    const firstError = await first.catch((error: unknown) => error);
    const secondError = await second.catch((error: unknown) => error);

    for (const error of [firstError, secondError]) {
      expect(error).toBeInstanceOf(AppServerProcessExitError);
      // Never auto-retry: the write may have landed before the exit.
      expect(classifyDispatchFailure(error)).toBe("ambiguous");
      expect(isSafeToRetryImmediately(error)).toBe(false);
    }
    expect((firstError as AppServerProcessExitError).method).toBe("turn/start");
    expect((secondError as AppServerProcessExitError).method).toBe("thread/read");
    expect((firstError as AppServerProcessExitError).generation).toBe(1);
  });

  test("close() attaches the supervisor's exit detail", async () => {
    const h = harness();
    const promise = h.client.request("turn/start");
    h.client.close(
      new AppServerProcessExitError("app-server exited with code 1", {
        generation: 1,
        exitCode: 1,
      }),
    );

    const error = await promise.catch((caught: AppServerProcessExitError) => caught);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("code 1");
  });

  test("requests after close fail fast instead of hanging", async () => {
    const h = harness();
    h.stdout.end();
    expect(h.client.isClosed()).toBe(true);
    await expect(h.client.request("a")).rejects.toBeInstanceOf(AppServerProcessExitError);
  });

  test("stdout error closes the connection", async () => {
    const h = harness();
    const promise = h.client.request("a");
    h.stdout.destroy(new Error("read failure"));
    await expect(promise).rejects.toBeInstanceOf(AppServerProcessExitError);
  });
});

describe("scripted app-server round trip", () => {
  test("drives initialize, a notification, and a turn like the real binary", async () => {
    const server = new ScriptedAppServer({
      initialize: () => ({ userAgent: "orkestrator/0.145.0", codexHome: "/tmp/codex" }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    const notifications: InboundNotification[] = [];
    const client = new JsonlRpcClient({
      generation: 3,
      stdin: server.stdin,
      stdout: server.stdout,
      onNotification: (notification) => notifications.push(notification),
      onServerRequest: () => undefined,
    });

    const initPromise = client.request("initialize", { clientInfo: { name: "orkestrator" } });
    await server.flush();
    expect((await initPromise) as Record<string, unknown>).toMatchObject({
      codexHome: "/tmp/codex",
    });

    await client.notify("initialized");
    const turnPromise = client.request("turn/start", { threadId: "t1" });
    server.notify("turn/started", { threadId: "t1", turn: { id: "turn-1" } });
    await server.flush();

    expect(await turnPromise).toEqual({ turn: { id: "turn-1" } });
    expect(notifications.map((entry) => entry.method)).toEqual(["turn/started"]);
    expect(server.received.map((entry) => entry.method)).toEqual([
      "initialize",
      "initialized",
      "turn/start",
    ]);
  });

  test("an unknown method comes back as a rejection, not a hang", async () => {
    const server = new ScriptedAppServer({});
    const client = new JsonlRpcClient({
      generation: 1,
      stdin: server.stdin,
      stdout: server.stdout,
      onNotification: () => undefined,
      onServerRequest: () => undefined,
    });

    const promise = client.request("does/not/exist");
    await server.flush();
    const error = await promise.catch((caught: AppServerRpcError) => caught);
    expect(error.code).toBe(-32601);
  });
});

describe("SerialQueue", () => {
  test("preserves order within a key", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];

    queue.run("thread-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    queue.run("thread-a", () => {
      order.push(2);
    });

    await queue.drain("thread-a");
    expect(order).toEqual([1, 2]);
  });

  test("a slow key does not delay a different key", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    queue.run("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow");
    });
    queue.run("fast", () => {
      order.push("fast");
    });

    await queue.drain("fast");
    // The fast thread completed while the slow one was still running.
    expect(order).toEqual(["fast"]);
    await queue.drain("slow");
    expect(order).toEqual(["fast", "slow"]);
  });

  test("a failing task does not block its successors", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    queue.run("k", () => {
      throw new Error("boom");
    });
    queue.run("k", () => {
      order.push("after");
    });

    await queue.drain("k");
    expect(order).toEqual(["after"]);
  });

  test("tracks queue depth for reducer-lag metrics", async () => {
    const queue = new SerialQueue();
    queue.run("k", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    queue.run("k", () => undefined);

    expect(queue.pendingDepth).toBe(2);
    expect(queue.highWaterMark).toBeGreaterThanOrEqual(2);
    await queue.drainAll();
    expect(queue.pendingDepth).toBe(0);
  });
});
