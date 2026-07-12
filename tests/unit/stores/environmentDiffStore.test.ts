import { afterEach, describe, expect, test } from "bun:test";
import { useEnvironmentDiffStore } from "../../../apps/web/src/stores/environmentDiffStore";

function resetStore() {
  useEnvironmentDiffStore.setState({
    stats: new Map(),
  });
}

describe("environmentDiffStore", () => {
  afterEach(() => {
    resetStore();
  });

  test("sets stats for an environment", () => {
    useEnvironmentDiffStore.getState().setStats("env-1", {
      additions: 3,
      deletions: 1,
      filesChanged: 2,
    });

    expect(useEnvironmentDiffStore.getState().stats.get("env-1")).toEqual({
      additions: 3,
      deletions: 1,
      filesChanged: 2,
    });
  });

  test("does not replace state when stats are unchanged", () => {
    useEnvironmentDiffStore.getState().setStats("env-1", {
      additions: 3,
      deletions: 1,
      filesChanged: 2,
    });
    const statsMap = useEnvironmentDiffStore.getState().stats;

    useEnvironmentDiffStore.getState().setStats("env-1", {
      additions: 3,
      deletions: 1,
      filesChanged: 2,
    });

    expect(useEnvironmentDiffStore.getState().stats).toBe(statsMap);
  });

  test("replaces state when stats change", () => {
    useEnvironmentDiffStore.getState().setStats("env-1", {
      additions: 3,
      deletions: 1,
      filesChanged: 2,
    });
    const statsMap = useEnvironmentDiffStore.getState().stats;

    useEnvironmentDiffStore.getState().setStats("env-1", {
      additions: 4,
      deletions: 1,
      filesChanged: 2,
    });

    expect(useEnvironmentDiffStore.getState().stats).not.toBe(statsMap);
    expect(useEnvironmentDiffStore.getState().stats.get("env-1")?.additions).toBe(4);
  });

  test("prunes only stale environment stats", () => {
    useEnvironmentDiffStore.setState({
      stats: new Map([
        ["env-1", { additions: 1, deletions: 1, filesChanged: 1 }],
        ["env-2", { additions: 2, deletions: 2, filesChanged: 2 }],
      ]),
    });

    useEnvironmentDiffStore.getState().pruneStats(new Set(["env-2"]));

    expect([...useEnvironmentDiffStore.getState().stats.entries()]).toEqual([
      ["env-2", { additions: 2, deletions: 2, filesChanged: 2 }],
    ]);
  });

  test("does not replace state when prune finds no stale entries", () => {
    useEnvironmentDiffStore.setState({
      stats: new Map([["env-1", { additions: 1, deletions: 1, filesChanged: 1 }]]),
    });
    const statsMap = useEnvironmentDiffStore.getState().stats;

    useEnvironmentDiffStore.getState().pruneStats(new Set(["env-1"]));

    expect(useEnvironmentDiffStore.getState().stats).toBe(statsMap);
  });
});
