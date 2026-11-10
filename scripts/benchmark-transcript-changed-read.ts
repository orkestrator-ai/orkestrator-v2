/**
 * Changed transcript read benchmark (to-do 6260, efficiency batch E11).
 *
 * Times what the backend does for one changed progressive transcript read: the
 * provider fake's tail row moves, the view asks with the token it holds and
 * negotiated part patches, and the answer is encoded the way the gateway
 * writes it. A legacy `getProjection` read is measured beside it. Everything
 * runs in process against a provider fake in a temporary data directory; no
 * bridge, provider process or network is involved, and the default test run
 * never executes this file.
 *
 * Scenarios (row shapes the E11 parts were reasoned about):
 * - `tool-parts`: a 20-row window whose streaming tail row holds 60 inline
 *   tool parts with 4 KiB outputs (part 0350's case);
 * - `revised`: a 100-row window of ~1 KiB rows plus 20 `revisedMessages`, one
 *   of which changes its tool state on every read (part 0340's case);
 * - `near-full`: a 100-row window of ~4 KiB rows, close to the 512 KiB
 *   target, whose last row streams;
 * - `short-incomplete`: an incomplete 60-row window whose raw inline tool
 *   outputs bring it near the bridge's byte bound, so every changed read asks
 *   whether the preview already fills the window (to-do 6861);
 * - `short-incomplete-idle`: the same rows from a provider that answers with
 *   an interactive snapshot and a revision, polled while nothing changes, so
 *   every read reprojects the same revision (to-do 6861);
 * - `legacy`: `getProjection` on the near-full rows (part 0210's case),
 *   encoded with `JSON.stringify` as the gateway writes that command;
 * - `legacy-spliced`: the same read encoded with `spliceEncodedJson`, which
 *   measured slower (to-do 6860), so the command is not marked.
 *
 * Per read it reports CPU time (user + system, `process.cpuUsage`), wall time,
 * and, from a separate instrumented pass, the characters `JSON.stringify`
 * produced and the characters fed to SHA-256. Bun exposes no cumulative
 * allocation counter, so those string volumes stand in for the allocations E11
 * set out to remove.
 *
 * To compare two commits, run the same file on each: check the older commit
 * out and copy this file in. The script uses only APIs present before E11
 * (`39c26627f`), and splices the response through `spliceEncodedJson` only
 * where that exists. Interleave rounds across the trees; on a shared host the
 * run-to-run noise is larger than the gap between back-to-back runs. The
 * method and the figures from 2026-11-05 are in the efficiency index,
 * "Measurement of E11 (to-do 6260)".
 *
 *   bun scripts/benchmark-transcript-changed-read.ts                # Markdown
 *   bun scripts/benchmark-transcript-changed-read.ts --json         # JSON
 *   bun scripts/benchmark-transcript-changed-read.ts --samples=400 --scenario=revised
 *
 * `--scan-bound` additionally times the three linear scans to-do 6260 task 1
 * asks about, each at its worst case (no match in a 100-row window), against
 * the same predicate shapes, as an upper bound on their share of a read.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const core = path.join(import.meta.dir, "../apps/backend/src/core");
const { NativeAgentService } = await import(path.join(core, "native-agent-service.ts"));
const { StorageService } = await import(path.join(core, "storage.ts"));
const { isNormalizedProgressiveMessage } = await import(
  path.join(core, "native-agent-projection-helpers.ts")
);
const encoding = (await import(path.join(core, "native-agent-projection-encoding.ts"))) as {
  spliceEncodedJson?: (value: unknown) => string | undefined;
};

export const BENCHMARK_SCHEMA = "orkestrator.transcript-changed-read-benchmark.v1";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const samples = Number(arg("samples", "300"));
const warmup = Number(arg("warmup", "50"));
const countedReads = Number(arg("counted", "20"));
const onlyScenario = arg("scenario", "");
const asJson = process.argv.includes("--json");
const scanBound = process.argv.includes("--scan-bound");

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
const createdAt = "2026-11-05T00:00:00.000Z";

type Part = Record<string, unknown>;
interface Row {
  id: string;
  role: "assistant" | "user";
  content: string;
  parts: Part[];
  createdAt: string;
}

const fillers = new Map<string, string>();

/**
 * Deterministic filler; repeated characters would understate hashing. Cached,
 * so the fake's own cost stays out of the measured read: a real provider hands
 * over freshly parsed objects, which the fake mirrors, but builds no strings.
 */
function filler(seed: number, length: number): string {
  const key = `${seed}:${length}`;
  const cached = fillers.get(key);
  if (cached !== undefined) return cached;
  let text = "";
  let state = seed + 1;
  while (text.length < length) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    text += state.toString(36);
  }
  text = text.slice(0, length);
  fillers.set(key, text);
  return text;
}

function textRow(id: string, role: Row["role"], content: string, parts: Part[] = []): Row {
  return { id, role, content, parts: [...parts, { type: "text", content }], createdAt };
}

function toolPart(callId: string, output: string, state = "success"): Part {
  return {
    type: "tool-invocation",
    toolUseId: callId,
    toolName: "exec_command",
    content: `Command ${callId}`,
    toolInput: { cmd: `run ${callId}` },
    toolOutput: output,
    toolState: state,
  };
}

/** Every read returns freshly built row objects, as a parsed bridge response would. */
interface Source {
  /** Advance the fake by one streamed revision. */
  stream(): void;
  snapshot(): Record<string, unknown>;
  rows(): Row[];
}

function toolPartsSource(): Source {
  const history = () =>
    Array.from({ length: 19 }, (_, index) =>
      textRow(`m${index}`, index % 2 === 0 ? "user" : "assistant", filler(index, 800)),
    );
  const tools = () =>
    Array.from({ length: 60 }, (_, index) =>
      toolPart(`call-${index}`, filler(1_000 + index, 4_096)),
    );
  let revision = 0;
  const rows = () => [
    ...history(),
    textRow("tail", "assistant", `streaming ${revision} ${filler(0, 200)}`, tools()),
  ];
  return {
    stream: () => {
      revision += 1;
    },
    rows,
    snapshot: () => ({
      messages: rows(),
      complete: true,
      sourceToken: `tool-parts-${revision}`,
      historyEpoch: "1:1",
      freshness: "current",
    }),
  };
}

function revisedSource(): Source {
  const history = () =>
    Array.from({ length: 99 }, (_, index) =>
      textRow(`m${index + 200}`, index % 2 === 0 ? "user" : "assistant", filler(index, 1_000)),
    );
  let revision = 0;
  const revised = () =>
    Array.from({ length: 20 }, (_, index) =>
      textRow(`r${index}`, "assistant", filler(5_000 + index, 600), [
        toolPart(
          `r${index}-call`,
          filler(6_000 + index, 2_048),
          index === 0 ? `state-${revision}` : "success",
        ),
      ]),
    );
  const rows = () => [
    ...history(),
    textRow("tail", "assistant", `streaming ${revision} ${filler(0, 400)}`),
  ];
  return {
    stream: () => {
      revision += 1;
    },
    rows,
    snapshot: () => ({
      messages: rows(),
      historyStartIndex: 200,
      complete: false,
      historyEpoch: "1:1",
      // A provider whose token moves with the tail; the revised row moves too.
      sourceToken: `revised-${revision}`,
      freshness: "current",
      revisedMessages: revised(),
    }),
  };
}

function nearFullSource(): Source {
  const history = () =>
    Array.from({ length: 99 }, (_, index) =>
      textRow(
        `m${index}`,
        index % 2 === 0 ? "user" : "assistant",
        filler(index, 2_000),
        index % 2 === 0 ? [] : [toolPart(`m${index}-call`, filler(9_000 + index, 1_500))],
      ),
    );
  let revision = 0;
  const rows = () => [
    ...history(),
    textRow("tail", "assistant", `streaming ${revision} ${filler(0, 2_000)}`),
  ];
  return {
    stream: () => {
      revision += 1;
    },
    rows,
    snapshot: () => ({
      messages: rows(),
      complete: true,
      sourceToken: `near-full-${revision}`,
      historyEpoch: "1:1",
      freshness: "current",
    }),
  };
}

/**
 * A tool-heavy session whose bridge cut the window by bytes: 60 rows, half of
 * them carrying a ~15 KiB inline tool output, about 480 KB in all, reported
 * `complete: false` with no omitted parts and no summary representation.
 */
function shortIncompleteSource(): Source {
  const history = () =>
    Array.from({ length: 59 }, (_, index) =>
      textRow(
        `m${index + 400}`,
        index % 2 === 0 ? "user" : "assistant",
        filler(index, 400),
        index % 2 === 0 ? [] : [toolPart(`m${index}-call`, filler(12_000 + index, 15_000))],
      ),
    );
  let revision = 0;
  const rows = () => [
    ...history(),
    textRow("tail", "assistant", `streaming ${revision} ${filler(0, 400)}`),
  ];
  return {
    stream: () => {
      revision += 1;
    },
    rows,
    snapshot: () => ({
      messages: rows(),
      complete: false,
      sourceToken: `short-incomplete-${revision}`,
      historyEpoch: "1:1",
      freshness: "current",
    }),
  };
}

interface Counters {
  hydrationReads: number;
}

function codexProvider(source: Source, counters: Counters) {
  return {
    agent: "codex",
    createSession: async () => "provider-session",
    registerSession: () => undefined,
    send: async () => undefined,
    status: async () => "busy",
    messages: async () => {
      counters.hydrationReads += 1;
      return [];
    },
    transcriptSnapshot: async () => source.snapshot(),
    steerSupported: async () => true,
    structured: async () => null,
    abort: async () => undefined,
    dispose: async () => undefined,
  };
}

function opencodeProvider(source: Source) {
  return {
    agent: "opencode",
    createSession: async () => "provider-session",
    registerSession: () => undefined,
    send: async () => undefined,
    status: async () => "busy",
    messages: async () => source.rows(),
    interactiveSnapshot: async () => ({ status: "busy", messages: source.rows() }),
    structured: async () => null,
    abort: async () => undefined,
    dispose: async () => undefined,
  };
}

/** A provider that answers transcript reads with an interactive snapshot and a revision. */
function interactiveProvider(source: Source, revision: () => number) {
  return {
    agent: "opencode",
    createSession: async () => "provider-session",
    registerSession: () => undefined,
    send: async () => undefined,
    status: async () => "idle",
    messages: async () => source.rows(),
    interactiveSnapshot: async () => ({
      status: "idle",
      messages: source.rows(),
      messagesComplete: false,
      providerRevision: revision(),
    }),
    structured: async () => null,
    abort: async () => undefined,
    dispose: async () => undefined,
  };
}

/** The gateway's response body for a command result. */
function responseBody(result: unknown): string {
  const spliced = encoding.spliceEncodedJson?.(result);
  return spliced === undefined ? JSON.stringify({ result }) : `{"result":${spliced}}`;
}

interface Measurement {
  scenario: string;
  reads: number;
  cpuUsPerRead: number;
  wallP50Ms: number;
  wallP95Ms: number;
  stringifiedCharsPerRead: number;
  hashedCharsPerRead: number;
  responseBytes: number;
  windowMessages: number;
  windowBytes: number;
  statuses: Record<string, number>;
  hydrationReads: number;
}

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/** Count what `JSON.stringify` produces and what SHA-256 is fed while `run` executes. */
async function countStrings(
  run: () => Promise<void>,
): Promise<{ stringified: number; hashed: number }> {
  const originalStringify = JSON.stringify;
  const hashPrototype = Object.getPrototypeOf(createHash("sha256")) as {
    update: (data: unknown, ...rest: unknown[]) => unknown;
  };
  const originalUpdate = hashPrototype.update;
  let stringified = 0;
  let hashed = 0;
  JSON.stringify = function (this: unknown, ...args: Parameters<typeof JSON.stringify>) {
    const json = originalStringify.apply(JSON, args);
    if (typeof json === "string") stringified += json.length;
    return json;
  } as typeof JSON.stringify;
  hashPrototype.update = function (this: unknown, data: unknown, ...rest: unknown[]) {
    if (typeof data === "string") hashed += data.length;
    else if (data instanceof Uint8Array) hashed += data.byteLength;
    return originalUpdate.call(this, data, ...rest);
  };
  try {
    await run();
  } finally {
    JSON.stringify = originalStringify;
    hashPrototype.update = originalUpdate;
  }
  return { stringified, hashed };
}

async function withService<T>(
  provider: unknown,
  run: (service: InstanceType<typeof NativeAgentService>) => Promise<T>,
): Promise<T> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ork-changed-read-bench-"));
  let service: InstanceType<typeof NativeAgentService> | undefined;
  try {
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Environment",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: path.join(dataDir, "worktree"),
      setupScriptsComplete: true,
    });
    service = new NativeAgentService(
      storage,
      async (command: string) => {
        throw new Error(`Unexpected backend command: ${command}`);
      },
      { provider: async () => provider, interactionMonitorMode: "disabled" },
    );
    return await run(service);
  } finally {
    try {
      await service?.shutdown();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

async function progressiveScenario(
  name: string,
  source: Source,
  options: { agent?: "codex" | "opencode"; provider?: unknown; idle?: boolean } = {},
): Promise<Measurement> {
  const counters: Counters = { hydrationReads: 0 };
  return withService(options.provider ?? codexProvider(source, counters), async (service) => {
    const identity = {
      environmentId: "env-1",
      agent: options.agent ?? ("codex" as const),
      logicalSessionKey: `env-env-1:${name}`,
    };
    await service.ensureSession(identity);
    const first = await service.getTranscriptUpdate({
      ...identity,
      viewVersion: 1,
      liveWindow,
      forceSnapshot: true,
      patchVersion: 2,
    });
    if (first.status !== "snapshot") throw new Error(`${name}: expected a first snapshot`);
    const windowMessages = first.value.messages.length;
    const windowBytes = Buffer.byteLength(responseBody(first));
    let token: string = first.token;
    const statuses: Record<string, number> = {};
    let responseBytes = 0;
    const read = async () => {
      if (!options.idle) source.stream();
      const update = await service.getTranscriptUpdate({
        ...identity,
        viewVersion: 1,
        liveWindow,
        knownToken: token,
        patchVersion: 2,
      });
      const body = responseBody(update);
      responseBytes = Buffer.byteLength(body);
      statuses[update.status] = (statuses[update.status] ?? 0) + 1;
      if ("token" in update) token = update.token;
    };
    return measure(
      name,
      read,
      statuses,
      () => responseBytes,
      { windowMessages, windowBytes },
      counters,
    );
  });
}

async function legacyScenario(
  name: string,
  source: Source,
  encode: (result: unknown) => string,
): Promise<Measurement> {
  const counters: Counters = { hydrationReads: 0 };
  return withService(opencodeProvider(source), async (service) => {
    const identity = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:legacy",
    };
    await service.ensureSession(identity);
    const first = await service.getProjection(identity);
    const windowMessages = first?.messages.length ?? 0;
    const windowBytes = Buffer.byteLength(encode(first));
    const statuses: Record<string, number> = {};
    let responseBytes = 0;
    let revision = first?.revision ?? 0;
    const read = async () => {
      source.stream();
      const projection = await service.getProjection(identity);
      responseBytes = Buffer.byteLength(encode(projection));
      const status = (projection?.revision ?? 0) > revision ? "changed" : "unchanged";
      revision = projection?.revision ?? revision;
      statuses[status] = (statuses[status] ?? 0) + 1;
    };
    return measure(
      name,
      read,
      statuses,
      () => responseBytes,
      { windowMessages, windowBytes },
      counters,
    );
  });
}

async function measure(
  scenario: string,
  read: () => Promise<void>,
  statuses: Record<string, number>,
  responseBytes: () => number,
  window: { windowMessages: number; windowBytes: number },
  counters: Counters,
): Promise<Measurement> {
  for (let index = 0; index < warmup; index += 1) await read();
  const counted = await countStrings(async () => {
    for (let index = 0; index < countedReads; index += 1) await read();
  });
  for (const key of Object.keys(statuses)) delete statuses[key];
  Bun.gc(true);
  const wall: number[] = [];
  const cpuBefore = process.cpuUsage();
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await read();
    wall.push(performance.now() - started);
  }
  const cpu = process.cpuUsage(cpuBefore);
  return {
    scenario,
    reads: samples,
    cpuUsPerRead: round((cpu.user + cpu.system) / samples, 1),
    wallP50Ms: round(percentile(wall, 0.5)),
    wallP95Ms: round(percentile(wall, 0.95)),
    stringifiedCharsPerRead: Math.round(counted.stringified / countedReads),
    hashedCharsPerRead: Math.round(counted.hashed / countedReads),
    responseBytes: responseBytes(),
    ...window,
    statuses: { ...statuses },
    hydrationReads: counters.hydrationReads,
  };
}

/**
 * Worst-case cost of each scan to-do 6260 task 1 names: a full pass over a
 * 100-row window with no match, using the same predicates as
 * `projectionMessages` (`firstUserMessageIndex`) and the two head lookups
 * (`recoveredHead`, `displayedHead`).
 */
function scanBounds(rows: Row[]): Record<string, number> {
  const window = rows.map((row) => ({ ...row, role: "assistant" as const }));
  const missingHead = { ...window[0]!, id: "not-in-window" };
  const iterations = 20_000;
  const time = (scan: () => unknown) => {
    for (let index = 0; index < 1_000; index += 1) scan();
    const started = performance.now();
    let sink: unknown;
    for (let index = 0; index < iterations; index += 1) sink = scan();
    const elapsed = performance.now() - started;
    if (sink === Symbol.for("never")) console.log(sink);
    return round((elapsed / iterations) * 1_000, 3);
  };
  const firstUser = () =>
    window.findIndex(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).role === "user",
    );
  const headLookup = () =>
    window.find(
      (message) =>
        isNormalizedProgressiveMessage(missingHead) &&
        isNormalizedProgressiveMessage(message) &&
        message.id === missingHead.id,
    );
  return {
    firstUserMessageIndexUs: time(firstUser),
    headLookupUs: time(headLookup),
  };
}

const scenarios: Array<{ name: string; run: () => Promise<Measurement> }> = [
  { name: "tool-parts", run: () => progressiveScenario("tool-parts", toolPartsSource()) },
  { name: "revised", run: () => progressiveScenario("revised", revisedSource()) },
  { name: "near-full", run: () => progressiveScenario("near-full", nearFullSource()) },
  {
    name: "short-incomplete",
    run: () => progressiveScenario("short-incomplete", shortIncompleteSource()),
  },
  {
    name: "short-incomplete-idle",
    run: () => {
      const source = shortIncompleteSource();
      return progressiveScenario("short-incomplete-idle", source, {
        agent: "opencode",
        provider: interactiveProvider(source, () => 7),
        idle: true,
      });
    },
  },
  {
    name: "legacy",
    run: () => legacyScenario("legacy", nearFullSource(), (result) => JSON.stringify({ result })),
  },
  {
    name: "legacy-spliced",
    run: () => legacyScenario("legacy-spliced", nearFullSource(), responseBody),
  },
];

const results: Measurement[] = [];
for (const scenario of scenarios) {
  if (onlyScenario && scenario.name !== onlyScenario) continue;
  results.push(await scenario.run());
}
const bounds = scanBound ? scanBounds(nearFullSource().rows()) : undefined;

const host = { cpu: cpus()[0]?.model ?? "unknown", bun: Bun.version, platform: process.platform };
const splices = typeof encoding.spliceEncodedJson === "function";
if (asJson) {
  console.log(
    JSON.stringify(
      { schema: BENCHMARK_SCHEMA, host, samples, warmup, splices, results, scanBounds: bounds },
      null,
      2,
    ),
  );
} else {
  console.log(
    `Changed transcript read (${host.cpu}, Bun ${host.bun}, ${samples} reads after ${warmup} warm-up)`,
  );
  console.log(`Response encoding: ${splices ? "spliced from memoised rows" : "JSON.stringify"}\n`);
  console.log(
    "| Scenario | Rows | Snapshot bytes | CPU µs/read | Wall p50 ms | Wall p95 ms | Stringified chars/read | Hashed chars/read | Response bytes | Statuses |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const result of results) {
    console.log(
      `| ${result.scenario} | ${result.windowMessages} | ${result.windowBytes} | ${result.cpuUsPerRead} | ${result.wallP50Ms} | ${result.wallP95Ms} | ${result.stringifiedCharsPerRead} | ${result.hashedCharsPerRead} | ${result.responseBytes} | ${Object.entries(
        result.statuses,
      )
        .map(([status, count]) => `${status} ${count}`)
        .join(", ")} |`,
    );
  }
  if (bounds) {
    console.log(
      `\nWorst-case scans over a 100-row window: firstUserMessageIndex ${bounds.firstUserMessageIndexUs} µs, head lookup ${bounds.headLookupUs} µs`,
    );
  }
}
