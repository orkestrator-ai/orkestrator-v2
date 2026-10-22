import { describe, expect, test } from "bun:test";
import type { ClientRect } from "@dnd-kit/core";
import { sidebarCollisionDetection } from "@/lib/sidebar-collision";
import { PROJECT_ROOT_DROP_ID } from "@/lib/project-folders";

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
    expect(overId(layout("env-a3", "envs-a", { x: 40, y: 10 }))).toBe("env-a1");
    expect(overId(layout("env-a3", "envs-a", { x: 40, y: 160 }))).toBe("env-a3");
  });

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
