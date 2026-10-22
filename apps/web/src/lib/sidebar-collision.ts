import { closestCenter, type CollisionDetection } from "@dnd-kit/core";

/**
 * Collision detection for the sidebar's nested sortable lists.
 *
 * Projects and their environments share one `DndContext`, so `closestCenter`
 * on its own lets an environment row win a project drag (and a project group
 * win an environment drag). The resolvers treat either mismatch as a no-op,
 * which is why dropping a project's name on the one above used to do nothing
 * whenever that project was expanded. Candidates are therefore limited to the
 * dragged row's own sortable list, plus plain droppables such as the root
 * drop zone.
 *
 * Among those, the row under the pointer wins. A project's droppable spans its
 * header and every environment below it, so comparing centres would favour a
 * neighbour over a tall group the pointer is plainly on. Nested rows (a folder
 * and its members) both contain the pointer: project drags prefer the smallest
 * row, while whole-group drags prefer the enclosing group. A pointer outside
 * all candidates has no target, so cross-project environment drops stay no-ops.
 * With no pointer — the keyboard sensor — centres are compared as before.
 */
export const sidebarCollisionDetection: CollisionDetection = (args) => {
  const activeContainer = args.active.data.current?.sortable?.containerId;
  const droppableContainers = args.droppableContainers.filter((container) => {
    const containerId = container.data.current?.sortable?.containerId;
    return containerId === undefined || containerId === activeContainer;
  });

  const pointer = args.pointerCoordinates;
  if (!pointer) return closestCenter({ ...args, droppableContainers });

  const draggingGroup = args.active.data.current?.sidebarGroup === true;
  let best: {
    id: (typeof droppableContainers)[number]["id"];
    area: number;
  } | null = null;
  for (const container of droppableContainers) {
    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;
    if (
      pointer.x < rect.left ||
      pointer.x > rect.right ||
      pointer.y < rect.top ||
      pointer.y > rect.bottom
    )
      continue;
    const area = rect.width * rect.height;
    if (!best || (draggingGroup ? area > best.area : area < best.area)) {
      best = { id: container.id, area };
    }
  }
  return best ? [{ id: best.id }] : [];
};
