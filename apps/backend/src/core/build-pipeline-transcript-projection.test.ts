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
  type TranscriptReader,
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
  sdkSessionId = `sdk-${key}`,
): Promise<PipelineSession> {
  const committed = await storage.commitBuildPipelineTranscript({
    pipelineId: "p1",
    sessionKey: key,
    sdkSessionId,
    messages: body,
    revision,
    fingerprint: transcriptFingerprint(body),
  });
  if (committed.status !== "staged") throw new Error("commit failed");
  return {
    phase: "build",
    iteration: 0,
    sessionKey: key,
    sdkSessionId,
    status: "idle",
    startedAt: "2026-09-01T00:00:00.000Z",
    label: key,
    messageRevision: revision,
    messagesFingerprint: committed.fingerprint,
    transcript: committed.reference,
  };
}

function saveSessions(
  storage: StorageService,
  sessions: PipelineSession[],
  expectedRevision?: number,
) {
  return storage.saveBuildPipeline(
    "p1",
    "proj-1",
    "",
    2,
    { id: "p1", phase: "building", sessions, currentSessionIndex: 0 },
    expectedRevision,
  );
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

      // Same control revision, but one body is behind: the tail comes back,
      // with the rows before it an older revision may hold stale copies of.
      const stale = await conditionalBuildPipelineRead(storage, record, {
        knownRevision: record.revision,
        knownSessions: { ...current, build: { revision: 2, count: 48 } },
      });
      expect(stale.unchanged).toBe(false);
      if (stale.unchanged) return;
      expect(stale.messagePatches).toEqual([
        {
          sessionKey: "build",
          startIndex: 0,
          revision: 3,
          messages: messages(50, "build"),
        },
      ]);
      expect(JSON.stringify(stale.record)).not.toContain("legacy-0");
    });
  });

  test("a change to an earlier row reaches a reader whose copy is from an older revision", async () => {
    await withStorage(async (storage) => {
      const first = messages(50, "build");
      const session = await referencedSession(storage, "build", first, 1);
      const record = await storage.saveBuildPipeline("p1", "proj-1", "", 2, {
        id: "p1",
        phase: "building",
        sessions: [session],
        currentSessionIndex: 0,
      });
      const initial = await conditionalBuildPipelineRead(storage, record, { knownSessions: {} });
      if (initial.unchanged) throw new Error("expected a patch");
      let held = initial.messagePatches[0]!.messages;
      expect(held).toEqual(first);

      // A late tool result lands on a step several rows back, and a new step
      // follows. Patching from the reader's last row only left the old copy.
      const second = [...first, { id: "build-50", role: "assistant", text: "next" }];
      second[0] = { ...(second[0] as object), text: "build:0 with its tool result" };
      const updated = await referencedSession(storage, "build", second, 2);
      const next = await storage.saveBuildPipeline("p1", "proj-1", "", record.revision, {
        id: "p1",
        phase: "building",
        sessions: [updated],
        currentSessionIndex: 0,
      });
      const read = await conditionalBuildPipelineRead(storage, next, {
        knownRevision: record.revision,
        knownSessions: { build: { revision: 1, count: held.length } },
      });
      if (read.unchanged) throw new Error("expected a patch");
      const patch = read.messagePatches[0]!;
      expect(patch).toMatchObject({ startIndex: 0, revision: 2 });
      expect(patch.baseRevision).toBeUndefined();
      held = [...held.slice(0, patch.startIndex), ...patch.messages];
      expect(held).toEqual(second);

      // Once current, the reader pages on from its tail without the overlap.
      const current = await conditionalBuildPipelineRead(storage, next, {
        knownSessions: { build: { revision: 2, count: 20 } },
      });
      if (current.unchanged) throw new Error("expected a patch");
      expect(current.messagePatches[0]!.startIndex).toBe(19);
    });
  });

  test("a growing transcript is patched from its first edited row, not resent whole", async () => {
    await withStorage(async (storage) => {
      const first = messages(50, "build");
      const record = await saveSessions(storage, [
        await referencedSession(storage, "build", first, 1),
      ]);
      // A streaming turn: the newest rows grow and a late tool result lands
      // three rows back.
      const second = [...first, ...messages(5, "more")];
      second[47] = { ...(second[47] as object), text: "build:47 with its tool result" };
      const next = await saveSessions(
        storage,
        [await referencedSession(storage, "build", second, 2)],
        record.revision,
      );

      const read = await conditionalBuildPipelineRead(storage, next, {
        knownRevision: record.revision,
        knownSessions: { build: { revision: 1, count: first.length } },
      });
      if (read.unchanged) throw new Error("expected a patch");
      const patch = read.messagePatches[0]!;
      expect(patch).toMatchObject({ baseRevision: 1, baseCount: 50, startIndex: 47, revision: 2 });
      expect(patch.messages).toEqual(second.slice(47));
      expect([...first.slice(0, patch.startIndex), ...patch.messages]).toEqual(second);
    });
  });

  for (const intervening of ["earlier edit", "provider replacement", "reused display revision"]) {
    test(`reconciles when a ${intervening} lands between the tail and prefix reads`, async () => {
      await withStorage(async (storage) => {
        const first = messages(50, "build");
        const initial = await saveSessions(storage, [
          await referencedSession(storage, "build", first, 1),
        ]);
        const second = [...first];
        second[47] = { id: "late-tool", role: "assistant", text: "updated row 47" };
        const next = await saveSessions(
          storage,
          [await referencedSession(storage, "build", second, 2)],
          initial.revision,
        );
        const authoritative =
          intervening === "provider replacement" ? messages(50, "replacement") : [...second];
        authoritative[30] = { id: "earlier-tool", role: "assistant", text: "updated row 30" };
        const revision = intervening === "reused display revision" ? 2 : 3;
        const starts: number[] = [];
        const reader: TranscriptReader = {
          async readBuildPipelineTranscript(id, session, window) {
            starts.push(window?.fromIndex ?? 0);
            const read = await storage.readBuildPipelineTranscript(id, session, window);
            if (starts.length === 1) {
              // Commit after the first manifest has answered, before the
              // projection requests the prefix that manifest proved safe.
              await saveSessions(
                storage,
                [
                  await referencedSession(
                    storage,
                    "build",
                    authoritative,
                    revision,
                    intervening === "provider replacement" ? "sdk-replacement" : "sdk-build",
                  ),
                ],
                next.revision,
              );
            }
            return read;
          },
        };
        const result = await conditionalBuildPipelineRead(reader, next, {
          knownSessions: { build: { revision: 1, count: first.length } },
        });
        if (result.unchanged) throw new Error("expected a patch");
        const patch = result.messagePatches[0]!;
        expect(starts).toEqual([49, 47, 0]);
        expect(patch).toMatchObject({ startIndex: 0, revision });
        expect(patch.baseRevision).toBeUndefined();
        expect(patch.baseCount).toBeUndefined();
        expect([...first.slice(0, patch.startIndex), ...patch.messages]).toEqual(authoritative);
      });
    });
  }

  for (const edit of [49, 50]) {
    test(`keeps the overlap and acknowledges the base when the first edit is row ${edit}`, async () => {
      await withStorage(async (storage) => {
        const first = messages(50, "build");
        const initial = await saveSessions(storage, [
          await referencedSession(storage, "build", first, 1),
        ]);
        const second = [...first, ...messages(3, "new")];
        second[edit] = { id: "changed", role: "assistant", text: "late update" };
        const next = await saveSessions(
          storage,
          [await referencedSession(storage, "build", second, 2)],
          initial.revision,
        );
        const starts: number[] = [];
        const reader: TranscriptReader = {
          readBuildPipelineTranscript(id, session, window) {
            starts.push(window?.fromIndex ?? 0);
            return storage.readBuildPipelineTranscript(id, session, window);
          },
        };
        const result = await conditionalBuildPipelineRead(reader, next, {
          knownSessions: { build: { revision: 1, count: 50 } },
        });
        if (result.unchanged) throw new Error("expected a patch");
        const patch = result.messagePatches[0]!;
        expect(starts).toEqual([49]);
        expect(patch).toMatchObject({
          startIndex: 49,
          revision: 2,
          baseRevision: 1,
          baseCount: 50,
        });
        expect([...first.slice(0, patch.startIndex), ...patch.messages]).toEqual(second);
      });
    });
  }

  test("a reader several checkpoints behind is patched from the earliest edit it missed", async () => {
    await withStorage(async (storage) => {
      const first = messages(50, "build");
      let record = await saveSessions(storage, [
        await referencedSession(storage, "build", first, 1),
      ]);
      const second = [...first, ...messages(5, "more")];
      record = await saveSessions(
        storage,
        [await referencedSession(storage, "build", second, 2)],
        record.revision,
      );
      const third = [...second, ...messages(5, "last")];
      third[30] = { ...(third[30] as object), text: "build:30 revised" };
      record = await saveSessions(
        storage,
        [await referencedSession(storage, "build", third, 3)],
        record.revision,
      );

      for (const [held, revision] of [
        [first, 1],
        [second, 2],
      ] as const) {
        const read = await conditionalBuildPipelineRead(storage, record, {
          knownSessions: { build: { revision, count: held.length } },
        });
        if (read.unchanged) throw new Error("expected a patch");
        const patch = read.messagePatches[0]!;
        expect(patch).toMatchObject({ baseRevision: revision, startIndex: 30, revision: 3 });
        expect([...held.slice(0, patch.startIndex), ...patch.messages]).toEqual(third);
      }
    });
  });

  test("after a restart an edit is located at chunk granularity", async () => {
    await withStorage(async (storage, dataDir) => {
      // ~45-byte rows in 256-byte chunks: several sealed chunks before the tail.
      storage.setBuildPipelineTranscriptLimits({ targetChunkBytes: 256 });
      const first = messages(50, "build");
      const record = await saveSessions(storage, [
        await referencedSession(storage, "build", first, 1),
      ]);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      restarted.setBuildPipelineTranscriptLimits({ targetChunkBytes: 256 });
      const second = [...first, ...messages(5, "more")];
      const next = await saveSessions(
        restarted,
        [await referencedSession(restarted, "build", second, 2)],
        record.revision,
      );

      const read = await conditionalBuildPipelineRead(restarted, next, {
        knownSessions: { build: { revision: 1, count: first.length } },
      });
      if (read.unchanged) throw new Error("expected a patch");
      const patch = read.messagePatches[0]!;
      // Without the previous checkpoint's digests the unsealed tail chunk is
      // resent, but every sealed chunk before it is kept.
      expect(patch).toMatchObject({ baseRevision: 1, revision: 2 });
      expect(patch.startIndex).toBeGreaterThan(0);
      expect(patch.startIndex).toBeLessThan(first.length);
      expect([...first.slice(0, patch.startIndex), ...patch.messages]).toEqual(second);
    });
  });

  test("a new provider session is reconciled from zero", async () => {
    await withStorage(async (storage) => {
      const first = messages(50, "build");
      const record = await saveSessions(storage, [
        await referencedSession(storage, "build", first, 1),
      ]);
      const second = [...first, ...messages(5, "more")];
      const replaced = await referencedSession(storage, "build", second, 2, "sdk-replacement");
      const next = await saveSessions(storage, [replaced], record.revision);

      const read = await conditionalBuildPipelineRead(storage, next, {
        knownSessions: { build: { revision: 1, count: first.length } },
      });
      if (read.unchanged) throw new Error("expected a patch");
      const patch = read.messagePatches[0]!;
      expect(patch).toMatchObject({ startIndex: 0, revision: 2 });
      expect(patch.baseRevision).toBeUndefined();
      expect(patch.messages).toEqual(second);
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

  test("oversized normalized legacy OpenCode rows declare a limitation and do not fence later history", async () => {
    await withStorage(async (storage) => {
      const { record } = await seed(storage);
      const raw = [
        {
          info: { id: "legacy-large", role: "assistant" },
          parts: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }],
        },
        {
          info: { id: "after-large", role: "assistant" },
          parts: [{ type: "text", text: "Later history" }],
        },
      ];
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(
        BUILD_PIPELINE_PATCH_BUDGET_BYTES,
      );
      const legacy: PipelineSession = {
        phase: "build",
        iteration: 0,
        sessionKey: "legacy-large",
        sdkSessionId: "sdk-large",
        status: "idle",
        startedAt: "2026-09-01T00:00:00.000Z",
        label: "legacy",
        messageRevision: 1,
        messages: raw,
      };
      const legacyRecord = { ...record, snapshot: { sessions: [legacy], currentSessionIndex: 0 } };
      const read = await conditionalBuildPipelineRead(storage, legacyRecord, { knownSessions: {} });
      if (read.unchanged) throw new Error("expected patches");
      expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(
        BUILD_PIPELINE_PATCH_BUDGET_BYTES,
      );
      const patch = read.messagePatches[0]!;
      expect(patch.deferred).toBeUndefined();
      expect(patch.messages).toHaveLength(2);
      expect(patch.messages[0]).toMatchObject({
        id: "legacy-large",
        content: expect.stringContaining("omitted from display"),
      });
      expect(patch.messages[1]).toMatchObject({ id: "after-large", content: "Later history" });
      expect(
        await conditionalBuildPipelineRead(storage, legacyRecord, {
          knownRevision: record.revision,
          knownSessions: { "legacy-large": { revision: 1, count: 2 } },
        }),
      ).toEqual({ unchanged: true, revision: record.revision });
      const persisted = await storage.readBuildPipelineTranscript("p1", legacy);
      expect(persisted.status === "found" && persisted.messages[0]).toBe(raw[0]);
    });
  });

  test("a stored row too large for any response is replaced, not left to fence later rows", async () => {
    await withStorage(async (storage) => {
      // The store stops a budgeted page before the large row; the projection
      // must still reach it, whether it follows other rows or starts the page.
      const body = [
        { id: "before", role: "assistant", content: "Earlier history" },
        { id: "large", role: "assistant", content: "x".repeat(8 * 1024) },
        { id: "after", role: "assistant", content: "Later history" },
      ];
      const session = await referencedSession(storage, "stored-large", body, 1);
      const record = await storage.saveBuildPipeline("p1", "proj-1", "", 2, {
        id: "p1",
        phase: "complete",
        sessions: [session],
        currentSessionIndex: 0,
      });
      const budget =
        Buffer.byteLength(
          JSON.stringify({
            unchanged: false,
            record: withoutTranscriptBodies(record),
            messagePatches: [],
          }),
          "utf8",
        ) + 2048;
      let held: unknown[] = [];
      for (let attempt = 0; attempt < 5 && held.length < body.length; attempt += 1) {
        const read = await conditionalBuildPipelineRead(
          storage,
          record,
          {
            knownSessions: held.length
              ? { "stored-large": { revision: 1, count: held.length } }
              : {},
          },
          budget,
        );
        if (read.unchanged) throw new Error("expected a patch");
        expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(budget);
        const patch = read.messagePatches[0]!;
        held = [...held.slice(0, patch.startIndex), ...patch.messages];
      }
      expect(held).toHaveLength(3);
      expect(held[0]).toEqual(body[0]);
      expect(held[1]).toMatchObject({
        id: "large",
        content: expect.stringContaining("omitted from display"),
      });
      expect(held[2]).toEqual(body[2]);
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

  test("a patch of many messages reads each chunk once", async () => {
    await withStorage(async (storage) => {
      storage.setBuildPipelineTranscriptLimits({ targetChunkBytes: 256 });
      const { record, build } = await seed(storage);
      const chunks = new Set<number>();
      // ~45-byte messages packed into 256-byte chunks: several messages each.
      let size = 2;
      let chunk = 0;
      for (const message of build) {
        const bytes = JSON.stringify(message).length + 1;
        if (size > 2 && size + bytes > 256) {
          chunk += 1;
          size = 2;
        }
        size += bytes;
        chunks.add(chunk);
      }
      expect(chunks.size).toBeGreaterThan(4);
      const before = storage.buildPipelineTranscriptStats().chunkReads;
      const read = await conditionalBuildPipelineRead(storage, record, {
        knownSessions: { review: { revision: 2, count: 20 }, legacy: { revision: 1, count: 4 } },
        prioritySessionKey: "build",
      });
      if (read.unchanged) throw new Error("expected a patch");
      expect(read.messagePatches[0]).toMatchObject({ sessionKey: "build", messages: build });
      expect(storage.buildPipelineTranscriptStats().chunkReads - before).toBe(chunks.size);

      // A paged tail read touches only the chunks it returns.
      const tailBefore = storage.buildPipelineTranscriptStats().chunkReads;
      const tail = await conditionalBuildPipelineRead(storage, record, {
        knownRevision: record.revision,
        knownSessions: {
          build: { revision: 3, count: 49 },
          review: { revision: 2, count: 20 },
          legacy: { revision: 1, count: 4 },
        },
      });
      if (tail.unchanged) throw new Error("expected a patch");
      expect(tail.messagePatches[0]).toMatchObject({ startIndex: 48, messages: build.slice(48) });
      expect(storage.buildPipelineTranscriptStats().chunkReads - tailBefore).toBeLessThanOrEqual(2);
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

  test("serves stored OpenCode envelopes as display messages, one for one", async () => {
    await withStorage(async (storage) => {
      // Stored exactly as the provider returned them; other backend readers
      // (structured output, result evidence) parse this raw shape.
      const openCode = (index: number) => ({
        info: { id: `oc-${index}`, role: "assistant", time: { created: 1_800_000_000_000 } },
        parts: [{ id: `part-${index}`, type: "text", text: `opencode:${index}` }],
      });
      const raw = [
        openCode(0),
        { info: { role: "assistant", time: { created: 1e18 } }, parts: [] },
        { id: "flat", role: "assistant", content: "bridge row" },
        openCode(3),
      ];
      const session = await referencedSession(storage, "oc", raw, 2);
      const legacy = {
        ...session,
        sessionKey: "legacy-oc",
        transcript: undefined,
        messagesFingerprint: undefined,
        messages: [openCode(9)],
      };
      const record = await storage.saveBuildPipeline("p1", "proj-1", "", 2, {
        id: "p1",
        phase: "building",
        sessions: [session, legacy],
        currentSessionIndex: 0,
      });

      const whole = await conditionalBuildPipelineRead(storage, record, { knownSessions: {} });
      if (whole.unchanged) throw new Error("expected patches");
      const bySession = new Map(whole.messagePatches.map((patch) => [patch.sessionKey, patch]));
      expect(bySession.get("oc")!.messages).toEqual([
        {
          id: "oc-0",
          role: "assistant",
          content: "opencode:0",
          parts: [{ type: "text", content: "opencode:0", sourcePartId: "part-0" }],
          createdAt: "2027-01-15T08:00:00.000Z",
        },
        // Out-of-range clock: no throw, no timestamp, a position-derived id.
        { id: "opencode-message-1", role: "assistant", content: "", parts: [] },
        raw[2],
        expect.objectContaining({ id: "oc-3", content: "opencode:3" }),
      ]);
      expect(bySession.get("legacy-oc")!.messages).toEqual([
        expect.objectContaining({ id: "oc-9", content: "opencode:9" }),
      ]);

      // A tail patch addresses the client's copy by raw index and count. The
      // client's copy is from an older revision, so the rows before its tail
      // are re-sent too — as display messages, like every other row.
      const tail = await conditionalBuildPipelineRead(storage, record, {
        knownSessions: { oc: { revision: 1, count: 3 }, "legacy-oc": { revision: 2, count: 1 } },
      });
      if (tail.unchanged) throw new Error("expected a patch");
      const patch = tail.messagePatches.find((candidate) => candidate.sessionKey === "oc")!;
      expect(patch).toMatchObject({ startIndex: 0 });
      expect(patch.baseCount).toBeUndefined();
      expect(patch.messages).toEqual([
        expect.objectContaining({ id: "oc-0", content: "opencode:0" }),
        { id: "opencode-message-1", role: "assistant", content: "", parts: [] },
        raw[2],
        expect.objectContaining({ id: "oc-3" }),
      ]);

      // The store itself still holds the provider's raw envelopes.
      const stored = await storage.readBuildPipelineTranscript("p1", session);
      expect(stored.status === "found" && stored.messages).toEqual(raw);
    });
  });
});

test("revision reconciliation pages every held row even beyond the old overlap byte cap", async () => {
  await withStorage(async (storage) => {
    const first = messages(50, "wide").map((row) => ({
      ...(row as object),
      content: "x".repeat(24 * 1024),
    }));
    const session = await referencedSession(storage, "wide", first, 1);
    const record = await storage.saveBuildPipeline("p1", "proj-1", "", 2, {
      id: "p1",
      phase: "building",
      sessions: [session],
      currentSessionIndex: 0,
    });
    const second = [...first, { id: "wide-50", role: "assistant", content: "new" }];
    second[0] = { ...(second[0] as object), content: "late root result" };
    second[36] = { ...(second[36] as object), content: "late overlap result" };
    const updated = await referencedSession(storage, "wide", second, 2);
    const next = await storage.saveBuildPipeline("p1", "proj-1", "", record.revision, {
      id: "p1",
      phase: "building",
      sessions: [updated],
      currentSessionIndex: 0,
    });
    let held: unknown[] = first;
    let revision = 1;
    for (let pass = 0; pass < 10; pass++) {
      const read = await conditionalBuildPipelineRead(
        storage,
        next,
        { knownSessions: { wide: { revision, count: held.length } } },
        400 * 1024,
      );
      if (read.unchanged) throw new Error("expected a reconciliation patch");
      const patch = read.messagePatches[0]!;
      if (pass === 0) expect(patch.startIndex).toBe(0);
      expect(patch.messages.length).toBeGreaterThan(0);
      held = [...held.slice(0, patch.startIndex), ...patch.messages];
      revision = patch.revision;
      if (held.length === second.length) break;
    }
    expect(held).toEqual(second);
    expect(
      await conditionalBuildPipelineRead(storage, next, {
        knownRevision: next.revision,
        knownSessions: { wide: { revision, count: held.length } },
      }),
    ).toEqual({ unchanged: true, revision: next.revision });
  });
});
