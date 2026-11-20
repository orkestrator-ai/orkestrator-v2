import { afterEach, expect, test } from "bun:test";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { searchProjectsAndEnvironments, type ProjectSearchSource } from "@/lib/project-search";
import {
  MAX_RECENT_KEYS,
  sanitizePersisted,
  useMachineViewStore,
  withRecentKeys,
} from "./machineViewStore";

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
  expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_remote"]);
  expect(useMachineViewStore.getState().grouping).toBe("repository");
  expect(useMachineViewStore.getState().environmentOrdering).toBe("machine");
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

test("compact persists across a reload", async () => {
  localStorage.removeItem(storageKey);
  useMachineViewStore.getState().setGrouping("compact");
  const stored = JSON.parse(localStorage.getItem(storageKey)!) as {
    state: Record<string, unknown>;
    version: number;
  };
  expect(stored.version).toBe(1);
  expect(stored.state.grouping).toBe("compact");
  expect(stored.state).not.toHaveProperty("groupingBeforeCompact");

  useMachineViewStore.setState({ grouping: "repository" });
  localStorage.setItem(storageKey, JSON.stringify(stored));
  await useMachineViewStore.persist.rehydrate();
  expect(useMachineViewStore.getState().grouping).toBe("compact");
});

test("rehydrating an earlier build's view migrates its filter and grouping", async () => {
  for (const [grouping, expected] of [
    ["machine", "repository"],
    ["project", "repository"],
    ["compact", "compact"],
  ] as const) {
    useMachineViewStore.setState(original, true);
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        state: { machineFilter: "all", grouping, groupingBeforeCompact: "project" },
        version: 0,
      }),
    );
    await useMachineViewStore.persist.rehydrate();
    const state = useMachineViewStore.getState();
    expect(state.machineFilter).toEqual([]);
    expect(state.grouping).toBe(expected);
    expect(state.environmentOrdering).toBe("machine");
    expect(state).not.toHaveProperty("groupingBeforeCompact");
  }
});

test("the filter and environment ordering persist across a reload", async () => {
  useMachineViewStore.getState().setMachineFilter(["bk_a", "bk_b"]);
  useMachineViewStore.getState().setEnvironmentOrdering("manual");
  const persisted = localStorage.getItem(storageKey)!;
  useMachineViewStore.setState(original, true);
  localStorage.setItem(storageKey, persisted);
  await useMachineViewStore.persist.rehydrate();
  expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_a", "bk_b"]);
  expect(useMachineViewStore.getState().environmentOrdering).toBe("manual");
});

test("sanitizePersisted reads every stored machine filter as a list", () => {
  expect(sanitizePersisted({ machineFilter: "all" }).machineFilter).toEqual([]);
  expect(sanitizePersisted({ machineFilter: "" }).machineFilter).toEqual([]);
  expect(sanitizePersisted({ machineFilter: "bk_a" }).machineFilter).toEqual(["bk_a"]);
  expect(sanitizePersisted({ machineFilter: ["bk_a", "bk_b"] }).machineFilter).toEqual([
    "bk_a",
    "bk_b",
  ]);
  expect(
    sanitizePersisted({ machineFilter: ["bk_a", "", 3, null, "bk_a", "bk_b"] }).machineFilter,
  ).toEqual(["bk_a", "bk_b"]);
  expect(sanitizePersisted({ machineFilter: 7 }).machineFilter).toEqual([]);
  expect(sanitizePersisted({ machineFilter: { bk_a: true } }).machineFilter).toEqual([]);
  expect(sanitizePersisted({})).not.toHaveProperty("machineFilter");
});

test("sanitizePersisted maps earlier groupings to the repository list and keeps compact", () => {
  expect(sanitizePersisted({ grouping: "machine" }).grouping).toBe("repository");
  expect(sanitizePersisted({ grouping: "project" }).grouping).toBe("repository");
  expect(sanitizePersisted({ grouping: "repository" }).grouping).toBe("repository");
  expect(sanitizePersisted({ grouping: "compact" }).grouping).toBe("compact");
  expect(sanitizePersisted({ grouping: "activity" }).grouping).toBe("repository");
  expect(sanitizePersisted({ grouping: 1 }).grouping).toBe("repository");
  expect(
    sanitizePersisted({ grouping: "compact", groupingBeforeCompact: "project" }),
  ).not.toHaveProperty("groupingBeforeCompact");
});

test("sanitizePersisted keeps a valid environment ordering and defaults any other", () => {
  expect(sanitizePersisted({ environmentOrdering: "manual" }).environmentOrdering).toBe("manual");
  expect(sanitizePersisted({ environmentOrdering: "machine" }).environmentOrdering).toBe("machine");
  expect(sanitizePersisted({ environmentOrdering: "activity" }).environmentOrdering).toBe(
    "machine",
  );
  expect(sanitizePersisted({ environmentOrdering: null }).environmentOrdering).toBe("machine");
  expect(sanitizePersisted({})).not.toHaveProperty("environmentOrdering");
  expect(useMachineViewStore.getState().environmentOrdering).toBe("machine");
});

test("sanitizePersisted ignores a stored value that is not an object", () => {
  expect(sanitizePersisted(null)).toEqual({});
  expect(sanitizePersisted("compact")).toEqual({});
  expect(sanitizePersisted(undefined)).toEqual({});
});

test("setMachineFilter accepts all, one machine, or a list", () => {
  const filter = () => useMachineViewStore.getState().machineFilter;
  expect(filter()).toEqual([]);
  useMachineViewStore.getState().setMachineFilter("bk_a");
  expect(filter()).toEqual(["bk_a"]);
  useMachineViewStore.getState().setMachineFilter("all");
  expect(filter()).toEqual([]);
  useMachineViewStore.getState().setMachineFilter(["bk_b", "bk_a", "bk_b", ""]);
  expect(filter()).toEqual(["bk_b", "bk_a"]);
  useMachineViewStore.getState().setMachineFilter([]);
  expect(filter()).toEqual([]);
  useMachineViewStore.getState().setMachineFilter("");
  expect(filter()).toEqual([]);
});
