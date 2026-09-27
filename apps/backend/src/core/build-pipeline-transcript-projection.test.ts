import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { BUILD_PIPELINE_TRANSCRIPT_DIRECTORY } from "./build-pipeline-transcript-store.js";
import {
  conditionalBuildPipelineRead,
  withoutTranscriptBodies,
} from "./build-pipeline-transcript-projection.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-transcript-projection-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function messages(count: number, prefix: string): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: "assistant",
    text: `${prefix}:${index}`,
  }));
}

async function referencedSession(
  storage: StorageService,
  key: string,
  body: unknown[],
  revision: number,
): Promise<PipelineSession> {
  const committed = await storage.commitBuildPipelineTranscript({
    pipelineId: "p1",
    sessionKey: key,
    sdkSessionId: `sdk-${key}`,
    messages: body,
    revision,
    fingerprint: transcriptFingerprint(body),
  });
  if (committed.status !== "committed") throw new Error("commit failed");
  return {
    phase: "build",
    iteration: 0,
    sessionKey: key,
    sdkSessionId: `sdk-${key}`,
    status: "idle",
    startedAt: "2026-09-01T00:00:00.000Z",
    label: key,
    messageRevision: revision,
    messagesFingerprint: committed.fingerprint,
    transcript: committed.reference,
  };
}

async function seed(storage: StorageService) {
  const build = messages(50, "build");
  const review = messages(20, "review");
  const legacy = messages(4, "legacy");
  const sessions = [
    await referencedSession(storage, "build", build, 3),
    await referencedSession(storage, "review", review, 2),
    {
      phase: "verify" as const,
      iteration: 0,
      sessionKey: "legacy",
      sdkSessionId: "sdk-legacy",
      status: "idle" as const,
      startedAt: "2026-09-01T00:00:00.000Z",
      label: "legacy",
      messageRevision: 1,
      messages: legacy,
    },
  ];
  const record = await storage.saveBuildPipeline("p1", "proj-1", "", 2, {
    id: "p1",
    phase: "verifying",
    sessions,
    currentSessionIndex: 2,
  });
  return { record, build, review, legacy };
}

describe("build pipeline transcript projection", () => {
  test("plain and list reads never carry transcript bodies", async () => {
    await withStorage(async (storage) => {
      const { record } = await seed(storage);
      const projected = withoutTranscriptBodies(record);
      expect(JSON.stringify(projected)).not.toContain("legacy-0");
      expect(JSON.stringify(projected)).not.toContain("build-0");
      const sessions = (projected.snapshot as { sessions: PipelineSession[] }).sessions;
      expect(sessions[0]!.transcript).toBeDefined();
      expect(sessions[2]!.messageRevision).toBe(1);
    });
  });

  test("answers unchanged only when the revision and every held body are current", async () => {
    await withStorage(async (storage) => {
      const { record } = await seed(storage);
      const current = {
        build: { revision: 3, count: 50 },
        review: { revision: 2, count: 20 },
        legacy: { revision: 1, count: 4 },
      };
      expect(
        await conditionalBuildPipelineRead(storage, record, {
          knownRevision: record.revision,
          knownSessions: current,
        }),
      ).toEqual({ unchanged: true, revision: record.revision });

      // Same control revision, but one body is behind: the tail comes back.
      const stale = await conditionalBuildPipelineRead(storage, record, {
        knownRevision: record.revision,
        knownSessions: { ...current, build: { revision: 2, count: 48 } },
      });
      expect(stale.unchanged).toBe(false);
      if (stale.unchanged) return;
      expect(stale.messagePatches).toEqual([
        {
          sessionKey: "build",
          baseRevision: 2,
          baseCount: 48,
          startIndex: 47,
          revision: 3,
          messages: messages(50, "build").slice(47),
        },
      ]);
      expect(JSON.stringify(stale.record)).not.toContain("legacy-0");
    });
  });

  test("sends whole bodies for sessions the client does not hold, legacy ones included", async () => {
    await withStorage(async (storage) => {
      const { record, build, review, legacy } = await seed(storage);
      const read = await conditionalBuildPipelineRead(storage, record, { knownSessions: {} });
      if (read.unchanged) throw new Error("expected patches");
      const bySession = new Map(read.messagePatches.map((patch) => [patch.sessionKey, patch]));
      expect(bySession.get("build")).toMatchObject({ startIndex: 0, revision: 3, messages: build });
      expect(bySession.get("review")).toMatchObject({
        startIndex: 0,
        revision: 2,
        messages: review,
      });
      expect(bySession.get("legacy")).toMatchObject({
        startIndex: 0,
        revision: 1,
        messages: legacy,
      });
    });
  });

  test("serves the viewed session first and defers the rest past the byte budget", async () => {
    await withStorage(async (storage) => {
      const { record } = await seed(storage);
      const read = await conditionalBuildPipelineRead(
        storage,
        record,
        { knownSessions: {}, prioritySessionKey: "review" },
        1,
      );
      if (read.unchanged) throw new Error("expected patches");
      expect(read.messagePatches[0]).toMatchObject({ sessionKey: "review", startIndex: 0 });
      expect(read.messagePatches[0]!.messages).toHaveLength(20);
      expect(read.messagePatches.slice(1).every((patch) => patch.deferred)).toBe(true);
    });
  });

  test("reports an unreadable stored transcript without failing the read", async () => {
    await withStorage(async (storage, dataDir) => {
      const { record } = await seed(storage);
      const chunks = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY, "chunks");
      for (const name of await fs.readdir(chunks)) {
        await fs.writeFile(path.join(chunks, name), "corrupt");
      }
      const read = await conditionalBuildPipelineRead(storage, record, { knownSessions: {} });
      if (read.unchanged) throw new Error("expected patches");
      const bySession = new Map(read.messagePatches.map((patch) => [patch.sessionKey, patch]));
      expect(bySession.get("build")).toMatchObject({ unavailable: true, messages: [] });
      expect(bySession.get("legacy")?.messages).toHaveLength(4);
      expect((read.record.snapshot as { phase: string }).phase).toBe("verifying");
    });
  });
});
