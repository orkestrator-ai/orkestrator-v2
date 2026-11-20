import { describe, expect, test } from "bun:test";
import {
  formatReviewTranscriptPushKey,
  type PushStamp,
  type ReviewTranscriptPushKey,
} from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import {
  REVIEW_TRANSCRIPT_ERROR_MS,
  REVIEW_TRANSCRIPT_MIN_PUBLISH_MS,
  REVIEW_TRANSCRIPT_PROBE_MS,
  ReviewTranscriptPushTopic,
  reviewTranscriptChangedParts,
  type ReviewTranscriptTarget,
} from "./review-transcript-push-topic.js";
import { BackendPush } from "./index.js";

const REVIEWER = formatReviewTranscriptPushKey({ workflowId: "wf-1", reviewerId: "r-1" });
const STEP = formatReviewTranscriptPushKey({ workflowId: "wf-1", step: "consolidate" });
const OTHER = formatReviewTranscriptPushKey({ workflowId: "wf-2", reviewerId: "r-9" });

function target(overrides: Partial<ReviewTranscriptTarget> = {}): ReviewTranscriptTarget {
  return {
    environmentId: "env-1",
    agent: "claude",
    providerSessionId: "session-1",
    live: true,
    digest: "d1",
    ...overrides,
  };
}

function multiReviewSaved(id: string) {
  return { resource: "multi-review", id, revision: 1 };
}

function harness(options: { announces?: boolean } = {}) {
  const clock = new ManualClock();
  const targets = new Map<string, ReviewTranscriptTarget | null>([
    [REVIEWER, target()],
    [STEP, target({ providerSessionId: "session-step", digest: "s1" })],
    [OTHER, target({ environmentId: "env-2", providerSessionId: "session-9" })],
  ]);
  const reads: string[] = [];
  const probes: Array<{ key: string; token: string | undefined }> = [];
  const tokens = new Map<string, string>();
  let failReads = 0;
  let announces = options.announces ?? true;
  const published: Array<{ key: string; stamp: PushStamp; parts: readonly string[] }> = [];
  const topic = new ReviewTranscriptPushTopic({
    timers: clock,
    now: () => clock.now(),
    readTarget: async (key: ReviewTranscriptPushKey) => {
      const id = formatReviewTranscriptPushKey(key);
      reads.push(id);
      if (failReads > 0) {
        failReads -= 1;
        throw new Error("storage unavailable");
      }
      return targets.get(id) ?? null;
    },
    bridgeAnnounces: () => announces,
    probeTranscript: async (key, token) => {
      const id = formatReviewTranscriptPushKey(key);
      probes.push({ key: id, token });
      return tokens.get(id) ?? "t0";
    },
    publish: (key, stamp, parts) => published.push({ key, stamp, parts }),
  });
  const settle = async (ms = 0) => {
    await clock.advanceAsync(ms);
    await flushMicrotasks();
  };
  const subscribe = async (...keys: string[]) => {
    for (const key of keys) {
      topic.retain(key);
      await topic.resolve(key);
    }
    await settle();
  };
  return {
    clock,
    topic,
    targets,
    tokens,
    reads,
    probes,
    published,
    settle,
    subscribe,
    failReads: (count: number) => {
      failReads = count;
    },
    setAnnounces: (value: boolean) => {
      announces = value;
    },
  };
}

describe("reviewTranscriptChangedParts", () => {
  test("names what moved", () => {
    const base = target();
    expect(reviewTranscriptChangedParts(base, base)).toEqual([]);
    expect(reviewTranscriptChangedParts(base, { ...base, digest: "d2" })).toEqual(["status"]);
    expect(reviewTranscriptChangedParts(base, { ...base, live: false })).toEqual(["status"]);
    expect(reviewTranscriptChangedParts(base, { ...base, providerSessionId: "s2" })).toEqual([
      "status",
      "transcript",
    ]);
    expect(reviewTranscriptChangedParts(base, null)).toEqual(["status", "transcript"]);
    expect(reviewTranscriptChangedParts(null, null)).toEqual([]);
  });
});

describe("ReviewTranscriptPushTopic", () => {
  test("resolve answers the stamp for a reviewer, missing for a gone one, denied for a bad key", async () => {
    const h = harness();
    h.topic.retain(REVIEWER);
    expect(await h.topic.resolve(REVIEWER)).toMatchObject({ status: "ok", revision: 0 });
    expect(h.reads).toEqual([REVIEWER]);
    await h.topic.resolve(REVIEWER);
    expect(h.reads).toEqual([REVIEWER]);
    h.targets.set(OTHER, null);
    h.topic.retain(OTHER);
    expect(await h.topic.resolve(OTHER)).toEqual({ status: "missing" });
    expect(await h.topic.resolve(STEP)).toEqual({ status: "missing" });
    expect(await h.topic.resolve("wf-1/session/x")).toEqual({ status: "denied" });
    expect(h.topic.validKey("wf-1/step/prepare")).toBe(true);
    h.topic.dispose();
  });

  test("a bridge hint for the reviewer's session publishes transcript without reading anything", async () => {
    const h = harness();
    await h.subscribe(REVIEWER, OTHER);
    const reads = h.reads.length;
    h.topic.hint("env-1", "claude", "session-1", ["transcript"]);
    expect(h.published).toEqual([
      { key: REVIEWER, stamp: expect.anything(), parts: ["transcript"] },
    ]);
    // Another session, another bridge, or a state-only revision: nothing.
    h.topic.hint("env-1", "claude", "session-x", ["transcript"]);
    h.topic.hint("env-1", "codex", "session-1", ["transcript"]);
    h.topic.hint("env-1", "claude", "session-1", ["state"]);
    expect(h.published).toHaveLength(1);
    expect(h.reads).toHaveLength(reads);
    expect(h.probes).toEqual([]);
    h.topic.dispose();
  });

  test("a streaming reviewer is announced at most once a second, ending with the last change", async () => {
    const h = harness();
    await h.subscribe(REVIEWER);
    for (let index = 0; index < 20; index += 1) {
      h.topic.hint("env-1", "claude", "session-1", ["transcript"]);
      await h.settle(100);
    }
    // Two seconds of hints every 100 ms: the first at once, then one per second.
    expect(h.published.length).toBeLessThanOrEqual(3);
    await h.settle(REVIEW_TRANSCRIPT_MIN_PUBLISH_MS);
    const last = h.published.length;
    expect(last).toBeGreaterThanOrEqual(2);
    // Nothing further is pending once the hints stop.
    await h.settle(REVIEW_TRANSCRIPT_MIN_PUBLISH_MS * 3);
    expect(h.published).toHaveLength(last);
    h.topic.dispose();
  });

  test("a lost-continuity hint announces every reviewer of that bridge", async () => {
    const h = harness();
    await h.subscribe(REVIEWER, STEP, OTHER);
    h.topic.hint("env-1", "claude", undefined);
    expect(h.published.map((entry) => entry.key).sort()).toEqual([REVIEWER, STEP].sort());
    h.topic.dispose();
  });

  test("a workflow save reads only that workflow's keys and publishes status, or a new session", async () => {
    const h = harness();
    await h.subscribe(REVIEWER, STEP, OTHER);
    h.reads.length = 0;
    h.topic.observeEvent("resource-changed", multiReviewSaved("wf-1"));
    await h.settle();
    expect(h.reads.sort()).toEqual([REVIEWER, STEP].sort());
    expect(h.published).toEqual([]);

    h.targets.set(REVIEWER, target({ digest: "d2", live: false }));
    h.topic.observeEvent("resource-changed", multiReviewSaved("wf-1"));
    h.topic.observeEvent("resource-changed", { resource: "build-pipeline", id: "wf-1" });
    await h.settle();
    expect(h.published).toEqual([{ key: REVIEWER, stamp: expect.anything(), parts: ["status"] }]);

    // A restarted reviewer shows another session: both parts, and its hints follow it.
    h.targets.set(REVIEWER, target({ providerSessionId: "session-2" }));
    h.topic.observeEvent("resource-changed", multiReviewSaved("wf-1"));
    await h.settle();
    expect(h.published.at(-1)?.parts).toEqual(["status", "transcript"]);
    const count = h.published.length;
    await h.settle(REVIEW_TRANSCRIPT_MIN_PUBLISH_MS);
    h.topic.hint("env-1", "claude", "session-1", ["transcript"]);
    expect(h.published).toHaveLength(count);
    h.topic.hint("env-1", "claude", "session-2", ["transcript"]);
    expect(h.published).toHaveLength(count + 1);
    h.topic.dispose();
  });

  test("status changes are urgent; the transcript throttle never holds them", async () => {
    const h = harness();
    expect(h.topic.urgentParts).toEqual(["status"]);
    await h.subscribe(REVIEWER);
    h.topic.hint("env-1", "claude", "session-1", ["transcript"]);
    h.topic.hint("env-1", "claude", "session-1", ["transcript"]);
    h.targets.set(REVIEWER, target({ digest: "decided" }));
    h.topic.observeEvent("resource-changed", multiReviewSaved("wf-1"));
    await h.settle();
    expect(h.published.map((entry) => entry.parts)).toEqual([["transcript"], ["status"]]);
    h.topic.dispose();
  });

  test("without bridge revisions a live reviewer is probed once for every viewer and announced when its token moves", async () => {
    const h = harness({ announces: false });
    h.topic.retain(REVIEWER);
    await h.topic.resolve(REVIEWER);
    // A viewer could have read t0 at mount, before the first probe.
    h.tokens.set(REVIEWER, "final");
    await h.settle();
    expect(h.published.map((entry) => entry.parts)).toEqual([["transcript"]]);
    expect(h.probes).toEqual([{ key: REVIEWER, token: undefined }]);
    await h.settle(REVIEW_TRANSCRIPT_PROBE_MS);
    expect(h.probes.at(-1)).toEqual({ key: REVIEWER, token: "final" });
    expect(h.published).toHaveLength(1);
    h.published.length = 0;
    h.tokens.set(REVIEWER, "t1");
    await h.settle(REVIEW_TRANSCRIPT_PROBE_MS);
    expect(h.published).toEqual([
      { key: REVIEWER, stamp: expect.anything(), parts: ["transcript"] },
    ]);
    // The bridge starts announcing: the probe stops reading.
    h.setAnnounces(true);
    const probes = h.probes.length;
    await h.settle(REVIEW_TRANSCRIPT_PROBE_MS * 3);
    expect(h.probes).toHaveLength(probes);
    h.topic.dispose();
  });

  test("a settled reviewer is not probed, and release stops every timer", async () => {
    const h = harness({ announces: false });
    h.targets.set(REVIEWER, target({ live: false }));
    await h.subscribe(REVIEWER);
    await h.settle(REVIEW_TRANSCRIPT_PROBE_MS * 3);
    expect(h.probes).toEqual([]);

    h.targets.set(REVIEWER, target());
    h.topic.observeEvent("resource-changed", multiReviewSaved("wf-1"));
    await h.settle();
    expect(h.probes).toHaveLength(1);
    h.topic.hint("env-1", "claude", "session-1");
    h.topic.hint("env-1", "claude", "session-1");
    h.topic.release(REVIEWER);
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.topic.metrics().observers).toBe(0);
  });

  test("a failed record read retries with backoff, and a failed first read fails the resolve", async () => {
    const h = harness();
    h.topic.retain(REVIEWER);
    h.failReads(1);
    await expect(h.topic.resolve(REVIEWER)).rejects.toThrow("Review transcript target read failed");
    await h.settle(REVIEW_TRANSCRIPT_ERROR_MS);
    expect(h.reads).toHaveLength(2);
    expect(h.topic.metrics()).toMatchObject({ readFailures: 1, reads: 2 });
    h.topic.dispose();
  });

  test("the backend's push layer offers the topic when given its reads", () => {
    const push = new BackendPush({
      nativeAgents: () => undefined,
      sessionExists: async () => false,
      reviewTranscripts: {
        readTarget: async () => null,
        bridgeAnnounces: () => false,
        probeTranscript: async () => undefined,
      },
    });
    expect(push.reviewTranscripts).not.toBeNull();
    expect(push.metrics().topics["review-transcript"]).toMatchObject({ observers: 0 });
    push.dispose();
    const without = new BackendPush({
      nativeAgents: () => undefined,
      sessionExists: async () => false,
    });
    expect(without.reviewTranscripts).toBeNull();
    without.dispose();
  });
});
