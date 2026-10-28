import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_REMEMBERED_UPSTREAM_DECLINES,
  selectDeclinedUpstreamMerge,
  useCoordinatorUpstreamDeclineStore as store,
} from "./coordinatorUpstreamDeclineStore";

const key = store.persist.getOptions().name!;
afterEach(() => {
  store.setState({ declines: [] });
  localStorage.removeItem(key);
});

describe("coordinator upstream decline persistence", () => {
  test("keeps one decline per project and restores it after a reload", async () => {
    store.getState().decline("first", { upstream: "origin/main", upstreamCommit: "a1" });
    store.getState().decline("second", { upstream: "origin/main", upstreamCommit: "b1" });
    store.getState().decline("first", { upstream: "origin/main", upstreamCommit: "a2" });
    const persisted = localStorage.getItem(key)!;
    store.setState({ declines: [] });
    localStorage.setItem(key, persisted);
    await store.persist.rehydrate();
    expect(selectDeclinedUpstreamMerge("first")(store.getState())).toMatchObject({
      upstream: "origin/main",
      upstreamCommit: "a2",
    });
    expect(selectDeclinedUpstreamMerge("second")(store.getState())?.upstreamCommit).toBe("b1");
    expect(store.getState().declines).toHaveLength(2);
  });

  test("drops malformed entries and bounds the remembered projects", async () => {
    const entries = Array.from({ length: MAX_REMEMBERED_UPSTREAM_DECLINES + 5 }, (_, index) => ({
      projectId: `project-${index}`,
      upstream: "origin/main",
      upstreamCommit: `tip-${index}`,
    }));
    localStorage.setItem(
      key,
      JSON.stringify({
        state: {
          declines: [
            ...entries,
            { projectId: "", upstream: "origin/main", upstreamCommit: "x" },
            { projectId: "bad", upstream: 4, upstreamCommit: "x" },
            null,
          ],
        },
        version: 0,
      }),
    );
    await store.persist.rehydrate();
    const declines = store.getState().declines;
    expect(declines.length).toBeLessThanOrEqual(MAX_REMEMBERED_UPSTREAM_DECLINES);
    expect(declines.some((entry) => entry.projectId === "bad")).toBe(false);
    expect(selectDeclinedUpstreamMerge("project-0")(store.getState())).toBeUndefined();
    expect(
      selectDeclinedUpstreamMerge(`project-${MAX_REMEMBERED_UPSTREAM_DECLINES + 4}`)(
        store.getState(),
      )?.upstreamCommit,
    ).toBe(`tip-${MAX_REMEMBERED_UPSTREAM_DECLINES + 4}`);
  });
});
