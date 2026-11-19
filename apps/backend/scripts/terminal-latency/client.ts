/**
 * Browser-like client process for the terminal latency benchmark
 * (`apps/backend/scripts/terminal-latency.ts`). It runs in its own process, as a
 * renderer does, so its clock is not held by the backend's event loop.
 *
 * It speaks the default browser transport: terminal output arrives on a
 * filtered `/__orkestrator/events` stream (`includeEvents=terminal-output-…`)
 * and keystrokes go out as `terminal_write` through `/__orkestrator/invoke`.
 *
 * Roles (first argument, configuration as JSON in the second, the gateway
 * credential in `ORK_LATENCY_TOKEN`):
 *
 * - `typist` types one key at a time into the interactive terminal and times
 *   each until its echo arrives. With `parse`, it also feeds every terminal it
 *   subscribes to into a headless xterm on its own thread, the way the
 *   renderer parses each mounted terminal tab.
 * - `observer` holds the main event stream and a stream of every terminal,
 *   and reads an agent's transcript (`get_native_agent_live_update`) each time
 *   its activity event says it changed, as an open agent tab does.
 *
 * Reports are single JSON lines on stdout. An observer reports and exits when
 * a line arrives on stdin.
 */
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { EchoTracker, echoPayload, SseFrameReader, type SseEvent } from "./scenario.js";

type TypistConfig = {
  url: string;
  interactiveSessionId: string;
  loadSessionIds: string[];
  keystrokes: number;
  warmupKeystrokes: number;
  keyIntervalMs: number;
  echoTimeoutMs: number;
  settleMs: number;
  parse: boolean;
  cols: number;
  rows: number;
};

type ObserverConfig = {
  url: string;
  terminalSessionIds: string[];
};

const TERMINAL_EVENT_PREFIX = "terminal-output-";
const ACTIVITY_EVENT = "native-agent-session-activity";

const role = process.argv[2];
const config = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;
const token = process.env.ORK_LATENCY_TOKEN ?? "";
const headers = { authorization: `Bearer ${token}` };
const connection = new AbortController();

function report(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function peakRss(): number {
  return process.memoryUsage().rss;
}

type Stream = { bytes: () => number; desyncs: () => number };

/** Opens one event stream and feeds it through an SSE reader until closed. */
async function openStream(
  url: string,
  query: URLSearchParams,
  onEvent: (event: SseEvent, at: number) => void,
): Promise<Stream> {
  let bytes = 0;
  let desyncs = 0;
  let connected: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const reader = new SseFrameReader(
    (event) => {
      const payload = event.payload as { desynced?: unknown } | null;
      if (payload && typeof payload === "object" && payload.desynced === true) desyncs += 1;
      onEvent(event, performance.now());
    },
    (comment) => {
      if (comment.startsWith("connected")) connected();
    },
  );
  const response = await fetch(`${url}__orkestrator/events?${query.toString()}`, {
    headers,
    signal: connection.signal,
  });
  if (!response.ok || !response.body) throw new Error(`event stream answered ${response.status}`);
  const body = response.body.getReader();
  const decoder = new TextDecoder();
  const read = (async () => {
    while (!connection.signal.aborted) {
      const { done, value } = await body.read();
      if (done) throw new Error("SSE stream closed unexpectedly");
      bytes += value.byteLength;
      reader.push(decoder.decode(value, { stream: true }));
    }
  })();
  void read.catch((error: unknown) => connection.abort(error));
  await Promise.race([ready, read]);
  return { bytes: () => bytes, desyncs: () => desyncs };
}

async function invoke(
  url: string,
  command: string,
  args: Record<string, unknown>,
  signal = connection.signal,
) {
  const response = await fetch(`${url}__orkestrator/invoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${command} answered ${response.status}`);
  return { bytes: text.length, body: JSON.parse(text) as { result?: unknown } };
}

function parentSignal(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdin.once("data", () => resolve());
    process.stdin.once("end", () => reject(new Error("Parent closed the control pipe")));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTypist(options: TypistConfig): Promise<void> {
  const tracker = new EchoTracker();
  const subscribed = [options.interactiveSessionId, ...options.loadSessionIds];
  const terminals = new Map<string, HeadlessTerminal>();
  if (options.parse) {
    for (const sessionId of subscribed) {
      terminals.set(
        sessionId,
        new HeadlessTerminal({
          cols: options.cols,
          rows: options.rows,
          scrollback: 5_000,
          allowProposedApi: true,
        }),
      );
    }
  }
  const interactiveEvent = `${TERMINAL_EVENT_PREFIX}${options.interactiveSessionId}`;
  let parsedBytes = 0;
  let receivedOutputBytes = 0;
  const stream = await openStream(
    options.url,
    new URLSearchParams({
      excludeEvents: TERMINAL_EVENT_PREFIX,
      includeEvents: subscribed.map((id) => `${TERMINAL_EVENT_PREFIX}${id}`).join(","),
    }),
    (event, at) => {
      if (!event.event.startsWith(TERMINAL_EVENT_PREFIX)) return;
      const text = (event.payload as { text?: unknown } | null)?.text;
      if (typeof text !== "string") return;
      if (event.event === interactiveEvent) tracker.observe(text, at);
      receivedOutputBytes += text.length;
      const terminal = terminals.get(event.event.slice(TERMINAL_EVENT_PREFIX.length));
      if (terminal) {
        // Like the renderer, feed xterm on the client event loop.
        terminal.write(text);
        parsedBytes += text.length;
      }
    },
  );

  await sleep(options.settleMs);
  const latencies: number[] = [];
  let timeouts = 0;
  const total = options.warmupKeystrokes + options.keystrokes;
  for (let index = 0; index < total; index += 1) {
    const measured = index >= options.warmupKeystrokes;
    if (index === options.warmupKeystrokes) {
      const acknowledged = parentSignal();
      await Promise.all([report({ type: "measurement-ready" }), acknowledged]);
    }

    const key = echoPayload(index);
    const echoed = tracker.expect(key);
    const request = new AbortController();
    const sentAt = performance.now();
    const delivery = invoke(
      options.url,
      "terminal_write",
      { sessionId: options.interactiveSessionId, data: key },
      AbortSignal.any([connection.signal, request.signal]),
    ).then(({ body }) => {
      if (!(body.result as { delivered?: boolean } | undefined)?.delivered) {
        throw new Error("Interactive terminal did not accept the write");
      }
      return echoed;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        echoed,
        delivery,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), options.echoTimeoutMs);
        }),
      ]);
      if (measured) {
        if (outcome === null) timeouts += 1;
        else latencies.push(outcome - sentAt);
      }
    } finally {
      clearTimeout(timer);
      request.abort();
      tracker.cancel();
    }
    if (index + 1 < total) await sleep(options.keyIntervalMs);
  }
  await report({ type: "measurement-ended" });
  await report({
    type: "typist-result",
    latencies,
    timeouts,
    streamBytes: stream.bytes(),
    parsedBytes,
    receivedOutputBytes,
    desyncs: stream.desyncs(),
    rssBytes: peakRss(),
  });
  for (const terminal of terminals.values()) terminal.dispose();
}

async function runObserver(options: ObserverConfig): Promise<void> {
  let transcriptReads = 0;
  let transcriptBytes = 0;
  let transcriptFailures = 0;
  const cursors = new Map<string, number>();
  const inFlight = new Set<string>();
  const dirty = new Set<string>();

  const read = async (sessionId: string): Promise<void> => {
    if (inFlight.has(sessionId)) {
      dirty.add(sessionId);
      return;
    }
    inFlight.add(sessionId);
    try {
      do {
        dirty.delete(sessionId);
        const answer = await invoke(options.url, "get_native_agent_live_update", {
          sessionId,
          sinceRevision: cursors.get(sessionId) ?? 0,
        });
        transcriptReads += 1;
        transcriptBytes += answer.bytes;
        const revision = (answer.body.result as { revision?: unknown } | null)?.revision;
        if (typeof revision === "number") cursors.set(sessionId, revision);
      } while (dirty.has(sessionId));
    } catch {
      transcriptFailures += 1;
    } finally {
      inFlight.delete(sessionId);
    }
  };

  const main = await openStream(
    options.url,
    new URLSearchParams({ excludeEvents: TERMINAL_EVENT_PREFIX }),
    (event) => {
      if (event.event !== ACTIVITY_EVENT) return;
      const sessionId = (event.payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId === "string") void read(sessionId);
    },
  );
  let snapshotInFlight = false;
  let nextSnapshotAt = 0;
  const terminals = await openStream(
    options.url,
    new URLSearchParams({
      excludeEvents: TERMINAL_EVENT_PREFIX,
      includeEvents: options.terminalSessionIds
        .map((id) => `${TERMINAL_EVENT_PREFIX}${id}`)
        .join(","),
    }),
    (event, at) => {
      if (!event.event.startsWith(TERMINAL_EVENT_PREFIX)) return;
      if (snapshotInFlight || at < nextSnapshotAt) return;
      snapshotInFlight = true;
      nextSnapshotAt = at + 1_000;
      void invoke(options.url, "get_terminal_state_snapshot", {
        sessionId: event.event.slice(TERMINAL_EVENT_PREFIX.length),
      })
        .then(({ body }) => {
          if (typeof (body.result as { output?: unknown } | null)?.output !== "string") {
            throw new Error("Terminal snapshot returned no output");
          }
        })
        .catch((error: unknown) => connection.abort(error))
        .finally(() => {
          snapshotInFlight = false;
        });
    },
  );
  const finish = parentSignal();
  await Promise.all([report({ type: "ready" }), finish]);
  await report({
    type: "observer-result",
    mainBytes: main.bytes(),
    terminalBytes: terminals.bytes(),
    desyncs: terminals.desyncs(),
    transcriptReads,
    transcriptBytes,
    transcriptFailures,
    rssBytes: peakRss(),
  });
}

const disconnected = new Promise<never>((_resolve, reject) => {
  connection.signal.addEventListener("abort", () => reject(connection.signal.reason), {
    once: true,
  });
});
try {
  if (role !== "typist" && role !== "observer") throw new Error(`unknown role ${role}`);
  const client =
    role === "typist" ? runTypist(config as TypistConfig) : runObserver(config as ObserverConfig);
  await Promise.race([client, disconnected]);
  connection.abort();
  process.exit(0);
} catch (error) {
  await report({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
