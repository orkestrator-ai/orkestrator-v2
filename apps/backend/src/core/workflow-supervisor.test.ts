import { describe, expect, test } from "bun:test";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { ManualTime, deferred, flushMicrotasks, type Deferred } from "./recurring-test-support.js";
import { WorkAdmissionPool } from "./work-admission.js";
import {
  KEYED_SCHEDULING_ROLLBACK_ENV,
  KeyedWorkflowSupervisor,
  keyedSchedulingEnabled,
  stableSpreadMs,
  type WorkflowPass,
} from "./workflow-supervisor.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";

type Obligation = "advance" | "cancelling" | "settle";

/**
 * A fake authoritative store and domain. `advance` reads the record, notes
 * its obligation (as every migrated domain does after its authoritative
 * read) and may block on a per-key gate to model a slow provider.
 */
class FakeDomain {
  records = new Map<string, { obligation: Obligation | null; corrupt?: boolean }>();
  readonly passes: { key: string; at: number; trigger: WorkflowPass<Obligation>["trigger"] }[] = [];
  readonly gates = new Map<string, Deferred<void>>();
  discoverCalls = 0;
  failDiscovery = false;
  incompleteDiscovery = false;
  /** Records a partial enumeration fails to return (the pass still reads them). */
  readonly hiddenFromDiscovery = new Set<string>();
  inFlight = 0;
  peakInFlight = 0;
  supervisor!: KeyedWorkflowSupervisor<Obligation>;
  onPass?: (pass: WorkflowPass<Obligation>) => Promise<void> | void;

  constructor(private readonly time: ManualTime) {}

  async discover() {
    this.discoverCalls += 1;
    if (this.failDiscovery) throw new Error("storage unavailable");
    const entries = [];
    for (const [key, record] of this.records) {
      if (record.corrupt || record.obligation === null) continue;
      if (this.hiddenFromDiscovery.has(key)) continue;
      entries.push({ key, obligation: record.obligation, target: `env-${key}` });
    }
    return { entries, scanned: this.records.size, complete: !this.incompleteDiscovery };
  }

  async advance(pass: WorkflowPass<Obligation>) {
    this.passes.push({ key: pass.key, at: this.time.now(), trigger: pass.trigger });
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      const record = this.records.get(pass.key);
      this.supervisor.note(pass.key, record && !record.corrupt ? record.obligation : null);
      await this.onPass?.(pass);
      const gate = this.gates.get(pass.key);
      if (gate) await gate.promise;
    } finally {
      this.inFlight -= 1;
    }
  }

  passesOf(key: string) {
    return this.passes.filter((entry) => entry.key === key);
  }
}

function setup(
  options: {
    progressIntervalMs?: number;
    discoveryIntervalMs?: number;
    maxConcurrent?: number;
    admission?: WorkAdmissionPool;
    nextDelayMs?: (key: string, obligation: Obligation) => number | null | undefined;
  } = {},
) {
  const time = new ManualTime(1_000);
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const domain = new FakeDomain(time);
  const supervisor = new KeyedWorkflowSupervisor<Obligation>({
    domain: "looped-review",
    kind: "looped-review-tick",
    progressIntervalMs: options.progressIntervalMs ?? 1_000,
    discoveryIntervalMs: options.discoveryIntervalMs ?? 30_000,
    discover: () => domain.discover(),
    advance: (pass) => domain.advance(pass),
    ...(options.nextDelayMs ? { nextDelayMs: options.nextDelayMs } : {}),
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    now: time.now,
    timers: time.timerFactory,
    random: () => 0,
    metrics,
    diagnostics: null,
  });
  domain.supervisor = supervisor;
  return { time, metrics, domain, supervisor };
}

describe("KeyedWorkflowSupervisor", () => {
  test("selection scales with active obligations, not retained history", async () => {
    const { time, metrics, domain, supervisor } = setup();
    for (let index = 0; index < 200; index += 1) {
      domain.records.set(`done-${index}`, { obligation: null });
    }
    domain.records.set("active-1", { obligation: "advance" });
    domain.records.set("active-2", { obligation: "cancelling" });
    supervisor.start();
    await time.advance(60_000);
    // Discovery ran at start and every 30 s: three enumerations, not sixty.
    expect(domain.discoverCalls).toBe(3);
    const counters = metrics.snapshot().kinds["looped-review-tick"]!;
    expect(counters.workUnits["record-scanned"]).toBe(3 * 202);
    // Each active key progressed at its own one-second cadence.
    expect(domain.passesOf("active-1").length).toBeGreaterThanOrEqual(59);
    expect(domain.passesOf("active-2").length).toBeGreaterThanOrEqual(59);
    expect(domain.passes.every((pass) => pass.key.startsWith("active-"))).toBe(true);
    expect(supervisor.status().keys).toBe(2);
    supervisor.stop();
  });

  test("a key that settles is dropped and never polled again", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("a", { obligation: "advance" });
    supervisor.start();
    await time.advance(0);
    expect(domain.passesOf("a")).toHaveLength(1);
    domain.records.set("a", { obligation: null });
    await time.advance(1_000);
    expect(domain.passesOf("a")).toHaveLength(2);
    await time.advance(20_000);
    expect(domain.passesOf("a")).toHaveLength(2);
    expect(supervisor.has("a")).toBe(false);
    supervisor.stop();
  });

  test("one slow key never delays another key's progress", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("slow", { obligation: "advance" });
    domain.records.set("fast", { obligation: "advance" });
    const slow = deferred();
    domain.gates.set("slow", slow);
    supervisor.start();
    await time.advance(10_000);
    expect(domain.passesOf("slow")).toHaveLength(1);
    expect(domain.passesOf("fast").length).toBeGreaterThanOrEqual(10);
    domain.gates.delete("slow");
    slow.resolve();
    await time.advance(1_000);
    expect(domain.passesOf("slow")).toHaveLength(2);
    supervisor.stop();
  });

  test("a dirty wake mid-pass reruns once; a periodic tick alone cannot chain reruns", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("a", { obligation: "advance" });
    const gate = deferred();
    supervisor.start();
    await time.advance(0);
    expect(domain.passesOf("a")).toHaveLength(1);
    domain.gates.set("a", gate);
    await time.advance(1_000);
    expect(domain.passesOf("a")).toHaveLength(2);
    // Periodic due times and hints while running are dropped...
    await time.advance(5_000);
    supervisor.wake("a", "provider-transition");
    expect(domain.passesOf("a")).toHaveLength(2);
    // ...but real changes coalesce into exactly one trailing pass.
    supervisor.wake("a", "result-accepted");
    supervisor.wake("a", "cancel");
    domain.gates.delete("a");
    gate.resolve();
    await time.advance(0);
    expect(domain.passesOf("a")).toHaveLength(3);
    expect(domain.passesOf("a")[2]!.trigger).toBe("wake");
    // The trailing pass is followed by the ordinary cadence, not another rerun.
    await time.advance(999);
    expect(domain.passesOf("a")).toHaveLength(3);
    await time.advance(1);
    expect(domain.passesOf("a")).toHaveLength(4);
    supervisor.stop();
  });

  test("a domain that writes on every pass does not wake itself", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("a", { obligation: "advance" });
    // Every pass re-notes the same obligation after its durable write.
    domain.onPass = (pass) => supervisor.note(pass.key, "advance");
    supervisor.start();
    await time.advance(10_000);
    expect(domain.passesOf("a")).toHaveLength(11);
    supervisor.stop();
  });

  test("an unknown key woken by a command is probed and classified", async () => {
    const { time, domain, supervisor } = setup();
    supervisor.start();
    await time.advance(0);
    domain.records.set("new", { obligation: "advance" });
    supervisor.wake("new", "start");
    await time.advance(0);
    expect(domain.passesOf("new")).toHaveLength(1);
    expect(supervisor.obligation("new")).toBe("advance");
    // A probe for a record with nothing owed is dropped after one read.
    supervisor.wake("missing", "explicit");
    await time.advance(0);
    expect(domain.passesOf("missing")).toHaveLength(1);
    expect(supervisor.has("missing")).toBe(false);
    supervisor.stop();
  });

  test("a wake that lands during a probe pass is not lost", async () => {
    const { time, domain, supervisor } = setup();
    supervisor.start();
    await time.advance(0);
    const gate = deferred();
    domain.gates.set("k", gate);
    supervisor.wake("k", "start");
    await time.advance(0);
    expect(domain.passesOf("k")).toHaveLength(1);
    // The record becomes active while the probe (which saw nothing) is still running.
    domain.records.set("k", { obligation: "advance" });
    supervisor.wake("k", "retry");
    domain.gates.delete("k");
    gate.resolve();
    await time.advance(0);
    expect(domain.passesOf("k")).toHaveLength(2);
    expect(supervisor.obligation("k")).toBe("advance");
    supervisor.stop();
  });

  test("a missed wakeup converges within the safety interval", async () => {
    const { time, domain, supervisor } = setup();
    supervisor.start();
    await time.advance(0);
    // Committed by another path with no wakeup and no note.
    domain.records.set("missed", { obligation: "settle" });
    await time.advance(29_000);
    expect(domain.passesOf("missed")).toHaveLength(0);
    await time.advance(1_000);
    expect(domain.passesOf("missed")).toHaveLength(1);
    expect(supervisor.status().recoveredByDiscovery).toBe(1);
    supervisor.stop();
  });

  test("restart between a durable commit and its wakeup recovers on startup", async () => {
    const first = setup();
    first.domain.records.set("a", { obligation: "advance" });
    // The commit landed; the process died before any wakeup was delivered.
    const second = setup();
    second.domain.records = first.domain.records;
    second.supervisor.start();
    await second.time.advance(0);
    expect(second.domain.passesOf("a")).toHaveLength(1);
    second.supervisor.stop();
  });

  test("a failed or incomplete enumeration never drops known obligations", async () => {
    const { time, domain, supervisor } = setup({ discoveryIntervalMs: 5_000 });
    domain.records.set("a", { obligation: "advance" });
    supervisor.start();
    await time.advance(0);
    expect(supervisor.has("a")).toBe(true);
    // Storage enumeration now fails; the index keeps the key and keeps progressing it.
    domain.failDiscovery = true;
    await time.advance(10_000);
    expect(supervisor.has("a")).toBe(true);
    expect(supervisor.status().failedDiscoveries).toBeGreaterThan(0);
    const before = domain.passesOf("a").length;
    await time.advance(3_000);
    expect(domain.passesOf("a").length).toBeGreaterThan(before);
    // A partial enumeration that omits the key must not drop it either.
    domain.failDiscovery = false;
    domain.incompleteDiscovery = true;
    domain.hiddenFromDiscovery.add("a");
    await time.advance(5_000);
    expect(supervisor.status().incompleteDiscoveries).toBeGreaterThan(0);
    expect(supervisor.has("a")).toBe(true);
    supervisor.stop();
  });

  test("a corrupt record is skipped without blocking unrelated recovery", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("corrupt", { obligation: "advance", corrupt: true });
    domain.records.set("healthy", { obligation: "advance" });
    supervisor.start();
    await time.advance(3_000);
    expect(domain.passesOf("healthy").length).toBeGreaterThanOrEqual(3);
    expect(domain.passesOf("corrupt")).toHaveLength(0);
    supervisor.stop();
  });

  test("start returns immediately even when the first pass never settles", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("stuck", { obligation: "advance" });
    domain.gates.set("stuck", deferred());
    const started = performance.now();
    supervisor.start();
    expect(performance.now() - started).toBeLessThan(100);
    await time.advance(0);
    expect(domain.passesOf("stuck")).toHaveLength(1);
    supervisor.stop();
  });

  test("admission bounds passes per target and hands off to nested work", async () => {
    const time = new ManualTime(1_000);
    const pool = new WorkAdmissionPool({
      name: "workflow-provider",
      limits: { maxConcurrent: 2, maxPerTarget: 1 },
      now: time.now,
      diagnostics: null,
    });
    const { domain, supervisor, time: clock } = setup({ admission: pool });
    domain.records.set("a", { obligation: "advance" });
    domain.records.set("b", { obligation: "advance" });
    domain.records.set("c", { obligation: "advance" });
    const gates = ["a", "b", "c"].map((key) => {
      const gate = deferred();
      domain.gates.set(key, gate);
      return gate;
    });
    let nested = 0;
    domain.onPass = async (pass) => {
      // Nested reviewer work in the same pool uses the pass's own slot.
      await pool.run(
        {
          kind: "looped-review-tick",
          priority: "progress",
          target: "nested",
          holding: pass.lease ? [pass.lease] : [],
        },
        async () => {
          nested += 1;
        },
      );
    };
    supervisor.start();
    await clock.advance(0);
    expect(domain.peakInFlight).toBe(2);
    expect(nested).toBe(2);
    expect(pool.status().waiting).toBe(1);
    for (const gate of gates) gate.resolve();
    for (const key of ["a", "b", "c"]) domain.gates.delete(key);
    await clock.advance(0);
    expect(domain.passesOf("c")).toHaveLength(1);
    supervisor.stop();
    pool.close();
    void time;
  });

  test("critical jobs run on time while every best-effort slot is blocked", async () => {
    const { time, domain, supervisor } = setup({ maxConcurrent: 2 });
    for (const key of ["a", "b", "c"]) {
      domain.records.set(key, { obligation: "advance" });
      domain.gates.set(key, deferred());
    }
    const renewals: number[] = [];
    supervisor.addCriticalJob({
      key: "lease-renewal",
      kind: "looped-review-lease-renewal",
      intervalMs: 5_000,
      run: async () => {
        renewals.push(time.now());
      },
    });
    supervisor.start();
    await time.advance(15_000);
    expect(domain.peakInFlight).toBe(2);
    expect(renewals).toEqual([6_000, 11_000, 16_000]);
    supervisor.stop();
  });

  test("scoped target wakes reach only the matching keys", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("a", { obligation: "advance" });
    domain.records.set("b", { obligation: "cancelling" });
    supervisor.start();
    await time.advance(0);
    expect(supervisor.wakeTarget("env-a", "result-accepted")).toBe(1);
    expect(supervisor.wakeTarget("env-b", "result-accepted", (o) => o === "advance")).toBe(0);
    expect(supervisor.wakeTarget("env-unknown", "result-accepted")).toBe(0);
    await time.advance(0);
    expect(domain.passesOf("a")).toHaveLength(2);
    expect(domain.passesOf("b")).toHaveLength(1);
    expect(supervisor.status().wakes["result-accepted"]).toBe(1);
    supervisor.stop();
  });

  test("nextDelayMs can shape the cadence or release a key", async () => {
    const { time, domain, supervisor } = setup({
      nextDelayMs: (_key, obligation) => (obligation === "settle" ? 3_000 : null),
    });
    domain.records.set("observe", { obligation: "settle" });
    domain.records.set("released", { obligation: "advance" });
    supervisor.start();
    await time.advance(9_000);
    expect(domain.passesOf("observe")).toHaveLength(4);
    expect(domain.passesOf("released")).toHaveLength(1);
    expect(supervisor.has("released")).toBe(false);
    supervisor.stop();
  });

  test("reconcileNow performs a full authoritative discovery on demand", async () => {
    const { time, domain, supervisor } = setup();
    supervisor.start();
    await time.advance(0);
    domain.records.set("late", { obligation: "advance" });
    const report = await supervisor.reconcileNow();
    expect(report).toMatchObject({ complete: true, recovered: 1, keys: 1 });
    supervisor.stop();
  });

  test("note and wake are inert until started and after stop", async () => {
    const { time, domain, supervisor } = setup();
    supervisor.note("a", "advance");
    supervisor.wake("a", "start");
    await time.advance(5_000);
    expect(domain.passes).toHaveLength(0);
    supervisor.start();
    supervisor.stop();
    supervisor.wake("a", "start");
    await time.advance(5_000);
    expect(domain.passes).toHaveLength(0);
  });

  test("the rollback switch disables one domain at a time", () => {
    expect(keyedSchedulingEnabled("build-pipeline", {})).toBe(true);
    const env = { [KEYED_SCHEDULING_ROLLBACK_ENV]: "build-pipeline, looped-review" };
    expect(keyedSchedulingEnabled("build-pipeline", env)).toBe(false);
    expect(keyedSchedulingEnabled("looped-review", env)).toBe(false);
    expect(keyedSchedulingEnabled("multi-review", env)).toBe(true);
    expect(keyedSchedulingEnabled("multi-review", { [KEYED_SCHEDULING_ROLLBACK_ENV]: "all" })).toBe(
      false,
    );
  });

  test("status is content-free", async () => {
    const { time, domain, supervisor } = setup();
    domain.records.set("env-secret/Users/alice", { obligation: "advance" });
    supervisor.start();
    await time.advance(0);
    const serialized = JSON.stringify(supervisor.status());
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("env-secret");
    supervisor.stop();
    await flushMicrotasks();
  });

  test("stable spread is bounded and deterministic", () => {
    expect(stableSpreadMs("a", 0)).toBe(0);
    expect(stableSpreadMs("workflow-1", 1_000)).toBe(stableSpreadMs("workflow-1", 1_000));
    expect(stableSpreadMs("workflow-1", 1_000)).toBeLessThan(1_000);
  });
});

describe("ElapsedPollGate", () => {
  test("periodic and explicit observations always count", () => {
    const time = new ManualTime(0);
    const gate = new ElapsedPollGate(1_000, { now: time.now });
    expect(gate.count("s", "explicit")).toBe(true);
    expect(gate.count("s", "explicit")).toBe(true);
    expect(gate.count("s", "periodic")).toBe(true);
  });

  test("a burst of wakeups cannot exhaust an attempt-counted grace", () => {
    const time = new ManualTime(0);
    const gate = new ElapsedPollGate(1_000, { now: time.now });
    let count = 0;
    for (let index = 0; index < 10; index += 1) {
      if (gate.count("s", "wake")) count += 1;
    }
    expect(count).toBe(1);
    expect(gate.exhausted("s", count, 5)).toBe(false);
    time.jump(1_000);
    if (gate.count("s", "wake")) count += 1;
    expect(count).toBe(2);
  });

  test("a slowed cadence cannot stretch the grace beyond its duration", () => {
    const time = new ManualTime(0);
    const gate = new ElapsedPollGate(1_000, { now: time.now });
    gate.count("s", "periodic");
    time.jump(10_000);
    gate.count("s", "periodic");
    // Two observations ten seconds apart: the five-second window has passed.
    expect(gate.exhausted("s", 2, 5)).toBe(true);
    // One observation alone never exhausts on time.
    const fresh = new ElapsedPollGate(1_000, { now: time.now });
    fresh.count("t", "periodic");
    time.jump(60_000);
    expect(fresh.exhausted("t", 1, 5)).toBe(false);
  });

  test("scopes are bounded and clearable", () => {
    const gate = new ElapsedPollGate(1_000, { maxScopes: 2 });
    gate.count("w1\0a", "periodic");
    gate.count("w1\0b", "periodic");
    gate.count("w2\0a", "periodic");
    expect(gate.size).toBe(2);
    gate.clearPrefix("w1\0");
    expect(gate.size).toBe(1);
    gate.clear("w2\0a");
    expect(gate.size).toBe(0);
  });
});
