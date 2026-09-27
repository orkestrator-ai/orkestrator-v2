import { expect, test } from "bun:test";
import { summarizeBridgeMessage } from "@orkestrator/protocol/bridge-transcript-summary";
import type { ProviderTranscriptSnapshot } from "./agent-provider-contract.js";
import { MultiReviewProgressTracker, progressFingerprint } from "./multi-review-progress.js";
import { commitProgressObservation } from "./review-fanout.js";
import {
  applyProgressSample,
  compareProgressDigests,
  PROGRESS_SNAPSHOT_TARGET_BYTES,
  readTranscriptProgressSample,
  snapshotProgressDigest,
} from "./transcript-progress.js";

/** Every persisted workflow validator accepts exactly this digest shape. */
const PERSISTED_DIGEST = /^[0-9a-f]{64}$/;

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/**
 * A bridge-like provider: a conditional one-message window whose token moves
 * with a revision that also advances for usage/title churn, like the real
 * bridge envelope, and a legacy whole-history read that must stay untouched.
 */
class SnapshotProvider {
  readonly agent = "claude" as const;
  tail: unknown = { id: "m-1", role: "assistant", content: "working", parts: [] };
  startIndex = 0;
  generation: string | number = "gen-1";
  historyEpoch = "gen-1:epoch-1";
  representation: "summary" | undefined = "summary";
  revision = 1;
  failNext = false;
  answerUnchanged = false;
  readonly snapshotCalls: Array<{
    limit: number;
    targetBytes: number;
    knownSourceToken?: string;
    representation?: "summary";
  }> = [];
  readonly messageCalls: Array<{ limit?: number } | undefined> = [];

  /** Like the bridge token, scoped to the generation and epoch it was minted in. */
  private token(): string {
    return this.generation === "gen-1" && this.historyEpoch === "gen-1:epoch-1"
      ? `bt1.rev-${this.revision}`
      : `bt1.${this.historyEpoch}.rev-${this.revision}`;
  }

  async transcriptSnapshot(
    _sessionId: string,
    options: {
      limit: number;
      targetBytes: number;
      knownSourceToken?: string;
      representation?: "summary";
    },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
    this.snapshotCalls.push({ ...options });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("bridge unavailable");
    }
    if (this.answerUnchanged || options.knownSourceToken === this.token()) {
      return { unchanged: true, sourceToken: this.token() };
    }
    return {
      messages: [this.tail],
      historyStartIndex: this.startIndex,
      sourceToken: this.token(),
      complete: this.startIndex === 0,
      revision: this.revision,
      generation: this.generation,
      historyEpoch: this.historyEpoch,
      freshness: "current",
      ...(this.representation ? { representation: this.representation } : {}),
    };
  }

  async messages(_sessionId: string, options?: { limit?: number }): Promise<unknown[]> {
    this.messageCalls.push(options);
    return [this.tail];
  }
}

function setup() {
  const time = clock();
  const tracker = new MultiReviewProgressTracker(1_000, time.now);
  const provider = new SnapshotProvider();
  const observe = (persistedDigest?: string) =>
    tracker.observe(
      "session-1",
      (known) => readTranscriptProgressSample({ provider, sessionId: "session-1", known }),
      persistedDigest,
    );
  return { time, tracker, provider, observe };
}

function toolMessage(childOutput: string): unknown {
  return summarizeBridgeMessage({
    id: "m-1",
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    parts: [
      {
        type: "tool",
        toolUseId: "task-1",
        toolName: "Task",
        content: "",
        childTools: [
          { type: "tool", toolUseId: "child-1", toolName: "Bash", toolOutput: childOutput },
        ],
      },
    ],
  });
}

test("an unchanged probe is answered conditionally without any legacy transcript read", async () => {
  const { time, provider, observe } = setup();
  const first = await observe();
  expect(first).toMatchObject({ probed: true, baselineEstablished: true, changed: false });
  expect(first.digest).toMatch(PERSISTED_DIGEST);

  time.advance(1_000);
  const second = await observe();
  expect(second).toEqual({
    probed: true,
    baselineEstablished: false,
    changed: false,
    digest: first.digest,
  });

  // One bounded summary tail per due probe; the second carried the first's token.
  expect(provider.snapshotCalls).toEqual([
    { limit: 1, targetBytes: PROGRESS_SNAPSHOT_TARGET_BYTES, representation: "summary" },
    {
      limit: 1,
      targetBytes: PROGRESS_SNAPSHOT_TARGET_BYTES,
      knownSourceToken: "bt1.rev-1",
      representation: "summary",
    },
  ]);
  expect(provider.messageCalls).toEqual([]);

  // Throttled probes read nothing at all.
  await observe();
  expect(provider.snapshotCalls).toHaveLength(2);
});

test("token churn without a content change is not progress", async () => {
  const { time, provider, observe } = setup();
  const first = await observe();
  // Usage, title or access-time updates advance the bridge revision and so
  // its token, but the tail row and its position are identical.
  provider.revision += 3;
  time.advance(1_000);
  const second = await observe();
  expect(second).toMatchObject({ probed: true, changed: false, baselineEstablished: false });
  expect(second.digest).toBe(first.digest);
  expect(second.rebased).toBeUndefined();
  expect(provider.snapshotCalls[1]?.knownSourceToken).toBe("bt1.rev-1");
});

test("a nested child tool output change inside the tail message is progress", async () => {
  const { time, provider, observe } = setup();
  provider.tail = toolMessage("a".repeat(8 * 1024));
  // The summary carries a locator, not the body, so the sample stays small.
  expect(JSON.stringify(provider.tail).length).toBeLessThan(2 * 1024);
  await observe();

  provider.tail = toolMessage(`${"a".repeat(8 * 1024)}more output`);
  provider.revision += 1;
  time.advance(1_000);
  await expect(observe()).resolves.toMatchObject({ probed: true, changed: true });
});

test("an appended message is progress even when the new tail looks the same", async () => {
  const { time, provider, observe } = setup();
  await observe();
  provider.startIndex += 1;
  provider.revision += 1;
  time.advance(1_000);
  await expect(observe()).resolves.toMatchObject({ probed: true, changed: true });
});

test("a generation change establishes a new base without manufacturing progress", async () => {
  const { time, provider, observe } = setup();
  const first = await observe();
  const target: { progressAt?: string; progressDigest?: string } = {
    progressAt: "2026-01-01T00:00:00.000Z",
    progressDigest: first.digest,
  };

  // A bridge restart: new generation and epoch, and a different window.
  provider.generation = "gen-2";
  provider.historyEpoch = "gen-2:epoch-1";
  provider.tail = { id: "m-9", role: "assistant", content: "replayed", parts: [] };
  provider.revision = 1;
  time.advance(1_000);
  const rebased = await observe();
  expect(rebased).toMatchObject({
    probed: true,
    baselineEstablished: false,
    changed: false,
    rebased: true,
  });
  expect(commitProgressObservation(target, rebased)).toBe("evaluate");
  expect(target.progressAt).toBe("2026-01-01T00:00:00.000Z");
  expect(target.progressDigest).toBe(rebased.digest);

  // Later movement within the new base is progress again.
  provider.tail = { id: "m-9", role: "assistant", content: "replayed and moved", parts: [] };
  provider.revision += 1;
  time.advance(1_000);
  await expect(observe()).resolves.toMatchObject({ changed: true });
});

test("a representation change after a bridge upgrade rebases instead of counting", async () => {
  const { time, provider, observe } = setup();
  provider.representation = undefined;
  await observe();
  provider.representation = "summary";
  provider.revision += 1;
  time.advance(1_000);
  await expect(observe()).resolves.toMatchObject({ changed: false, rebased: true });
});

test("an old-format persisted baseline is replaced without progress or a new clock", async () => {
  const { provider, observe } = setup();
  const legacy = progressFingerprint([provider.tail]);
  const target: { progressAt?: string; progressDigest?: string } = {
    progressAt: "2026-01-01T00:00:00.000Z",
    progressDigest: legacy,
  };
  const observation = await observe(legacy);
  expect(observation).toMatchObject({
    probed: true,
    baselineEstablished: false,
    changed: false,
    rebased: true,
  });
  expect(commitProgressObservation(target, observation)).toBe("evaluate");
  expect(target.progressAt).toBe("2026-01-01T00:00:00.000Z");
  expect(target.progressDigest).toMatch(PERSISTED_DIGEST);
  expect(target.progressDigest).not.toBe(legacy);
});

test("a persisted version-2 digest is compared after a restart", async () => {
  const { provider, observe } = setup();
  const persisted = (await observe()).digest!;

  const restarted = new MultiReviewProgressTracker(1_000, clock().now);
  const observeAgain = () =>
    restarted.observe(
      "session-1",
      (known) => readTranscriptProgressSample({ provider, sessionId: "session-1", known }),
      persisted,
    );
  // No in-memory token after a restart: a full bounded sample, same content.
  await expect(observeAgain()).resolves.toMatchObject({ probed: true, changed: false });
  expect(provider.snapshotCalls.at(-1)?.knownSourceToken).toBeUndefined();
});

test("a failed read learns nothing and keeps the known source for the next probe", async () => {
  const { time, provider, observe } = setup();
  const first = await observe();
  provider.failNext = true;
  time.advance(1_000);
  await expect(observe()).resolves.toEqual({
    probed: false,
    baselineEstablished: false,
    changed: false,
  });
  time.advance(1_000);
  await expect(observe()).resolves.toMatchObject({
    probed: true,
    changed: false,
    digest: first.digest,
  });
  expect(provider.snapshotCalls.at(-1)?.knownSourceToken).toBe("bt1.rev-1");
});

test("an unchanged answer with nothing to compare it to is not a baseline", async () => {
  const { provider, observe } = setup();
  provider.answerUnchanged = true;
  await expect(observe()).resolves.toEqual({
    probed: false,
    baselineEstablished: false,
    changed: false,
  });
});

test("a cut tail row is hashed from the exact newest message, comparably with an uncut one", async () => {
  const exact = { id: "m-1", role: "assistant", content: "", parts: [{ id: "a" }, { id: "b" }] };
  const cut: ProviderTranscriptSnapshot = {
    messages: [{ ...exact, parts: [{ id: "b" }] }],
    omittedParts: 1,
    historyStartIndex: 3,
    historyEpoch: "g:e",
    sourceToken: "t-1",
  };
  const reads: string[] = [];
  const sample = await readTranscriptProgressSample({
    provider: {
      async transcriptSnapshot() {
        return cut;
      },
      async messages() {
        throw new Error("the shared read must be used");
      },
    },
    sessionId: "session-1",
    fallbackRead: async () => [{ id: "older" }, exact],
    onRead: (kind) => reads.push(kind),
  });
  expect(reads).toEqual(["snapshot", "fallback"]);
  expect(sample).toEqual({
    digest: snapshotProgressDigest({ ...cut, messages: [exact], omittedParts: undefined }),
    sourceToken: "t-1",
  });
  // The same row once it fits the target produces the same digest.
  expect(
    snapshotProgressDigest({ messages: [exact], historyStartIndex: 3, historyEpoch: "g:e" }),
  ).toBe(sample.digest);
});

test("providers without a snapshot surface keep the legacy tail digest", async () => {
  const messages = [{ id: "a" }, { id: "b" }];
  const calls: Array<{ limit?: number } | undefined> = [];
  const provider = {
    async messages(_sessionId: string, options?: { limit?: number }) {
      calls.push(options);
      return messages;
    },
  };
  const kinds: string[] = [];
  const sample = await readTranscriptProgressSample({
    provider,
    sessionId: "session-1",
    onRead: (kind) => kinds.push(kind),
  });
  // Byte-identical to what older builds persisted, so baselines stay comparable.
  expect(sample).toEqual({ digest: progressFingerprint([{ id: "b" }]) });
  expect(calls).toEqual([{ limit: 1 }]);
  expect(kinds).toEqual(["fallback"]);
});

test("version-2 digests are fixed-size, content-free and scoped to their base", () => {
  const secret = "secret tool output ".repeat(100);
  const base: ProviderTranscriptSnapshot = {
    messages: [{ id: "m", content: secret }],
    historyStartIndex: 4,
    historyEpoch: "g:e",
    representation: "summary",
    sourceToken: "t-1",
    revision: 1,
    title: "one",
  };
  const digest = snapshotProgressDigest(base);
  expect(digest).toMatch(PERSISTED_DIGEST);
  expect(digest).not.toContain("secret");
  // Token, revision, title and freshness are not content.
  expect(
    snapshotProgressDigest({
      ...base,
      sourceToken: "t-2",
      revision: 9,
      title: "two",
      freshness: "cached",
    }),
  ).toBe(digest);
  const moved = snapshotProgressDigest({ ...base, messages: [{ id: "m", content: "moved" }] });
  expect(compareProgressDigests(digest, moved)).toBe("changed");
  const otherEpoch = snapshotProgressDigest({ ...base, historyEpoch: "g:e2" });
  expect(compareProgressDigests(digest, otherEpoch)).toBe("rebased");
  expect(compareProgressDigests(undefined, digest)).toBe("baseline");
  expect(compareProgressDigests(digest, digest)).toBe("unchanged");
  // Two legacy digests stay comparable with each other; mixed formats are not.
  const legacyA = progressFingerprint([{ id: "a" }]);
  const legacyB = progressFingerprint([{ id: "b" }]);
  expect(compareProgressDigests(legacyA, legacyB)).toBe("changed");
  expect(compareProgressDigests(legacyA, digest)).toBe("rebased");
});

test("a tracker-less clock moves only on a first sample or a change", () => {
  const legacy = progressFingerprint([{ id: "a" }]);
  const v2 = snapshotProgressDigest({ messages: [{ id: "a" }], historyEpoch: "g:e" });
  const wait: { progressDigest?: string; progressAt?: string } = {
    progressDigest: legacy,
    progressAt: "2026-01-01T00:00:00.000Z",
  };
  expect(applyProgressSample(wait, v2, "2026-01-02T00:00:00.000Z")).toBe("rebased");
  expect(wait).toEqual({ progressDigest: v2, progressAt: "2026-01-01T00:00:00.000Z" });
  expect(applyProgressSample(wait, v2, "2026-01-03T00:00:00.000Z")).toBe("unchanged");
  expect(wait.progressAt).toBe("2026-01-01T00:00:00.000Z");
  const moved = snapshotProgressDigest({ messages: [{ id: "b" }], historyEpoch: "g:e" });
  expect(applyProgressSample(wait, moved, "2026-01-04T00:00:00.000Z")).toBe("changed");
  expect(wait).toEqual({ progressDigest: moved, progressAt: "2026-01-04T00:00:00.000Z" });

  const fresh: { progressDigest?: string; progressAt?: string } = {};
  expect(applyProgressSample(fresh, v2, "2026-01-05T00:00:00.000Z")).toBe("baseline");
  expect(fresh).toEqual({ progressDigest: v2, progressAt: "2026-01-05T00:00:00.000Z" });
});
