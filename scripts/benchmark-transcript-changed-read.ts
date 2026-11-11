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
 * - `legacy-spliced`: the same read encoded the way the gateway writes a
 *   marked result. The first splice measured slower (to-do 6860); the
 *   narrowed one measures faster (to-do 7553, retired), and marking the
 *   command is to-do 7755.
 *
 * Per read it reports CPU time (user + system, `process.cpuUsage`), wall time,
 * and, from a separate instrumented pass, the characters `JSON.stringify`
 * produced and the characters fed to SHA-256. Bun exposes no cumulative
 * allocation counter, so those string volumes stand in for the allocations E11
 * set out to remove.
 *
 * To compare two commits, run the same file on each: check the older commit
 * out and copy this file in. The script uses only APIs present before E11
 * (`39c26627f`), and splices the response through `spliceEncodedJsonBytes`
 * (or the older string `spliceEncodedJson`, before to-do 7553, retired) only
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
 *
 * `--snapshot` (to-do 7553, retired) instead times only the encoding of each
 * progressive scenario's first snapshot, the read a tab pays on open, reload
 * and every snapshot fallback: the gateway's unmarked path (`JSON.stringify`,
 * then the UTF-8 bytes and their length) against its marked path (the splice,
 * to bytes, sized), so both pay what the gateway pays before the write. Rounds
 * alternate between the two and report the median of per-round means, which
 * keeps a busy host's noise out of the comparison. `--gateway` adds the same
 * comparison end to end through a real `OrkestratorGateway` on loopback, so
 * the HTTP write is counted: the marked result against an unmarked copy of it
 * (which the gateway serializes with `JSON.stringify`).
 *
 *   bun scripts/benchmark-transcript-changed-read.ts --snapshot --gateway
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
  spliceEncodedJsonBytes?: (value: unknown) => Buffer | undefined;
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
const snapshotMode = process.argv.includes("--snapshot");
const throughGateway = process.argv.includes("--gateway");

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

/** The gateway's response body for a marked command result, as bytes, as it writes it. */
function responseBody(result: unknown): Buffer {
  if (encoding.spliceEncodedJsonBytes) {
    return encoding.spliceEncodedJsonBytes({ result }) ?? Buffer.from(JSON.stringify({ result }));
  }
  // Before to-do 7553 (retired) the gateway built a string and sized it, then wrote it.
  const spliced = encoding.spliceEncodedJson?.(result);
  const body = spliced === undefined ? JSON.stringify({ result }) : `{"result":${spliced}}`;
  Buffer.byteLength(body);
  return Buffer.from(body);
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
  encode: (result: unknown) => string | Buffer,
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
    run: () =>
      legacyScenario("legacy", nearFullSource(), (result) =>
        Buffer.from(JSON.stringify({ result })),
      ),
  },
  {
    name: "legacy-spliced",
    run: () => legacyScenario("legacy-spliced", nearFullSource(), responseBody),
  },
];

/** The first snapshot a tab receives, marked the way the transcript command marks it. */
async function firstSnapshot(
  name: string,
  source: Source,
  options: { agent?: "codex" | "opencode"; provider?: unknown } = {},
): Promise<{ result: unknown; rows: number }> {
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
    const marked = (
      encoding as { markSpliceableResult?: <T>(value: T) => T }
    ).markSpliceableResult?.(first);
    return { result: marked ?? first, rows: first.value.messages.length };
  });
}

interface SnapshotMeasurement {
  scenario: string;
  rows: number;
  bodyBytes: number;
  stringifyUs: number;
  spliceUs: number;
  gateway?: { stringifyUs: number; spliceUs: number };
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

/**
 * Median over `rounds` of the mean µs per call of each candidate, the
 * candidates alternating round by round so drift on a shared host hits both.
 */
async function alternate(
  candidates: Record<string, () => unknown | Promise<unknown>>,
  rounds: number,
  perRound: number,
): Promise<Record<string, number>> {
  const names = Object.keys(candidates);
  const means: Record<string, number[]> = Object.fromEntries(names.map((name) => [name, []]));
  for (const name of names) {
    for (let index = 0; index < warmup; index += 1) await candidates[name]!();
  }
  let sink = 0;
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const order = roundIndex % 2 === 0 ? names : names.toReversed();
    for (const name of order) {
      const run = candidates[name]!;
      const started = performance.now();
      for (let index = 0; index < perRound; index += 1) {
        const value = await run();
        if (typeof value === "number") sink += value;
      }
      means[name]!.push(((performance.now() - started) * 1_000) / perRound);
    }
  }
  if (sink === -1) console.log(sink);
  return Object.fromEntries(names.map((name) => [name, round(median(means[name]!), 1)]));
}

/** Time the two encodings end to end through a real gateway on loopback. */
async function gatewayTimings(result: unknown): Promise<{ stringifyUs: number; spliceUs: number }> {
  const { OrkestratorGateway } = await import(path.join(core, "../gateway.ts"));
  const { registryCommandAccess } = await import(
    path.join(core, "nodes/workspace-grant-test-support.ts")
  );
  const { Agent, request } = await import("node:http");
  const dataDir = mkdtempSync(path.join(tmpdir(), "ork-snapshot-gateway-bench-"));
  const rendererRoot = path.join(dataDir, "renderer");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(path.join(rendererRoot, "index.html"), "<!doctype html>");
  // A fresh object holding the same rows: the gateway serializes it whole.
  const unmarked = { ...(result as Record<string, unknown>) };
  const token = "snapshot-bench-token-0123456789";
  const gateway = new OrkestratorGateway({
    backend: {
      invoke: async (command: string) =>
        command === "get_native_agent_transcript_update" ? result : unmarked,
      commandAccess: registryCommandAccess,
    },
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: token },
    allowNonTailscaleBind: true,
    legacyPreviewPortAccess: async () => "allowed" as const,
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const info = await gateway.start();
    if (!info) throw new Error("Gateway did not start");
    const url = new URL(`${info.url}__orkestrator/invoke`);
    // Both commands are registered transcript reads; only the first answer is marked.
    const invoke = (command: string) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ command, args: {} });
        const outgoing = request(
          {
            agent,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "accept-encoding": "identity",
            },
          },
          (response) => {
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
            });
            response.on("error", reject);
            response.on("end", () =>
              response.statusCode === 200
                ? resolve(bytes)
                : reject(new Error(`gateway answered ${response.statusCode}`)),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end(body);
      });
    const [spliced, whole] = await Promise.all([
      invoke("get_native_agent_transcript_update"),
      invoke("get_native_agent_live_update"),
    ]);
    if (spliced !== whole) throw new Error(`gateway bodies differ: ${spliced} vs ${whole}`);
    const timed = await alternate(
      {
        splice: () => invoke("get_native_agent_transcript_update"),
        stringify: () => invoke("get_native_agent_live_update"),
      },
      Math.max(10, Math.round(samples / 20)),
      20,
    );
    return { stringifyUs: timed.stringify!, spliceUs: timed.splice! };
  } finally {
    agent.destroy();
    await gateway.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function snapshotEncodings(): Promise<SnapshotMeasurement[]> {
  const snapshotScenarios: Array<{ name: string; take: () => ReturnType<typeof firstSnapshot> }> = [
    { name: "tool-parts", take: () => firstSnapshot("tool-parts", toolPartsSource()) },
    { name: "revised", take: () => firstSnapshot("revised", revisedSource()) },
    { name: "near-full", take: () => firstSnapshot("near-full", nearFullSource()) },
    {
      name: "short-incomplete",
      take: () => firstSnapshot("short-incomplete", shortIncompleteSource()),
    },
    {
      name: "short-incomplete-idle",
      take: () => {
        const source = shortIncompleteSource();
        return firstSnapshot("short-incomplete-idle", source, {
          agent: "opencode",
          provider: interactiveProvider(source, () => 7),
        });
      },
    },
  ];
  const measured: SnapshotMeasurement[] = [];
  for (const scenario of snapshotScenarios) {
    if (onlyScenario && scenario.name !== onlyScenario) continue;
    const { result, rows } = await scenario.take();
    const whole = JSON.stringify({ result });
    if (!responseBody(result).equals(Buffer.from(whole))) {
      throw new Error(`${scenario.name}: splice differs`);
    }
    const timed = await alternate(
      {
        stringify: () => Buffer.from(JSON.stringify({ result })).byteLength,
        splice: () => responseBody(result).byteLength,
      },
      Math.max(10, Math.round(samples / 20)),
      100,
    );
    measured.push({
      scenario: scenario.name,
      rows,
      bodyBytes: Buffer.byteLength(whole),
      stringifyUs: timed.stringify!,
      spliceUs: timed.splice!,
      ...(throughGateway ? { gateway: await gatewayTimings(result) } : {}),
    });
  }
  return measured;
}

if (snapshotMode) {
  const host = { cpu: cpus()[0]?.model ?? "unknown", bun: Bun.version, platform: process.platform };
  const measured = await snapshotEncodings();
  if (asJson) {
    console.log(
      JSON.stringify({ schema: `${BENCHMARK_SCHEMA}.snapshot`, host, measured }, null, 2),
    );
  } else {
    console.log(
      `First-snapshot encoding (${host.cpu}, Bun ${host.bun}; median of per-round means, ${warmup} warm-up calls each)\n`,
    );
    console.log(
      `| Scenario | Rows | Body bytes | JSON.stringify µs | Splice µs |${throughGateway ? " Gateway stringify µs | Gateway splice µs |" : ""}`,
    );
    console.log(`| --- | ---: | ---: | ---: | ---: |${throughGateway ? " ---: | ---: |" : ""}`);
    for (const entry of measured) {
      console.log(
        `| ${entry.scenario} | ${entry.rows} | ${entry.bodyBytes} | ${entry.stringifyUs} | ${entry.spliceUs} |${entry.gateway ? ` ${entry.gateway.stringifyUs} | ${entry.gateway.spliceUs} |` : ""}`,
      );
    }
  }
  process.exit(0);
}

const results: Measurement[] = [];
for (const scenario of scenarios) {
  if (onlyScenario && scenario.name !== onlyScenario) continue;
  results.push(await scenario.run());
}
const bounds = scanBound ? scanBounds(nearFullSource().rows()) : undefined;

const host = { cpu: cpus()[0]?.model ?? "unknown", bun: Bun.version, platform: process.platform };
const splices =
  typeof encoding.spliceEncodedJsonBytes === "function" ||
  typeof encoding.spliceEncodedJson === "function";
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
