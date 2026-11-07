import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../tests/helpers/controlled-timeout";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import {
  createNodeSnapshotStore,
  memorySnapshotBackend,
  type MemorySnapshotBackend,
  type NodeSnapshot,
  type NodeSnapshotStore,
} from "@/lib/node-scope/snapshot-store";
import { noteAuthoritativeRead, scopeSnapshotSync } from "@/lib/node-scope/snapshot-sync";
import { WindowScope } from "@/lib/node-scope/window-scope";
import type { PortalState } from "@/lib/portal/portal-store";
import { requestResourceResync, resetResourceSync } from "@/lib/resource-sync";
import { startStoreResourceSync, STORE_RESOURCE_HANDLERS } from "@/lib/store-resource-sync";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { AppConfig, Environment, Project } from "@/types";
import type { TabInfo } from "@/types/paneLayout";
import {
  captureNodeSnapshot,
  clearAllNodeSnapshots,
  clearNodeSnapshot,
  configureNodeSnapshots,
  hydrateScopeFromSnapshot,
  readNodeSnapshot,
  startNodeSnapshotWriter,
  startSnapshotRegistryWatch,
} from "./node-snapshots";

const LEAF = "bk_leaf" as BackendId;

const project: Project = {
  id: "project-1",
  name: "Checkout",
  gitUrl: "https://SECRET-TOKEN@github.com/acme/checkout.git",
  localPath: "/srv/checkout",
  addedAt: "2026-11-01T10:00:00.000Z",
  order: 0,
};

/** An environment record as the node answers it, prompt and all. */
const environment = {
  id: "env-1",
  projectId: project.id,
  name: "feature",
  branch: "feature/x",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-11-02T10:00:00.000Z",
  networkAccessMode: "full",
  order: 0,
  environmentType: "local",
  projectHome: false,
  initialPrompt: "SECRET-PROMPT build the thing",
  initialPromptAttachments: [{ type: "image", base64Data: "SECRET-ATTACHMENT" }],
  worktreePath: "/srv/worktrees/SECRET-PATH",
  setupSessionId: "SECRET-SETUP",
  agentSettings: { defaultAgent: "claude" },
} as unknown as Environment;

let windows: WindowScope[];
let backend: MemorySnapshotBackend;
let store: NodeSnapshotStore;
let restore: () => void;
const timers: ControlledTimeout[] = [];

function openLeaf(nodeId: BackendId = LEAF, invoke: Record<string, unknown> = {}) {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const client = new FakeNodeClient({ nodeId, invoke });
  return { scope: windowScope.open({ role: "leaf", client }), client };
}

/** The node's lists as an authoritative read leaves them. */
function loadAuthoritative(scope: NodeScope) {
  scope.store(projectStore).getState().setProjects([project]);
  scope.store(environmentStore).getState().setEnvironments([environment]);
  noteAuthoritativeRead(scope, "environment");
  const config = createDefaultAppConfig() as AppConfig;
  config.global.reviewInstruction = "SECRET-INSTRUCTION review carefully";
  config.repositories[project.id] = { defaultBranch: "main", prBaseBranch: "develop" };
  scope.store(configStore).getState().setConfig(config);
  scope.store(uiStore).setState({ selectedProjectId: project.id, selectedEnvironmentId: "env-1" });
  scope.store(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [
              {
                id: "tab-1",
                type: "native-agent",
                initialPrompt: "SECRET-TAB-PROMPT",
                fileData: { path: "a.ts", content: "SECRET-FILE" },
              } as unknown as TabInfo,
            ],
            activeTabId: "tab-1",
          },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  windows = [];
  backend = memorySnapshotBackend();
  store = createNodeSnapshotStore(backend);
  restore = configureNodeSnapshots(store);
});

afterEach(() => {
  for (const timer of timers.splice(0)) timer.restore();
  restore();
  for (const windowScope of windows.splice(0)) windowScope.dispose();
});

describe("capture: list metadata only (invariant 12)", () => {
  test("a captured and stored snapshot carries no prompt, file, terminal or credential", async () => {
    const { scope } = openLeaf();
    loadAuthoritative(scope);
    const snapshot = captureNodeSnapshot(scope, 5_000);
    await store.write(snapshot);
    const body = backend.bodies.get(LEAF)!;
    expect(body).not.toContain("SECRET");
    expect(snapshot.projects[0]?.gitUrl).toBe("https://github.com/acme/checkout.git");
    expect(snapshot.environments[0]).toEqual({
      id: "env-1",
      projectId: project.id,
      name: "feature",
      branch: "feature/x",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: "2026-11-02T10:00:00.000Z",
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      projectHome: false,
    });
    expect(snapshot.paneLayouts).toEqual([
      { environmentId: "env-1", activePaneId: "pane-1", activeTabId: "tab-1", tabIds: ["tab-1"] },
    ]);
    expect(snapshot.config?.repositories).toEqual([
      { projectId: project.id, defaultBranch: "main", prBaseBranch: "develop" },
    ]);
    expect(snapshot.selection).toEqual({ projectId: project.id, environmentId: "env-1" });
  });

  test("a config the node has not answered yet is not captured", () => {
    const { scope } = openLeaf();
    expect(captureNodeSnapshot(scope).config).toBeNull();
  });
});

function savedSnapshot(nodeId: BackendId = LEAF): NodeSnapshot {
  const { scope } = openLeaf(nodeId);
  loadAuthoritative(scope);
  return captureNodeSnapshot(scope, 9_000);
}

describe("hydration", () => {
  test("fills a new scope's empty stores without claiming they loaded, and marks it resyncing", () => {
    const snapshot = savedSnapshot();
    const { scope } = openLeaf();
    expect(hydrateScopeFromSnapshot(scope, snapshot)).toBe(true);
    const projects = scope.store(projectStore).getState();
    expect(projects.projects.map((p) => p.name)).toEqual(["Checkout"]);
    expect(projects.hasLoaded).toBe(false);
    expect(
      scope
        .store(environmentStore)
        .getState()
        .environments.map((e) => e.id),
    ).toEqual(["env-1"]);
    const config = scope.store(configStore).getState();
    expect(config.hasLoaded).toBe(false);
    expect(config.config.repositories[project.id]?.prBaseBranch).toBe("develop");
    // The pane layout is the node's; only the preview reads its ids.
    expect(scope.store(paneLayoutStore).getState().environments.size).toBe(0);
    expect(scopeSnapshotSync(scope).get()).toEqual({
      state: "resyncing",
      savedAt: 9_000,
      pending: ["project", "environment", "config"],
    });
  });

  test("authoritative data wins: a scope whose projects arrived is not hydrated", () => {
    const snapshot = savedSnapshot();
    const { scope } = openLeaf();
    scope.store(projectStore).getState().setProjects([]);
    expect(hydrateScopeFromSnapshot(scope, snapshot)).toBe(false);
    expect(scopeSnapshotSync(scope).get().state).toBe("live");
  });

  test("another node's snapshot is never hydrated", () => {
    const snapshot = savedSnapshot("bk_other" as BackendId);
    const { scope } = openLeaf();
    expect(hydrateScopeFromSnapshot(scope, snapshot)).toBe(false);
    expect(scope.store(projectStore).getState().projects).toEqual([]);
  });

  test("stale marker then live: the scope's own resync replaces the snapshot", async () => {
    const snapshot = savedSnapshot();
    let answerProjects!: (projects: Project[]) => void;
    const { scope } = openLeaf();
    hydrateScopeFromSnapshot(scope, snapshot);
    const renamed = { ...project, name: "Checkout (renamed)" };
    const stop = startStoreResourceSync(
      {
        getProjects: () =>
          new Promise<Project[]>((resolve) => {
            answerProjects = resolve;
          }),
        getEnvironmentSnapshots: async () => [{ ...environment, name: "feature (now)" }],
        getConfig: async () => createDefaultAppConfig() as AppConfig,
      },
      {
        scope,
        handlers: STORE_RESOURCE_HANDLERS.filter((entry) =>
          ["projects", "environments", "config"].includes(entry.name),
        ),
      },
    );
    try {
      requestResourceResync(scope);
      await flush();
      // The read is out; the snapshot is still what the scope shows.
      expect(scope.store(projectStore).getState().projects[0]?.name).toBe("Checkout");
      expect(scopeSnapshotSync(scope).get().state).toBe("resyncing");
      answerProjects([renamed]);
      await flush();
      await flush();
      expect(scope.store(projectStore).getState().projects[0]?.name).toBe("Checkout (renamed)");
      expect(scope.store(environmentStore).getState().environments[0]?.name).toBe("feature (now)");
      expect(scopeSnapshotSync(scope).get()).toEqual({ state: "live" });
    } finally {
      stop();
      resetResourceSync(scope);
    }
  });
});

describe("the writer", () => {
  const FIRST = 7;
  const EVERY = 11;

  function controlled() {
    const first = installControlledTimeout(FIRST, { label: "snapshot first write" });
    const every = installControlledTimeout(EVERY, { label: "snapshot interval" });
    timers.push(first, every);
    return { first, every };
  }

  test("writes only once the scope holds authoritative lists, then only when they change", async () => {
    const { first, every } = controlled();
    const { scope } = openLeaf();
    const stop = startNodeSnapshotWriter(scope, store, { firstWriteMs: FIRST, intervalMs: EVERY });
    first.advance();
    await flush();
    expect(backend.bodies.size).toBe(0);

    loadAuthoritative(scope);
    every.advance();
    await flush();
    expect(JSON.parse(backend.bodies.get(LEAF)!).projects[0].name).toBe("Checkout");

    const before = backend.bodies.get(LEAF);
    every.advance();
    await flush();
    expect(backend.bodies.get(LEAF)).toBe(before);

    // A clear makes the next tick write it again.
    await clearNodeSnapshot(LEAF);
    expect(backend.bodies.size).toBe(0);
    every.advance();
    await flush();
    expect(backend.bodies.has(LEAF)).toBe(true);

    stop();
    expect(every.pendingCount()).toBe(0);
  });

  test("a hydrated scope writes nothing while resyncing, and writes as soon as it is live", async () => {
    const { first } = controlled();
    const snapshot = savedSnapshot();
    const { scope } = openLeaf();
    hydrateScopeFromSnapshot(scope, snapshot);
    const stop = startNodeSnapshotWriter(scope, store, { firstWriteMs: FIRST, intervalMs: EVERY });
    first.advance();
    await flush();
    expect(backend.bodies.size).toBe(0);
    loadAuthoritative(scope);
    await flush();
    expect(scopeSnapshotSync(scope).get().state).toBe("live");
    expect(backend.bodies.has(LEAF)).toBe(true);
    stop();
  });

  test("stopping writes once more and clears its timers", async () => {
    const { first } = controlled();
    const { scope } = openLeaf();
    loadAuthoritative(scope);
    const stop = startNodeSnapshotWriter(scope, store, { firstWriteMs: FIRST, intervalMs: EVERY });
    stop();
    await flush();
    expect(backend.bodies.has(LEAF)).toBe(true);
    expect(first.pendingCount()).toBe(0);
  });
});

describe("clearing", () => {
  test("sign-out (a whole-window protected clear) drops every node's snapshot", async () => {
    await store.write(savedSnapshot());
    await store.write(savedSnapshot("bk_other" as BackendId));
    clearProtectedRichContent("logout");
    await flush();
    expect(await store.entries()).toEqual([]);
  });

  test("a node's credential or identity change drops only that node's", async () => {
    await store.write(savedSnapshot());
    await store.write(savedSnapshot("bk_other" as BackendId));
    clearProtectedRichContent("credentials", { nodeId: "bk_other" });
    await flush();
    expect((await store.entries()).map((entry) => entry.nodeId)).toEqual([LEAF]);
  });

  test("clearAll records the request first and removes the record once done", async () => {
    await store.write(savedSnapshot());
    const pending = clearAllNodeSnapshots();
    expect(localStorage.getItem("orkestrator-node-snapshots-clear-pending")).toBe("1");
    await pending;
    expect(localStorage.getItem("orkestrator-node-snapshots-clear-pending")).toBeNull();
    expect(await store.entries()).toEqual([]);
  });

  test("a node removed from the registry loses its snapshot; an unloaded registry prunes nothing", async () => {
    await store.write(savedSnapshot());
    await store.write(savedSnapshot("bk_other" as BackendId));
    let state = {
      loaded: false,
      unsupported: false,
      selfId: null,
      nodes: [],
    } as unknown as PortalState;
    const listeners = new Set<(next: PortalState) => void>();
    const source = {
      getState: () => state,
      subscribe(listener: (next: PortalState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const stop = startSnapshotRegistryWatch(store, source);
    await flush();
    expect(await store.entries()).toHaveLength(2);

    state = { ...state, loaded: true, nodes: [{ nodeId: LEAF }] } as unknown as PortalState;
    for (const listener of listeners) listener(state);
    await flush();
    expect((await store.entries()).map((entry) => entry.nodeId)).toEqual([LEAF]);
    stop();
    expect(listeners.size).toBe(0);
  });
});

test("a snapshot read that does not answer gives up within its budget", async () => {
  const timer = installControlledTimeout(25, { label: "snapshot read budget" });
  timers.push(timer);
  const stuck = {
    ...store,
    read: () => new Promise<NodeSnapshot | null>(() => undefined),
  } as NodeSnapshotStore;
  const read = readNodeSnapshot(LEAF, 25, stuck);
  expect(timer.advance()).toBe(1);
  expect(await read).toBeNull();
});
