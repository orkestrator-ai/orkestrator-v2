import { afterEach, expect, test } from "bun:test";
import { windowStorageKey } from "@/lib/desktop-storage-key";
import { nodesInTree, useInTreeNodesStore } from "./inTreeNodesStore";

const KEY = windowStorageKey("use-realms-for-remote-machines");

afterEach(() => {
  localStorage.removeItem(KEY);
  localStorage.removeItem(windowStorageKey("in-tree-nodes"));
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
});

test("every node is in-tree by default; the rollback setting brings realms back", () => {
  expect(useInTreeNodesStore.getState().useRealmsForRemoteMachines).toBe(false);
  expect(nodesInTree()).toBe(true);
  useInTreeNodesStore.getState().setUseRealmsForRemoteMachines(true);
  expect(nodesInTree()).toBe(false);
  expect(nodesInTree({ useRealmsForRemoteMachines: false })).toBe(true);
  useInTreeNodesStore.getState().setUseRealmsForRemoteMachines(false);
  expect(nodesInTree()).toBe(true);
});

test("the rollback is saved for this window and only an explicit true turns it on", async () => {
  useInTreeNodesStore.getState().setUseRealmsForRemoteMachines(true);
  expect(JSON.parse(localStorage.getItem(KEY) ?? "null")?.state).toEqual({
    useRealmsForRemoteMachines: true,
  });

  for (const stored of ["yes", 1, null, undefined]) {
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { useRealmsForRemoteMachines: stored }, version: 1 }),
    );
    await useInTreeNodesStore.persist.rehydrate();
    expect(useInTreeNodesStore.getState().useRealmsForRemoteMachines).toBe(false);
  }
  localStorage.setItem(
    KEY,
    JSON.stringify({ state: { useRealmsForRemoteMachines: true }, version: 1 }),
  );
  await useInTreeNodesStore.persist.rehydrate();
  expect(useInTreeNodesStore.getState().useRealmsForRemoteMachines).toBe(true);
});

test("4001's per-node opt-in list is no longer read: an empty list does not mean realms", async () => {
  localStorage.setItem(
    windowStorageKey("in-tree-nodes"),
    JSON.stringify({ state: { nodes: [] }, version: 1 }),
  );
  await useInTreeNodesStore.persist.rehydrate();
  expect(nodesInTree()).toBe(true);
});
