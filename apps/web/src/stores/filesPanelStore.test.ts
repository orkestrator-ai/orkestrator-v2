import { beforeEach, expect, test } from "bun:test";
import { gitHubPullRequestKey } from "@orkestrator/protocol/github-pull-requests";
import { useFilesPanelStore as store } from "./filesPanelStore";
const ref = (number: number) => ({ owner: "acme", repo: "repo", number });
const key = (number: number) => gitHubPullRequestKey(ref(number));
const tabs = (id = "one") => store.getState().pullRequestTabs[id] ?? [];
beforeEach(() => store.setState({ pullRequestTabs: {}, activeTab: "changes", isOpen: false }));

test("opening and reopening deduplicates refs and reapplies the requested view", () => {
  store.getState().openPullRequest("one", ref(1), "code");
  store.getState().openPullRequest("one", { ...ref(1), owner: "ACME" }, "timeline");
  expect(tabs()).toHaveLength(1);
  expect(tabs()[0]).toMatchObject({ key: key(1), view: "timeline", openRequest: 1 });
  store.getState().openPullRequest("two", ref(2));
  expect(tabs()).toHaveLength(1);
  expect(tabs("two")[0]?.ref.number).toBe(2);
});

test("closing selects the next neighbour, then the previous, then the list", () => {
  for (const number of [1, 2, 3]) store.getState().openPullRequest("one", ref(number));
  store.getState().setActiveTab(`pull-request:${key(2)}`);
  store.getState().closePullRequest("one", key(2));
  expect(store.getState().activeTab).toBe(`pull-request:${key(3)}`);
  store.getState().closePullRequest("one", key(3));
  expect(store.getState().activeTab).toBe(`pull-request:${key(1)}`);
  store.getState().closePullRequest("one", key(1));
  expect(store.getState().activeTab).toBe("pull-requests");
});

test("closing inactive or missing tabs preserves selection; summaries update their tab", () => {
  store.getState().openPullRequest("one", ref(1));
  store.getState().openPullRequest("one", ref(2));
  const summary = { title: "Merged feature", state: "merged" as const, isDraft: false };
  store.getState().updatePullRequestTab("one", key(2), summary);
  expect(tabs()[1]).toMatchObject(summary);
  store.getState().closePullRequest("one", key(1));
  store.getState().closePullRequest("one", "missing");
  expect(store.getState().activeTab).toBe(`pull-request:${key(2)}`);
});

test("tab and target bounds evict oldest entries", () => {
  for (let i = 1; i <= 12; i++) store.getState().openPullRequest("one", ref(i));
  expect(tabs()).toHaveLength(8);
  expect(tabs()[0]?.ref.number).toBe(5);
  for (let i = 0; i < 50; i++) store.getState().openPullRequest(`target-${i}`, ref(1));
  expect(Object.keys(store.getState().pullRequestTabs)).toHaveLength(50);
  expect(tabs()).toHaveLength(0);
});

test("persisted tabs reject malformed refs, recompute keys and reset transient requests", () => {
  const merge = store.persist.getOptions().merge!;
  const values = [
    null,
    { ref: ref(0) },
    { ref: { ...ref(1), repo: "../bad" } },
    {
      key: "forged",
      ref: ref(1),
      view: "code",
      openRequest: 99,
      title: "x".repeat(400),
      state: "invalid",
      isDraft: "yes",
    },
  ];
  const restored = merge({ pullRequestTabs: { one: values, invalid: true } }, store.getState());
  const result = restored.pullRequestTabs.one!;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    key: key(1),
    ref: ref(1),
    view: "summary",
    openRequest: 0,
    title: "x".repeat(300),
    state: undefined,
    isDraft: false,
  });
  expect(merge(null, store.getState()).pullRequestTabs).toEqual({});
});

test("persisted state enforces target and tab bounds and ignores invalid containers", () => {
  const values = Array.from({ length: 15 }, (_, i) => ({ ref: ref(i + 1) }));
  const entries = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`saved-${i}`, values]));
  const merge = store.persist.getOptions().merge!;
  const restored = merge({ pullRequestTabs: entries }, store.getState());
  expect(Object.keys(restored.pullRequestTabs)).toHaveLength(50);
  expect(restored.pullRequestTabs["saved-0"]).toBeUndefined();
  expect(restored.pullRequestTabs["saved-54"]).toHaveLength(8);
  for (const invalid of [null, [], true, "invalid"]) {
    expect(merge({ pullRequestTabs: invalid }, store.getState()).pullRequestTabs).toEqual({});
  }
});

const subtree = { children: [], truncated: false };

function resetFolders() {
  store.setState({
    fileSubtreeKey: "A",
    fileSubtrees: {},
    loadingFolders: [],
    folderLoadTokens: new Map(),
    failedFolders: [],
    expandedFolders: ["parent", "parent/child", "other"],
  });
  return store.getState();
}

test("collapse forgets descendant results, failures and pending requests without affecting siblings", () => {
  const state = resetFolders();
  const child = state.beginFolderLoad("A", "parent/child", false)!;
  store.setState({
    fileSubtrees: { parent: subtree, "parent/loaded": subtree, other: subtree },
    failedFolders: ["parent/failed", "other/failed"],
  });
  state.setFolderExpanded("parent", false);
  expect(store.getState().fileSubtrees).toEqual({ other: subtree });
  expect(store.getState().failedFolders).toEqual(["other/failed"]);
  expect(store.getState().loadingFolders).toEqual([]);
  state.setFolderExpanded("parent", true);
  const replacement = state.beginFolderLoad("A", "parent/child", false)!;
  expect(replacement).toBeTruthy();
  expect(state.finishFolderLoad("A", "parent/child", child, subtree)).toBe(false);
  expect(store.getState().folderLoadTokens.get("parent/child")).toBe(replacement);
});

for (const oldFirst of [true, false]) {
  test(`target A → B → A rejects obsolete completion (${oldFirst ? "old" : "new"} first)`, () => {
    const state = resetFolders();
    const old = state.beginFolderLoad("A", "parent", false)!;
    state.resetFileSubtrees("B");
    state.resetFileSubtrees("A");
    const current = state.beginFolderLoad("A", "parent", false)!;
    if (oldFirst) {
      expect(state.finishFolderLoad("A", "parent", old, null)).toBe(false);
      expect(store.getState().loadingFolders).toEqual(["parent"]);
    }
    expect(state.finishFolderLoad("A", "parent", current, subtree)).toBe(true);
    expect(state.finishFolderLoad("A", "parent", old, null)).toBe(false);
    expect(store.getState().fileSubtrees.parent).toEqual(subtree);
    expect(store.getState().failedFolders).toEqual([]);
  });
}

for (const path of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
  test(`loads and stores the valid folder name ${path}`, () => {
    const state = resetFolders();
    state.setFolderExpanded(path, true);
    const token = state.beginFolderLoad("A", path, false)!;
    expect(typeof token).toBe("symbol");
    state.finishFolderLoad("A", path, token, subtree);
    expect(Object.hasOwn(store.getState().fileSubtrees, path)).toBe(true);
    expect(store.getState().fileSubtrees[path]).toEqual(subtree);
    expect(state.beginFolderLoad("A", path, false)).toBeNull();
  });
}

test("load guards deduplicate, failures preserve contents, and retry allows a fresh read", () => {
  const state = resetFolders();
  expect(state.beginFolderLoad("B", "parent", true)).toBeNull();
  const first = state.beginFolderLoad("A", "parent", false)!;
  expect(state.beginFolderLoad("A", "parent", true)).toBeNull();
  state.finishFolderLoad("A", "parent", first, subtree);
  expect(state.beginFolderLoad("A", "parent", false)).toBeNull();
  const refresh = state.beginFolderLoad("A", "parent", true)!;
  state.finishFolderLoad("A", "parent", refresh, null);
  expect(store.getState().fileSubtrees.parent).toEqual(subtree);
  expect(state.beginFolderLoad("A", "parent", false)).toBeNull();
  state.retryFolderLoad("parent");
  const retry = state.beginFolderLoad("A", "parent", false)!;
  state.finishFolderLoad("A", "parent", retry, subtree);
  expect(store.getState().failedFolders).toEqual([]);
});
