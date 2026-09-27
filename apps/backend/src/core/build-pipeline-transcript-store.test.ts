import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BuildPipelineTranscriptStore,
  type BuildPipelineTranscriptFaults,
  type BuildPipelineTranscriptLimits,
  type TranscriptCommitInput,
  type TranscriptCommitResult,
} from "./build-pipeline-transcript-store.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-transcripts-"));
  directories.push(directory);
  return directory;
}

function store(
  directory: string,
  options: {
    limits?: Partial<BuildPipelineTranscriptLimits>;
    faults?: BuildPipelineTranscriptFaults;
    now?: () => number;
  } = {},
): BuildPipelineTranscriptStore {
  return new BuildPipelineTranscriptStore({
    directory,
    limits: { targetChunkBytes: 1_024, ...options.limits },
    ...(options.faults ? { faults: () => options.faults } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

function messages(count: number, size = 200, prefix = "m"): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(size)}`,
  }));
}

function input(
  body: readonly unknown[],
  overrides: Partial<TranscriptCommitInput> = {},
): TranscriptCommitInput {
  return {
    pipelineId: "pipeline-1",
    sessionKey: "pipeline-1:build:0:a",
    sdkSessionId: "sdk-1",
    messages: body,
    revision: 1,
    fingerprint: transcriptFingerprint(body),
    ...overrides,
  };
}

function committed(result: TranscriptCommitResult) {
  if (result.status !== "committed") throw new Error(`commit ${result.status}`);
  return result;
}

async function chunkFiles(directory: string): Promise<Map<string, number>> {
  const entries = await fs.readdir(path.join(directory, "chunks"));
  const inodes = new Map<string, number>();
  for (const name of entries.filter((entry) => entry.endsWith(".chunk"))) {
    inodes.set(name, (await fs.stat(path.join(directory, "chunks", name))).ino);
  }
  return inodes;
}

describe("BuildPipelineTranscriptStore", () => {
  test("commits a session transcript and reads any window of it", async () => {
    const transcripts = store(await tempDirectory());
    const body = messages(40);
    const { reference } = committed(await transcripts.commit(input(body)));
    expect(reference).toMatchObject({
      version: 1,
      sdkSessionId: "sdk-1",
      manifestRevision: 1,
      revision: 1,
      messageCount: 40,
      complete: true,
    });

    const whole = await transcripts.read("pipeline-1", "pipeline-1:build:0:a", reference);
    expect(whole).toMatchObject({ status: "found", startIndex: 0, messageCount: 40 });
    expect(whole.status === "found" ? whole.messages : []).toEqual(body);

    const before = transcripts.stats().chunkReads;
    const tail = await transcripts.read("pipeline-1", "pipeline-1:build:0:a", reference, {
      fromIndex: 37,
    });
    expect(tail.status === "found" ? tail.messages : []).toEqual(body.slice(37));
    expect(tail.status === "found" ? tail.startIndex : -1).toBe(37);
    // Only the chunks overlapping the window are read.
    expect(transcripts.stats().chunkReads - before).toBeLessThanOrEqual(2);
  });

  test("an active tail update rewrites only the tail chunk and the manifest", async () => {
    const directory = await tempDirectory();
    const transcripts = store(directory, { limits: { targetChunkBytes: 8_192 } });
    // Several long histories: other sessions and completed stages.
    for (const session of ["review", "verify"]) {
      committed(
        await transcripts.commit(
          input(messages(1_000, 300, session), {
            sessionKey: `pipeline-1:${session}:0:a`,
            sdkSessionId: `sdk-${session}`,
          }),
        ),
      );
    }
    const body = messages(1_000, 300);
    committed(await transcripts.commit(input(body)));
    const before = await chunkFiles(directory);
    const statsBefore = transcripts.stats();

    // The provider streams into the newest entry.
    const streamed = [...body.slice(0, -1), { ...(body.at(-1) as object), text: "streamed more" }];
    const { reference } = committed(await transcripts.commit(input(streamed, { revision: 2 })));
    const stats = transcripts.stats();
    const after = await chunkFiles(directory);

    const chunkBytes = stats.chunkBytesWritten - statsBefore.chunkBytesWritten;
    const manifestBytes = stats.manifestBytesWritten - statsBefore.manifestBytesWritten;
    const historyBytes = 3 * 1_000 * 330;
    expect(stats.chunkWrites - statsBefore.chunkWrites).toBe(1);
    expect(chunkBytes).toBeLessThanOrEqual(8_192);
    // Bytes written per active tail update: one tail chunk plus a manifest
    // naming the sealed chunks — a small fraction of the histories involved.
    expect(chunkBytes + manifestBytes).toBeLessThan(historyBytes / 20);
    // Sealed chunks are referenced, never rewritten.
    const rewritten = [...before].filter(
      ([name, inode]) => after.has(name) && after.get(name) !== inode,
    );
    expect(rewritten).toEqual([]);
    const read = await transcripts.read("pipeline-1", "pipeline-1:build:0:a", reference);
    expect(read.status === "found" ? read.messages : []).toEqual(streamed);
  });

  test("an identical commit is idempotent and writes nothing", async () => {
    const transcripts = store(await tempDirectory());
    const body = messages(10);
    const first = committed(await transcripts.commit(input(body)));
    const writes = transcripts.stats();
    const retry = committed(await transcripts.commit(input(body, { revision: 5 })));
    expect(retry.written).toBe(false);
    expect(retry.reference).toEqual(first.reference);
    expect(transcripts.stats().chunkWrites).toBe(writes.chunkWrites);
    expect(transcripts.stats().manifestBytesWritten).toBe(writes.manifestBytesWritten);
  });

  test("a newly omitted message advances the reference and fingerprint", async () => {
    const transcripts = store(await tempDirectory(), {
      limits: { maxChunkBytes: 4_096, maxSessionBytes: 20_000 },
    });
    const body = messages(1);
    const first = committed(await transcripts.commit(input(body)));
    const appended = [...body, { id: "huge", text: "x".repeat(10_000) }];
    const second = committed(await transcripts.commit(input(appended, { revision: 2 })));
    expect(second.written).toBe(true);
    expect(second.reference.manifestRevision).toBeGreaterThan(first.reference.manifestRevision);
    expect(second.reference).toMatchObject({ complete: false, omittedMessages: 1, revision: 2 });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test("records oversized content as explicitly incomplete instead of failing", async () => {
    const transcripts = store(await tempDirectory(), {
      limits: { maxChunkBytes: 4_096, maxSessionBytes: 20_000 },
    });
    const huge = { id: "huge", role: "assistant", text: "y".repeat(10_000) };
    const body = [...messages(100, 300), huge];
    const { reference } = committed(await transcripts.commit(input(body)));
    expect(reference.complete).toBe(false);
    // The single message beyond the chunk bound, plus the oldest history
    // beyond the session bound, are omitted and counted.
    expect(reference.omittedMessages).toBe(101 - reference.messageCount);
    expect(reference.bytes).toBeLessThanOrEqual(20_000);
    const read = await transcripts.read("pipeline-1", "pipeline-1:build:0:a", reference);
    const kept = read.status === "found" ? read.messages : [];
    expect(kept).toEqual(body.slice(100 - reference.messageCount, 100));
  });

  test("keeps serving the referenced revision after a newer unreferenced commit", async () => {
    const transcripts = store(await tempDirectory());
    const old = messages(12);
    const { reference: oldReference } = committed(await transcripts.commit(input(old)));
    // A checkpoint whose control-record write then fails: the manifest moved on.
    committed(await transcripts.commit(input(messages(30, 200, "new"), { revision: 2 })));

    const read = await transcripts.read("pipeline-1", "pipeline-1:build:0:a", oldReference);
    expect(read).toMatchObject({ status: "found", substituted: false, revision: 1 });
    expect(read.status === "found" ? read.messages : []).toEqual(old);
  });

  test("a crash after chunk write leaves the old revision readable; repair collects the orphans", async () => {
    const directory = await tempDirectory();
    const clock = { now: Date.now() };
    const body = messages(20);
    const { reference } = committed(
      await store(directory, { now: () => clock.now }).commit(input(body)),
    );
    const chunksBefore = await chunkFiles(directory);
    const crashing = store(directory, {
      now: () => clock.now,
      faults: {
        at: (stage) => {
          if (stage === "after-chunks") throw new Error("crash after chunk write");
        },
      },
    });
    await expect(
      crashing.commit(input(messages(40, 200, "next"), { revision: 2 })),
    ).rejects.toThrow("crash after chunk write");

    const restarted = store(directory, { now: () => clock.now });
    const read = await restarted.read("pipeline-1", "pipeline-1:build:0:a", reference);
    expect(read.status === "found" ? read.messages : []).toEqual(body);
    expect((await chunkFiles(directory)).size).toBeGreaterThan(chunksBefore.size);

    clock.now += 120_000;
    const repair = await restarted.repair();
    expect(repair.removedChunks).toBeGreaterThan(0);
    expect([...(await chunkFiles(directory)).keys()].sort()).toEqual(
      [...chunksBefore.keys()].sort(),
    );
    const again = await restarted.read("pipeline-1", "pipeline-1:build:0:a", reference);
    expect(again.status === "found" ? again.messages : []).toEqual(body);
  });

  test("a crash after manifest publish exposes the new revision and keeps the old one", async () => {
    const directory = await tempDirectory();
    const old = messages(10);
    const { reference } = committed(await store(directory).commit(input(old)));
    const next = messages(15, 200, "next");
    await expect(
      store(directory, {
        faults: {
          at: (stage) => {
            if (stage === "after-manifest") throw new Error("crash after manifest publish");
          },
        },
      }).commit(input(next, { revision: 2 })),
    ).rejects.toThrow("crash after manifest publish");

    const restarted = store(directory);
    // The workflow record still references the old revision; it stays exact.
    const referenced = await restarted.read("pipeline-1", "pipeline-1:build:0:a", reference);
    expect(referenced.status === "found" ? referenced.messages : []).toEqual(old);
    const described = await restarted.describe("pipeline-1", "pipeline-1:build:0:a");
    expect(described?.reference).toMatchObject({ manifestRevision: 2, messageCount: 15 });
    // Retrying the checkpoint is idempotent.
    const retry = committed(await restarted.commit(input(next, { revision: 2 })));
    expect(retry.written).toBe(false);
  });

  test("deleting a pipeline removes every session and chunk and fences late checkpoints", async () => {
    const directory = await tempDirectory();
    const transcripts = store(directory);
    committed(await transcripts.commit(input(messages(10))));
    committed(
      await transcripts.commit(
        input(messages(10), { sessionKey: "pipeline-1:review:0:b", sdkSessionId: "sdk-2" }),
      ),
    );
    committed(await transcripts.commit(input(messages(5), { pipelineId: "pipeline-2" })));

    expect(await transcripts.deletePipeline("pipeline-1")).toBe(2);
    expect(await transcripts.commit(input(messages(3)))).toEqual({ status: "fenced" });
    expect(await transcripts.describe("pipeline-1", "pipeline-1:build:0:a")).toBeNull();
    expect(await transcripts.describe("pipeline-2", "pipeline-1:build:0:a")).not.toBeNull();
    expect((await chunkFiles(directory)).size).toBeGreaterThan(0);

    await transcripts.deletePipeline("pipeline-2");
    expect((await chunkFiles(directory)).size).toBe(0);
    transcripts.unfence("pipeline-1");
    expect((await transcripts.commit(input(messages(3)))).status).toBe("committed");
  });

  test("the orphan sweep removes transcripts no live pipeline owns after the grace window", async () => {
    const directory = await tempDirectory();
    const clock = { now: Date.now() };
    const transcripts = store(directory, { now: () => clock.now });
    committed(await transcripts.commit(input(messages(5))));
    committed(await transcripts.commit(input(messages(5), { pipelineId: "orphan" })));

    expect(await transcripts.sweepOrphans(["pipeline-1"])).toBe(0);
    clock.now += 11 * 60_000;
    expect(await transcripts.sweepOrphans(["pipeline-1"])).toBe(1);
    expect(await transcripts.describe("orphan", "pipeline-1:build:0:a")).toBeNull();
    expect(await transcripts.describe("pipeline-1", "pipeline-1:build:0:a")).not.toBeNull();
  });
});
