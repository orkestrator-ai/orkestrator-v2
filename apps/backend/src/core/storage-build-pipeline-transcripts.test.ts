/**
 * Build-pipeline transcripts stored apart from the workflow control record
 * (plan step 16): legacy migration, deletion, crash points, the size bound
 * that used to block control writes, and admission uniqueness.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { BUILD_PIPELINE_TRANSCRIPT_DIRECTORY } from "./build-pipeline-transcript-store.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

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

async function controlFile(dataDir: string): Promise<string> {
  return fs.readFile(path.join(dataDir, "build-pipelines.json"), "utf8");
}

async function allControlCopies(dataDir: string): Promise<string> {
  const names = (await fs.readdir(dataDir)).filter((name) =>
    name.startsWith("build-pipelines.json"),
  );
  return (
    await Promise.all(names.map((name) => fs.readFile(path.join(dataDir, name), "utf8")))
  ).join("\n");
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
        expect(session.messagesFingerprint).toStartWith("tf2:");
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
  test("deletion removes referenced chunks and scrubs legacy backups", async () => {
    await withStorage(async (storage, dataDir) => {
      await seedLegacy(storage);
      await storage.migrateBuildPipelineTranscripts();
      expect(await allControlCopies(dataDir)).toContain("p1-build");

      await storage.deleteBuildPipeline("p1");

      expect(await allControlCopies(dataDir)).not.toContain("p1-build");
      expect(await allControlCopies(dataDir)).not.toContain("p1-verify");
      const [other] = await sessionsOf(storage, "p2");
      expect(await transcriptOf(storage, "p2", other!)).toEqual(messages(60, "p2-build"));
      await storage.deleteBuildPipelinesByEnvironment("unused-env", "p2");
      expect(await chunkCount(dataDir)).toBe(0);
    });
  });

  test("a crash between the control delete and the transcript delete is swept on restart", async () => {
    await withStorage(async (storage, dataDir) => {
      await seedLegacy(storage);
      await storage.migrateBuildPipelineTranscripts();
      const chunksBefore = await chunkCount(dataDir);
      storage.setBuildPipelineTranscriptFaults({
        at: (stage) => {
          if (stage === "delete-after-control") throw new Error("crash during deletion");
        },
      });
      await expect(storage.deleteBuildPipeline("p1")).rejects.toThrow("crash during deletion");
      expect(await storage.getBuildPipeline("p1")).toBeNull();
      expect(await chunkCount(dataDir)).toBe(chunksBefore);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      const swept = await restarted.sweepBuildPipelineTranscripts({ graceMs: 0 });
      expect(swept.orphans).toBe(2);
      expect(await chunkCount(dataDir)).toBeLessThan(chunksBefore);
      const [other] = await sessionsOf(restarted, "p2");
      expect(await transcriptOf(restarted, "p2", other!)).toEqual(messages(60, "p2-build"));
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
        if (committed.status !== "committed") throw new Error("transcript commit failed");
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

      // An explicit downgrade export reports that this pipeline cannot fit
      // the old format rather than truncating it.
      expect(await storage.exportBuildPipelineForDowngrade("p1")).toMatchObject({
        status: "incompatible",
        reason: "too-large",
      });
    });
  });

  test("exports a pipeline that fits the old schema with its transcripts inline", async () => {
    await withStorage(async (storage) => {
      const bodies = await seedLegacy(storage);
      await storage.migrateBuildPipelineTranscripts();
      const exported = await storage.exportBuildPipelineForDowngrade("p1");
      expect(exported.status).toBe("exported");
      const sessions =
        exported.status === "exported"
          ? (exported.record.snapshot as { sessions: PipelineSession[] }).sessions
          : [];
      expect(sessions[0]!.messages).toEqual(bodies.build);
      expect(sessions[0]!.transcript).toBeUndefined();
      expect(sessions[1]!.messages).toEqual(bodies.verify);
      // Export is read-only: the stored record keeps its references.
      expect((await sessionsOf(storage, "p1"))[0]!.transcript).toBeDefined();
      expect(await storage.exportBuildPipelineForDowngrade("missing")).toEqual({
        status: "missing",
      });
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
