import { afterEach, expect, test } from "bun:test";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { searchProjectsAndEnvironments, type ProjectSearchSource } from "@/lib/project-search";
import { MAX_RECENT_KEYS, useMachineViewStore, withRecentKeys } from "./machineViewStore";

const original = useMachineViewStore.getState();
const storageKey = useMachineViewStore.persist.getOptions().name!;
afterEach(() => {
  useMachineViewStore.setState(original, true);
  localStorage.removeItem(storageKey);
});

test("rehydrates machine-qualified local and remote recents and preserves search ordering", async () => {
  const sources: ProjectSearchSource[] = ["bk_local", "bk_remote"].map((node, index) => {
    const backendId = node as BackendId;
    return {
      machine: {
        backendId,
        connectionId: node,
        name: node,
        colorToken: "teal",
        bound: index === 0,
        transport: "connected",
        freshness: "current",
        projects: [],
        environmentsByProject: new Map(),
        loadedAt: 1,
        truncated: false,
      },
      projects: [
        {
          id: "p",
          key: projectKey(projectRef(backendId, "p")),
          name: "shared",
          order: 0,
          folder: null,
          repositoryHint: null,
          pathName: null,
          defaultBranch: "main",
        },
      ],
      environments: [
        {
          id: "e",
          key: environmentKey(environmentRef(backendId, "e")),
          projectId: "p",
          name: "shared",
          branch: "main",
          status: "running",
          environmentType: "local",
          worktreeName: null,
          order: 0,
        },
      ],
    };
  });
  useMachineViewStore.setState({ recentKeys: [] });
  for (const source of sources) {
    useMachineViewStore
      .getState()
      .recordRecent([source.environments[0]!.key, source.projects[0]!.key]);
  }
  const expected = sources
    .toReversed()
    .flatMap((source) => [source.environments[0]!.key, source.projects[0]!.key]);
  const persisted = localStorage.getItem(storageKey)!;
  useMachineViewStore.setState(original, true);
  expect(useMachineViewStore.getState().recentKeys).toEqual([]);
  localStorage.setItem(storageKey, persisted);
  await useMachineViewStore.persist.rehydrate();
  expect(useMachineViewStore.getState().recentKeys).toEqual(expected);
  for (const query of ["", "shared"]) {
    const results = searchProjectsAndEnvironments({
      query,
      filter: "all",
      sources,
      recentKeys: useMachineViewStore.getState().recentKeys,
    });
    expect(results.projects.map((hit) => hit.project.key)).toEqual([expected[1]!, expected[3]!]);
    expect(results.environments.map((hit) => hit.environment.key)).toEqual([
      expected[0]!,
      expected[2]!,
    ]);
  }
});

test("rehydrates storage from before recentKeys existed with compatible defaults", async () => {
  useMachineViewStore.setState(original, true);
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      state: {
        machineFilter: "bk_remote",
        grouping: "repository",
        collapsedMachines: ["bk_local"],
      },
      version: 0,
    }),
  );
  await useMachineViewStore.persist.rehydrate();
  expect(useMachineViewStore.getState().recentKeys).toEqual([]);
  expect(useMachineViewStore.getState().machineFilter).toBe("bk_remote");
  expect(useMachineViewStore.getState().grouping).toBe("repository");
  expect(useMachineViewStore.getState().collapsedMachines).toEqual(["bk_local"]);
  useMachineViewStore.getState().recordRecent(["new"]);
  expect(useMachineViewStore.getState().recentKeys).toEqual(["new"]);
});

test("recency deduplicates incoming keys, ignores empty keys and preserves newest-first order", () => {
  expect(withRecentKeys(["old", "used", "older"], ["used", "", "new", "used"])).toEqual([
    "used",
    "new",
    "old",
    "older",
  ]);
  useMachineViewStore.setState({ recentKeys: ["old", "used", "older"] });
  useMachineViewStore.getState().recordRecent(["used", "", "new", "used"]);
  expect(useMachineViewStore.getState().recentKeys).toEqual(["used", "new", "old", "older"]);
});

test("recording the current prefix or no keys is an idempotent no-op", () => {
  const keys = ["new", "old"];
  expect(withRecentKeys(keys, ["new", "new", ""])).toBe(keys);
  expect(withRecentKeys(keys, [])).toBe(keys);
  useMachineViewStore.setState({ recentKeys: keys });
  const before = useMachineViewStore.getState();
  useMachineViewStore.getState().recordRecent(["new", "old", "new"]);
  expect(useMachineViewStore.getState()).toBe(before);
  useMachineViewStore.getState().recordRecent([]);
  expect(useMachineViewStore.getState()).toBe(before);
});

test("recency is bounded to 64 newest keys across repeated updates and oversized batches", () => {
  const keys = Array.from({ length: MAX_RECENT_KEYS + 10 }, (_, i) => `key-${i}`);
  expect(withRecentKeys([], keys)).toEqual(keys.slice(0, MAX_RECENT_KEYS));
  useMachineViewStore.getState().recordRecent(keys);
  useMachineViewStore.getState().recordRecent(["new"]);
  expect(useMachineViewStore.getState().recentKeys).toEqual([
    "new",
    ...keys.slice(0, MAX_RECENT_KEYS - 1),
  ]);
});
