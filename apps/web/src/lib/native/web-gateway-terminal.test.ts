import { describe, expect, mock, test } from "bun:test";
import { TERMINAL_TRANSPORT_STORAGE_KEY } from "./web-gateway";
import { TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES } from "@orkestrator/protocol/terminal-input-batcher";
import { TERMINAL_INPUT_RESUME_COMMAND } from "@orkestrator/protocol/terminal-input-sequencer";
import {
  type decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
} from "@orkestrator/protocol/terminal-websocket";
import {
  createBrowserGatewayApi,
  installBrowserGatewayApi,
  originalSetTimeout,
  type TestGatewayWindow,
  EVENT_SOURCE_CLOSED,
  MockEventSource,
  MockWebSocket,
  sentControlFrames,
  decodeSentBinaryFrame,
  openTerminalSocket,
  subscribeTerminalSocket,
  waitForCondition,
  useGatewayTestGlobals,
} from "./web-gateway.test-support";

import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";

/** Terminal input ordering over HTTP and the opt-in terminal WebSocket. */
useGatewayTestGlobals();

describe("web gateway terminal input and WebSocket", () => {
  test("micro-batches HTTP terminal typing and flushes Enter in order", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(
        JSON.parse(String(init?.body)) as {
          command: string;
          args: Record<string, unknown>;
        },
      );
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();
    const writes = ["h", "i", "\r"].map((data) =>
      api.invoke("terminal_write", {
        sessionId: "session-1",
        data,
      }),
    );
    await expect(Promise.all(writes)).resolves.toEqual([
      { delivered: true },
      { delivered: true },
      { delivered: true },
    ]);

    expect(invokes).toEqual([
      {
        command: "terminal_write",
        args: { sessionId: "session-1", data: "hi\r" },
      },
    ]);
  });

  test("rejects every batched HTTP input waiter when the backend refuses delivery", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ result: { delivered: false } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    const writes = [
      ...["n", "o", "\r"].map((data) =>
        api.invoke("terminal_write", { sessionId: "dead-http", data }),
      ),
      api.invoke("local_terminal_write", { sessionId: "dead-local-http", data: "pwd\r" }),
    ];
    const results = await Promise.allSettled(writes);

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContain(
        "Terminal session is not running",
      );
    }
  });

  test("batches local-terminal input and keeps malformed invokes on the immediate path", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(
        JSON.parse(String(init?.body)) as {
          command: string;
          args: Record<string, unknown>;
        },
      );
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();
    await Promise.all(
      ["o", "k", "\r"].map((data) =>
        api.invoke("local_terminal_write", {
          sessionId: "local-1",
          data,
        }),
      ),
    );
    await api.invoke("terminal_write", { sessionId: 42, data: "x" });
    await api.invoke("terminal_write", { sessionId: "empty", data: "" });

    expect(invokes).toEqual([
      {
        command: "local_terminal_write",
        args: { sessionId: "local-1", data: "ok\r" },
      },
      {
        command: "terminal_write",
        args: { sessionId: 42, data: "x" },
      },
    ]);
  });

  test("splits large Unicode-safe terminal input into bounded ordered requests", async () => {
    const chunks: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { args: { data: string } };
      chunks.push(body.args.data);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const input = `${"x".repeat(TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES - 1)}😀tail`;

    const api = createBrowserGatewayApi();
    await api.invoke("terminal_write", { sessionId: "session-large", data: input });

    const encoder = new TextEncoder();
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) => encoder.encode(chunk).byteLength <= TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
      ),
    ).toBe(true);
    expect(chunks.join("")).toBe(input);
  });

  test("fails a terminal queue closed after HTTP rejection and resets it on session restart", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    let rejectFirstWrite = true;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(body);
      if (body.command === "terminal_write" && rejectFirstWrite) {
        rejectFirstWrite = false;
        return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createBrowserGatewayApi();
    const failed = ["a", "b", "\r"].map((data) =>
      api.invoke("terminal_write", {
        sessionId: "session-recover",
        data,
      }),
    );
    const failedResults = await Promise.allSettled(failed);
    expect(failedResults).toHaveLength(3);
    for (const result of failedResults) {
      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContain(
        "gateway unavailable",
      );
    }
    await expect(
      api.invoke("terminal_write", {
        sessionId: "session-recover",
        data: "blocked",
      }),
    ).rejects.toThrow("gateway unavailable");
    expect(invokes).toHaveLength(1);

    await api.invoke("start_terminal_session", { sessionId: "session-recover" });
    await api.invoke("terminal_write", { sessionId: "session-recover", data: "ok\r" });
    expect(invokes.map(({ command }) => command)).toEqual([
      "terminal_write",
      "start_terminal_session",
      "terminal_write",
    ]);
  });

  test("times out a hung terminal send and does not dispatch its queued suffix", async () => {
    const fetchMock = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputSendTimeoutMs: 5 });

    const prefix = api.invoke("terminal_write", { sessionId: "hung", data: "prefix" });
    const suffix = api.invoke("terminal_write", { sessionId: "hung", data: "suffix" });
    const timeoutResults = await Promise.allSettled([prefix, suffix]);
    for (const result of timeoutResults) {
      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContain("timed out");
    }
    await expect(
      api.invoke("terminal_write", {
        sessionId: "hung",
        data: "later",
      }),
    ).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("flushes accepted terminal input before resize and close lifecycle commands", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(
        JSON.parse(String(init?.body)) as {
          command: string;
          args: Record<string, unknown>;
        },
      );
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

    const scenarios = [
      ["terminal_write", "terminal_resize", "container-resize"],
      ["terminal_write", "detach_terminal", "container-close"],
      ["local_terminal_write", "local_terminal_resize", "local-resize"],
      ["local_terminal_write", "close_local_terminal_session", "local-close"],
    ] as const;
    for (const [writeCommand, lifecycleCommand, sessionId] of scenarios) {
      const write = api.invoke(writeCommand, { sessionId, data: "x" });
      const lifecycle = api.invoke(lifecycleCommand, { sessionId, cols: 100, rows: 30 });
      await Promise.all([write, lifecycle]);
    }
    await api.invoke("start_local_terminal_session", { sessionId: "local-restart" });

    expect(invokes.map(({ command }) => command)).toEqual([
      "terminal_write",
      "terminal_resize",
      "terminal_write",
      "detach_terminal",
      "local_terminal_write",
      "local_terminal_resize",
      "local_terminal_write",
      "close_local_terminal_session",
      "start_local_terminal_session",
    ]);
  });

  test("keeps post-lifecycle input behind resize and rejects it after close", async () => {
    const runScenario = async ({
      writeCommand,
      lifecycleCommand,
      closes,
    }: {
      writeCommand: "terminal_write" | "local_terminal_write";
      lifecycleCommand: "terminal_resize" | "detach_terminal" | "close_local_terminal_session";
      closes: boolean;
    }) => {
      const invokes: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstResponse = new Promise<Response>((resolve) => {
        releaseFirst = () => resolve(new Response(JSON.stringify({}), { status: 200 }));
      });
      globalThis.fetch = mock(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          command: string;
          args: Record<string, unknown>;
        };
        invokes.push(`${body.command}:${String(body.args.data ?? "")}`);
        if (invokes.length === 1) return firstResponse;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch;
      const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

      const first = api.invoke(writeCommand, { sessionId: "ordered", data: "prefix" });
      await waitForCondition(() => invokes.length === 1, "First terminal write did not start");
      const lifecycle = api.invoke(lifecycleCommand, {
        sessionId: "ordered",
        cols: 100,
        rows: 30,
      });
      const later = api.invoke(writeCommand, { sessionId: "ordered", data: "\r" });

      if (closes) {
        await expect(later).rejects.toThrow("closed until the session restarts");
      }
      releaseFirst();
      await Promise.all([first, lifecycle, ...(closes ? [] : [later])]);
      expect(invokes).toEqual(
        closes
          ? [`${writeCommand}:prefix`, `${lifecycleCommand}:`]
          : [`${writeCommand}:prefix`, `${lifecycleCommand}:`, `${writeCommand}:\r`],
      );
    };

    await runScenario({
      writeCommand: "terminal_write",
      lifecycleCommand: "terminal_resize",
      closes: false,
    });
    await runScenario({
      writeCommand: "terminal_write",
      lifecycleCommand: "detach_terminal",
      closes: true,
    });
    await runScenario({
      writeCommand: "local_terminal_write",
      lifecycleCommand: "close_local_terminal_session",
      closes: true,
    });
  });

  test("start aborts active input, resets a closed queue, and gates later writes", async () => {
    const invokes: string[] = [];
    let firstSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(`${body.command}:${String(body.args.data ?? "")}`);
      if (invokes.length === 1) {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

    const active = api.invoke("terminal_write", { sessionId: "restart", data: "active" });
    await waitForCondition(() => invokes.length === 1, "Active terminal write did not start");
    const activeResult = active.catch((error) => error);
    const start = api.invoke("start_terminal_session", { sessionId: "restart" });
    const later = api.invoke("terminal_write", { sessionId: "restart", data: "ok\r" });

    await expect(activeResult).resolves.toEqual(new Error("Terminal HTTP input queue reset"));
    await Promise.all([start, later]);
    expect(firstSignal?.aborted).toBe(true);
    expect(invokes).toEqual([
      "terminal_write:active",
      "start_terminal_session:",
      "terminal_write:ok\r",
    ]);

    await api.invoke("detach_terminal", { sessionId: "restart" });
    await expect(
      api.invoke("terminal_write", { sessionId: "restart", data: "blocked" }),
    ).rejects.toThrow("closed until the session restarts");
    await api.invoke("start_terminal_session", { sessionId: "restart" });
    await expect(
      api.invoke("terminal_write", { sessionId: "restart", data: "fresh\r" }),
    ).resolves.toEqual({ delivered: true });
  });

  test("disposing a replaced gateway aborts in-flight and queued terminal input", async () => {
    let oldSignal: AbortSignal | undefined;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/session")) return new Response(null, { status: 404 });
      oldSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { terminalInputBatchDelayMs: 50 },
    );
    const oldApi = fakeWindow.orkestrator!;
    const active = oldApi.invoke("terminal_write", { sessionId: "old", data: "active" });
    const queued = oldApi.invoke("terminal_write", { sessionId: "old", data: "q" });
    const activeResult = active.catch((error) => error);
    const queuedResult = queued.catch((error) => error);
    await waitForCondition(() => oldSignal !== undefined, "Old terminal write did not start");
    const resizeResult = oldApi
      .invoke("terminal_resize", {
        sessionId: "old",
        cols: 100,
        rows: 30,
      })
      .catch((error) => error);
    const closeResult = oldApi
      .invoke("detach_terminal", { sessionId: "old" })
      .catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );

    expect(fakeWindow.orkestrator).not.toBe(oldApi);
    expect(oldSignal?.aborted).toBe(true);
    await expect(activeResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(queuedResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(resizeResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(closeResult).resolves.toEqual(new Error("Browser gateway replaced"));
    await expect(
      oldApi.invoke("terminal_write", { sessionId: "old", data: "later" }),
    ).rejects.toThrow("Browser gateway replaced");
    expect(
      fetchMock.mock.calls.filter(([input]) => !String(input).includes("/session")),
    ).toHaveLength(1);
  });

  test("keeps a terminal closed when its close never reached the backend, until a start", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(body.command);
      if (body.command === "detach_terminal" && body.args.sessionId === "still-alive") {
        return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.invoke("detach_terminal", { sessionId: "still-alive" })).rejects.toThrow(
      "gateway unavailable",
    );

    // The UI asked for the close, so input stays refused even though the
    // backend terminal may have survived. Resume does not reopen it.
    await expect(
      api.invoke("terminal_write", { sessionId: "still-alive", data: "ls\r" }),
    ).rejects.toThrow("closed until the session restarts");
    await expect(
      api.invoke(TERMINAL_INPUT_RESUME_COMMAND, { sessionId: "still-alive" }),
    ).resolves.toEqual({ resumed: false });
    await expect(
      api.invoke("terminal_write", { sessionId: "still-alive", data: "ls\r" }),
    ).rejects.toThrow("closed until the session restarts");
    expect(invokes).toEqual(["detach_terminal"]);

    // Only a start reopens it.
    await api.invoke("start_terminal_session", { sessionId: "still-alive" });
    await api.invoke("terminal_write", { sessionId: "still-alive", data: "ls\r" });
    expect(invokes).toEqual(["detach_terminal", "start_terminal_session", "terminal_write"]);
  });

  test("keeps a failed terminal fenced after a resize until the user resumes", async () => {
    const invokes: string[] = [];
    let rejectWrites = true;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      invokes.push(body.command);
      if (body.command === "terminal_write" && rejectWrites) {
        return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.invoke("terminal_write", { sessionId: "flaky", data: "a\r" })).rejects.toThrow(
      "gateway unavailable",
    );
    await expect(api.invoke("terminal_write", { sessionId: "flaky", data: "b\r" })).rejects.toThrow(
      "gateway unavailable",
    );

    // Layout changes resize the terminal; that is not evidence of what the
    // lost write delivered, so input stays fenced.
    rejectWrites = false;
    await api.invoke("terminal_resize", { sessionId: "flaky", cols: 100, rows: 30 });
    await expect(api.invoke("terminal_write", { sessionId: "flaky", data: "c\r" })).rejects.toThrow(
      "gateway unavailable",
    );

    // An explicit resume re-arms it, without a request to the backend.
    await expect(
      api.invoke(TERMINAL_INPUT_RESUME_COMMAND, { sessionId: "flaky" }),
    ).resolves.toEqual({ resumed: true });
    await api.invoke("terminal_write", { sessionId: "flaky", data: "d\r" });

    expect(invokes).toEqual(["terminal_write", "terminal_resize", "terminal_write"]);
  });

  test("leaves a failed queue closed when the recovering resize also fails", async () => {
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      return body.command === "start_terminal_session"
        ? new Response(JSON.stringify({}), { status: 200 })
        : new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await expect(api.invoke("terminal_write", { sessionId: "down", data: "a\r" })).rejects.toThrow(
      "gateway unavailable",
    );
    await expect(
      api.invoke("terminal_resize", { sessionId: "down", cols: 80, rows: 24 }),
    ).rejects.toThrow("gateway unavailable");
    await expect(api.invoke("terminal_write", { sessionId: "down", data: "b\r" })).rejects.toThrow(
      "gateway unavailable",
    );
  });

  test("fences a terminal whose start command failed until a start succeeds", async () => {
    const invokes: string[] = [];
    let rejectStart = true;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      if (body.command === "start_terminal_session" && rejectStart) {
        rejectStart = false;
        return new Response(JSON.stringify({ error: "container gone" }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi();

    await api.invoke("detach_terminal", { sessionId: "restart" });
    await expect(api.invoke("start_terminal_session", { sessionId: "restart" })).rejects.toThrow(
      "container gone",
    );

    // After a failed start the shell may not exist, so input carries the start
    // error rather than reaching the backend.
    await expect(
      api.invoke("terminal_write", { sessionId: "restart", data: "no\r" }),
    ).rejects.toThrow("container gone");

    // A successful retry re-arms it.
    await api.invoke("start_terminal_session", { sessionId: "restart" });
    await api.invoke("terminal_write", { sessionId: "restart", data: "ok\r" });
    expect(invokes).toEqual([
      "detach_terminal",
      "start_terminal_session",
      "start_terminal_session",
      "terminal_write",
    ]);
  });

  test("rejects lifecycle commands issued after the gateway was replaced", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      {},
    );
    const oldApi = fakeWindow.orkestrator!;
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );

    for (const [command, args] of [
      ["terminal_resize", { sessionId: "gone", cols: 80, rows: 24 }],
      ["detach_terminal", { sessionId: "gone" }],
      ["start_terminal_session", { sessionId: "gone" }],
    ] as const) {
      await expect(oldApi.invoke(command, args)).rejects.toThrow("Browser gateway replaced");
    }
  });

  test("replaces a gateway this module did not create without disposing it", () => {
    const foreignApi = { invoke: async () => undefined } as unknown as Window["orkestrator"];
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: foreignApi,
      orkestratorGateway: undefined,
    };

    expect(() =>
      installBrowserGatewayApi(
        fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
        { replaceExisting: true },
      ),
    ).not.toThrow();
    expect(fakeWindow.orkestrator).not.toBe(foreignApi);
  });

  test("routes a lifecycle command with no usable session id straight through", async () => {
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (_input, init) => {
      invokes.push(
        JSON.parse(String(init?.body)) as {
          command: string;
          args: Record<string, unknown>;
        },
      );
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({ terminalInputBatchDelayMs: 50 });

    // Without a string session id there is no queue to order against, so the
    // command must not be silently dropped or attached to another terminal.
    await api.invoke("terminal_resize", { cols: 80, rows: 24 });
    await api.invoke("detach_terminal", { sessionId: 42 });
    expect(invokes.map(({ command }) => command)).toEqual(["terminal_resize", "detach_terminal"]);

    // The absent session id did not close any real terminal's queue.
    await api.invoke("terminal_write", { sessionId: "42", data: "x\r" });
    expect(invokes.map(({ command }) => command)).toEqual([
      "terminal_resize",
      "detach_terminal",
      "terminal_write",
    ]);
  });

  test("wires the configured batch and queue byte limits into the batcher", async () => {
    const sent: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { args: { data: string } };
      sent.push(body.args.data);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      terminalInputMaxBatchBytes: 4,
      terminalInputMaxQueuedBytes: 8,
    });

    await api.invoke("terminal_write", { sessionId: "bounded", data: "abcdefgh" });
    expect(sent).toEqual(["abcd", "efgh"]);

    await expect(
      api.invoke("terminal_write", { sessionId: "bounded", data: "too-long-to-fit" }),
    ).rejects.toThrow("exceeds the 8-byte terminal queue limit");
  });

  test("batches direct terminal writes with bearer authentication", async () => {
    const requests: Array<{ url: string; authorization: string | null; data: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { args: { data: string } };
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        data: body.args.data,
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
    });

    await Promise.all(
      ["d", "i", "r", "\r"].map((data) =>
        api.invoke("terminal_write", {
          sessionId: "direct-terminal",
          data,
        }),
      ),
    );

    expect(requests).toEqual([
      {
        url: "https://workstation.tailnet.ts.net/__orkestrator/invoke",
        authorization: "Bearer direct-token-123456",
        data: "dir\r",
      },
    ]);
  });

  test("opts into the terminal WebSocket explicitly or from storage and forwards URL and token", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    const createSocket = (url: string, protocols: string | string[]) =>
      new MockWebSocket(url, protocols) as unknown as WebSocket;
    const direct = createBrowserGatewayApi({
      baseUrl: "https://workstation.tailnet.ts.net",
      token: "direct-token-123456",
      terminalTransport: "websocket",
      terminalWebSocketFactory: createSocket,
    });

    const stopDirect = direct.listen("terminal-output-direct", () => undefined);
    const directSocket = MockWebSocket.instances[0];
    if (!directSocket) throw new Error("Direct terminal socket was not created");
    expect(String(directSocket.url)).toBe(
      "wss://workstation.tailnet.ts.net/__orkestrator/terminal",
    );
    expect(directSocket.protocols).toEqual([
      "orkestrator-terminal.v1.input-results",
      "orkestrator-terminal.v1",
    ]);
    directSocket.open();
    expect(sentControlFrames(directSocket)[0]).toEqual({
      type: "authenticate",
      version: 1,
      token: "direct-token-123456",
    });
    stopDirect();

    localStorage.setItem(TERMINAL_TRANSPORT_STORAGE_KEY, "websocket");
    const stored = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalWebSocketFactory: createSocket,
    });
    const stopStored = stored.listen("terminal-output-stored", () => undefined);
    expect(MockWebSocket.instances).toHaveLength(2);
    stopStored();

    const forcedHttp = createBrowserGatewayApi({
      terminalTransport: "http-sse",
      terminalWebSocketFactory: createSocket,
    });
    const stopHttp = forcedHttp.listen("terminal-output-http", () => undefined);
    await Promise.resolve();
    expect(MockWebSocket.instances).toHaveLength(2);
    stopHttp();
  });

  test("keeps fallback per channel until its WebSocket snapshot succeeds", async () => {
    const createSocket = (url: string, protocols: string | string[]) =>
      new MockWebSocket(url, protocols) as unknown as WebSocket;
    const fallbackSignals = new Map<string, AbortSignal>();
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        // One shared stream carries every terminal; track each event's newest.
        const events = new URL(String(input)).searchParams.get("includeEvents")?.split(",") ?? [];
        for (const event of events) if (init?.signal) fallbackSignals.set(event, init.signal);
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      expect(body.command).toBe("get_terminal_output_snapshot");
      return new Response(
        JSON.stringify({
          result: { generation: 1, revision: 0, data: "" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: createSocket,
    });

    const stopFirst = api.listen("terminal-output-session-1", () => undefined);
    const stopSecond = api.listen("terminal-output-session-2", () => undefined);
    await waitForCondition(() => fallbackSignals.size === 2);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "session-1");
    expect(fallbackSignals.get("terminal-output-session-1")?.aborted).toBe(false);
    expect(fallbackSignals.get("terminal-output-session-2")?.aborted).toBe(false);

    await api.invoke("get_terminal_output_snapshot", { sessionId: "session-1" });
    await api.invoke("terminal_snapshot_applied", {
      sessionId: "session-1",
      generation: 1,
      revision: 0,
    });
    await waitForCondition(
      () => fallbackSignals.get("terminal-output-session-1")?.aborted === true,
      "Snapshot completion did not retire fallback",
    );
    expect(fallbackSignals.get("terminal-output-session-2")?.aborted).toBe(false);
    stopFirst();
    stopSecond();
  });

  test.each(["direct", "same-origin"] as const)(
    "recovers multiple terminals through %s SSE after backpressure and outage without reordering input",
    async (transport) => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };
      const previousUrl = window.location.href;
      happyWindow.happyDOM.setURL("http://localhost:1420/");
      const socketRetry = installControlledTimeout(1_234);
      const streamRetry = installControlledTimeout(4_321, { maxPending: 2 });
      type DirectStream = {
        event: string;
        signal: AbortSignal;
        controller: ReadableStreamDefaultController<Uint8Array>;
      };
      const directStreams: DirectStream[] = [];
      const snapshots = new Map([
        ["a", { generation: 1, revision: 4, data: "snapshot-a" }],
        ["b", { generation: 2, revision: 3, data: "snapshot-b" }],
      ]);
      const httpWrites: Array<{ sessionId: string; data: string }> = [];
      let releaseHttp: (() => void) | undefined;
      globalThis.fetch = mock(async (input, init) => {
        if (String(input).includes("/__orkestrator/events?")) {
          const event = new URL(String(input)).searchParams.get("includeEvents")!;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                directStreams.push({ event, controller, signal: init!.signal! });
              },
            }),
            { status: 200 },
          );
        }
        const { command, args } = JSON.parse(String(init?.body));
        if (command === "get_terminal_output_snapshot") {
          return new Response(JSON.stringify({ result: snapshots.get(args.sessionId) }), {
            status: 200,
          });
        }
        expect(command).toBe("terminal_write");
        httpWrites.push(args);
        if (args.sessionId === "a")
          await new Promise<void>((resolve) => {
            releaseHttp = resolve;
          });
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }) as unknown as typeof fetch;
      const api = createBrowserGatewayApi({
        ...(transport === "direct" ? { baseUrl: "http://localhost:4319" } : {}),
        terminalTransport: "websocket",
        terminalWebSocketReconnectDelayMs: 1_234,
        eventReconnectDelayMs: 4_321,
        eventReconnectRandom: () => 1,
        terminalWebSocketFactory: (url, protocols) =>
          new MockWebSocket(url, protocols) as unknown as WebSocket,
      });
      type RecoveryPayload = {
        generation?: number;
        revision?: number;
        bytes?: Uint8Array;
        bytesBase64?: string;
        desynced?: boolean;
      };
      const payloads = { a: [] as RecoveryPayload[], b: [] as RecoveryPayload[] };
      const stops = (["a", "b"] as const).map((session) =>
        api.listen<RecoveryPayload>(`terminal-output-${session}`, (payload) => {
          payloads[session].push(payload);
        }),
      );
      const browserStream = () => MockEventSource.instances.at(-1)!;
      const activeFallbacks = () =>
        transport === "direct"
          ? directStreams.filter((stream) => !stream.signal.aborted).length
          : MockEventSource.instances.filter((source) => source.readyState !== EVENT_SOURCE_CLOSED)
              .length;
      const output = (
        socket: MockWebSocket,
        channelId: number,
        generation: number,
        revision: number,
        text: string,
      ) =>
        socket.receive(
          encodeTerminalBinaryFrame({
            type: TERMINAL_BINARY_FRAME_TYPE.output,
            channelId,
            generation,
            revision,
            bytes: new TextEncoder().encode(text),
          }),
        );
      const applySnapshot = async (sessionId: string) => {
        const snapshot = await api.invoke<{ generation: number; revision: number }>(
          "get_terminal_output_snapshot",
          { sessionId },
        );
        await api.invoke("terminal_snapshot_applied", { sessionId, ...snapshot });
      };
      const binaries = (socket: MockWebSocket) =>
        socket.sent
          .filter((frame) => typeof frame !== "string")
          .map((frame) => decodeSentBinaryFrame(frame as ArrayBufferLike | ArrayBufferView));
      const acknowledge = (
        socket: MockWebSocket,
        frame: ReturnType<typeof decodeTerminalBinaryFrame>,
      ) =>
        socket.receive(
          JSON.stringify({
            type: "operation-result",
            operation: "input",
            channelId: frame.channelId,
            operationId: frame.revision,
            ok: true,
          }),
        );
      try {
        await waitForCondition(
          // Both transports carry every terminal on one shared stream.
          () => activeFallbacks() === 1,
          "Initial fallback stream did not start",
        );
        if (transport === "same-origin") browserStream().open();
        const first = MockWebSocket.instances[0]!;
        openTerminalSocket(first);
        subscribeTerminalSocket(first, "a", "current", 1);
        subscribeTerminalSocket(first, "b", "current", 2);
        await waitForCondition(
          () => activeFallbacks() === 0,
          "Healthy channels did not retire their fallbacks",
        );
        output(first, 1, 1, 1, "a-one");
        output(first, 2, 1, 1, "b-one");
        await waitForCondition(
          () =>
            payloads.a.some((p) => p.revision === 1) && payloads.b.some((p) => p.revision === 1),
          "Initial output did not reach both terminals",
        );

        // Server output backpressure desynchronizes only its slow channel.
        first.receive(
          JSON.stringify({
            type: "desync",
            channelId: 1,
            generation: 1,
            revision: 4,
            reason: "slow-consumer",
          }),
        );
        await waitForCondition(
          () => activeFallbacks() === 1,
          "Slow channel did not start fallback",
        );
        if (transport === "same-origin") browserStream().open();
        output(first, 2, 1, 2, "b-two");
        await waitForCondition(
          () => payloads.b.some((p) => p.revision === 2),
          "Slow channel blocked its healthy sibling",
        );
        expect(payloads.a.at(-1)).toMatchObject({ desynced: true });
        await applySnapshot("a");
        await waitForCondition(
          () =>
            sentControlFrames(first).filter((f) => f.type === "subscribe" && f.sessionId === "a")
              .length === 2,
          "Snapshot did not resubscribe the slow channel",
        );
        expect(
          sentControlFrames(first).findLast((f) => f.type === "subscribe" && f.sessionId === "a"),
        ).toMatchObject({ knownGeneration: 1, knownRevision: 4 });
        subscribeTerminalSocket(first, "a", "current", 3, 1, 4);
        await waitForCondition(
          () => activeFallbacks() === 0,
          "Recovered channel did not retire fallback",
        );

        first.close(1006, "backend outage");
        expect(socketRetry.pendingCount()).toBe(1);
        await waitForCondition(
          () => activeFallbacks() === 1,
          "Socket outage did not activate the shared fallback",
        );
        if (transport === "same-origin") browserStream().open();
        const desyncCounts = {
          a: payloads.a.filter((p) => p.desynced).length,
          b: payloads.b.filter((p) => p.desynced).length,
        };
        // The fallback itself drops under load and reopens; every terminal
        // receives a snapshot hint, independently of the socket retry.
        if (transport === "direct") {
          for (const stream of directStreams.filter((s) => !s.signal.aborted))
            stream.controller.close();
        } else browserStream().fail();
        await waitForCondition(
          () => streamRetry.pendingCount() === 1,
          "The failed fallback did not arm its retry",
        );
        const previousStreamCount = directStreams.length;
        const previousBrowserStreamCount = MockEventSource.instances.length;
        streamRetry.advance();
        if (transport === "direct")
          await waitForCondition(
            () => directStreams.length === previousStreamCount + 1,
            "Direct fallback did not reopen",
          );
        else {
          await waitForCondition(
            () => MockEventSource.instances.length === previousBrowserStreamCount + 1,
            "Browser fallback did not reopen",
          );
          browserStream().open();
        }
        await waitForCondition(
          () =>
            (["a", "b"] as const).every(
              (id) => payloads[id].filter((p) => p.desynced).length > desyncCounts[id],
            ),
          "Reopened fallbacks did not announce desync to both terminals",
        );

        // Output continues through each fallback while the socket is down.
        for (const session of ["a", "b"] as const) {
          const event = `terminal-output-${session}`;
          const frame = JSON.stringify({
            event,
            payload: {
              generation: session === "a" ? 1 : 2,
              revision: session === "a" ? 6 : 2,
              bytesBase64: session === "a" ? "YQ==" : "Yg==",
            },
          });
          if (transport === "direct") {
            directStreams
              .findLast(
                (stream) => stream.event.split(",").includes(event) && !stream.signal.aborted,
              )!
              .controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
          } else browserStream().onmessage!(new MessageEvent("message", { data: frame }));
        }
        await waitForCondition(
          () => payloads.a.some((p) => p.bytesBase64) && payloads.b.some((p) => p.bytesBase64),
          "Fallback output did not reach both terminals",
        );
        expect(payloads.a.filter((p) => p.bytesBase64)).toEqual([
          { generation: 1, revision: 6, bytesBase64: "YQ==" },
        ]);
        expect(payloads.b.filter((p) => p.bytesBase64)).toEqual([
          { generation: 2, revision: 2, bytesBase64: "Yg==" },
        ]);

        snapshots.set("a", { generation: 1, revision: 7, data: "snapshot-a-recovered" });
        await applySnapshot("a");
        await applySnapshot("b");
        const during = api.invoke("terminal_write", { sessionId: "a", data: "during-outage" });
        await waitForCondition(() => releaseHttp !== undefined, "Outage input did not reach HTTP");
        await api.invoke("terminal_write", { sessionId: "b", data: "other-terminal" });
        expect(httpWrites).toEqual([
          { sessionId: "a", data: "during-outage" },
          { sessionId: "b", data: "other-terminal" },
        ]);

        socketRetry.advance();
        const second = MockWebSocket.instances[1]!;
        openTerminalSocket(second);
        for (const [sessionId, snapshot] of snapshots) {
          expect(
            sentControlFrames(second).find(
              (f) => f.type === "subscribe" && f.sessionId === sessionId,
            ),
          ).toMatchObject({
            knownGeneration: snapshot.generation,
            knownRevision: snapshot.revision,
          });
        }
        subscribeTerminalSocket(second, "a", "current", 11, 1, 7);
        subscribeTerminalSocket(second, "b", "current", 12, 2, 3);
        await waitForCondition(
          () => activeFallbacks() === 0,
          "Recovered socket did not retire fallbacks",
        );
        const after = ["after-1", "after-2"].map((data) =>
          api.invoke("terminal_write", { sessionId: "a", data }),
        );
        const independent = api.invoke("terminal_write", { sessionId: "b", data: "independent" });
        await waitForCondition(
          () => binaries(second).some((f) => f.channelId === 12),
          "Pending HTTP input blocked another terminal",
        );
        expect(binaries(second).filter((f) => f.channelId === 11)).toHaveLength(0);
        acknowledge(
          second,
          binaries(second).find((f) => f.channelId === 12)!,
        );
        await independent;
        releaseHttp!();
        await during;
        await waitForCondition(
          () => binaries(second).filter((f) => f.channelId === 11).length === 2,
          "Recovered input did not follow the HTTP write",
        );
        const ordered = binaries(second).filter((f) => f.channelId === 11);
        expect(ordered.map((f) => new TextDecoder().decode(f.bytes))).toEqual([
          "after-1",
          "after-2",
        ]);
        for (const frame of ordered) acknowledge(second, frame);
        await Promise.all(after);
        expect(httpWrites).toHaveLength(2);
        output(second, 11, 1, 8, "a-eight");
        output(second, 12, 2, 4, "b-four");
        await waitForCondition(
          () =>
            payloads.a.some((p) => p.revision === 8) && payloads.b.some((p) => p.revision === 4),
          "Recovered output did not reach both terminals",
        );
        expect(payloads.a.filter((p) => p.bytes).map((p) => p.revision)).toEqual([1, 8]);
        expect(payloads.b.filter((p) => p.bytes).map((p) => p.revision)).toEqual([1, 2, 4]);
        expect(socketRetry.pendingCount()).toBe(0);
        expect(streamRetry.pendingCount()).toBe(0);
      } finally {
        releaseHttp?.();
        for (const stop of stops) stop();
        streamRetry.restore();
        socketRetry.restore();
        happyWindow.happyDOM.setURL(previousUrl);
      }
    },
  );

  test("retains fallback and retries a channel when its snapshot fails", async () => {
    let fallbackSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        fallbackSignal = init?.signal ?? undefined;
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "snapshot unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });

    const stop = api.listen("terminal-output-session-1", () => undefined);
    await waitForCondition(() => fallbackSignal !== undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "session-1");

    await expect(
      api.invoke("get_terminal_output_snapshot", { sessionId: "session-1" }),
    ).rejects.toThrow("snapshot unavailable");
    await api.invoke("terminal_snapshot_failed", { sessionId: "session-1" });
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "unsubscribe"),
      "Snapshot failure did not reset the WebSocket subscription",
    );
    expect(fallbackSignal?.aborted).toBe(false);
    stop();
  });

  test("waits for WebSocket input and resize acknowledgements before HTTP close and restart", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-ordered", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "ordered", "current");

    const input = api.invoke("terminal_write", { sessionId: "ordered", data: "final" });
    await waitForCondition(
      () => socket.sent.some((frame) => typeof frame !== "string"),
      "WebSocket input was not sent",
    );
    const binary = socket.sent.find((frame) => typeof frame !== "string");
    if (!binary || binary instanceof Blob) throw new Error("Input frame was not binary");
    const inputFrame = decodeSentBinaryFrame(binary as ArrayBufferLike | ArrayBufferView);
    expect(inputFrame.type).toBe(TERMINAL_BINARY_FRAME_TYPE.input);

    const resize = api.invoke("terminal_resize", { sessionId: "ordered", cols: 100, rows: 30 });
    const close = api.invoke("detach_terminal", { sessionId: "ordered" });
    const restart = api.invoke("start_terminal_session", { sessionId: "ordered" });
    await Promise.resolve();
    expect(sentControlFrames(socket).some((frame) => frame.type === "resize")).toBe(false);
    expect(invokes).toEqual([]);

    socket.receive(
      JSON.stringify({
        type: "operation-result",
        channelId,
        operationId: inputFrame.revision,
        operation: "input",
        ok: true,
      }),
    );
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "resize"),
      "Resize did not follow acknowledged input",
    );
    const resizeFrame = sentControlFrames(socket).find((frame) => frame.type === "resize")!;
    expect(invokes).toEqual([]);
    socket.receive(
      JSON.stringify({
        type: "operation-result",
        channelId,
        operationId: resizeFrame.operationId,
        operation: "resize",
        ok: true,
      }),
    );

    await Promise.all([input, resize, close, restart]);
    expect(invokes).toEqual(["detach_terminal", "start_terminal_session"]);
    stop();
  });

  test("does not re-arm a terminal fallback that a ready WebSocket channel retired", async () => {
    let eventStreamRequests = 0;
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        eventStreamRequests += 1;
        const signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              // A real aborted body errors its reader, which is what runs the
              // reconnect bookkeeping. A stream that just hangs would hide it.
              signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          result: { generation: 1, revision: 0, output: "" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      eventReconnectDelayMs: 1,
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });

    const stop = api.listen("terminal-output-session-1", () => undefined);
    await waitForCondition(() => eventStreamRequests === 1);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "session-1");
    await api.invoke("get_terminal_output_snapshot", { sessionId: "session-1" });
    await waitForCondition(
      () =>
        sentControlFrames(socket).some((frame) => frame.type === "ack") ||
        eventStreamRequests === 1,
      "Channel never became ready",
    );

    const settled = eventStreamRequests;
    await new Promise((resolve) => originalSetTimeout(resolve, 30));
    // Stopping the fallback aborts its controller, and that abort is exactly
    // what schedules the reconnect. Both transports carrying the same terminal
    // would double every byte the milestone is trying to save.
    expect(eventStreamRequests).toBe(settled);
    stop();
  });

  test("pipelines consecutive WebSocket writes instead of waiting for each acknowledgement", async () => {
    globalThis.fetch = mock(async (input) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-typed", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "typed", "current");

    const writes = [
      api.invoke("terminal_write", { sessionId: "typed", data: "a" }),
      api.invoke("terminal_write", { sessionId: "typed", data: "b" }),
      api.invoke("terminal_write", { sessionId: "typed", data: "c" }),
    ];
    // No acknowledgement has been delivered yet. Chaining each keystroke on the
    // previous ack would cap typing at one round trip per character.
    await waitForCondition(
      () => socket.sent.filter((frame) => typeof frame !== "string").length === 3,
      "Writes were serialized behind their acknowledgements",
    );
    const frames = socket.sent
      .filter((frame) => typeof frame !== "string")
      .map((frame) => decodeSentBinaryFrame(frame as ArrayBufferLike | ArrayBufferView));
    expect(frames.map((frame) => new TextDecoder().decode(frame.bytes))).toEqual(["a", "b", "c"]);

    for (const frame of frames) {
      socket.receive(
        JSON.stringify({
          type: "operation-result",
          channelId,
          operationId: frame.revision,
          operation: "input",
          ok: true,
        }),
      );
    }
    await expect(Promise.all(writes)).resolves.toEqual([
      { delivered: true },
      { delivered: true },
      { delivered: true },
    ]);
    stop();
  });

  test("rejects socket input after an HTTP write failure latched the queue, until resume", async () => {
    let failWrites = true;
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      if (failWrites && body.command.endsWith("terminal_write")) {
        return new Response(JSON.stringify({ error: "write failed" }), { status: 503 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-latched", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);

    // The channel is not ready yet, so this write takes the HTTP path and
    // fails, latching the batcher's queue for this terminal.
    await expect(
      api.invoke("terminal_write", { sessionId: "latched", data: "x" }),
    ).rejects.toThrow();
    failWrites = false;

    const channelId = subscribeTerminalSocket(socket, "latched", "current");
    // A healthy socket says nothing about how much of the lost write reached
    // the shell, so the latched failure vetoes it too.
    await expect(api.invoke("terminal_write", { sessionId: "latched", data: "y" })).rejects.toThrow(
      "write failed",
    );
    expect(socket.sent.some((frame) => typeof frame !== "string")).toBe(false);

    await expect(
      api.invoke(TERMINAL_INPUT_RESUME_COMMAND, { sessionId: "latched" }),
    ).resolves.toEqual({ resumed: true });
    const write = api.invoke("terminal_write", { sessionId: "latched", data: "z" });
    await waitForCondition(
      () => socket.sent.some((frame) => typeof frame !== "string"),
      "A latched HTTP queue blocked a healthy WebSocket write",
    );
    const frame = decodeSentBinaryFrame(
      socket.sent.find((value) => typeof value !== "string") as ArrayBufferLike,
    );
    socket.receive(
      JSON.stringify({
        type: "operation-result",
        channelId,
        operationId: frame.revision,
        operation: "input",
        ok: true,
      }),
    );
    await write;
    // The only HTTP request is the write that failed.
    expect(invokes).toEqual(["terminal_write"]);
    stop();
  });

  test("falls back to an HTTP resize when the socket rejects the operation", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      invokes.push((JSON.parse(String(init?.body)) as { command: string }).command);
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-sized", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "sized", "current");

    const resize = api.invoke("terminal_resize", { sessionId: "sized", cols: 100, rows: 30 });
    await waitForCondition(
      () => sentControlFrames(socket).some((frame) => frame.type === "resize"),
      "Resize was never attempted over the socket",
    );
    const resizeFrame = sentControlFrames(socket).find((frame) => frame.type === "resize")!;
    socket.receive(
      JSON.stringify({
        type: "operation-result",
        channelId,
        operationId: resizeFrame.operationId,
        operation: "resize",
        ok: false,
        message: "Unknown terminal channel",
      }),
    );

    // A refused socket resize still has to reach the backend. Letting the
    // rejection propagate would leave the PTY at stale dimensions silently.
    await resize;
    expect(invokes).toContain("terminal_resize");
    stop();
  });

  test("coalesces the shared browser stream rebuild when channels become ready together", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            result: { generation: 1, revision: 0, output: "" },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    // The shared stream is the same-origin path, so there is no base URL to
    // derive the socket address from — the document has to have a real one.
    const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };
    happyWindow.happyDOM.setURL("http://localhost:1420/");
    const api = createBrowserGatewayApi({
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stopFirst = api.listen("terminal-output-one", () => undefined);
    const stopSecond = api.listen("terminal-output-two", () => undefined);
    await waitForCondition(() => MockEventSource.instances.length === 1);
    MockEventSource.instances[0]!.open();

    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    subscribeTerminalSocket(socket, "one", "current", 1);
    subscribeTerminalSocket(socket, "two", "current", 2);

    // Every rebuild costs the still-fallback terminals a snapshot reconcile, so
    // channels retiring their fallback in a burst must produce one rebuild.
    await new Promise((resolve) => originalSetTimeout(resolve, 120));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    stopFirst();
    stopSecond();
    happyWindow.happyDOM.setURL("about:blank");
  });

  test("disposes an opted-in terminal socket when the browser adapter is replaced", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.fetch = mock(
      async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    ) as unknown as typeof fetch;
    const fakeWindow: TestGatewayWindow = {
      location: { protocol: "http:" },
      orkestrator: undefined,
      orkestratorGateway: undefined,
    };
    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      {
        baseUrl: "http://localhost:4319",
        terminalTransport: "websocket",
        terminalWebSocketFactory: (url, protocols) =>
          new MockWebSocket(url, protocols) as unknown as WebSocket,
      },
    );
    const stop = fakeWindow.orkestrator!.listen("terminal-output-dispose", () => undefined);
    const socket = MockWebSocket.instances[0]!;

    installBrowserGatewayApi(
      fakeWindow as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">,
      { replaceExisting: true },
    );

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(socket.closeReason).toBe("Gateway adapter disposed");
    stop();
  });

  test("reconnects an active terminal socket with a rotated gateway token", async () => {
    globalThis.fetch = mock(async (input) => {
      if (String(input).includes("/gateway-settings")) {
        return new Response(
          JSON.stringify({
            token: "rotated-token-654321",
            configured: true,
          }),
          { status: 200 },
        );
      }
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      token: "initial-token-123456",
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 0,
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-token", () => undefined);
    const first = MockWebSocket.instances[0]!;
    first.open();
    expect(sentControlFrames(first)[0]?.token).toBe("initial-token-123456");

    await api.webClient.setToken("rotated-token-654321");
    expect(first.closeReason).toBe("Gateway credential changed");
    await waitForCondition(() => MockWebSocket.instances.length === 2);
    const second = MockWebSocket.instances[1]!;
    second.open();
    expect(sentControlFrames(second)[0]?.token).toBe("rotated-token-654321");
    stop();
  });

  test("applies a verified active connection token to HTTP and terminal WebSocket transport", async () => {
    const authorization: Array<string | null> = [];
    globalThis.fetch = mock(async (input, init) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      if (String(input).endsWith("/__orkestrator/invoke")) {
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const connectionList = {
      activeConnectionId: "remote-1",
      credentialStorage: "session-only" as const,
      connections: [],
    };
    const connections = {
      list: mock(async () => connectionList),
      probe: mock(async () => true),
      connect: mock(async () => connectionList),
      updateToken: mock(async () => connectionList),
      use: mock(async () => connectionList),
      forget: mock(async () => connectionList),
    };
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      token: "initial-token-123456",
      connections,
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 0,
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-token", () => undefined);
    const first = MockWebSocket.instances[0]!;
    first.open();
    expect(sentControlFrames(first)[0]?.token).toBe("initial-token-123456");

    await api.connections?.updateToken("remote-1", "replacement-token-123456");
    await api.invoke("get_projects");

    expect(connections.updateToken).toHaveBeenCalledWith("remote-1", "replacement-token-123456");
    expect(authorization.at(-1)).toBe("Bearer replacement-token-123456");
    expect(first.closeReason).toBe("Gateway credential changed");
    await waitForCondition(() => MockWebSocket.instances.length === 2);
    const second = MockWebSocket.instances[1]!;
    second.open();
    expect(sentControlFrames(second)[0]?.token).toBe("replacement-token-123456");
    stop();
  });

  test("keeps SSE fallback when terminal WebSocket construction fails", async () => {
    let fallbackSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      fallbackSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketReconnectDelayMs: 60_000,
      terminalWebSocketFactory: () => {
        throw new Error("WebSocket unavailable");
      },
    });

    const stop = api.listen("terminal-output-fallback", () => undefined);
    const ready = api.eventStreamReady("terminal-output-fallback");
    await expect(ready).resolves.toBeUndefined();
    expect(fallbackSignal?.aborted).toBe(false);
    stop();
    // The shared terminal stream drops its last terminal on the next microtask.
    await Promise.resolve();
    expect(fallbackSignal?.aborted).toBe(true);
  });

  test("surfaces a rejected WebSocket input operation without an ambiguous HTTP retry", async () => {
    const invokes: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/__orkestrator/events?")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { command: string };
      invokes.push(body.command);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBrowserGatewayApi({
      baseUrl: "http://localhost:4319",
      terminalTransport: "websocket",
      terminalWebSocketFactory: (url, protocols) =>
        new MockWebSocket(url, protocols) as unknown as WebSocket,
    });
    const stop = api.listen("terminal-output-rejected", () => undefined);
    const socket = MockWebSocket.instances[0]!;
    openTerminalSocket(socket);
    const channelId = subscribeTerminalSocket(socket, "rejected", "current");

    const input = api.invoke("terminal_write", { sessionId: "rejected", data: "dangerous" });
    await waitForCondition(() => socket.sent.some((frame) => typeof frame !== "string"));
    const binary = socket.sent.find((frame) => typeof frame !== "string");
    if (!binary || binary instanceof Blob) throw new Error("Input frame was not binary");
    const inputFrame = decodeSentBinaryFrame(binary as ArrayBufferLike | ArrayBufferView);
    socket.receive(
      JSON.stringify({
        type: "operation-result",
        channelId,
        operationId: inputFrame.revision,
        operation: "input",
        ok: false,
        message: "terminal write rejected",
      }),
    );

    await expect(input).rejects.toThrow("terminal write rejected");
    expect(invokes).toEqual([]);
    stop();
  });
});
