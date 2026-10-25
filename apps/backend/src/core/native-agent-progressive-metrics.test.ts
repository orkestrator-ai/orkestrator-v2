import { describe, expect, test } from "bun:test";
import {
  ProgressiveReadMetrics,
  ProgressiveReadPhaseTimer,
  monotonicMs,
  type ProgressiveReadMetric,
} from "./native-agent-progressive-metrics.js";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

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
        const waiters = projectionInternals(service).progressiveReadWaiterCount;
        await waitForCondition(() => waiters() === 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        release();
        expect((await first).status).toBe("snapshot");
        expect((await second).status).toBe("snapshot");
        expect(reads).toBe(1);

        const samples = projectionInternals(
          service,
        ).progressiveMetrics.list() as ProgressiveReadMetric[];
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

describe("state and discovery read phase metrics", () => {
  const identity = {
    environmentId: "env-1",
    agent: "claude" as const,
    logicalSessionKey: "env-env-1:state-discovery-metrics",
  };

  test("domains are bounded separately, so polling one never evicts another", () => {
    const metrics = new ProgressiveReadMetrics();
    metrics.record({
      domain: "transcript",
      cacheTier: "provider",
      outcome: "delta",
      durationMs: 1,
    });
    for (let index = 0; index < 300; index += 1) {
      metrics.record({
        domain: "discovery",
        cacheTier: "memory",
        outcome: "unchanged",
        durationMs: 0,
      });
    }
    expect(metrics.list("transcript")).toHaveLength(1);
    expect(metrics.list("discovery")).toHaveLength(256);
    expect(metrics.list()).toHaveLength(257);
  });

  test("a state read splits its time into source and normalization", async () => {
    const stub = createProviderStub("claude", {
      status: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "idle";
      },
    });
    await withService(
      { prefix: "orkestrator-state-phase-metrics-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const first = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(first.status).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        await service.getSessionStateUpdate({
          ...identity,
          viewVersion: 1,
          knownToken: first.token,
        });
        const samples = projectionInternals(service).progressiveMetrics.list(
          "state",
        ) as ProgressiveReadMetric[];
        expect(samples.map((sample) => sample.outcome)).toEqual(["snapshot", "unchanged"]);
        for (const sample of samples) {
          expect(sample.sourceMs).toBeNumber();
          expect(sample.normalizeMs).toBeNumber();
          expect(sample.schedulerWaitMs).toBeNumber();
          expect(
            sample.sourceMs! + sample.normalizeMs! + sample.schedulerWaitMs!,
          ).toBeLessThanOrEqual(sample.durationMs + 3);
        }
        expect(samples[0]!.sourceMs!).toBeGreaterThan(0);
        expect(JSON.stringify(samples)).not.toContain(identity.logicalSessionKey);
      },
    );
  });

  test("discovery records each view read and each provider job", async () => {
    const stub = createProviderStub("claude", {
      slashCommands: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ name: "/review", description: "Review", source: "project" }];
      },
    });
    await withService(
      { prefix: "orkestrator-discovery-phase-metrics-", provider: async () => stub.provider },
      async ({ service }) => {
        const input = { ...identity, viewVersion: 1 as const, sections: ["commands" as const] };
        await service.ensureSession(input);
        await service.getDiscoveryUpdate(input);
        const internals = projectionInternals(service);
        await waitForCondition(() =>
          (internals.progressiveMetrics.list("discovery") as ProgressiveReadMetric[]).some(
            (sample) => sample.cacheTier === "provider",
          ),
        );
        const samples = internals.progressiveMetrics.list("discovery") as ProgressiveReadMetric[];
        const view = samples.find((sample) => sample.cacheTier === "memory")!;
        const job = samples.find((sample) => sample.cacheTier === "provider")!;
        expect(view).toMatchObject({ outcome: "snapshot" });
        expect(view.normalizeMs).toBeNumber();
        expect(view.sourceMs).toBeUndefined();
        expect(job.outcome === "snapshot" || job.outcome === "unchanged").toBe(true);
        expect(job.sourceMs!).toBeGreaterThan(0);
        expect(job.normalizeMs).toBeNumber();
        expect(JSON.stringify(samples)).not.toContain("/review");
      },
    );
  });
});

describe("discovery on return to an idle view", () => {
  test("expired sections refill in at most two-job batches: values change, no token is lost", async () => {
    let clock = 1_000;
    const stub = createProviderStub("claude", {
      slashCommands: async () => [{ name: "/review", description: "Review", source: "project" }],
    });
    await withService(
      {
        prefix: "orkestrator-discovery-return-",
        provider: async () => stub.provider,
        now: () => clock,
      },
      async ({ service }) => {
        const input = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:discovery-return",
          viewVersion: 1 as const,
          sections: ["commands" as const, "mcp" as const, "runtime" as const],
        };
        await service.ensureSession(input);
        const internals = projectionInternals(service);
        const read = async (knownToken?: string) => {
          const update = await service.getDiscoveryUpdate({
            ...input,
            ...(knownToken ? { knownToken } : {}),
          });
          // Let the scheduled section jobs settle before the next read.
          await waitForCondition(() => internals.progressiveReads.size === 0);
          return update;
        };
        const availability = (update: Awaited<ReturnType<typeof read>>) =>
          update.status === "snapshot"
            ? input.sections.map((section) => update.value.sections[section]?.availability)
            : update.status;

        // Fill every section, then settle on `unchanged`.
        let token: string | undefined;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const update = await read(token);
          if (update.status === "unchanged") break;
          if (update.status === "snapshot") token = update.token;
        }
        expect((await read(token)).status).toBe("unchanged");

        // Off screen past the 30 s section lifetime, then back.
        clock += 60_000;
        const seen: unknown[] = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const update = await read(token);
          seen.push(availability(update));
          if (update.status === "unchanged") break;
          if (update.status === "snapshot") token = update.token;
        }
        // Commands follow their catalogue's own state, so they stay ready.
        // The other sections read stale once expired; a provider runs at most
        // two section jobs at a time, so they turn ready one batch per read
        // (the commands job takes one slot). Each snapshot carries a changed
        // value, and the reader's token is honoured as soon as nothing changed:
        // the repeats on return are values filling in, not a dropped token.
        expect(seen).toEqual([
          ["ready", "stale", "stale"],
          ["ready", "ready", "stale"],
          ["ready", "ready", "ready"],
          "unchanged",
        ]);
      },
    );
  });
});
