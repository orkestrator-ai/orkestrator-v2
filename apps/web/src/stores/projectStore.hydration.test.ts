import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { Project } from "@/types";
import { projectStore, type ProjectState } from "./projectStore";

const NODE_A = "bk_project-store-a" as BackendId;
const NODE_B = "bk_project-store-b" as BackendId;

let windowScope: WindowScope;
/** NODE_A's instance; the tests name their scope, as converted code does. */
let projects: StoreApi<ProjectState>;

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    gitUrl: `https://example.test/${id}.git`,
    localPath: null,
    addedAt: "2026-11-07T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

beforeEach(() => {
  windowScope = new WindowScope();
  projects = windowScope
    .open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) })
    .store(projectStore);
});

afterEach(() => windowScope.dispose());

test("empty successful snapshots are loaded, while the initial idle store and stale snapshots are not", () => {
  expect(projects.getState().hasLoaded).toBe(false);
  const stale = projects.getState().getMutationVersion();
  projects.getState().invalidateSnapshots();
  expect(projects.getState().applySnapshot([], stale)).toBe(false);
  expect(projects.getState().hasLoaded).toBe(false);
  expect(projects.getState().applySnapshot([], projects.getState().getMutationVersion())).toBe(
    true,
  );
  expect(projects.getState().hasLoaded).toBe(true);
});

test("a local mutation makes a snapshot read started before it stale", () => {
  const before = projects.getState().getMutationVersion();
  projects.getState().addProject(project("p-1"));
  expect(projects.getState().applySnapshot([], before)).toBe(false);
  expect(projects.getState().projects.map(({ id }) => id)).toEqual(["p-1"]);
});

describe("projectStore per node", () => {
  test("two scopes holding the same project id do not collide", () => {
    const leaf = windowScope
      .open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) })
      .store(projectStore);
    projects.getState().setProjects([project("p-1", { name: "on-a" })]);
    leaf.getState().setProjects([project("p-1", { name: "on-b" })]);

    leaf.getState().updateProject("p-1", { name: "renamed-on-b" });
    leaf.getState().setDeleting("p-1", true);

    expect(projects.getState().getProjectById("p-1")?.name).toBe("on-a");
    expect(projects.getState().deletingProjects.has("p-1")).toBe(false);
    expect(leaf.getState().getProjectById("p-1")?.name).toBe("renamed-on-b");
  });

  test("snapshot versions are per node: a mutation on one node never stales another's read", () => {
    const leaf = windowScope
      .open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) })
      .store(projectStore);
    const readOnA = projects.getState().getMutationVersion();
    leaf.getState().invalidateSnapshots();
    leaf.getState().addProject(project("p-b"));

    expect(projects.getState().applySnapshot([project("p-a")], readOnA)).toBe(true);
    expect(projects.getState().projects.map(({ id }) => id)).toEqual(["p-a"]);
    expect(leaf.getState().projects.map(({ id }) => id)).toEqual(["p-b"]);
  });
});
