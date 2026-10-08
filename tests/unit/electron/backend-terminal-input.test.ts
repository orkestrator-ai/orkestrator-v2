import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  BackendHttpClient,
  MAX_TERMINAL_QUEUED_BYTES,
  MAX_TERMINAL_QUEUE_OPERATIONS,
  MAX_TERMINAL_QUEUE_WAITERS,
  MAX_TERMINAL_QUEUES,
  MAX_TERMINAL_WRITE_BATCH_BYTES,
} from "../../../apps/desktop/electron/backend-process";
import { nativeWebPlatform } from "../../register-dom";

const originalFetch = globalThis.fetch;
const originalController = globalThis.AbortController;
const originalSignal = globalThis.AbortSignal;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.AbortController = originalController;
  globalThis.AbortSignal = originalSignal;
});

type Body = { command: string; args: Record<string, unknown> };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const delivered = () => Response.json({ result: { delivered: true } });
function fixture(
  send?: (body: Body, signal?: AbortSignal | null) => Promise<Response>,
  timeout = 30_000,
) {
  globalThis.AbortController = nativeWebPlatform.AbortController;
  globalThis.AbortSignal = nativeWebPlatform.AbortSignal;
  const bodies: Body[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return send ? send(body, init?.signal) : delivered();
  }) as unknown as typeof fetch;
  return {
    client: new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
      terminalSendTimeoutMs: timeout,
    }),
    bodies,
  };
}
function queueSnapshot(client: BackendHttpClient) {
  return Array.from(
    (
      client as unknown as {
        terminalWrites: Map<
          string,
          { bytes: number; operationCount: number; waiters: Set<unknown>; operations: unknown[] }
        >;
      }
    ).terminalWrites.values(),
  ).map((queue) => ({
    bytes: queue.bytes,
    operations: queue.operationCount,
    waiters: queue.waiters.size,
    pending: queue.operations.length,
  }));
}
const families = [
  ["terminal_write", "terminal_resize", "detach_terminal", "start_terminal_session"],
  [
    "local_terminal_write",
    "local_terminal_resize",
    "close_local_terminal_session",
    "start_local_terminal_session",
  ],
] as const;

// Catch immediately: these tests deliberately reject input the UI may not await.
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => value,
    (error) => error,
  );

describe("Electron terminal HTTP input", () => {
  test("splits a single oversized batch at UTF-8 boundaries and resolves only after all chunks", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let call = 0;
    const { client, bodies } = fixture(async () => (++call === 1 ? first.promise : second.promise));
    const input = "a".repeat(MAX_TERMINAL_WRITE_BATCH_BYTES - 1) + "😀é\ud800";
    let settled = false;
    const write = client.invoke("terminal_write", { sessionId: "utf8", data: input }).then(() => {
      settled = true;
    });
    expect(bodies[0]!.args.data).toBe("a".repeat(MAX_TERMINAL_WRITE_BATCH_BYTES - 1));
    first.resolve(delivered());
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(bodies[1]!.args.data).toBe("😀é\ud800");
    expect(bodies.map((body) => String(body.args.data)).join("")).toBe(input);
    expect(
      bodies.every(
        (body) =>
          Buffer.byteLength(String(body.args.data), "utf8") <= MAX_TERMINAL_WRITE_BATCH_BYTES,
      ),
    ).toBe(true);
    second.resolve(delivered());
    await write;
  });

  test("coalesces exactly to 64 KiB but puts an overflowing UTF-8 character in the next batch", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () =>
      bodies.length === 1 ? held.promise : delivered(),
    );
    const writes = ["active", "a".repeat(MAX_TERMINAL_WRITE_BATCH_BYTES - 2), "é", "😀"].map(
      (data) => client.invoke("terminal_write", { sessionId: "boundary", data }),
    );
    held.resolve(delivered());
    await Promise.all(writes);
    expect(bodies.map((body) => body.args.data)).toEqual([
      "active",
      "a".repeat(MAX_TERMINAL_WRITE_BATCH_BYTES - 2) + "é",
      "😀",
    ]);
  });

  test("command families, terminals, unrelated commands and invalid writes have independent dispatch", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async (body) =>
      body.command === "terminal_write" && body.args.data === "held" ? held.promise : delivered(),
    );
    const write = client.invoke("terminal_write", { sessionId: "same", data: "held" });
    for (const [command, args] of [
      ["local_terminal_write", { sessionId: "same", data: "local" }],
      ["terminal_write", { sessionId: "other", data: "other" }],
      ["greet", { sessionId: "same" }],
      ["terminal_write", { sessionId: 1, data: "x" }],
      ["terminal_write", { sessionId: "same", data: 1 }],
      ["local_terminal_write", { sessionId: false, data: "x" }],
      ["local_terminal_write", { sessionId: "same", data: null }],
      ["terminal_resize", { sessionId: 1 }],
      ["close_local_terminal_session", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      await client.invoke(command, args);
      expect(bodies.at(-1)).toEqual({ command, args });
    }
    held.resolve(delivered());
    await write;
  });

  for (const [writeCommand, resizeCommand, closeCommand, startCommand] of families) {
    for (const lifecycle of [resizeCommand, closeCommand, startCommand]) {
      test(`${lifecycle} waits for accepted input and fences writes across the operation`, async () => {
        const first = deferred<Response>();
        const suffix = deferred<Response>();
        const barrier = deferred<Response>();
        const { client, bodies } = fixture(async (body) =>
          body.args.data === "a"
            ? first.promise
            : body.args.data === "b"
              ? suffix.promise
              : body.command === lifecycle
                ? barrier.promise
                : delivered(),
        );
        const a = client.invoke(writeCommand, { sessionId: "ordered", data: "a" });
        const b = client.invoke(writeCommand, { sessionId: "ordered", data: "b" });
        const operation = client.invoke(lifecycle, { sessionId: "ordered", cols: 90, rows: 30 });
        const later = outcome(client.invoke(writeCommand, { sessionId: "ordered", data: "later" }));
        expect(bodies.map((body) => body.args.data)).toEqual(["a"]);
        first.resolve(delivered());
        await Bun.sleep(0);
        expect(bodies.map((body) => body.args.data)).toEqual(["a", "b"]);
        suffix.resolve(delivered());
        await Bun.sleep(0);
        expect(bodies.map((body) => body.command)).toEqual([writeCommand, writeCommand, lifecycle]);
        barrier.resolve(delivered());
        await Promise.all([a, b, operation]);
        if (lifecycle === closeCommand) {
          expect(await later).toBeInstanceOf(Error);
          await expect(
            client.invoke(writeCommand, { sessionId: "ordered", data: "stale" }),
          ).rejects.toThrow("closed");
          await client.invoke(startCommand, { sessionId: "ordered" });
          await client.invoke(writeCommand, { sessionId: "ordered", data: "fresh" });
          expect(bodies.map((body) => body.args.data).filter(Boolean)).toEqual(["a", "b", "fresh"]);
        } else {
          expect(await later).toEqual({ delivered: true });
          expect(bodies.at(-1)!.args.data).toBe("later");
        }
      });
    }

    test(`${writeCommand} stays fenced after applied input loses its response, even after resize or failed start`, async () => {
      const lost = deferred<Response>();
      let failStart = true;
      const applied: unknown[] = [];
      const { client, bodies } = fixture(async (body) => {
        if (body.command === writeCommand) {
          applied.push(body.args.data);
          if (applied.length === 1) return lost.promise;
        }
        if (body.command === startCommand && failStart) throw new Error("restart failed");
        return delivered();
      });
      const a = outcome(
        client.invoke(writeCommand, { sessionId: "lost", data: "dangerous-prefix" }),
      );
      const b = outcome(client.invoke(writeCommand, { sessionId: "lost", data: "suffix" }));
      lost.reject(new Error("response lost"));
      expect(await a).toBeInstanceOf(Error);
      expect(await b).toBeInstanceOf(Error);
      await expect(client.invoke(writeCommand, { sessionId: "lost", data: "\r" })).rejects.toThrow(
        "response lost",
      );
      await client.invoke(resizeCommand, { sessionId: "lost", cols: 80, rows: 24 });
      await expect(client.invoke(writeCommand, { sessionId: "lost", data: "\r" })).rejects.toThrow(
        "response lost",
      );
      await expect(client.invoke(startCommand, { sessionId: "lost" })).rejects.toThrow(
        "restart failed",
      );
      await expect(client.invoke(writeCommand, { sessionId: "lost", data: "\r" })).rejects.toThrow(
        "restart failed",
      );
      failStart = false;
      await client.invoke(startCommand, { sessionId: "lost" });
      await client.invoke(writeCommand, { sessionId: "lost", data: "fresh" });
      expect(applied).toEqual(["dangerous-prefix", "fresh"]);
      expect(bodies.filter((body) => body.command === writeCommand)).toHaveLength(2);
    });
  }

  for (const [writeCommand, , closeCommand, startCommand] of families) {
    test(`${closeCommand} and restart remain usable behind a timed-out write and ignore its late response`, async () => {
      const lost = deferred<Response>();
      const { client, bodies } = fixture(
        async (body) => (body.args.data === "prefix" ? lost.promise : delivered()),
        40,
      );
      const active = outcome(client.invoke(writeCommand, { sessionId: "recover", data: "prefix" }));
      const suffix = outcome(client.invoke(writeCommand, { sessionId: "recover", data: "stale" }));
      const close = client.invoke(closeCommand, { sessionId: "recover" });
      const start = client.invoke(startCommand, { sessionId: "recover" });
      expect(String(await active)).toContain("timed out");
      expect(String(await suffix)).toContain("timed out");
      await Promise.all([close, start]);
      await client.invoke(writeCommand, { sessionId: "recover", data: "fresh" });
      lost.resolve(delivered());
      await Bun.sleep(0);
      await client.invoke(writeCommand, { sessionId: "recover", data: "later" });
      expect(bodies.map((body) => [body.command, body.args.data])).toEqual([
        [writeCommand, "prefix"],
        [closeCommand, undefined],
        [startCommand, undefined],
        [writeCommand, "fresh"],
        [writeCommand, "later"],
      ]);
    });
  }

  test("even a non-Error fetch rejection fences later input", async () => {
    const { client, bodies } = fixture(async () => {
      throw null;
    });
    expect(
      await outcome(client.invoke("terminal_write", { sessionId: "null-error", data: "a" })),
    ).toBeNull();
    expect(
      await outcome(client.invoke("terminal_write", { sessionId: "null-error", data: "later" })),
    ).toBeNull();
    expect(bodies).toHaveLength(1);
  });

  test("a start before a queued close cannot reopen admission across that close", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () =>
      bodies.length === 1 ? held.promise : delivered(),
    );
    const start = client.invoke("start_terminal_session", { sessionId: "closed" });
    const close = client.invoke("detach_terminal", { sessionId: "closed" });
    held.resolve(delivered());
    await start;
    await expect(
      client.invoke("terminal_write", { sessionId: "closed", data: "stale" }),
    ).rejects.toThrow("closed");
    await close;
    expect(bodies.map((body) => body.command)).toEqual([
      "start_terminal_session",
      "detach_terminal",
    ]);
  });

  for (const failure of ["undelivered", "network", "malformed"] as const) {
    test(`${failure} rejects the queued suffix and keeps the failed fence`, async () => {
      const held = deferred<Response>();
      const { client, bodies } = fixture(async () => held.promise);
      const first = outcome(client.invoke("terminal_write", { sessionId: "failed", data: "a" }));
      const suffix = outcome(client.invoke("terminal_write", { sessionId: "failed", data: "b" }));
      if (failure === "network") held.reject(new Error("network failed"));
      else
        held.resolve(
          failure === "undelivered"
            ? Response.json({ result: { delivered: false } })
            : new Response("invalid json"),
        );
      expect(await first).toBeInstanceOf(Error);
      expect(await suffix).toBeInstanceOf(Error);
      await expect(
        client.invoke("terminal_write", { sessionId: "failed", data: "later" }),
      ).rejects.toThrow();
      expect(bodies).toHaveLength(1);
    });
  }

  for (const stall of ["fetch", "body"] as const) {
    test(`deadline releases a never-settling ${stall}, aborts and rejects every suffix`, async () => {
      const stuck = deferred<Response>();
      let signal: AbortSignal | null | undefined;
      const { client, bodies } = fixture(async (_body, inputSignal) => {
        signal = inputSignal;
        if (stall === "fetch") return stuck.promise;
        return { ok: true, json: () => new Promise(() => {}) } as Response;
      }, 40);
      const first = outcome(client.invoke("terminal_write", { sessionId: "hung", data: "a" }));
      const suffix = outcome(client.invoke("terminal_write", { sessionId: "hung", data: "b" }));
      expect(String(await first)).toContain("timed out");
      expect(String(await suffix)).toContain("timed out");
      expect(signal!.aborted).toBe(true);
      expect(queueSnapshot(client)).toEqual([{ bytes: 0, operations: 0, waiters: 0, pending: 0 }]);
      await expect(
        client.invoke("terminal_write", { sessionId: "hung", data: "later" }),
      ).rejects.toThrow("timed out");
      stuck.resolve(delivered());
      await Bun.sleep(0);
      expect(bodies).toHaveLength(1);
    });
  }

  test("aggregate byte overflow rejects promptly and fences input without retaining the queued suffix", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () => held.promise);
    const active = outcome(
      client.invoke("terminal_write", {
        sessionId: "bytes",
        data: "a".repeat(MAX_TERMINAL_WRITE_BATCH_BYTES),
      }),
    );
    const queued = outcome(
      client.invoke("terminal_write", {
        sessionId: "bytes",
        data: "é".repeat((MAX_TERMINAL_QUEUED_BYTES - MAX_TERMINAL_WRITE_BATCH_BYTES) / 2),
      }),
    );
    expect(queueSnapshot(client)[0]!.bytes).toBe(MAX_TERMINAL_QUEUED_BYTES);
    await expect(
      client.invoke("terminal_write", { sessionId: "bytes", data: "x" }),
    ).rejects.toThrow("queue limit");
    expect(await queued).toBeInstanceOf(Error);
    expect(queueSnapshot(client)).toEqual([
      { bytes: MAX_TERMINAL_WRITE_BATCH_BYTES, operations: 1, waiters: 1, pending: 0 },
    ]);
    await expect(
      client.invoke("terminal_write", { sessionId: "bytes", data: "\r" }),
    ).rejects.toThrow("queue limit");
    held.resolve(delivered());
    await active;
    expect(queueSnapshot(client)).toEqual([{ bytes: 0, operations: 0, waiters: 0, pending: 0 }]);
    expect(bodies).toHaveLength(1);
  });

  test("a single input larger than the byte ceiling is rejected before dispatch", async () => {
    const { client, bodies } = fixture();
    await expect(
      client.invoke("local_terminal_write", {
        sessionId: "large",
        data: "x".repeat(MAX_TERMINAL_QUEUED_BYTES + 1),
      }),
    ).rejects.toThrow("queue limit");
    expect(bodies).toHaveLength(0);
  });

  test("waiter count bounds tiny and empty writes as well as bytes", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () => held.promise);
    const writes = Array.from({ length: MAX_TERMINAL_QUEUE_WAITERS }, (_, i) =>
      outcome(client.invoke("terminal_write", { sessionId: "count", data: i === 0 ? "a" : "" })),
    );
    await expect(client.invoke("terminal_write", { sessionId: "count", data: "" })).rejects.toThrow(
      "queue limit",
    );
    held.resolve(delivered());
    await Promise.all(writes);
    expect(bodies).toHaveLength(1);
  });

  test("lifecycle operation count is bounded and allows recovery once the queue drains", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () =>
      bodies.length === 1 ? held.promise : delivered(),
    );
    const operations = Array.from({ length: MAX_TERMINAL_QUEUE_OPERATIONS }, () =>
      client.invoke("terminal_resize", { sessionId: "operations", cols: 80, rows: 24 }),
    );
    await expect(client.invoke("detach_terminal", { sessionId: "operations" })).rejects.toThrow(
      "lifecycle queue limit",
    );
    // Write admission at a full operation queue must also reject and fence.
    await expect(
      client.invoke("terminal_write", { sessionId: "operations", data: "x" }),
    ).rejects.toThrow("operation limit");
    held.resolve(delivered());
    await Promise.all(operations);
    await client.invoke("start_terminal_session", { sessionId: "operations" });
    await client.invoke("terminal_write", { sessionId: "operations", data: "fresh" });
    expect(bodies.at(-1)!.args.data).toBe("fresh");
  });

  test("terminal fence capacity is bounded without evicting closed sessions", async () => {
    const { client, bodies } = fixture();
    for (let i = 0; i < MAX_TERMINAL_QUEUES; i++)
      await client.invoke("detach_terminal", { sessionId: String(i) });
    await expect(client.invoke("terminal_write", { sessionId: "new", data: "x" })).rejects.toThrow(
      "capacity",
    );
    await expect(
      client.invoke("terminal_write", { sessionId: "0", data: "stale" }),
    ).rejects.toThrow("closed");
    await client.invoke("start_terminal_session", { sessionId: "0" });
    await client.invoke("terminal_write", { sessionId: "new", data: "fresh" });
    expect(bodies.at(-1)!.args.data).toBe("fresh");
  });
});
