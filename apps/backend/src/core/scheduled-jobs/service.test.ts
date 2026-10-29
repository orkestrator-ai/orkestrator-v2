import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ScheduleAction,
  ScheduleFire,
  ScheduleOwner,
  ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";
import { SCHEDULED_JOB_LIMITS } from "@orkestrator/protocol/scheduled-jobs";
import { StorageService } from "../storage.js";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout.js";
import { ScheduleAuthorityError, type ScheduledJobExecutor } from "./executor.js";
import { claimDueFire, settleFire, type FireResult } from "./model.js";
import { ScheduledJobService, SAFETY_TICK_MS, ScheduleNotFoundError } from "./service.js";

/**
 * The scheduler over real storage with a recording executor: persistence
 * across a restart, the catch-up rule, exactly-once claims across two
 * backends sharing a data directory, stale-claim recovery, busy retries and
 * who may see and manage a schedule.
 */

const OPERATOR: ScheduleOwner = { kind: "operator" };
const AGENT: ScheduleOwner = {
  kind: "agent",
  projectId: "p1",
  environmentId: "env-1",
  tabId: "t1",
};
const OTHER_AGENT: ScheduleOwner = {
  kind: "agent",
  projectId: "p1",
  environmentId: "env-2",
  tabId: "t1",
};
const MAIL: ScheduleAction = {
  kind: "action",
  action: "mail.send",
  input: { toEnvironmentId: "env-9", toTabId: "startup-agent", body: "wake up" },
};

class RecordingExecutor {
  readonly fired: Array<{ fireId: string; kind: string; missed?: number }> = [];
  validations: Array<{ owner: ScheduleOwner; action: ScheduleAction }> = [];
  next: (fire: ScheduleFire) => FireResult | Promise<FireResult> = () => ({
    ok: true,
    outcome: { summary: "ok" },
  });
  refuse: string | null = null;

  async validate(owner: ScheduleOwner, action: ScheduleAction): Promise<void> {
    this.validations.push({ owner, action });
    if (this.refuse) throw new ScheduleAuthorityError(this.refuse);
  }

  async execute(_job: ScheduledJob, fire: ScheduleFire): Promise<FireResult> {
    this.fired.push({
      fireId: fire.fireId,
      kind: fire.kind,
      ...(fire.missed ? { missed: fire.missed } : {}),
    });
    return this.next(fire);
  }
}

const roots: string[] = [];
const storages: StorageService[] = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-scheduled-jobs-"));
  roots.push(root);
  return root;
}

async function backend(dir: string, clock: { now: number }, executor = new RecordingExecutor()) {
  const storage = new StorageService(dir);
  await storage.init();
  storages.push(storage);
  const service = new ScheduledJobService({
    store: storage.scheduledJobStore(),
    executor: executor as unknown as ScheduledJobExecutor,
    now: () => clock.now,
    defaultTimeZone: () => "Europe/London",
  });
  return { storage, service, executor };
}

async function tick(service: ScheduledJobService): Promise<void> {
  await service.tick();
  await service.idle();
}

const T0 = Date.parse("2026-10-25T10:00:00Z");

describe("creation", () => {
  test("stores the owner, zone, catch-up window and next fire; idempotent per request key", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    const created = await service.create(AGENT, { at: "03:12", action: MAIL }, "req-1");
    expect(created.replayed).toBe(false);
    expect(created.job).toMatchObject({
      owner: AGENT,
      ownerKey: "env:env-1",
      timeZone: "Europe/London",
      catchUpMinutes: 15,
      state: "active",
      nextFireAt: "2026-10-26T03:12:00.000Z",
      trigger: { kind: "once", at: "2026-10-26T03:12:00.000Z" },
    });
    expect(executor.validations).toHaveLength(1);
    const again = await service.create(AGENT, { at: "03:12", action: MAIL }, "req-1");
    expect(again).toMatchObject({ replayed: true, job: { id: created.job.id } });
    await expect(service.create(AGENT, { at: "04:00", action: MAIL }, "req-1")).rejects.toThrow(
      /different schedule/,
    );
    // The same key from another owner is a different schedule.
    const other = await service.create(OTHER_AGENT, { at: "03:12", action: MAIL }, "req-1");
    expect(other.job.id).not.toBe(created.job.id);
  });

  test("the facade adapter reuses its store across database reopen and announces committed edits", async () => {
    const { storage, service } = await backend(await dataDir(), { now: T0 });
    const store = storage.scheduledJobStore();
    const changes: string[] = [];
    storage.addResourceChangeListener((event) => {
      if (event.resource === "scheduled-job") changes.push(event.id!);
    });
    const { job } = await service.create(OPERATOR, { at: "+5m", action: MAIL });
    expect(changes).toEqual([job.id]);
    storage.close();
    expect(storage.scheduledJobStore()).toBe(store);
    expect(store.get(job.id)).toEqual(job);
    expect(store.mutate(job.id, () => ({ result: "removed", delete: true }))).toBe("removed");
    expect(store.get(job.id)).toBeNull();
    expect(changes).toEqual([job.id, job.id]);
  });

  test("refuses what the owner could not run, and stores nothing", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    executor.refuse = "You cannot call launch_environment";
    await expect(service.create(AGENT, { at: "+5m", action: MAIL })).rejects.toThrow(
      ScheduleAuthorityError,
    );
    expect(service.list(OPERATOR)).toHaveLength(0);
  });

  test("validates triggers and bounds per owner", async () => {
    const clock = { now: T0 };
    const { service } = await backend(await dataDir(), clock);
    await expect(service.create(AGENT, { action: MAIL })).rejects.toThrow(/exactly one/);
    await expect(service.create(AGENT, { everySeconds: 30, action: MAIL })).rejects.toThrow(
      /everySeconds/,
    );
    await expect(service.create(AGENT, { cron: "0 0 31 2 *", action: MAIL })).rejects.toThrow(
      /never fires/,
    );
    await expect(
      service.create(AGENT, { at: "+5m", timeZone: "Nowhere/City", action: MAIL }),
    ).rejects.toThrow(/time zone/);
    for (let index = 0; index < SCHEDULED_JOB_LIMITS.maxPerOwner; index += 1) {
      await service.create(AGENT, { at: "+5m", action: MAIL });
    }
    await expect(service.create(AGENT, { at: "+5m", action: MAIL })).rejects.toThrow(/already has/);
  });
});

describe("firing", () => {
  test("a one-shot fires once at its time, records the outcome and completes", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    const { job } = await service.create(OPERATOR, { at: "+2m", action: MAIL });
    await tick(service);
    expect(executor.fired).toHaveLength(0);
    clock.now = T0 + 2 * 60_000;
    await tick(service);
    await tick(service);
    expect(executor.fired).toEqual([{ fireId: `${job.id}@${T0 + 120_000}`, kind: "scheduled" }]);
    const stored = service.get(OPERATOR, job.id);
    expect(stored.state).toBe("completed");
    expect(stored.nextFireAt).toBeNull();
    expect(stored.fires).toMatchObject([
      { state: "succeeded", attempts: 1, outcome: { summary: "ok" } },
    ]);
  });

  test("an interval keeps its rhythm and history stays bounded", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    const { job } = await service.create(OPERATOR, { everySeconds: 60, action: MAIL });
    for (let minute = 1; minute <= SCHEDULED_JOB_LIMITS.historyEntries + 5; minute += 1) {
      clock.now = T0 + minute * 60_000;
      await tick(service);
    }
    expect(executor.fired).toHaveLength(SCHEDULED_JOB_LIMITS.historyEntries + 5);
    const stored = service.get(OPERATOR, job.id);
    expect(stored.fires).toHaveLength(SCHEDULED_JOB_LIMITS.historyEntries);
    expect(stored.fireCount).toBe(SCHEDULED_JOB_LIMITS.historyEntries + 5);
    expect(stored.nextFireAt).toBe(new Date(clock.now + 60_000).toISOString());
  });

  test("a failure is recorded with its error; a refusal for a gone target pauses", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    const { job } = await service.create(OPERATOR, { everySeconds: 60, action: MAIL });
    executor.next = () => ({
      ok: false,
      error: { code: "not-found", message: "No such tab" },
      pause: "target-deleted",
    });
    clock.now = T0 + 60_000;
    await tick(service);
    const stored = service.get(OPERATOR, job.id);
    expect(stored).toMatchObject({ state: "paused", pausedReason: "target-deleted" });
    expect(stored.fires[0]).toMatchObject({ state: "failed", error: { code: "not-found" } });
    clock.now += 10 * 60_000;
    await tick(service);
    expect(executor.fired).toHaveLength(1);
  });

  test("a busy target is retried, then gives up after the busy window", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    const { job } = await service.create(OPERATOR, { at: "+1m", action: MAIL });
    executor.next = () => ({ ok: false, error: { code: "busy", message: "busy" }, retry: true });
    clock.now = T0 + 60_000;
    await tick(service);
    expect(service.get(OPERATOR, job.id).fires[0]).toMatchObject({
      state: "pending",
      retryAt: expect.any(String),
    });
    clock.now += 10_000;
    await tick(service);
    expect(executor.fired).toHaveLength(1);
    clock.now += SCHEDULED_JOB_LIMITS.busyRetryDelayMs;
    executor.next = () => ({ ok: true, outcome: { summary: "second try" } });
    await tick(service);
    expect(executor.fired).toHaveLength(2);
    expect(service.get(OPERATOR, job.id)).toMatchObject({
      state: "completed",
      fires: [{ state: "succeeded", attempts: 2, outcome: { summary: "second try" } }],
    });
  });

  test("run now fires immediately without moving the schedule; pause stops slots", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    const { job } = await service.create(OPERATOR, { cron: "0 3 * * *", action: MAIL });
    const { fire } = service.runNow(OPERATOR, job.id);
    expect(fire).toMatchObject({ kind: "manual", state: "pending" });
    await tick(service);
    expect(executor.fired.map((item) => item.kind)).toEqual(["manual"]);
    expect(service.get(OPERATOR, job.id).nextFireAt).toBe("2026-10-26T03:00:00.000Z");
    service.pause(OPERATOR, job.id);
    clock.now = Date.parse("2026-10-26T03:00:00Z");
    await tick(service);
    expect(executor.fired).toHaveLength(1);
    // Resuming does not catch up time spent paused.
    clock.now = Date.parse("2026-10-26T05:00:00Z");
    expect(service.resume(OPERATOR, job.id).nextFireAt).toBe("2026-10-27T03:00:00.000Z");
    await tick(service);
    expect(executor.fired).toHaveLength(1);
  });
});

describe("restarts and missed fires", () => {
  test("a schedule survives a restart and a fire missed within the window runs once", async () => {
    const dir = await dataDir();
    const clock = { now: T0 };
    const first = await backend(dir, clock);
    const { job } = await first.service.create(OPERATOR, {
      cron: "*/5 * * * *",
      action: MAIL,
      catchUpMinutes: 30,
    });
    first.storage.close();
    storages.splice(storages.indexOf(first.storage), 1);

    // Down for 22 minutes: four slots passed, the latest 2 minutes ago.
    clock.now = T0 + 22 * 60_000;
    const second = await backend(dir, clock);
    await tick(second.service);
    expect(second.executor.fired).toEqual([
      { fireId: `${job.id}@${T0 + 20 * 60_000}`, kind: "catch-up", missed: 3 },
    ]);
    const stored = second.service.get(OPERATOR, job.id);
    expect(stored.nextFireAt).toBe(new Date(T0 + 25 * 60_000).toISOString());
  });

  test("a fire missed beyond the window is recorded as skipped, not run", async () => {
    const dir = await dataDir();
    const clock = { now: T0 };
    const first = await backend(dir, clock);
    const { job } = await first.service.create(OPERATOR, {
      at: "+10m",
      action: MAIL,
      catchUpMinutes: 15,
    });
    clock.now = T0 + 10 * 60_000 + 16 * 60_000;
    const second = await backend(dir, clock);
    await tick(second.service);
    expect(second.executor.fired).toHaveLength(0);
    expect(second.service.get(OPERATOR, job.id)).toMatchObject({
      state: "completed",
      fires: [{ state: "skipped", error: { code: "missed" } }],
    });
  });

  test("a zero window still tolerates timer slop", async () => {
    const clock = { now: T0 };
    const { service, executor } = await backend(await dataDir(), clock);
    await service.create(OPERATOR, { at: "+1m", action: MAIL, catchUpMinutes: 0 });
    clock.now = T0 + 60_000 + 30_000;
    await tick(service);
    expect(executor.fired).toHaveLength(1);
    expect(executor.fired[0]!.kind).toBe("scheduled");
  });

  test("a fire abandoned mid-run by a stopped backend is re-claimed under the same fire id", async () => {
    const dir = await dataDir();
    const clock = { now: T0 };
    const first = await backend(dir, clock);
    const { job } = await first.service.create(OPERATOR, { at: "+1m", action: MAIL });
    clock.now = T0 + 60_000;
    let release!: () => void;
    first.executor.next = () =>
      new Promise<FireResult>((resolve) => {
        release = () => resolve({ ok: true, outcome: {} });
      });
    await first.service.tick();
    expect(first.executor.fired).toHaveLength(1);
    // The first backend "dies" with the fire running.
    const second = await backend(dir, clock);
    await tick(second.service);
    expect(second.executor.fired).toHaveLength(0);
    clock.now += SCHEDULED_JOB_LIMITS.fireStaleMs + 1;
    await tick(second.service);
    expect(second.executor.fired.map((fire) => fire.fireId)).toEqual(
      first.executor.fired.map((fire) => fire.fireId),
    );
    expect(second.service.get(OPERATOR, job.id).fires[0]).toMatchObject({
      state: "succeeded",
      attempts: 2,
    });
    // The first backend's late outcome no longer owns the claim.
    release();
    await first.service.idle();
    expect(second.service.get(OPERATOR, job.id).fires).toHaveLength(1);
  });
});

describe("two backends sharing a data directory", () => {
  test("claim each fire exactly once", async () => {
    const dir = await dataDir();
    const clock = { now: T0 };
    const a = await backend(dir, clock);
    const b = await backend(dir, clock);
    for (let index = 0; index < 10; index += 1) {
      await a.service.create(OPERATOR, { at: "+1m", action: MAIL });
    }
    clock.now = T0 + 60_000;
    await Promise.all([a.service.tick(), b.service.tick(), a.service.tick(), b.service.tick()]);
    await Promise.all([a.service.idle(), b.service.idle()]);
    await Promise.all([tick(a.service), tick(b.service)]);
    const fired = [...a.executor.fired, ...b.executor.fired].map((fire) => fire.fireId);
    expect(fired).toHaveLength(10);
    expect(new Set(fired).size).toBe(10);
  });

  test("a backend without the writer lease never fires", async () => {
    const dir = await dataDir();
    const clock = { now: T0 };
    const storage = new StorageService(dir);
    await storage.init();
    storages.push(storage);
    const executor = new RecordingExecutor();
    const service = new ScheduledJobService({
      store: storage.scheduledJobStore(),
      executor: executor as unknown as ScheduledJobExecutor,
      now: () => clock.now,
      isWriter: () => false,
    });
    await service.create(OPERATOR, { at: "+1m", action: MAIL });
    clock.now += 120_000;
    await tick(service);
    expect(executor.fired).toHaveLength(0);
  });
});

describe("experimental scheduling switch", () => {
  test("nothing fires while scheduling is off; turning it on catches up within the window", async () => {
    const dir = await dataDir();
    const clock = { now: T0 };
    const storage = new StorageService(dir);
    await storage.init();
    storages.push(storage);
    const executor = new RecordingExecutor();
    let enabled = false;
    const service = new ScheduledJobService({
      store: storage.scheduledJobStore(),
      executor: executor as unknown as ScheduledJobExecutor,
      now: () => clock.now,
      enabled: async () => enabled,
    });
    const { job } = await service.create(OPERATOR, { at: "+1m", action: MAIL });
    clock.now += 120_000;
    await tick(service);
    expect(executor.fired).toHaveLength(0);
    expect(service.get(OPERATOR, job.id).state).toBe("active");

    enabled = true;
    await tick(service);
    expect(executor.fired).toHaveLength(1);
  });
});

describe("visibility and ownership", () => {
  test("owners see and manage only their own schedules; the operator manages all", async () => {
    const clock = { now: T0 };
    const { service } = await backend(await dataDir(), clock);
    const mine = (await service.create(AGENT, { at: "+5m", action: MAIL })).job;
    const theirs = (await service.create(OTHER_AGENT, { at: "+5m", action: MAIL })).job;
    const main: ScheduleOwner = {
      kind: "coordinator",
      projectId: "p1",
      coordinatorId: "c1",
      conversationId: "m",
      role: "main",
    };
    const side: ScheduleOwner = {
      kind: "coordinator",
      projectId: "p1",
      coordinatorId: "c1",
      conversationId: "s",
      role: "side",
    };
    const sideJob = (await service.create(side, { at: "+5m", action: MAIL })).job;
    const mainJob = (await service.create(main, { at: "+5m", action: MAIL })).job;

    expect(service.list(AGENT).map((job) => job.id)).toEqual([mine.id]);
    expect(() => service.get(AGENT, theirs.id)).toThrow(ScheduleNotFoundError);
    expect(() => service.pause(AGENT, theirs.id)).toThrow(ScheduleNotFoundError);
    expect(() => service.delete(AGENT, theirs.id)).toThrow(ScheduleNotFoundError);
    expect(service.list(side).map((job) => job.id)).toEqual([sideJob.id]);
    expect(
      service
        .list(main)
        .map((job) => job.id)
        .sort(),
    ).toEqual([sideJob.id, mainJob.id].sort());
    expect(service.list(OPERATOR)).toHaveLength(4);
    // The operator may retime anyone's schedule, but not change what it runs as them.
    await service.update(OPERATOR, mine.id, { cron: "0 4 * * *" });
    await expect(
      service.update(OPERATOR, mine.id, {
        action: { ...MAIL, input: { ...MAIL.input, body: "other" } },
      }),
    ).rejects.toThrow(ScheduleAuthorityError);
    expect(service.delete(OPERATOR, theirs.id).deleted).toBe(true);
  });

  test("environment deletion removes its agents' schedules and pauses others aimed at it", async () => {
    const clock = { now: T0 };
    const { service } = await backend(await dataDir(), clock);
    const owned = (await service.create(AGENT, { at: "+5m", action: MAIL })).job;
    const aimed = (
      await service.create(OPERATOR, {
        at: "+5m",
        action: { kind: "prompt", environmentId: "env-1", tabId: "startup-agent", prompt: "go" },
      })
    ).job;
    const unrelated = (await service.create(OPERATOR, { at: "+5m", action: MAIL })).job;
    expect(service.environmentDeleted("env-1")).toEqual({
      deleted: [owned.id],
      paused: [aimed.id],
    });
    expect(
      service.list(OPERATOR).map((job) => [job.id, job.state, job.pausedReason ?? null]),
    ).toEqual([
      [unrelated.id, "active", null],
      [aimed.id, "paused", "target-deleted"],
    ]);
  });

  test("closing a side conversation removes its schedules; the main's stay", async () => {
    const clock = { now: T0 };
    const { service } = await backend(await dataDir(), clock);
    const main: ScheduleOwner = {
      kind: "coordinator",
      projectId: "p1",
      coordinatorId: "c1",
      conversationId: "m",
      role: "main",
    };
    const side: ScheduleOwner = {
      kind: "coordinator",
      projectId: "p1",
      coordinatorId: "c1",
      conversationId: "s",
      role: "side",
    };
    const mainJob = (await service.create(main, { at: "+5m", action: MAIL })).job;
    const sideJob = (await service.create(side, { at: "+5m", action: MAIL })).job;
    expect(service.coordinatorConversationClosed("c1", "s")).toEqual([sideJob.id]);
    expect(service.coordinatorConversationClosed("c1", "m")).toEqual([]);
    expect(service.list(OPERATOR).map((job) => job.id)).toEqual([mainJob.id]);
  });
});

describe("scheduler regressions", () => {
  test("replays an absolute creation after its time expires, but conflicts on changed intent", async () => {
    const clock = { now: T0 };
    const { service } = await backend(await dataDir(), clock);
    const input = { at: new Date(T0 + 60_000).toISOString(), action: MAIL };
    const first = await service.create(OPERATOR, input, "absolute");
    clock.now += 120_000;
    expect(await service.create(OPERATOR, input, "absolute")).toEqual({
      job: first.job,
      replayed: true,
    });
    await expect(
      service.create(OPERATOR, { ...input, name: "changed" }, "absolute"),
    ).rejects.toThrow(/different schedule/);
    await expect(service.create(OPERATOR, input, "new")).rejects.toThrow();
  });

  for (const timing of [{ everySeconds: 60 }, { cron: "* * * * *" }]) {
    test(`coalesces over 500 missed slots: ${JSON.stringify(timing)}`, async () => {
      const clock = { now: T0 };
      const { service, executor } = await backend(await dataDir(), clock);
      const { job } = await service.create(OPERATOR, { ...timing, action: MAIL });
      clock.now += 24 * 60 * 60_000 + 12_000;
      await tick(service);
      const stored = service.get(OPERATOR, job.id);
      expect(stored.fires).toHaveLength(1);
      expect(stored.fires[0]).toMatchObject({
        state: "succeeded",
        scheduledFor: new Date(clock.now - 12_000).toISOString(),
      });
      expect(stored.fires[0]!.missed).toBeGreaterThanOrEqual(500);
      expect(Date.parse(stored.nextFireAt!)).toBeGreaterThan(clock.now);
      await tick(service);
      expect(executor.fired).toHaveLength(1);
    });
  }

  test("busy retries block later slots and do not consume the interruption budget", async () => {
    const clock = { now: T0 };
    const { service } = await backend(await dataDir(), clock);
    let job = (await service.create(OPERATOR, { everySeconds: 60, action: MAIL })).job;
    clock.now += 60_000;
    const id = `${job.id}@${clock.now}`;
    for (let index = 0; index < 6; index++) {
      const claim = claimDueFire(job, clock.now, "first");
      expect(claim.fire?.fireId).toBe(id);
      job = settleFire(
        claim.job!,
        id,
        "first",
        { ok: false, error: { code: "busy", message: "busy" }, retry: true },
        clock.now,
      )!;
      expect(claimDueFire(job, clock.now + 1, "other")).toEqual({ job: null, fire: null });
      expect(job.fires).toHaveLength(1);
      clock.now += SCHEDULED_JOB_LIMITS.busyRetryDelayMs;
    }
    const running = claimDueFire(job, clock.now, "first");
    clock.now += SCHEDULED_JOB_LIMITS.fireStaleMs;
    const reclaimed = claimDueFire(running.job!, clock.now, "second");
    expect(reclaimed.fire).toMatchObject({ fireId: id, interruptions: 1, attempts: 8 });
    job = reclaimed.job!;
    for (let index = 2; index <= SCHEDULED_JOB_LIMITS.maxFireAttempts; index++) {
      clock.now += SCHEDULED_JOB_LIMITS.fireStaleMs;
      const claim = claimDueFire(job, clock.now, `restart-${index}`);
      job = claim.job!;
      expect(job.fires[0]!.interruptions).toBe(index);
    }
    expect(job.fires[0]).toMatchObject({
      state: "failed",
      error: {
        code: "interrupted",
        message: "The backend running this fire stopped 3 times before it finished",
      },
    });
  });

  test("non-writers and saturated workers arm at the safety interval; completion and edits wake them", async () => {
    const clock = { now: T0 };
    const { storage } = await backend(await dataDir(), clock);
    const executor = new RecordingExecutor();
    let writer = false;
    const service = new ScheduledJobService({
      store: storage.scheduledJobStore(),
      executor: executor as unknown as ScheduledJobExecutor,
      now: () => clock.now,
      isWriter: () => writer,
    });
    const jobs = [];
    for (let i = 0; i < 5; i++)
      jobs.push((await service.create(OPERATOR, { at: "+1m", action: MAIL })).job);
    clock.now += 60_000;
    const releases: Array<() => void> = [];
    executor.next = () =>
      new Promise((resolve) => releases.push(() => resolve({ ok: true, outcome: {} })));
    const safetyTimer = installControlledTimeout(SAFETY_TICK_MS, {
      label: "scheduler safety tick",
    });
    const timers = spyOn(globalThis, "setTimeout");
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    try {
      service.start();
      await flush();
      expect(timers.mock.calls.at(-1)?.[1]).toBe(SAFETY_TICK_MS);
      expect(executor.fired).toHaveLength(0);
      clock.now += SAFETY_TICK_MS;
      expect(safetyTimer.advance()).toBe(1);
      await flush();
      expect(executor.fired).toHaveLength(0);
      expect(timers.mock.calls.every((call) => call[1] === SAFETY_TICK_MS)).toBe(true);
      writer = true;
      service.wake();
      await flush();
      expect(executor.fired).toHaveLength(4);
      expect(timers.mock.calls.at(-1)?.[1]).toBe(SAFETY_TICK_MS);
      clock.now += SAFETY_TICK_MS;
      expect(safetyTimer.advance()).toBe(1);
      await flush();
      expect(executor.fired).toHaveLength(4);
      expect(timers.mock.calls.every((call) => call[1] === SAFETY_TICK_MS)).toBe(true);
      await service.update(OPERATOR, jobs[4]!.id, { name: "edited while saturated" });
      await flush();
      expect(timers.mock.calls.at(-1)?.[1]).toBe(SAFETY_TICK_MS);
      releases.shift()!();
      await flush();
      expect(executor.fired).toHaveLength(5);
    } finally {
      writer = false;
      for (const release of releases) release();
      await service.stop();
      timers.mockRestore();
      expect(safetyTimer.restore()).toBe(0);
    }
  });

  test("a heartbeat persists without resource events; settlement announces", async () => {
    const clock = { now: T0 };
    const { storage, service, executor } = await backend(await dataDir(), clock);
    const changes: string[] = [];
    storage.setResourceChangeListener((event) => {
      if (event.resource === "scheduled-job") changes.push(event.resource);
    });
    const { job } = await service.create(OPERATOR, { at: "+1m", action: MAIL });
    clock.now += 60_000;
    let release!: () => void;
    executor.next = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, outcome: {} });
      });
    const intervals = spyOn(globalThis, "setInterval");
    try {
      await service.tick();
      const before = changes.length;
      const revision = service.get(OPERATOR, job.id).revision;
      clock.now += SCHEDULED_JOB_LIMITS.fireHeartbeatMs;
      const callback = intervals.mock.calls.find(
        (call) => call[1] === SCHEDULED_JOB_LIMITS.fireHeartbeatMs,
      )![0];
      (callback as () => void)();
      expect(service.get(OPERATOR, job.id).fires[0]!.heartbeatAt).toBe(
        new Date(clock.now).toISOString(),
      );
      expect(service.get(OPERATOR, job.id).revision).toBe(revision);
      expect(changes).toHaveLength(before);
      release();
      await service.idle();
      expect(changes).toHaveLength(before + 1);
    } finally {
      release?.();
      await service.idle();
      intervals.mockRestore();
    }
  });
});
