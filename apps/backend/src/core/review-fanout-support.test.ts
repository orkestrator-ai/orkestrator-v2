import { describe, expect, test } from "bun:test";
import {
  EFFICIENCY_OPERATIONS,
  RecordingEfficiencyObserver,
  recordEfficiency,
  reviewerCountBucket,
  sanitizeEfficiencyEvent,
  type EfficiencyEvent,
} from "./multi-review-efficiency.js";
import {
  DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS,
  ReviewEvidencePermits,
  evidenceGenerationKey,
} from "./review-evidence-permits.js";
import {
  MAX_REVIEW_FANOUT_CONCURRENCY,
  reviewFanoutConcurrency,
  runBoundedTasks,
  type BoundedTask,
} from "./review-fanout-scheduler.js";
import { PassTranscriptReader } from "./review-fanout-transcript.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("bounded fan-out task pool", () => {
  test("clamps configured limits", () => {
    expect(
      reviewFanoutConcurrency({ admission: 0, observation: 1_000, provider: Number.NaN }),
    ).toEqual({
      admission: 1,
      observation: MAX_REVIEW_FANOUT_CONCURRENCY,
      provider: 4,
    });
  });

  test("respects pool and group limits and starts tasks in order", async () => {
    const started: number[] = [];
    const gates = Array.from({ length: 6 }, deferred);
    const tasks: BoundedTask[] = gates.map((gate, index) => ({
      pool: "admission",
      group: index < 3 ? "a" : "b",
      run: async () => {
        started.push(index);
        await gate.promise;
      },
    }));
    const done = runBoundedTasks(tasks, { admission: 3, observation: 1, provider: 2 });
    await flush();
    // Group "a" allows two; the third slot goes to the first "b" task.
    expect(started).toEqual([0, 1, 3]);
    gates[0]!.resolve();
    await flush();
    expect(started).toEqual([0, 1, 3, 2]);
    for (const gate of gates) gate.resolve();
    const stats = await done;
    expect(started.sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(stats.maxActive).toBe(3);
    expect(stats.maxActiveByGroup).toEqual({ a: 2, b: 2 });
  });

  test("stops starting new work once asked, and still settles in-flight tasks", async () => {
    let stop = false;
    const started: number[] = [];
    const tasks: BoundedTask[] = Array.from({ length: 5 }, (_, index) => ({
      pool: "observation",
      group: "g",
      run: async () => {
        started.push(index);
        stop = true;
        await flush();
      },
    }));
    await runBoundedTasks(tasks, { admission: 1, observation: 1, provider: 4 }, () => !stop);
    expect(started).toEqual([0]);
  });

  test("a rejected task frees its slot without an unhandled rejection", async () => {
    const tasks: BoundedTask[] = [
      { pool: "admission", group: "g", run: async () => Promise.reject(new Error("boom")) },
      { pool: "admission", group: "g", run: async () => {} },
    ];
    await expect(
      runBoundedTasks(tasks, { admission: 1, observation: 1, provider: 1 }),
    ).resolves.toMatchObject({ maxActive: 1 });
  });
});

describe("pass-local transcript reader", () => {
  function provider() {
    const calls: Array<{ limit?: number }> = [];
    return {
      calls,
      value: {
        agent: "claude" as const,
        async messages(_sessionId: string, options: { limit?: number } = {}) {
          calls.push(options);
          return [1, 2, 3, 4, 5].slice(-(options.limit ?? 5));
        },
      },
    };
  }

  test("starts nothing until asked and memoizes identical shapes", async () => {
    const fake = provider();
    const reader = new PassTranscriptReader(fake.value, "session");
    expect(reader.started).toBe(false);
    expect(fake.calls).toEqual([]);
    await Promise.all([reader.read(1), reader.read(1)]);
    expect(fake.calls).toEqual([{ limit: 1 }]);
  });

  test("a larger read answers a smaller tail, never the reverse", async () => {
    const fake = provider();
    const reader = new PassTranscriptReader(fake.value, "session");
    expect(await reader.read(1)).toEqual([5]);
    // A full transcript cannot be served from a one-message tail.
    expect(await reader.read(undefined)).toEqual([1, 2, 3, 4, 5]);
    expect(fake.calls).toEqual([{ limit: 1 }, {}]);
    expect(await reader.read(3)).toEqual([3, 4, 5]);
    expect(fake.calls).toHaveLength(2);
    expect(reader.peek(64)).toBeDefined();
  });

  test("records reads, reuse and failures without content", async () => {
    const observer = new RecordingEfficiencyObserver();
    const reader = new PassTranscriptReader(
      {
        agent: "codex",
        messages: async () => {
          throw new Error("secret transcript text");
        },
      },
      "session",
      { observer, owner: "build-pipeline" },
    );
    await expect(reader.read(1)).rejects.toThrow();
    await flush();
    expect(observer.count("transcript.provider_read_started")).toBe(1);
    expect(observer.count("transcript.provider_read_failed")).toBe(1);
    expect(JSON.stringify(observer.events)).not.toContain("secret");
  });
});

describe("evidence permits", () => {
  const identity = {
    environmentId: "env-1",
    package: { id: "pkg", sha256: "a".repeat(64), bytes: 10, baseRef: "b", headRef: "h" },
    snapshotFingerprint: "f",
  };

  test("the generation key changes with every identity component", () => {
    const base = evidenceGenerationKey(identity);
    expect(evidenceGenerationKey({ ...identity })).toBe(base);
    for (const variant of [
      { ...identity, environmentId: "env-2" },
      { ...identity, package: { ...identity.package, sha256: "b".repeat(64) } },
      { ...identity, package: { ...identity.package, id: "pkg-2" } },
      { ...identity, package: { ...identity.package, headRef: "h2" } },
      { ...identity, snapshotFingerprint: "g" },
    ]) {
      expect(evidenceGenerationKey(variant)).not.toBe(base);
    }
  });

  test("verifies once per phase, generation and controller", async () => {
    let now = 0;
    const permits = new ReviewEvidencePermits(DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS, () => now);
    let verifications = 0;
    const verify = async () => {
      verifications += 1;
    };
    const scope = { generationKey: "g1", controllerToken: "t1" };
    expect(await permits.ensure("w1", "fanout", scope, verify)).toEqual({ reused: false });
    expect(await permits.ensure("w1", "fanout", scope, verify)).toEqual({ reused: true });
    expect(verifications).toBe(1);
    // Another phase, generation, controller or workflow verifies again.
    await permits.ensure("w1", "consolidation", scope, verify);
    await permits.ensure("w1", "fanout", { ...scope, generationKey: "g2" }, verify);
    await permits.ensure("w1", "fanout", { generationKey: "g2", controllerToken: "t2" }, verify);
    await permits.ensure("w2", "fanout", scope, verify);
    expect(verifications).toBe(5);
    // Expiry bounds the trust interval.
    now += DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS;
    await permits.ensure("w2", "fanout", scope, verify);
    expect(verifications).toBe(6);
  });

  test("a failed verification leaves no permit and invalidation drops both phases", async () => {
    const permits = new ReviewEvidencePermits();
    const scope = { generationKey: "g", controllerToken: "t" };
    await expect(
      permits.ensure("w", "fanout", scope, async () => {
        throw new Error("changed");
      }),
    ).rejects.toThrow("changed");
    expect(permits.size).toBe(0);
    await permits.ensure("w", "fanout", scope, async () => {});
    await permits.ensure("w", "consolidation", scope, async () => {});
    permits.invalidate("w");
    expect(permits.size).toBe(0);
  });
});

describe("efficiency observer", () => {
  test("labels are closed enums and numbers are sanitized", () => {
    const sanitized = sanitizeEfficiencyEvent({
      owner: "multi-review",
      operation: "reviewer.send",
      phase: "not-a-phase",
      outcome: "weird",
      platform: "some-account/secret-model",
      reviewers: 23,
      count: -4,
      bytes: 12.6,
      elapsedMs: Number.NaN,
      // A caller mistake must not smuggle an identifier through.
      workflowId: "workflow-123",
    } as unknown as EfficiencyEvent);
    expect(sanitized).toEqual({
      owner: "multi-review",
      operation: "reviewer.send",
      phase: "other",
      outcome: "failed",
      platform: "other",
      reviewers: 32,
      bytes: 13,
    });
    expect(sanitizeEfficiencyEvent({ owner: "x", operation: "y" } as never)).toBeNull();
    expect(reviewerCountBucket(3)).toBe(4);
  });

  test("a throwing observer cannot fail orchestration", () => {
    expect(() =>
      recordEfficiency(
        {
          record() {
            throw new Error("observer down");
          },
        },
        { owner: "build-pipeline", operation: EFFICIENCY_OPERATIONS[0] },
      ),
    ).not.toThrow();
  });

  test("the recorder is bounded", () => {
    const observer = new RecordingEfficiencyObserver(2);
    for (let index = 0; index < 5; index++) {
      observer.record({ owner: "multi-review", operation: "fence.check" });
    }
    expect(observer.events).toHaveLength(2);
    expect(observer.dropped).toBe(3);
  });
});
