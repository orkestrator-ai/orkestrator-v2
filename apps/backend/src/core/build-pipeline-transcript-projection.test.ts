import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { StorageService } from "./storage.js";
import { BUILD_PIPELINE_TRANSCRIPT_DIRECTORY } from "./build-pipeline-transcript-store.js";
import {
  BUILD_PIPELINE_PATCH_BUDGET_BYTES,
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
        1_800,
      );
      if (read.unchanged) throw new Error("expected patches");
      expect(read.messagePatches[0]).toMatchObject({ sessionKey: "review", startIndex: 0 });
      expect(read.messagePatches[0]!.messages.length).toBeGreaterThan(0);
      expect(read.messagePatches[0]!.messages.length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(1_800);
      expect(read.messagePatches.slice(1).every((patch) => patch.deferred)).toBe(true);
    });
  });

  test("pages a transcript within the response budget until all messages arrive", async () => {
    await withStorage(async (storage) => {
      const { record, build } = await seed(storage);
      let held: unknown[] = [];
      for (let attempt = 0; attempt < 20 && held.length < build.length; attempt += 1) {
        const read = await conditionalBuildPipelineRead(
          storage,
          record,
          {
            knownRevision: record.revision,
            knownSessions: {
              ...(held.length ? { build: { revision: 3, count: held.length } } : {}),
              review: { revision: 2, count: 20 },
              legacy: { revision: 1, count: 4 },
            },
            prioritySessionKey: "build",
          },
          1_800,
        );
        if (read.unchanged) throw new Error("expected a patch");
        expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(1_800);
        const patch = read.messagePatches.find((entry) => entry.sessionKey === "build");
        expect(patch?.messages.length).toBeGreaterThan(0);
        held = [...held.slice(0, patch!.startIndex), ...patch!.messages];
      }
      expect(held).toEqual(build);
    });
  });

  test("a stored transcript larger than the default response budget hydrates in bounded pages", async () => {
    await withStorage(async (storage) => {
      const body = messages(5, "large").map((entry) => ({
        ...(entry as object),
        text: "x".repeat(7 * 1024 * 1024),
      }));
      const session = await referencedSession(storage, "large", body, 1);
      const record = await storage.saveBuildPipeline("p1", "proj-1", "", 2, {
        id: "p1",
        phase: "complete",
        sessions: [session],
        currentSessionIndex: 0,
      });
      let held: unknown[] = [];
      for (let attempt = 0; attempt < 5 && held.length < body.length; attempt += 1) {
        const read = await conditionalBuildPipelineRead(storage, record, {
          knownSessions: held.length ? { large: { revision: 1, count: held.length } } : {},
          prioritySessionKey: "large",
        });
        if (read.unchanged) throw new Error("expected a patch");
        expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(
          BUILD_PIPELINE_PATCH_BUDGET_BYTES,
        );
        const patch = read.messagePatches[0]!;
        expect(patch.messages.length).toBeGreaterThan(0);
        held = [...held.slice(0, patch.startIndex), ...patch.messages];
      }
      expect(held).toEqual(body);
    });
  });

  test("continues paging a substituted generation from its own cursor", async () => {
    await withStorage(async (storage) => {
      const { record, build } = await seed(storage);
      const reader = {
        readBuildPipelineTranscript: async (
          _pipelineId: string,
          _session: unknown,
          window: { fromIndex?: number; toIndex?: number } = {},
        ) => ({
          status: "found" as const,
          messages: build.slice(window.fromIndex ?? 0, window.toIndex ?? build.length),
          startIndex: window.fromIndex ?? 0,
          messageCount: build.length,
          revision: 4,
          complete: true,
          substituted: true,
        }),
      };
      let held: unknown[] = [];
      for (let attempt = 0; attempt < 20 && held.length < build.length; attempt += 1) {
        const read = await conditionalBuildPipelineRead(
          reader,
          record,
          {
            knownSessions: {
              ...(held.length ? { build: { revision: 4, count: held.length } } : {}),
              review: { revision: 2, count: 20 },
              legacy: { revision: 1, count: 4 },
            },
            prioritySessionKey: "build",
          },
          1_800,
        );
        if (read.unchanged) throw new Error("expected patch");
        const patch = read.messagePatches[0]!;
        expect(patch.revision).toBe(4);
        expect(patch.messages.length).toBeGreaterThan(0);
        if (held.length) expect(patch.baseRevision).toBe(4);
        held = [...held.slice(0, patch.startIndex), ...patch.messages];
      }
      expect(held).toEqual(build);
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
