import { beforeEach, expect, test } from "bun:test";
import { gitHubPullRequestKey } from "@orkestrator/protocol/github-pull-requests";
import { useProjectPullRequestsStore as store } from "./projectPullRequestsStore";
const ref = (number: number) => ({ owner: "acme", repo: "repo", number });
const key = (number: number) => gitHubPullRequestKey(ref(number));
const tabs = (id = "one") => store.getState().projects[id]?.tabs ?? [];
beforeEach(() => store.setState({ projects: {} }));

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
  store.getState().setActive("one", key(2));
  store.getState().closePullRequest("one", key(2));
  expect(store.getState().projects.one?.activeKey).toBe(key(3));
  store.getState().closePullRequest("one", key(3));
  expect(store.getState().projects.one?.activeKey).toBe(key(1));
  store.getState().closePullRequest("one", key(1));
  expect(store.getState().projects.one?.activeKey).toBe(null);
});

test("closing inactive or missing tabs preserves selection; summaries update their tab", () => {
  store.getState().openPullRequest("one", ref(1));
  store.getState().openPullRequest("one", ref(2));
  const summary = { title: "Merged feature", state: "merged" as const, isDraft: false };
  store.getState().updateTab("one", key(2), summary);
  expect(tabs()[1]).toMatchObject(summary);
  store.getState().closePullRequest("one", key(1));
  store.getState().closePullRequest("one", "missing");
  expect(store.getState().projects.one?.activeKey).toBe(key(2));
});

test("tab and target bounds evict oldest entries", () => {
  for (let i = 1; i <= 12; i++) store.getState().openPullRequest("one", ref(i));
  expect(tabs()).toHaveLength(10);
  expect(tabs()[0]?.ref.number).toBe(3);
  for (let i = 0; i < 50; i++) store.getState().openPullRequest(`target-${i}`, ref(1));
  expect(Object.keys(store.getState().projects)).toHaveLength(50);
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
  const restored = merge(
    { projects: { one: { tabs: values, activeKey: "forged" } } },
    store.getState(),
  );
  const result = restored.projects.one!.tabs;
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
  expect(merge(null, store.getState()).projects).toEqual({});
});

test("selection accepts only open tabs and null shows the project list", () => {
  store.getState().openPullRequest("one", ref(1));
  store.getState().setActive("one", "missing");
  expect(store.getState().projects.one?.activeKey).toBe(key(1));
  store.getState().setActive("one", null);
  expect(store.getState().projects.one?.activeKey).toBeNull();
  const restored = store.persist.getOptions().merge!(
    { projects: { one: { tabs: [{ ref: ref(1) }], activeKey: "missing" } } },
    store.getState(),
  );
  expect(restored.projects.one?.activeKey).toBeNull();
});

test("persisted state enforces target and tab bounds and ignores invalid containers", () => {
  const values = Array.from({ length: 15 }, (_, i) => ({ ref: ref(i + 1) }));
  const entries = Object.fromEntries(
    Array.from({ length: 55 }, (_, i) => [`saved-${i}`, { tabs: values, activeKey: key(1) }]),
  );
  const merge = store.persist.getOptions().merge!;
  const restored = merge({ projects: entries }, store.getState());
  expect(Object.keys(restored.projects)).toHaveLength(50);
  expect(restored.projects["saved-0"]).toBeUndefined();
  expect(restored.projects["saved-54"]?.tabs).toHaveLength(10);
  for (const invalid of [null, [], true, "invalid"]) {
    expect(merge({ projects: invalid }, store.getState()).projects).toEqual({});
  }
});
