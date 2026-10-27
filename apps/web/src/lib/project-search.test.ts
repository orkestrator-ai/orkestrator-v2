import { describe, expect, test } from "bun:test";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
} from "@orkestrator/protocol/node-summaries";
import { ALL_MACHINES, type MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { Environment, Project } from "@/types";
import {
  flattenProjectSearchResults,
  localSearchSource,
  machineAvailability,
  machineSearchSource,
  nextProjectSearchFilter,
  previousProjectSearchFilter,
  searchProjectsAndEnvironments,
  THIS_MACHINE,
  type ProjectSearchFilter,
  type ProjectSearchSource,
} from "./project-search";

/** This machine alone, as outside a multi-machine view. */
function buildProjectSearchResults({
  query,
  filter,
  projects,
  environments,
  recentProjectIds,
  defaultBranches,
  recentLimit,
  resultLimit,
}: {
  query: string;
  filter: ProjectSearchFilter;
  projects: Project[];
  environments: Environment[];
  recentProjectIds: string[];
  defaultBranches: ReadonlyMap<string, string>;
  recentLimit?: number;
  resultLimit?: number;
}) {
  return searchProjectsAndEnvironments({
    query,
    filter,
    sources: [localSearchSource({ machine: null, projects, environments, defaultBranches })],
    recentKeys: recentProjectIds,
    ...(recentLimit === undefined ? {} : { recentLimit }),
    ...(resultLimit === undefined ? {} : { resultLimit }),
  });
}

function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    gitUrl: `https://github.com/acme/${overrides.name}.git`,
    localPath: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

function environment(
  overrides: Partial<Environment> & Pick<Environment, "id" | "projectId" | "name">,
): Environment {
  return {
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

const orkestrator = project({ id: "p-ork", name: "orkestrator-v2", order: 0 });
const docs = project({ id: "p-docs", name: "docs", order: 1 });
const projects = [orkestrator, docs];

const main = environment({
  id: "e-main",
  projectId: "p-ork",
  name: "main",
  branch: "main",
  status: "running",
  lastActivityAt: "2026-09-13T08:00:00.000Z",
  environmentType: "local",
  worktreePath: "/tmp/orkestrator-v2",
});
const feature = environment({
  id: "e-feature",
  projectId: "p-ork",
  name: "build-modal-steps",
  branch: "build-modal-steps",
  lastActivityAt: "2026-09-09T10:00:00.000Z",
  environmentType: "containerized",
});
const docsEnv = environment({
  id: "e-docs",
  projectId: "p-docs",
  name: "docs-preview",
  branch: "preview",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
});

const defaultBranches = new Map([
  ["p-ork", "main"],
  ["p-docs", "main"],
]);

describe("nextProjectSearchFilter", () => {
  test("cycles all → projects → environments → all", () => {
    expect(nextProjectSearchFilter("all")).toBe("projects");
    expect(nextProjectSearchFilter("projects")).toBe("environments");
    expect(nextProjectSearchFilter("environments")).toBe("all");
  });
});

describe("previousProjectSearchFilter", () => {
  test("cycles all → environments → projects → all", () => {
    expect(previousProjectSearchFilter("all")).toBe("environments");
    expect(previousProjectSearchFilter("environments")).toBe("projects");
    expect(previousProjectSearchFilter("projects")).toBe("all");
  });
});

describe("buildProjectSearchResults", () => {
  test("returns recent projects and environments when the query is empty", () => {
    const results = buildProjectSearchResults({
      query: "  ",
      filter: "all",
      projects,
      environments: [feature, main, docsEnv],
      recentProjectIds: ["p-docs"],
      defaultBranches,
    });

    expect(results.projects.map((hit) => hit.project.id)).toEqual(["p-docs", "p-ork"]);
    expect(results.environments.map((hit) => hit.environment.id)).toEqual([
      "e-main",
      "e-feature",
      "e-docs",
    ]);
    expect(results.environments[0]?.isPrimary).toBe(true);
    expect(results.environments[1]?.isPrimary).toBe(false);
  });

  test("matches containerized environments as well as local worktrees", () => {
    const results = buildProjectSearchResults({
      query: "build",
      filter: "all",
      projects,
      environments: [main, feature],
      recentProjectIds: [],
      defaultBranches,
    });

    expect(results.projects).toEqual([]);
    expect(results.environments.map((hit) => hit.environment.id)).toEqual(["e-feature"]);
    expect(results.environments[0]?.environment.environmentType).toBe("containerized");
  });

  test("matches project name, environment name, branch, and environment type", () => {
    const byProject = buildProjectSearchResults({
      query: "orkestrator",
      filter: "all",
      projects,
      environments: [main, docsEnv],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(byProject.projects.map((hit) => hit.id)).toEqual(["p-ork"]);
    expect(byProject.environments.map((hit) => hit.id)).toEqual(["e-main"]);

    const byType = buildProjectSearchResults({
      query: "local",
      filter: "all",
      projects,
      environments: [main, feature],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(byType.environments.map((hit) => hit.id)).toEqual(["e-main"]);
  });

  test("honors the type filter and result cap", () => {
    const projectsOnly = buildProjectSearchResults({
      query: "",
      filter: "projects",
      projects,
      environments: [main],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(projectsOnly.environments).toEqual([]);
    expect(projectsOnly.projects).toHaveLength(2);

    const environmentsOnly = buildProjectSearchResults({
      query: "",
      filter: "environments",
      projects,
      environments: [main, feature],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(environmentsOnly.projects).toEqual([]);
    expect(environmentsOnly.environments).toHaveLength(2);

    const capped = buildProjectSearchResults({
      query: "",
      filter: "all",
      projects,
      environments: [main, feature, docsEnv],
      recentProjectIds: [],
      defaultBranches,
      recentLimit: 1,
    });
    expect(capped.projects).toHaveLength(1);
    expect(capped.environments).toHaveLength(1);
    expect(capped.environments[0]?.id).toBe("e-main");
  });

  test("ranks an exact name above a substring and flattens projects first", () => {
    const extra = environment({
      id: "e-mainline",
      projectId: "p-ork",
      name: "mainline-notes",
      branch: "notes",
      lastActivityAt: "2026-09-13T09:00:00.000Z",
    });
    const results = buildProjectSearchResults({
      query: "main",
      filter: "all",
      projects,
      environments: [extra, main],
      recentProjectIds: [],
      defaultBranches,
    });

    expect(results.environments.map((hit) => hit.id)).toEqual(["e-main", "e-mainline"]);
    expect(flattenProjectSearchResults(results).map((hit) => hit.type)).toEqual([
      "environment",
      "environment",
    ]);
    expect(results.projects).toEqual([]);
  });

  test("counts environments on each project hit", () => {
    const results = buildProjectSearchResults({
      query: "orkestrator",
      filter: "projects",
      projects,
      environments: [main, feature],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(results.projects[0]?.environmentCount).toBe(2);
  });

  test("requires every token to match the same hit", () => {
    const both = buildProjectSearchResults({
      query: "build modal",
      filter: "all",
      projects,
      environments: [main, feature, docsEnv],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(both.projects).toEqual([]);
    expect(both.environments.map((hit) => hit.id)).toEqual(["e-feature"]);

    const split = buildProjectSearchResults({
      query: "build docs",
      filter: "all",
      projects,
      environments: [main, feature, docsEnv],
      recentProjectIds: [],
      defaultBranches,
    });
    expect(split.projects).toEqual([]);
    expect(split.environments).toEqual([]);
  });

  test("does not match generic git URL or worktree path tokens", () => {
    const widgets = project({
      id: "p-widgets",
      name: "widgets",
      gitUrl: "https://github.com/acme/widgets.git",
      order: 2,
    });
    const widgetsEnv = environment({
      id: "e-widgets",
      projectId: "p-widgets",
      name: "preview",
      branch: "preview",
      worktreePath: "/tmp/widgets",
    });

    for (const query of ["git", "https", "tmp"]) {
      const results = buildProjectSearchResults({
        query,
        filter: "all",
        projects: [...projects, widgets],
        environments: [main, widgetsEnv],
        recentProjectIds: [],
        defaultBranches: new Map([...defaultBranches, ["p-widgets", "main"]]),
      });
      expect(results.projects).toEqual([]);
      expect(results.environments).toEqual([]);
    }

    const bySlug = buildProjectSearchResults({
      query: "acme/widgets",
      filter: "all",
      projects: [...projects, widgets],
      environments: [main, widgetsEnv],
      recentProjectIds: [],
      defaultBranches: new Map([...defaultBranches, ["p-widgets", "main"]]),
    });
    expect(bySlug.projects.map((hit) => hit.id)).toEqual(["p-widgets"]);
    expect(bySlug.environments.map((hit) => hit.id)).toEqual(["e-widgets"]);
  });

  test("skips environments whose project is missing from the project list", () => {
    const orphan = environment({
      id: "e-orphan",
      projectId: "missing",
      name: "build-orphan",
      branch: "build-orphan",
    });
    const results = buildProjectSearchResults({
      query: "build",
      filter: "all",
      projects,
      environments: [feature, orphan],
      recentProjectIds: [],
      defaultBranches,
    });

    expect(results.environments.map((hit) => hit.id)).toEqual(["e-feature"]);
  });
});

describe("searchProjectsAndEnvironments across machines", () => {
  const selfId = "bk_self" as BackendId;

  function machineView(
    node: string,
    name: string,
    rawProjects: Record<string, unknown>[],
    rawEnvironments: Record<string, unknown>[],
    overrides: Partial<MachineView> = {},
  ): MachineView {
    const backendId = node as BackendId;
    const environmentsByProject = new Map<string, FederatedEnvironment[]>();
    rawEnvironments.forEach((raw, index) => {
      const summary = toNodeEnvironmentSummary(backendId, raw, index)!;
      environmentsByProject.set(summary.projectId, [
        ...(environmentsByProject.get(summary.projectId) ?? []),
        summary,
      ]);
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
      projects: rawProjects.map((raw, index) => toNodeProjectSummary(backendId, raw, index)!),
      environmentsByProject,
      ...overrides,
    };
  }

  const bound = machineView("bk_self", "studio", [], [], { bound: true });
  const mbp3 = machineView(
    "bk_mbp3",
    "mbp3",
    [
      { id: "tg", name: "telegram-scraper", gitUrl: "git@github.com:acme/telegram-scraper.git" },
      { id: "ork-3", name: "orkestrator-v2", gitUrl: "https://github.com/acme/orkestrator-v2.git" },
    ],
    [
      {
        id: "run",
        projectId: "ork-3",
        name: "run-desktop-app",
        branch: "run-desktop-app",
        status: "running",
        lastActivityAt: "2026-09-12T00:00:00.000Z",
      },
      { id: "home", projectId: "ork-3", name: "orkestrator-v2", projectHome: true },
    ],
  );
  const mini = machineView(
    "bk_mini",
    "mini",
    [{ id: "ork-m", name: "orkestrator-v2", gitUrl: "https://github.com/acme/orkestrator-v2.git" }],
    [],
  );

  function sources(...machines: MachineView[]) {
    return [
      localSearchSource({
        machine: bound,
        projects,
        environments: [main, feature, docsEnv],
        defaultBranches,
      }),
      ...machines.map(machineSearchSource),
    ];
  }

  function search(
    query: string,
    options: Partial<Parameters<typeof searchProjectsAndEnvironments>[0]> = {},
  ) {
    return searchProjectsAndEnvironments({
      query,
      filter: "all",
      sources: sources(mbp3, mini),
      recentKeys: [],
      ...options,
    });
  }

  const local = (id: string) => projectKey(projectRef(selfId, id));
  const remote = (machine: MachineView, id: string) =>
    projectKey(projectRef(machine.backendId, id));

  test("finds a project that exists only on another machine, even with no environments", () => {
    const results = search("tel");
    expect(results.projects.map((hit) => [hit.project.name, hit.machine?.name])).toEqual([
      ["telegram-scraper", "mbp3"],
    ]);
    expect(results.projects[0]!.environmentCount).toBe(0);
    expect(results.projects[0]!.id).toBe("bk_mbp3:tg");
    expect(results.incomplete).toBe(false);
  });

  test("a project on several machines is one row per machine; project homes stay rowless", () => {
    const results = search("orkestrator");
    expect(results.projects.map((hit) => hit.machine?.name)).toEqual(["studio", "mbp3", "mini"]);
    expect(new Set(results.projects.map((hit) => hit.id)).size).toBe(3);
    expect(results.projects.map((hit) => hit.environmentCount)).toEqual([2, 1, 0]);
    expect(
      results.environments.map((hit) => `${hit.machine?.name}/${hit.environment.name}`),
    ).toEqual(["studio/main", "mbp3/run-desktop-app", "studio/build-modal-steps"]);
  });

  test("type and machine filters cover every machine", () => {
    expect(search("orkestrator", { filter: "projects" }).environments).toEqual([]);
    expect(search("orkestrator", { filter: "environments" }).projects).toEqual([]);
    expect(
      search("orkestrator", { machineFilter: THIS_MACHINE }).projects.map(
        (hit) => hit.machine?.name,
      ),
    ).toEqual(["studio"]);
    const onMbp3 = search("orkestrator", { machineFilter: "bk_mbp3" });
    expect(onMbp3.projects.map((hit) => hit.machine?.name)).toEqual(["mbp3"]);
    expect(onMbp3.environments.map((hit) => hit.environment.name)).toEqual(["run-desktop-app"]);
    expect(search("tel", { machineFilter: "bk_mini" }).projects).toEqual([]);
    expect(search("orkestrator", { machineFilter: ALL_MACHINES }).projects).toHaveLength(3);
  });

  test("ranks most recently used first across machines, then by match quality", () => {
    // "orkestrator" is an exact match on every machine; mini's copy was used last.
    const results = search("orkestrator-v2", {
      recentKeys: [remote(mini, "ork-m"), local("p-ork")],
    });
    expect(results.projects.map((hit) => hit.machine?.name)).toEqual(["mini", "studio", "mbp3"]);
    // A recent prefix match outranks an exact match that was not used.
    const prefix = search("orkestrator", { recentKeys: [remote(mbp3, "ork-3")] });
    expect(prefix.projects[0]!.machine?.name).toBe("mbp3");
    // Recency is per machine: using mbp3's copy does not lift mini's.
    expect(prefix.projects.map((hit) => hit.machine?.name)).toEqual(["mbp3", "studio", "mini"]);
    // Recent environments go first too, by their node-qualified key.
    const environments = search("", {
      recentKeys: [environmentKey(environmentRef(mbp3.backendId, "run"))],
    }).environments;
    expect(environments[0]!.environment.name).toBe("run-desktop-app");
  });

  test("the empty-query recent list includes other machines' recently used projects", () => {
    const results = search("", { recentKeys: [remote(mbp3, "tg"), local("p-docs")] });
    expect(results.projects.slice(0, 2).map((hit) => hit.project.name)).toEqual([
      "telegram-scraper",
      "docs",
    ]);
    expect(results.projects.length).toBeLessThanOrEqual(8);
  });

  test("keeps offline, stale and loading machines' last-known rows, flagged incomplete", () => {
    const offline = { ...mbp3, transport: "unreachable" as const, freshness: "stale" as const };
    const stale = { ...mini, freshness: "stale" as const };
    const results = searchProjectsAndEnvironments({
      query: "orkestrator",
      filter: "all",
      sources: sources(offline, stale),
      recentKeys: [],
    });
    expect(results.projects.map((hit) => [hit.machine?.name, hit.availability])).toEqual([
      ["studio", "live"],
      ["mbp3", "offline"],
      ["mini", "stale"],
    ]);
    expect(results.incomplete).toBe(true);
    const loading = machineView("bk_new", "new", [], [], {
      freshness: "initializing",
      loadedAt: null,
    });
    expect(machineAvailability(loading)).toBe("loading");
    expect(
      searchProjectsAndEnvironments({
        query: "anything",
        filter: "all",
        sources: sources(loading),
        recentKeys: [],
      }).incomplete,
    ).toBe(true);
    const truncated = { ...mini, truncated: true };
    expect(search("x", { sources: sources(truncated) }).incomplete).toBe(true);
    // A machine outside the machine filter does not make the results incomplete.
    expect(
      searchProjectsAndEnvironments({
        query: "orkestrator",
        filter: "all",
        machineFilter: THIS_MACHINE,
        sources: sources(offline),
        recentKeys: [],
      }).incomplete,
    ).toBe(false);
  });

  for (const transport of ["unreachable", "authentication-required"] as const) {
    test(`${transport} machines with current summaries retain offline rows and mark results incomplete`, () => {
      const unavailable = { ...mbp3, transport };
      const results = search("orkestrator", { sources: sources(unavailable) });
      expect(unavailable.freshness).toBe("current");
      expect(results.projects.map((hit) => [hit.machine?.name, hit.availability])).toEqual([
        ["studio", "live"],
        ["mbp3", "offline"],
      ]);
      expect(results.environments.find((hit) => hit.machine === unavailable)?.availability).toBe(
        "offline",
      );
      expect(results.incomplete).toBe(true);
      expect(
        search("", { sources: sources(unavailable), machineFilter: THIS_MACHINE }).incomplete,
      ).toBe(false);
      expect(
        search("", { sources: sources({ ...unavailable, transport: "connected" }) }).incomplete,
      ).toBe(false);
    });
  }

  test("degraded summaries are stale and connected catching-up summaries are loading", () => {
    const degraded = { ...mbp3, freshness: "degraded" as const };
    const catchingUp = { ...mini, freshness: "catching-up" as const };
    expect(machineAvailability(degraded)).toBe("stale");
    expect(machineAvailability(catchingUp)).toBe("loading");
    const results = search("orkestrator", { sources: sources(degraded, catchingUp) });
    expect(results.projects.map((hit) => hit.availability)).toEqual(["live", "stale", "loading"]);
    expect(results.incomplete).toBe(true);
    expect(
      search("", { sources: sources(degraded, catchingUp), machineFilter: THIS_MACHINE })
        .incomplete,
    ).toBe(false);
  });

  test("remote rows match on exactly the fields local rows match on", () => {
    const rawProject = {
      id: "p-parity",
      name: "parity-app",
      gitUrl: "git@github.com:widgets-inc/parity-repo.git",
      localPath: "/Users/someone/src/parity-checkout",
      addedAt: "2026-01-01T00:00:00.000Z",
      order: 0,
    };
    const rawEnvironment = {
      id: "e-parity",
      projectId: "p-parity",
      name: "fix-login",
      branch: "feature/login-flow",
      status: "stopped" as const,
      environmentType: "containerized" as const,
      worktreePath: "/Users/someone/worktrees/parity-wt",
      createdAt: "2026-01-02T00:00:00.000Z",
      order: 0,
    };
    const localSource = localSearchSource({
      machine: null,
      projects: [project(rawProject)],
      environments: [environment(rawEnvironment)],
      defaultBranches: new Map([["p-parity", "develop"]]),
    });
    const leaf = machineView(
      "bk_leaf",
      "leaf",
      [{ ...rawProject, defaultBranch: "develop" }],
      [rawEnvironment],
    );
    const queries = [
      "parity",
      "parity-app",
      "parity-repo",
      "widgets-inc",
      "widgets-inc/parity-repo",
      "parity-checkout",
      "fix",
      "login-flow",
      "containerized",
      "parity-wt",
      "github",
      "someone",
      "worktrees",
      "develop",
    ];
    const matches = (source: ProjectSearchSource) =>
      queries.map((query) => {
        const results = searchProjectsAndEnvironments({
          query,
          filter: "all",
          sources: [source],
          recentKeys: [],
        });
        return [
          query,
          results.projects.map((hit) => [hit.project.id, hit.score]),
          results.environments.map((hit) => [hit.environment.id, hit.score, hit.isPrimary]),
        ];
      });
    expect(matches(machineSearchSource(leaf))).toEqual(matches(localSource));
    // Hosts, schemes and the rest of a path never match.
    const local = matches(localSource);
    for (const query of ["github", "someone", "worktrees"]) {
      expect(local.find(([candidate]) => candidate === query)).toEqual([query, [], []]);
    }
  });

  test("an older leaf's summary matches on what it sends", () => {
    // Summaries from before pathName, worktreeName, defaultBranch and createdAt.
    const older = machineView(
      "bk_old",
      "old",
      [{ id: "p", name: "legacy", gitUrl: "https://github.com/acme/legacy-repo.git" }],
      [{ id: "e", projectId: "p", name: "main", branch: "main", status: "weird-status" }],
    );
    for (const field of ["pathName", "defaultBranch"] as const) {
      expect(older.projects[0]![field]).toBeUndefined();
    }
    const source = machineSearchSource(older);
    const results = searchProjectsAndEnvironments({
      query: "legacy-repo",
      filter: "all",
      sources: [source],
      recentKeys: [],
    });
    expect(results.projects.map((hit) => hit.project.name)).toEqual(["legacy"]);
    expect(results.environments[0]!.isPrimary).toBe(true);
    // An unknown owner status shows as stopped rather than breaking the row.
    expect(results.environments[0]!.environment.status).toBe("stopped");
    expect(results.environments[0]!.environment.createdAt).toBeUndefined();
  });

  test("keeps the result limits for the merged list", () => {
    const many = machineView(
      "bk_many",
      "many",
      Array.from({ length: 60 }, (_, index) => ({ id: `p${index}`, name: `bulk-${index}` })),
      [],
    );
    expect(search("bulk", { sources: sources(many) }).projects).toHaveLength(50);
    expect(search("", { sources: sources(many) }).projects).toHaveLength(8);
  });
});
