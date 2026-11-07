import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { useInTreeNodesStore } from "./inTreeNodesStore";
import { MAX_OPEN_REALMS, useRemoteWorkspaceStore } from "./remoteWorkspaceStore";

const INITIAL = useRemoteWorkspaceStore.getState();

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL, true);
  // The realm cases run under the rollback setting (plan item 6001).
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: true });
});

afterEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL, true);
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  resetWindowScopeForTests();
});

test("realms are capped at MAX_OPEN_REALMS, least recently opened first", () => {
  const ids = ["bk_1", "bk_2", "bk_3", "bk_4"];
  for (const id of ids) useRemoteWorkspaceStore.getState().open(id, {});
  expect(useRemoteWorkspaceStore.getState().realms).toEqual(ids.slice(-MAX_OPEN_REALMS));
});

test("in-tree by default, no node is counted: the lifecycle's budgets bound them (4002)", () => {
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  const order = ["bk_1", "bk_2", "bk_3", "bk_4", "bk_5", "bk_6", "bk_2"];
  for (const id of order) useRemoteWorkspaceStore.getState().open(id, {});
  expect(useRemoteWorkspaceStore.getState().realms).toEqual([
    "bk_1",
    "bk_3",
    "bk_4",
    "bk_5",
    "bk_6",
    "bk_2",
  ]);
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_2");
});
