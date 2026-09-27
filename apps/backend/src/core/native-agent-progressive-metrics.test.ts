import { describe, expect, test } from "bun:test";
import {
  ProgressiveReadMetrics,
  ProgressiveReadPhaseTimer,
  monotonicMs,
  type ProgressiveReadMetric,
} from "./native-agent-progressive-metrics.js";
import {
  createProviderStub,
  internals,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

/** A clock the test advances by hand. */
function manualClock() {
  let now = 1_000;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("progressive read metrics", () => {
  test("samples are bounded, rounded and never negative", () => {
    const metrics = new ProgressiveReadMetrics();
    for (let index = 0; index < 300; index += 1) {
      metrics.record({
        domain: "transcript",
        cacheTier: "provider",
        outcome: "snapshot",
        durationMs: index + 0.4,
        sourceMs: -2,
        normalizeMs: 1.6,
        schedulerWaitMs: 0.2,
      });
    }
    const samples = metrics.list();
    expect(samples).toHaveLength(256);
    expect(samples[0]).toMatchObject({
      durationMs: 44,
      sourceMs: 0,
      normalizeMs: 2,
      schedulerWaitMs: 0,
    });
  });

  test("the default clock is monotonic, not wall-clock", () => {
    const before = performance.now();
    const value = monotonicMs();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(performance.now());
    // A wall-clock reading is epoch-sized; a monotonic one starts near zero.
    expect(value).toBeLessThan(Date.now() / 2);
  });

  test("phases split source, normalization and scheduler wait", async () => {
    const { clock, advance } = manualClock();
    const timer = new ProgressiveReadPhaseTimer(clock);
    const read = timer.own(async () => {
      advance(2); // session resolution: no phase
      timer.sourceStarted();
      advance(30);
      timer.sourceEnded();
      advance(5); // projection after the provider answered
      return "value";
    });
    await timer.covering(async () => {
      advance(7); // queued behind another read
      return read();
    });
    timer.normalize(() => advance(3));
    expect(timer.phases()).toEqual({ schedulerWaitMs: 7, sourceMs: 30, normalizeMs: 8 });
  });

  test("a caller whose own read never ran is joined; all its time is waiting", async () => {
    const { clock, advance } = manualClock();
    const timer = new ProgressiveReadPhaseTimer(clock);
    timer.own(async () => "never run");
    await timer.covering(async () => advance(12));
    expect(timer.phases()).toEqual({
      schedulerWaitMs: 12,
      sourceMs: 0,
      normalizeMs: 0,
      joined: true,
    });
  });

  test("a failed provider read records its wait but no normalization", async () => {
    const { clock, advance } = manualClock();
    const timer = new ProgressiveReadPhaseTimer(clock);
    const read = timer.own(async () => {
      timer.sourceStarted();
      advance(4);
      throw new Error("provider down");
    });
    await expect(timer.covering(read)).rejects.toThrow("provider down");
    expect(timer.phases()).toEqual({ schedulerWaitMs: 0, sourceMs: 0, normalizeMs: 0 });
  });
});

describe("transcript read phase metrics", () => {
  const identity = {
    environmentId: "env-1",
    agent: "cursor" as const,
    logicalSessionKey: "env-env-1:phase-metrics",
  };
  const secret = "private transcript body";

  function isBounded(sample: ProgressiveReadMetric): boolean {
    const phases =
      (sample.sourceMs ?? 0) + (sample.normalizeMs ?? 0) + (sample.schedulerWaitMs ?? 0);
    // Each field is rounded separately, so allow one unit per field.
    return phases <= sample.durationMs + 3;
  }

  test("a provider read populates every phase within its duration, without payloads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => {
        reads += 1;
        await gate;
        return {
          messages: [
            {
              id: "m-secret-id",
              role: "assistant",
              content: secret,
              parts: [],
              createdAt: "2026-09-27T00:00:00.000Z",
            },
          ],
          complete: true,
          revision: 1,
          sourceToken: "source-1",
          freshness: "current" as const,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-phase-metrics-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const first = service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        await waitForCondition(() => reads === 1);
        // A second reader of the same window joins the in-flight read.
        const second = service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        const waiters = () =>
          (service as unknown as { progressiveReadWaiterCount: number }).progressiveReadWaiterCount;
        await waitForCondition(() => waiters() === 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        release();
        expect((await first).status).toBe("snapshot");
        expect((await second).status).toBe("snapshot");
        expect(reads).toBe(1);

        const samples = internals(service).progressiveMetrics.list() as ProgressiveReadMetric[];
        const transcript = samples.filter((sample) => sample.domain === "transcript");
        expect(transcript).toHaveLength(2);
        const own = transcript.find((sample) => sample.joined !== true)!;
        const joined = transcript.find((sample) => sample.joined === true)!;
        for (const sample of [own, joined]) {
          expect(sample).toMatchObject({ cacheTier: "provider", outcome: "snapshot" });
          expect(sample.sourceMs).toBeNumber();
          expect(sample.normalizeMs).toBeNumber();
          expect(sample.schedulerWaitMs).toBeNumber();
          expect(isBounded(sample)).toBe(true);
        }
        // The reader that did the work spent its time at the provider; the
        // joined one spent it waiting on that read.
        expect(own.sourceMs!).toBeGreaterThan(0);
        expect(joined.sourceMs).toBe(0);
        expect(joined.schedulerWaitMs!).toBeGreaterThan(0);
        const serialized = JSON.stringify(samples);
        for (const forbidden of [secret, "m-secret-id", identity.logicalSessionKey, "source-1"]) {
          expect(serialized).not.toContain(forbidden);
        }
      },
    );
  });
});
