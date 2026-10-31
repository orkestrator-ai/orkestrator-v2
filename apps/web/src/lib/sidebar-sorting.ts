import type { ClientRect, UniqueIdentifier } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";
import {
  PROJECT_FOLDER_ID_PREFIX,
  parseProjectFolderDragId,
  type ProjectTreeEntry,
} from "@/lib/project-folders";

/**
 * Sorting strategy for a sidebar project list whose folders contain their
 * members.
 *
 * A folder and its visible members are registered in one flat sortable list,
 * but the folder's node wraps its members. `verticalListSortingStrategy`
 * assumes sibling rows that do not overlap: it measured the gap between a
 * folder and its first member as minus the members' height, and it shifted a
 * member on top of the shift its folder already carried. Dragging over an
 * expanded folder therefore piled rows onto each other.
 *
 * Here a member's shift is relative to its folder, so members ride along with
 * their folder, and the preview follows what the drop resolves to:
 * - a project over a folder heading lands inside the folder, which highlights
 *   itself, so no row moves;
 * - a project over a project opens a gap where the flat order puts it, inside
 *   a folder or outside one (or, without `crossFolderMoves`, only among the
 *   project's own siblings);
 * - a folder moves as one block past whole entries; a member of a folder is
 *   not a place it can go.
 *
 * `items` must be the ids given to the `SortableContext`, built from `entries`.
 */
export function projectTreeSortingStrategy<P extends { id: string }>(
  entries: readonly ProjectTreeEntry<P>[],
  items: readonly UniqueIdentifier[],
  { crossFolderMoves = true }: { crossFolderMoves?: boolean } = {},
): SortingStrategy {
  const folderOf = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "folder") continue;
    const folderId = `${PROJECT_FOLDER_ID_PREFIX}${entry.key}`;
    for (const project of entry.projects) folderOf.set(project.id, folderId);
  }
  const indexOf = new Map(items.map((id, index) => [String(id), index]));
  // Index of each row's folder, or -1 for a root row (or a collapsed member,
  // which is not in `items` at all).
  const parent = items.map((id) => {
    const folderId = folderOf.get(String(id));
    return folderId === undefined ? -1 : (indexOf.get(folderId) ?? -1);
  });
  const isFolder = items.map((id) => parseProjectFolderDragId(String(id)) !== null);
  // Last row of each row's block: a folder's last visible member, else itself.
  const blockEnd = items.map((_, index) => {
    let end = index;
    while (parent[end + 1] === index) end += 1;
    return end;
  });

  const bottom = (rect: ClientRect) => rect.top + rect.height;

  return ({ activeIndex, overIndex, index, rects, activeNodeRect }) => {
    const activeRect = rects[activeIndex] ?? activeNodeRect;
    const overRect = rects[overIndex];
    if (!activeRect || !overRect) return null;
    const height = activeRect.height;

    const folderShift = (row: number): number => {
      if (parent[overIndex] !== -1) return 0;
      const activeEnd = blockEnd[activeIndex]!;
      const inActive = row === activeIndex || parent[row] === activeIndex;
      if (overIndex > activeEnd) {
        if (inActive) return bottom(overRect) - bottom(activeRect);
        return row > activeEnd && row <= blockEnd[overIndex]! ? -height : 0;
      }
      if (overIndex < activeIndex) {
        if (inActive) return overRect.top - activeRect.top;
        return row >= overIndex && row < activeIndex ? height : 0;
      }
      return 0;
    };

    const projectShift = (row: number): number => {
      if (activeIndex === overIndex || isFolder[overIndex]) return 0;
      if (!crossFolderMoves && parent[overIndex] !== parent[activeIndex]) return 0;
      if (row === activeIndex) {
        return activeIndex < overIndex
          ? bottom(overRect) - bottom(activeRect)
          : overRect.top - activeRect.top;
      }
      if (row > activeIndex && row <= overIndex) return -height;
      if (row < activeIndex && row >= overIndex) return height;
      return 0;
    };

    const shift = isFolder[activeIndex] ? folderShift : projectShift;
    const host = parent[index]!;
    const y = shift(index) - (host === -1 ? 0 : shift(host));
    return { x: 0, y, scaleX: 1, scaleY: 1 };
  };
}
