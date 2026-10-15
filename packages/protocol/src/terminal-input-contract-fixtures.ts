/**
 * Transport-neutral contract for terminal input, run by every client that
 * sends terminal input to the backend (the browser gateway and the desktop
 * client). Each client's test file supplies an adapter that drives its real
 * `invoke` against a scripted backend, then asserts `actual` equals
 * `expected` for every scenario.
 *
 * Scenarios observe only what crosses the wire and what callers see, so a
 * client passes by behaving correctly, not by sharing an implementation.
 */
import { TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES } from "./terminal-input-batcher.js";
import {
  TERMINAL_CLOSED_SESSION_MEMORY,
  TERMINAL_INPUT_CLOSED_MESSAGE,
  TERMINAL_INPUT_NOT_DELIVERED_MESSAGE,
  LOCAL_TERMINAL_INPUT_RESUME_COMMAND,
  TERMINAL_INPUT_RESUME_COMMAND,
} from "./terminal-input-sequencer.js";

export interface TerminalContractRequest {
  command: string;
  args: Record<string, unknown>;
}

export type TerminalContractReply = { result: unknown } | { status: number; error: string };

/** Answers one backend request. Throwing simulates a network failure. */
export type TerminalContractBackend = (
  request: TerminalContractRequest,
  signal: AbortSignal | null,
) => Promise<TerminalContractReply>;

export interface TerminalContractClient {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  dispose?(): void;
}

export interface TerminalContractAdapter {
  /** Uses default limits unless an option overrides one. */
  create(
    backend: TerminalContractBackend,
    options?: { sendTimeoutMs?: number },
  ): TerminalContractClient;
}

export interface TerminalContractScenario {
  name: string;
  run(adapter: TerminalContractAdapter): Promise<{ actual: unknown; expected: unknown }>;
}

type Outcome = "delivered" | "resolved" | `rejected: ${string}`;

const delivered: TerminalContractReply = { result: { delivered: true } };
const ok: TerminalContractReply = { result: null };
const unavailable: TerminalContractReply = { status: 503, error: "gateway unavailable" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Longer than any client's typing batch delay, so queued input has been sent. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) =>
      value && typeof value === "object" && (value as { delivered?: unknown }).delivered === true
        ? "delivered"
        : "resolved",
    (error: unknown) =>
      `rejected: ${error instanceof Error ? error.message : String(error)}` as Outcome,
  );
}

/** Reduces timed-out messages, whose wording includes the configured delay. */
function normalize(result: Outcome): Outcome {
  return result.startsWith("rejected: ") && result.includes("timed out")
    ? "rejected: timed out"
    : result;
}

/**
 * The wire log with consecutive writes to one terminal merged, since how
 * input is split into requests is a batching detail rather than the contract.
 */
function wire(log: TerminalContractRequest[]): string[] {
  const entries: string[] = [];
  let previousWrite: string | null = null;
  for (const { command, args } of log) {
    const isWrite = command === "terminal_write" || command === "local_terminal_write";
    const target = `${command}:${String(args.sessionId)}`;
    if (isWrite && previousWrite === target) {
      entries[entries.length - 1] += String(args.data);
      continue;
    }
    entries.push(isWrite ? `${target}=${String(args.data)}` : target);
    previousWrite = isWrite ? target : null;
  }
  return entries;
}

function recorder(
  answer: (
    request: TerminalContractRequest,
    signal: AbortSignal | null,
  ) => Promise<TerminalContractReply>,
) {
  const log: TerminalContractRequest[] = [];
  const backend: TerminalContractBackend = (request, signal) => {
    log.push(request);
    return answer(request, signal);
  };
  return { log, backend };
}

const write = (client: TerminalContractClient, sessionId: string, data: string) =>
  client.invoke("terminal_write", { sessionId, data });

/** A request that settles only when its signal aborts. */
const hang = (signal: AbortSignal | null) =>
  new Promise<TerminalContractReply>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const isWrite = (request: TerminalContractRequest) => request.command === "terminal_write";

/** Resolves with the raw result, or the rejection message. */
const resume = (
  client: TerminalContractClient,
  sessionId: string,
  command = TERMINAL_INPUT_RESUME_COMMAND,
) =>
  client.invoke(command, { sessionId }).then(
    (value) => value,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );

/** A backend whose writes fail until `heal` is called. */
function failingWrites() {
  let failWrites = true;
  const recorded = recorder(async (request) =>
    request.command.endsWith("_write") ? (failWrites ? unavailable : delivered) : ok,
  );
  return {
    ...recorded,
    heal: () => {
      failWrites = false;
    },
  };
}

export const terminalInputContractScenarios: readonly TerminalContractScenario[] = [
  {
    name: "delivers input in issue order around a resize",
    async run(adapter) {
      const { log, backend } = recorder(async (request) => (isWrite(request) ? delivered : ok));
      const client = adapter.create(backend);
      const results = await Promise.all([
        outcome(write(client, "t", "a")),
        outcome(write(client, "t", "b")),
        outcome(client.invoke("terminal_resize", { sessionId: "t", cols: 80, rows: 24 })),
        outcome(write(client, "t", "c")),
      ]);
      return {
        actual: { results, wire: wire(log) },
        expected: {
          results: ["delivered", "delivered", "resolved", "delivered"],
          wire: ["terminal_write:t=ab", "terminal_resize:t", "terminal_write:t=c"],
        },
      };
    },
  },
  {
    name: "a lifecycle command waits for input accepted before it",
    async run(adapter) {
      const held = deferred<TerminalContractReply>();
      let first = true;
      const { log, backend } = recorder(async (request) => {
        if (isWrite(request) && first) {
          first = false;
          return held.promise;
        }
        return isWrite(request) ? delivered : ok;
      });
      const client = adapter.create(backend);
      const prefix = outcome(write(client, "t", "prefix"));
      await settle();
      const close = outcome(client.invoke("detach_terminal", { sessionId: "t" }));
      await settle();
      const beforeRelease = wire(log);
      held.resolve(delivered);
      return {
        actual: { beforeRelease, results: [await prefix, await close], wire: wire(log) },
        expected: {
          beforeRelease: ["terminal_write:t=prefix"],
          results: ["delivered", "resolved"],
          wire: ["terminal_write:t=prefix", "detach_terminal:t"],
        },
      };
    },
  },
  {
    name: "close fences input until a start reopens it",
    async run(adapter) {
      const { log, backend } = recorder(async (request) => (isWrite(request) ? delivered : ok));
      const client = adapter.create(backend);
      const results = [
        await outcome(write(client, "t", "a")),
        await outcome(client.invoke("detach_terminal", { sessionId: "t" })),
        await outcome(write(client, "t", "stale")),
        await outcome(client.invoke("start_terminal_session", { sessionId: "t" })),
        await outcome(write(client, "t", "fresh")),
      ];
      return {
        actual: { results, wire: wire(log) },
        expected: {
          results: [
            "delivered",
            "resolved",
            `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`,
            "resolved",
            "delivered",
          ],
          wire: [
            "terminal_write:t=a",
            "detach_terminal:t",
            "start_terminal_session:t",
            "terminal_write:t=fresh",
          ],
        },
      };
    },
  },
  {
    name: "input issued after a close is rejected even while the close is in flight",
    async run(adapter) {
      const held = deferred<TerminalContractReply>();
      const { log, backend } = recorder(async (request) =>
        request.command === "detach_terminal" ? held.promise : delivered,
      );
      const client = adapter.create(backend);
      const close = outcome(client.invoke("detach_terminal", { sessionId: "t" }));
      const later = await outcome(write(client, "t", "later"));
      held.resolve(ok);
      return {
        actual: { results: [await close, later], wire: wire(log) },
        expected: {
          results: ["resolved", `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`],
          wire: ["detach_terminal:t"],
        },
      };
    },
  },
  {
    name: "a failed send rejects its queued suffix and fences later input",
    async run(adapter) {
      const held = deferred<TerminalContractReply>();
      let first = true;
      const { log, backend } = recorder(async () => {
        if (first) {
          first = false;
          return held.promise;
        }
        return delivered;
      });
      const client = adapter.create(backend);
      const prefix = outcome(write(client, "t", "prefix"));
      await settle();
      const suffix = outcome(write(client, "t", "suffix"));
      held.resolve(unavailable);
      const results = [await prefix, await suffix, await outcome(write(client, "t", "later"))];
      return {
        actual: { results, wire: wire(log) },
        expected: {
          results: Array.from({ length: 3 }, () => "rejected: gateway unavailable"),
          wire: ["terminal_write:t=prefix"],
        },
      };
    },
  },
  {
    name: "an in-band refusal rejects every input in the batch",
    async run(adapter) {
      const { backend } = recorder(async () => ({ result: { delivered: false } }));
      const client = adapter.create(backend);
      const results = await Promise.all([
        outcome(write(client, "t", "n")),
        outcome(write(client, "t", "o")),
      ]);
      return {
        actual: results,
        expected: Array.from(
          { length: 2 },
          () => `rejected: ${TERMINAL_INPUT_NOT_DELIVERED_MESSAGE}`,
        ),
      };
    },
  },
  {
    name: "a hung send times out, aborts, and fences its suffix",
    async run(adapter) {
      const signals: Array<AbortSignal | null> = [];
      const { log, backend } = recorder((_request, signal) => {
        signals.push(signal);
        return hang(signal);
      });
      const client = adapter.create(backend, { sendTimeoutMs: 40 });
      const prefix = outcome(write(client, "t", "prefix"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const suffix = outcome(write(client, "t", "suffix"));
      const results = [await prefix, await suffix, await outcome(write(client, "t", "later"))];
      return {
        actual: { results: results.map(normalize), aborted: signals[0]?.aborted, wire: wire(log) },
        expected: {
          results: Array.from({ length: 3 }, () => "rejected: timed out"),
          aborted: true,
          wire: ["terminal_write:t=prefix"],
        },
      };
    },
  },
  {
    name: "a start discards input queued against the previous incarnation",
    async run(adapter) {
      let first = true;
      const { log, backend } = recorder((request, signal) => {
        if (isWrite(request) && first) {
          first = false;
          return hang(signal);
        }
        return Promise.resolve(isWrite(request) ? delivered : ok);
      });
      const client = adapter.create(backend);
      const stale = outcome(write(client, "t", "stale"));
      await settle();
      const start = outcome(client.invoke("start_terminal_session", { sessionId: "t" }));
      const fresh = outcome(write(client, "t", "fresh"));
      const results = [(await stale).startsWith("rejected: "), await start, await fresh];
      return {
        actual: { results, wire: wire(log) },
        expected: {
          results: [true, "resolved", "delivered"],
          wire: ["terminal_write:t=stale", "start_terminal_session:t", "terminal_write:t=fresh"],
        },
      };
    },
  },
  {
    name: "input larger than the queue ceiling is refused without fencing the terminal",
    async run(adapter) {
      const { log, backend } = recorder(async () => delivered);
      const client = adapter.create(backend);
      const oversized = await outcome(
        write(client, "t", "x".repeat(TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES + 1)),
      );
      const after = await outcome(write(client, "t", "ok"));
      return {
        actual: { refused: oversized.includes("queue limit"), after, wire: wire(log) },
        expected: { refused: true, after: "delivered", wire: ["terminal_write:t=ok"] },
      };
    },
  },
  {
    name: "closing many terminals never blocks input to new ones",
    async run(adapter) {
      const { backend } = recorder(async (request) => (isWrite(request) ? delivered : ok));
      const client = adapter.create(backend);
      const closes = TERMINAL_CLOSED_SESSION_MEMORY + 8;
      for (let index = 0; index < closes; index += 1) {
        await client.invoke("detach_terminal", { sessionId: `closed-${index}` });
      }
      return {
        actual: {
          fresh: await outcome(write(client, "fresh", "x")),
          recentlyClosed: await outcome(write(client, `closed-${closes - 1}`, "x")),
        },
        expected: {
          fresh: "delivered",
          recentlyClosed: `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`,
        },
      };
    },
  },
  {
    name: "terminals and command families are independent",
    async run(adapter) {
      const held = deferred<TerminalContractReply>();
      const { log, backend } = recorder(async (request) => {
        if (request.args.sessionId === "busy" && isWrite(request)) return held.promise;
        return request.command.endsWith("_write") ? delivered : ok;
      });
      const client = adapter.create(backend);
      const busy = outcome(write(client, "busy", "held"));
      await settle();
      const others = await Promise.all([
        outcome(client.invoke("local_terminal_write", { sessionId: "busy", data: "local" })),
        outcome(write(client, "other", "other")),
        // Without a usable session id there is no queue to order against.
        outcome(client.invoke("terminal_resize", { cols: 80, rows: 24 })),
      ]);
      held.resolve(delivered);
      return {
        actual: { others, busy: await busy, sent: wire(log).length },
        expected: { others: ["delivered", "delivered", "resolved"], busy: "delivered", sent: 4 },
      };
    },
  },
  {
    name: "a successful start re-arms a failed terminal",
    async run(adapter) {
      let failWrites = true;
      const { backend } = recorder(async (request) =>
        isWrite(request) && failWrites ? unavailable : isWrite(request) ? delivered : ok,
      );
      const client = adapter.create(backend);
      await outcome(write(client, "t", "a"));
      failWrites = false;
      await client.invoke("start_terminal_session", { sessionId: "t" });
      return {
        actual: await outcome(write(client, "t", "b")),
        expected: "delivered",
      };
    },
  },
  {
    name: "a successful resize does not re-arm a failed terminal",
    async run(adapter) {
      const { backend, heal } = failingWrites();
      const client = adapter.create(backend);
      await outcome(write(client, "t", "a"));
      heal();
      await client.invoke("terminal_resize", { sessionId: "t", cols: 100, rows: 30 });
      return {
        actual: await outcome(write(client, "t", "b")),
        expected: "rejected: gateway unavailable",
      };
    },
  },
  {
    name: "a close that never landed keeps the terminal closed",
    async run(adapter) {
      const { backend } = recorder(async (request) =>
        request.command === "detach_terminal" ? unavailable : delivered,
      );
      const client = adapter.create(backend);
      const close = await outcome(client.invoke("detach_terminal", { sessionId: "t" }));
      return {
        actual: { close, after: await outcome(write(client, "t", "ls\r")) },
        expected: {
          close: "rejected: gateway unavailable",
          after: `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`,
        },
      };
    },
  },
  {
    name: "a failed start fences input with the start error",
    async run(adapter) {
      let failStart = true;
      const { backend } = recorder(async (request) => {
        if (request.command === "start_terminal_session" && failStart) {
          failStart = false;
          return { status: 500, error: "container gone" };
        }
        return isWrite(request) ? delivered : ok;
      });
      const client = adapter.create(backend);
      const start = await outcome(client.invoke("start_terminal_session", { sessionId: "t" }));
      return {
        actual: { start, after: await outcome(write(client, "t", "ok\r")) },
        expected: { start: "rejected: container gone", after: "rejected: container gone" },
      };
    },
  },
  {
    name: "resume after a failed write re-arms, and the next write is delivered",
    async run(adapter) {
      const { log, backend, heal } = failingWrites();
      const client = adapter.create(backend);
      const failed = await outcome(write(client, "t", "a"));
      heal();
      const resumed = await resume(client, "t");
      return {
        actual: { failed, resumed, after: await outcome(write(client, "t", "b")), wire: wire(log) },
        expected: {
          failed: "rejected: gateway unavailable",
          resumed: { resumed: true },
          after: "delivered",
          // The rejected write was sent; resume lets the next one follow it.
          wire: ["terminal_write:t=ab"],
        },
      };
    },
  },
  {
    name: "resume does not reopen a closed terminal",
    async run(adapter) {
      const { log, backend } = recorder(async (request) => (isWrite(request) ? delivered : ok));
      const client = adapter.create(backend);
      await client.invoke("detach_terminal", { sessionId: "t" });
      const resumed = await resume(client, "t");
      return {
        actual: { resumed, after: await outcome(write(client, "t", "x")), wire: wire(log) },
        expected: {
          resumed: { resumed: false },
          after: `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`,
          wire: ["detach_terminal:t"],
        },
      };
    },
  },
  {
    name: "resume on a healthy terminal reports nothing to resume and sends nothing",
    async run(adapter) {
      const { log, backend } = recorder(async () => delivered);
      const client = adapter.create(backend);
      const resumed = await resume(client, "t");
      return {
        actual: { resumed, after: await outcome(write(client, "t", "x")), wire: wire(log) },
        expected: { resumed: { resumed: false }, after: "delivered", wire: ["terminal_write:t=x"] },
      };
    },
  },
  {
    name: "resume issued after a close waits for that close and leaves the terminal closed",
    async run(adapter) {
      const held = deferred<TerminalContractReply>();
      const { log, backend } = recorder(async (request) =>
        request.command === "detach_terminal" ? held.promise : delivered,
      );
      const client = adapter.create(backend);
      const close = outcome(client.invoke("detach_terminal", { sessionId: "t" }));
      let resumeSettled = false;
      const resumed = resume(client, "t").finally(() => {
        resumeSettled = true;
      });
      await settle();
      const settledBeforeClose = resumeSettled;
      held.resolve(ok);
      return {
        actual: {
          settledBeforeClose,
          close: await close,
          resumed: await resumed,
          after: await outcome(write(client, "t", "x")),
          wire: wire(log),
        },
        expected: {
          settledBeforeClose: false,
          close: "resolved",
          resumed: { resumed: false },
          after: `rejected: ${TERMINAL_INPUT_CLOSED_MESSAGE}`,
          wire: ["detach_terminal:t"],
        },
      };
    },
  },
  {
    name: "resume never reaches the backend",
    async run(adapter) {
      const { log, backend } = recorder(async () => ok);
      const client = adapter.create(backend);
      const results = [
        await resume(client, "t"),
        await resume(client, "t", LOCAL_TERMINAL_INPUT_RESUME_COMMAND),
        // Malformed, but still refused locally rather than sent on.
        String(await resume(client, 1 as unknown as string)).startsWith("rejected: "),
      ];
      return {
        actual: { results, wire: wire(log) },
        expected: { results: [{ resumed: false }, { resumed: false }, true], wire: [] },
      };
    },
  },
  {
    name: "resume re-arms only its own command family",
    async run(adapter) {
      const { log, backend, heal } = failingWrites();
      const client = adapter.create(backend);
      await outcome(write(client, "t", "a"));
      await outcome(client.invoke("local_terminal_write", { sessionId: "t", data: "b" }));
      heal();
      const resumed = await resume(client, "t", LOCAL_TERMINAL_INPUT_RESUME_COMMAND);
      return {
        actual: {
          resumed,
          local: await outcome(
            client.invoke("local_terminal_write", { sessionId: "t", data: "c" }),
          ),
          remote: await outcome(write(client, "t", "d")),
          wire: wire(log),
        },
        expected: {
          resumed: { resumed: true },
          local: "delivered",
          remote: "rejected: gateway unavailable",
          wire: ["terminal_write:t=a", "local_terminal_write:t=bc"],
        },
      };
    },
  },
];
