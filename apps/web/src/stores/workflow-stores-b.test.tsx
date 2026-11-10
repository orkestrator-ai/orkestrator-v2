/**
 * Plan item 3012: the design, web annotation, GitHub, pull request, change
 * projection, file dirty and preview service stores keep one instance per
 * node scope.
 *
 * For each store: two scopes keep independent state, the hook reads the
 * rendered scope's instance, and the hook carries no command-scope statics. Then, per store with backend work, a leaf scope's reads and
 * subscriptions go to that leaf's client and land in that leaf's instance.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { previewServicesChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import { CHANGE_PROJECTION_CHANGED_EVENT } from "@orkestrator/protocol/change-resources";
import {
  FIXTURE_ENVIRONMENT_ID,
  fixturePreviewCapabilities,
  fixturePreviewSnapshot,
} from "@orkestrator/protocol/testing/preview-contract-fixtures";
import type { StoreApi } from "zustand/vanilla";
import { environmentProjectionFixture } from "@/components/files-panel/change-projection-test-fixture";
import { subscribeChangeResource } from "@/lib/changes/subscriptions";
import { loadFileDraft, persistFileDraft } from "@/lib/file-draft-persistence";
import { acquireWebAnnotationSync } from "@/lib/web-annotations/sync";
import { fixtureCapabilities } from "@/test/web-annotation-fakes";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { ScopedStoreDef } from "@/lib/node-scope/scoped-store";
import type { ScopedStoreHook } from "@/lib/node-scope/scoped-store";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { designController } from "@/components/design/design-controller";
import { changeProjectionStore, useChangeProjectionStore } from "./changeProjectionStore";
import { designStore, emptyProjection, useDesignStore } from "./designStore";
import { fileDirtyStore, useFileDirtyStore } from "./fileDirtyStore";
import { githubIssuesStore, useGitHubIssuesStore } from "./githubIssuesStore";
import {
  ensurePreviewServiceSync,
  previewServiceStore,
  usePreviewServiceStore,
} from "./previewServiceStore";
import { pullRequestsStore, usePullRequestsStore } from "./pullRequestsStore";
import {
  emptyWebAnnotationCache,
  useWebAnnotationStore,
  webAnnotationStore,
} from "./webAnnotationStore";
import {
  rememberedDestinationTabId,
  useWebAnnotationPreferencesStore,
  webAnnotationPreferencesStore,
} from "./webAnnotationPreferencesStore";
import * as barrel from "./index";

const NODE_A = "bk_workflow-b-a" as BackendId;
const NODE_B = "bk_workflow-b-b" as BackendId;

interface Case<S> {
  def: ScopedStoreDef<S>;
  hook: ScopedStoreHook<S>;
  /** Changes the state through the store's own action (or a plain write). */
  write(store: StoreApi<S>): void;
  /** A string that differs once `write` ran. */
  read(state: S): string;
}

function scopedCase<S>(entry: Case<S>): Case<unknown> {
  return entry as unknown as Case<unknown>;
}

const CASES: ReadonlyArray<Case<unknown>> = [
  scopedCase({
    def: designStore,
    hook: useDesignStore,
    write: (store) =>
      store.getState().put(emptyProjection("local|env-1|canvas-1", "env-1", "canvas-1")),
    read: (state) => String(state.projections.size),
  }),
  scopedCase({
    def: fileDirtyStore,
    hook: useFileDirtyStore,
    write: (store) => store.getState().setContent("tab-1", "edited"),
    read: (state) => state.getContent("tab-1") ?? "none",
  }),
  scopedCase({
    def: githubIssuesStore,
    hook: useGitHubIssuesStore,
    write: (store) => store.setState({ projectErrors: new Map([["project-1", "Could not load"]]) }),
    read: (state) => state.projectErrors.get("project-1") ?? "none",
  }),
  scopedCase({
    def: pullRequestsStore,
    hook: usePullRequestsStore,
    write: (store) => store.setState({ errors: new Map([["detail:acme/widget#1", "failed"]]) }),
    read: (state) => state.errors.get("detail:acme/widget#1") ?? "none",
  }),
  scopedCase({
    def: changeProjectionStore,
    hook: useChangeProjectionStore,
    write: (store) => store.getState().resync(),
    read: (state) => String(state.transportRevision),
  }),
  scopedCase({
    def: previewServiceStore,
    hook: usePreviewServiceStore,
    write: (store) => store.setState({ status: "error" }),
    read: (state) => state.status,
  }),
  scopedCase({
    def: webAnnotationStore,
    hook: useWebAnnotationStore,
    write: (store) => store.getState().update("env-1", () => ({ revision: 7 })),
    read: (state) => String(state.environments.get("env-1")?.revision ?? "none"),
  }),
  scopedCase({
    def: webAnnotationPreferencesStore,
    hook: useWebAnnotationPreferencesStore,
    write: (store) => store.getState().rememberDestination("env-1", "tab-1"),
    read: (state) => state.destinations.map((entry) => entry.tabId).join(",") || "none",
  }),
];

let windowScope: WindowScope | null = null;

afterEach(() => {
  cleanupNodeScopes();
  windowScope?.dispose();
  windowScope = null;
  resetWindowScopeForTests();
  window.localStorage.clear();
});

function twoScopes(clients: { a?: FakeNodeClient; b?: FakeNodeClient } = {}) {
  windowScope = new WindowScope();
  const a = windowScope.open({
    role: "command",
    client: clients.a ?? new FakeNodeClient({ nodeId: NODE_A }),
  });
  const b = windowScope.open({
    role: "leaf",
    client: clients.b ?? new FakeNodeClient({ nodeId: NODE_B }),
  });
  return { a, b };
}

describe.each(CASES.map((entry) => [entry.def.name, entry] as const))("%s", (_name, entry) => {
  test("each node scope holds its own instance", () => {
    const { a, b } = twoScopes();
    const storeA = a.store(entry.def);
    const storeB = b.store(entry.def);
    expect(storeA).not.toBe(storeB);
    const before = entry.read(storeB.getState());

    entry.write(storeA);

    expect(entry.read(storeA.getState())).not.toBe(before);
    expect(entry.read(storeB.getState())).toBe(before);
    b.dispose();
    expect(() => b.store(entry.def)).toThrow();
    expect(a.store(entry.def)).toBe(storeA);
  });

  test("the hook reads the rendered scope's instance", () => {
    const Reader = () => <span data-testid="value">{entry.read(entry.hook())}</span>;
    const { scope } = renderInNodeScope(<Reader />, { nodeId: NODE_A });
    const initial = screen.getByTestId("value").textContent;
    // Created first: a persisted command-node store hydrates from the shared command key.
    const command = getWindowScope().commandScope().store(entry.def);

    act(() => entry.write(scope.store(entry.def)));

    expect(screen.getByTestId("value").textContent).not.toBe(initial);
    // The app's command scope is a different instance and did not move.
    expect(entry.read(command.getState())).toBe(initial);
  });

  test("the hook has no command-scope statics", () => {
    // Plan item 3018: a static would pick a node without being told which.
    for (const name of ["getState", "setState", "subscribe", "getInitialState"])
      expect([name, name in entry.hook]).toEqual([name, false]);
    expect(entry.hook.def).toBe(entry.def);
  });
});

test("the barrel exports each converted def beside its hook", () => {
  expect(barrel.designStore).toBe(designStore);
  expect(barrel.fileDirtyStore).toBe(fileDirtyStore);
  expect(barrel.githubIssuesStore).toBe(githubIssuesStore);
  expect(barrel.pullRequestsStore).toBe(pullRequestsStore);
  expect(barrel.changeProjectionStore).toBe(changeProjectionStore);
  expect(barrel.previewServiceStore).toBe(previewServiceStore);
  expect(barrel.webAnnotationStore).toBe(webAnnotationStore);
  expect(barrel.webAnnotationPreferencesStore).toBe(webAnnotationPreferencesStore);
  for (const entry of CASES) expect(entry.hook.def).toBe(entry.def);
});

describe("a leaf scope's backend work goes to its own node", () => {
  test("GitHub issues load from the leaf's client into the leaf's store", async () => {
    const snapshot = { repository: null, viewer: null, issues: [] };
    const b = new FakeNodeClient({ nodeId: NODE_B, invoke: { get_github_issues: snapshot } });
    const { a, b: leaf } = twoScopes({ b });

    await leaf.store(githubIssuesStore).getState().loadIssues("project-1");

    expect(b.calls("get_github_issues")).toEqual([
      { command: "get_github_issues", args: { projectId: "project-1" } },
    ]);
    expect(leaf.store(githubIssuesStore).getState().snapshots.get("project-1")).toEqual(
      snapshot as never,
    );
    expect(a.store(githubIssuesStore).getState().snapshots.size).toBe(0);
  });

  test("pull request reads go to the leaf, and one node's read never fences another's", async () => {
    const detail = { number: 1, title: "Leaf PR" };
    const a = new FakeNodeClient({
      nodeId: NODE_A,
      invoke: { get_github_pull_request: { number: 1, title: "Command PR" } },
    });
    const b = new FakeNodeClient({ nodeId: NODE_B, invoke: { get_github_pull_request: detail } });
    const scopes = twoScopes({ a, b });
    const ref = { owner: "acme", repo: "widget", number: 1 };

    await Promise.all([
      scopes.a.store(pullRequestsStore).getState().loadDetail(ref),
      scopes.b.store(pullRequestsStore).getState().loadDetail(ref),
    ]);

    expect(b.calls("get_github_pull_request")).toHaveLength(1);
    const [key] = scopes.b.store(pullRequestsStore).getState().details.keys();
    expect(scopes.b.store(pullRequestsStore).getState().details.get(key!)).toEqual(detail as never);
    expect(scopes.a.store(pullRequestsStore).getState().details.get(key!)?.title).toBe(
      "Command PR",
    );
  });

  test("preview snapshots and invalidations follow the leaf's client until it is disposed", async () => {
    const capabilities = fixturePreviewCapabilities();
    let revision = 3;
    const b = new FakeNodeClient({
      nodeId: NODE_B,
      invoke: {
        get_preview_capabilities: capabilities,
        get_preview_services: () =>
          fixturePreviewSnapshot(undefined, { registryRevision: revision }),
      },
    });
    const { a, b: leaf } = twoScopes({ b });
    ensurePreviewServiceSync(leaf);
    expect(b.listenerCount(previewServicesChangedEvent.name)).toBe(1);

    const previews = leaf.store(previewServiceStore);
    await previews.getState().refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    expect(b.calls("get_preview_services")).toHaveLength(1);
    expect(a.store(previewServiceStore).getState().status).toBe("idle");

    revision = 4;
    b.emit(previewServicesChangedEvent.name, {
      backendInstanceId: capabilities.backendInstanceId,
      backendEpoch: capabilities.backendEpoch,
      registryRevision: 4,
      environmentIds: [FIXTURE_ENVIRONMENT_ID],
      revokedServiceIds: [],
    });
    await waitFor(() => expect(b.calls("get_preview_services")).toHaveLength(2));

    leaf.dispose();
    expect(b.listenerCount(previewServicesChangedEvent.name)).toBe(0);
  });

  test("the preview store addresses frames through a node client that can", () => {
    const client = Object.assign(new FakeNodeClient({ nodeId: NODE_B }), {
      resolvePreviewUrl: (url: string) =>
        `https://relay.example/nodes/b?u=${encodeURIComponent(url)}`,
    });
    const { a, b } = twoScopes({ b: client });
    expect(
      b.store(previewServiceStore).getState().resolvePreviewUrl("http://localhost:3000/"),
    ).toBe("https://relay.example/nodes/b?u=http%3A%2F%2Flocalhost%3A3000%2F");
    // A client without preview addressing keeps the window gateway's (here: direct).
    expect(
      a.store(previewServiceStore).getState().resolvePreviewUrl("http://localhost:3000/"),
    ).toBe("http://localhost:3000/");
  });

  test("change projections are read and applied per node", async () => {
    const key = "environment-net/environment/env-1/live";
    const projection = environmentProjectionFixture("env-1", { revision: 2 });
    const b = new FakeNodeClient({
      nodeId: NODE_B,
      invoke: { changes_get_view: { kind: "projection", projection } },
    });
    const { a, b: leaf } = twoScopes({ b });

    const release = subscribeChangeResource(key, leaf);
    await waitFor(() =>
      expect(leaf.store(changeProjectionStore).getState().projections.get(key)?.revision).toBe(2),
    );
    expect(b.calls("changes_get_view")).toHaveLength(1);
    expect(a.store(changeProjectionStore).getState().projections.size).toBe(0);

    b.emit(CHANGE_PROJECTION_CHANGED_EVENT, {
      kind: "projection",
      projection: { ...projection, revision: 3 },
    });
    expect(leaf.store(changeProjectionStore).getState().projections.get(key)?.revision).toBe(3);

    release();
    leaf.dispose();
    expect(b.listenerCount(CHANGE_PROJECTION_CHANGED_EVENT)).toBe(0);
  });

  test("file drafts are read and written on the leaf, with their own revisions", async () => {
    const saves: Array<Readonly<Record<string, unknown>>> = [];
    const b = new FakeNodeClient({
      nodeId: NODE_B,
      invoke: {
        get_file_draft: { revision: 4, environmentId: "env-1", filePath: "a.ts", content: "x" },
        save_file_draft: (args: Readonly<Record<string, unknown>>) => {
          saves.push(args);
          return { revision: 5 };
        },
      },
    });
    const { b: leaf } = twoScopes({ b });

    await loadFileDraft("env-1", "a.ts", undefined, leaf);
    await persistFileDraft("env-1", "a.ts", "edited", "x", undefined, leaf);

    expect(b.calls("get_file_draft")).toHaveLength(1);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ expectedRevision: 4, content: "edited" });
  });

  test("a leaf's canvas controller reads its own node and stops with its scope", async () => {
    const b = new FakeNodeClient({
      nodeId: NODE_B,
      invoke: {
        design_capabilities: { ok: true, value: { intents: false } },
        design_snapshot: {
          ok: false,
          failure: { code: "missing", message: "No canvas", retry: "never" },
        },
      },
    });
    const { a, b: leaf } = twoScopes({ b });
    const controller = designController("env-1", "canvas-1", leaf);
    expect(designController("env-1", "canvas-1", leaf)).toBe(controller);
    expect(designController("env-1", "canvas-1", a)).not.toBe(controller);

    const release = controller.acquire();
    await controller.refresh();

    expect(b.calls("design_snapshot").length).toBeGreaterThan(0);
    expect(leaf.store(designStore).getState().projections.has(controller.key)).toBe(true);
    expect(controller.key.startsWith(`${NODE_B}|`)).toBe(true);
    expect(b.listenerCount("design-canvas-changed")).toBe(1);

    leaf.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(b.listenerCount("design-canvas-changed")).toBe(0);
    release();
  });

  test("a leaf's annotation sync asks its own node and stops with its scope", async () => {
    const b = new FakeNodeClient({
      nodeId: NODE_B,
      invoke: {
        web_annotations_capabilities: fixtureCapabilities({ read: false }),
      },
    });
    const { a, b: leaf } = twoScopes({ b });
    const handle = acquireWebAnnotationSync("env-1", { visible: false }, leaf);

    await waitFor(() =>
      expect(
        leaf.store(webAnnotationStore).getState().environments.get("env-1")?.capabilityStatus,
      ).toBe("available"),
    );
    expect(b.calls("web_annotations_capabilities")).toEqual([
      { command: "web_annotations_capabilities", args: { environmentId: "env-1" } },
    ]);
    expect(b.listenerCount("web-annotations-changed")).toBe(1);
    expect(a.store(webAnnotationStore).getState().environments.has("env-1")).toBe(false);

    leaf.dispose();
    expect(b.listenerCount("web-annotations-changed")).toBe(0);
    handle.release();
  });

  test("remembered destinations persist under the leaf's own key", () => {
    const { a, b } = twoScopes();
    b.store(webAnnotationPreferencesStore).getState().rememberDestination("env-1", "leaf-tab");

    expect(rememberedDestinationTabId("env-1", b)).toBe("leaf-tab");
    expect(rememberedDestinationTabId("env-1", a)).toBeNull();
    const keys = Object.keys(window.localStorage).filter((key) =>
      key.includes("web-annotation-preferences"),
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(":machine:");
  });

  test("disposing a scope revokes its annotation object URLs", () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    try {
      const { b } = twoScopes();
      const store = b.store(webAnnotationStore);
      store.getState().update("env-1", () => ({ ...emptyWebAnnotationCache() }));
      store.getState().setAsset("env-1", "asset-1", {
        url: "blob:leaf-asset",
        status: "ready",
        error: null,
        usedAt: 1,
      });
      b.dispose();
      expect(revoked).toEqual(["blob:leaf-asset"]);
    } finally {
      URL.revokeObjectURL = original;
    }
  });
});
