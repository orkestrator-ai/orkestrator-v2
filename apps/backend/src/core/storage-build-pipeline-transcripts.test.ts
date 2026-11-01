/**
 * Build-pipeline transcripts stored apart from the workflow control record
 * (plan step 16): legacy migration, deletion, crash points, the atomic
 * control-plus-manifest commit, the size bound that used to block control
 * writes, and admission uniqueness.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import {
  BUILD_PIPELINE_TRANSCRIPT_DIRECTORY,
  transcriptPipelineTag,
} from "./build-pipeline-transcript-store.js";
import { BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE } from "./build-pipeline-transcript-layout.js";
import { BuildPipelineTranscriptCheckpoints } from "./build-pipeline-transcript-checkpoints.js";
import { writeLegacyTranscriptSession } from "./build-pipeline-transcript-test-fixtures.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";
import { openBackendDatabase } from "./storage-stores.js";
import {
  readStoredValue,
  seedStore,
  seedUnreadableStore,
  storageFilesContain,
  storageDatabase,
  storageInternals,
} from "./storage-test-support.js";

/** Manifest rows a pipeline owns, read through a separate connection. */
function manifestRows(dataDir: string, pipelineId: string): unknown[] {
  const database = openBackendDatabase(dataDir);
  try {
    return (
      database.readStoreRowsByOwner(
        BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE,
        transcriptPipelineTag(pipelineId),
      ) ?? []
    );
  } finally {
    database.close();
  }
}

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-transcripts-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const SENTINEL = "SENTINEL-TRANSCRIPT-TEXT";

function messages(count: number, prefix: string, size = 200): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index === 0 ? "user" : "assistant",
    text: `${SENTINEL}:${prefix}:${index}:${"x".repeat(size)}`,
  }));
}

function legacySession(
  sessionKey: string,
  phase: PipelineSession["phase"],
  body: unknown[] | undefined,
  extra: Partial<PipelineSession> = {},
): PipelineSession {
  return {
    phase,
    iteration: 0,
    sessionKey,
    sdkSessionId: `sdk-${sessionKey}`,
    status: "idle",
    startedAt: "2026-09-01T00:00:00.000Z",
    label: `${phase} session`,
    ...(body ? { messages: body, messageRevision: 3 } : {}),
    ...(body ? { messagesFingerprint: legacyKey(body) } : {}),
    ...extra,
  };
}

/** The raw fingerprint form records written before the digest carried. */
function legacyKey(body: unknown[]): string {
  return body.length === 0 ? "0:" : `${body.length}:${JSON.stringify(body.at(-1))}`;
}

function pipelineSnapshot(id: string, sessions: PipelineSession[], phase = "building") {
  return { id, phase, sessions, currentSessionIndex: sessions.length - 1 };
}

/** The committed control records, serialized the way the old control file was. */
async function controlFile(dataDir: string): Promise<string> {
  return JSON.stringify(readStoredValue(dataDir, "build-pipelines.json") ?? {});
}

async function chunkCount(dataDir: string): Promise<number> {
  try {
    return (
      await fs.readdir(path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY, "chunks"))
    ).filter((name) => name.endsWith(".chunk")).length;
  } catch {
    return 0;
  }
}

async function sessionsOf(storage: StorageService, id: string): Promise<PipelineSession[]> {
  const record = await storage.getBuildPipeline(id);
  if (!record) throw new Error(`Pipeline ${id} disappeared`);
  return (record.snapshot as { sessions: PipelineSession[] }).sessions;
}

async function transcriptOf(
  storage: StorageService,
  id: string,
  session: PipelineSession,
): Promise<unknown[] | string> {
  const read = await storage.readBuildPipelineTranscript(id, session);
  return read.status === "found" ? read.messages : read.status;
}

async function seedLegacy(storage: StorageService) {
  const bodies = {
    build: messages(120, "p1-build"),
    verify: [...messages(3, "p1-verify"), { id: "legacy-request", role: "user", text: "verify" }],
    other: messages(60, "p2-build"),
  };
  await storage.saveBuildPipeline(
    "p1",
    "proj-1",
    "",
    2,
    pipelineSnapshot("p1", [
      legacySession("p1:build", "build", bodies.build),
      legacySession("p1:verify", "verify", bodies.verify),
      legacySession("p1:pr", "pr", []),
    ]),
  );
  await storage.saveBuildPipeline(
    "p2",
    "proj-1",
    "",
    2,
    pipelineSnapshot("p2", [legacySession("p2:build", "build", bodies.other)]),
  );
  await storage.saveBuildPipeline("p3", "proj-1", "", 2, pipelineSnapshot("p3", []));
  return bodies;
}

describe("build pipeline transcript migration", () => {
  test("keeps a legacy inline body when one message exceeds the chunk limit", async () => {
    await withStorage(async (storage, dataDir) => {
      const huge = messages(1, "large", 9 * 1024 * 1024);
      await storage.saveBuildPipeline(
        "large",
        "proj-1",
        "",
        2,
        pipelineSnapshot("large", [legacySession("large:build", "build", huge)]),
      );
      const report = await storage.migrateBuildPipelineTranscripts();
      expect(report.remaining).toBe(1);
      expect((await sessionsOf(storage, "large"))[0]!.messages).toEqual(huge);
      expect(await controlFile(dataDir)).toContain(SENTINEL);
    });
  });
  test("moves inline transcripts out of the control file without changing revisions", async () => {
    await withStorage(async (storage, dataDir) => {
      const bodies = await seedLegacy(storage);
      const before = await storage.listAllBuildPipelines();
      const bytesBefore = (await controlFile(dataDir)).length;

      const report = await storage.migrateBuildPipelineTranscripts();

      expect(report).toMatchObject({ migrated: 2, sessions: 3, deferred: 0, remaining: 0 });
      const after = await storage.listAllBuildPipelines();
      expect(after.map((record) => [record.id, record.revision])).toEqual(
        before.map((record) => [record.id, record.revision]),
      );
      const control = await controlFile(dataDir);
      expect(control).not.toContain(SENTINEL);
      expect(control.length).toBeLessThan(bytesBefore / 10);

      const [build, verify, pr] = await sessionsOf(storage, "p1");
      for (const session of [build!, verify!]) {
        expect(session.messages).toBeUndefined();
        expect(session.transcript).toMatchObject({ version: 1, complete: true });
        expect(session.messageRevision).toBe(3);
        expect(session.messagesFingerprint).toStartWith("tf3:");
      }
      expect(pr!.messages).toBeUndefined();
      expect(pr!.transcript).toBeUndefined();
      expect(await transcriptOf(storage, "p1", build!)).toEqual(bodies.build);
      expect(await transcriptOf(storage, "p1", verify!)).toEqual(bodies.verify);
      // The one semantic fact a legacy verification session recovered from its
      // transcript is now persisted explicitly.
      expect(verify!.legacyStructuredRequestId).toBe("legacy-request");
      expect(build!.messagesFingerprint).toBe(transcriptFingerprint(bodies.build));

      expect(await storage.migrateBuildPipelineTranscripts()).toMatchObject({
        migrated: 0,
        remaining: 0,
      });
    });
  });

  test("a concurrent supervisor write wins; that pipeline is migrated on a later pass", async () => {
    await withStorage(async (storage) => {
      const bodies = await seedLegacy(storage);
      let raced = false;
      storage.setBuildPipelineTranscriptFaults({
        at: async (stage) => {
          if (stage !== "migration-after-import" || raced) return;
          raced = true;
          // A legacy-format writer commits between import and the control CAS.
          const record = (await storage.getBuildPipeline("p2"))!;
          await storage.saveBuildPipeline(
            "p2",
            "proj-1",
            "",
            2,
            { ...(record.snapshot as object), phase: "reviewing" },
            record.revision,
          );
        },
      });

      const first = await storage.migrateBuildPipelineTranscripts();
      expect(first).toMatchObject({ migrated: 1, deferred: 1, remaining: 1 });
      const racedRecord = (await storage.getBuildPipeline("p2"))!;
      // The concurrent update is not lost.
      expect((racedRecord.snapshot as { phase: string }).phase).toBe("reviewing");
      expect((await sessionsOf(storage, "p2"))[0]!.messages).toEqual(bodies.other);

      storage.setBuildPipelineTranscriptFaults(null);
      expect(await storage.migrateBuildPipelineTranscripts()).toMatchObject({
        migrated: 1,
        remaining: 0,
      });
      const [migrated] = await sessionsOf(storage, "p2");
      expect(await transcriptOf(storage, "p2", migrated!)).toEqual(bodies.other);
      expect((await storage.getBuildPipeline("p2"))!.revision).toBe(racedRecord.revision);
    });
  });

  test("a crash during migration leaves the legacy record intact and a retry is idempotent", async () => {
    await withStorage(async (storage, dataDir) => {
      const bodies = await seedLegacy(storage);
      storage.setBuildPipelineTranscriptFaults({
        at: (stage) => {
          if (stage === "migration-before-control-commit") throw new Error("crash");
        },
      });
      await expect(storage.migrateBuildPipelineTranscripts()).rejects.toThrow("crash");
      expect(await controlFile(dataDir)).toContain(SENTINEL);
      const imported = await chunkCount(dataDir);
      expect(imported).toBeGreaterThan(0);

      // Restart: a fresh process finishes the move, reusing what was imported.
      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(await restarted.migrateBuildPipelineTranscripts()).toMatchObject({
        migrated: 2,
        remaining: 0,
      });
      expect(await chunkCount(dataDir)).toBe(imported);
      const [build] = await sessionsOf(restarted, "p1");
      expect(build!.transcript?.manifestRevision).toBe(1);
      expect(await transcriptOf(restarted, "p1", build!)).toEqual(bodies.build);
    });
  });

  test("the first save of an unmigrated record moves its transcript itself", async () => {
    await withStorage(async (storage, dataDir) => {
      const bodies = await seedLegacy(storage);
      const { BuildPipelineTranscriptCheckpoints } =
        await import("./build-pipeline-transcript-checkpoints.js");
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const record = (await storage.getBuildPipeline("p2"))!;
      const pipeline = record.snapshot as Parameters<typeof checkpoints.prepare>[0];
      const checkpoint = await checkpoints.prepare(pipeline);
      await storage.saveBuildPipeline("p2", "proj-1", "", 2, pipeline, record.revision);
      checkpoint.settle();

      const [session] = await sessionsOf(storage, "p2");
      expect(session!.messages).toBeUndefined();
      expect(await transcriptOf(storage, "p2", session!)).toEqual(bodies.other);
      expect(await controlFile(dataDir)).not.toContain("p2-build");
    });
  });
});

describe("build pipeline transcript deletion", () => {
  test("deletion removes referenced chunks and scrubs earlier inline revisions", async () => {
    await withStorage(async (storage, dataDir) => {
      await seedLegacy(storage);
      await storage.migrateBuildPipelineTranscripts();
      // The migrated record no longer carries the body, but the pre-migration
      // revision may survive in the database's free pages or WAL frames.
      expect(await controlFile(dataDir)).not.toContain("p1-build");
      expect(storageFilesContain(dataDir, "p1-build")).toBe(true);

      await storage.deleteBuildPipeline("p1");

      expect(storageFilesContain(dataDir, "p1-build")).toBe(false);
      expect(storageFilesContain(dataDir, "p1-verify")).toBe(false);
      const [other] = await sessionsOf(storage, "p2");
      expect(await transcriptOf(storage, "p2", other!)).toEqual(messages(60, "p2-build"));
      await storage.deleteBuildPipelinesByEnvironment("unused-env", "p2");
      expect(await chunkCount(dataDir)).toBe(0);
    });
  });

  test("deleting an environment that only links another environment's pipeline keeps its transcripts", async () => {
    await withStorage(async (storage) => {
      await storage.addEnvironment({
        id: "source",
        projectId: "proj-1",
        name: "source",
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
      });
      const body = messages(60, "source-build");
      await storage.saveBuildPipeline(
        "p1",
        "proj-1",
        "source",
        2,
        pipelineSnapshot("p1", [legacySession("p1:build", "build", body)]),
      );
      await storage.migrateBuildPipelineTranscripts();

      // A sidebar fork carries the source's buildPipelineId.
      expect(await storage.deleteBuildPipelinesByEnvironment("fork", "p1")).toEqual([]);

      const [session] = await sessionsOf(storage, "p1");
      expect(await transcriptOf(storage, "p1", session!)).toEqual(body);
    });
  });

  test("control and manifest rows are deleted in one commit; a crash before the unlinks only leaves chunks repair removes", async () => {
    await withStorage(async (storage, dataDir) => {
      await seedLegacy(storage);
      await storage.migrateBuildPipelineTranscripts();
      expect(manifestRows(dataDir, "p1")).toHaveLength(2);
      const chunksBefore = await chunkCount(dataDir);
      storage.setBuildPipelineTranscriptFaults({
        at: (stage) => {
          if (stage === "delete-after-control") throw new Error("crash during deletion");
        },
      });
      await expect(storage.deleteBuildPipeline("p1")).rejects.toThrow("crash during deletion");
      expect(await storage.getBuildPipeline("p1")).toBeNull();
      // The manifests went with the control record: nothing references the chunks.
      expect(manifestRows(dataDir, "p1")).toEqual([]);
      expect(storageFilesContain(dataDir, "sdk-p1:build")).toBe(false);
      expect(await chunkCount(dataDir)).toBe(chunksBefore);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      const swept = await restarted.sweepBuildPipelineTranscripts({ graceMs: 0 });
      expect(swept).toMatchObject({ orphans: 0, complete: true });
      expect(swept.removedChunks).toBeGreaterThan(0);
      expect(await chunkCount(dataDir)).toBeLessThan(chunksBefore);
      const [other] = await sessionsOf(restarted, "p2");
      expect(await transcriptOf(restarted, "p2", other!)).toEqual(messages(60, "p2-build"));
    });
  });

  test("deletion leaves no manifest row, chunk file or session identity behind", async () => {
    await withStorage(async (storage, dataDir) => {
      await seedLegacy(storage);
      await storage.migrateBuildPipelineTranscripts();
      const chunks = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY, "chunks");
      const before = new Set(await fs.readdir(chunks));
      expect(storageFilesContain(dataDir, "sdk-p1:verify")).toBe(true);

      await storage.deleteBuildPipeline("p1");

      expect(manifestRows(dataDir, "p1")).toEqual([]);
      expect(storageFilesContain(dataDir, "sdk-p1:verify")).toBe(false);
      const after = new Set(await fs.readdir(chunks));
      // Only p2's chunks remain on disk.
      expect(after.size).toBeLessThan(before.size);
      expect(manifestRows(dataDir, "p2")).toHaveLength(1);
      const [other] = await sessionsOf(storage, "p2");
      expect(await transcriptOf(storage, "p2", other!)).toEqual(messages(60, "p2-build"));
    });
  });
});

describe("build pipeline transcript commit", () => {
  async function checkpointed(storage: StorageService, body: unknown[]) {
    const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
    const session = legacySession("p1:build", "build", undefined, { messageRevision: 0 });
    checkpoints.observe(session, body);
    const pipeline = pipelineSnapshot("p1", [session]) as Parameters<typeof checkpoints.prepare>[0];
    const checkpoint = await checkpoints.prepare(pipeline);
    const saved = await storage.saveBuildPipeline("p1", "proj-1", "", 2, pipeline);
    checkpoint.settle();
    return { checkpoints, saved };
  }

  test("a failure between the chunk write and the commit leaves the old transcript and control record", async () => {
    await withStorage(async (storage, dataDir) => {
      const first = messages(5, "first");
      const { checkpoints, saved } = await checkpointed(storage, first);
      const chunksAfterFirst = await chunkCount(dataDir);

      const record = (await storage.getBuildPipeline("p1"))!;
      const pipeline = record.snapshot as Parameters<typeof checkpoints.prepare>[0];
      checkpoints.observe(pipeline.sessions[0]!, messages(9, "second"));
      (pipeline as { phase: string }).phase = "reviewing";
      await checkpoints.prepare(pipeline);
      expect(await chunkCount(dataDir)).toBeGreaterThan(chunksAfterFirst);

      // The control write's transaction fails after the manifest row was written.
      const database = storageDatabase(storage);
      const failing = spyOn(database, "updateStoreRow").mockImplementation(() => {
        throw new Error("disk I/O error");
      });
      try {
        await expect(
          storage.saveBuildPipeline("p1", "proj-1", "", 2, pipeline, saved.revision),
        ).rejects.toThrow("disk I/O error");
      } finally {
        failing.mockRestore();
      }

      const restarted = new StorageService(dataDir);
      await restarted.init();
      const stored = (await restarted.getBuildPipeline("p1"))!;
      expect(stored.revision).toBe(saved.revision);
      expect((stored.snapshot as { phase: string }).phase).toBe("building");
      const [session] = await sessionsOf(restarted, "p1");
      expect(session!.transcript?.manifestRevision).toBe(1);
      const read = await restarted.readBuildPipelineTranscript("p1", session!);
      expect(read).toMatchObject({ status: "found", substituted: false });
      expect(read.status === "found" ? read.messages : []).toEqual(first);
      // The staged chunks are orphans: repair collects them.
      const swept = await restarted.sweepBuildPipelineTranscripts({ graceMs: 0 });
      expect(swept.removedChunks).toBeGreaterThan(0);
      expect(await chunkCount(dataDir)).toBe(chunksAfterFirst);
      expect(await transcriptOf(restarted, "p1", session!)).toEqual(first);
    });
  });

  test("a discarded same-base staged sibling cannot replace the committed transcript reference", async () => {
    await withStorage(async (storage) => {
      await checkpointed(storage, messages(5, "base"));
      const prepared = [];
      for (const index of [0, 1]) {
        const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
        const record = (await storage.getBuildPipeline("p1"))!;
        const pipeline = record.snapshot as Parameters<typeof checkpoints.prepare>[0];
        checkpoints.observe(pipeline.sessions[0]!, messages(8 + index, `sibling-${index}`));
        await checkpoints.prepare(pipeline);
        prepared.push(pipeline);
      }
      expect(prepared[0]!.sessions[0]!.transcript!.manifestRevision).toBe(
        prepared[1]!.sessions[0]!.transcript!.manifestRevision,
      );
      await storage.saveBuildPipeline("p1", "proj-1", "", 2, prepared[0]);
      await storage.saveBuildPipeline("p1", "proj-1", "", 3, prepared[1]);
      const [session] = await sessionsOf(storage, "p1");
      expect(session!.transcriptCheckpointError).toBe("stage-expired");
      expect(session!.transcript).toEqual(prepared[0]!.sessions[0]!.transcript);
      expect(session!.messagesFingerprint).toBe(prepared[0]!.sessions[0]!.messagesFingerprint);
      const read = await storage.readBuildPipelineTranscript("p1", session!);
      expect(read.status === "found" ? read.messages : []).toEqual(messages(8, "sibling-0"));
    });
  });

  test("two backends checkpointing one session cannot lose or tear each other's transcript", async () => {
    await withStorage(async (storage, dataDir) => {
      await checkpointed(storage, messages(5, "base"));
      const other = new StorageService(dataDir);
      await other.init();
      const contenders = [storage, other].map((instance, index) => ({
        instance,
        checkpoints: new BuildPipelineTranscriptCheckpoints(instance),
        body: messages(8 + index, `writer-${index}`),
      }));
      const prepared = [];
      for (const contender of contenders) {
        const record = (await contender.instance.getBuildPipeline("p1"))!;
        const pipeline = record.snapshot as Parameters<typeof contender.checkpoints.prepare>[0];
        contender.checkpoints.observe(pipeline.sessions[0]!, contender.body);
        await contender.checkpoints.prepare(pipeline);
        prepared.push({ ...contender, pipeline });
      }
      // Without a revision guard both control writes land, one after the other.
      for (const { instance, pipeline } of prepared) {
        await instance.saveBuildPipeline("p1", "proj-1", "", 2, pipeline);
      }
      // The second staged manifest was planned on the base the first replaced:
      // it is refused inside the transaction, and that session keeps the
      // committed reference instead of naming a manifest that never landed.
      const [session] = await sessionsOf(other, "p1");
      expect(session!.transcriptCheckpointError).toBe("conflict");
      const read = await other.readBuildPipelineTranscript("p1", session!);
      expect(read).toMatchObject({ status: "found", substituted: false });
      expect(read.status === "found" ? read.messages : []).toEqual(prepared[0]!.body);
      // The refused writer's in-memory session agrees, so it checkpoints again.
      expect(prepared[1]!.pipeline.sessions[0]!.transcript).toEqual(session!.transcript);
      expect(
        prepared[1]!.checkpoints.observe(prepared[1]!.pipeline.sessions[0]!, prepared[1]!.body),
      ).toBe(true);
    });
  });

  test("a staged checkpoint the quota refuses keeps the previous reference and never blocks the control write", async () => {
    await withStorage(async (storage) => {
      const { checkpoints, saved } = await checkpointed(storage, messages(5, "first"));
      const record = (await storage.getBuildPipeline("p1"))!;
      const pipeline = record.snapshot as Parameters<typeof checkpoints.prepare>[0];
      checkpoints.observe(pipeline.sessions[0]!, messages(9, "second"));
      await checkpoints.prepare(pipeline);
      (pipeline as { phase: string }).phase = "reviewing";
      const store = (
        storageInternals(storage).repos.buildPipelines as unknown as {
          buildPipelineTranscriptStore(): {
            commitStagedInTransaction(staged: unknown): unknown;
          };
        }
      ).buildPipelineTranscriptStore();
      const refused = spyOn(store, "commitStagedInTransaction").mockReturnValue({
        ok: false,
        reason: "quota-exceeded",
      });
      try {
        await storage.saveBuildPipeline("p1", "proj-1", "", 2, pipeline, saved.revision);
      } finally {
        refused.mockRestore();
      }
      const stored = (await storage.getBuildPipeline("p1"))!;
      expect((stored.snapshot as { phase: string }).phase).toBe("reviewing");
      const [session] = await sessionsOf(storage, "p1");
      expect(session!.transcriptCheckpointError).toBe("quota-exceeded");
      expect(session!.transcript?.manifestRevision).toBe(1);
      expect(await transcriptOf(storage, "p1", session!)).toEqual(messages(5, "first"));
    });
  });
});

describe("pre-database transcript manifests", () => {
  test("a control write naming a not-yet-imported file manifest imports it instead of dropping it", async () => {
    await withStorage(async (storage, dataDir) => {
      const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
      const body = messages(6, "file-era");
      await writeLegacyTranscriptSession(directory, "p1", "p1:build", body, { revision: 2 });
      const reference = {
        version: 1 as const,
        sdkSessionId: "sdk-p1:build",
        manifestRevision: 2,
        revision: 2,
        messageCount: body.length,
        bytes: body.reduce<number>(
          (sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1,
          0,
        ),
        complete: true,
        committedAt: "2026-09-01T00:00:00.000Z",
      };
      await storage.saveBuildPipeline(
        "p1",
        "proj-1",
        "",
        2,
        pipelineSnapshot("p1", [
          legacySession("p1:build", "build", undefined, { transcript: reference }),
        ]),
      );
      const [session] = await sessionsOf(storage, "p1");
      expect(session!.transcript).toEqual(reference);
      expect(session!.transcriptCheckpointError).toBeUndefined();
      expect(await transcriptOf(storage, "p1", session!)).toEqual(body);
    });
  });

  test("the background migration imports file manifests the control records reference", async () => {
    await withStorage(async (storage, dataDir) => {
      const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
      const body = messages(12, "file-era");
      await writeLegacyTranscriptSession(directory, "p1", "p1:build", body, { revision: 7 });
      const reference = {
        version: 1 as const,
        sdkSessionId: "sdk-p1:build",
        manifestRevision: 7,
        revision: 7,
        messageCount: body.length,
        bytes: 1,
        complete: true,
        committedAt: "2026-09-01T00:00:00.000Z",
      };
      // The control record as an upgraded installation carries it.
      seedStore(dataDir, "build-pipelines.json", {
        p1: {
          version: 2,
          id: "p1",
          projectId: "proj-1",
          environmentId: "",
          revision: 4,
          updatedAt: "2026-09-01T00:00:00.000Z",
          snapshot: pipelineSnapshot("p1", [
            legacySession("p1:build", "build", undefined, { transcript: reference }),
          ]),
        },
      });
      const report = await storage.migrateBuildPipelineTranscripts();
      expect(report.legacyManifests).toEqual({ imported: 1, complete: true });
      await expect(fs.stat(path.join(directory, "manifests"))).rejects.toThrow();
      const [session] = await sessionsOf(storage, "p1");
      const read = await storage.readBuildPipelineTranscript("p1", session!);
      expect(read).toMatchObject({ status: "found", substituted: false, messageCount: 12 });
      expect(read.status === "found" ? read.messages : []).toEqual(body);
      expect(manifestRows(dataDir, "p1")).toHaveLength(1);
    });
  });
});

describe("build pipeline control records", () => {
  test("phase, queue, cancel and lease updates succeed beyond the former transcript-size limit", async () => {
    await withStorage(async (storage, dataDir) => {
      // Two stages whose transcripts together exceed the old 32 MiB snapshot bound.
      const huge = (prefix: string) =>
        Array.from({ length: 17 }, (_, index) => ({
          id: `${prefix}-${index}`,
          role: "assistant",
          text: `${prefix}:${"z".repeat(1024 * 1024)}`,
        }));
      const sessions: PipelineSession[] = [];
      for (const [key, body] of [
        ["p1:build", huge("build")],
        ["p1:review", huge("review")],
      ] as const) {
        const session = legacySession(key, key === "p1:build" ? "build" : "review", undefined);
        const committed = await storage.commitBuildPipelineTranscript({
          pipelineId: "p1",
          sessionKey: key,
          sdkSessionId: session.sdkSessionId,
          messages: body,
          revision: 1,
          fingerprint: transcriptFingerprint(body),
        });
        if (committed.status !== "staged") throw new Error("transcript commit failed");
        sessions.push({ ...session, transcript: committed.reference, messageRevision: 1 });
      }
      // The old inline representation could not persist any control change.
      await expect(
        storage.saveBuildPipeline(
          "legacy",
          "proj-1",
          "",
          2,
          pipelineSnapshot(
            "legacy",
            sessions.map((session, index) => ({
              ...session,
              messages: index === 0 ? huge("build") : huge("review"),
            })),
          ),
        ),
      ).rejects.toThrow("exceeds the 32 MB limit");

      let revision = (
        await storage.saveBuildPipeline("p1", "proj-1", "", 2, pipelineSnapshot("p1", sessions))
      ).revision;
      for (const update of [
        { phase: "paused", pausedFromPhase: "reviewing" },
        { phase: "reviewing", pendingUserMessages: [{ id: "m1", text: "hi", createdAt: "x" }] },
        { phase: "reviewing", reconnectAttempt: { id: "lease", startedAt: "x" } },
        { phase: "failed", error: "Build cancelled" },
      ]) {
        revision = (
          await storage.saveBuildPipeline(
            "p1",
            "proj-1",
            "",
            2,
            { ...pipelineSnapshot("p1", sessions), ...update },
            revision,
          )
        ).revision;
      }
      expect(revision).toBe(5);
      expect((await controlFile(dataDir)).length).toBeLessThan(16 * 1024);
      const [build] = await sessionsOf(storage, "p1");
      const read = await storage.readBuildPipelineTranscript("p1", build!, { fromIndex: 16 });
      expect(read).toMatchObject({ status: "found", startIndex: 16, messageCount: 17 });
    });
  });

  test("two concurrent admissions cannot both reserve one GitHub build", async () => {
    await withStorage(async (storage, dataDir) => {
      const other = new StorageService(dataDir);
      await other.init();
      const github = (id: string) => ({
        id,
        phase: "creating-environment",
        source: {
          type: "github",
          repositoryOwner: "OpenAI",
          repositoryName: "Codex",
          issueNumber: 7,
        },
      });
      const results = await Promise.allSettled([
        storage.saveBuildPipeline("a", "proj-1", "", 2, github("a"), 0),
        other.saveBuildPipeline("b", "proj-1", "", 2, github("b"), 0),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === "rejected" &&
            String(result.reason).includes("active build already exists"),
        ),
      ).toHaveLength(1);

      // Equivalent concurrent starts share one admission instead of creating two.
      const admission = (id: string) => ({ id, phase: "creating-environment", admissionKey: "k1" });
      const admitted = await Promise.all([
        storage.saveBuildPipeline("c", "proj-1", "", 2, admission("c"), 0),
        other.saveBuildPipeline("d", "proj-1", "", 2, admission("d"), 0),
      ]);
      expect(new Set(admitted.map((record) => record.id)).size).toBe(1);
    });
  });

  test("a control store imported unreadable reads as empty and the next write replaces it", async () => {
    await withStorage(async (storage, dataDir) => {
      seedUnreadableStore(dataDir, "build-pipelines.json");
      expect(await storage.listAllBuildPipelines()).toEqual([]);
      const saved = await storage.saveBuildPipeline("p1", "proj-1", "", 2, { id: "p1" });
      expect(saved.revision).toBe(1);
      expect((await storage.listAllBuildPipelines()).map((record) => record.id)).toEqual(["p1"]);
    });
  });

  test("cached reads observe another process's write and never alias the cache", async () => {
    await withStorage(async (storage, dataDir) => {
      await storage.saveBuildPipeline("p1", "proj-1", "", 2, { id: "p1", phase: "building" });
      const first = (await storage.getBuildPipeline("p1"))!;
      (first.snapshot as { phase: string }).phase = "mutated-by-caller";
      expect(((await storage.getBuildPipeline("p1"))!.snapshot as { phase: string }).phase).toBe(
        "building",
      );

      const other = new StorageService(dataDir);
      await other.init();
      await other.saveBuildPipeline("p1", "proj-1", "", 2, { id: "p1", phase: "reviewing" }, 1);
      const reread = (await storage.getBuildPipeline("p1"))!;
      expect(reread.revision).toBe(2);
      expect((reread.snapshot as { phase: string }).phase).toBe("reviewing");
    });
  });
});
