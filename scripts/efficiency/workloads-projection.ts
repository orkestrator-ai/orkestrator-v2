/**
 * Backend projection workloads through the real `NativeAgentService`:
 * changed-read serialization (E05/E10 backend half), history paging (E07)
 * and the step-14 whole-message delta stream (E05).
 *
 * The provider is an in-memory stub answering with the same protocol helpers
 * a bridge uses, like `native-agent-service-summary-transcripts.test.ts`. It
 * counts calls per provider method; no bridge, network or profile is touched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { countStringifyCalls, jsonBytes } from "./counters.js";
import {
  accountUpserts,
  emptyAccounting,
  holdSnapshot,
  ratio,
  type DeltaAccounting,
} from "./delta-analysis.js";
import {
  FIXTURE_CREATED_AT,
  nestedAgentPart,
  prose,
  textMessages,
  toolResultPart,
  type FixtureMessage,
  type FixturePart,
} from "./fixtures.js";
import type { CaseDefinition, WorkloadContext, WorkloadDefinition } from "./harness.js";

type Json = Record<string, unknown>;
type Protocol = (messages: readonly unknown[], options: Json) => Json;

const LIVE_WINDOW = { messages: 100, targetBytes: 512 * 1024 };
const IDENTITY = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:efficiency",
};

interface Service {
  ensureSession(input: Json): Promise<unknown>;
  getTranscriptUpdate(input: Json): Promise<Json>;
  getProjectionUpdate(input: Json): Promise<Json>;
  getMessagePage(input: Json): Promise<Json>;
  shutdown(): Promise<void>;
}

interface Modules {
  service: new (storage: unknown, invoke: unknown, options: Json) => Service;
  storage: new (dataDir: string) => {
    init(): Promise<void>;
    addEnvironment(value: Json): Promise<unknown>;
  };
  bridgeTranscriptUpdate: Protocol;
  summary?: {
    bridgeTranscriptSummaryUpdate: Protocol;
    bridgeTranscriptPage: (messages: readonly unknown[], options: Json) => Json;
    readBridgeTranscriptDetail: (messages: readonly unknown[], locator: string) => Json;
  };
  patchVersion?: 1;
}

async function loadModules(context: WorkloadContext): Promise<Modules> {
  const service = await context.load<{ NativeAgentService: Modules["service"] }>(
    "apps/backend/src/core/native-agent-service.ts",
  );
  const storage = await context.load<{ StorageService: Modules["storage"] }>(
    "apps/backend/src/core/storage.ts",
  );
  const progressive = await context.load<{ bridgeTranscriptUpdate: Protocol }>(
    "packages/protocol/src/progressive-transcript.ts",
  );
  const summary = await context.loadOptional<NonNullable<Modules["summary"]>>(
    "packages/protocol/src/bridge-transcript-summary.ts",
  );
  // Step 14: present only on trees that implement part-level patches.
  const patches = await context.loadOptional<{ NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION: 1 }>(
    "packages/protocol/src/native-agent-transcript-patch.ts",
  );
  return {
    service: service.NativeAgentService,
    storage: storage.StorageService,
    bridgeTranscriptUpdate: progressive.bridgeTranscriptUpdate,
    ...(summary ? { summary } : {}),
    ...(patches ? { patchVersion: patches.NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } : {}),
  };
}

type CallCounts = Record<string, number>;

/** A provider stub in the shape the service reads, counting each read method. */
function stubProvider(methods: Record<string, (...args: never[]) => Promise<unknown>>) {
  const calls: CallCounts = {};
  const returned = { messages: 0 };
  const counted: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(methods)) {
    calls[name] = 0;
    counted[name] = async (...args: never[]) => {
      calls[name]! += 1;
      const result = await method(...args);
      // Provider volume: how many messages each read handed the backend.
      const messages = Array.isArray(result)
        ? result
        : (result as { messages?: unknown } | undefined)?.messages;
      if (Array.isArray(messages)) returned.messages += messages.length;
      return result;
    };
  }
  const provider = {
    agent: IDENTITY.agent,
    createSession: async () => "provider-session",
    registerSession: () => undefined,
    send: async () => undefined,
    status: async () => "idle",
    structured: async () => null,
    abort: async () => undefined,
    dispose: async () => undefined,
    steerSupported: async () => true,
    messages: async () => [],
    ...counted,
  };
  return { provider, calls, returned };
}

async function withService<T>(
  modules: Modules,
  provider: unknown,
  run: (service: Service) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "orkestrator-efficiency-service-"));
  const storage = new modules.storage(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: IDENTITY.environmentId,
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
  const service = new modules.service(
    storage,
    async (command: string) => {
      throw new Error(`Unexpected backend command: ${command}`);
    },
    { provider: async () => provider },
  );
  try {
    await service.ensureSession(IDENTITY);
    return await run(service);
  } finally {
    await service.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Serves a mutable history the way a v1 bridge does (raw window). */
function v1Snapshot(modules: Modules, history: { messages: unknown[]; revision: number }) {
  return async (
    _sessionId: string,
    options: { limit: number; targetBytes: number; knownSourceToken?: string },
  ) => {
    const update = modules.bridgeTranscriptUpdate(history.messages, {
      sessionIdentity: "provider-session",
      generation: "g1",
      contentEpoch: 1,
      revision: history.revision,
      limit: options.limit,
      targetBytes: options.targetBytes,
      complete: true,
      ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
    });
    // An HTTP bridge provider reports a matching token as `unchanged`.
    if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
    const value = update.value as Json;
    return {
      messages: value.messages,
      historyStartIndex: value.startIndex,
      sourceToken: update.token,
      complete: value.complete,
      generation: "g1",
      historyEpoch: "g1:1",
      freshness: "current",
    };
  };
}

/** Serves summaries, details and pages the way a v2 bridge does. */
function v2Methods(
  summary: NonNullable<Modules["summary"]>,
  history: { messages: unknown[]; revision: number },
) {
  return {
    transcriptSnapshot: async (
      _sessionId: string,
      options: { limit: number; targetBytes: number; knownSourceToken?: string },
    ) => {
      const update = summary.bridgeTranscriptSummaryUpdate(history.messages, {
        sessionIdentity: "provider-session",
        generation: "g1",
        contentEpoch: 1,
        revision: history.revision,
        limit: options.limit,
        targetBytes: options.targetBytes,
        complete: true,
        pages: true,
        ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
      });
      if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
      const value = update.value as Json;
      return {
        messages: value.messages,
        historyStartIndex: value.startIndex,
        sourceToken: update.token,
        complete: value.complete,
        generation: "g1",
        historyEpoch: "g1:1",
        freshness: "current",
        representation: "summary",
        ...(value.historyCursor ? { historyCursor: value.historyCursor } : {}),
      };
    },
    transcriptDetail: async (_sessionId: string, locator: string) => {
      const result = summary.readBridgeTranscriptDetail(history.messages, locator);
      return result.status === "ok"
        ? { status: "ok", detail: result.detail }
        : { status: result.status };
    },
    transcriptPage: async (
      _sessionId: string,
      options: { cursor: string; limit: number; targetBytes: number },
    ) => {
      const page = summary.bridgeTranscriptPage(history.messages, {
        generation: "g1",
        contentEpoch: 1,
        complete: true,
        ...options,
      });
      if (page.status !== "page") return { status: "expired" };
      return {
        status: "page",
        messages: page.messages,
        historyStartIndex: page.startIndex,
        ...(page.nextCursor ? { historyCursor: page.nextCursor } : {}),
        complete: page.complete,
        truncated: page.truncated,
        historyEpoch: "g1:1",
        representation: "summary",
      };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// --- (f) Changed-read serialization -------------------------------------------------

export async function projectionChangedReadWorkload(
  context: WorkloadContext,
): Promise<WorkloadDefinition> {
  const modules = await loadModules(context);
  const run = async () => {
    const history: { messages: FixtureMessage[]; revision: number } = {
      messages: textMessages(100, 200).map((message) => ({
        ...message,
        role: "assistant" as const,
      })),
      revision: 1,
    };
    const { provider } = stubProvider({ transcriptSnapshot: v1Snapshot(modules, history) });
    return withService(modules, provider, async (service) => {
      const read = (knownToken?: string) =>
        service.getTranscriptUpdate({
          ...IDENTITY,
          viewVersion: 1,
          liveWindow: LIVE_WINDOW,
          ...(knownToken ? { knownToken } : {}),
        });
      const first = await read();
      history.messages[99] = { ...history.messages[99]!, content: "streaming more" };
      history.revision += 1;
      const sourceRows = new Set<unknown>(history.messages);
      const projectedRow = (value: unknown) =>
        Boolean(value) &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !sourceRows.has(value) &&
        typeof (value as { id?: unknown }).id === "string" &&
        (value as { role?: unknown }).role === "assistant";
      const started = performance.now();
      const changed = await countStringifyCalls(projectedRow, () => read(String(first.token)));
      const measuredMs = performance.now() - started;
      const unchanged = await countStringifyCalls(projectedRow, () =>
        read(String(changed.result.token)),
      );
      const delta = changed.result.delta as { messageUpserts?: unknown[] } | undefined;
      return {
        counters: {
          changedStatus: String(changed.result.status),
          changedUpserts: delta?.messageUpserts?.length ?? 0,
          changedMessageSerializations: changed.calls,
          unchangedStatus: String(unchanged.result.status),
          unchangedMessageSerializations: unchanged.calls,
        },
        measuredMs,
      };
    });
  };
  return {
    id: "f-projection-changed-read",
    title: "Backend projection: changed read of a 100-message window with one changing tail",
    findings: ["E05"],
    fixture: { messages: 100, contentBytes: 200, changedMessages: 1 },
    method:
      "getTranscriptUpdate with the previous token after the tail changed; JSON.stringify calls on projected assistant rows counted as in native-agent-projection-encoding.test.ts (source rows excluded).",
    cases: [
      { id: "one-tail-change", description: "v1 provider window, revisioned", run, repetitions: 5 },
    ],
  };
}

// --- (i) History paging ---------------------------------------------------------------

export async function historyPagingWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const modules = await loadModules(context);
  const total = 250;
  const history = () => ({
    messages: textMessages(total, 400).map((message) => ({
      ...message,
      role: "assistant" as const,
    })),
    revision: 1,
  });
  const pageAll = async (service: Service, cursor: string | undefined) => {
    let pages = 0;
    let messages = 0;
    while (cursor && pages < 20) {
      const page = await service.getMessagePage({
        ...IDENTITY,
        syncVersion: 1,
        before: cursor,
        limit: 60,
      });
      pages += 1;
      messages += (page.messages as unknown[]).length;
      cursor = page.nextCursor as string | undefined;
    }
    return { pages, messages };
  };
  const joined: CaseDefinition = {
    id: "joined-refresh",
    description: "v1 provider: transcript read, joined sync snapshot for a cursor, then pages",
    run: async () => {
      const source = history();
      const { provider, calls, returned } = stubProvider({
        transcriptSnapshot: v1Snapshot(modules, source),
        interactiveSnapshot: async () => ({
          status: "idle",
          messages: source.messages,
          messagesComplete: true,
        }),
        messages: async () => source.messages,
      });
      return withService(modules, provider, async (service) => {
        const started = performance.now();
        await service.getTranscriptUpdate({
          ...IDENTITY,
          viewVersion: 1,
          liveWindow: LIVE_WINDOW,
          forceSnapshot: true,
        });
        const joinedSnapshot = await service.getProjectionUpdate({
          ...IDENTITY,
          syncVersion: 1,
          liveWindow: LIVE_WINDOW,
          forceSnapshot: true,
        });
        const paged = await pageAll(service, joinedSnapshot.historyCursor as string | undefined);
        const measuredMs = performance.now() - started;
        await settle();
        return {
          counters: { ...paged, ...prefixed(calls), providerMessagesReturned: returned.messages },
          measuredMs,
        };
      });
    },
  };
  const direct: CaseDefinition = {
    id: "direct-page",
    description: "v2 provider: summary transcript read, then direct provider pages",
    ...(modules.summary
      ? {
          run: async () => {
            const source = history();
            const { provider, calls, returned } = stubProvider({
              ...v2Methods(modules.summary!, source),
              interactiveSnapshot: async () => ({
                status: "idle",
                messages: source.messages,
                messagesComplete: true,
              }),
              messages: async () => source.messages,
            });
            return withService(modules, provider, async (service) => {
              const started = performance.now();
              const update = await service.getTranscriptUpdate({
                ...IDENTITY,
                viewVersion: 1,
                liveWindow: LIVE_WINDOW,
                forceSnapshot: true,
              });
              const value = (update.value ?? {}) as Json;
              const paged = await pageAll(service, value.historyCursor as string | undefined);
              const measuredMs = performance.now() - started;
              await settle();
              return {
                counters: {
                  pagingPath: String(value.historyPaging ?? "none"),
                  ...paged,
                  ...prefixed(calls),
                  providerMessagesReturned: returned.messages,
                },
                measuredMs,
              };
            });
          },
        }
      : { unsupportedReason: "direct provider pages do not exist at this revision" }),
  };
  return {
    id: "i-history-paging",
    title: "History paging: provider calls for loading all earlier history",
    findings: ["E07"],
    fixture: { messages: total, messageBytes: 400, liveWindow: 100, pageLimit: 60 },
    method:
      "Real NativeAgentService with a counting stub provider; the joined path mirrors the renderer's Load-earlier bootstrap (forced sync-v1 snapshot, then getMessagePage). Background reads are given 50 ms to land before counting.",
    cases: [joined, direct],
  };
}

function prefixed(calls: CallCounts): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const [name, count] of Object.entries(calls)) {
    out[`calls.${name}`] = count;
    total += count;
  }
  out["calls.total"] = total;
  return out;
}

// --- (j) Step-14 delta stream --------------------------------------------------------

/** One observed state of the changing assistant message at `step`. */
type TailBuilder = (step: number) => FixtureMessage;

const GROWTH_BYTES = 256;
const OBSERVATIONS = 40;
/** ASCII, so a character slice is also a byte slice and every step extends the last. */
const GROWING_TEXT = prose(GROWTH_BYTES * (OBSERVATIONS + 1), "ascii", 11);
const grownText = (step: number) => GROWING_TEXT.slice(0, GROWTH_BYTES * (step + 1));

function assistant(id: string, content: string, parts: FixturePart[]): FixtureMessage {
  return { id, role: "assistant", content, parts, createdAt: FIXTURE_CREATED_AT };
}

export const STEP14_WORKLOADS: Record<string, { description: string; tail: TailBuilder }> = {
  "growing-prose": {
    description: "one message whose single text part grows 256 B per observation",
    tail: (step) => {
      const text = grownText(step);
      return assistant("live", text, [{ type: "text", content: text, sourcePartId: "live-text" }]);
    },
  },
  "completed-tools-plus-growing": {
    description: "30 completed tool parts (2 KiB outputs) plus one text part growing 256 B",
    tail: (step) => {
      const text = grownText(step);
      const tools = Array.from({ length: 30 }, (_, index) =>
        toolResultPart(`tool-${index}`, 2 * 1024),
      );
      return assistant("live", text, [
        ...tools,
        { type: "text", content: text, sourcePartId: "live-text" },
      ]);
    },
  },
  "tool-stream": {
    description: "a tool-heavy turn: 20 completed tool parts, one more completes per observation",
    tail: (step) =>
      assistant(
        "live",
        "working",
        Array.from({ length: 20 + step }, (_, index) => toolResultPart(`tool-${index}`, 2 * 1024)),
      ),
  },
  "nested-agent": {
    description:
      "3 completed tools plus a sub-agent gaining one completed 1 KiB action per observation",
    tail: (step) =>
      assistant("live", "delegating", [
        ...Array.from({ length: 3 }, (_, index) => toolResultPart(`tool-${index}`, 2 * 1024)),
        nestedAgentPart("agent-1", step + 1, 1024, true),
      ]),
  },
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry as Record<string, unknown>)
            .sort()
            .map((key) => [key, (entry as Record<string, unknown>)[key]]),
        )
      : entry,
  );
}

/**
 * The same stream for a client that negotiated part-level patches: decoded
 * bytes of `messageUpserts` plus `messagePatches`, and whether the client's
 * applied view still equals a fresh snapshot at the end.
 */
async function patchedStream(
  modules: Modules,
  prefix: readonly FixtureMessage[],
  tail: TailBuilder,
  patchVersion: 1,
): Promise<{ deltas: number; snapshots: number; decodedBytes: number; matches: boolean }> {
  const source = { messages: [...prefix, tail(0)] as unknown[], revision: 1 };
  const methods = modules.summary
    ? v2Methods(modules.summary, source)
    : { transcriptSnapshot: v1Snapshot(modules, source) };
  const { provider } = stubProvider(methods);
  const { applyNativeAgentTranscriptDelta } =
    (await import("../../packages/protocol/src/native-agent.ts")) as {
      applyNativeAgentTranscriptDelta: (view: unknown, delta: unknown) => unknown;
    };
  return withService(modules, provider, async (service) => {
    const read = (knownToken?: string) =>
      service.getTranscriptUpdate({
        ...IDENTITY,
        viewVersion: 1,
        liveWindow: LIVE_WINDOW,
        patchVersion,
        ...(knownToken ? { knownToken } : {}),
      });
    let update = await read();
    let token = String(update.token);
    let view = JSON.parse(JSON.stringify(update.value)) as unknown;
    let deltas = 0;
    let snapshots = 0;
    let decodedBytes = 0;
    for (let step = 1; step <= OBSERVATIONS; step += 1) {
      source.messages = [...prefix, tail(step)];
      source.revision += 1;
      update = await read(token);
      if (update.status === "delta") {
        deltas += 1;
        const delta = JSON.parse(JSON.stringify(update.delta)) as Json;
        decodedBytes +=
          jsonBytes(delta.messageUpserts ?? []) + jsonBytes(delta.messagePatches ?? []);
        view = applyNativeAgentTranscriptDelta(view, delta);
      } else if (update.status === "snapshot") {
        snapshots += 1;
        view = JSON.parse(JSON.stringify(update.value));
      }
      if (update.token) token = String(update.token);
    }
    const fresh = await service.getTranscriptUpdate({
      ...IDENTITY,
      viewVersion: 1,
      liveWindow: LIVE_WINDOW,
      forceSnapshot: true,
    });
    // Patched messages rebuild their fields in a different key order; compare
    // content, not serialization order.
    const matches =
      canonicalJson((view as Json | null)?.messages) ===
      canonicalJson((fresh.value as Json).messages);
    return { deltas, snapshots, decodedBytes, matches };
  });
}

export async function step14Workload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const modules = await loadModules(context);
  const caseFor = (id: string, tail: TailBuilder, description: string): CaseDefinition => ({
    id,
    description,
    repetitions: 3,
    run: async () => {
      const prefix = textMessages(20, 1024).map((message) => ({
        ...message,
        role: "assistant" as const,
      }));
      const source = { messages: [...prefix, tail(0)] as unknown[], revision: 1 };
      const methods = modules.summary
        ? v2Methods(modules.summary, source)
        : { transcriptSnapshot: v1Snapshot(modules, source) };
      const { provider } = stubProvider(methods);
      return withService(modules, provider, async (service) => {
        const held = new Map<string, Record<string, unknown>>();
        const accounting: DeltaAccounting = emptyAccounting();
        let snapshots = 0;
        let snapshotBytes = 0;
        let deltas = 0;
        const read = (knownToken?: string) =>
          service.getTranscriptUpdate({
            ...IDENTITY,
            viewVersion: 1,
            liveWindow: LIVE_WINDOW,
            ...(knownToken ? { knownToken } : {}),
          });
        let update = await read();
        let token = String(update.token);
        holdSnapshot(held, ((update.value as Json).messages as unknown[]) ?? []);
        const started = performance.now();
        for (let step = 1; step <= OBSERVATIONS; step += 1) {
          source.messages = [...prefix, tail(step)];
          source.revision += 1;
          update = await read(token);
          if (update.status === "delta") {
            deltas += 1;
            accountUpserts(accounting, held, (update.delta as Json).messageUpserts as unknown[]);
          } else if (update.status === "snapshot") {
            snapshots += 1;
            const messages = ((update.value as Json).messages as unknown[]) ?? [];
            snapshotBytes += jsonBytes(messages);
            holdSnapshot(held, messages);
          }
          if (update.token) token = String(update.token);
        }
        const measuredMs = performance.now() - started;
        const patched = modules.patchVersion
          ? await patchedStream(modules, prefix, tail, modules.patchVersion)
          : undefined;
        const repeatedAny =
          accounting.identicalPartBytes +
          accounting.grownPartPrefixBytes +
          accounting.contentPrefixBytes +
          accounting.nestedIdenticalChildBytes;
        return {
          counters: {
            provider: modules.summary ? "v2-summary" : "v1-raw",
            observations: OBSERVATIONS,
            deltas,
            snapshots,
            snapshotBytes,
            ...accounting,
            identicalPartFraction: ratio(
              accounting.identicalPartBytes,
              accounting.decodedUpsertBytes,
            ),
            anyRepeatedFraction: ratio(repeatedAny, accounting.decodedUpsertBytes),
            ...(patched
              ? {
                  patchedDeltas: patched.deltas,
                  patchedSnapshots: patched.snapshots,
                  patchedDecodedBytes: patched.decodedBytes,
                  patchedToWholeRatio: ratio(patched.decodedBytes, accounting.decodedUpsertBytes),
                  patchedClientMatchesSnapshot: patched.matches,
                }
              : {}),
          },
          measuredMs,
        };
      });
    },
  });
  return {
    id: "j-step14-delta-stream",
    title: "Step 14 gate: repeated unchanged part content in whole-message deltas",
    findings: ["E05"],
    fixture: {
      prefixMessages: 20,
      prefixBytes: 1024,
      observations: OBSERVATIONS,
      growthBytes: GROWTH_BYTES,
    },
    method:
      "Real getTranscriptUpdate over a fake summary provider (v1 raw where summaries do not exist). A client applies every delta; decoded bytes are the UTF-8 JSON of messageUpserts. identicalPartFraction = bytes of top-level parts byte-identical to the client's previous copy of the same part / decoded upsert bytes (the step-14 gate). anyRepeatedFraction adds grown-text prefixes, the content mirror and identical nested children.",
    cases: Object.entries(STEP14_WORKLOADS).map(([id, entry]) =>
      caseFor(id, entry.tail, entry.description),
    ),
  };
}
