import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { useInTreeNodesStore } from "./inTreeNodesStore";
import { MAX_OPEN_REALMS, useRemoteWorkspaceStore } from "./remoteWorkspaceStore";

const INITIAL = useRemoteWorkspaceStore.getState();

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL, true);
});

afterEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL, true);
  useInTreeNodesStore.setState({ nodes: [] });
  resetWindowScopeForTests();
});

test("realms are capped at MAX_OPEN_REALMS, least recently opened first", () => {
  const ids = ["bk_1", "bk_2", "bk_3", "bk_4"];
  for (const id of ids) useRemoteWorkspaceStore.getState().open(id, {});
  expect(useRemoteWorkspaceStore.getState().realms).toEqual(ids.slice(-MAX_OPEN_REALMS));
});

test("nodes shown in the window's tree are not counted: the lifecycle's budgets bound them (4002)", () => {
  useInTreeNodesStore.setState({ nodes: ["bk_t1", "bk_t2", "bk_t3", "bk_t4"] });
  const order = ["bk_t1", "bk_r1", "bk_t2", "bk_r2", "bk_t3", "bk_r3", "bk_t4", "bk_r4"];
  for (const id of order) useRemoteWorkspaceStore.getState().open(id, {});
  expect(useRemoteWorkspaceStore.getState().realms).toEqual([
    "bk_t1",
    "bk_t2",
    "bk_r2",
    "bk_t3",
    "bk_r3",
    "bk_t4",
    "bk_r4",
  ]);
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_r4");
});
