import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import type {
  CoordinatorPaneLayout,
  CoordinatorPaneLayoutRecord,
} from "@orkestrator/protocol/coordinator-pane-layout";
import {
  LEGACY_COORDINATOR_LAYOUT_KEY,
  MAX_REMEMBERED_COORDINATOR_LAYOUTS,
  selectCoordinatorPaneLayout,
  selectCoordinatorPaneLayoutReady,
  useCoordinatorPaneLayoutStore as store,
} from "./coordinatorPaneLayoutStore";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import {
  focusCoordinatorPane,
  reconcileCoordinatorLayout,
  reorderCoordinatorConversations,
  resizeCoordinatorSplit,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { dispatchResourceChange, requestResourceResync } from "@/lib/resource-sync";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const key = LEGACY_COORDINATOR_LAYOUT_KEY;
const single = () => reconcileCoordinatorLayout(null, ["main", "side-1", "side-2"]);

const capabilities = (coordinatorPaneLayouts: boolean): ClientStateCapabilities => ({
  coordinatorPaneLayouts,
  coordinatorUpstreamMerge: false,
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
  store.getState().reset();
});

afterEach(() => {
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
    expect(selectCoordinatorPaneLayoutReady("p")(store.getState())).toBe(false);
    await store.getState().hydrate("p");
    expect(selectCoordinatorPaneLayoutReady("p")(store.getState())).toBe(true);
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(layout);
  });

  test("saves changes in order, each against the revision the last one returned", async () => {
    const server = fakeBackend();
    await store.getState().hydrate("p");
    const first = single();
    const second = focusCoordinatorPane(first, first.activePaneId, "side-2");
    store.getState().setLayout("p", first);
    store.getState().setLayout("p", second);
    await flushPromises();
    expect(server.saves.map((save) => save.expectedRevision)).toEqual([0, 1]);
    expect(server.records.get("p")?.layout).toEqual(second);
    expect(localStorage.getItem(key)).toBeNull();
  });

  test("identical layouts are a state and save no-op", async () => {
    const server = fakeBackend();
    await store.getState().hydrate("p");
    const layout = single();
    store.getState().setLayout("p", layout);
    await flushPromises();
    const state = store.getState();
    store.getState().setLayout("p", layout);
    await flushPromises();
    expect(store.getState()).toBe(state);
    expect(server.saves).toHaveLength(1);
  });

  test("another client's save wins a conflict and its layout is adopted", async () => {
    const server = fakeBackend();
    await store.getState().hydrate("p");
    const remote = focusCoordinatorPane(single(), "x", "side-1");
    server.remoteSave("p", remote);
    store.getState().setLayout("p", single());
    await flushPromises();
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(remote);
    // The next local change builds on the revision it adopted.
    const next = single();
    store.getState().setLayout("p", next);
    await flushPromises();
    expect(server.records.get("p")).toMatchObject({ revision: 2, layout: next });
  });

  test("a change hint refreshes the project; a stale answer cannot roll it back", async () => {
    const server = fakeBackend();
    await store.getState().hydrate("p");
    const remote = single();
    server.remoteSave("p", remote);
    dispatchResourceChange({
      resource: "coordinator-pane-layout",
      id: "p",
      projectId: "p",
      revision: 1,
    });
    await hintDelivered();
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(remote);

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
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(newer);

    // An answer older than the revision already held does not replace it.
    server.records.set("p", { ...server.records.get("p")!, layout: single(), revision: 3 });
    hint(3);
    await hintDelivered();
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(newer);
  });

  test("this client's own save announced back keeps the same layout object", async () => {
    fakeBackend();
    await store.getState().hydrate("p");
    const layout = single();
    store.getState().setLayout("p", layout);
    await flushPromises();
    dispatchResourceChange({
      resource: "coordinator-pane-layout",
      id: "p",
      projectId: "p",
      revision: 1,
    });
    await hintDelivered();
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toBe(layout);
  });

  test("a change the connection dropped is sent by the next resync", async () => {
    const server = fakeBackend();
    await store.getState().hydrate("p");
    server.failSavesWith(new Error("transport closed"));
    const layout = single();
    store.getState().setLayout("p", layout);
    await flushPromises();
    expect(server.records.has("p")).toBe(false);
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toBe(layout);

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
    await store.getState().hydrate("p");
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(browser);
    expect(server.records.get("other-client")?.layout).toEqual(stored);
    expect(localStorage.getItem(key)).toBeNull();

    const saves = server.saves.length;
    await store.getState().hydrate("p");
    expect(server.saves).toHaveLength(saves);
  });

  test("keeps the browser copy for another session when an import save fails", async () => {
    const server = fakeBackend();
    seedBrowserCopy([{ projectId: "p", layout: single(), updatedAt: 1 }]);
    server.failSavesWith(new Error("transport closed"));
    await store.getState().hydrate("p");
    expect(selectCoordinatorPaneLayoutReady("p")(store.getState())).toBe(true);
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
    await store.getState().hydrate("p");
    store.getState().setLayout("p", edited);

    resetClientStateCapabilitiesForTests(capabilities(true));
    invokeMock.mockImplementation(healthy);
    await store.getState().hydrate("p");
    await flushPromises();

    expect(server.records.get("p")?.layout).toEqual(edited);
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual(edited);
  });

  test("a failed read still lets the page render", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("transport closed");
    });
    await store.getState().hydrate("p");
    expect(selectCoordinatorPaneLayoutReady("p")(store.getState())).toBe(true);
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toBeUndefined();
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
    await store.getState().hydrate("first");
    store.getState().setLayout("first", split);
    store.getState().setLayout("second", first);
    expect(invokeMock).not.toHaveBeenCalledWith("save_coordinator_pane_layout", expect.anything());

    store.getState().reset();
    await store.getState().hydrate("first");
    await store.getState().hydrate("second");
    expect(selectCoordinatorPaneLayout("first")(store.getState())).toEqual(split);
    expect(selectCoordinatorPaneLayout("second")(store.getState())).toEqual(first);
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
    await store.getState().hydrate("p");
    expect(selectCoordinatorPaneLayout("p")(store.getState())).toEqual({
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
      await store.getState().hydrate(projectId);
    }
    expect(selectCoordinatorPaneLayout("bad")(store.getState())).toBeUndefined();
    expect(selectCoordinatorPaneLayout("deep")(store.getState())).toBeUndefined();
    expect(selectCoordinatorPaneLayout("x".repeat(201))(store.getState())).toBeUndefined();
    const root = selectCoordinatorPaneLayout("bounded")(store.getState())!.root;
    expect(root.kind === "leaf" && root.conversationIds.length).toBe(64);
  });

  test("retains the latest projects in the browser copy and uses the latest duplicate", async () => {
    const layout = single();
    await store.getState().hydrate("seed");
    for (let index = 0; index < 55; index += 1) store.getState().setLayout(`p-${index}`, layout);
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
    await store.getState().hydrate("dup");
    expect(selectCoordinatorPaneLayout("dup")(store.getState())).toEqual(second);
  });
});
