import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  CoordinatorPaneLayout,
  CoordinatorPaneLayoutRecord,
} from "@orkestrator/protocol/coordinator-pane-layout";
import {
  COORDINATOR_LAYOUT_RETRY_DELAYS_MS,
  LEGACY_COORDINATOR_LAYOUT_KEY,
  MAX_REMEMBERED_COORDINATOR_LAYOUTS,
  selectCoordinatorPaneLayout,
  selectCoordinatorPaneLayoutReady,
  selectCoordinatorPaneLayoutStatus,
  coordinatorPaneLayoutStore,
} from "./coordinatorPaneLayoutStore";
import { appCommandStore } from "@/test/app-command-store";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import {
  focusCoordinatorPane,
  reconcileCoordinatorLayout,
  reorderCoordinatorConversations,
  resizeCoordinatorSplit,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  dispatchResourceChange,
  requestResourceResync,
  requestViewSafetyChecks,
} from "@/lib/resource-sync";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const key = LEGACY_COORDINATOR_LAYOUT_KEY;
const single = () => reconcileCoordinatorLayout(null, ["main", "side-1", "side-2"]);

const capabilities = (coordinatorPaneLayouts: boolean): ClientStateCapabilities => ({
  coordinatorPaneLayouts,
  coordinatorUpstreamMerge: false,
  coordinatorUpstreamAutoMerge: false,
  noticeDismissals: false,
  environmentAttention: false,
});

function seedBrowserCopy(layouts: unknown) {
  localStorage.setItem(key, JSON.stringify({ state: { layouts }, version: 0 }));
}

async function flushPromises() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Resource hints are coalesced for a short window before delivery. */
const hintDelivered = () => new Promise((resolve) => setTimeout(resolve, 70));

const RETRY_DELAYS: ReadonlySet<number> = new Set(COORDINATOR_LAYOUT_RETRY_DELAYS_MS);

/**
 * Captures the store's retry timers (by their delays) without running them;
 * every other timer runs as usual. `restore` puts the real timers back.
 */
function captureRetryTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const captured: Array<{ delay: number; run: () => void }> = [];
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    if (delay !== undefined && RETRY_DELAYS.has(delay)) {
      captured.push({ delay, run });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(run, delay);
  }) as typeof setTimeout;
  return {
    get scheduled() {
      return captured.map((timer) => timer.delay);
    },
    run: (index: number) => captured[index]!.run(),
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

/** A stand-in for the backend store: compare-and-swap on one record per project. */
function fakeBackend() {
  const records = new Map<string, CoordinatorPaneLayoutRecord>();
  const missingProjects = new Set<string>();
  const saves: Array<{ projectId: string; expectedRevision: number }> = [];
  let failSaves: Error | null = null;
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const projectId = args?.projectId as string;
    if (command === "get_coordinator_pane_layout") return records.get(projectId) ?? null;
    if (command === "save_coordinator_pane_layout") {
      if (failSaves) throw failSaves;
      if (missingProjects.has(projectId)) throw new Error("Project not found");
      const expectedRevision = args.expectedRevision as number;
      saves.push({ projectId, expectedRevision });
      const stored = records.get(projectId) ?? null;
      if ((stored?.revision ?? 0) !== expectedRevision) {
        return { status: "conflict", current: stored };
      }
      const record = {
        projectId,
        layout: args.layout as CoordinatorPaneLayout,
        revision: expectedRevision + 1,
        updatedAt: new Date(0).toISOString(),
      };
      records.set(projectId, record);
      return { status: "saved", record };
    }
    return undefined;
  });
  return {
    records,
    missingProjects,
    saves,
    failSavesWith: (error: Error | null) => {
      failSaves = error;
    },
    remoteSave: (projectId: string, layout: CoordinatorPaneLayout) => {
      const revision = (records.get(projectId)?.revision ?? 0) + 1;
      records.set(projectId, {
        projectId,
        layout,
        revision,
        updatedAt: new Date(0).toISOString(),
      });
      return revision;
    },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  localStorage.removeItem(key);
  appCommandStore(coordinatorPaneLayoutStore).getState().reset();
});

afterEach(() => {
  // Stops any retry a failed read scheduled (invariant 15).
  appCommandStore(coordinatorPaneLayoutStore).getState().reset();
  localStorage.removeItem(key);
  resetClientStateCapabilitiesForTests();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("against a backend that owns coordinator layouts", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(true)));

  test("reads the stored layout on hydrate and is not ready before it", async () => {
    const server = fakeBackend();
    const layout = single();
    server.remoteSave("p", layout);
    expect(
      selectCoordinatorPaneLayoutReady("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBe(false);
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    expect(
      selectCoordinatorPaneLayoutReady("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBe(true);
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(layout);
  });

  test("saves changes in order, each against the revision the last one returned", async () => {
    const server = fakeBackend();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const first = single();
    const second = focusCoordinatorPane(first, first.activePaneId, "side-2");
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", first);
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", second);
    await flushPromises();
    expect(server.saves.map((save) => save.expectedRevision)).toEqual([0, 1]);
    expect(server.records.get("p")?.layout).toEqual(second);
    expect(localStorage.getItem(key)).toBeNull();
  });

  test("identical layouts are a state and save no-op", async () => {
    const server = fakeBackend();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const layout = single();
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", layout);
    await flushPromises();
    const state = appCommandStore(coordinatorPaneLayoutStore).getState();
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", layout);
    await flushPromises();
    expect(appCommandStore(coordinatorPaneLayoutStore).getState()).toBe(state);
    expect(server.saves).toHaveLength(1);
  });

  test("another client's save wins a conflict and its layout is adopted", async () => {
    const server = fakeBackend();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const remote = focusCoordinatorPane(single(), "x", "side-1");
    server.remoteSave("p", remote);
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", single());
    await flushPromises();
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(remote);
    // The next local change builds on the revision it adopted.
    const next = single();
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", next);
    await flushPromises();
    expect(server.records.get("p")).toMatchObject({ revision: 2, layout: next });
  });

  test("a change hint refreshes the project; a stale answer cannot roll it back", async () => {
    const server = fakeBackend();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const remote = single();
    server.remoteSave("p", remote);
    dispatchResourceChange({
      resource: "coordinator-pane-layout",
      id: "p",
      projectId: "p",
      revision: 1,
    });
    await hintDelivered();
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(remote);

    const newer = single();
    server.records.set("p", { ...server.records.get("p")!, layout: newer, revision: 5 });
    const hint = (revision: number) =>
      dispatchResourceChange({
        resource: "coordinator-pane-layout",
        id: "p",
        projectId: "p",
        revision,
      });
    hint(2);
    await hintDelivered();
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(newer);

    // An answer older than the revision already held does not replace it.
    server.records.set("p", { ...server.records.get("p")!, layout: single(), revision: 3 });
    hint(3);
    await hintDelivered();
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(newer);
  });

  test("this client's own save announced back keeps the same layout object", async () => {
    fakeBackend();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const layout = single();
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", layout);
    await flushPromises();
    dispatchResourceChange({
      resource: "coordinator-pane-layout",
      id: "p",
      projectId: "p",
      revision: 1,
    });
    await hintDelivered();
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBe(layout);
  });

  test("a change the connection dropped is sent by the next resync", async () => {
    const server = fakeBackend();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    server.failSavesWith(new Error("transport closed"));
    const layout = single();
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", layout);
    await flushPromises();
    expect(server.records.has("p")).toBe(false);
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBe(layout);

    server.failSavesWith(null);
    requestResourceResync();
    await hintDelivered();
    expect(server.records.get("p")?.layout).toEqual(layout);
  });

  test("imports the browser copy once, skips removed projects and keeps a newer layout", async () => {
    const server = fakeBackend();
    const browser = single();
    const stored = focusCoordinatorPane(browser, browser.activePaneId, "side-2");
    server.remoteSave("other-client", stored);
    server.missingProjects.add("removed");
    seedBrowserCopy([
      { projectId: "p", layout: browser, updatedAt: 1 },
      { projectId: "other-client", layout: browser, updatedAt: 2 },
      { projectId: "removed", layout: browser, updatedAt: 3 },
    ]);
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(browser);
    expect(server.records.get("other-client")?.layout).toEqual(stored);
    expect(localStorage.getItem(key)).toBeNull();

    const saves = server.saves.length;
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    expect(server.saves).toHaveLength(saves);
  });

  test("keeps the browser copy for another session when an import save fails", async () => {
    const server = fakeBackend();
    seedBrowserCopy([{ projectId: "p", layout: single(), updatedAt: 1 }]);
    server.failSavesWith(new Error("transport closed"));
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    expect(
      selectCoordinatorPaneLayoutReady("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBe(true);
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  test("an edit made while capabilities were unknown is saved over the stored layout", async () => {
    const stored = single();
    const edited = reconcileCoordinatorLayout(null, ["main", "other"]);
    const server = fakeBackend();
    server.remoteSave("p", stored);
    const healthy = invokeMock.getMockImplementation()!;
    resetClientStateCapabilitiesForTests();
    invokeMock.mockImplementation(async () => {
      throw new Error("transport closed");
    });
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("p", edited);

    resetClientStateCapabilitiesForTests(capabilities(true));
    invokeMock.mockImplementation(healthy);
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    await flushPromises();

    expect(server.records.get("p")?.layout).toEqual(edited);
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(edited);
  });

  test("a failed read is not ready, so nothing is reconciled against it", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("transport closed");
    });
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const state = appCommandStore(coordinatorPaneLayoutStore).getState();
    expect(selectCoordinatorPaneLayoutReady("p")(state)).toBe(false);
    expect(selectCoordinatorPaneLayoutStatus("p")(state)).toBe("failed");
    expect(selectCoordinatorPaneLayout("p")(state)).toBeUndefined();
  });

  test("a failed layout read is read again after a delay, a bounded number of times", async () => {
    const server = fakeBackend();
    server.remoteSave("p", single());
    const timers: Array<{ delay: number; run: () => void }> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void, delay: number) => {
      timers.push({ delay, run });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      const healthy = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_coordinator_pane_layout") throw new Error("transport closed");
        return healthy(command, args);
      });
      await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
      for (let index = 0; index < 5 && timers.length > index; index += 1) {
        timers[index]!.run();
        await flushPromises();
      }
      expect(timers.map((timer) => timer.delay)).toEqual([...COORDINATOR_LAYOUT_RETRY_DELAYS_MS]);
      expect(
        selectCoordinatorPaneLayoutStatus("p")(
          appCommandStore(coordinatorPaneLayoutStore).getState(),
        ),
      ).toBe("failed");

      // The panel's Retry reads again now, and a success ends the failure.
      invokeMock.mockImplementation(healthy);
      await appCommandStore(coordinatorPaneLayoutStore).getState().retry("p");
      const state = appCommandStore(coordinatorPaneLayoutStore).getState();
      expect(selectCoordinatorPaneLayoutStatus("p")(state)).toBe("ready");
      expect(selectCoordinatorPaneLayout("p")(state)).toEqual(server.records.get("p")!.layout);
      expect(server.saves).toEqual([]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("a read that fails after a reset schedules no retry and changes nothing", async () => {
    fakeBackend();
    const healthy = invokeMock.getMockImplementation()!;
    let rejectRead: (error: Error) => void = () => undefined;
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_coordinator_pane_layout") {
        return new Promise((_, reject) => {
          rejectRead = reject;
        });
      }
      return healthy(command, args);
    });
    const retryTimers = captureRetryTimers();
    try {
      const read = appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
      await flushPromises();
      appCommandStore(coordinatorPaneLayoutStore).getState().reset();
      const callsAtReset = invokeMock.mock.calls.length;
      rejectRead(new Error("transport closed"));
      await read;
      await flushPromises();
      expect(retryTimers.scheduled).toEqual([]);
      expect(appCommandStore(coordinatorPaneLayoutStore).getState().entries).toEqual({});
      expect(invokeMock.mock.calls.length).toBe(callsAtReset);
    } finally {
      retryTimers.restore();
    }
  });

  test("a read that fails after its scope is disposed schedules no retry and reads nothing", async () => {
    const windowScope = new WindowScope();
    let rejectRead: (error: Error) => void = () => undefined;
    const client = new FakeNodeClient({
      nodeId: "bk_pane-layout-dispose" as BackendId,
      invoke: {
        get_client_state_capabilities: capabilities(true),
        get_coordinator_pane_layout: () =>
          new Promise((_, reject) => {
            rejectRead = reject;
          }),
      },
    });
    const scope = windowScope.open({ role: "leaf", client });
    const store = scope.store(coordinatorPaneLayoutStore);
    const retryTimers = captureRetryTimers();
    try {
      const read = store.getState().hydrate("p");
      await flushPromises();
      expect(client.calls("get_coordinator_pane_layout")).toHaveLength(1);
      windowScope.dispose();
      const callsAtDispose = client.invocations.length;
      rejectRead(new Error("transport closed"));
      // Resolves rather than throwing against the disposed scope.
      await read;
      await flushPromises();
      expect(retryTimers.scheduled).toEqual([]);
      expect(store.getState().entries.p?.failed).toBe(false);
      // A late mount or Retry on the disposed scope reads nothing either.
      await store.getState().retry("p");
      expect(client.invocations.length).toBe(callsAtDispose);
      expect(retryTimers.scheduled).toEqual([]);
    } finally {
      retryTimers.restore();
      windowScope.dispose();
    }
  });

  test("a mount, a Retry and a resync during one read share it, per project", async () => {
    const server = fakeBackend();
    server.remoteSave("p", single());
    server.remoteSave("q", single());
    const healthy = invokeMock.getMockImplementation()!;
    const held: Array<() => void> = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_coordinator_pane_layout") {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      return healthy(command, args);
    });
    const reads = (projectId: string) =>
      invokeMock.mock.calls.filter(
        ([command, args]) =>
          command === "get_coordinator_pane_layout" &&
          (args as Record<string, unknown>)?.projectId === projectId,
      ).length;
    const state = () => appCommandStore(coordinatorPaneLayoutStore).getState();

    const first = state().hydrate("p");
    await flushPromises();
    const second = state().hydrate("p");
    const retried = state().retry("p");
    requestResourceResync();
    const other = state().hydrate("q");
    await flushPromises();
    expect(reads("p")).toBe(1);
    expect(reads("q")).toBe(1);
    expect(selectCoordinatorPaneLayoutStatus("p")(state())).toBe("loading");

    for (const release of held.splice(0)) release();
    await Promise.all([first, second, retried, other]);
    await flushPromises();
    expect(selectCoordinatorPaneLayoutStatus("p")(state())).toBe("ready");
    expect(selectCoordinatorPaneLayoutStatus("q")(state())).toBe("ready");
    expect(selectCoordinatorPaneLayout("p")(state())).toEqual(server.records.get("p")!.layout);
    expect(server.saves).toEqual([]);

    // Once settled, the next mount reads again rather than reusing the old read.
    const again = state().hydrate("p");
    await flushPromises();
    for (const release of held.splice(0)) release();
    await again;
    expect(reads("p")).toBe(2);
  });

  test("a ready project stays ready when a later read fails, with no retries", async () => {
    const server = fakeBackend();
    server.remoteSave("p", single());
    const healthy = invokeMock.getMockImplementation()!;
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    const layout = selectCoordinatorPaneLayout("p")(
      appCommandStore(coordinatorPaneLayoutStore).getState(),
    );
    expect(layout).toEqual(server.records.get("p")!.layout);

    const retryTimers = captureRetryTimers();
    try {
      // A remount whose layout read fails.
      invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_coordinator_pane_layout") throw new Error("transport closed");
        return healthy(command, args);
      });
      await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
      // A remount after a reconnect, whose capability read fails.
      resetClientStateCapabilitiesForTests();
      invokeMock.mockImplementation(async () => {
        throw new Error("transport closed");
      });
      await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
      await flushPromises();

      const state = appCommandStore(coordinatorPaneLayoutStore).getState();
      expect(selectCoordinatorPaneLayoutStatus("p")(state)).toBe("ready");
      expect(selectCoordinatorPaneLayout("p")(state)).toBe(layout);
      expect(retryTimers.scheduled).toEqual([]);
      expect(server.saves).toEqual([]);
    } finally {
      retryTimers.restore();
    }
  });

  test("the periodic safety check recovers a project once its timed retries are spent", async () => {
    const server = fakeBackend();
    server.remoteSave("p", single());
    const healthy = invokeMock.getMockImplementation()!;
    const retryTimers = captureRetryTimers();
    try {
      invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_coordinator_pane_layout") throw new Error("transport closed");
        return healthy(command, args);
      });
      await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
      for (let index = 0; index < 5 && retryTimers.scheduled.length > index; index += 1) {
        retryTimers.run(index);
        await flushPromises();
      }
      expect(retryTimers.scheduled).toEqual([...COORDINATOR_LAYOUT_RETRY_DELAYS_MS]);
      expect(
        selectCoordinatorPaneLayoutStatus("p")(
          appCommandStore(coordinatorPaneLayoutStore).getState(),
        ),
      ).toBe("failed");

      invokeMock.mockImplementation(healthy);
      requestViewSafetyChecks("interval");
      await flushPromises();
      const state = appCommandStore(coordinatorPaneLayoutStore).getState();
      expect(selectCoordinatorPaneLayoutStatus("p")(state)).toBe("ready");
      expect(selectCoordinatorPaneLayout("p")(state)).toEqual(server.records.get("p")!.layout);
      expect(server.saves).toEqual([]);
      expect(retryTimers.scheduled).toHaveLength(COORDINATOR_LAYOUT_RETRY_DELAYS_MS.length);
    } finally {
      retryTimers.restore();
    }
  });
});

describe("against an older backend", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(false)));

  test("keeps isolated projects with group order, active tabs and split sizes in the browser copy", async () => {
    const first = single();
    let split = splitCoordinatorPaneAtEdge(
      first,
      first.activePaneId,
      "right",
      "side-1",
      first.activePaneId,
    );
    if (split.root.kind !== "split") throw new Error("expected split");
    split = resizeCoordinatorSplit(split, split.root.id, [65, 35]);
    split = reorderCoordinatorConversations(split, first.activePaneId, 1, 0);
    split = focusCoordinatorPane(split, first.activePaneId, "side-2");
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("first");
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("first", split);
    appCommandStore(coordinatorPaneLayoutStore).getState().setLayout("second", first);
    expect(invokeMock).not.toHaveBeenCalledWith("save_coordinator_pane_layout", expect.anything());

    appCommandStore(coordinatorPaneLayoutStore).getState().reset();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("first");
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("second");
    expect(
      selectCoordinatorPaneLayout("first")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(split);
    expect(
      selectCoordinatorPaneLayout("second")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(first);
  });

  test("sanitizes tabs, active IDs and sizes when reading the browser copy", async () => {
    const layout = single();
    if (layout.root.kind !== "leaf") throw new Error("expected leaf");
    seedBrowserCopy([
      {
        projectId: "p",
        updatedAt: "bad",
        layout: {
          ...layout,
          activePaneId: "missing",
          root: {
            ...layout.root,
            conversationIds: ["main", "main", 12, "", "x".repeat(201)],
            activeConversationId: "missing",
          },
        },
      },
    ]);
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("p");
    expect(
      selectCoordinatorPaneLayout("p")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual({
      activePaneId: layout.root.id,
      root: { ...layout.root, conversationIds: ["main"], activeConversationId: "main" },
    });
  });

  test("rejects malformed records, oversized IDs and trees and bounds tab counts", async () => {
    const layout = single();
    if (layout.root.kind !== "leaf") throw new Error("expected leaf");
    let deep: unknown = layout.root;
    for (let index = 0; index < 20; index += 1) {
      deep = {
        kind: "split",
        id: `split-${index}`,
        direction: "horizontal",
        children: [deep, { kind: "leaf", id: `leaf-${index}`, conversationIds: [] }],
      };
    }
    seedBrowserCopy([
      null,
      4,
      {},
      { projectId: 7, layout },
      { projectId: "", layout },
      { projectId: "x".repeat(201), layout },
      { projectId: "bad", layout: { root: { ...layout.root, id: "x".repeat(201) } } },
      { projectId: "deep", layout: { root: deep } },
      {
        projectId: "bounded",
        layout: {
          ...layout,
          root: {
            ...layout.root,
            conversationIds: Array.from({ length: 100 }, (_, index) => `tab-${index}`),
          },
        },
      },
    ]);
    for (const projectId of ["bad", "deep", "x".repeat(201), "bounded"]) {
      await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate(projectId);
    }
    expect(
      selectCoordinatorPaneLayout("bad")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBeUndefined();
    expect(
      selectCoordinatorPaneLayout("deep")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toBeUndefined();
    expect(
      selectCoordinatorPaneLayout("x".repeat(201))(
        appCommandStore(coordinatorPaneLayoutStore).getState(),
      ),
    ).toBeUndefined();
    const root = selectCoordinatorPaneLayout("bounded")(
      appCommandStore(coordinatorPaneLayoutStore).getState(),
    )!.root;
    expect(root.kind === "leaf" && root.conversationIds.length).toBe(64);
  });

  test("retains the latest projects in the browser copy and uses the latest duplicate", async () => {
    const layout = single();
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("seed");
    for (let index = 0; index < 55; index += 1)
      appCommandStore(coordinatorPaneLayoutStore).getState().setLayout(`p-${index}`, layout);
    const saved = JSON.parse(localStorage.getItem(key)!).state.layouts as Array<{
      projectId: string;
    }>;
    expect(saved).toHaveLength(MAX_REMEMBERED_COORDINATOR_LAYOUTS);
    expect(saved[0]!.projectId).toBe("p-5");

    const second = focusCoordinatorPane(layout, layout.activePaneId, "side-2");
    seedBrowserCopy([
      { projectId: "dup", layout },
      { projectId: "dup", layout: second },
    ]);
    await appCommandStore(coordinatorPaneLayoutStore).getState().hydrate("dup");
    expect(
      selectCoordinatorPaneLayout("dup")(appCommandStore(coordinatorPaneLayoutStore).getState()),
    ).toEqual(second);
  });
});
