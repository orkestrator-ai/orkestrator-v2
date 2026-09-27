import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  webAnnotationPageKey,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureAnnotation,
  fixturePage,
  fixtureRequest,
} from "@orkestrator/protocol/web-annotations-fixtures";
import {
  acquireWebAnnotationSync,
  registerWebAnnotationList,
  refreshWebAnnotations,
  registerWebAnnotationThread,
  resetWebAnnotationSyncForTests,
} from "@/lib/web-annotations/sync";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import {
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  getWebAnnotationCache,
  listQueryKey,
  useWebAnnotationStore,
  type ListQuery,
} from "./webAnnotationStore";

const QUERY: ListQuery = {
  filter: { pageKey: webAnnotationPageKey(fixturePage), state: "open" },
  cursor: null,
  limit: 20,
};

async function settle(times = 6) {
  for (let index = 0; index < times; index++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

let bus: ReturnType<typeof installFakeOrkestrator>;
let backend: FakeWebAnnotationBackend;
const releases: Array<() => void> = [];

function observe(environmentId = "env-1", visible = true) {
  const handle = acquireWebAnnotationSync(environmentId, { visible });
  const list = registerWebAnnotationList(environmentId, QUERY);
  releases.push(list.release, handle.release);
  return { handle, list };
}

function listIds(environmentId = "env-1") {
  return getWebAnnotationCache(environmentId).lists.get(listQueryKey(QUERY))?.ids ?? [];
}

describe("web annotation sync", () => {
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    bus = installFakeOrkestrator();
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("subscribes before fetching and applies a hint buffered during the snapshot", async () => {
    backend.seed({ id: "annotation-a" });
    const hold = backend.hold("web_annotations_list");
    observe();
    await settle();
    // The hint subscription exists before the first list request resolved.
    expect(bus.listenerCount(WEB_ANNOTATIONS_CHANGED_EVENT)).toBe(1);
    const firstList = backend.calls.findIndex((call) => call.command === "web_annotations_list");
    expect(firstList).toBeGreaterThanOrEqual(0);
    expect(bus.listen.mock.calls[0]?.[0]).toBe(WEB_ANNOTATIONS_CHANGED_EVENT);

    // A change commits while the snapshot response is in flight.
    backend.seed({ id: "annotation-b" });
    backend.bump(["annotation-b"]);
    bus.emitHint(backend.hint(["annotation-b"]));
    hold.release();
    await settle(10);

    expect(listIds()).toEqual(["annotation-a", "annotation-b"]);
    expect(getWebAnnotationCache("env-1").revision).toBe(backend.revision);
  });

  test("overflowing the pre-snapshot hint buffer forces a second full snapshot", async () => {
    backend.seed({ id: "annotation-a" });
    const hold = backend.hold("web_annotations_list");
    observe();
    await settle();
    expect(backend.callsOf("web_annotations_list")).toHaveLength(1);
    backend.seed({ id: "annotation-b" });
    for (let index = 0; index <= WEB_ANNOTATION_LIMITS.hintRingEntries; index++) {
      backend.bump(["annotation-b"]);
      bus.emitHint(backend.hint(["annotation-b"]));
    }
    hold.release();
    await settle(12);
    // The dropped hints are not replayed; a fresh snapshot replaces them.
    expect(backend.callsOf("web_annotations_list")).toHaveLength(2);
    expect(backend.callsOf("web_annotations_changes")).toHaveLength(0);
    expect(listIds()).toEqual(["annotation-a", "annotation-b"]);
    expect(getWebAnnotationCache("env-1").revision).toBe(backend.revision);
  });

  test("a snapshot whose lists span two generations is refetched", async () => {
    backend.seed({ id: "annotation-a" });
    const list = (backend as unknown as { list: (args: unknown) => { generation: string } }).list;
    let calls = 0;
    backend.overrides.set("web_annotations_list", (args) => {
      const result = list.call(backend, args);
      // The second list of the first snapshot raced a backend restart.
      return ++calls === 2 ? { ...result, generation: "gen-stale" } : result;
    });
    observe();
    const other = registerWebAnnotationList("env-1", { ...QUERY, filter: { state: "all" } });
    releases.push(other.release);
    await settle(12);
    expect(backend.callsOf("web_annotations_list").length).toBeGreaterThanOrEqual(4);
    expect(getWebAnnotationCache("env-1").generation).toBe("gen-1");
    expect(getWebAnnotationCache("env-1").sync.status).toBe("ready");
  });

  test("an open thread keeps its list summary's content revision current", async () => {
    backend.seed({ id: "annotation-a" });
    observe();
    releases.push(registerWebAnnotationThread("env-1", "annotation-a"));
    await settle(10);
    expect(getWebAnnotationCache("env-1").summaries.get("annotation-a")?.contentRevision).toBe(1);
    // A reply advances content; only the open thread is refetched.
    const annotation = backend.annotations.get("annotation-a")!;
    annotation.contentRevision = 2;
    annotation.metadataRevision += 1;
    refreshWebAnnotations("env-1", { annotationIds: ["annotation-a"], allLists: false });
    await settle(10);
    const cache = getWebAnnotationCache("env-1");
    expect(cache.threads.get("annotation-a")?.data?.annotation.contentRevision).toBe(2);
    expect(cache.summaries.get("annotation-a")?.contentRevision).toBe(2);
  });

  test("an older thread snapshot never regresses a newer summary", () => {
    const store = useWebAnnotationStore.getState();
    const newer = { ...fixtureAnnotation({ id: "annotation-a" }), activeRequest: null };
    newer.metadataRevision = 5;
    newer.contentRevision = 3;
    store.installList("env-1", "k", { total: 1, openOnPage: null, nextCursor: null, revision: 1 }, [
      newer,
    ]);
    const older = { ...newer, metadataRevision: 4, contentRevision: 2 };
    store.installThread("env-1", "annotation-a", {
      status: "ready",
      error: null,
      data: {
        generation: "gen-1",
        revision: 1,
        annotation: older,
        capture: null,
        entries: [],
        nextEntrySequence: null,
        requests: [],
        results: [],
      },
    });
    expect(getWebAnnotationCache("env-1").summaries.get("annotation-a")?.contentRevision).toBe(3);
  });

  test("a later contiguous hint refetches affected resources instead of patching", async () => {
    backend.seed({ id: "annotation-a" });
    observe();
    const unregister = registerWebAnnotationThread("env-1", "annotation-a");
    releases.push(unregister);
    await settle(10);
    const gets = backend.callsOf("web_annotation_get").length;
    backend.annotations.get("annotation-a")!.title = "Renamed";
    backend.bump(["annotation-a"]);
    bus.emitHint(backend.hint(["annotation-a"]));
    await settle(10);
    expect(backend.callsOf("web_annotation_get").length).toBe(gets + 1);
    expect(getWebAnnotationCache("env-1").summaries.get("annotation-a")?.title).toBe("Renamed");
  });

  test("a revision gap asks the backend for changes", async () => {
    backend.seed({ id: "annotation-a" });
    observe();
    await settle(10);
    backend.bump(["annotation-a"]);
    backend.bump(["annotation-a"]);
    bus.emitHint(backend.hint(["annotation-a"]));
    await settle(10);
    expect(backend.callsOf("web_annotations_changes").length).toBe(1);
    expect(getWebAnnotationCache("env-1").revision).toBe(backend.revision);
  });

  test("recovers a lost final hint with the visible reconcile interval", async () => {
    const intervals: Array<{ callback: () => void; delay: number }> = [];
    const spy = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      intervals.push({ callback, delay });
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      backend.seed({ id: "annotation-a" });
      observe("env-1", true);
      await settle(10);
      const reconcile = intervals.find(
        (entry) => entry.delay === WEB_ANNOTATION_LIMITS.reconcileIntervalMs,
      );
      expect(reconcile).toBeDefined();

      // The final change's hint never arrives.
      backend.seed({ id: "annotation-late" });
      backend.bump(["annotation-late"]);
      reconcile!.callback();
      await settle(10);
      expect(listIds()).toContain("annotation-late");
    } finally {
      spy.mockRestore();
    }
  });

  test("does not poll while hidden, and activation reconciles", async () => {
    const spy = spyOn(globalThis, "setInterval");
    try {
      backend.seed({ id: "annotation-a" });
      const { handle } = observe("env-1", false);
      await settle(10);
      expect(
        spy.mock.calls.some((call) => call[1] === WEB_ANNOTATION_LIMITS.reconcileIntervalMs),
      ).toBe(false);
      backend.seed({ id: "annotation-while-hidden" });
      backend.bump(["annotation-while-hidden"]);
      handle.setVisible(true);
      await settle(10);
      expect(listIds()).toContain("annotation-while-hidden");
    } finally {
      spy.mockRestore();
    }
  });

  test("resetRequired from the changes cursor triggers a full refetch", async () => {
    backend.seed({ id: "annotation-a" });
    const { handle } = observe("env-1", false);
    await settle(10);
    const lists = backend.callsOf("web_annotations_list").length;
    // Backend restarted: new generation, cursor no longer valid.
    backend.generation = "gen-2";
    backend.seed({ id: "annotation-b" });
    handle.setVisible(true);
    await settle(12);
    expect(backend.callsOf("web_annotations_list").length).toBeGreaterThan(lists);
    expect(getWebAnnotationCache("env-1").generation).toBe("gen-2");
    expect(listIds()).toEqual(["annotation-a", "annotation-b"]);
  });

  test("a hint from a new generation triggers a full refetch", async () => {
    backend.seed({ id: "annotation-a" });
    observe();
    await settle(10);
    backend.generation = "gen-3";
    bus.emitHint({ ...backend.hint(), reset: false });
    await settle(10);
    expect(getWebAnnotationCache("env-1").generation).toBe("gen-3");
  });

  test("discards a stale response after switching environments", async () => {
    backend.seed({ id: "annotation-a" });
    const hold = backend.hold("web_annotations_list");
    const first = acquireWebAnnotationSync("env-1", { visible: true });
    const list = registerWebAnnotationList("env-1", QUERY);
    await settle();
    list.release();
    first.release();
    observe("env-2");
    hold.release();
    await settle(10);
    expect(getWebAnnotationCache("env-1").lists.size).toBe(0);
  });

  test("a fetch failure marks the transport offline without changing domain state", async () => {
    const running = fixtureRequest("running", { id: "request-running" });
    backend.requests.set(running.id, running);
    backend.seed({ id: "annotation-a", activeRequestId: running.id, requestIds: [running.id] });
    const { handle } = observe("env-1", false);
    await settle(10);
    expect(getWebAnnotationCache("env-1").summaries.get("annotation-a")?.activeRequest?.state).toBe(
      "running",
    );

    backend.fail("web_annotations_changes", new Error("Gateway disconnected"));
    handle.setVisible(true);
    await settle(10);
    const cache = getWebAnnotationCache("env-1");
    expect(cache.sync.status).toBe("error");
    expect(cache.sync.error).toContain("Gateway disconnected");
    expect(cache.summaries.get("annotation-a")?.activeRequest?.state).toBe("running");
    expect(cache.summaries.get("annotation-a")?.state).toBe("open");
  });

  test("an older backend is explicitly unavailable and receives no annotation reads", async () => {
    backend.capabilities = null;
    observe();
    await settle(10);
    const cache = getWebAnnotationCache("env-1");
    expect(cache.capabilityStatus).toBe("unavailable");
    expect(backend.callsOf("web_annotations_list")).toHaveLength(0);
  });

  test("ignores hints for other environments", async () => {
    backend.seed({ id: "annotation-a" });
    observe();
    await settle(10);
    const lists = backend.callsOf("web_annotations_list").length;
    bus.emitHint({ ...backend.hint(), environmentId: "env-other", revision: 99 });
    await settle(10);
    expect(backend.callsOf("web_annotations_list").length).toBe(lists);
  });

  test("migration runs once per environment when advertised", async () => {
    backend.capabilities = {
      ...backend.capabilities!,
      operations: { ...backend.capabilities!.operations, migration: true },
    };
    const first = observe();
    await settle(10);
    first.list.release();
    first.handle.release();
    observe();
    await settle(10);
    expect(backend.callsOf("web_annotations_migrate")).toHaveLength(1);
  });

  test("migration repeats while drafts remain and stops when a batch makes no progress", async () => {
    backend.capabilities = {
      ...backend.capabilities!,
      operations: { ...backend.capabilities!.operations, migration: true },
    };
    backend.migrationBatches = [
      { pendingDrafts: 30, completedAt: null },
      { pendingDrafts: 5, completedAt: null },
      { pendingDrafts: 5, completedAt: null },
      { pendingDrafts: 0 },
    ];
    observe();
    await waitFor(() => expect(backend.callsOf("web_annotations_migrate")).toHaveLength(3));
    await settle(10);
    // The third batch did not shrink the backlog: wait for a later retry.
    expect(backend.callsOf("web_annotations_migrate")).toHaveLength(3);
    expect(getWebAnnotationCache("env-1").migration?.pendingDrafts).toBe(5);
  });

  test("a deferred migration is retried by a reconcile after the retry delay", async () => {
    backend.capabilities = {
      ...backend.capabilities!,
      operations: { ...backend.capabilities!.operations, migration: true },
    };
    backend.migrationBatches = [{ deferredDrafts: 2, completedAt: null }];
    const { handle } = observe();
    await settle(10);
    expect(backend.callsOf("web_annotations_migrate")).toHaveLength(1);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now + 61_000);
    try {
      handle.setVisible(false);
      handle.setVisible(true);
      await settle(10);
      expect(backend.callsOf("web_annotations_migrate")).toHaveLength(2);
      expect(getWebAnnotationCache("env-1").migration?.deferredDrafts).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});
