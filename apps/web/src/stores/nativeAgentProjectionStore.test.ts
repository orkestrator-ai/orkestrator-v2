import { afterEach, describe, expect, test } from "bun:test";
import type {
  NativeAgentDiscoveryView,
  NativeAgentSessionProjection,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import {
  measureEncodedValue,
  setEncodedValueMeasureForTests,
  slowEncodedBytes,
} from "@/lib/native-history-accounting";
import { appCommandScope } from "@/lib/node-scope-slots";
import {
  evictNativeAgentHistoryCaches,
  nativeAgentProjectionStore,
  type NativeAgentSyncCacheEntry,
  recomputeNativeAgentProjectionTotals,
} from "./nativeAgentProjectionStore";
import { appCommandStore } from "@/test/app-command-store";

/** The command node's retained-history reservations in the window budget. */
function reservedHistoryBytes(): number {
  const scope = appCommandScope();
  return scope.budgets.transcripts.usedBytesFor(scope.nodeId);
}

function discoveryView(): NativeAgentDiscoveryView {
  return {
    identity: {
      backendInstanceId: "backend-1",
      environmentId: "env-1",
      platform: "codex",
      logicalSessionKey: "session-a",
      providerSessionId: "provider-a",
      sourceGeneration: "generation-1",
    },
    sections: {},
  };
}

function projection(id: string, messages: unknown[] = []): NativeAgentSessionProjection {
  return {
    platform: "codex",
    environmentId: "env-1",
    sessionId: id,
    connection: "connected",
    turn: { phase: "idle" },
    messages,
    interactions: [],
    composerControls: [],
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: {
        provider: false,
        model: false,
        reasoning: false,
        speed: false,
        mode: false,
      },
    },
    revision: 1,
    generation: "generation-1",
  };
}

function seedSession(key: string, historyBytes: number): void {
  const live = projection(`${key}-live`, [{ id: `${key}-live-message` }]);
  appCommandStore(nativeAgentProjectionStore)
    .getState()
    .setProjection(
      key,
      projection(`${key}-materialized`, [{ id: `${key}-history-message` }, ...live.messages]),
      {
        token: `${key}-token`,
        liveProjection: live,
        historyEpoch: "epoch-1",
        historyComplete: false,
        historyMessages: [{ id: `${key}-history-message` }],
        historyBytes,
      },
    );
}

function syncCache(
  liveProjection: NativeAgentSessionProjection,
  historyMessages: unknown[],
  historyBytes: number,
): NativeAgentSyncCacheEntry {
  return { liveProjection, historyComplete: false, historyMessages, historyBytes };
}

afterEach(() => appCommandStore(nativeAgentProjectionStore).getState().reset());

describe("native agent projection history cache", () => {
  test("evicts inactive history while retaining its bounded live projection", () => {
    for (const key of ["session-a", "session-b", "session-c"]) seedSession(key, 8);

    evictNativeAgentHistoryCaches("session-c", 5, 20);

    const state = appCommandStore(nativeAgentProjectionStore).getState();
    expect([...state.syncCaches.keys()]).toEqual(["session-c"]);
    expect(state.projections.get("session-a")?.sessionId).toBe("session-a-live");
    expect(state.projections.get("session-b")?.sessionId).toBe("session-b-live");
    expect(state.projections.get("session-c")?.sessionId).toBe("session-c-materialized");
  });

  test("counts each eviction so a mounted reader can drop its own copy", () => {
    seedSession("session-a", 8);
    seedSession("session-b", 8);

    evictNativeAgentHistoryCaches("session-b", 8, 12);
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.get("session-a"),
    ).toBe(1);
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.has("session-b"),
    ).toBe(false);

    // A later mount repopulates the cache; the next eviction must be visible as
    // a change rather than repeating a value the reader already honoured.
    seedSession("session-a", 8);
    evictNativeAgentHistoryCaches("session-b", 8, 12);
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.get("session-a"),
    ).toBe(2);
  });

  test("does nothing when the retained history already fits", () => {
    seedSession("session-a", 8);

    evictNativeAgentHistoryCaches("session-b", 1, 100);

    expect([...appCommandStore(nativeAgentProjectionStore).getState().syncCaches.keys()]).toEqual([
      "session-a",
    ]);
    expect(appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.size).toBe(0);
  });

  test("retains a progressive entry that carries no token or paging epoch", () => {
    // A live tail read through the progressive transcript has neither: both are
    // minted by the sync-v1 surfaces, which such a session never touches. The
    // entry still has to survive so a remount can inherit its retained pages.
    const live = projection("session-a-live", [{ id: "session-a-live-message" }]);
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(
        "session-a",
        projection("session-a-materialized", [{ id: "history-message" }, ...live.messages]),
        {
          liveProjection: live,
          historyBootstrap: true,
          historyComplete: false,
          historyMessages: [{ id: "history-message" }],
          historyBytes: 8,
        },
      );

    const cached = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .syncCaches.get("session-a");
    expect(cached?.token).toBeUndefined();
    expect(cached?.historyEpoch).toBeUndefined();
    expect(cached?.historyBootstrap).toBe(true);
    expect(cached?.historyMessages).toEqual([{ id: "history-message" }]);
  });

  test("drops a progressive transcript token when its projection is evicted", () => {
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    const identity: NativeAgentViewIdentity = {
      backendInstanceId: "backend-1",
      environmentId: "env-1",
      platform: "codex",
      logicalSessionKey: "session-old",
      providerSessionId: "session-old-session",
      sourceGeneration: "generation-1",
    };
    store.setProgressiveCache("session-old", {
      identity,
      transcriptToken: "tok-old",
      transcriptHistoryEpoch: "epoch-1",
      transcriptHistoryMetadata: {
        historyCursor: "before-head",
        historyPaging: "direct",
        historyComplete: false,
        historyReconciliationToken: "row-digest",
      },
      transcriptAvailability: "current",
      transcriptRefreshing: false,
      stateAvailability: "unavailable",
    });
    store.setProjection("session-old", projection("old", [{ id: "m" }]));
    for (let index = 0; index < 128; index += 1) {
      store.setProjection(`session-${index}`, projection(`s${index}`, [{ id: "m" }]));
    }

    const next = appCommandStore(nativeAgentProjectionStore).getState();
    expect(next.projections.has("session-old")).toBe(false);
    expect(next.progressiveCaches.get("session-old")?.transcriptToken).toBeUndefined();
    expect(next.progressiveCaches.get("session-old")?.transcriptHistoryEpoch).toBeUndefined();
    expect(next.progressiveCaches.get("session-old")?.transcriptHistoryMetadata).toBeUndefined();
  });

  test("drops a progressive transcript token when its projection is cleared", () => {
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    store.setProgressiveCache("session-a", {
      transcriptToken: "tok-a",
      transcriptHistoryEpoch: "epoch-1",
      transcriptAvailability: "current",
      transcriptRefreshing: false,
      stateAvailability: "unavailable",
    });
    store.setProjection("session-a", projection("a", [{ id: "m" }]));
    store.setProjection("session-a", null);

    expect(
      appCommandStore(nativeAgentProjectionStore).getState().progressiveCaches.get("session-a")
        ?.transcriptToken,
    ).toBeUndefined();
  });

  test("releases the eviction counter once nothing is left to compare against", () => {
    seedSession("session-a", 8);
    seedSession("session-b", 8);
    evictNativeAgentHistoryCaches("session-b", 8, 12);
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.has("session-a"),
    ).toBe(true);

    appCommandStore(nativeAgentProjectionStore).getState().setProjection("session-a", null, null);

    expect(
      appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.has("session-a"),
    ).toBe(false);
  });
});

describe("native agent projection byte accounting", () => {
  afterEach(() => setEncodedValueMeasureForTests());

  function countMeasuredObjects(): unknown[] {
    const measured: unknown[] = [];
    setEncodedValueMeasureForTests((value) => {
      if (value !== null && typeof value === "object") measured.push(value);
      return measureEncodedValue(value);
    });
    return measured;
  }

  function expectExactTotals(): void {
    const state = appCommandStore(nativeAgentProjectionStore).getState();
    const slow = recomputeNativeAgentProjectionTotals(state);
    expect(state.projectionBytesTotal).toBe(slow.projectionBytesTotal);
    expect(reservedHistoryBytes()).toBe(slow.historyBytesTotal);
    expect(state.progressiveCacheBytesTotal).toBe(slow.progressiveCacheBytesTotal);
    for (const [key, bytes] of state.projectionBytes) {
      expect(bytes).toBe(slowEncodedBytes(state.projections.get(key)!.messages));
    }
  }

  function syncEntry(
    live: NativeAgentSessionProjection,
    historyMessages: unknown[],
  ): NativeAgentSyncCacheEntry {
    return {
      liveProjection: live,
      historyComplete: false,
      historyMessages,
      historyBytes: historyMessages.length ? slowEncodedBytes(historyMessages) : 0,
    };
  }

  test("serializes only changed messages while ~8 MiB of history is retained", () => {
    const measured = countMeasuredObjects();
    const history = Array.from({ length: 2_000 }, (_, index) => ({
      id: `h${index}`,
      text: "x".repeat(4_000),
    }));
    let liveMessage = { id: "live", text: "" };
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    store.setProjection("session-a", projection("a", [...history, liveMessage]));
    expect(measured).toHaveLength(2_001);
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().projectionBytesTotal,
    ).toBeGreaterThan(7.5 * 1024 * 1024);

    for (let update = 0; update < 20; update += 1) {
      measured.length = 0;
      liveMessage = { id: "live", text: `${liveMessage.text}token-${update} ` };
      store.setProjection("session-a", projection("a", [...history, liveMessage]));
      expect(measured).toEqual([liveMessage]);
    }
    expectExactTotals();
  });

  test("keeps running totals exact across a random operation sequence", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let nextId = 0;
    const fresh = () => ({ id: `m${nextId++}`, text: "é😀".repeat(Math.floor(random() * 20)) });
    const keys = ["a", "b", "c", "d"];
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    for (let step = 0; step < 300; step += 1) {
      const key = keys[Math.floor(random() * keys.length)]!;
      const operation = Math.floor(random() * 6);
      if (operation <= 1) {
        const live = projection(`${key}-live`, [fresh(), fresh()]);
        const history = Array.from({ length: Math.floor(random() * 4) }, fresh);
        store.setProjection(
          key,
          projection(key, [...history, ...live.messages]),
          syncEntry(live, history),
        );
      } else if (operation === 2) {
        const current = appCommandStore(nativeAgentProjectionStore).getState().projections.get(key);
        // Same array identity: bytes are reused without measuring anything.
        if (current) store.setProjection(key, { ...current, revision: current.revision + 1 });
      } else if (operation === 3) {
        store.setProjection(key, random() < 0.5 ? null : projection(key, [fresh()]), null);
      } else if (operation === 4) {
        evictNativeAgentHistoryCaches(key, Math.floor(random() * 400), 300);
      } else {
        store.setProgressiveCache(key, {
          transcriptAvailability: "current",
          transcriptRefreshing: random() < 0.5,
          stateAvailability: "current",
          ...(random() < 0.5 ? { discovery: discoveryView() } : {}),
        });
      }
      expectExactTotals();
    }
  });

  test("an eviction charges the display budget for the live tail only", () => {
    seedSession("session-a", 8);
    seedSession("session-b", 8);
    evictNativeAgentHistoryCaches("session-b", 8, 12);

    const state = appCommandStore(nativeAgentProjectionStore).getState();
    expect(state.projectionBytes.get("session-a")).toBe(
      slowEncodedBytes([{ id: "session-a-live-message" }]),
    );
    expect(reservedHistoryBytes()).toBe(8);
    expectExactTotals();
  });

  test("does not evict a session that retains no history", () => {
    const live = projection("a-live", [{ id: "live" }]);
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection("a", live, syncEntry(live, []));
    seedSession("b", 30);

    evictNativeAgentHistoryCaches("b", 10, 20);

    expect(appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.has("a")).toBe(
      false,
    );
    expect(appCommandStore(nativeAgentProjectionStore).getState().syncCaches.has("a")).toBe(true);
  });

  test("measures discovery once per object and ignores unchanged patches", () => {
    const measured = countMeasuredObjects();
    const discovery = discoveryView();
    const entry = {
      transcriptAvailability: "current" as const,
      transcriptRefreshing: false,
      stateAvailability: "current" as const,
      discovery,
    };
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    store.setProgressiveCache("session-a", entry);
    let notifications = 0;
    const unsubscribe = appCommandStore(nativeAgentProjectionStore).subscribe(() => {
      notifications += 1;
    });
    try {
      // An idle poll rebuilds an identical entry.
      store.setProgressiveCache("session-a", { ...entry });
      expect(notifications).toBe(0);
      // Two visible sessions polling in turn change nothing either.
      store.setProgressiveCache("session-b", entry);
      notifications = 0;
      store.setProgressiveCache("session-a", { ...entry });
      store.setProgressiveCache("session-b", { ...entry });
      store.setProgressiveCache("session-a", { ...entry });
      expect(notifications).toBe(0);
      store.setProgressiveCache("session-b", null);
      notifications = 0;
      // A refresh-flag toggle is a real change, but the discovery is not.
      store.setProgressiveCache("session-a", { ...entry, transcriptRefreshing: true });
      store.setProgressiveCache("session-a", { ...entry, transcriptRefreshing: false });
      expect(notifications).toBe(2);
      expect(measured).toEqual([discovery]);

      const nextDiscovery = discoveryView();
      store.setProgressiveCache("session-a", { ...entry, discovery: nextDiscovery });
      expect(measured).toEqual([discovery, nextDiscovery]);
    } finally {
      unsubscribe();
    }
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().progressiveCacheBytes.get("session-a"),
    ).toBe(slowEncodedBytes(discoveryView()) + 4_096);
    expectExactTotals();
  });
});

describe("native agent projection writes copy only what they change", () => {
  const identities = () => {
    const state = appCommandStore(nativeAgentProjectionStore).getState();
    return {
      projections: state.projections,
      projectionBytes: state.projectionBytes,
      syncCaches: state.syncCaches,
      progressiveCaches: state.progressiveCaches,
      progressiveCacheBytes: state.progressiveCacheBytes,
      historyEvictions: state.historyEvictions,
    };
  };
  const changedMaps = (before: ReturnType<typeof identities>) => {
    const after = identities();
    return (Object.keys(before) as Array<keyof typeof before>).filter(
      (name) => before[name] !== after[name],
    );
  };
  const progressive = {
    transcriptToken: "token",
    transcriptAvailability: "current",
    transcriptRefreshing: false,
    stateAvailability: "current",
  } as const;

  test("a new projection with the same messages changes only the projections Map", () => {
    const { setProjection } = appCommandStore(nativeAgentProjectionStore).getState();
    const messages = [{ id: "m1" }];
    setProjection("a", projection("a", messages));
    setProjection("b", projection("b", messages));
    const before = identities();
    setProjection("a", projection("a", messages));
    expect(changedMaps(before)).toEqual(["projections"]);
    // The LRU still moved: "a" is now the most recent.
    expect([...appCommandStore(nativeAgentProjectionStore).getState().projections.keys()]).toEqual([
      "b",
      "a",
    ]);
  });

  test("changed messages also change the byte Map, and nothing else", () => {
    const { setProjection, setProgressiveCache } = appCommandStore(
      nativeAgentProjectionStore,
    ).getState();
    setProgressiveCache("a", progressive);
    setProjection("a", projection("a", [{ id: "m1" }]));
    const before = identities();
    setProjection("a", projection("a", [{ id: "m1" }, { id: "m2" }]));
    expect(changedMaps(before)).toEqual(["projections", "projectionBytes"]);
  });

  test("a sync cache write adds only the sync Map", () => {
    const { setProjection } = appCommandStore(nativeAgentProjectionStore).getState();
    const live = projection("a");
    setProjection("a", live);
    const before = identities();
    setProjection("a", projection("a"), syncCache(live, [], 0));
    expect(changedMaps(before)).toEqual(["projections", "syncCaches"]);
    expect(recomputeNativeAgentProjectionTotals().historyBytesTotal).toBe(reservedHistoryBytes());
  });

  test("a projection write keeps the sync and progressive Maps while both hold entries", () => {
    const { setProjection, setProgressiveCache } = appCommandStore(
      nativeAgentProjectionStore,
    ).getState();
    for (const key of ["a", "b"]) {
      const live = projection(key, [{ id: `${key}-1` }]);
      setProjection(key, live, syncCache(live, [{ id: `${key}-history` }], 20));
      setProgressiveCache(key, progressive);
    }
    const before = identities();
    const entries = {
      sync: before.syncCaches.get("a"),
      progressive: before.progressiveCaches.get("a"),
    };

    setProjection("a", projection("a", [{ id: "a-1" }, { id: "a-2" }]));

    expect(changedMaps(before)).toEqual(["projections", "projectionBytes"]);
    const state = appCommandStore(nativeAgentProjectionStore).getState();
    expect(state.syncCaches.get("a")).toBe(entries.sync);
    expect(state.progressiveCaches.get("a")).toBe(entries.progressive);
    expect([...state.projections.keys()]).toEqual(["b", "a"]);
  });

  test("the count ceiling still evicts the oldest session from all three Maps", () => {
    const { setProjection, setProgressiveCache } = appCommandStore(
      nativeAgentProjectionStore,
    ).getState();
    const oldLive = projection("old", [{ id: "old-1" }]);
    setProjection("old", oldLive, syncCache(oldLive, [{ id: "old-history" }], 40));
    setProgressiveCache("old", progressive);
    for (let index = 0; index < 127; index += 1) {
      setProjection(`s${index}`, projection(`s${index}`, [{ id: "m" }]));
    }
    const before = identities();
    expect(before.projections.size).toBe(128);

    setProjection("s127", projection("s127", [{ id: "m" }]));

    const state = appCommandStore(nativeAgentProjectionStore).getState();
    expect(state.projections.size).toBe(128);
    expect(state.projections.has("old")).toBe(false);
    expect(state.projectionBytes.has("old")).toBe(false);
    expect(state.syncCaches.has("old")).toBe(false);
    expect(reservedHistoryBytes()).toBe(0);
    expect(state.progressiveCaches.get("old")?.transcriptToken).toBeUndefined();
    expect(changedMaps(before)).toEqual([
      "projections",
      "projectionBytes",
      "syncCaches",
      "progressiveCaches",
    ]);
    expect(recomputeNativeAgentProjectionTotals()).toEqual({
      projectionBytesTotal: state.projectionBytesTotal,
      historyBytesTotal: reservedHistoryBytes(),
      progressiveCacheBytesTotal: state.progressiveCacheBytesTotal,
    });
  });

  test("the byte ceiling still evicts the oldest session from all three Maps", () => {
    // Each "big" message counts as 20 MiB, so two of them pass the 32 MiB ceiling.
    setEncodedValueMeasureForTests((value) =>
      (value as { big?: boolean } | null)?.big ? 20 * 1024 * 1024 : measureEncodedValue(value),
    );
    try {
      const { setProjection, setProgressiveCache } = appCommandStore(
        nativeAgentProjectionStore,
      ).getState();
      const oldLive = projection("old", [{ id: "old-1", big: true }]);
      setProjection("old", oldLive, syncCache(oldLive, [{ id: "old-history" }], 40));
      setProgressiveCache("old", progressive);
      const keptLive = projection("kept", [{ id: "kept-1" }]);
      setProjection("kept", keptLive, syncCache(keptLive, [{ id: "kept-history" }], 30));
      const before = identities();

      setProjection("new", projection("new", [{ id: "new-1", big: true }]));

      const state = appCommandStore(nativeAgentProjectionStore).getState();
      expect([...state.projections.keys()]).toEqual(["kept", "new"]);
      expect([...state.projectionBytes.keys()].sort()).toEqual(["kept", "new"]);
      expect([...state.syncCaches.keys()]).toEqual(["kept"]);
      expect(reservedHistoryBytes()).toBe(30);
      expect(state.projectionBytesTotal).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(state.progressiveCaches.get("old")?.transcriptToken).toBeUndefined();
      expect(changedMaps(before)).toEqual([
        "projections",
        "projectionBytes",
        "syncCaches",
        "progressiveCaches",
      ]);
    } finally {
      setEncodedValueMeasureForTests();
    }
  });

  test("rewriting the newest projection publishes nothing", () => {
    const { setProjection } = appCommandStore(nativeAgentProjectionStore).getState();
    const live = projection("a");
    const cache = syncCache(live, [], 0);
    setProjection("a", live, cache);
    const state = appCommandStore(nativeAgentProjectionStore).getState();
    setProjection("a", live);
    setProjection("a", live, cache);
    expect(appCommandStore(nativeAgentProjectionStore).getState()).toBe(state);
  });

  test("clearing a session touches its progressive entry only when it holds a token", () => {
    const { setProjection, setProgressiveCache } = appCommandStore(
      nativeAgentProjectionStore,
    ).getState();
    setProjection("a", projection("a"));
    setProgressiveCache("other", progressive);
    const before = identities();
    setProjection("a", null);
    expect(changedMaps(before)).toEqual(["projections", "projectionBytes"]);

    setProjection("b", projection("b"));
    setProgressiveCache("b", progressive);
    const withToken = identities();
    setProjection("b", null);
    expect(changedMaps(withToken)).toEqual(["projections", "projectionBytes", "progressiveCaches"]);
  });

  test("a progressive patch with the same discovery keeps the byte Map", () => {
    const { setProgressiveCache } = appCommandStore(nativeAgentProjectionStore).getState();
    const discovery = discoveryView();
    setProgressiveCache("a", { ...progressive, discovery });
    const before = identities();
    setProgressiveCache("a", { ...progressive, discovery, transcriptRefreshing: true });
    expect(changedMaps(before)).toEqual(["progressiveCaches"]);
  });

  test("clearing an absent progressive entry publishes nothing", () => {
    const state = appCommandStore(nativeAgentProjectionStore).getState();
    state.setProgressiveCache("absent", null);
    expect(appCommandStore(nativeAgentProjectionStore).getState()).toBe(state);
  });

  test("an eviction that finds nothing to release publishes nothing", () => {
    const { setProjection } = appCommandStore(nativeAgentProjectionStore).getState();
    const live = projection("a");
    setProjection("a", live, syncCache(live, [{ id: "m" }], 2_000));
    const state = appCommandStore(nativeAgentProjectionStore).getState();
    // Over budget, but the only history belongs to the excepted session.
    evictNativeAgentHistoryCaches("a", 1_000, 1_000);
    expect(appCommandStore(nativeAgentProjectionStore).getState()).toBe(state);
  });
});
