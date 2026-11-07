/**
 * Plan item 3003: the light per-node stores keep one instance per node scope.
 *
 * For each store: two scopes keep independent state, the hook reads the
 * rendered scope's instance, and the hook carries no command-scope statics. The stores make no backend calls of their own; the calls
 * their companion modules make are tested beside those modules
 * (`multi-review-persistence`, `multi-review-launch-compat`,
 * `agent-model-catalog-cache`, `tab-launch`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, screen } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { ScopedStoreDef } from "@/lib/node-scope/scoped-store";
import type { ScopedStoreHook } from "@/lib/node-scope/scoped-store";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { agentActivityStore, useAgentActivityStore } from "./agentActivityStore";
import { agentModelCatalogStore, useAgentModelCatalogStore } from "./agentModelCatalogStore";
import { claudeOptionsStore, useClaudeOptionsStore } from "./claudeOptionsStore";
import { environmentDiffStore, useEnvironmentDiffStore } from "./environmentDiffStore";
import { multiReviewStore, useMultiReviewStore } from "./multiReviewStore";
import { prMonitorStore, usePrMonitorStore } from "./prMonitorStore";
import { tabLaunchStore, useTabLaunchStore } from "./tabLaunchStore";
import { useWorktreeSnapshotStore, worktreeSnapshotStore } from "./worktreeSnapshotStore";
import * as barrel from "./index";

const NODE_A = "bk_light-store-a" as BackendId;
const NODE_B = "bk_light-store-b" as BackendId;

interface Case<S> {
  def: ScopedStoreDef<S>;
  hook: ScopedStoreHook<S>;
  /** Changes the state through the store's own action. */
  write(store: StoreApi<S>): void;
  /** A string that differs once `write` ran. */
  read(state: S): string;
}

function scopedCase<S>(entry: Case<S>): Case<unknown> {
  return entry as unknown as Case<unknown>;
}

const CASES: ReadonlyArray<Case<unknown>> = [
  scopedCase({
    def: environmentDiffStore,
    hook: useEnvironmentDiffStore,
    write: (store) =>
      store.getState().applyChange({
        environmentId: "env-1",
        comparisonRef: "origin/main",
        stats: { additions: 3, deletions: 1, filesChanged: 2, truncated: false },
        computedAt: "2026-11-07T00:00:00.000Z",
      }),
    read: (state) => String(state.stats.get("env-1")?.additions ?? "none"),
  }),
  scopedCase({
    def: worktreeSnapshotStore,
    hook: useWorktreeSnapshotStore,
    write: (store) => store.getState().setGeneration("generation-a"),
    read: (state) => state.generation ?? "none",
  }),
  scopedCase({
    def: agentActivityStore,
    hook: useAgentActivityStore,
    write: (store) => store.getState().setTabState("tab-1", "working"),
    read: (state) => state.getTabState("tab-1"),
  }),
  scopedCase({
    def: prMonitorStore,
    hook: usePrMonitorStore,
    write: (store) => store.getState().setSyncStatus("current"),
    read: (state) => state.syncStatus,
  }),
  scopedCase({
    def: multiReviewStore,
    hook: useMultiReviewStore,
    // A workflow's shape is the persistence tests' business; the instance is what matters here.
    write: (store) => store.setState({ workflows: new Map([["wf-1", { id: "wf-1" } as never]]) }),
    read: (state) => String(state.workflows.size),
  }),
  scopedCase({
    def: agentModelCatalogStore,
    hook: useAgentModelCatalogStore,
    write: (store) => store.getState().setClaudeModels([{ id: "opus", name: "Opus" }]),
    read: (state) => state.claudeModels.map((model) => model.id).join(",") || "none",
  }),
  scopedCase({
    def: claudeOptionsStore,
    hook: useClaudeOptionsStore,
    write: (store) =>
      store
        .getState()
        .setOptions("env-1", { launchAgent: true, agentType: "codex", initialPrompt: "" }),
    read: (state) => state.getOptions("env-1")?.agentType ?? "none",
  }),
  scopedCase({
    def: tabLaunchStore,
    hook: useTabLaunchStore,
    write: (store) =>
      store.getState().add("env-1", { tabId: "tab-1", title: "Push", surface: "agent" }),
    read: (state) => state.launches.get("env-1")?.[0]?.tabId ?? "none",
  }),
];

let windowScope: WindowScope | null = null;

afterEach(() => {
  cleanupNodeScopes();
  windowScope?.dispose();
  windowScope = null;
  resetWindowScopeForTests();
});

function twoScopes() {
  windowScope = new WindowScope();
  const a = windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) });
  const b = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
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

    act(() => entry.write(scope.store(entry.def)));

    expect(screen.getByTestId("value").textContent).not.toBe(initial);
    // The app's command scope is a different instance and did not move.
    expect(entry.read(getWindowScope().commandScope().store(entry.def).getState())).toBe(initial);
  });

  test("the hook has no command-scope statics", () => {
    // Plan item 3018: a static would pick a node without being told which.
    for (const name of ["getState", "setState", "subscribe", "getInitialState"])
      expect([name, name in entry.hook]).toEqual([name, false]);
    expect(entry.hook.def).toBe(entry.def);
  });
});

test("the barrel exports each converted def beside its hook", () => {
  expect(barrel.environmentDiffStore).toBe(environmentDiffStore);
  expect(barrel.agentActivityStore).toBe(agentActivityStore);
  expect(barrel.prMonitorStore).toBe(prMonitorStore);
  expect(barrel.multiReviewStore).toBe(multiReviewStore);
  expect(barrel.agentModelCatalogStore).toBe(agentModelCatalogStore);
  expect(barrel.claudeOptionsStore).toBe(claudeOptionsStore);
  for (const entry of CASES) expect(entry.hook.def).toBe(entry.def);
});
