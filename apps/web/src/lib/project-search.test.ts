import { describe, expect, test } from "bun:test";
import type { Environment, Project } from "@/types";
import {
  buildProjectSearchResults,
  flattenProjectSearchResults,
  nextProjectSearchFilter,
  previousProjectSearchFilter,
} from "./project-search";

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
