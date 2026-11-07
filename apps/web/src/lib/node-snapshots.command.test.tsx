/**
 * Plan item 4003, the command scope's box: the window's own node writes its
 * snapshot under its proven id, remembers that id, and the next start paints
 * from it before the first authoritative read. A first-ever start, a window
 * without IndexedDB, and a read that has not answered by the time the
 * services start change nothing; a browser window whose hello proves another
 * command node than the remembered one takes the snapshot's data back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";
import type { BackendId } from "@orkestrator/protocol/federation";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../tests/helpers/controlled-timeout";
import { ScopeSnapshotGate } from "@/components/federation/ScopeSnapshotGate";
import { COMMAND_SCOPE_PROVISIONAL_NODE_ID } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { createSignal } from "@/lib/node-scope/signal";
import {
  createNodeSnapshotStore,
  memorySnapshotBackend,
  type MemorySnapshotBackend,
  type NodeSnapshot,
  type NodeSnapshotStore,
} from "@/lib/node-scope/snapshot-store";
import {
  noteAuthoritativeRead,
  scopeMutationGate,
  scopeSnapshotSync,
  ScopeResyncingError,
} from "@/lib/node-scope/snapshot-sync";
import { WindowScope } from "@/lib/node-scope/window-scope";
import type { PortalState } from "@/lib/portal/portal-store";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { clientEnvironmentFixture } from "@/test/environments-results";
import type { AppConfig, Environment, Project } from "@/types";
import {
  captureNodeSnapshot,
  configureNodeSnapshots,
  hydrateCommandScopeFromSnapshot,
  hydratedScopeSnapshot,
  primeCommandScopeSnapshot,
  rememberCommandNodeId,
  rememberedCommandNodeId,
  resetCommandScopeSnapshotForTests,
  startCommandScopeSnapshot,
} from "./node-snapshots";
import { expectDomAbsent } from "../../../../tests/bounded-test-diagnostics";

const COMMAND = "bk_command" as BackendId;
const OTHER = "bk_other_command" as BackendId;
const REMEMBERED_KEY = "orkestrator-command-node-snapshot-id";

const project: Project = {
  id: "project-1",
  name: "Checkout",
  gitUrl: "git@github.com:acme/checkout.git",
  localPath: "/srv/checkout",
  addedAt: "2026-11-01T10:00:00.000Z",
  order: 0,
};
const environment = clientEnvironmentFixture({
  id: "env-1",
  projectId: project.id,
  name: "feature-login",
  branch: "feature/login",
  status: "running",
  environmentType: "local",
}) as Environment;

let windows: WindowScope[];
let backend: MemorySnapshotBackend;
let store: NodeSnapshotStore;
let restore: () => void;
const timers: ControlledTimeout[] = [];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The node's lists as an authoritative read leaves them. */
function loadAuthoritative(scope: NodeScope) {
  scope.store(projectStore).getState().setProjects([project]);
  scope.store(environmentStore).getState().setEnvironments([environment]);
  noteAuthoritativeRead(scope, "environment");
  scope
    .store(configStore)
    .getState()
    .setConfig(createDefaultAppConfig() as AppConfig);
}

/**
 * The window's command scope. `proven` gives its client the hello's proven id
 * signal, as the window client has; the scope opens under `nodeId`.
 */
function openCommand(
  nodeId: BackendId,
  proven?: ReturnType<typeof createSignal<BackendId | null>>,
) {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const client = new FakeNodeClient({ nodeId });
  if (proven) Object.assign(client, { provenNodeId: proven });
  return { windowScope, scope: windowScope.open({ role: "command", client }) };
}

/** `nodeId`'s snapshot as a previous run of this window left it. */
async function storedSnapshot(nodeId: BackendId = COMMAND): Promise<NodeSnapshot> {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const scope = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId }) });
  loadAuthoritative(scope);
  const snapshot = captureNodeSnapshot(scope, 9_000);
  await store.write(snapshot);
  return snapshot;
}

function projectNames(scope: NodeScope) {
  return scope
    .store(projectStore)
    .getState()
    .projects.map((entry) => entry.name);
}

beforeEach(() => {
  windows = [];
  backend = memorySnapshotBackend();
  store = createNodeSnapshotStore(backend);
  restore = configureNodeSnapshots(store);
  resetCommandScopeSnapshotForTests();
  localStorage.removeItem(REMEMBERED_KEY);
});

afterEach(() => {
  cleanup();
  for (const timer of timers.splice(0)) timer.restore();
  resetCommandScopeSnapshotForTests();
  localStorage.removeItem(REMEMBERED_KEY);
  restore();
  for (const windowScope of windows.splice(0)) windowScope.dispose();
});

describe("nothing changes without a snapshot to paint", () => {
  test("a first-ever start: no proven id, none remembered, no read and no hydration", async () => {
    await storedSnapshot();
    const { scope } = openCommand(COMMAND_SCOPE_PROVISIONAL_NODE_ID);
    primeCommandScopeSnapshot(COMMAND_SCOPE_PROVISIONAL_NODE_ID);
    await flush();
    expect(hydrateCommandScopeFromSnapshot(scope)).toBe(false);
    expect(projectNames(scope)).toEqual([]);
    expect(scopeSnapshotSync(scope).get()).toEqual({ state: "live" });
    expect(scopeMutationGate(scope)).toBeNull();
  });

  test("a proven id with no snapshot yet, and a window without IndexedDB", async () => {
    const first = openCommand(COMMAND).scope;
    primeCommandScopeSnapshot(COMMAND);
    await flush();
    expect(hydrateCommandScopeFromSnapshot(first)).toBe(false);
    expect(scopeSnapshotSync(first).get().state).toBe("live");

    await storedSnapshot();
    const withoutStore = configureNodeSnapshots(null);
    try {
      const second = openCommand(COMMAND).scope;
      primeCommandScopeSnapshot(COMMAND);
      await flush();
      expect(hydrateCommandScopeFromSnapshot(second)).toBe(false);
      expect(projectNames(second)).toEqual([]);
    } finally {
      withoutStore();
    }
  });

  test("a read still out when the services start is not used later", async () => {
    await storedSnapshot();
    let answer!: () => void;
    const slow = {
      ...store,
      read: (nodeId: string) =>
        new Promise<NodeSnapshot | null>((resolve) => {
          answer = () => void store.read(nodeId).then(resolve);
        }),
    } as NodeSnapshotStore;
    const withSlow = configureNodeSnapshots(slow);
    try {
      const { scope } = openCommand(COMMAND);
      primeCommandScopeSnapshot(COMMAND);
      expect(hydrateCommandScopeFromSnapshot(scope)).toBe(false);
      answer();
      await flush();
      await flush();
      expect(hydrateCommandScopeFromSnapshot(scope)).toBe(false);
      expect(projectNames(scope)).toEqual([]);
    } finally {
      withSlow();
    }
  });
});

describe("snapshot-first paint of the command node after a restart", () => {
  test("the page's proven id: hydrated before any read, stale until live, mutations wait", async () => {
    await storedSnapshot();
    const { scope } = openCommand(COMMAND);
    primeCommandScopeSnapshot(COMMAND);
    await flush();
    expect(hydrateCommandScopeFromSnapshot(scope)).toBe(true);
    expect(projectNames(scope)).toEqual(["Checkout"]);
    expect(scope.store(projectStore).getState().hasLoaded).toBe(false);
    expect(scopeSnapshotSync(scope).get()).toMatchObject({ state: "resyncing", savedAt: 9_000 });
    expect(hydratedScopeSnapshot(scope)?.nodeId).toBe(COMMAND);
    const gate = scopeMutationGate(scope);
    expect(gate).not.toBeNull();

    loadAuthoritative(scope);
    await gate;
    expect(scopeSnapshotSync(scope).get()).toEqual({ state: "live" });
    expect(hydratedScopeSnapshot(scope)).toBeNull();
    expect(scopeMutationGate(scope)).toBeNull();
  });

  test("a browser window: hydrated for the remembered id while provisional; the same proof keeps it", async () => {
    await storedSnapshot();
    rememberCommandNodeId(COMMAND);
    const proven = createSignal<BackendId | null>(null);
    const { windowScope, scope } = openCommand(COMMAND_SCOPE_PROVISIONAL_NODE_ID, proven);
    primeCommandScopeSnapshot(COMMAND_SCOPE_PROVISIONAL_NODE_ID);
    await flush();
    expect(hydrateCommandScopeFromSnapshot(scope)).toBe(true);
    expect(projectNames(scope)).toEqual(["Checkout"]);

    windowScope.adoptCommandNodeId(COMMAND);
    proven.set(COMMAND);
    expect(scope.nodeId).toBe(COMMAND);
    expect(projectNames(scope)).toEqual(["Checkout"]);
    expect(scopeSnapshotSync(scope).get().state).toBe("resyncing");
  });

  test("another proven command node discards the remembered snapshot and refuses what waited on it", async () => {
    await storedSnapshot();
    rememberCommandNodeId(COMMAND);
    const proven = createSignal<BackendId | null>(null);
    const { windowScope, scope } = openCommand(COMMAND_SCOPE_PROVISIONAL_NODE_ID, proven);
    const before = scope.store(configStore).getState().config;
    primeCommandScopeSnapshot(COMMAND_SCOPE_PROVISIONAL_NODE_ID);
    await flush();
    expect(hydrateCommandScopeFromSnapshot(scope)).toBe(true);
    const waiting = scopeMutationGate(scope)!.then(
      () => null,
      (error: unknown) => error,
    );

    windowScope.adoptCommandNodeId(OTHER);
    proven.set(OTHER);
    const refused = await waiting;
    expect(refused).toBeInstanceOf(ScopeResyncingError);
    expect((refused as ScopeResyncingError).reason).toBe("discarded");
    expect(projectNames(scope)).toEqual([]);
    expect(scope.store(environmentStore).getState().environments).toEqual([]);
    expect(scope.store(configStore).getState().config).toBe(before);
    expect(scopeSnapshotSync(scope).get()).toEqual({ state: "live" });
    expect(hydratedScopeSnapshot(scope)).toBeNull();
  });

  test("the main area shows the snapshot read-only until live, then the workspace", async () => {
    await storedSnapshot();
    const { windowScope, scope } = openCommand(COMMAND);
    primeCommandScopeSnapshot(COMMAND);
    await flush();
    hydrateCommandScopeFromSnapshot(scope);
    render(
      <WindowScopeProvider windowScope={windowScope}>
        <NodeScopeProvider scope={scope}>
          <ScopeSnapshotGate machine="This machine">
            <p>workspace</p>
          </ScopeSnapshotGate>
        </NodeScopeProvider>
      </WindowScopeProvider>,
    );
    expect(screen.getByTestId("node-snapshot-preview").textContent).toContain("Checkout");
    expect(screen.getByTestId("snapshot-stale-marker")).toBeTruthy();
    expectDomAbsent(screen.queryByText("workspace"));
    act(() => loadAuthoritative(scope));
    expect(screen.getByText("workspace")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("node-snapshot-preview"));
  });

  test("a scope never hydrated renders its workspace unchanged", () => {
    const { windowScope, scope } = openCommand(COMMAND);
    render(
      <WindowScopeProvider windowScope={windowScope}>
        <NodeScopeProvider scope={scope}>
          <ScopeSnapshotGate machine="This machine">
            <p>workspace</p>
          </ScopeSnapshotGate>
        </NodeScopeProvider>
      </WindowScopeProvider>,
    );
    expect(screen.getByText("workspace")).toBeTruthy();
  });
});

describe("the command scope's writer", () => {
  const FIRST = 7;
  const EVERY = 11;
  const unloaded = {
    getState: () => ({ loaded: false }) as PortalState,
    subscribe: () => () => undefined,
  };

  test("writes under the proven id only, and remembers that id for the next start", async () => {
    const first = installControlledTimeout(FIRST, { label: "snapshot first write" });
    const every = installControlledTimeout(EVERY, { label: "snapshot interval" });
    timers.push(first, every);
    const proven = createSignal<BackendId | null>(null);
    const { windowScope, scope } = openCommand(COMMAND_SCOPE_PROVISIONAL_NODE_ID, proven);
    const stop = startCommandScopeSnapshot(scope, store, {
      firstWriteMs: FIRST,
      intervalMs: EVERY,
      registry: unloaded,
    });
    try {
      loadAuthoritative(scope);
      first.advance();
      await flush();
      expect(backend.bodies.size).toBe(0);
      expect(rememberedCommandNodeId()).toBeNull();

      windowScope.adoptCommandNodeId(COMMAND);
      proven.set(COMMAND);
      expect(rememberedCommandNodeId()).toBe(COMMAND);
      every.advance();
      await flush();
      expect(JSON.parse(backend.bodies.get(COMMAND)!).projects[0].name).toBe("Checkout");
    } finally {
      stop();
    }
    expect(every.pendingCount()).toBe(0);
  });

  test("a scope opened under a proven id is remembered at once", () => {
    const { scope } = openCommand(COMMAND);
    const stop = startCommandScopeSnapshot(scope, store, { registry: unloaded });
    try {
      expect(rememberedCommandNodeId()).toBe(COMMAND);
    } finally {
      stop();
    }
  });
});
