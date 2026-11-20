import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
} from "@orkestrator/protocol/node-summaries";
import { ALL_MACHINES, type MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { Environment, Project } from "@/types";
import { useProjectSearchResults, type ProjectSearchResultsInput } from "./useProjectSearchResults";

/**
 * Counts every property read on the inputs: source preparation and ranking
 * read projects, environments, machines and recents, so a closed palette that
 * does neither leaves the count at zero.
 */
function reads() {
  let count = 0;
  const watch = <T extends object>(value: T): T =>
    new Proxy(value, {
      get(target, property, receiver) {
        count++;
        return Reflect.get(target, property, receiver);
      },
    });
  return { watch, count: () => count };
}

const project = (id: string, name: string, order = 0): Project => ({
  id,
  name,
  gitUrl: `https://github.com/acme/${name}.git`,
  localPath: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  order,
});

const environment = (id: string, projectId: string, name: string): Environment => ({
  id,
  projectId,
  name,
  branch: name,
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-09-13T08:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
});

function machineView(node: string, name: string, projectNames: string[]): MachineView {
  const backendId = node as BackendId;
  const environmentsByProject = new Map<string, FederatedEnvironment[]>();
  projectNames.forEach((projectName, index) => {
    const summary = toNodeEnvironmentSummary(
      backendId,
      { id: `${projectName}-env`, projectId: projectName, name: `${projectName}-env` },
      index,
    )!;
    environmentsByProject.set(summary.projectId, [summary]);
  });
  return {
    connectionId: node,
    backendId,
    name,
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    loadedAt: 1,
    truncated: false,
    projects: projectNames.map((projectName, index) =>
      toNodeProjectSummary(
        backendId,
        { id: projectName, name: projectName, gitUrl: `git@github.com:acme/${projectName}.git` },
        index,
      )!,
    ),
    environmentsByProject,
  };
}

const ork = project("p-ork", "orkestrator-v2", 0);
const docs = project("p-docs", "docs", 1);
const backendId = "bk_self" as BackendId;

function input(overrides: Partial<ProjectSearchResultsInput> = {}): ProjectSearchResultsInput {
  return {
    open: false,
    query: "",
    filter: "all",
    machineFilter: ALL_MACHINES,
    boundMachine: null,
    backendId,
    projects: [ork, docs],
    environments: [environment("e-main", "p-ork", "main")],
    repositories: {},
    remoteMachines: [],
    requireChecks: false,
    recentKeys: [],
    recentProjectIds: [],
    ...overrides,
  };
}

/** Fresh, watched inputs, as a store update hands the search new arrays. */
function watchedInputs(watch: <T extends object>(value: T) => T, environmentName: string) {
  return {
    projects: watch([watch(ork), watch(docs)]),
    environments: watch([watch(environment(`e-${environmentName}`, "p-ork", environmentName))]),
    repositories: watch({ "p-ork": { defaultBranch: "main" } }),
    remoteMachines: watch([watch(machineView("bk_mbp3", "mbp3", [`remote-${environmentName}`]))]),
    recentKeys: watch([projectKey(projectRef(backendId, "p-docs"))]),
    recentProjectIds: watch(["p-ork"]),
  };
}

/**
 * Renders the hook over inputs held in a closure, not component props: in
 * development React diffs changed props for its performance track, which
 * would read them.
 */
function renderSearch(initial: ProjectSearchResultsInput) {
  let current = initial;
  const view = renderHook(() => useProjectSearchResults(current));
  return {
    result: view.result,
    rerender: (next: ProjectSearchResultsInput) => {
      current = next;
      view.rerender();
    },
  };
}

const names = (results: ReturnType<typeof useProjectSearchResults>["results"]) => ({
  projects: results.projects.map((hit) => hit.project.name),
  environments: results.environments.map((hit) => hit.environment.name),
});

describe("useProjectSearchResults", () => {
  afterEach(cleanup);

  test("a closed palette reads no environments, machines or recents as they change", () => {
    const counter = reads();
    const { result, rerender } = renderSearch(input({ ...watchedInputs(counter.watch, "first") }));
    for (const name of ["second", "third", "fourth"]) {
      rerender(input({ ...watchedInputs(counter.watch, name), requireChecks: name === "third" }));
    }
    rerender(input({ ...watchedInputs(counter.watch, "query"), query: "orkestrator" }));

    expect(counter.count()).toBe(0);
    expect(result.current.results.projects).toEqual([]);
    expect(result.current.results.environments).toEqual([]);
    expect(result.current.hasProjects).toBe(false);
  });

  test("opening ranks the inputs current at that moment, recents first", () => {
    const counter = reads();
    const { result, rerender } = renderSearch(input({ ...watchedInputs(counter.watch, "stale") }));
    rerender(input({ ...watchedInputs(counter.watch, "current") }));
    expect(counter.count()).toBe(0);

    rerender(input({ ...watchedInputs(counter.watch, "current"), open: true }));
    expect(counter.count()).toBeGreaterThan(0);
    expect(result.current.hasProjects).toBe(true);
    // The cross-machine recent (docs), then this machine's older recent
    // (orkestrator-v2), then the other machine's project.
    expect(names(result.current.results)).toEqual({
      projects: ["docs", "orkestrator-v2", "remote-current"],
      environments: ["current", "remote-current-env"],
    });
  });

  test("open, updates show live; closed, they wait; reopened, the latest show", () => {
    const counter = reads();
    const { result, rerender } = renderSearch(
      input({ ...watchedInputs(counter.watch, "one"), open: true }),
    );
    expect(names(result.current.results).environments).toEqual(["one", "remote-one-env"]);

    rerender(input({ ...watchedInputs(counter.watch, "two"), open: true }));
    expect(names(result.current.results).environments).toEqual(["two", "remote-two-env"]);

    rerender(
      input({ ...watchedInputs(counter.watch, "two"), open: true, machineFilter: "bk_mbp3" }),
    );
    expect(names(result.current.results).environments).toEqual(["remote-two-env"]);

    rerender(input({ ...watchedInputs(counter.watch, "two"), open: false }));
    const closedAt = counter.count();
    rerender(input({ ...watchedInputs(counter.watch, "three"), open: false }));
    expect(counter.count()).toBe(closedAt);
    expect(result.current.results.environments).toEqual([]);

    rerender(input({ ...watchedInputs(counter.watch, "three"), open: true }));
    expect(names(result.current.results).environments).toEqual(["three", "remote-three-env"]);
  });

  test("a command category ranks no destinations", () => {
    const { result } = renderSearch(input({ open: true, filter: null }));
    expect(result.current.results.projects).toEqual([]);
    expect(result.current.hasProjects).toBe(true);
  });
});
