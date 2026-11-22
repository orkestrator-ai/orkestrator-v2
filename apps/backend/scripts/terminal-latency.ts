/**
 * Terminal key-to-echo latency under simultaneous agent and build traffic.
 *
 *   mise exec -- bun apps/backend/scripts/terminal-latency.ts [--only busy] [--json]
 *   mise exec -- bun --cpu-prof-md --cpu-prof-dir output/terminal-latency \
 *     apps/backend/scripts/terminal-latency.ts --only heavy
 *
 * This process plays the backend: the real gateway (`OrkestratorGateway`, SSE
 * fan-out, compression, invoke route), the real `TerminalRuntime` with its
 * replay buffers and durable `TerminalHistory` (headless parser, checkpoints,
 * archive) and real PTYs from `spawnPty`, coalescing included. Browser-like
 * clients run as separate processes (`terminal-latency/client.ts`) so their
 * clocks are not held by this event loop.
 *
 * Each load level adds, all at once:
 * - build terminals: paced, coloured build lines (`terminal-latency/producer.ts`);
 * - tool terminals: a multi-megabyte block every couple of seconds;
 * - agents: a transcript row every `transcriptIntervalMs`, announced with the
 *   real activity event and read back by every observer through the invoke
 *   route, as an open agent tab does;
 * - observers: clients holding the main stream, every terminal's stream and
 *   those transcript reads.
 *
 * One typing client then types into an interactive terminal (`cat` in raw
 * mode, so the echo comes from a user-space process as a shell's would) one
 * key at a time and reports, per level:
 * - key-to-echo percentiles seen by the client, and the backend's share of it
 *   (from `terminal_write` arriving to the echo being emitted);
 * - event-loop lag in this process (a timer chain, see `efficiency/resources.ts`);
 * - checkpoint serializations and snapshot reads per second, snapshot read
 *   latency, and how long each `SerializeAddon.serialize` call held the loop;
 * - terminal throughput, desyncs and memory.
 *
 * Nothing touches a real data directory: every level uses its own temporary
 * directory, an ephemeral loopback port and a random credential that is never
 * printed. Results are aggregates only, never terminal content.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { SerializeAddon } from "@xterm/addon-serialize";
import { configureLogger } from "@orkestrator/protocol/logger";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import { createBackendEmit } from "../src/core/backend-emit.js";
import { spawnPty, type PtyProcess } from "../src/core/pty.js";
import { TerminalRuntime } from "../src/core/terminals/runtime.js";
import { startGateway, type StartedGateway } from "./gateway-frame-costs.js";
import {
  startResourceSampler,
  type ResourceSampler,
} from "../../../scripts/efficiency/resources.ts";
import {
  distribution,
  EchoTracker,
  typingPhaseTimeoutMs,
  parseLatencyArgs,
  USAGE,
  type Distribution,
  type LatencyOptions,
  type LoadLevel,
} from "./terminal-latency/scenario.js";

const COLS = 120;
const ROWS = 32;
const INTERACTIVE = "latency-interactive";
const CLIENT = path.join(import.meta.dir, "terminal-latency", "client.ts");
const PRODUCER = path.join(import.meta.dir, "terminal-latency", "producer.ts");
const TRANSCRIPT_ROWS_KEPT = 50;
const TRANSCRIPT_ROWS_PER_READ = 20;
const CHILD_REPORT_TIMEOUT_MS = 30_000;

/**
 * Times every `SerializeAddon.serialize` call in this process: it is
 * synchronous, so its duration is exactly how long it held the event loop.
 */
const serializeCalls: number[] = [];
let timingSerialize = false;
const serialize = SerializeAddon.prototype.serialize;
SerializeAddon.prototype.serialize = function timedSerialize(
  this: SerializeAddon,
  ...args: Parameters<typeof serialize>
) {
  const started = performance.now();
  try {
    return serialize.apply(this, args);
  } finally {
    if (timingSerialize) serializeCalls.push(performance.now() - started);
  }
};

export type LevelResult = {
  level: LoadLevel;
  keyToEchoMs: Distribution;
  timeouts: number;
  backendEchoMs: Distribution;
  eventLoopLagMs: Distribution;
  checkpointsPerSecond: number;
  snapshotReadsPerSecond: number;
  snapshotReadMs: Distribution;
  typistOutputBytes: number;
  typistParsedBytes: number;
  /** Each `SerializeAddon.serialize` call; one serialization may make several. */
  serializeCallMs: Distribution;
  terminalMiBPerSecond: number;
  transcriptReadsPerSecond: number;
  desyncs: number;
  measuredSeconds: number;
  backendPeakRssMiB: number;
  backendPeakHeapMiB: number;
  typistRssMiB: number;
  historyStateMiB: number;
};

type Child = {
  process: ChildProcessWithoutNullStreams;
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
};

/** A client process whose JSON-line reports can be awaited by type. */
function startClient(
  role: "typist" | "observer",
  config: unknown,
  token: string,
  failure: AbortController,
): Child {
  const child = spawn(process.execPath, [CLIENT, role, JSON.stringify(config)], {
    env: { ...process.env, ORK_LATENCY_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reports: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  let reportedResult = false;
  const fail = (message: string) => failure.abort(new Error(`${role} failed: ${message}`));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let report: Record<string, unknown>;
    try {
      report = JSON.parse(line) as Record<string, unknown>;
    } catch {
      fail("invalid report");
      return;
    }
    if (report.type === "error") {
      fail(String(report.message));
      return;
    }
    reportedResult ||= report.type === `${role}-result`;
    reports.push(report);
    wake?.();
  });
  child.stderr.resume();
  child.on("error", (error) => fail(error.message));
  child.stdin.on("error", (error) => fail(error.message));
  child.once("close", (code) => {
    if (code !== 0 || !reportedResult) fail("exited before a successful result");
  });
  return {
    process: child,
    async next(type, timeoutMs = CHILD_REPORT_TIMEOUT_MS) {
      const deadline = performance.now() + timeoutMs;
      const signal = failure.signal;
      while (true) {
        signal.throwIfAborted();
        const index = reports.findIndex((report) => report.type === type);
        if (index !== -1) return reports.splice(index, 1)[0]!;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`${role} did not report ${type}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, Math.min(remaining, 2_147_483_647));
          function finish() {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            wake = undefined;
            resolve();
          }
          wake = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    },
  };
}

/** A simulated agent: a bounded transcript that grows a row at a time. */
class SimulatedAgent {
  private revision = 0;
  private readonly rows: Array<{ revision: number; message: Record<string, unknown> }> = [];

  constructor(
    readonly sessionId: string,
    private readonly rowBytes: number,
  ) {}

  append(): number {
    this.revision += 1;
    // Every tenth row carries a large tool result, as a test run or a diff does.
    const bytes = this.revision % 10 === 0 ? this.rowBytes * 16 : this.rowBytes;
    const line = `${this.sessionId} step ${this.revision}: tool output line with some detail\n`;
    this.rows.push({
      revision: this.revision,
      message: {
        id: `${this.sessionId}-${this.revision}`,
        role: "assistant",
        createdAt: Date.now(),
        parts: [
          { type: "text", text: `Working on step ${this.revision}.` },
          {
            type: "tool",
            toolName: "Bash",
            state: "completed",
            output: line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes),
          },
        ],
      },
    });
    if (this.rows.length > TRANSCRIPT_ROWS_KEPT) this.rows.shift();
    return this.revision;
  }

  since(revision: number) {
    const messages = this.rows
      .filter((row) => row.revision > revision)
      .slice(-TRANSCRIPT_ROWS_PER_READ)
      .map((row) => row.message);
    return { sessionId: this.sessionId, revision: this.revision, messages };
  }
}

async function runLevel(level: LoadLevel, options: LatencyOptions): Promise<LevelResult> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-terminal-latency-"));
  let checkpoints = 0;
  let measuring = false;
  const runtime = new TerminalRuntime({
    history: {
      serializeHook: (source) => {
        if (source === "checkpoint" && measuring) checkpoints += 1;
      },
    },
  });
  const ptys = new Map<string, PtyProcess>();
  const agents = new Map<string, SimulatedAgent>();
  const timers: ReturnType<typeof setInterval>[] = [];
  const clients: Child[] = [];
  const clientFailure = new AbortController();
  let started: StartedGateway | null = null;
  let sampler: ResourceSampler | undefined;
  let terminalBytes = 0;
  let transcriptReads = 0;
  const backendEcho: number[] = [];
  const snapshotReads: number[] = [];
  const tracker = new EchoTracker();
  const interactiveReady = Promise.withResolvers<void>();
  let waitingForInteractive = true;
  let latestKey = -1;
  let pendingKey: { at: number; measured: boolean } | null = null;

  const backend = {
    invoke: async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case "terminal_write": {
          const at = performance.now();
          const pty = ptys.get(String(args.sessionId));
          if (!pty) return { delivered: false };
          const data = String(args.data ?? "");
          if (args.sessionId === INTERACTIVE) {
            const index = Number.parseInt(data.slice(1, -1), 36);
            if (index > latestKey) {
              latestKey = index;
              tracker.cancel();
              void tracker.expect(data);
              pendingKey = { at, measured: index >= options.warmupKeystrokes };
            }
          }
          pty.write(data);
          return { delivered: true };
        }
        case "get_terminal_state_snapshot": {
          const sessionId = String(args.sessionId);
          if (!ptys.has(sessionId)) return null;
          const inWindow = measuring;
          const at = performance.now();
          const snapshot = options.history
            ? await runtime.history.stateSnapshot(sessionId)
            : { output: runtime.readOutput(sessionId) };
          if (snapshot && inWindow && measuring) snapshotReads.push(performance.now() - at);
          return snapshot;
        }
        case "get_native_agent_live_update": {
          if (measuring) transcriptReads += 1;
          return agents.get(String(args.sessionId))?.since(Number(args.sinceRevision) || 0) ?? null;
        }
        default:
          return null;
      }
    },
  };

  try {
    started = await startGateway(backend);
    const gateway = started.gateway;
    const url = started.url.toString();
    const emit = createBackendEmit((event, payload) => gateway.emit(event, payload), {
      validation: "off",
    });

    const spawnTerminal = (id: string, command: string, args: string[]) => {
      const pty = spawnPty(command, args, { cols: COLS, rows: ROWS, cwd: dataDir });
      ptys.set(id, pty);
      runtime.registerProcess(id, pty);
      if (options.history) {
        runtime.history.configure({
          sessionId: id,
          dataDir,
          stableIdentity: `terminal-latency-${id}`,
          cols: COLS,
          rows: ROWS,
        });
      }
      pty.onExit(({ exitCode }) => {
        clientFailure.abort(new Error(`Terminal ${id} exited during the benchmark (${exitCode})`));
      });
      pty.onData((data) => {
        // The interactive shell emits a single readiness byte only after
        // switching its PTY to raw mode. No writes are sent before then.
        if (id === INTERACTIVE && waitingForInteractive && data === "R") {
          waitingForInteractive = false;
          interactiveReady.resolve();
          return;
        }
        if (measuring) terminalBytes += Buffer.byteLength(data);
        runtime.emitOutput(id, data, emit);
        if (id !== INTERACTIVE || !pendingKey) return;
        const emittedAt = performance.now();
        if (tracker.observe(data, emittedAt)) {
          if (measuring && pendingKey.measured) backendEcho.push(emittedAt - pendingKey.at);
          pendingKey = null;
        }
      });
    };

    spawnTerminal(INTERACTIVE, "/bin/sh", ["-c", "stty raw -echo && printf R && exec cat"]);
    const startup = AbortSignal.any([
      clientFailure.signal,
      AbortSignal.timeout(CHILD_REPORT_TIMEOUT_MS),
    ]);
    await Promise.race([
      interactiveReady.promise,
      new Promise<never>((_resolve, reject) => {
        if (startup.aborted) reject(startup.reason);
        else startup.addEventListener("abort", () => reject(startup.reason), { once: true });
      }),
    ]);
    const loadIds: string[] = [];
    for (let index = 0; index < level.buildTerminals; index += 1) {
      const id = `latency-build-${index}`;
      spawnTerminal(id, process.execPath, [PRODUCER, "build", String(options.buildBytesPerSecond)]);
      loadIds.push(id);
    }
    for (let index = 0; index < level.toolTerminals; index += 1) {
      const id = `latency-tool-${index}`;
      spawnTerminal(id, process.execPath, [
        PRODUCER,
        "tool",
        String(options.toolBurstBytes),
        String(options.toolBurstEveryMs),
      ]);
      loadIds.push(id);
    }
    for (let index = 0; index < level.agents; index += 1) {
      const agent = new SimulatedAgent(`latency-agent-${index}`, options.transcriptRowBytes);
      agents.set(agent.sessionId, agent);
      const timer = setInterval(() => {
        const revision = agent.append();
        gateway.emit(NATIVE_AGENT_ACTIVITY_EVENT, {
          environmentId: `latency-environment-${index}`,
          sessionId: agent.sessionId,
          activity: "running",
          revision,
        });
      }, options.transcriptIntervalMs);
      timers.push(timer);
    }

    for (let index = 0; index < level.observers; index += 1) {
      const observer = startClient(
        "observer",
        { url, terminalSessionIds: [INTERACTIVE, ...loadIds] },
        started.token,
        clientFailure,
      );
      clients.push(observer);
      await observer.next("ready");
    }

    const typist = startClient(
      "typist",
      {
        url,
        interactiveSessionId: INTERACTIVE,
        loadSessionIds: loadIds,
        keystrokes: options.keystrokes,
        warmupKeystrokes: options.warmupKeystrokes,
        keyIntervalMs: options.keyIntervalMs,
        echoTimeoutMs: options.echoTimeoutMs,
        settleMs: options.settleMs,
        parse: options.clientParse,
        cols: COLS,
        rows: ROWS,
      },
      started.token,
      clientFailure,
    );
    clients.push(typist);
    await typist.next(
      "measurement-ready",
      typingPhaseTimeoutMs(options, options.warmupKeystrokes) + options.settleMs,
    );
    sampler = startResourceSampler(options.lagSampleMs);
    serializeCalls.length = 0;
    timingSerialize = true;
    const measuredFrom = performance.now();
    measuring = true;
    typist.process.stdin.write("measure\n");
    await typist.next("measurement-ended", typingPhaseTimeoutMs(options, options.keystrokes));
    measuring = false;
    timingSerialize = false;
    const measuredSeconds = (performance.now() - measuredFrom) / 1000;
    const checkpointCount = checkpoints;
    const resources = sampler.stop();
    sampler = undefined;
    const typed = await typist.next("typist-result");

    let desyncs = Number(typed.desyncs) || 0;
    for (const observer of clients.slice(0, -1)) {
      observer.process.stdin.write("report\n");
      desyncs += Number((await observer.next("observer-result")).desyncs) || 0;
    }

    const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
    return {
      level,
      keyToEchoMs: distribution(typed.latencies as number[]),
      timeouts: Number(typed.timeouts) || 0,
      backendEchoMs: distribution(backendEcho),
      eventLoopLagMs: distribution(resources.lagMs),
      checkpointsPerSecond: Math.round((checkpointCount / measuredSeconds) * 10) / 10,
      snapshotReadsPerSecond: Math.round((snapshotReads.length / measuredSeconds) * 10) / 10,
      snapshotReadMs: distribution(snapshotReads),
      typistOutputBytes: Number(typed.receivedOutputBytes),
      typistParsedBytes: Number(typed.parsedBytes),
      serializeCallMs: distribution(serializeCalls),
      terminalMiBPerSecond: Math.round((terminalBytes / 1024 / 1024 / measuredSeconds) * 10) / 10,
      transcriptReadsPerSecond: Math.round((transcriptReads / measuredSeconds) * 10) / 10,
      desyncs,
      measuredSeconds: Math.round(measuredSeconds * 10) / 10,
      backendPeakRssMiB: mib(resources.peak.rssBytes),
      backendPeakHeapMiB: mib(resources.peak.heapUsedBytes),
      typistRssMiB: mib(Number(typed.rssBytes) || 0),
      historyStateMiB: mib(runtime.history.stats().estimatedStateBytes),
    };
  } finally {
    measuring = false;
    timingSerialize = false;
    sampler?.stop();
    for (const timer of timers) clearInterval(timer);
    for (const client of clients) {
      if (client.process.exitCode === null && client.process.signalCode === null) {
        client.process.kill("SIGTERM");
      }
    }
    await Promise.all(Array.from(ptys.values(), (pty) => pty.terminate().catch(() => false)));
    await runtime.history.flush(true).catch(() => undefined);
    runtime.shutdown();
    await started?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function formatTable(results: readonly LevelResult[]): string {
  const header = [
    "level",
    "load (b/t/a/o)",
    "echo p50/p95/p99/max ms",
    "timeouts",
    "backend p50/p95/p99 ms",
    "loop lag p50/p95/p99/max ms",
    "checkpoints/s",
    "snapshots/s",
    "snapshot p95 ms",
    "serialize p95/max ms",
    "term MiB/s",
    "reads/s",
    "desyncs",
    "rss MiB",
  ];
  const rows = results.map((result) => [
    result.level.name,
    `${result.level.buildTerminals}/${result.level.toolTerminals}/${result.level.agents}/${result.level.observers}`,
    `${result.keyToEchoMs.p50}/${result.keyToEchoMs.p95}/${result.keyToEchoMs.p99}/${result.keyToEchoMs.max}`,
    String(result.timeouts),
    `${result.backendEchoMs.p50}/${result.backendEchoMs.p95}/${result.backendEchoMs.p99}`,
    `${result.eventLoopLagMs.p50}/${result.eventLoopLagMs.p95}/${result.eventLoopLagMs.p99}/${result.eventLoopLagMs.max}`,
    String(result.checkpointsPerSecond),
    String(result.snapshotReadsPerSecond),
    String(result.snapshotReadMs.p95),
    `${result.serializeCallMs.p95}/${result.serializeCallMs.max}`,
    String(result.terminalMiBPerSecond),
    String(result.transcriptReadsPerSecond),
    String(result.desyncs),
    String(result.backendPeakRssMiB),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
  return [
    line(header),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseLatencyArgs(process.argv.slice(2));
  // Backend log lines would interleave with the report; only errors matter here.
  configureLogger({ level: "error" });
  const results: LevelResult[] = [];
  for (const level of options.levels) {
    if (!options.json) process.stderr.write(`level ${level.name}…\n`);
    results.push(await runLevel(level, options));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, cpus: os.cpus().length, bun: Bun.version },
    options: { ...options, levels: undefined },
    results,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatTable(results)}\n`);
}

if (import.meta.main) await main();
