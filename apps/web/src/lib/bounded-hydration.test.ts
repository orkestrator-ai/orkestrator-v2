/**
 * Fault-injection matrix for bounded subscribe-before-snapshot hydration
 * (recurring-processes plan step 11). Every case uses a fake clock and
 * deferred snapshot reads, and asserts the exact final state, the memory
 * bounds, and the number of snapshot reads/reconciliations.
 */
import { describe, expect, test } from "bun:test";
import {
  BoundedKeySet,
  RevisionRanges,
  approximateJsonBytes,
  createBoundedHydration,
  toHydrationFetchResult,
  type BoundedHydrationLimits,
  type HydrationClock,
  type HydrationFetchRequest,
  type HydrationFetchResult,
  type HydrationStatus,
} from "./bounded-hydration";

const A = "gen-a";
const B = "gen-b";

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: HydrationClock = {
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    random: () => 1,
  };
  return {
    clock,
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = target;
    },
  };
}

type Fetch = HydrationFetchRequest & PromiseWithResolvers<HydrationFetchResult<string | null>>;

function harness(limits: Partial<BoundedHydrationLimits> = {}) {
  const time = fakeClock();
  const store = new Map<string, string>();
  const fetches: Fetch[] = [];
  const statuses: HydrationStatus[] = [];
  const notified: string[] = [];
  let replaceAllCalls = 0;
  const hydration = createBoundedHydration<string | null>({
    name: "test-view",
    fetchSnapshot: (request) => {
      const deferred = Promise.withResolvers<HydrationFetchResult<string | null>>();
      fetches.push({ ...request, ...deferred });
      return deferred.promise;
    },
    replaceAll: (entries) => {
      replaceAllCalls += 1;
      store.clear();
      for (const entry of entries) if (entry.value !== null) store.set(entry.key, entry.value);
    },
    applyUpdate: (key, value) => {
      if (value === null) store.delete(key);
      else store.set(key, value);
    },
    estimateBytes: (value) => (value === null ? 4 : value.length),
    limits,
    clock: time.clock,
    onStatusChange: (status) => statuses.push(status),
  });
  const state = () => Object.fromEntries(Array.from(store).sort(([a], [b]) => a.localeCompare(b)));
  return {
    hydration,
    time,
    store,
    state,
    fetches,
    statuses,
    notified,
    replaceAllCalls: () => replaceAllCalls,
    /** Delivers a stamped update, with a notification that records `label`. */
    event(key: string, value: string | null, revision: number, generation = A, label?: string) {
      hydration.receive(
        { key, value, stamp: { generation, revision } },
        label ? () => notified.push(label) : undefined,
      );
    },
    legacyEvent(key: string, value: string | null, label?: string) {
      hydration.receive(
        { key, value, stamp: null },
        label ? () => notified.push(label) : undefined,
      );
    },
    async resolve(index: number, result: HydrationFetchResult<string | null>) {
      fetches[index]!.resolve(result);
      await flush();
    },
    async reject(index: number, error = new Error("backend offline")) {
      fetches[index]!.reject(error);
      await flush();
    },
    diagnostics: () => hydration.getDiagnostics(),
  };
}

function snapshot(
  revision: number | null,
  entries: Record<string, string>,
  generation = A,
): HydrationFetchResult<string | null> {
  return {
    kind: "snapshot",
    stamp: revision === null ? null : { generation, revision },
    entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
  };
}

/** Hydrates to a current revisioned baseline. */
async function hydrated(
  revision: number,
  entries: Record<string, string>,
  limits: Partial<BoundedHydrationLimits> = {},
) {
  const view = harness(limits);
  view.hydration.request("initial");
  await view.resolve(0, snapshot(revision, entries));
  expect(view.hydration.getStatus()).toBe("current");
  return view;
}

describe("bounded hydration fault matrix", () => {
  test("event before subscription is covered by the snapshot read after subscribing", async () => {
    // The caller subscribes first; anything emitted earlier never reaches the
    // controller and is part of the snapshot, which is read afterwards.
    const view = harness();
    view.hydration.request("initial");
    expect(view.fetches[0]?.known).toBeNull();
    await view.resolve(0, snapshot(1, { a: "before-subscribe" }));

    expect(view.state()).toEqual({ a: "before-subscribe" });
    expect(view.diagnostics()).toMatchObject({ fetches: 1, reconciliations: {} });
    expect(view.statuses).toEqual(["hydrating", "current"]);
  });

  test("event during a snapshot is applied over it only when newer", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.event("a", "during", 2);
    view.event("b", "covered", 1);
    expect(view.state()).toEqual({});

    await view.resolve(0, snapshot(1, { a: "old", b: "covered" }));

    expect(view.state()).toEqual({ a: "during", b: "covered" });
    expect(view.diagnostics()).toMatchObject({
      fetches: 1,
      applied: { generation: A, revision: 2 },
      bufferedKeys: 0,
      peakBufferedKeys: 2,
    });
  });

  test("multiple reconnects during a snapshot fence it and queue exactly one rerun", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.hydration.onReconnect();
    view.hydration.onReconnect();
    view.hydration.onReconnect();
    expect(view.fetches).toHaveLength(1);

    // The pre-reconnect answer is discarded; the single rerun starts.
    await view.resolve(0, snapshot(3, { a: "pre-reconnect" }));
    expect(view.state()).toEqual({});
    expect(view.fetches).toHaveLength(2);

    await view.resolve(1, snapshot(4, { a: "post-reconnect" }));
    expect(view.state()).toEqual({ a: "post-reconnect" });
    expect(view.diagnostics()).toMatchObject({ fetches: 2, reconciliations: { reconnect: 1 } });
  });

  test("an older snapshot resolving late never overwrites the newer one", async () => {
    const view = harness();
    view.hydration.request("initial");
    await view.time.advance(15_000); // owned timeout
    expect(view.hydration.getStatus()).toBe("stale");
    await view.time.advance(1_000); // backoff
    expect(view.fetches).toHaveLength(2);

    await view.resolve(1, snapshot(5, { a: "newer" }));
    await view.resolve(0, snapshot(3, { a: "older" }));

    expect(view.state()).toEqual({ a: "newer" });
    expect(view.diagnostics()).toMatchObject({ fetches: 2, reconciliations: { retry: 1 } });
    expect(view.time.pending()).toBe(0);
  });

  test("a duplicate revision applies and notifies once", async () => {
    const view = await hydrated(1, { a: "v1" });
    view.event("a", "v2", 2, A, "merged");
    view.event("a", "v2", 2, A, "merged");

    expect(view.state()).toEqual({ a: "v2" });
    expect(view.notified).toEqual(["merged"]);
    expect(view.diagnostics().fetches).toBe(1);
  });

  test("an out-of-order update is detected as a gap and never regresses the key", async () => {
    const view = await hydrated(1, { a: "v1" });
    view.event("a", "v3", 3);
    expect(view.state()).toEqual({ a: "v3" });
    expect(view.fetches).toHaveLength(2);
    expect(view.fetches[1]?.known).toEqual({ generation: A, revision: 1 });

    view.event("a", "v2", 2); // arrives late, buffered in the recovery window
    await view.resolve(1, snapshot(3, { a: "v3" }));

    expect(view.state()).toEqual({ a: "v3" });
    expect(view.diagnostics()).toMatchObject({
      fetches: 2,
      reconciliations: { gap: 1 },
      applied: { revision: 3 },
      trackedKeyRevisions: 0,
    });
  });

  test("a late-filled gap outside recovery advances the position without regressing", async () => {
    const view = await hydrated(1, { a: "v1", b: "b1" });
    // Recovery is already pending (backoff), so the gap is recorded, not re-requested.
    view.hydration.request("explicit");
    await view.reject(1);
    expect(view.hydration.getStatus()).toBe("stale");
    view.event("a", "v3", 3);
    view.event("a", "v2", 2); // fills the gap, but its body is older than the key's
    view.event("b", "b4", 4);

    expect(view.state()).toEqual({ a: "v3", b: "b4" });
    expect(view.diagnostics()).toMatchObject({
      fetches: 2,
      applied: { revision: 4 },
      trackedKeyRevisions: 0,
    });
  });

  test("a generation reset replaces the view and discards old-generation bookkeeping", async () => {
    const view = await hydrated(5, { a: "old", b: "gone" });
    view.event("a", "restarted", 1, B);
    expect(view.fetches).toHaveLength(2);
    expect(view.state()).toEqual({ a: "old", b: "gone" });

    await view.resolve(1, snapshot(1, { a: "restarted" }, B));

    expect(view.state()).toEqual({ a: "restarted" });
    expect(view.diagnostics()).toMatchObject({
      fetches: 2,
      reconciliations: { generation: 1 },
      applied: { generation: B, revision: 1 },
    });
  });

  test("a snapshot from a replaced owner is not applied", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.event("a", "from-b", 1, B); // new owner generation while the read is outstanding
    await view.resolve(0, snapshot(9, { a: "from-a" }, A));

    expect(view.state()).toEqual({});
    expect(view.fetches).toHaveLength(2);
    await view.resolve(1, snapshot(1, { a: "from-b" }, B));
    expect(view.state()).toEqual({ a: "from-b" });
    expect(view.diagnostics()).toMatchObject({ fetches: 2, reconciliations: { generation: 1 } });
  });

  test("a lost final event is recovered by the compact safety check", async () => {
    const view = await hydrated(2, { a: "running" });
    // Revision 3 ("done") was lost; nothing else follows it.
    view.hydration.safetyCheck();
    expect(view.fetches[1]?.known).toEqual({ generation: A, revision: 2 });
    expect(view.fetches[1]?.reason).toBe("safety");
    // A confirmed view does not flip to pending for a compact check.
    expect(view.hydration.getStatus()).toBe("current");

    await view.resolve(1, snapshot(3, { a: "done" }));
    expect(view.state()).toEqual({ a: "done" });
    expect(view.diagnostics()).toMatchObject({ fetches: 2, reconciliations: { safety: 1 } });
  });

  test("an unchanged safety answer writes nothing", async () => {
    const view = await hydrated(2, { a: "same" });
    view.hydration.safetyCheck();
    await view.resolve(1, { kind: "unchanged", stamp: { generation: A, revision: 2 } });

    expect(view.replaceAllCalls()).toBe(1);
    expect(view.state()).toEqual({ a: "same" });
    expect(view.statuses).toEqual(["hydrating", "current"]);
  });

  test("an unchanged answer for a position that was not requested is rejected", async () => {
    const view = await hydrated(2, { a: "same" });
    view.hydration.safetyCheck();
    await view.resolve(1, { kind: "unchanged", stamp: { generation: A, revision: 7 } });

    expect(view.hydration.getStatus()).toBe("stale");
    expect(view.diagnostics().applied).toEqual({ generation: A, revision: 2 });
  });

  test("replay expiry reconnect restores the exact snapshot, removals included", async () => {
    const view = await hydrated(4, { a: "a4", b: "b4" });
    view.hydration.onReconnect(); // reconcile-required is announced as a fresh connection
    expect(view.fetches[1]?.known).toEqual({ generation: A, revision: 4 });

    await view.resolve(1, snapshot(9, { b: "b9" }));
    expect(view.state()).toEqual({ b: "b9" });
    expect(view.diagnostics()).toMatchObject({ fetches: 2, reconciliations: { reconnect: 1 } });
  });

  test("filtered global cursors do not create domain gaps", async () => {
    // Only this view's events reach it; other domains' interleaved events and
    // the gateway's filtered global revisions are a different sequence.
    const view = await hydrated(1, {});
    view.event("a", "a2", 2);
    view.event("b", "b3", 3);
    view.event("a", "a4", 4);

    expect(view.state()).toEqual({ a: "a4", b: "b3" });
    expect(view.diagnostics()).toMatchObject({ fetches: 1, applied: { revision: 4 } });
  });

  test("deletion then recreation during hydration keeps the recreation", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.event("a", null, 2);
    view.event("a", "recreated", 3);
    await view.resolve(0, snapshot(1, { a: "original" }));

    expect(view.state()).toEqual({ a: "recreated" });
  });

  test("a removal during hydration does not resurrect the key", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.event("a", null, 2);
    await view.resolve(0, snapshot(1, { a: "original" }));

    expect(view.state()).toEqual({});
  });

  test("a stale update after a removal is ignored", async () => {
    const view = await hydrated(1, { a: "v1" });
    view.event("a", null, 3); // gap: revision 2 missing; recovery starts
    view.event("a", "stale", 2); // late, buffered in the recovery window
    await view.resolve(1, snapshot(3, {}));

    expect(view.state()).toEqual({});
    expect(view.diagnostics()).toMatchObject({ fetches: 2, applied: { revision: 3 } });
  });

  test("buffer overflow keeps only high-water evidence and a covering snapshot suffices", async () => {
    const view = harness({ maxBufferedKeys: 2 });
    view.hydration.request("initial");
    view.event("a", "a2", 2);
    view.event("b", "b3", 3);
    view.event("c", "c4", 4); // third key: overflow
    view.event("d", "d5", 5);
    expect(view.diagnostics()).toMatchObject({
      overflows: 1,
      bufferedKeys: 0,
      peakBufferedKeys: 2,
    });

    await view.resolve(0, snapshot(5, { a: "a2", b: "b3", c: "c4", d: "d5" }));
    expect(view.state()).toEqual({ a: "a2", b: "b3", c: "c4", d: "d5" });
    expect(view.hydration.getStatus()).toBe("current");
    expect(view.diagnostics().fetches).toBe(1);
  });

  test("buffer overflow with an insufficient snapshot applies it, then converges by bounded retry", async () => {
    const view = harness({ maxBufferedBytes: 6 });
    view.hydration.request("initial");
    view.event("a", "aaaa", 2);
    view.event("b", "bbbb", 3); // 8 estimated bytes > 6: overflow
    await view.resolve(0, snapshot(2, { a: "aaaa" }));

    // Newer than the store, so applied; but revision 3 was dropped.
    expect(view.state()).toEqual({ a: "aaaa" });
    expect(view.hydration.getStatus()).toBe("stale");
    await view.time.advance(1_000);
    expect(view.fetches).toHaveLength(2);
    await view.resolve(1, snapshot(3, { a: "aaaa", b: "bbbb" }));

    expect(view.state()).toEqual({ a: "aaaa", b: "bbbb" });
    expect(view.hydration.getStatus()).toBe("current");
    expect(view.diagnostics()).toMatchObject({
      fetches: 2,
      overflows: 1,
      reconciliations: { overflow: 1 },
      peakBufferedBytes: 4,
    });
  });

  test("continuous events cannot grow memory while snapshots keep failing", async () => {
    const view = harness({ maxBufferedKeys: 8, maxAttempts: 3 });
    view.hydration.request("initial");
    let revision = 1;
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < 100; index += 1) {
        view.event(`k${index}`, `v${revision}`, (revision += 1));
      }
      await view.time.advance(60_000);
    }

    expect(view.hydration.getStatus()).toBe("degraded");
    expect(view.diagnostics()).toMatchObject({ fetches: 3, peakBufferedKeys: 8, bufferedKeys: 0 });
    expect(view.time.pending()).toBe(0);
  });

  test("an invalid snapshot is never applied and is retried with backoff", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.legacyEvent("a", "live");
    await view.resolve(0, { kind: "invalid" });

    // The buffered live update is still shown; the invalid body is not.
    expect(view.state()).toEqual({ a: "live" });
    expect(view.hydration.getStatus()).toBe("stale");
    await view.time.advance(999);
    expect(view.fetches).toHaveLength(1);
    await view.time.advance(1);
    await view.resolve(1, snapshot(3, { a: "valid" }));
    expect(view.state()).toEqual({ a: "valid" });
  });

  test("snapshot timeouts retry with capped backoff, then degrade until a safety check", async () => {
    const view = harness({ maxAttempts: 4 });
    view.hydration.request("initial");
    view.legacyEvent("a", "live-during-hang");
    await view.time.advance(15_000);
    // The hung read does not freeze the view.
    expect(view.state()).toEqual({ a: "live-during-hang" });

    await view.time.advance(1_000 + 15_000 + 2_000 + 15_000 + 4_000 + 15_000);
    expect(view.diagnostics().fetches).toBe(4);
    expect(view.hydration.getStatus()).toBe("degraded");
    expect(view.time.pending()).toBe(0);

    view.hydration.safetyCheck();
    expect(view.fetches).toHaveLength(5);
    await view.resolve(4, snapshot(2, { a: "recovered" }));
    expect(view.state()).toEqual({ a: "recovered" });
    expect(view.hydration.getStatus()).toBe("current");
  });

  test("unsupported capability stops timed reads until a reconnect", async () => {
    const view = harness();
    view.hydration.request("initial");
    await view.resolve(0, { kind: "unsupported" });
    expect(view.hydration.getStatus()).toBe("unsupported");

    view.legacyEvent("a", "live");
    view.hydration.safetyCheck();
    view.hydration.request("gap");
    expect(view.state()).toEqual({ a: "live" });
    expect(view.fetches).toHaveLength(1);
    expect(view.time.pending()).toBe(0);

    view.hydration.onReconnect();
    expect(view.fetches).toHaveLength(2);
  });

  test("a legacy peer replays buffered updates over its snapshot and skips safety reads", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.legacyEvent("a", "newer");
    view.legacyEvent("b", null);
    await view.resolve(0, snapshot(null, { a: "older", b: "present" }));

    expect(view.state()).toEqual({ a: "newer" });
    expect(view.diagnostics().capability).toBe("legacy");
    view.hydration.safetyCheck();
    expect(view.fetches).toHaveLength(1);
    // Reconnect remains the conservative recovery path.
    view.hydration.onReconnect();
    expect(view.fetches[1]?.known).toBeNull();
  });

  test("transport switch to a new owner resets through the reconnect read", async () => {
    const view = await hydrated(7, { a: "a7" });
    view.hydration.onReconnect();
    view.event("a", "b2", 2, B);
    view.event("c", "b3", 3, B);
    await view.resolve(1, snapshot(2, { a: "b2" }, B));

    expect(view.state()).toEqual({ a: "b2", c: "b3" });
    expect(view.diagnostics()).toMatchObject({ applied: { generation: B, revision: 3 } });
  });

  test("transport switch to a legacy peer falls back to conservative hydration", async () => {
    const view = await hydrated(7, { a: "a7" });
    view.legacyEvent("a", "legacy-live");
    expect(view.state()).toEqual({ a: "legacy-live" });
    expect(view.diagnostics().capability).toBe("legacy");
    expect(view.fetches).toHaveLength(2);
    await view.resolve(1, snapshot(null, { a: "legacy-live", b: "legacy" }));
    expect(view.state()).toEqual({ a: "legacy-live", b: "legacy" });
  });

  test("one read in flight and at most one queued rerun", async () => {
    const view = harness();
    view.hydration.request("initial");
    for (let index = 0; index < 5; index += 1) view.hydration.request("explicit");
    expect(view.fetches).toHaveLength(1);
    await view.resolve(0, snapshot(1, {}));
    expect(view.fetches).toHaveLength(2);
    await view.resolve(1, snapshot(1, {}));
    expect(view.fetches).toHaveLength(2);
  });

  test("deferred notifications run after their state and are separately bounded", async () => {
    const view = harness({ maxDeferredNotifications: 2 });
    const seenState: Array<string | undefined> = [];
    view.hydration.request("initial");
    for (const [index, key] of ["a", "b", "c"].entries()) {
      view.hydration.receive(
        { key, value: key, stamp: { generation: A, revision: index + 2 } },
        () => seenState.push(view.store.get(key)),
      );
    }
    expect(seenState).toEqual([]);
    await view.resolve(0, snapshot(1, {}));

    expect(seenState).toEqual(["b", "c"]);
    expect(view.diagnostics().droppedNotifications).toBe(1);
  });

  test("dispose ignores late answers and clears every timer", async () => {
    const view = harness();
    view.hydration.request("initial");
    view.hydration.dispose();
    await view.resolve(0, snapshot(1, { a: "late" }));
    expect(view.state()).toEqual({});
    expect(view.time.pending()).toBe(0);
  });
});

describe("bounded hydration primitives", () => {
  test("revision ranges merge, extend, prune and saturate at their bound", () => {
    const ranges = new RevisionRanges(2);
    ranges.add(3);
    ranges.add(5);
    ranges.add(4);
    expect(ranges.size).toBe(1);
    expect(ranges.extend(2)).toBe(5);
    ranges.add(9);
    ranges.prune(4);
    expect(ranges.extend(4)).toBe(5);
    expect(ranges.hasAbove(5)).toBe(true);
    ranges.add(20);
    expect(ranges.saturated).toBe(true);
    expect(ranges.size).toBe(0);
  });

  test("bounded key set evicts the oldest key and reports duplicates", () => {
    const keys = new BoundedKeySet(2);
    expect(keys.add("one")).toBe(true);
    expect(keys.add("one")).toBe(false);
    keys.add("two");
    keys.add("three");
    expect(keys.has("one")).toBe(false);
    expect(keys.size).toBe(2);
  });

  test("byte estimate is bounded in work and result", () => {
    expect(approximateJsonBytes({ a: "xy" })).toBe(2 + 4 + 4);
    const wide = Array.from({ length: 50_000 }, () => 1);
    expect(approximateJsonBytes(wide, 1_000)).toBeGreaterThan(1_000);
  });

  test("snapshot responses are validated before classification", () => {
    const isBody = (value: unknown): value is { entries: string[] } =>
      typeof value === "object" && value !== null && Array.isArray((value as never)["entries"]);
    const toEntries = (body: { entries: string[] }) =>
      body.entries.map((key) => ({ key, value: key }));

    expect(toHydrationFetchResult({ entries: ["a"] }, isBody, toEntries)).toEqual({
      kind: "snapshot",
      stamp: null,
      entries: [{ key: "a", value: "a" }],
    });
    expect(
      toHydrationFetchResult(
        {
          status: "reset",
          generation: A,
          revision: 1,
          reason: "generation",
          snapshot: { entries: [] },
        },
        isBody,
        toEntries,
      ),
    ).toEqual({ kind: "snapshot", stamp: { generation: A, revision: 1 }, entries: [] });
    expect(
      toHydrationFetchResult({ status: "deleted", generation: A, revision: 4 }, isBody, toEntries),
    ).toEqual({ kind: "deleted", stamp: { generation: A, revision: 4 } });
    expect(toHydrationFetchResult({ entries: "nope" }, isBody, toEntries)).toEqual({
      kind: "invalid",
    });
  });
});
