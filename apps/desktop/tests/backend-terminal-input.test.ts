import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
  TERMINAL_HTTP_INPUT_MAX_PENDING_INPUTS,
} from "@orkestrator/protocol/terminal-input-batcher";
import {
  LOCAL_TERMINAL_INPUT_RESUME_COMMAND,
  TERMINAL_INPUT_RESUME_COMMAND,
  TERMINAL_MAX_PENDING_LIFECYCLE_OPERATIONS,
} from "@orkestrator/protocol/terminal-input-sequencer";
import {
  terminalInputContractScenarios,
  type TerminalContractAdapter,
} from "@orkestrator/protocol/terminal-input-contract-fixtures";
import { BackendHttpClient } from "../electron/backend-process";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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
  const bodies: Body[] = [];
  globalThis.fetch = Object.assign(
    mock(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return send ? send(body, init?.signal) : delivered();
    }),
    { preconnect: originalFetch.preconnect },
  );
  return {
    client: new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
      terminalSendTimeoutMs: timeout,
    }),
    bodies,
  };
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

const desktopAdapter: TerminalContractAdapter = {
  create(backend, options = {}) {
    globalThis.fetch = Object.assign(
      mock(async (_url: unknown, init?: RequestInit) => {
        const reply = await backend(
          JSON.parse(String(init?.body)) as Body,
          (init?.signal as AbortSignal | null | undefined) ?? null,
        );
        return "result" in reply
          ? Response.json({ result: reply.result })
          : Response.json({ error: reply.error }, { status: reply.status });
      }),
      { preconnect: originalFetch.preconnect },
    );
    return new BackendHttpClient("http://127.0.0.1:34121/", "fixture-token", {
      terminalSendTimeoutMs: options.sendTimeoutMs,
    });
  },
};

describe("Electron terminal input contract", () => {
  for (const scenario of terminalInputContractScenarios) {
    test(scenario.name, async () => {
      const { actual, expected } = await scenario.run(desktopAdapter);
      expect(actual).toEqual(expected);
    });
  }
});

describe("Electron terminal HTTP input", () => {
  test("splits a single oversized batch at UTF-8 boundaries and resolves only after all chunks", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let call = 0;
    const { client, bodies } = fixture(async () => (++call === 1 ? first.promise : second.promise));
    const input = "a".repeat(TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES - 1) + "😀é\ud800";
    let settled = false;
    const write = client.invoke("terminal_write", { sessionId: "utf8", data: input }).then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(bodies[0]!.args.data).toBe("a".repeat(TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES - 1));
    first.resolve(delivered());
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(bodies[1]!.args.data).toBe("😀é\ud800");
    expect(bodies.map((body) => String(body.args.data)).join("")).toBe(input);
    expect(
      bodies.every(
        (body) =>
          Buffer.byteLength(String(body.args.data), "utf8") <= TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
      ),
    ).toBe(true);
    second.resolve(delivered());
    await write;
  });

  test("coalesces input typed during a round trip into one request", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () =>
      bodies.length === 1 ? held.promise : delivered(),
    );
    const active = client.invoke("terminal_write", { sessionId: "typing", data: "active" });
    await Bun.sleep(0);
    // Typed across several timer turns while the first request is in flight.
    const typed: Array<Promise<unknown>> = [];
    for (const data of ["l", "s", " ", "-", "l", "a"]) {
      typed.push(client.invoke("terminal_write", { sessionId: "typing", data }));
      await Bun.sleep(2);
    }
    held.resolve(delivered());
    await Promise.all([active, ...typed]);
    expect(bodies.map((body) => body.args.data)).toEqual(["active", "ls -la"]);
  });

  for (const [writeCommand, resizeCommand, , startCommand] of families) {
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
      await Bun.sleep(0);
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

    test(`${resizeCommand} whose response is lost fences ${writeCommand}`, async () => {
      const { client, bodies } = fixture(async (body) => {
        if (body.command === resizeCommand) throw new Error("resize lost");
        return delivered();
      });
      await expect(
        client.invoke(resizeCommand, { sessionId: "uncertain", cols: 80, rows: 24 }),
      ).rejects.toThrow("resize lost");
      await expect(
        client.invoke(writeCommand, { sessionId: "uncertain", data: "x" }),
      ).rejects.toThrow("resize lost");
      expect(bodies.map((body) => body.command)).toEqual([resizeCommand]);
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
      await Bun.sleep(0);
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

  for (const [writeCommand, resumeCommand] of [
    ["terminal_write", TERMINAL_INPUT_RESUME_COMMAND],
    ["local_terminal_write", LOCAL_TERMINAL_INPUT_RESUME_COMMAND],
  ] as const) {
    test(`${resumeCommand} re-arms ${writeCommand} without an HTTP request`, async () => {
      let failWrites = true;
      const { client, bodies } = fixture(async () => {
        if (failWrites) throw new Error("response lost");
        return delivered();
      });
      await expect(client.invoke(writeCommand, { sessionId: "resume", data: "a" })).rejects.toThrow(
        "response lost",
      );
      failWrites = false;
      expect(await client.invoke(resumeCommand, { sessionId: "resume" })).toEqual({
        resumed: true,
      });
      await client.invoke(writeCommand, { sessionId: "resume", data: "b" });
      expect(bodies.map((body) => [body.command, body.args.data])).toEqual([
        [writeCommand, "a"],
        [writeCommand, "b"],
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
    await Bun.sleep(0);
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

  test("pending input count is bounded and overflow fences the terminal", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () => held.promise);
    const writes = Array.from({ length: TERMINAL_HTTP_INPUT_MAX_PENDING_INPUTS }, () =>
      outcome(client.invoke("terminal_write", { sessionId: "count", data: "a" })),
    );
    await expect(
      client.invoke("terminal_write", { sessionId: "count", data: "b" }),
    ).rejects.toThrow("queue limit");
    // Overflow fails the queue closed rather than dropping one input mid-stream.
    for (const result of await Promise.all(writes)) expect(result).toBeInstanceOf(Error);
    held.resolve(delivered());
    await expect(
      client.invoke("terminal_write", { sessionId: "count", data: "c" }),
    ).rejects.toThrow("queue limit");
    expect(bodies.length).toBeLessThanOrEqual(1);
  });

  test("lifecycle operation count is bounded and allows recovery once the queue drains", async () => {
    const held = deferred<Response>();
    const { client, bodies } = fixture(async () =>
      bodies.length === 1 ? held.promise : delivered(),
    );
    const operations = Array.from({ length: TERMINAL_MAX_PENDING_LIFECYCLE_OPERATIONS }, () =>
      client.invoke("terminal_resize", { sessionId: "operations", cols: 80, rows: 24 }),
    );
    await expect(client.invoke("detach_terminal", { sessionId: "operations" })).rejects.toThrow(
      "lifecycle queue limit",
    );
    await Bun.sleep(0);
    held.resolve(delivered());
    await Promise.all(operations);
    await client.invoke("terminal_write", { sessionId: "operations", data: "fresh" });
    expect(bodies.at(-1)!.args.data).toBe("fresh");
  });
});

describe("route changes", () => {
  test("OP-03: a route change keeps the ambiguous-input fence; no keystroke is replayed", async () => {
    const urls: string[] = [];
    let failFirst = true;
    globalThis.fetch = Object.assign(
      mock(async (url: unknown, init?: RequestInit) => {
        urls.push(new URL(String(url)).origin);
        const body = JSON.parse(String(init?.body)) as Body;
        if (body.command === "terminal_write" && failFirst) {
          failFirst = false;
          throw new TypeError("connection reset");
        }
        return delivered();
      }),
      { preconnect: originalFetch.preconnect },
    );
    const client = new BackendHttpClient("http://127.0.0.1:41001/", "fixture-token");
    const lost = await outcome(
      client.invoke("terminal_write", { sessionId: "route", data: "rm -rf build\r" }),
    );
    expect(lost).toBeInstanceOf(Error);
    // The tunnel moved to another local port (same backend, same generation).
    client.retarget("http://127.0.0.1:41002/", "fixture-token", { preserveCursor: true });
    const after = await outcome(
      client.invoke("terminal_write", { sessionId: "route", data: "ls\r" }),
    );
    // Still fenced: the uncertain write is neither resent nor overtaken.
    expect(after).toBeInstanceOf(Error);
    expect(urls).toEqual(["http://127.0.0.1:41001"]);
  });
});
