/**
 * Supervision workloads: the batched activity sweep, the Files panel tree
 * cache, reviewer and progress probes, and build-pipeline transcript
 * checkpoints. Their counts used to come only from the owning test suites.
 *
 * Every workload drives the real exported backend functions. Bridges are stub
 * `fetch` handlers or stub providers answering with the same protocol helpers
 * a bridge uses; storage runs in a temporary directory that is removed
 * afterwards. Nothing touches a profile, a provider or the network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonBytes } from "./counters.js";
import { textMessages, type FixtureMessage } from "./fixtures.js";
import type { CaseDefinition, WorkloadContext, WorkloadDefinition } from "./harness.js";
import { v2Methods, type Modules as ProjectionModules } from "./workloads-projection.js";

type Json = Record<string, unknown>;
type Summary = NonNullable<ProjectionModules["summary"]>;

async function withTempDir<T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const assistantHistory = (count: number, bytes: number, prefix = "") =>
  textMessages(count, bytes, { prefix }).map((message) => ({
    ...message,
    role: "assistant" as const,
  }));

// --- (k) Batched activity sweep ------------------------------------------------------

interface ActivityProvider {
  observeActivityBatch?: unknown;
}

export async function activitySweepWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const providerModule = await context.load<{
    createNativeAgentProvider: (connection: Json, dependencies: Json) => ActivityProvider;
  }>("apps/backend/src/core/native-agent-provider.ts");
  const reads = await context.loadOptional<{
    readActivityGroup: (options: {
      provider: unknown;
      sessions: readonly { providerSessionId: string }[];
      apply: (session: unknown, read: { state: string }) => Promise<void>;
    }) => Promise<void>;
  }>("apps/backend/src/core/native-agent-activity-reads.ts");
  const batch = await context.loadOptional<{
    SESSION_ACTIVITY_BATCH_PATH: string;
    buildSessionActivityBatchResponse: (
      sessionIds: readonly string[],
      read: (sessionId: string) => unknown,
    ) => Promise<unknown>;
  }>("packages/protocol/src/session-activity-batch.ts");
  const connection = {
    agent: "codex",
    baseUrl: "http://codex.test",
    authToken: "codex-token",
    model: "gpt-5-codex",
    effort: "high",
    requestTimeoutMs: 5_000,
  };
  // The bridge's single-route answer, which the batch route reuses per id.
  const observation = (sessionId: string) => ({
    activity: Number(sessionId.slice(2)) % 4 === 0 ? "working" : "idle",
  });

  const sweep = async (
    sessions: number,
    options: { batchRoute: boolean; sweeps: number },
  ): Promise<Json> => {
    const counters = {
      requests: 0,
      batchRequests: 0,
      batchRejected: 0,
      singleRequests: 0,
      requestBytes: 0,
      responseBytes: 0,
      applied: 0,
      working: 0,
    };
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      counters.requests += 1;
      counters.requestBytes += typeof init.body === "string" ? Buffer.byteLength(init.body) : 0;
      let response: Response;
      if (url.pathname === batch!.SESSION_ACTIVITY_BATCH_PATH) {
        counters.batchRequests += 1;
        if (!options.batchRoute) {
          counters.batchRejected += 1;
          response = new Response("Not found", { status: 404 });
        } else {
          const { sessionIds } = JSON.parse(String(init.body)) as { sessionIds: string[] };
          response = Response.json(
            await batch!.buildSessionActivityBatchResponse(sessionIds, observation),
          );
        }
      } else {
        const match = /^\/session\/([^/]+)\/activity$/.exec(url.pathname);
        if (!match) throw new Error("Unexpected bridge route in the activity sweep");
        counters.singleRequests += 1;
        response = Response.json(observation(decodeURIComponent(match[1]!)));
      }
      counters.responseBytes += Number((await response.clone().arrayBuffer()).byteLength);
      return response;
    }) as typeof globalThis.fetch;
    const provider = providerModule.createNativeAgentProvider(connection, { fetch });
    const group = Array.from({ length: sessions }, (_, index) => ({
      providerSessionId: `s-${index}`,
    }));
    const started = performance.now();
    for (let pass = 0; pass < options.sweeps; pass += 1) {
      await reads!.readActivityGroup({
        provider,
        sessions: group,
        apply: async (_session, read) => {
          counters.applied += 1;
          if (read.state === "working") counters.working += 1;
        },
      });
    }
    return { ...counters, measuredMs: performance.now() - started };
  };

  const unsupported = !reads
    ? "the grouped activity read does not exist at this revision"
    : !batch
      ? "the activity batch route does not exist at this revision"
      : undefined;
  const caseFor = (
    id: string,
    description: string,
    sessions: number,
    options: { batchRoute: boolean; sweeps: number },
  ): CaseDefinition => ({
    id,
    description,
    ...(unsupported
      ? { unsupportedReason: unsupported }
      : {
          run: async () => {
            const { measuredMs, ...counters } = await sweep(sessions, options);
            return {
              counters: counters as Record<string, number>,
              measuredMs: measuredMs as number,
            };
          },
        }),
  });
  return {
    id: "k-activity-sweep",
    title: "Activity sweep: bridge requests per sweep with and without the batch route",
    findings: ["0050-2"],
    fixture: { sessions: "1, 10, 100", workingEvery: 4, provider: "codex HTTP bridge stub" },
    method:
      "Real createNativeAgentProvider and readActivityGroup against a stub fetch that answers POST /sessions/activity with buildSessionActivityBatchResponse and GET /session/:id/activity with the same observation. An older bridge answers 404 on the batch route; the provider caches that verdict for its connection.",
    cases: [
      caseFor("batch-1", "1 session, batch route present", 1, { batchRoute: true, sweeps: 1 }),
      caseFor("batch-10", "10 sessions, batch route present", 10, { batchRoute: true, sweeps: 1 }),
      caseFor("batch-100", "100 sessions, batch route present", 100, {
        batchRoute: true,
        sweeps: 1,
      }),
      caseFor("older-bridge-100", "100 sessions, bridge without the batch route", 100, {
        batchRoute: false,
        sweeps: 1,
      }),
      caseFor(
        "older-bridge-100-x3",
        "100 sessions, three sweeps against a bridge without the batch route",
        100,
        { batchRoute: false, sweeps: 3 },
      ),
    ],
  };
}

// --- (l) File-tree cache -------------------------------------------------------------

interface TreeSnapshots {
  register(target: Json): void;
  hint(key: string): void;
  invalidate(key: string): void;
  read(key: string, request?: Json): Promise<{ digest: string; revision: number }>;
  status(): { entries: number; bodies: number; bytes: number; inFlight: number };
}

export async function fileTreeCacheWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const trees = await context.loadOptional<{
    WorktreeTreeSnapshots: new (options: Json) => TreeSnapshots;
  }>("apps/backend/src/core/worktree-tree-snapshots.ts");
  const metricsModule = await context.loadOptional<{
    RecurringWorkMetrics: new () => {
      snapshot(): { kinds: Record<string, Record<string, number>> };
    };
  }>("apps/backend/src/core/recurring-work-metrics.ts");
  const nodes = 2_000;
  const treeFor = (generation: number) =>
    Array.from({ length: nodes }, (_, index) => ({
      name: `file-${index}${index === nodes - 1 ? `-g${generation}` : ""}.ts`,
      path: `dir-${index % 40}/file-${index}${index === nodes - 1 ? `-g${generation}` : ""}.ts`,
      type: "file",
    }));

  type Step =
    | { kind: "read"; advanceMs: number }
    | { kind: "hint" }
    | { kind: "invalidate"; change: boolean };
  const scenario = (
    id: string,
    description: string,
    qualified: boolean,
    steps: Step[],
  ): CaseDefinition => ({
    id,
    description,
    ...(!trees || !metricsModule
      ? { unsupportedReason: "the tree snapshot owner does not exist at this revision" }
      : {
          run: async () => {
            let clock = 0;
            let generation = 0;
            let walks = 0;
            let walkedNodes = 0;
            const metrics = new metricsModule.RecurringWorkMetrics();
            const owner = new trees.WorktreeTreeSnapshots({
              walk: async () => {
                walks += 1;
                const tree = treeFor(generation);
                walkedNodes += tree.length;
                return tree;
              },
              monotonicNow: () => clock,
              coverage: () => ({ qualified, watcherGeneration: 1 }),
              metrics,
            });
            owner.register({ key: "env-1", kind: "local", admissionTarget: "env-1" });
            const digests = new Set<string>();
            let reads = 0;
            let lastRevision = 0;
            const started = performance.now();
            for (const step of steps) {
              if (step.kind === "read") {
                clock += step.advanceMs;
                const result = await owner.read("env-1");
                reads += 1;
                digests.add(result.digest);
                lastRevision = result.revision;
              } else if (step.kind === "hint") {
                owner.hint("env-1");
              } else {
                if (step.change) generation += 1;
                owner.invalidate("env-1");
              }
            }
            const measuredMs = performance.now() - started;
            const kind = metrics.snapshot().kinds["file-tree-read"] ?? {};
            return {
              counters: {
                reads,
                walks,
                walkedNodes,
                distinctDigests: digests.size,
                finalRevision: lastRevision,
                cacheHits: kind.cacheHits ?? 0,
                cacheMisses: kind.cacheMisses ?? 0,
                joined: kind.coalesced ?? 0,
                retainedBodies: owner.status().bodies,
                retainedBytes: owner.status().bytes,
              },
              measuredMs,
            };
          },
        }),
  });
  const reads = (count: number, advanceMs: number): Step[] =>
    Array.from({ length: count }, () => ({ kind: "read" as const, advanceMs }));
  return {
    id: "l-file-tree-cache",
    title: "Files panel tree cache: walks per read under watcher coverage and age bounds",
    findings: ["0050-2"],
    fixture: { nodes, readsPerCase: 20, maxAgeMs: 3_000 },
    method:
      "Real WorktreeTreeSnapshots with a counting walk and an injected clock. Qualified coverage keeps a body until a hint or mutation; unqualified coverage keeps it for the age bound (3 s). Cache hits, misses and joins come from a private RecurringWorkMetrics instance.",
    cases: [
      scenario("watched-unchanged", "20 reads 1 s apart under qualified watcher coverage", true, [
        ...reads(20, 1_000),
      ]),
      scenario(
        "watched-hint",
        "qualified coverage: read, tree-relevant hint while demanded, 19 reads",
        true,
        [...reads(1, 1_000), { kind: "hint" }, ...reads(19, 1_000)],
      ),
      scenario(
        "watched-mutation",
        "qualified coverage: read, a mutation that changes one node, 19 reads",
        true,
        [...reads(1, 1_000), { kind: "invalidate", change: true }, ...reads(19, 1_000)],
      ),
      scenario("unwatched-age-bound", "20 reads 1 s apart with no qualified watcher", false, [
        ...reads(20, 1_000),
      ]),
    ],
  };
}

// --- (m) Reviewer and progress probes --------------------------------------------------

interface ProgressModule {
  readTranscriptProgressSample(input: Json): Promise<{
    digest: string;
    sourceToken?: string;
    historyRevisionsTracked?: boolean;
  }>;
  compareProgressDigests?: (previous: string | undefined, next: string) => string;
}

interface ReviewerModule {
  readReviewerTranscript(
    provider: unknown,
    providerSessionId: string,
    knownSourceToken: string | undefined,
  ): Promise<{ kind: string; sourceToken?: string; bytes?: number; messages?: unknown[] }>;
}

/** A provider stub over a mutable history, counting each method and what it returned. */
function countingProvider(
  summary: Summary | undefined,
  history: { messages: FixtureMessage[]; revision: number },
) {
  const calls: Record<string, number> = {};
  const returned = { messages: 0, bytes: 0 };
  const methods: Record<string, (...args: never[]) => Promise<unknown>> = {
    // The bridge honours `/messages?limit=`; a whole read passes no limit.
    messages: async (_sessionId: string, options?: { limit?: number }) =>
      options?.limit ? history.messages.slice(-options.limit) : history.messages,
    ...(summary ? v2Methods(summary, history) : {}),
  };
  const provider: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(methods)) {
    calls[name] = 0;
    provider[name] = async (...args: never[]) => {
      calls[name]! += 1;
      const result = await method(...args);
      const messages = Array.isArray(result)
        ? result
        : (result as { messages?: unknown } | undefined)?.messages;
      if (Array.isArray(messages)) {
        returned.messages += messages.length;
        returned.bytes += jsonBytes(messages);
      }
      return result;
    };
  }
  return { provider, calls, returned };
}

function callCounters(calls: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, count] of Object.entries(calls)) out[`calls.${name}`] = count;
  return out;
}

export async function probeWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const progress = await context.loadOptional<ProgressModule>(
    "apps/backend/src/core/transcript-progress.ts",
  );
  const reviewer = await context.loadOptional<ReviewerModule>(
    "apps/backend/src/core/multi-review-reviewer-transcript.ts",
  );
  const summary = await context.loadOptional<Summary>(
    "packages/protocol/src/node/bridge-transcript-summary.ts",
  );
  const historyMessages = 200;
  const messageBytes = 1024;
  const probes = 10;

  const progressCase = (
    id: string,
    description: string,
    options: { snapshotSurface: boolean; moves: boolean },
  ): CaseDefinition => ({
    id,
    description,
    ...(!progress?.readTranscriptProgressSample
      ? { unsupportedReason: "transcript progress samples do not exist at this revision" }
      : options.snapshotSurface && !summary
        ? { unsupportedReason: "v2 summary snapshots do not exist at this revision" }
        : {
            run: async () => {
              const history = {
                messages: assistantHistory(historyMessages, messageBytes),
                revision: 1,
              };
              const { provider, calls, returned } = countingProvider(
                options.snapshotSurface ? summary : undefined,
                history,
              );
              const kinds: Record<string, number> = { unchanged: 0, snapshot: 0, fallback: 0 };
              let known: Json | undefined;
              let previousDigest: string | undefined;
              let digestMoves = 0;
              const started = performance.now();
              for (let index = 0; index <= probes; index += 1) {
                if (options.moves && index > 0) {
                  history.messages.push(
                    ...assistantHistory(1, messageBytes, `moved-${index}-`).map((message) => ({
                      ...message,
                      id: `moved-${index}`,
                    })),
                  );
                  history.revision += 1;
                }
                const sample = await progress.readTranscriptProgressSample({
                  provider,
                  sessionId: "provider-session",
                  ...(known ? { known } : {}),
                  onRead: (kind: string) => {
                    kinds[kind] = (kinds[kind] ?? 0) + 1;
                  },
                });
                if (previousDigest !== undefined && sample.digest !== previousDigest) {
                  digestMoves += 1;
                }
                previousDigest = sample.digest;
                known = sample.sourceToken
                  ? {
                      sourceToken: sample.sourceToken,
                      digest: sample.digest,
                      ...(sample.historyRevisionsTracked ? { historyRevisionsTracked: true } : {}),
                    }
                  : undefined;
              }
              return {
                counters: {
                  probes: probes + 1,
                  "reads.unchanged": kinds.unchanged ?? 0,
                  "reads.snapshot": kinds.snapshot ?? 0,
                  "reads.fallback": kinds.fallback ?? 0,
                  digestMoves,
                  ...callCounters(calls),
                  providerMessagesReturned: returned.messages,
                  providerBytesReturned: returned.bytes,
                },
                measuredMs: performance.now() - started,
              };
            },
          }),
  });

  const reviewerCase = (id: string, description: string, moves: boolean): CaseDefinition => ({
    id,
    description,
    ...(!reviewer?.readReviewerTranscript || !summary
      ? { unsupportedReason: "reviewer summary windows do not exist at this revision" }
      : {
          run: async () => {
            const history = {
              messages: assistantHistory(historyMessages, messageBytes),
              revision: 1,
            };
            const { provider, calls, returned } = countingProvider(summary, history);
            const kinds: Record<string, number> = {};
            let token: string | undefined;
            let bytesToClient = 0;
            const started = performance.now();
            for (let index = 0; index <= probes; index += 1) {
              if (moves && index > 0) {
                history.messages.push({
                  ...assistantHistory(1, messageBytes, `moved-${index}-`)[0]!,
                  id: `moved-${index}`,
                });
                history.revision += 1;
              }
              const read = await reviewer.readReviewerTranscript(
                provider,
                "provider-session",
                token,
              );
              kinds[read.kind] = (kinds[read.kind] ?? 0) + 1;
              bytesToClient += read.bytes ?? 0;
              token = read.sourceToken;
            }
            return {
              counters: {
                reads: probes + 1,
                "reads.unchanged": kinds.unchanged ?? 0,
                "reads.snapshot": kinds.snapshot ?? 0,
                encodedBytesToClient: bytesToClient,
                ...callCounters(calls),
                providerMessagesReturned: returned.messages,
                providerBytesReturned: returned.bytes,
              },
              measuredMs: performance.now() - started,
            };
          },
        }),
  });

  return {
    id: "m-reviewer-progress-probes",
    title: "Reviewer and progress probes: provider reads per probe, unchanged and moved",
    findings: ["0050-2"],
    fixture: { messages: historyMessages, messageBytes, probesAfterBaseline: probes },
    method:
      "Real readTranscriptProgressSample and readReviewerTranscript against a counting stub provider that serves v2 summaries (bridgeTranscriptSummaryUpdate) and honours messages({ limit }). Each probe after the first sends the previous source token; in the moved cases one message is appended before every probe.",
    cases: [
      progressCase("progress-unchanged", "progress probe: baseline, then 10 conditional probes", {
        snapshotSurface: true,
        moves: false,
      }),
      progressCase("progress-moved", "progress probe: baseline, then 10 probes after a change", {
        snapshotSurface: true,
        moves: true,
      }),
      progressCase(
        "progress-legacy",
        "progress probe against a provider without a snapshot surface (tail read)",
        { snapshotSurface: false, moves: false },
      ),
      reviewerCase(
        "reviewer-unchanged",
        "reviewer window: first read, then 10 with its token",
        false,
      ),
      reviewerCase("reviewer-moved", "reviewer window: first read, then 10 after a change", true),
    ],
  };
}

// --- (n) Build-pipeline transcript checkpoints ------------------------------------------

interface PipelineStorage {
  init(): Promise<void>;
  saveBuildPipeline(
    pipelineId: string,
    projectId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<{ revision: number }>;
  buildPipelineTranscriptStats(): Record<string, number>;
}

interface Checkpoints {
  observe(session: Json, messages: readonly unknown[], probe?: unknown): boolean;
  knownProbe(session: Json): unknown;
  matchesProbe(session: Json, sample: unknown): boolean;
  prepare(pipeline: Json): Promise<{ settle(): void }>;
}

export async function pipelineCheckpointWorkload(
  context: WorkloadContext,
): Promise<WorkloadDefinition> {
  const storageModule = await context.load<{
    StorageService: new (dataDir: string) => PipelineStorage;
  }>("apps/backend/src/core/storage.ts");
  const checkpointsModule = await context.loadOptional<{
    BuildPipelineTranscriptCheckpoints: new (storage: unknown) => Checkpoints;
  }>("apps/backend/src/core/build-pipeline-transcript-checkpoints.ts");
  const progress = await context.loadOptional<
    ProgressModule & { hasProgressSnapshot?: (provider: object) => boolean }
  >("apps/backend/src/core/transcript-progress.ts");
  const summary = await context.loadOptional<Summary>(
    "packages/protocol/src/node/bridge-transcript-summary.ts",
  );
  const passes = 20;
  const historyMessages = 200;
  const messageBytes = 1024;
  const statNames = ["commits", "chunkWrites", "chunkBytesWritten", "chunkReads", "fileSyncs"];

  const caseFor = (
    id: string,
    description: string,
    options: { snapshotSurface: boolean; moves: boolean },
  ): CaseDefinition => ({
    id,
    description,
    ...(!checkpointsModule || !progress?.hasProgressSnapshot
      ? { unsupportedReason: "probe-gated transcript checkpoints do not exist at this revision" }
      : options.snapshotSurface && !summary
        ? { unsupportedReason: "v2 summary snapshots do not exist at this revision" }
        : {
            repetitions: 3,
            run: () =>
              withTempDir("orkestrator-efficiency-checkpoints-", async (dataDir) => {
                const storage = new storageModule.StorageService(dataDir);
                await storage.init();
                const checkpoints = new checkpointsModule.BuildPipelineTranscriptCheckpoints(
                  storage,
                );
                const history = {
                  messages: assistantHistory(historyMessages, messageBytes),
                  revision: 1,
                };
                const { provider, calls, returned } = countingProvider(
                  options.snapshotSurface ? summary : undefined,
                  history,
                );
                const session: Json = {
                  phase: "build",
                  iteration: 0,
                  sessionKey: "build-0",
                  sdkSessionId: "provider-session",
                  status: "running",
                  startedAt: "2026-01-01T00:00:00.000Z",
                  label: "build session",
                  messageRevision: 0,
                };
                const pipeline: Json = {
                  id: "pipeline-1",
                  phase: "building",
                  sessions: [session],
                  currentSessionIndex: 0,
                };
                const kinds: Record<string, number> = {};
                let wholeReads = 0;
                let changedPasses = 0;
                let saves = 0;
                let revision: number | undefined;
                const before = storage.buildPipelineTranscriptStats();
                const started = performance.now();
                for (let pass = 0; pass < passes; pass += 1) {
                  if (options.moves && pass > 0) {
                    history.messages.push({
                      ...assistantHistory(1, messageBytes, `moved-${pass}-`)[0]!,
                      id: `moved-${pass}`,
                    });
                    history.revision += 1;
                  }
                  // `refreshMovedTranscript` in build-pipeline-service-supervisor.ts,
                  // reproduced call for call: probe first, whole read only when the
                  // probe moved since the committed copy.
                  let whole: Promise<readonly unknown[]> | undefined;
                  const readWhole = () => {
                    if (!whole) {
                      wholeReads += 1;
                      whole = (provider.messages as (id: string) => Promise<readonly unknown[]>)(
                        "provider-session",
                      );
                    }
                    return whole;
                  };
                  let changed: boolean;
                  if (!progress.hasProgressSnapshot!(provider)) {
                    changed = checkpoints.observe(session, Array.from(await readWhole()));
                  } else {
                    let probe: unknown;
                    try {
                      probe = await progress.readTranscriptProgressSample({
                        provider,
                        sessionId: "provider-session",
                        known: checkpoints.knownProbe(session),
                        fallbackRead: async () => Array.from(await readWhole()),
                        onRead: (kind: string) => {
                          kinds[kind] = (kinds[kind] ?? 0) + 1;
                        },
                      });
                    } catch {
                      probe = undefined;
                    }
                    changed =
                      probe && checkpoints.matchesProbe(session, probe)
                        ? false
                        : checkpoints.observe(session, Array.from(await readWhole()), probe);
                  }
                  if (!changed) continue;
                  // Every pass sits on a persist boundary here: the save the
                  // supervisor would make at its 5 s interval.
                  changedPasses += 1;
                  const checkpoint = await checkpoints.prepare(pipeline);
                  const saved = await storage.saveBuildPipeline(
                    "pipeline-1",
                    "project-1",
                    "",
                    2,
                    pipeline,
                    revision,
                  );
                  checkpoint.settle();
                  revision = saved.revision;
                  saves += 1;
                }
                const measuredMs = performance.now() - started;
                const after = storage.buildPipelineTranscriptStats();
                const stats: Record<string, number> = {};
                for (const name of statNames) {
                  stats[`store.${name}`] = (after[name] ?? 0) - (before[name] ?? 0);
                }
                return {
                  counters: {
                    passes,
                    "probes.unchanged": kinds.unchanged ?? 0,
                    "probes.snapshot": kinds.snapshot ?? 0,
                    "probes.fallback": kinds.fallback ?? 0,
                    wholeReads,
                    changedPasses,
                    saves,
                    ...stats,
                    ...callCounters(calls),
                    providerMessagesReturned: returned.messages,
                    providerBytesReturned: returned.bytes,
                  },
                  measuredMs,
                };
              }),
          }),
  });

  return {
    id: "n-pipeline-checkpoints",
    title: "Build-pipeline transcript checkpoints: whole reads and chunk writes per pass",
    findings: ["0050-2"],
    fixture: { passes, messages: historyMessages, messageBytes },
    method:
      "Real BuildPipelineTranscriptCheckpoints, readTranscriptProgressSample and StorageService in a temporary data directory. Each pass reproduces the supervisor's refreshMovedTranscript (probe, then a whole read only when the probe moved since the committed copy) and saves at a persist boundary when the transcript changed. Store counters are BuildPipelineTranscriptStats deltas.",
    cases: [
      caseFor("unchanged-session", "20 passes over a session that does not move", {
        snapshotSurface: true,
        moves: false,
      }),
      caseFor("moving-session", "20 passes, one message appended before each", {
        snapshotSurface: true,
        moves: true,
      }),
      caseFor(
        "no-snapshot-surface",
        "20 passes over an unchanged session on a provider without the snapshot surface",
        { snapshotSurface: false, moves: false },
      ),
    ],
  };
}
