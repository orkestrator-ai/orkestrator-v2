import { describe, expect, test } from "bun:test";
import { FakeReadable, FakeWritable, ScriptedAppServer } from "./fake-app-server.js";

function collectJson(readable: FakeReadable): {
  messages: Array<Record<string, unknown>>;
  ended: () => boolean;
  closed: () => boolean;
  errors: Error[];
} {
  const messages: Array<Record<string, unknown>> = [];
  const errors: Error[] = [];
  let didEnd = false;
  let didClose = false;
  readable.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  readable.on("end", () => {
    didEnd = true;
  });
  readable.on("close", () => {
    didClose = true;
  });
  readable.on("error", (error) => errors.push(error));
  return {
    messages,
    ended: () => didEnd,
    closed: () => didClose,
    errors,
  };
}

describe("FakeReadable", () => {
  test("emits exact chunks, JSON messages, end, close, and errors", () => {
    const readable = new FakeReadable();
    const observed = collectJson(readable);

    readable.pushMessage({ id: 1, result: "ok" });
    readable.end();
    readable.destroy();
    readable.destroy(new Error("stream failed"));

    expect(observed.messages).toEqual([{ id: 1, result: "ok" }]);
    expect(observed.ended()).toBe(true);
    expect(observed.closed()).toBe(true);
    expect(observed.errors.map((error) => error.message)).toEqual(["stream failed"]);
  });
});

describe("FakeWritable", () => {
  test("parses writes, exposes the last request, and releases backpressure once", () => {
    const writable = new FakeWritable({
      applyBackpressure: (_line, index) => index === 0,
    });
    let drains = 0;
    writable.once("drain", () => {
      drains += 1;
    });

    expect(writable.write('{"id":1,"method":"first"}\n')).toBe(false);
    expect(writable.isAwaitingDrain()).toBe(true);
    expect(writable.lastRequest()).toEqual({ id: 1, method: "first" });
    writable.drain();
    writable.drain();

    expect(writable.isAwaitingDrain()).toBe(false);
    expect(drains).toBe(1);
  });

  test("reports scripted write failures without recording the line", () => {
    const writable = new FakeWritable({
      failWith: () => new Error("EPIPE"),
    });
    let failure: Error | null | undefined;

    expect(
      writable.write("not recorded\n", (error) => {
        failure = error;
      }),
    ).toBe(true);
    expect(failure?.message).toBe("EPIPE");
    expect(writable.lines).toEqual([]);
    expect(writable.lastRequest()).toBeUndefined();
  });
});

describe("ScriptedAppServer", () => {
  test("handles requests, notifications, unknown methods, and handler failures", async () => {
    const server = new ScriptedAppServer({
      echo: (params) => params,
      fail: () => {
        throw new Error("handler failed");
      },
    });
    const observed = collectJson(server.stdout);
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "echo", params: { value: 3 } },
      { jsonrpc: "2.0", id: 2, method: "missing", params: null },
      { jsonrpc: "2.0", id: 3, method: "fail", params: null },
      { jsonrpc: "2.0", method: "client/notice", params: { seen: true } },
    ]) {
      server.stdin.write(`${JSON.stringify(message)}\n`);
    }

    await server.flush();

    expect(server.received.map(({ id, method }) => ({ id, method }))).toEqual([
      { id: 1, method: "echo" },
      { id: 2, method: "missing" },
      { id: 3, method: "fail" },
      { id: undefined, method: "client/notice" },
    ]);
    expect(observed.messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: { value: 3 } },
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32601, message: "unknown method missing" },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32603, message: "handler failed" },
      },
    ]);
  });

  test("emits every server-side helper envelope and exits the streams", () => {
    const server = new ScriptedAppServer();
    const observed = collectJson(server.stdout);

    server.notify("turn/started", { turnId: "turn-1" }, 123);
    server.requestFromServer("approval-1", "item/requestApproval", { reason: "test" });
    server.rejectWithOverload(9);
    server.exit();

    expect(observed.messages).toEqual([
      {
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turnId: "turn-1" },
        emittedAtMs: 123,
      },
      {
        jsonrpc: "2.0",
        id: "approval-1",
        method: "item/requestApproval",
        params: { reason: "test" },
      },
      {
        jsonrpc: "2.0",
        id: 9,
        error: { code: -32001, message: "ingress queue full" },
      },
    ]);
    expect(server.stdin.destroyed).toBe(true);
    expect(observed.ended()).toBe(true);
  });
});
