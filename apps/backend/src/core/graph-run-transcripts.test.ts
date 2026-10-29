/**
 * Graph activation transcripts (item 211): stored in the build-pipeline
 * transcript store under the run's owner, kept while the run exists, removed
 * with it, and captured on a throttle by the agent executor's hook.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PipelineTranscriptReference } from "@orkestrator/protocol/build-pipeline";
import type { GraphRunWorld } from "./graph-run-executor-test-support.js";
import {
  createGraphRunTranscriptCapture,
  type GraphRunTranscriptStorage,
} from "./graph-run-transcripts.js";
import { failingPlan, harness, launch } from "./graph-run-view-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const MESSAGES = [
  { id: "m1", role: "user", text: "Do build." },
  { id: "m2", role: "assistant", text: "Done." },
];

describe("graph run transcript storage", () => {
  test("round trip, kept by the sweep while the run exists, removed with its environment", async () => {
    const h = await harness(worlds);
    const run = await launch(h, failingPlan({ onFailure: "skip" }));
    const storage = h.world.storage;
    const reference = await storage.commitGraphRunTranscript({
      runId: run.id,
      activationKey: "build#iter=1#attempt=1",
      sdkSessionId: "provider-session",
      messages: MESSAGES,
      revision: 1,
      fingerprint: "fp-1",
    });
    expect(reference).toMatchObject({ messageCount: 2, revision: 1, complete: true });
    // The same content again is idempotent: the committed reference.
    expect(
      await storage.commitGraphRunTranscript({
        runId: run.id,
        activationKey: "build#iter=1#attempt=1",
        sdkSessionId: "provider-session",
        messages: MESSAGES,
        revision: 1,
        fingerprint: "fp-1",
      }),
    ).toEqual(reference);
    const read = await storage.readGraphRunTranscript(run.id, "build#iter=1#attempt=1", reference!);
    expect(read).toMatchObject({ status: "found", messages: MESSAGES, substituted: false });
    expect(
      await storage.describeGraphRunTranscript(run.id, "build#iter=1#attempt=1"),
    ).toMatchObject({ fingerprint: "fp-1" });

    // An orphan (no such run) goes with the sweep; the live run's stays.
    await storage.commitGraphRunTranscript({
      runId: "no-such-run",
      activationKey: "build#iter=1#attempt=1",
      sdkSessionId: "provider-session",
      messages: MESSAGES,
      revision: 1,
      fingerprint: "fp-1",
    });
    const swept = await storage.sweepBuildPipelineTranscripts({ graceMs: -1 });
    expect(swept.orphans).toBe(1);
    expect(
      await storage.describeGraphRunTranscript(run.id, "build#iter=1#attempt=1"),
    ).not.toBeNull();
    expect(
      await storage.describeGraphRunTranscript("no-such-run", "build#iter=1#attempt=1"),
    ).toBeNull();

    expect(await storage.graphRuns.deleteGraphRunsByEnvironment("e1")).toEqual([run.id]);
    expect(await storage.describeGraphRunTranscript(run.id, "build#iter=1#attempt=1")).toBeNull();
  });
});

describe("transcript capture", () => {
  function fakeStorage() {
    const commits: { revision: number; messages: readonly unknown[] }[] = [];
    let committed: { reference: PipelineTranscriptReference; fingerprint: string } | null = null;
    const storage: GraphRunTranscriptStorage = {
      async commitGraphRunTranscript(input) {
        commits.push({ revision: input.revision, messages: input.messages });
        const reference: PipelineTranscriptReference = {
          version: 1,
          sdkSessionId: input.sdkSessionId,
          manifestRevision: commits.length,
          revision: input.revision,
          messageCount: input.messages.length,
          bytes: 10,
          complete: true,
          committedAt: "2026-10-29T00:00:00.000Z",
        } as PipelineTranscriptReference;
        committed = { reference, fingerprint: input.fingerprint };
        return reference;
      },
      async describeGraphRunTranscript() {
        return committed;
      },
    };
    return { storage, commits, setCommitted: (value: typeof committed) => (committed = value) };
  }

  test("captures on settling, else at most once per interval, and only changed content", async () => {
    const fake = fakeStorage();
    let now = 0;
    const capture = createGraphRunTranscriptCapture({
      storage: fake.storage,
      intervalMs: 15_000,
      clock: () => now,
    });
    let messages: unknown[] = [MESSAGES[0]];
    let reads = 0;
    const input = (settling: boolean) => ({
      runId: "run-1",
      activationKey: "build#iter=1#attempt=1",
      providerSessionId: "s",
      settling,
      readTranscript: async () => {
        reads += 1;
        return messages;
      },
    });
    expect(await capture(input(false))).toMatchObject({ revision: 1, messageCount: 1 });
    now = 5_000;
    messages = MESSAGES;
    // Inside the interval: not even read.
    expect(await capture(input(false))).toBeUndefined();
    expect(reads).toBe(1);
    now = 16_000;
    expect(await capture(input(false))).toMatchObject({ revision: 2, messageCount: 2 });
    // Settling always reads; unchanged content stores nothing.
    now = 17_000;
    expect(await capture(input(true))).toBeUndefined();
    expect(reads).toBe(3);
    expect(fake.commits.map((commit) => commit.revision)).toEqual([1, 2]);
  });

  test("after a restart it continues from the committed manifest", async () => {
    const fake = fakeStorage();
    const first = createGraphRunTranscriptCapture({ storage: fake.storage, clock: () => 0 });
    const input = {
      runId: "run-1",
      activationKey: "build#iter=1#attempt=1",
      providerSessionId: "s",
      settling: true,
      readTranscript: async () => MESSAGES,
    };
    const reference = await first(input);
    // A new process: the same content returns the committed reference without a commit.
    const second = createGraphRunTranscriptCapture({ storage: fake.storage, clock: () => 0 });
    expect(await second(input)).toEqual(reference);
    expect(fake.commits).toHaveLength(1);
    const third = createGraphRunTranscriptCapture({ storage: fake.storage, clock: () => 0 });
    expect(
      await third({ ...input, readTranscript: async () => [...MESSAGES, { id: "m3" }] }),
    ).toMatchObject({ revision: 2 });
  });

  test("never throws, and stores nothing for an empty transcript", async () => {
    const fake = fakeStorage();
    const capture = createGraphRunTranscriptCapture({ storage: fake.storage, clock: () => 0 });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(
        await capture({
          runId: "run-1",
          activationKey: "a",
          providerSessionId: "s",
          settling: true,
          readTranscript: async () => {
            throw new Error("bridge down");
          },
        }),
      ).toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(
      await capture({
        runId: "run-1",
        activationKey: "b",
        providerSessionId: "s",
        settling: true,
        readTranscript: async () => [],
      }),
    ).toBeUndefined();
    expect(fake.commits).toHaveLength(0);
  });
});
