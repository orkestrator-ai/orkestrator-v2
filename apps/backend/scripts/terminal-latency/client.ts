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
import { EchoTracker, KEY_ALPHABET, SseFrameReader, type SseEvent } from "./scenario.js";

type TypistConfig = {
  url: string;
  interactiveSessionId: string;
  parsedSessionIds: string[];
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

function report(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function peakRss(): number {
  return process.memoryUsage().rss;
}

type Stream = { bytes: () => number; desyncs: () => number; close: () => void };

/** Opens one event stream and feeds it through an SSE reader until closed. */
async function openStream(
  url: string,
  query: URLSearchParams,
  onEvent: (event: SseEvent, at: number) => void,
): Promise<Stream> {
  const controller = new AbortController();
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
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`event stream answered ${response.status}`);
  const body = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        bytes += value.byteLength;
        reader.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Closed by `close()`, or the backend went away at teardown.
    }
  })();
  await ready;
  return { bytes: () => bytes, desyncs: () => desyncs, close: () => controller.abort() };
}

async function invoke(url: string, command: string, args: Record<string, unknown>) {
  const response = await fetch(`${url}__orkestrator/invoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${command} answered ${response.status}`);
  return { bytes: text.length, body: JSON.parse(text) as { result?: unknown } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTypist(options: TypistConfig): Promise<void> {
  const tracker = new EchoTracker();
  const terminals = new Map<string, HeadlessTerminal>();
  if (options.parse) {
    for (const sessionId of [options.interactiveSessionId, ...options.parsedSessionIds]) {
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
  const subscribed = [
    options.interactiveSessionId,
    ...(options.parse ? options.parsedSessionIds : []),
  ];
  const interactiveEvent = `${TERMINAL_EVENT_PREFIX}${options.interactiveSessionId}`;
  let parsedBytes = 0;
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
      const terminal = terminals.get(event.event.slice(TERMINAL_EVENT_PREFIX.length));
      if (terminal) {
        // The renderer hands each frame to xterm.js on its main thread; the
        // parse runs before the next frame is read, as it does there.
        terminal.write(text);
        parsedBytes += text.length;
      }
    },
  );

  await sleep(options.settleMs);
  report({ type: "measuring" });
  const latencies: number[] = [];
  let timeouts = 0;
  const total = options.warmupKeystrokes + options.keystrokes;
  for (let index = 0; index < total; index += 1) {
    const key = KEY_ALPHABET[index % KEY_ALPHABET.length]!;
    const echoed = tracker.expect(key);
    const sentAt = performance.now();
    void invoke(options.url, "terminal_write", {
      sessionId: options.interactiveSessionId,
      data: key,
    }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      echoed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.echoTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === null) {
      tracker.cancel();
      if (index >= options.warmupKeystrokes) timeouts += 1;
    } else if (index >= options.warmupKeystrokes) {
      latencies.push(outcome - sentAt);
    }
    await sleep(options.keyIntervalMs);
  }
  report({
    type: "typist-result",
    latencies,
    timeouts,
    streamBytes: stream.bytes(),
    parsedBytes,
    desyncs: stream.desyncs(),
    rssBytes: peakRss(),
  });
  stream.close();
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
  const terminals =
    options.terminalSessionIds.length > 0
      ? await openStream(
          options.url,
          new URLSearchParams({
            excludeEvents: TERMINAL_EVENT_PREFIX,
            includeEvents: options.terminalSessionIds
              .map((id) => `${TERMINAL_EVENT_PREFIX}${id}`)
              .join(","),
          }),
          () => {},
        )
      : null;
  report({ type: "ready" });
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  report({
    type: "observer-result",
    mainBytes: main.bytes(),
    terminalBytes: terminals?.bytes() ?? 0,
    desyncs: terminals?.desyncs() ?? 0,
    transcriptReads,
    transcriptBytes,
    transcriptFailures,
    rssBytes: peakRss(),
  });
  main.close();
  terminals?.close();
}

try {
  if (role === "typist") await runTypist(config as TypistConfig);
  else if (role === "observer") await runObserver(config as ObserverConfig);
  else throw new Error(`unknown role ${role}`);
  process.exit(0);
} catch (error) {
  report({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
