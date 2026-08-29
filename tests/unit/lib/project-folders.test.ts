import { describe, expect, test } from "bun:test";
import type { Project } from "@/types";
import {
  PROJECT_ROOT_DROP_ID,
  buildProjectTree,
  flattenProjectTree,
  isProjectFolderCollapsed,
  parseProjectFolderDragId,
  projectFolderDragId,
  projectSortableIds,
  resolveAddProjectToFolder,
  resolveProjectArrangement,
  resolveRemoveProjectFromFolder,
  resolveRenameProjectFolder,
  resolveUngroupProjectFolder,
} from "@/lib/project-folders";

function makeProject(id: string, order: number, folder?: string | null): Project {
  return {
    id,
    name: id,
    gitUrl: `https://github.com/acme/${id}.git`,
    localPath: null,
    addedAt: "2024-01-01T00:00:00.000Z",
    order,
    ...(folder === undefined ? {} : { folder }),
  };
}

const alpha = makeProject("alpha", 0);
const beta = makeProject("beta", 1);
const gamma = makeProject("gamma", 2);

describe("buildProjectTree", () => {
  test("leaves unfoldered projects at the root in order", () => {
    expect(buildProjectTree([alpha, beta])).toEqual([
      { kind: "project", project: alpha },
      { kind: "project", project: beta },
    ]);
  });

  test("places a folder at the position of its first member", () => {
    const tree = buildProjectTree([alpha, makeProject("beta", 1, "Work"), gamma]);
    expect(tree.map((entry) => (entry.kind === "folder" ? entry.name : entry.project.id))).toEqual([
      "alpha",
      "Work",
      "gamma",
    ]);
  });

  test("collects members that are not adjacent, and folds differing spellings into one folder", () => {
    const tree = buildProjectTree([
      makeProject("alpha", 0, "Work"),
      beta,
      makeProject("gamma", 2, "WORK"),
    ]);
    expect(tree).toHaveLength(2);
    const folder = tree[0];
    expect(folder?.kind).toBe("folder");
    if (folder?.kind !== "folder") throw new Error("expected a folder entry");
    expect(folder.name).toBe("Work");
    expect(folder.projects.map((project) => project.id)).toEqual(["alpha", "gamma"]);
  });

  test("flattening reports the order the tree actually renders", () => {
    const projects = [makeProject("alpha", 0, "Work"), beta, makeProject("gamma", 2, "Work")];
    expect(flattenProjectTree(buildProjectTree(projects)).map(({ id }) => id)).toEqual([
      "alpha",
      "gamma",
      "beta",
    ]);
  });
});

describe("folder drag ids", () => {
  test("round-trips a folder name through its drag id", () => {
    expect(parseProjectFolderDragId(projectFolderDragId("Work"))).toBe("work");
  });

  test("reports a project id as not a folder", () => {
    expect(parseProjectFolderDragId("alpha")).toBeNull();
  });
});

describe("projectSortableIds", () => {
  const projects = [makeProject("alpha", 0, "Work"), makeProject("beta", 1, "Work"), gamma];

  test("registers folder members while the folder is expanded", () => {
    expect(projectSortableIds(buildProjectTree(projects), [])).toEqual([
      projectFolderDragId("Work"),
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  test("omits members of a collapsed folder, which have no visible row", () => {
    expect(projectSortableIds(buildProjectTree(projects), ["work"])).toEqual([
      projectFolderDragId("Work"),
      "gamma",
    ]);
  });

  test("matches a collapsed folder regardless of spelling", () => {
    expect(isProjectFolderCollapsed(["WORK"], "work")).toBe(true);
    expect(isProjectFolderCollapsed(["Work"], "Play")).toBe(false);
  });
});

describe("resolveAddProjectToFolder", () => {
  test("creates a folder in the project's own slot without moving anything", () => {
    const arrangement = resolveAddProjectToFolder([alpha, beta, gamma], "beta", "Work");
    expect(arrangement).toEqual({
      projectIds: ["alpha", "beta", "gamma"],
      folders: { beta: "Work" },
    });
    const tree = buildProjectTree([alpha, { ...beta, folder: "Work" }, gamma]);
    expect(tree.map((entry) => (entry.kind === "folder" ? entry.name : entry.project.id))).toEqual([
      "alpha",
      "Work",
      "gamma",
    ]);
  });

  test("moves the project beside the members of a folder that already exists", () => {
    const projects = [makeProject("alpha", 0, "Work"), beta, gamma];
    expect(resolveAddProjectToFolder(projects, "gamma", "work")).toEqual({
      projectIds: ["alpha", "gamma", "beta"],
      folders: { gamma: "Work" },
    });
  });

  test("reports a blank name, an unknown project, and a no-op re-add as nothing to do", () => {
    expect(resolveAddProjectToFolder([alpha], "alpha", "   ")).toBeNull();
    expect(resolveAddProjectToFolder([alpha], "missing", "Work")).toBeNull();
    expect(
      resolveAddProjectToFolder([makeProject("alpha", 0, "Work")], "alpha", "WORK"),
    ).toBeNull();
  });
});

describe("resolveProjectArrangement", () => {
  test("moving a project onto another project reorders at the root", () => {
    expect(resolveProjectArrangement("alpha", "beta", [alpha, beta, gamma])).toEqual({
      projectIds: ["beta", "alpha", "gamma"],
      folders: {},
    });
  });

  test("dropping a project on a folder header files it at the head of that folder", () => {
    const projects = [makeProject("alpha", 0, "Work"), beta, gamma];
    expect(resolveProjectArrangement("gamma", projectFolderDragId("Work"), projects)).toEqual({
      projectIds: ["gamma", "alpha", "beta"],
      folders: { gamma: "Work" },
    });
  });

  test("dropping onto a member of a folder joins that folder", () => {
    const projects = [makeProject("alpha", 0, "Work"), beta];
    expect(resolveProjectArrangement("beta", "alpha", projects)).toEqual({
      projectIds: ["beta", "alpha"],
      folders: { beta: "Work" },
    });
  });

  test("dropping onto a root project lifts a member back out of its folder", () => {
    const projects = [makeProject("alpha", 0, "Work"), makeProject("beta", 1, "Work"), gamma];
    expect(resolveProjectArrangement("beta", "gamma", projects)).toEqual({
      projectIds: ["alpha", "gamma", "beta"],
      folders: { beta: null },
    });
  });

  test("the root drop zone removes a project from its folder and sends it to the end", () => {
    const projects = [makeProject("alpha", 0, "Work"), makeProject("beta", 1, "Work"), gamma];
    expect(resolveProjectArrangement("alpha", PROJECT_ROOT_DROP_ID, projects)).toEqual({
      projectIds: ["beta", "gamma", "alpha"],
      folders: { alpha: null },
    });
  });

  test("the root drop zone is a no-op for a project already at the root and last", () => {
    expect(
      resolveProjectArrangement("gamma", PROJECT_ROOT_DROP_ID, [alpha, beta, gamma]),
    ).toBeNull();
  });

  test("a folder moves as one block, keeping its members and their membership", () => {
    const projects = [
      alpha,
      makeProject("beta", 1, "Work"),
      makeProject("delta", 2, "Work"),
      gamma,
    ];
    expect(resolveProjectArrangement(projectFolderDragId("Work"), "gamma", projects)).toEqual({
      projectIds: ["alpha", "gamma", "beta", "delta"],
      folders: {},
    });
  });

  test("a folder dropped on its own member is a no-op", () => {
    const projects = [makeProject("alpha", 0, "Work"), beta];
    expect(resolveProjectArrangement(projectFolderDragId("Work"), "alpha", projects)).toBeNull();
  });

  test("unknown, self-referential and unchanged drops resolve to nothing", () => {
    expect(resolveProjectArrangement("alpha", "alpha", [alpha])).toBeNull();
    expect(resolveProjectArrangement("missing", "alpha", [alpha])).toBeNull();
    expect(resolveProjectArrangement("alpha", "missing", [alpha, beta])).toBeNull();
    expect(resolveProjectArrangement(projectFolderDragId("Absent"), "alpha", [alpha])).toBeNull();
    expect(resolveProjectArrangement("alpha", projectFolderDragId("Absent"), [alpha])).toBeNull();
  });
});

describe("folder maintenance arrangements", () => {
  const projects = [makeProject("alpha", 0, "Work"), makeProject("beta", 1, "Work"), gamma];

  test("removing one project from a folder leaves it in place and regroups the rest", () => {
    // "alpha" keeps its slot, so the folder it just left now starts at "beta"
    // and renders immediately below it.
    expect(resolveRemoveProjectFromFolder(projects, "alpha")).toEqual({
      projectIds: ["alpha", "beta", "gamma"],
      folders: { alpha: null },
    });
    expect(resolveRemoveProjectFromFolder(projects, "beta")).toEqual({
      projectIds: ["alpha", "beta", "gamma"],
      folders: { beta: null },
    });
  });

  test("removing a project that has no folder is nothing to do", () => {
    expect(resolveRemoveProjectFromFolder(projects, "gamma")).toBeNull();
    expect(resolveRemoveProjectFromFolder(projects, "missing")).toBeNull();
  });

  test("renaming rewrites every member of the folder", () => {
    expect(resolveRenameProjectFolder(projects, "Work", "  Personal ")).toEqual({
      projectIds: ["alpha", "beta", "gamma"],
      folders: { alpha: "Personal", beta: "Personal" },
    });
  });

  test("renaming to a blank name, an unchanged name, or an absent folder does nothing", () => {
    expect(resolveRenameProjectFolder(projects, "Work", "  ")).toBeNull();
    expect(resolveRenameProjectFolder(projects, "Work", "Work")).toBeNull();
    expect(resolveRenameProjectFolder(projects, "Absent", "Personal")).toBeNull();
  });

  test("ungrouping returns every member to the root", () => {
    expect(resolveUngroupProjectFolder(projects, "work")).toEqual({
      projectIds: ["alpha", "beta", "gamma"],
      folders: { alpha: null, beta: null },
    });
  });

  test("ungrouping a folder nothing belongs to does nothing", () => {
    expect(resolveUngroupProjectFolder(projects, "Absent")).toBeNull();
  });
});
