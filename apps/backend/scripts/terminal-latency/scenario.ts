/**
 * Pure parts of the terminal key-to-echo latency benchmark
 * (`apps/backend/scripts/terminal-latency.ts`): load levels, flag parsing,
 * summaries and the incremental SSE frame reader the client processes use.
 * Nothing here starts a process or touches the network, so it is unit-tested
 * directly (`apps/backend/tests/terminal-latency-scenario.test.ts`).
 */

/** One rung of the load ladder. Every field is a count of concurrent producers. */
export type LoadLevel = {
  name: string;
  /** Terminals printing build-style lines (coloured, short) at `buildBytesPerSecond`. */
  buildTerminals: number;
  /** Terminals that dump a large block (a tool's output, a big `cat`) every `toolBurstEveryMs`. */
  toolTerminals: number;
  /** Simulated agents whose transcript changes every `transcriptIntervalMs`. */
  agents: number;
  /** Extra browser-like clients: the main stream, every terminal, transcript reads. */
  observers: number;
};

export type LatencyOptions = {
  levels: LoadLevel[];
  /** Measured keystrokes per level, after the warm-up. */
  keystrokes: number;
  warmupKeystrokes: number;
  /** Pause between one echo arriving and the next key, as a typist would leave. */
  keyIntervalMs: number;
  /** A key not echoed within this is a timeout and counts against the level. */
  echoTimeoutMs: number;
  /** How long load runs before the first measured key, so queues reach steady state. */
  settleMs: number;
  buildBytesPerSecond: number;
  toolBurstBytes: number;
  toolBurstEveryMs: number;
  transcriptIntervalMs: number;
  /** Bytes of tool output in an ordinary transcript row; every tenth row is 16 times larger. */
  transcriptRowBytes: number;
  /** Durable terminal history (headless parser, checkpoints, archive) on or off. */
  history: boolean;
  /**
   * The typing client also parses every terminal it subscribes to with a
   * headless xterm on its own thread, as the renderer does for each mounted
   * terminal tab. Both variants subscribe to the same terminals.
   */
  clientParse: boolean;
  /** Event-loop sampler interval in the backend process. */
  lagSampleMs: number;
  json: boolean;
};

export const DEFAULT_LEVELS: readonly LoadLevel[] = Object.freeze([
  { name: "idle", buildTerminals: 0, toolTerminals: 0, agents: 0, observers: 0 },
  { name: "light", buildTerminals: 1, toolTerminals: 1, agents: 2, observers: 1 },
  { name: "busy", buildTerminals: 3, toolTerminals: 2, agents: 4, observers: 2 },
  { name: "heavy", buildTerminals: 6, toolTerminals: 3, agents: 8, observers: 3 },
]);

export const DEFAULT_OPTIONS: LatencyOptions = Object.freeze({
  levels: [...DEFAULT_LEVELS],
  keystrokes: 200,
  warmupKeystrokes: 10,
  keyIntervalMs: 30,
  echoTimeoutMs: 5_000,
  settleMs: 1_500,
  buildBytesPerSecond: 256 * 1024,
  toolBurstBytes: 2 * 1024 * 1024,
  toolBurstEveryMs: 1_500,
  transcriptIntervalMs: 250,
  transcriptRowBytes: 8 * 1024,
  history: true,
  clientParse: true,
  lagSampleMs: 10,
  json: false,
}) as LatencyOptions;

function positiveInteger(flag: string, value: string | undefined, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} needs a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return parsed;
}

function onOff(flag: string, value: string | undefined): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${flag} takes on or off`);
}

/**
 * A level given on the command line: `name:build,tool,agents,observers`, for
 * example `soak:8,4,8,4`.
 */
export function parseLevel(spec: string): LoadLevel {
  const match = /^([a-z][a-z0-9-]*):(\d+),(\d+),(\d+),(\d+)$/u.exec(spec);
  if (!match) throw new Error(`--level takes name:build,tool,agents,observers, not ${spec}`);
  return {
    name: match[1]!,
    buildTerminals: Number(match[2]),
    toolTerminals: Number(match[3]),
    agents: Number(match[4]),
    observers: Number(match[5]),
  };
}

export const USAGE = `Usage: bun apps/backend/scripts/terminal-latency.ts [options]

Measures how quickly a keystroke typed into one terminal is echoed back to a
browser-like client while other terminals, agents and clients are busy.

  --level name:build,tool,agents,observers   Replace the default ladder (repeatable)
  --only <name>                              Run only the named default level (repeatable)
  --keystrokes <n>                           Measured keys per level (default ${DEFAULT_OPTIONS.keystrokes})
  --key-interval-ms <n>                      Pause between keys (default ${DEFAULT_OPTIONS.keyIntervalMs})
  --settle-ms <n>                            Load warm-up before measuring (default ${DEFAULT_OPTIONS.settleMs})
  --build-bytes-per-second <n>               Rate of each build terminal (default ${DEFAULT_OPTIONS.buildBytesPerSecond})
  --tool-burst-bytes <n>                     Size of each tool burst (default ${DEFAULT_OPTIONS.toolBurstBytes})
  --tool-burst-every-ms <n>                  Gap between tool bursts (default ${DEFAULT_OPTIONS.toolBurstEveryMs})
  --transcript-interval-ms <n>               Gap between an agent's transcript rows (default ${DEFAULT_OPTIONS.transcriptIntervalMs})
  --history on|off                           Durable terminal history (default on)
  --client-parse on|off                      Typing client parses its terminals like the renderer (default on)
  --json                                     Print the full JSON report only
`;

/** Parses the benchmark's flags over {@link DEFAULT_OPTIONS}. */
export function parseLatencyArgs(argv: readonly string[]): LatencyOptions {
  const options: LatencyOptions = { ...DEFAULT_OPTIONS, levels: [...DEFAULT_OPTIONS.levels] };
  const customLevels: LoadLevel[] = [];
  const only: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      index += 1;
      return argv[index];
    };
    switch (flag) {
      case "--level":
        customLevels.push(parseLevel(value() ?? ""));
        break;
      case "--only":
        only.push(value() ?? "");
        break;
      case "--keystrokes":
        options.keystrokes = positiveInteger(flag, value());
        break;
      case "--warmup-keystrokes":
        options.warmupKeystrokes = positiveInteger(flag, value(), true);
        break;
      case "--key-interval-ms":
        options.keyIntervalMs = positiveInteger(flag, value(), true);
        break;
      case "--echo-timeout-ms":
        options.echoTimeoutMs = positiveInteger(flag, value());
        break;
      case "--settle-ms":
        options.settleMs = positiveInteger(flag, value(), true);
        break;
      case "--build-bytes-per-second":
        options.buildBytesPerSecond = positiveInteger(flag, value());
        break;
      case "--tool-burst-bytes":
        options.toolBurstBytes = positiveInteger(flag, value());
        break;
      case "--tool-burst-every-ms":
        options.toolBurstEveryMs = positiveInteger(flag, value());
        break;
      case "--transcript-interval-ms":
        options.transcriptIntervalMs = positiveInteger(flag, value());
        break;
      case "--transcript-row-bytes":
        options.transcriptRowBytes = positiveInteger(flag, value());
        break;
      case "--history":
        options.history = onOff(flag, value());
        break;
      case "--client-parse":
        options.clientParse = onOff(flag, value());
        break;
      case "--lag-sample-ms":
        options.lagSampleMs = positiveInteger(flag, value());
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}\n\n${USAGE}`);
    }
  }
  if (customLevels.length > 0) options.levels = customLevels;
  if (only.length > 0) {
    const unknown = only.filter((name) => !options.levels.some((level) => level.name === name));
    if (unknown.length > 0) throw new Error(`Unknown level ${unknown.join(", ")}`);
    options.levels = options.levels.filter((level) => only.includes(level.name));
  }
  return options;
}

/** Allow each write its full echo timeout, the pacing interval and phase overhead. */
export function typingPhaseTimeoutMs(options: LatencyOptions, keys: number): number {
  return 30_000 + keys * (options.echoTimeoutMs + options.keyIntervalMs);
}

/** Nearest-rank percentile; 0 for no samples. */
export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[rank]!;
}

export type Distribution = { count: number; p50: number; p95: number; p99: number; max: number };

const round = (value: number) => Math.round(value * 100) / 100;

export function distribution(values: readonly number[]): Distribution {
  return {
    count: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(values.reduce((max, value) => Math.max(max, value), 0)),
  };
}

/** One server-sent event as the gateway frames it: `data: {"event","payload"}`. */
export type SseEvent = { event: string; payload: unknown };

/**
 * Splits a byte stream into SSE events. Comments (`: connected`, keepalives)
 * are reported through `onComment`; `id:` lines are ignored. Bounded: a frame
 * that never terminates past `maxFrameChars` throws instead of growing.
 */
export class SseFrameReader {
  private buffer = "";

  constructor(
    private readonly onEvent: (event: SseEvent) => void,
    private readonly onComment: (comment: string) => void = () => {},
    private readonly maxFrameChars = 16 * 1024 * 1024,
  ) {}

  push(text: string): void {
    this.buffer += text;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.frame(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    if (this.buffer.length > this.maxFrameChars) {
      throw new Error("SSE frame exceeded the reader's bound");
    }
  }

  private frame(frame: string): void {
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) this.onComment(line.slice(1).trim());
      else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    if (data.length === 0) return;
    const parsed = JSON.parse(data.join("\n")) as Partial<SseEvent>;
    if (typeof parsed.event !== "string") return;
    this.onEvent({ event: parsed.event, payload: parsed.payload });
  }
}

/** A printable, delimited payload that identifies one write even after a timeout. */
export const echoPayload = (index: number): string => `[${index.toString(36)}]`;

/** Matches one write at a time, including echoes split across output chunks. */
export class EchoTracker {
  private expected: { key: string; resolve: (at: number) => void } | null = null;
  private tail = "";

  expect(key: string): Promise<number> {
    if (this.expected) throw new Error("A key is already outstanding");
    return new Promise((resolve) => {
      this.expected = { key, resolve };
    });
  }

  observe(text: string, at: number): boolean {
    const expected = this.expected;
    if (!expected) return false;
    const output = this.tail + text;
    if (!output.includes(expected.key)) {
      const carry = expected.key.length - 1;
      this.tail = carry > 0 ? output.slice(-carry) : "";
      return false;
    }
    this.cancel();
    expected.resolve(at);
    return true;
  }

  cancel(): void {
    this.expected = null;
    this.tail = "";
  }
}
