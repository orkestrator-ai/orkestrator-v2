import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { useRemoteWorkspaceStore } from "./remoteWorkspaceStore";

const INITIAL = useRemoteWorkspaceStore.getState();

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL, true);
});

afterEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL, true);
  resetWindowScopeForTests();
});

test("no count caps held nodes: the lifecycle's budgets bound them (4002)", () => {
  const order = ["bk_1", "bk_2", "bk_3", "bk_4", "bk_5", "bk_6", "bk_2"];
  for (const id of order) useRemoteWorkspaceStore.getState().open(id, {});
  expect(useRemoteWorkspaceStore.getState().openNodes).toEqual([
    "bk_1",
    "bk_3",
    "bk_4",
    "bk_5",
    "bk_6",
    "bk_2",
  ]);
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_2");
});

test("each request is numbered, so the same request twice is applied twice", () => {
  const store = useRemoteWorkspaceStore.getState();
  store.open("bk_1", { projectId: "p" });
  const first = useRemoteWorkspaceStore.getState().requests.bk_1!;
  store.open("bk_1", { projectId: "p" });
  const second = useRemoteWorkspaceStore.getState().requests.bk_1!;
  expect(second.request).toEqual(first.request);
  expect(second.seq).toBeGreaterThan(first.seq);
});

test("closing a node drops its request and, when it was shown, the window's selection of it", () => {
  const store = useRemoteWorkspaceStore.getState();
  store.open("bk_1", { projectId: "p", environmentId: "e" });
  store.open("bk_2", {});
  useRemoteWorkspaceStore.getState().closeNode("bk_2");
  const state = useRemoteWorkspaceStore.getState();
  expect(state.openNodes).toEqual(["bk_1"]);
  expect(state.requests.bk_2).toBeUndefined();
  expect(state.active).toBeNull();
});
