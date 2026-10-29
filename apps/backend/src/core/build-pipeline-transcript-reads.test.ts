/**
 * How often the build-stage supervisor reads a session's whole transcript.
 *
 * Viewers read the committed copy, which only a save changes, so a stage reads
 * the provider's whole transcript only at a persist boundary (or when a turn
 * ends), and only when a bounded, conditional progress probe shows it moved
 * since that copy. These suites count the reads.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipeline, PipelineSessionPhase } from "@orkestrator/protocol/build-pipeline";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { bridgeTranscriptSummaryUpdate } from "@orkestrator/protocol/node/bridge-transcript-summary";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/node/progressive-transcript";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import { StorageService } from "./storage.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import type {
  ProviderSessionObservation,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import type { BuildPipelineProvider, ProviderStatus } from "./build-pipeline-provider.js";
import {
  TEST_FIX_RESULT,
  TEST_REVIEW_PREPARATION,
  testGeneratedReviewPackage,
} from "./build-pipeline-test-fixtures.js";

type SnapshotOptions = {
  limit: number;
  targetBytes: number;
  knownSourceToken?: string;
  representation?: "summary";
};

/**
 * A provider with a bridge's conditional snapshot surface: the source token
 * moves with every transcript write, and a probe that names the current token
 * is answered `unchanged` without a body.
 */
class ProbingProvider implements BuildPipelineProvider {
  readonly agent = "claude" as const;
  readonly wholeReads: string[] = [];
  readonly tailReads: Array<{ sessionId: string; limit: number }> = [];
  readonly probes: Array<{ sessionId: string; knownSourceToken?: string; unchanged: boolean }> = [];
  structuredResult: StructuredOutputResult<unknown> | null | "absent" = "absent";
  probeError: Error | null = null;
  /** Parts the bounded snapshot cut from its only row (an oversized tail row). */
  omittedParts = 0;
  /** Sessions whose turn is idle while background work it started still runs. */
  readonly backgroundWork = new Set<string>();
  transcriptSnapshot?: (
    sessionId: string,
    options: SnapshotOptions,
  ) => Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> = async (
    sessionId,
    options,
  ) => {
    if (this.probeError) throw this.probeError;
    const sourceToken = `${sessionId}:${this.revisions.get(sessionId) ?? 0}`;
    const unchanged = options.knownSourceToken === sourceToken;
    this.probes.push({
      sessionId,
      ...(options.knownSourceToken ? { knownSourceToken: options.knownSourceToken } : {}),
      unchanged,
    });
    if (unchanged) return { unchanged: true, sourceToken };
    const all = this.transcript(sessionId);
    const messages = all.slice(-options.limit);
    return {
      messages,
      representation: "summary",
      revisedMessages: [],
      sourceToken,
      historyStartIndex: all.length - messages.length,
      complete: messages.length === all.length,
      freshness: "current",
      ...(this.omittedParts > 0 ? { omittedParts: this.omittedParts } : {}),
    };
  };

  private readonly phases = new Map<string, PipelineSessionPhase>();
  private readonly transcripts = new Map<string, unknown[]>();
  private readonly revisions = new Map<string, number>();
  private readonly running = new Set<string>();
  private counter = 0;

  /** Replaces a transcript and moves its source token, as a bridge does. */
  write(sessionId: string, text: string): void {
    this.transcripts.set(sessionId, [{ id: `${sessionId}-reply`, role: "assistant", text }]);
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
  }

  /** Replaces a transcript without moving its token: a change no probe can see. */
  writeUnseen(sessionId: string, text: string): void {
    this.transcripts.set(sessionId, [{ id: `${sessionId}-reply`, role: "assistant", text }]);
  }

  stored(sessionId: string): unknown[] {
    return this.transcript(sessionId);
  }

  wholeReadsOf(sessionId: string): number {
    return this.wholeReads.filter((entry) => entry === sessionId).length;
  }

  probesOf(sessionId: string): ProbingProvider["probes"] {
    return this.probes.filter((entry) => entry.sessionId === sessionId);
  }

  markRunning(sessionId: string): void {
    this.running.add(sessionId);
  }

  markIdle(sessionId: string): void {
    this.running.delete(sessionId);
  }

  registerSession(): void {}

  async createSession(phase: PipelineSessionPhase): Promise<string> {
    const id = `${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    return id;
  }

  async send(sessionId: string): Promise<void> {
    this.running.delete(sessionId);
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    return this.running.has(sessionId) ? "running" : "idle";
  }

  async observeSession(sessionId: string): Promise<ProviderSessionObservation> {
    return {
      status: await this.status(sessionId),
      ...(this.backgroundWork.has(sessionId) ? { backgroundWorkLive: true } : {}),
    };
  }

  async messages(sessionId: string, options?: { limit?: number }): Promise<unknown[]> {
    const all = this.transcript(sessionId);
    if (options?.limit === undefined) {
      this.wholeReads.push(sessionId);
      return all;
    }
    this.tailReads.push({ sessionId, limit: options.limit });
    return all.slice(-options.limit);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if (this.structuredResult !== "absent") {
      return this.structuredResult as StructuredOutputResult<T> | null;
    }
    const phase = this.phases.get(sessionId);
    return {
      ok: true,
      provider: "claude",
      requestId,
      value: (phase === "build" || phase === "fix"
        ? TEST_REVIEW_PREPARATION
        : phase === "address"
          ? TEST_FIX_RESULT
          : { complete: true, rationale: "All criteria pass." }) as T,
    };
  }

  async abort(): Promise<void> {}

  private transcript(sessionId: string): unknown[] {
    return (
      this.transcripts.get(sessionId) ?? [
        { id: `${sessionId}-assistant`, role: "assistant", text: "started" },
      ]
    );
  }
}

type ServiceOptions = ConstructorParameters<typeof BuildPipelineService>[2];

interface Context {
  service: BuildPipelineService;
  storage: StorageService;
  provider: ProbingProvider;
  /** A second service over the same storage: a restarted backend. */
  restart(): BuildPipelineService;
}

async function withService(
  run: (context: Context) => Promise<void>,
  options: ServiceOptions = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-reads-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "build",
    branch: "build",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/build",
    setupScriptsComplete: true,
  });
  const provider = new ProbingProvider();
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (command === "get_environment_uncommitted_paths") {
      return { head: "1".repeat(40), paths: [] } as T;
    }
    if (command === "generate_review_package") return testGeneratedReviewPackage(args) as T;
    if (command === "verify_review_package") return { valid: true } as T;
    if (command === "get_kanban_tasks") return [] as T;
    return undefined as T;
  };
  const services: BuildPipelineService[] = [];
  const create = () => {
    const service = new BuildPipelineService(storage, invoke, {
      autoAdvance: false,
      provider: async () => provider,
      ...options,
    });
    services.push(service);
    return service;
  };
  try {
    await run({ service: create(), storage, provider, restart: create });
  } finally {
    for (const service of services) await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function snapshot(storage: StorageService, id: string): Promise<BuildPipeline> {
  const stored = await storage.getBuildPipeline(id);
  if (!stored) throw new Error("Pipeline disappeared");
  return stored.snapshot as BuildPipeline;
}

/**
 * Opens the build stage, marks its turn running, and runs the first running
 * pass, which reads the whole transcript once to set the probe baseline.
 */
async function startRunning(context: Context): Promise<{ pipelineId: string; sessionId: string }> {
  const { service, storage, provider } = context;
  const started = await service.start({
    taskId: "task-1",
    projectId: "project-1",
    environmentType: "local",
    agentType: "claude",
    taskTitle: "Backend pipeline",
    taskSnapshot: {
      title: "Backend pipeline",
      description: "Move the runner",
      acceptanceCriteria: "No renderer orchestration",
      comments: [],
      images: [],
    },
    existingEnvironmentId: "env-1",
  });
  await service.advanceNow(started.id);
  await service.advanceNow(started.id);
  const building = await snapshot(storage, started.id);
  expect(building.phase).toBe("building");
  const sessionId = building.sessions.at(-1)!.sdkSessionId;
  provider.markRunning(sessionId);
  await service.advanceNow(started.id);
  expect(provider.wholeReadsOf(sessionId)).toBe(1);
  return { pipelineId: started.id, sessionId };
}

async function committedTranscript(
  storage: StorageService,
  pipelineId: string,
  sessionId: string,
): Promise<unknown[]> {
  const pipeline = await snapshot(storage, pipelineId);
  const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sessionId)!;
  const stored = await storage.readBuildPipelineTranscript(pipelineId, session);
  return stored.status === "found" ? stored.messages : [];
}

/** Moves the stall clock eleven minutes into the past. */
async function backdate(storage: StorageService, pipelineId: string): Promise<void> {
  const record = (await storage.getBuildPipeline(pipelineId))!;
  const pipeline = record.snapshot as BuildPipeline;
  const session = pipeline.sessions[pipeline.currentSessionIndex]!;
  const stalledAt = new Date(Date.now() - 11 * 60_000).toISOString();
  session.startedAt = stalledAt;
  session.messagesPersistedAt = stalledAt;
  session.turnStartedAt = stalledAt;
  await storage.saveBuildPipeline(
    record.id,
    record.projectId,
    record.environmentId,
    record.version,
    pipeline,
    record.revision,
  );
}

describe("build stage transcript reads while a turn runs", () => {
  test("reads nothing between persist boundaries while the transcript streams", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        const before = await snapshot(storage, pipelineId);
        const probes = provider.probes.length;

        for (let chunk = 0; chunk < 4; chunk += 1) {
          provider.write(sessionId, `chunk ${chunk}`);
          await service.advanceNow(pipelineId);
        }

        expect(provider.wholeReadsOf(sessionId)).toBe(1);
        expect(provider.probes.length).toBe(probes);
        expect((await snapshot(storage, pipelineId)).backendRevision).toBe(before.backendRevision);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("probes at a boundary but reads no whole transcript when nothing moved", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        const before = await snapshot(storage, pipelineId);
        const probes = provider.probesOf(sessionId).length;

        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(pipelineId);

        expect(provider.wholeReadsOf(sessionId)).toBe(1);
        const conditional = provider.probesOf(sessionId).slice(probes);
        expect(conditional).toHaveLength(3);
        expect(conditional.every((probe) => probe.knownSourceToken && probe.unchanged)).toBe(true);
        // Nothing moved, so nothing was saved either.
        expect((await snapshot(storage, pipelineId)).backendRevision).toBe(before.backendRevision);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("reads and commits a transcript that moved since the committed copy", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        const revision = (await snapshot(storage, pipelineId)).sessions.at(-1)!.messageRevision!;

        provider.write(sessionId, "progress");
        await service.advanceNow(pipelineId);

        expect(provider.wholeReadsOf(sessionId)).toBe(2);
        expect((await snapshot(storage, pipelineId)).sessions.at(-1)!.messageRevision).toBe(
          revision + 1,
        );
        expect(await committedTranscript(storage, pipelineId, sessionId)).toEqual(
          provider.stored(sessionId),
        );
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("re-reads a moved transcript whose checkpoint was never committed", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        const commit = storage.commitBuildPipelineTranscript.bind(storage);
        let failures = 1;
        storage.commitBuildPipelineTranscript = async (input) => {
          if (failures-- > 0) throw new Error("disk full");
          return commit(input);
        };

        provider.write(sessionId, "progress");
        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(2);
        expect(
          (await snapshot(storage, pipelineId)).sessions.at(-1)!.transcriptCheckpointError,
        ).toBe("commit-failed");

        // The provider has not moved since, so the probe matches; but readers
        // never got that copy, so it is read and checkpointed again.
        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(3);
        expect(await committedTranscript(storage, pipelineId, sessionId)).toEqual(
          provider.stored(sessionId),
        );

        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(3);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("an oversized tail row costs one whole read, not two", async () => {
    await withService(
      async (context) => {
        const { service, provider } = context;
        provider.omittedParts = 1;
        const { pipelineId, sessionId } = await startRunning(context);

        provider.write(sessionId, "a very large tool result");
        await service.advanceNow(pipelineId);

        expect(provider.wholeReadsOf(sessionId)).toBe(2);
        expect(provider.tailReads).toEqual([]);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("a restarted backend reads the whole transcript once, then only probes", async () => {
    await withService(
      async (context) => {
        const { provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        const restarted = context.restart();

        await restarted.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(2);
        await restarted.advanceNow(pipelineId);
        await restarted.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(2);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("gates a turn kept alive by background work like a running one", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        provider.markIdle(sessionId);
        provider.backgroundWork.add(sessionId);

        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(1);
        expect((await snapshot(storage, pipelineId)).phase).toBe("building");

        provider.write(sessionId, "the background agent reported");
        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(2);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  test("a provider without the snapshot surface keeps reading the whole transcript", async () => {
    await withService(
      async (context) => {
        const { service, provider } = context;
        provider.transcriptSnapshot = undefined;
        const { pipelineId, sessionId } = await startRunning(context);

        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(pipelineId);

        expect(provider.wholeReadsOf(sessionId)).toBe(4);
        expect(provider.probes).toEqual([]);
      },
      { transcriptPersistIntervalMs: 0 },
    );
  });

  for (const mode of ["v2", "v1", "legacy"] as const) {
    test(`${mode} HTTP checkpoints retain revisions before the probe window`, async () => {
      await withService(
        async (context) => {
          const { service, storage, provider } = context;
          let messages = Array.from({ length: 12 }, (_, index) => ({
            id: `row-${index}`,
            role: "assistant",
            content: `row ${index}`,
            parts: [],
            createdAt: "2026-09-27T00:00:00Z",
          }));
          let revision = 1;
          const wire = httpProvider((url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/messages")) return Response.json({ messages });
            if (parsed.pathname.endsWith("/transcript") && mode !== "legacy") {
              const options = {
                sessionIdentity: "build",
                generation: "g",
                contentEpoch: 1,
                revision,
                complete: true,
                limit: Number(parsed.searchParams.get("limit")),
                targetBytes: Number(parsed.searchParams.get("targetBytes")),
                knownToken: parsed.searchParams.get("knownToken") ?? undefined,
              };
              return Response.json(
                mode === "v2"
                  ? bridgeTranscriptSummaryUpdate(messages, {
                      ...options,
                      revisedMessageIds: revision > 1 ? ["row-0"] : [],
                    })
                  : bridgeTranscriptUpdate(messages, options),
              );
            }
            return new Response("", { status: 404 });
          }, codexConnection);
          provider.transcriptSnapshot = wire.provider.transcriptSnapshot!.bind(wire.provider);
          const countRead = provider.messages.bind(provider);
          provider.messages = async (id, options) => {
            await countRead(id, options);
            return wire.provider.messages(id, options);
          };
          const { pipelineId, sessionId } = await startRunning(context);
          expect(await committedTranscript(storage, pipelineId, sessionId)).toEqual(messages);
          // Summary probes can skip quiet checkpoints; older windows cannot.
          await service.advanceNow(pipelineId);
          expect(provider.wholeReadsOf(sessionId)).toBe(mode === "v2" ? 1 : 2);
          messages = messages.map((row, index) =>
            index === 0 ? { ...row, content: "late tool result" } : row,
          );
          revision += 1;
          await service.advanceNow(pipelineId);
          expect(provider.wholeReadsOf(sessionId)).toBe(mode === "v2" ? 2 : 3);
          expect(await committedTranscript(storage, pipelineId, sessionId)).toEqual(messages);
          const snapshot = await provider.transcriptSnapshot(sessionId, {
            limit: 8,
            targetBytes: 65536,
            representation: "summary",
          });
          expect("unchanged" in snapshot).toBe(false);
          if ("unchanged" in snapshot) throw new Error("Expected legacy snapshot body");
          expect(snapshot.messages).toHaveLength(8);
          if (mode === "v2") expect(snapshot.revisedMessages).toEqual([messages[0]]);
          else expect(snapshot.revisedMessages).toBeUndefined();
          expect(snapshot.sourceToken === undefined).toBe(mode === "legacy");
        },
        { transcriptPersistIntervalMs: 0 },
      );
    });
  }
});

describe("build stage stall warnings under gated reads", () => {
  test("a matching probe keeps the warning; the first pass that sees movement clears it", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        await backdate(storage, pipelineId);

        await service.advanceNow(pipelineId);
        expect((await snapshot(storage, pipelineId)).stallWarning?.sessionId).toBe(sessionId);
        expect(provider.wholeReadsOf(sessionId)).toBe(1);

        // Inside the persist interval, but a shown warning is still probed.
        await service.advanceNow(pipelineId);
        expect((await snapshot(storage, pipelineId)).stallWarning?.sessionId).toBe(sessionId);
        expect(provider.wholeReadsOf(sessionId)).toBe(1);

        provider.write(sessionId, "progress resumed");
        await service.advanceNow(pipelineId);
        expect((await snapshot(storage, pipelineId)).stallWarning).toBeUndefined();
        expect(provider.wholeReadsOf(sessionId)).toBe(2);
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("a failed probe falls back to the whole read, which alone decides progress", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        provider.probeError = new Error("bridge restarting");
        await backdate(storage, pipelineId);

        // Nothing was learned from the probe, and the whole read shows no
        // change: the session has been silent, so it is warned about.
        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(2);
        expect((await snapshot(storage, pipelineId)).stallWarning?.sessionId).toBe(sessionId);

        provider.write(sessionId, "progress resumed");
        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(3);
        expect((await snapshot(storage, pipelineId)).stallWarning).toBeUndefined();
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });
});

describe("build stage transcript reads once a turn ends", () => {
  test("reads the whole transcript when a turn ends, even if the probe saw nothing", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);

        provider.writeUnseen(sessionId, "final answer");
        provider.markIdle(sessionId);
        await service.advanceNow(pipelineId);

        expect(provider.wholeReadsOf(sessionId)).toBe(2);
        expect(await committedTranscript(storage, pipelineId, sessionId)).toEqual(
          provider.stored(sessionId),
        );
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });

  test("only probes while an idle stage waits for its structured result", async () => {
    await withService(
      async (context) => {
        const { service, storage, provider } = context;
        const { pipelineId, sessionId } = await startRunning(context);
        provider.structuredResult = null;
        provider.markIdle(sessionId);

        // The turn ends and the preparation prompt goes out; that turn ends
        // too, and the stage starts waiting for its structured result.
        await service.advanceNow(pipelineId);
        await service.advanceNow(pipelineId);
        const waiting = (await snapshot(storage, pipelineId)).sessions.at(-1)!;
        expect(waiting.structuredWaitStartedAt).toBeDefined();
        const reads = provider.wholeReadsOf(sessionId);

        for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(reads);
        expect(provider.probesOf(sessionId).at(-1)?.unchanged).toBe(true);

        provider.write(sessionId, "a late update");
        await service.advanceNow(pipelineId);
        expect(provider.wholeReadsOf(sessionId)).toBe(reads + 1);
        expect(await committedTranscript(storage, pipelineId, sessionId)).toEqual(
          provider.stored(sessionId),
        );
      },
      { transcriptPersistIntervalMs: 60_000 },
    );
  });
});
