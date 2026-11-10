import { afterEach, describe, expect, test } from "bun:test";
import type {
  SelfImprovementRunRefusal,
  SelfImprovementRunStart,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import type { SelfImprovementService } from "../self-improvement/service.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * `self-improvement.status` and `self-improvement.run` through the real
 * `public_action` entry and operation ledger, over a stand-in service: which
 * refusals leave no record, how a started run's receipt replays, and what a
 * request key conflict looks like.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const STARTED_AT = "2026-11-09T09:00:00.000Z";

interface FakeService {
  status: SelfImprovementStatus;
  /** The refusal the next `run` answers with, when set. */
  refuse: SelfImprovementRunRefusal | null;
  runs: Array<{ trigger: string }>;
}

function statusOf(overrides: Partial<SelfImprovementStatus>): SelfImprovementStatus {
  return {
    enabled: true,
    settings: { projectId: "p1", conversationReview: false, dailyRun: false },
    project: { id: "p1", name: "orkestrator-v2" },
    running: null,
    lastRun: null,
    nextDailyRunAt: null,
    tracked: [],
    themes: [],
    ...overrides,
  } as SelfImprovementStatus;
}

async function setup(): Promise<{ harness: PublicApiHarness; fake: FakeService }> {
  const harness = await createPublicApiHarness();
  cleanups.push(() => harness.cleanup());
  const fake: FakeService = { status: statusOf({}), refuse: null, runs: [] };
  harness.context.selfImprovement = {
    async status() {
      return fake.status;
    },
    async run(options: { trigger: string }): Promise<SelfImprovementRunStart> {
      if (fake.refuse) return { started: false, refusal: fake.refuse, status: fake.status };
      fake.runs.push(options);
      fake.status = statusOf({
        running: { trigger: options.trigger as never, startedAt: STARTED_AT, step: "exporting" },
      });
      return { started: true, status: fake.status };
    },
  } as unknown as SelfImprovementService;
  return { harness, fake };
}

describe("self-improvement actions", () => {
  test("refusals before admission leave no record, so the same key can run later", async () => {
    const { harness, fake } = await setup();
    fake.status = statusOf({ enabled: false });
    expect(await harness.call("self-improvement.run", {}, { requestId: "k1" })).toMatchObject({
      ok: false,
      error: { code: "capability-unavailable" },
    });
    fake.status = statusOf({ project: null });
    const noProject = await harness.call("self-improvement.run", {}, { requestId: "k1" });
    expect(noProject).toMatchObject({ ok: false, error: { code: "not-ready" } });
    expect((noProject as { receipt?: unknown }).receipt).toBeUndefined();
    fake.status = statusOf({
      running: { trigger: "daily", startedAt: STARTED_AT, step: "board" },
    });
    expect(await harness.call("self-improvement.run", {}, { requestId: "k1" })).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    expect(fake.runs).toEqual([]);

    fake.status = statusOf({});
    const started = await harness.call("self-improvement.run", {}, { requestId: "k1" });
    expect(started).toMatchObject({
      ok: true,
      result: { started: true, dryRun: false, startedAt: STARTED_AT },
    });
    expect(started.receipt?.replayed).toBe(false);
    expect(fake.runs).toEqual([{ trigger: "manual" }]);
  });

  test("the same key replays the started run; a different intent under it conflicts", async () => {
    const { harness, fake } = await setup();
    const first = await harness.call("self-improvement.run", { dryRun: true }, { requestId: "k2" });
    expect(first).toMatchObject({ ok: true, result: { dryRun: true, startedAt: STARTED_AT } });
    expect(fake.runs).toEqual([{ trigger: "dry-run" }]);

    const replay = await harness.call(
      "self-improvement.run",
      { dryRun: true },
      { requestId: "k2" },
    );
    expect(replay).toMatchObject({ ok: true, result: { dryRun: true, startedAt: STARTED_AT } });
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.receipt?.operationId).toBe(first.receipt?.operationId);

    const conflict = await harness.call("self-improvement.run", {}, { requestId: "k2" });
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(fake.runs).toHaveLength(1);
  });

  test("a refusal at start, after admission, fails the operation with a fixed message", async () => {
    const { harness, fake } = await setup();
    fake.refuse = "not-writer";
    const refused = await harness.call("self-improvement.run", {}, { requestId: "k3" });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "not-ready",
        message: "Another backend is using this data directory; runs happen there",
      },
    });
    fake.refuse = "already-running";
    const busy = await harness.call("self-improvement.run", {}, { requestId: "k4" });
    expect(busy).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(fake.runs).toEqual([]);
  });

  test("status is a read with no receipt, and bad input is refused", async () => {
    const { harness } = await setup();
    const status = await harness.call("self-improvement.status", {});
    expect(status).toMatchObject({ ok: true, result: { enabled: true } });
    expect((status as { receipt?: unknown }).receipt).toBeUndefined();
    expect(
      await harness.call("self-improvement.run", { dryRun: "yes" }, { requestId: "k5" }),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  test("a backend without the service says so", async () => {
    const { harness } = await setup();
    harness.context.selfImprovement = undefined;
    expect(await harness.call("self-improvement.status", {})).toMatchObject({
      ok: false,
      error: { code: "capability-unavailable" },
    });
  });
});
