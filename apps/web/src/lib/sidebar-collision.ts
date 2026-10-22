import { closestCenter, type ClientRect, type CollisionDetection } from "@dnd-kit/core";

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
 * and its members) both contain the pointer, so the smallest one wins. With no
 * pointer — the keyboard sensor — centres are compared as before.
 */
export const sidebarCollisionDetection: CollisionDetection = (args) => {
  const activeContainer = args.active.data.current?.sortable?.containerId;
  const droppableContainers = args.droppableContainers.filter((container) => {
    const containerId = container.data.current?.sortable?.containerId;
    return containerId === undefined || containerId === activeContainer;
  });

  const pointer = args.pointerCoordinates;
  if (!pointer) return closestCenter({ ...args, droppableContainers });

  let best: {
    id: (typeof droppableContainers)[number]["id"];
    distance: number;
    area: number;
  } | null = null;
  for (const container of droppableContainers) {
    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;
    const distance = distanceToRect(pointer, rect);
    const area = rect.width * rect.height;
    if (!best || distance < best.distance || (distance === best.distance && area < best.area)) {
      best = { id: container.id, distance, area };
    }
  }
  return best ? [{ id: best.id }] : [];
};

function distanceToRect(point: { x: number; y: number }, rect: ClientRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}
