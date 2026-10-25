/**
 * The supervisor's save boundary for display transcripts (plan step 16):
 * transcripts are staged ahead of the control record that references them and
 * commit in its transaction, a checkpoint failure never blocks control state,
 * and every crash point leaves committed workflow evidence intact.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { BuildPipelineTranscriptCheckpoints } from "./build-pipeline-transcript-checkpoints.js";
import { readStoredValue, storageInternals } from "./storage-test-support.js";

/**
 * Serialized size of every committed control record. An upper bound on what a
 * control write stores: the record layout rewrites only the changed rows.
 */
function controlRecordBytes(dataDir: string): number {
  return Buffer.byteLength(
    JSON.stringify(readStoredValue(dataDir, "build-pipelines.json") ?? {}),
    "utf8",
  );
}

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-transcript-checkpoints-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function messages(count: number, prefix: string, size = 300): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index === 0 ? "user" : "assistant",
    text: `${prefix}:${index}:${"x".repeat(size)}`,
  }));
}

function session(key: string, phase: PipelineSession["phase"] = "build"): PipelineSession {
  return {
    phase,
    iteration: 0,
    sessionKey: key,
    sdkSessionId: `sdk-${key}`,
    status: "running",
    startedAt: "2026-09-01T00:00:00.000Z",
    label: `${phase} session`,
    messageRevision: 0,
  };
}

function pipeline(id: string, sessions: PipelineSession[]): BuildPipeline {
  return {
    id,
    phase: "building",
    sessions,
    currentSessionIndex: sessions.length - 1,
  } as unknown as BuildPipeline;
}

/** The service's save boundary, reduced to its storage effects. */
async function save(
  storage: StorageService,
  checkpoints: BuildPipelineTranscriptCheckpoints,
  value: BuildPipeline,
  expectedRevision?: number,
): Promise<number> {
  const checkpoint = await checkpoints.prepare(value);
  const saved = await storage.saveBuildPipeline(value.id, "proj-1", "", 2, value, expectedRevision);
  checkpoint.settle();
  return saved.revision;
}

async function stored(storage: StorageService, id: string): Promise<BuildPipeline> {
  return (await storage.getBuildPipeline(id))!.snapshot as BuildPipeline;
}

async function body(storage: StorageService, id: string, value: PipelineSession) {
  const read = await storage.readBuildPipelineTranscript(id, value);
  return read.status === "found" ? read.messages : read.status;
}

describe("build pipeline transcript checkpoints", () => {
  test("an active tail update writes one tail chunk, a manifest and the small control record", async () => {
    await withStorage(async (storage, dataDir) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      // Several long pipelines, each with completed stages.
      const histories = new Map<string, unknown[]>();
      for (const id of ["p1", "p2", "p3"]) {
        const sessions = ["build", "review", "verify"].map((phase) =>
          session(`${id}:${phase}`, phase as PipelineSession["phase"]),
        );
        for (const value of sessions) {
          const history = messages(1_500, `${value.sessionKey}`);
          histories.set(value.sessionKey, history);
          checkpoints.observe(value, history);
        }
        await save(storage, checkpoints, pipeline(id, sessions));
      }
      const historyBytes = [...histories.values()].reduce(
        (sum, history) => sum + JSON.stringify(history).length,
        0,
      );
      const controlBytes = controlRecordBytes(dataDir);
      expect(controlBytes).toBeLessThan(historyBytes / 100);

      // One active session streams into its newest entry.
      const active = (await stored(storage, "p2")).sessions[2]!;
      const history = histories.get(active.sessionKey)!;
      const streamed = [...history.slice(0, -1), { id: "tail", text: "still streaming" }];
      const before = storage.buildPipelineTranscriptStats();
      const current = await stored(storage, "p2");
      expect(checkpoints.observe(current.sessions[2]!, streamed)).toBe(true);
      await save(storage, checkpoints, current, (await storage.getBuildPipeline("p2"))!.revision);
      const after = storage.buildPipelineTranscriptStats();

      const transcriptBytes =
        after.chunkBytesWritten -
        before.chunkBytesWritten +
        (after.manifestBytesWritten - before.manifestBytesWritten);
      const controlWritten = controlRecordBytes(dataDir);
      expect(after.chunkWrites - before.chunkWrites).toBe(1);
      expect(after.chunkBytesWritten - before.chunkBytesWritten).toBeLessThanOrEqual(256 * 1024);
      // Bytes written per active tail update, measured: not proportional to
      // the histories of this or any other pipeline.
      expect(transcriptBytes + controlWritten).toBeLessThan(historyBytes / 20);
      const updated = (await stored(storage, "p2")).sessions[2]!;
      expect(updated.messageRevision).toBe(2);
      expect(await body(storage, "p2", updated)).toEqual(streamed);
    });
  });

  test("a failed checkpoint keeps the old reference and never blocks the control write", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const value = session("p1:build");
      const first = messages(5, "first");
      checkpoints.observe(value, first);
      let revision = await save(storage, checkpoints, pipeline("p1", [value]));
      const committed = (await stored(storage, "p1")).sessions[0]!;

      let failures = 1;
      storage.setBuildPipelineTranscriptFaults({
        at: (stage) => {
          if (stage === "after-chunks" && failures-- > 0) throw new Error("disk full");
        },
      });
      const next = await stored(storage, "p1");
      const second = messages(9, "second");
      checkpoints.observe(next.sessions[0]!, second);
      // A phase transition rides on this save: it must commit regardless.
      (next as { phase: string }).phase = "reviewing";
      revision = await save(storage, checkpoints, next, revision);

      const afterFailure = await stored(storage, "p1");
      expect(afterFailure.phase).toBe("reviewing");
      expect(afterFailure.sessions[0]!.transcript).toEqual(committed.transcript);
      // The lag is explicit and content-free.
      expect(afterFailure.sessions[0]!.transcriptCheckpointError).toBe("commit-failed");
      expect(await body(storage, "p1", afterFailure.sessions[0]!)).toEqual(first);
      // The newer body is still pending and lands on the next save.
      expect(checkpoints.pendingMessages(afterFailure.sessions[0]!)).toBe(second);
      await save(storage, checkpoints, afterFailure, revision);
      const recovered = (await stored(storage, "p1")).sessions[0]!;
      expect(await body(storage, "p1", recovered)).toEqual(second);
      expect(checkpoints.pendingMessages(recovered)).toBeUndefined();
      expect(recovered.transcriptCheckpointError).toBeUndefined();
    });
  });

  test("a crash before the control write leaves the referenced revision exact; the retry reuses the staged chunks", async () => {
    await withStorage(async (storage, dataDir) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const value = session("p1:build");
      const first = messages(5, "first");
      checkpoints.observe(value, first);
      await save(storage, checkpoints, pipeline("p1", [value]));

      // The checkpoint stages its chunks, then the process dies before the
      // control write that would have committed its manifest.
      const next = await stored(storage, "p1");
      const second = messages(8, "second");
      checkpoints.observe(next.sessions[0]!, second);
      await checkpoints.prepare(next);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      const afterCrash = await stored(restarted, "p1");
      expect(await body(restarted, "p1", afterCrash.sessions[0]!)).toEqual(first);
      // On restart the provider still reports the newer transcript: the
      // committed fingerprint differs, so it is checkpointed again — reusing
      // the chunk files the crashed attempt already wrote.
      const resumed = new BuildPipelineTranscriptCheckpoints(restarted);
      expect(resumed.observe(afterCrash.sessions[0]!, second)).toBe(true);
      const writes = restarted.buildPipelineTranscriptStats();
      await save(
        restarted,
        resumed,
        afterCrash,
        (await restarted.getBuildPipeline("p1"))!.revision,
      );
      expect(restarted.buildPipelineTranscriptStats().chunkWrites).toBe(writes.chunkWrites);
      const final = (await stored(restarted, "p1")).sessions[0]!;
      expect(final.transcript?.manifestRevision).toBe(2);
      expect(await body(restarted, "p1", final)).toEqual(second);
    });
  });

  test("after the control write a restart sees no transcript change and writes nothing", async () => {
    await withStorage(async (storage, dataDir) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const value = session("p1:build");
      const body1 = messages(5, "first");
      checkpoints.observe(value, body1);
      const snapshot = pipeline("p1", [value]);
      await checkpoints.prepare(snapshot);
      await storage.saveBuildPipeline("p1", "proj-1", "", 2, snapshot);
      // Crash here, before the in-memory pending copy is settled.

      const restarted = new StorageService(dataDir);
      await restarted.init();
      const resumed = new BuildPipelineTranscriptCheckpoints(restarted);
      const afterCrash = (await stored(restarted, "p1")).sessions[0]!;
      expect(resumed.observe(afterCrash, body1)).toBe(false);
      expect(await body(restarted, "p1", afterCrash)).toEqual(body1);
    });
  });

  test("a manifest the control transaction refuses is checkpointed again on the next save", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const value = session("p1:build");
      const first = messages(5, "first");
      checkpoints.observe(value, first);
      const snapshot = pipeline("p1", [value]);
      let revision = await save(storage, checkpoints, snapshot);

      const second = messages(9, "second");
      expect(checkpoints.observe(snapshot.sessions[0]!, second)).toBe(true);
      const store = (
        storageInternals(storage).repos.buildPipelines as unknown as {
          buildPipelineTranscriptStore(): { commitStagedInTransaction(staged: unknown): unknown };
        }
      ).buildPipelineTranscriptStore();
      const refused = spyOn(store, "commitStagedInTransaction").mockReturnValueOnce({
        ok: false,
        reason: "conflict",
      });
      try {
        revision = await save(storage, checkpoints, snapshot, revision);
      } finally {
        refused.mockRestore();
      }
      // Stored and in-memory sessions agree on the committed transcript.
      const persisted = (await stored(storage, "p1")).sessions[0]!;
      expect(persisted.transcriptCheckpointError).toBe("conflict");
      expect(snapshot.sessions[0]!.transcript).toEqual(persisted.transcript);
      expect(await body(storage, "p1", persisted)).toEqual(first);

      // The provider still reports the newer body: it is detected and lands.
      expect(checkpoints.observe(snapshot.sessions[0]!, second)).toBe(true);
      await save(storage, checkpoints, snapshot, revision);
      const recovered = (await stored(storage, "p1")).sessions[0]!;
      expect(recovered.transcriptCheckpointError).toBeUndefined();
      expect(await body(storage, "p1", recovered)).toEqual(second);
    });
  });

  test("bounded windows for the handoff and legacy request recovery read the stored transcript", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const review = session("p1:verify", "verify");
      const history = [
        ...messages(3_000, "review", 20),
        { info: { role: "user", id: "legacy-verify-request" } },
        ...messages(4, "tail", 20).slice(1),
      ];
      checkpoints.observe(review, history);
      await save(storage, checkpoints, pipeline("p1", [review]));
      const committed = (await stored(storage, "p1")).sessions[0]!;
      // Persisted explicitly on the way out of the snapshot.
      expect(committed.legacyStructuredRequestId).toBe("legacy-verify-request");

      const fresh = new BuildPipelineTranscriptCheckpoints(storage);
      const window = await fresh.window("p1", committed, 100);
      expect(window.total).toBe(history.length);
      expect(window.entries.map((entry) => entry.index)).toEqual([
        0,
        ...Array.from({ length: 100 }, (_, offset) => history.length - 100 + offset),
      ]);
      expect(window.entries[0]!.message).toEqual(history[0]);
      expect(window.entries.at(-1)!.message).toEqual(history.at(-1));

      const { legacyStructuredRequestId: _persisted, ...withoutPersisted } = committed;
      expect(await fresh.recoverStructuredRequestId("p1", withoutPersisted)).toBe(
        "legacy-verify-request",
      );
    });
  });
});

describe("build pipeline transcript probe baselines", () => {
  test("a probe matches only the baseline it gated, while that read is the committed copy", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const live = session("probe");
      const value = pipeline("p-probe", [live]);
      const probe = { historyRevisionsTracked: true, digest: "digest-1", sourceToken: "token-1" };

      expect(checkpoints.matchesProbe(live, probe)).toBe(false);
      expect(checkpoints.knownProbe(live)).toBeUndefined();

      expect(checkpoints.observe(live, messages(2, "probe"), probe)).toBe(true);
      expect(checkpoints.knownProbe(live)).toEqual({
        historyRevisionsTracked: true,
        sourceToken: "token-1",
        digest: "digest-1",
      });
      // Observed but not yet committed: readers do not have this copy.
      expect(checkpoints.matchesProbe(live, probe)).toBe(false);

      await save(storage, checkpoints, value);
      expect(checkpoints.matchesProbe(live, probe)).toBe(true);
      expect(
        checkpoints.matchesProbe(live, {
          historyRevisionsTracked: true,
          digest: "digest-2",
          sourceToken: "token-1",
        }),
      ).toBe(false);
    });
  });

  test("a matching probe adopts its newer source token", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const live = session("token");
      await save(storage, checkpoints, pipeline("p-token", [live]));
      checkpoints.observe(live, messages(1, "token"), {
        historyRevisionsTracked: true,
        digest: "digest",
        sourceToken: "old",
      });
      await save(storage, checkpoints, pipeline("p-token", [live]), 1);

      expect(
        checkpoints.matchesProbe(live, {
          historyRevisionsTracked: true,
          digest: "digest",
          sourceToken: "new",
        }),
      ).toBe(true);
      expect(checkpoints.knownProbe(live)).toEqual({
        historyRevisionsTracked: true,
        sourceToken: "new",
        digest: "digest",
      });
    });
  });

  test("a matching tail-only probe cannot certify a committed whole transcript", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const live = session("legacy-probe");
      const probe = { digest: "digest", sourceToken: "legacy-token" };
      checkpoints.observe(live, messages(1, "legacy-probe"), probe);
      await save(storage, checkpoints, pipeline("p-legacy-probe", [live]));
      expect(checkpoints.matchesProbe(live, probe)).toBe(false);
      expect(checkpoints.knownProbe(live)).toBeUndefined();
    });
  });

  test("a probe without a source token gives no conditional read, and forget drops the baseline", async () => {
    await withStorage(async (storage) => {
      const checkpoints = new BuildPipelineTranscriptCheckpoints(storage);
      const live = session("tokenless");
      checkpoints.observe(live, messages(1, "tokenless"), {
        historyRevisionsTracked: true,
        digest: "digest",
      });
      await save(storage, checkpoints, pipeline("p-tokenless", [live]));
      expect(checkpoints.knownProbe(live)).toBeUndefined();
      expect(
        checkpoints.matchesProbe(live, { historyRevisionsTracked: true, digest: "digest" }),
      ).toBe(true);

      checkpoints.forget([live]);
      expect(
        checkpoints.matchesProbe(live, { historyRevisionsTracked: true, digest: "digest" }),
      ).toBe(false);
    });
  });
});
