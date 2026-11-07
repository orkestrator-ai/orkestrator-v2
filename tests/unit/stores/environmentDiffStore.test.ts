import { afterEach, describe, expect, test } from "bun:test";
import type { EnvironmentDiffStatsChange } from "@orkestrator/protocol/diff-stats";
import { environmentDiffStore } from "../../../apps/web/src/stores/environmentDiffStore";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

function resetStore() {
  appCommandStore(environmentDiffStore).setState({ stats: new Map() });
}

function change(
  environmentId: string,
  overrides: Partial<EnvironmentDiffStatsChange["stats"]> = {},
): EnvironmentDiffStatsChange {
  return {
    environmentId,
    comparisonRef: "main",
    computedAt: "2026-07-27T12:00:00.000Z",
    stats: { additions: 1, deletions: 1, filesChanged: 1, truncated: false, ...overrides },
  };
}

describe("environmentDiffStore", () => {
  afterEach(() => {
    resetStore();
  });

  test("applies an incremental change", () => {
    appCommandStore(environmentDiffStore)
      .getState()
      .applyChange(
        change("env-1", {
          additions: 3,
          deletions: 1,
          filesChanged: 2,
        }),
      );

    expect(appCommandStore(environmentDiffStore).getState().stats.get("env-1")).toEqual({
      additions: 3,
      deletions: 1,
      filesChanged: 2,
      truncated: false,
    });
  });

  test("does not replace state when an incremental change repeats the current stats", () => {
    appCommandStore(environmentDiffStore).getState().applyChange(change("env-1"));
    const statsMap = appCommandStore(environmentDiffStore).getState().stats;

    appCommandStore(environmentDiffStore).getState().applyChange(change("env-1"));

    expect(appCommandStore(environmentDiffStore).getState().stats).toBe(statsMap);
  });

  test("replaces state when only the truncated flag moves", () => {
    appCommandStore(environmentDiffStore).getState().applyChange(change("env-1"));
    const statsMap = appCommandStore(environmentDiffStore).getState().stats;

    appCommandStore(environmentDiffStore)
      .getState()
      .applyChange(change("env-1", { truncated: true }));

    expect(appCommandStore(environmentDiffStore).getState().stats).not.toBe(statsMap);
    expect(appCommandStore(environmentDiffStore).getState().stats.get("env-1")?.truncated).toBe(
      true,
    );
  });

  test("removes an entry when the backend invalidates its counts", () => {
    appCommandStore(environmentDiffStore).getState().applyChange(change("env-1"));

    appCommandStore(environmentDiffStore).getState().applyChange({
      environmentId: "env-1",
      comparisonRef: "release",
      computedAt: "2026-07-27T12:01:00.000Z",
      removed: true,
    });

    expect(appCommandStore(environmentDiffStore).getState().stats.has("env-1")).toBe(false);
  });

  test("does not replace state when an invalidation repeats for an absent entry", () => {
    const statsMap = appCommandStore(environmentDiffStore).getState().stats;

    appCommandStore(environmentDiffStore).getState().applyChange({
      environmentId: "env-1",
      comparisonRef: "release",
      computedAt: "2026-07-27T12:01:00.000Z",
      removed: true,
    });

    expect(appCommandStore(environmentDiffStore).getState().stats).toBe(statsMap);
  });

  test("a snapshot replaces the map rather than merging into it", () => {
    appCommandStore(environmentDiffStore).getState().applyChange(change("env-gone"));

    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1"), change("env-2")]);

    expect([...appCommandStore(environmentDiffStore).getState().stats.keys()].sort()).toEqual([
      "env-1",
      "env-2",
    ]);
  });

  test("an empty snapshot clears every entry", () => {
    appCommandStore(environmentDiffStore).getState().applyChange(change("env-1"));

    appCommandStore(environmentDiffStore).getState().applySnapshot([]);

    expect(appCommandStore(environmentDiffStore).getState().stats.size).toBe(0);
  });

  // A rehydrate runs on every reconnect; an identical snapshot must not
  // re-render every environment row.
  test("does not replace state when a snapshot repeats the current map", () => {
    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1"), change("env-2")]);
    const statsMap = appCommandStore(environmentDiffStore).getState().stats;

    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1"), change("env-2")]);

    expect(appCommandStore(environmentDiffStore).getState().stats).toBe(statsMap);
  });

  test("does not replace state when an empty snapshot repeats an empty map", () => {
    const statsMap = appCommandStore(environmentDiffStore).getState().stats;

    appCommandStore(environmentDiffStore).getState().applySnapshot([]);

    expect(appCommandStore(environmentDiffStore).getState().stats).toBe(statsMap);
  });

  // Same size, different membership: the cheap size check must not be mistaken
  // for an equality check.
  test("replaces state when a snapshot swaps one environment for another", () => {
    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1"), change("env-2")]);

    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1"), change("env-3")]);

    expect([...appCommandStore(environmentDiffStore).getState().stats.keys()].sort()).toEqual([
      "env-1",
      "env-3",
    ]);
  });

  test("replaces state when a snapshot changes counts for the same environments", () => {
    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1")]);
    const statsMap = appCommandStore(environmentDiffStore).getState().stats;

    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1", { additions: 42 })]);

    expect(appCommandStore(environmentDiffStore).getState().stats).not.toBe(statsMap);
    expect(appCommandStore(environmentDiffStore).getState().stats.get("env-1")?.additions).toBe(42);
  });

  test("the last entry wins when a snapshot repeats an environment", () => {
    appCommandStore(environmentDiffStore)
      .getState()
      .applySnapshot([change("env-1", { additions: 1 }), change("env-1", { additions: 7 })]);

    expect(appCommandStore(environmentDiffStore).getState().stats.get("env-1")?.additions).toBe(7);
  });
});
