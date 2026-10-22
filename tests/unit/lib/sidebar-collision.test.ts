import { describe, expect, test } from "bun:test";
import type { ClientRect } from "@dnd-kit/core";
import { sidebarCollisionDetection } from "@/lib/sidebar-collision";
import {
  PROJECT_ROOT_DROP_ID,
  projectFolderDragId,
  resolveProjectArrangement,
} from "@/lib/project-folders";
import { resolveRepositoryArrangement, type MergedProject } from "@/lib/federation/sidebar-layout";

type Args = Parameters<typeof sidebarCollisionDetection>[0];

const PROJECTS = "projects";

function rect(top: number, height: number): ClientRect {
  return { top, left: 0, right: 240, bottom: top + height, width: 240, height };
}

function droppable(id: string, containerId: string | undefined) {
  return {
    id,
    data: { current: containerId === undefined ? undefined : { sortable: { containerId } } },
  };
}

/**
 * Two expanded projects, each a 28px header over three 24px environment rows,
 * so a group's centre sits well below its name.
 */
function layout(
  activeId: string,
  activeContainer: string,
  pointer: { x: number; y: number } | null,
) {
  const entries: Array<[string, string | undefined, ClientRect]> = [
    ["project-a", PROJECTS, rect(0, 100)],
    ["env-a1", "envs-a", rect(28, 24)],
    ["env-a2", "envs-a", rect(52, 24)],
    ["env-a3", "envs-a", rect(76, 24)],
    ["project-b", PROJECTS, rect(100, 100)],
    ["env-b1", "envs-b", rect(128, 24)],
    ["env-b2", "envs-b", rect(152, 24)],
    ["env-b3", "envs-b", rect(176, 24)],
  ];
  return {
    active: {
      id: activeId,
      data: { current: { sortable: { containerId: activeContainer } } },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: rect((pointer?.y ?? 0) - 16, 32),
    droppableRects: new Map(entries.map(([id, , r]) => [id, r])),
    droppableContainers: entries.map(([id, containerId]) => droppable(id, containerId)),
    pointerCoordinates: pointer,
  } as unknown as Args;
}

const overId = (args: Args) => sidebarCollisionDetection(args)[0]?.id;

describe("sidebarCollisionDetection", () => {
  test("dropping a project's name on the expanded project above targets that project", () => {
    expect(overId(layout("project-b", PROJECTS, { x: 40, y: 14 }))).toBe("project-a");
  });

  test("a project drag over another project's environments still targets the project", () => {
    expect(overId(layout("project-b", PROJECTS, { x: 40, y: 60 }))).toBe("project-a");
  });

  test("an environment drag only targets environments of its own project", () => {
    expect(overId(layout("env-a3", "envs-a", { x: 40, y: 30 }))).toBe("env-a1");
    expect(overId(layout("env-a3", "envs-a", { x: 40, y: 10 }))).toBeUndefined();
    expect(overId(layout("env-a3", "envs-a", { x: 40, y: 160 }))).toBeUndefined();
  });

  test("a non-boundary environment over another project cannot snap to a source sibling", () => {
    expect(overId(layout("env-a1", "envs-a", { x: 40, y: 160 }))).toBeUndefined();
    expect(overId(layout("env-a2", "envs-a", { x: 40, y: 160 }))).toBeUndefined();
    expect(overId(layout("env-a2", "envs-a", { x: 300, y: 60 }))).toBeUndefined();
    expect(overId(layout("env-a2", "envs-a", { x: 40, y: 210 }))).toBeUndefined();
  });

  for (const repository of [false, true]) {
    test(`${repository ? "repository groups" : "folders"} move as blocks over expanded members`, () => {
      const source = repository ? "github.com/acme/source" : "Source";
      const target = repository ? "github.com/acme/target" : "Target";
      const sourceId = repository ? `project-folder:${source}` : projectFolderDragId(source);
      const targetId = repository ? `project-folder:${target}` : projectFolderDragId(target);
      const args = layout(sourceId, PROJECTS, { x: 40, y: 160 });
      args.active.data.current!.sidebarGroup = true;
      for (const [id, top] of [
        [sourceId, 0],
        [targetId, 100],
      ] as const) {
        args.droppableRects.set(id, rect(top, 120));
        args.droppableContainers.push(droppable(id, PROJECTS) as never);
      }
      const targetHit = overId(args);
      expect(targetHit).toBe(targetId);
      const projects = [
        { id: "project-a", name: "A", folder: source },
        { id: "project-d", name: "D", folder: source },
        { id: "project-b", name: "B", folder: target },
        { id: "project-c", name: "C", folder: target },
      ];
      const arrangement = repository
        ? resolveRepositoryArrangement(sourceId, String(targetHit), projects as MergedProject[])
        : resolveProjectArrangement(sourceId, String(targetHit), projects);
      expect(arrangement).toEqual({
        projectIds: ["project-b", "project-c", "project-a", "project-d"],
        folders: {},
      });
      expect(projects.map((project) => project.folder)).toEqual([source, source, target, target]);
    });
  }

  test("nested rows resolve to the innermost one under the pointer", () => {
    const args = layout("project-b", PROJECTS, { x: 40, y: 160 });
    args.droppableRects.set("project-folder:work", rect(100, 200));
    args.droppableContainers.push(droppable("project-folder:work", PROJECTS) as never);
    expect(overId(args)).toBe("project-b");
  });

  test("plain droppables such as the root drop zone stay targets", () => {
    const args = layout("project-a", PROJECTS, { x: 40, y: 250 });
    args.droppableRects.set(PROJECT_ROOT_DROP_ID, rect(220, 64));
    args.droppableContainers.push(droppable(PROJECT_ROOT_DROP_ID, undefined) as never);
    expect(overId(args)).toBe(PROJECT_ROOT_DROP_ID);
  });

  test("keyboard drags without a pointer fall back to centres within the same list", () => {
    expect(overId(layout("project-b", PROJECTS, null))).toBe("project-a");
  });
});
