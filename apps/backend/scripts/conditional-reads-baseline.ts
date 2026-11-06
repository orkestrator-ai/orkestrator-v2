/**
 * Baseline for batch E10, conditional reads and deltas (efficiency report
 * parts 0160, 0180 and 0190):
 *
 *   mise exec -- bun apps/backend/scripts/conditional-reads-baseline.ts \
 *     [--seconds 10] [--agents claude,codex,pi] [--out result.json]
 *
 * Runs the real `NativeAgentService` and the real `HttpBridgeProvider`
 * against a fake bridge answered in process through `fetchImpl`. The fake
 * serves its transcript routes with the shared bridge code every bridge uses
 * (`bridgeTranscriptRouteBody`, `RecentlyRevisedRows`), and streams a turn on
 * a timer: the tail row grows every 100 ms, gains a tool part every 2 s and a
 * new model response every 5 s. No provider runs, nothing is billed, the data
 * directory is temporary and no port is bound.
 *
 * Viewers poll like a visible tab, transcript and state together with the
 * tokens they hold, at 500 ms. `lagging` polls every 1.5 s, the way a reader
 * that missed rounds does; `second` is another tab on the same session.
 *
 * Measured, aggregates only (counts, bytes, milliseconds; never content):
 *
 * - 0160: transcript answers per outcome (`delta`, `snapshot`, `unchanged`,
 *   `cached`) per viewer, with the delta ring as built (`ring`) and with it
 *   disabled (`no-ring`, the behaviour before TX-1).
 * - 0180: bridge requests per state poll by route, state bytes read, how many
 *   state bodies were byte-identical to the previous one (what a bridge state
 *   revision could answer `unchanged`), and the cost of the state token hash
 *   with the composer catalogue in it and without.
 * - 0190: bridge transcript requests and bytes while the turn streams, and
 *   what a delta from the backend's `knownToken` would have carried instead,
 *   with how often an 8-entry bridge ring would have held that base.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { configureLogger } from "@orkestrator/protocol/logger";
import { bridgeTranscriptRouteBody } from "@orkestrator/protocol/node/bridge-transcript-routes";
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { HttpBridgeProvider } from "../src/core/http-bridge/index.js";
import { NativeAgentService } from "../src/core/native-agent-service.js";
import { projectionInternals } from "../src/core/native-agent-service-test-collaborators.js";
import { StorageService } from "../src/core/storage.js";
import { collectStreamingSamples } from "./conditional-reads-samples.js";

configureLogger({ level: "error" });

const LIVE_WINDOW = { messages: 100, targetBytes: 512 * 1024 } as const;
const TICK_MS = 100;
const POLL_MS = 500;
const LAGGING_POLL_MS = 1_500;
const BRIDGE_RING = 8;

interface Row {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<Record<string, unknown>>;
  createdAt: string;
}

interface WindowShape {
  name: string;
  rows: number;
  textBytes: number;
  /** Inline tool output per assistant row; over 4 KiB a bridge sends a locator instead. */
  toolBytes: number;
}

const WINDOWS: readonly WindowShape[] = [
  { name: "typical", rows: 60, textBytes: 1_200, toolBytes: 2_000 },
  { name: "full", rows: 100, textBytes: 3_000, toolBytes: 3_800 },
];

const fill = (bytes: number, seed: number) =>
  "abcdefghijklmnopqrstuvwxyz0123456789 "
    .repeat(Math.ceil(bytes / 37) + 1)
    .slice(seed % 37, (seed % 37) + bytes);

function historyRows(shape: WindowShape): Row[] {
  return Array.from({ length: shape.rows }, (_, index) => {
    const assistant = index % 2 === 1;
    return {
      id: `m${index}`,
      role: assistant ? "assistant" : "user",
      content: fill(assistant ? shape.textBytes : 200, index),
      parts: assistant
        ? [
            { type: "text", content: fill(shape.textBytes, index), sourcePartId: `m${index}:0` },
            {
              type: "tool-invocation",
              content: "Read",
              sourcePartId: `m${index}:1`,
              toolUseId: `call-${index}`,
              toolOutput: fill(shape.toolBytes, index + 1),
              toolState: "success",
            },
          ]
        : [],
      createdAt: new Date(Date.UTC(2026, 10, 5, 0, 0, index)).toISOString(),
    };
  });
}

function composerModels(count: number): AgentModel[] {
  return Array.from({ length: count }, (_, index) => ({
    platform: "pi",
    id: `provider-${index % 15}/model-${index}-preview-2026`,
    label: `Model ${index} Preview`,
    providerLabel: `Provider ${index % 15}`,
    description: "A general purpose model with tool use and long context.",
    reasoning: ["off", "minimal", "low", "medium", "high"].map((id) => ({ id, label: id })),
    defaultReasoningId: "medium",
    contextWindow: 200_000,
    supportsImageInput: true,
  })) as AgentModel[];
}

const encode = (value: unknown) => JSON.stringify(value);
const bytesOf = (value: unknown) => Buffer.byteLength(encode(value));

interface RouteCount {
  requests: number;
  bytes: number;
  /** Body identical to the previous answer on this route. */
  repeatBodies: number;
}

/** The bridge, answered in process; counts every request at the boundary. */
class FakeBridge {
  readonly messages: Row[];
  readonly revised = new RecentlyRevisedRows();
  revision = 1;
  status: "idle" | "running" = "idle";
  lastActivity = new Date(0).toISOString();
  readonly routes = new Map<string, RouteCount>();
  private readonly lastBodies = new Map<string, string>();
  /** Windows answered per token, newest last, as a bridge ring would keep them. */
  private readonly sent: Array<{ token: string; rows: Map<string, string> }> = [];
  private readonly sentAll = new Map<string, Map<string, string>>();
  readonly transcript = {
    snapshots: 0,
    unchanged: 0,
    snapshotBytes: 0,
    withKnownToken: 0,
    deltaBytes: 0,
    baseInBridgeRing: 0,
    baseKnownAnywhere: 0,
    changedRows: 0,
    routeMs: 0,
    parseMs: 0,
  };
  tick = 0;
  private tailIndex = -1;

  constructor(
    readonly agent: BuildPipelineAgent,
    shape: WindowShape,
    private readonly composer?: { models: AgentModel[] },
  ) {
    this.messages = historyRows(shape);
  }

  startTurn(): void {
    this.status = "running";
    this.messages.push({
      id: `u${this.messages.length}`,
      role: "user",
      content: "Continue.",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    this.newResponse();
  }

  endTurn(): void {
    this.status = "idle";
    this.changed(this.messages[this.tailIndex]!.id);
  }

  /** One streamed event: the tail grows; sometimes a tool part or a new response. */
  stream(): void {
    this.tick += 1;
    if (this.tick % 50 === 0) this.newResponse();
    const tail = this.messages[this.tailIndex]!;
    const text = tail.parts[tail.parts.length - 1]!;
    if (this.tick % 20 === 0) {
      tail.parts = [
        ...tail.parts,
        {
          type: "tool-invocation",
          content: "Bash",
          sourcePartId: `${tail.id}:${tail.parts.length}`,
          toolUseId: `call-${tail.id}-${tail.parts.length}`,
          toolOutput: fill(2_500, this.tick),
          toolState: "success",
        },
        { type: "text", content: "", sourcePartId: `${tail.id}:${tail.parts.length + 1}` },
      ];
    } else {
      const grown = { ...text, content: `${String(text.content)}${fill(120, this.tick)}` };
      tail.parts = [...tail.parts.slice(0, -1), grown];
      tail.content = String(grown.content);
    }
    this.messages[this.tailIndex] = { ...tail };
    this.changed(tail.id);
  }

  private newResponse(): void {
    this.messages.push({
      id: `a${this.messages.length}`,
      role: "assistant",
      content: "",
      parts: [{ type: "text", content: "", sourcePartId: `a${this.messages.length}:0` }],
      createdAt: new Date().toISOString(),
    });
    this.tailIndex = this.messages.length - 1;
    this.changed(this.messages[this.tailIndex]!.id);
  }

  private changed(id: string): void {
    this.revision += 1;
    this.revised.note(id);
    this.lastActivity = new Date().toISOString();
  }

  private answer(route: string, body: unknown, status = 200): Response {
    const text = encode(body);
    const count = this.routes.get(route) ?? { requests: 0, bytes: 0, repeatBodies: 0 };
    count.requests += 1;
    count.bytes += Buffer.byteLength(text);
    if (this.lastBodies.get(route) === text) count.repeatBodies += 1;
    this.lastBodies.set(route, text);
    this.routes.set(route, count);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }

  private stateBody(): Record<string, unknown> {
    const common = {
      status: this.status,
      title: "Baseline session",
      contextUsage: { usedTokens: 12_000 + this.revision, maxTokens: 200_000 },
      policy: undefined,
    };
    if (this.agent === "claude") {
      // Claude's whole session resource (`bridges/claude-bridge/src/routes/session.ts`).
      return {
        id: "provider-session",
        ...common,
        turnStartedAt: this.status === "running" ? "2026-11-05T00:00:00.000Z" : undefined,
        createdAt: "2026-11-05T00:00:00.000Z",
        lastActivity: this.lastActivity,
        rateLimits: undefined,
        activity: this.status === "running" ? { kind: "responding" } : undefined,
        thinkingTokens: this.status === "running" ? this.revision * 3 : undefined,
        backgroundTasks: {},
        retainedContinuationRequestIds: [],
        completionBlockedByBackgroundTasks: false,
        rewindInProgress: false,
        commandRevision: 1,
      };
    }
    return {
      ...common,
      phase: this.status,
      messageRevision: this.revision,
      engineGeneration: 1,
      ...(this.composer
        ? {
            composer: {
              models: this.composer.models,
              modes: [],
              selectedModelId: this.composer.models[0]?.id,
            },
          }
        : {}),
    };
  }

  /** What a delta from `knownToken` to this window would carry, against what was sent. */
  private accountDelta(knownToken: string | null, body: Record<string, unknown>): void {
    const value = body.value as { messages: Row[]; revisedMessages?: unknown[] } | undefined;
    if (body.status !== "snapshot" || !value) return;
    const rows = new Map(value.messages.map((row) => [row.id, encode(row)] as const));
    const token = String(body.token);
    if (knownToken) {
      this.transcript.withKnownToken += 1;
      const ringBase = this.sent.find((entry) => entry.token === knownToken)?.rows;
      const base = ringBase ?? this.sentAll.get(knownToken);
      if (ringBase) this.transcript.baseInBridgeRing += 1;
      if (base) {
        this.transcript.baseKnownAnywhere += 1;
        let changed = 0;
        let changedBytes = 0;
        for (const [id, encoded] of rows) {
          if (base.get(id) === encoded) continue;
          changed += 1;
          changedBytes += Buffer.byteLength(encoded);
        }
        const envelope = bytesOf({
          ...body,
          value: { ...value, messages: [], revisedMessages: undefined },
        });
        const order = bytesOf([...rows.keys()]);
        const revised = value.revisedMessages ? bytesOf(value.revisedMessages) : 0;
        this.transcript.changedRows += changed;
        this.transcript.deltaBytes += envelope + order + changedBytes + revised;
      }
    }
    this.sent.push({ token, rows });
    if (this.sent.length > BRIDGE_RING) this.sent.shift();
    this.sentAll.set(token, rows);
    if (this.sentAll.size > 512) this.sentAll.delete(this.sentAll.keys().next().value!);
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const segments = url.pathname.split("/").filter(Boolean);
    const route = `${method} /${segments.map((s, i) => (i === 1 && segments[0] === "session" && s !== "create" ? ":id" : s)).join("/")}`;
    if (route === "POST /session/create")
      return this.answer(route, { sessionId: "provider-session" });
    if (route === "GET /session/:id" || route === "GET /session/:id/status") {
      return this.answer(route, this.stateBody());
    }
    if (route === "GET /session/:id/config") {
      return this.answer(route, {
        model: "gpt-5",
        modelReasoningEffort: "medium",
        mode: "build",
        fastMode: false,
      });
    }
    if (route === "GET /session/:id/queue") return this.answer(route, { items: [] });
    if (route === "GET /session/:id/transcript") {
      const startedAt = performance.now();
      const body = bridgeTranscriptRouteBody(
        {
          messages: this.messages,
          sessionIdentity: "provider-session",
          generation: "g1",
          contentEpoch: 1,
          revision: this.revision,
          complete: true,
          revisedMessageIds: this.revised.ids(),
          revisedRowsOverflowVersion: this.revised.overflowVersion,
        },
        (name) => url.searchParams.get(name),
      ) as unknown as Record<string, unknown>;
      this.transcript.routeMs += performance.now() - startedAt;
      if (body.status === "unchanged") this.transcript.unchanged += 1;
      else {
        this.transcript.snapshots += 1;
        this.transcript.snapshotBytes += bytesOf(body);
        const parseStartedAt = performance.now();
        JSON.parse(encode(body));
        this.transcript.parseMs += performance.now() - parseStartedAt;
        this.accountDelta(url.searchParams.get("knownToken"), body);
      }
      return this.answer(route, body);
    }
    if (route === "GET /session/:id/activity") {
      return this.answer(route, { activity: this.status === "running" ? "running" : "idle" });
    }
    if (route === "GET /session/:id/questions") return this.answer(route, { questions: [] });
    if (route === "GET /session/:id/plan-approvals" || route === "GET /session/:id/approvals") {
      return this.answer(route, { approvals: [] });
    }
    if (route === "GET /session/:id/interactions") return this.answer(route, { interactions: [] });
    if (route === "GET /session/:id/steer/dispatch")
      return this.answer(route, { dispatch: "unknown" });
    return this.answer(route, { error: "not served by the baseline bridge" }, 404);
  }) as typeof fetch;
}

interface ViewerCount {
  polls: number;
  transcript: Record<string, number>;
  state: Record<string, number>;
  transcriptBytes: number;
  stateBytes: number;
}

class Viewer {
  transcriptToken: string | undefined;
  stateToken: string | undefined;
  readonly count: ViewerCount = {
    polls: 0,
    transcript: {},
    state: {},
    transcriptBytes: 0,
    stateBytes: 0,
  };
  constructor(
    readonly name: string,
    readonly cadenceMs: number,
    readonly offsetMs: number,
  ) {}
}

const identityFor = (agent: BuildPipelineAgent) => ({
  environmentId: "env-1",
  agent,
  logicalSessionKey: "env-env-1:e10-baseline",
});

async function poll(service: NativeAgentService, agent: BuildPipelineAgent, viewer: Viewer) {
  const identity = identityFor(agent);
  const [transcript, state] = await Promise.all([
    service.getTranscriptUpdate({
      ...identity,
      viewVersion: 1,
      liveWindow: LIVE_WINDOW,
      ...(viewer.transcriptToken ? { knownToken: viewer.transcriptToken } : {}),
    }),
    service.getSessionStateUpdate({
      ...identity,
      viewVersion: 1,
      ...(viewer.stateToken ? { knownToken: viewer.stateToken } : {}),
    }),
  ]);
  viewer.count.polls += 1;
  viewer.count.transcript[transcript.status] =
    (viewer.count.transcript[transcript.status] ?? 0) + 1;
  viewer.count.state[state.status] = (viewer.count.state[state.status] ?? 0) + 1;
  viewer.count.transcriptBytes += bytesOf(transcript);
  viewer.count.stateBytes += bytesOf(state);
  if ("token" in transcript && typeof transcript.token === "string") {
    viewer.transcriptToken = transcript.token;
  }
  if ("token" in state && typeof state.token === "string") viewer.stateToken = state.token;
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

interface ScenarioInput {
  agent: BuildPipelineAgent;
  shape: WindowShape;
  viewers: Array<{ name: string; cadenceMs: number; offsetMs: number }>;
  ring: boolean;
  seconds: number;
  /** Idle seconds after the turn, polled at the quiet backoff's last step. */
  idleSeconds: number;
  composerModels?: number;
}

async function runScenario(input: ScenarioInput) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-e10-baseline-"));
  const composer = input.composerModels
    ? { models: composerModels(input.composerModels) }
    : undefined;
  const bridge = new FakeBridge(input.agent, input.shape, composer);
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
    worktreePath: dataDir,
    setupScriptsComplete: true,
  } as Parameters<StorageService["addEnvironment"]>[0]);
  const provider = new HttpBridgeProvider(
    { agent: input.agent, baseUrl: "http://baseline-bridge.invalid", authToken: "baseline" },
    bridge.fetch,
  );
  const service = new NativeAgentService(
    storage,
    (async (command: string) => {
      throw new Error(`Unexpected backend command: ${command}`);
    }) as never,
    { provider: async () => provider },
  );
  if (!input.ring) {
    // Before TX-1: one cached view per key, so no older base is ever found.
    projectionInternals(service).transcriptDeltaBases.record = () => undefined;
  }
  const viewers = input.viewers.map((v) => new Viewer(v.name, v.cadenceMs, v.offsetMs));
  try {
    await service.ensureSession(identityFor(input.agent));
    // Every viewer starts from a settled first snapshot, as a mounted tab does.
    for (const viewer of viewers) await poll(service, input.agent, viewer);
    for (const viewer of viewers) {
      viewer.count.polls = 0;
      viewer.count.transcript = {};
      viewer.count.state = {};
      viewer.count.transcriptBytes = 0;
      viewer.count.stateBytes = 0;
    }
    bridge.routes.clear();
    Object.assign(bridge.transcript, {
      snapshots: 0,
      unchanged: 0,
      snapshotBytes: 0,
      withKnownToken: 0,
      deltaBytes: 0,
      baseInBridgeRing: 0,
      baseKnownAnywhere: 0,
      changedRows: 0,
      routeMs: 0,
      parseMs: 0,
    });
    const measuredSamples = collectStreamingSamples(
      projectionInternals(service).progressiveMetrics,
    );

    bridge.startTurn();
    const streamTimer = setInterval(() => bridge.stream(), TICK_MS);
    const until = Date.now() + input.seconds * 1_000;
    await Promise.all(
      viewers.map(async (viewer) => {
        await Bun.sleep(viewer.offsetMs);
        while (Date.now() < until) {
          const startedAt = Date.now();
          await poll(service, input.agent, viewer);
          measuredSamples.capture();
          await Bun.sleep(Math.max(0, viewer.cadenceMs - (Date.now() - startedAt)));
        }
      }),
    );
    clearInterval(streamTimer);
    bridge.endTurn();
    const streaming = {
      routes: Object.fromEntries(bridge.routes),
      transcript: { ...bridge.transcript },
      viewers: viewers.map((v) => ({ name: v.name, ...structuredClone(v.count) })),
    };
    measuredSamples.capture();
    const samples = measuredSamples.samples;
    const stateSamples = samples.filter((s) => s.domain === "state" && !s.joined);
    const transcriptSamples = samples.filter((s) => s.domain === "transcript");

    // Idle: the turn is over and the tab is at its quiet backoff (15 s); the
    // window is compressed here, since only the per-poll answer matters.
    bridge.routes.clear();
    const idleViewer = viewers[0]!;
    const idleStart = structuredClone(idleViewer.count);
    for (let index = 0; index < input.idleSeconds; index += 1) {
      await poll(service, input.agent, idleViewer);
    }
    const idle = {
      polls: idleViewer.count.polls - idleStart.polls,
      routes: Object.fromEntries(bridge.routes),
      stateUnchanged: (idleViewer.count.state.unchanged ?? 0) - (idleStart.state.unchanged ?? 0),
      transcriptUnchanged:
        (idleViewer.count.transcript.unchanged ?? 0) - (idleStart.transcript.unchanged ?? 0),
    };

    // State token cost: the hash the backend runs on every state poll, over
    // the view it just built, with its composer and with the composer emptied.
    const stateUpdate = await service.getSessionStateUpdate({
      ...identityFor(input.agent),
      viewVersion: 1,
    });
    let tokenHash: Record<string, number> | undefined;
    if (stateUpdate.status === "snapshot") {
      const view = stateUpdate.value;
      const withoutComposer = { ...view, composer: { ...view.composer, models: [] } };
      const time = (value: unknown) => {
        const runs = 400;
        const startedAt = performance.now();
        for (let index = 0; index < runs; index += 1) {
          createHash("sha256").update(JSON.stringify(value)).digest("base64url");
        }
        return ((performance.now() - startedAt) / runs) * 1_000;
      };
      time(view);
      tokenHash = {
        viewBytes: bytesOf(view),
        composerModels: view.composer?.models.length ?? 0,
        composerBytes: bytesOf(view.composer ?? null),
        hashMicros: round(time(view), 1),
        hashMicrosWithoutModels: round(time(withoutComposer), 1),
      };
    }
    return {
      agent: input.agent,
      window: input.shape.name,
      windowRows: bridge.messages.length,
      ring: input.ring,
      seconds: input.seconds,
      streamTicks: bridge.tick,
      streaming,
      readPhases: {
        state: {
          samples: stateSamples.length,
          sourceMsP50: percentile(
            stateSamples.map((s) => s.sourceMs ?? 0),
            50,
          ),
          normalizeMsP50: percentile(
            stateSamples.map((s) => s.normalizeMs ?? 0),
            50,
          ),
          durationMsP50: percentile(
            stateSamples.map((s) => s.durationMs),
            50,
          ),
        },
        transcript: {
          samples: transcriptSamples.length,
          byOutcome: transcriptSamples.reduce<Record<string, number>>((acc, s) => {
            const label = `${s.cacheTier}:${s.outcome}`;
            acc[label] = (acc[label] ?? 0) + 1;
            return acc;
          }, {}),
          providerSourceMsP50: percentile(
            transcriptSamples
              .filter((s) => s.cacheTier === "provider" && !s.joined)
              .map((s) => s.sourceMs ?? 0),
            50,
          ),
          providerNormalizeMsP50: percentile(
            transcriptSamples
              .filter((s) => s.cacheTier === "provider" && !s.joined)
              .map((s) => s.normalizeMs ?? 0),
            50,
          ),
        },
      },
      idle,
      tokenHash,
    };
  } finally {
    await service.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const { values: args } = parseArgs({
  options: {
    seconds: { type: "string", default: "10" },
    agents: { type: "string", default: "claude,codex,pi" },
    out: { type: "string" },
  },
});
const seconds = Number(args.seconds);
const agents = String(args.agents).split(",") as BuildPipelineAgent[];

const live = { name: "live", cadenceMs: POLL_MS, offsetMs: 0 };
const second = { name: "second", cadenceMs: POLL_MS, offsetMs: 250 };
const lagging = { name: "lagging", cadenceMs: LAGGING_POLL_MS, offsetMs: 100 };
const results = [];
for (const shape of WINDOWS) {
  for (const ring of [true, false]) {
    results.push(
      await runScenario({
        agent: "claude",
        shape,
        viewers: [live, second, lagging],
        ring,
        seconds,
        idleSeconds: 4,
      }),
    );
  }
}
for (const agent of agents) {
  // Pi publishes its whole composer on `/status`: every signed-in provider's
  // models, a handful with one provider and hundreds with an aggregator.
  const shapes = agent === "claude" ? WINDOWS : WINDOWS.slice(0, 1);
  for (const [shape, composerModels] of shapes.flatMap((shape) =>
    (agent === "pi" ? [10, 300] : [undefined]).map((models) => [shape, models] as const),
  )) {
    results.push(
      await runScenario({
        agent,
        shape,
        viewers: [live],
        ring: true,
        seconds,
        idleSeconds: 4,
        composerModels,
      }),
    );
  }
}
const output = JSON.stringify(
  { tickMs: TICK_MS, pollMs: POLL_MS, laggingPollMs: LAGGING_POLL_MS, results },
  null,
  2,
);
if (args.out) await Bun.write(args.out, output);
else process.stdout.write(`${output}\n`);
