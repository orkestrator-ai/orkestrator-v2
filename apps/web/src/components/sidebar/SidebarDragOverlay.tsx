import { DragOverlay } from "@dnd-kit/core";
import { Folder, FolderGit2 } from "lucide-react";
import type { MachineView } from "@/lib/federation/aggregate";
import { parseProjectFolderDragId, type ProjectTreeEntry } from "@/lib/project-folders";

/** What is being dragged in a sidebar list, by the name its row shows. */
export type SidebarDragItem = {
  kind: "project" | "folder" | "environment";
  name: string;
} | null;

/**
 * The card that follows the pointer while a project, folder or environment
 * is dragged. Every sidebar list uses it (this window's tree, another
 * machine's tree, the merged lists), so a drag looks the same in each.
 */
export function SidebarDragOverlay({ item }: { item: SidebarDragItem }) {
  return (
    <DragOverlay>
      {item ? (
        <div
          className="rounded-md bg-card border border-border px-3 py-2 shadow-lg"
          data-testid="sidebar-drag-overlay"
        >
          {item.kind === "environment" ? (
            <span className="text-sm">{item.name}</span>
          ) : (
            <div className="flex items-center gap-2">
              {item.kind === "folder" ? (
                <Folder className="h-4 w-4 text-amber-400/80" aria-hidden="true" />
              ) : (
                <FolderGit2 className="h-4 w-4" />
              )}
              <span className="text-sm font-medium">{item.name}</span>
            </div>
          )}
        </div>
      ) : null}
    </DragOverlay>
  );
}

/**
 * The environment a machine list's drag id names: another machine's rows
 * drag by environment key, this window's by its own environment ID.
 */
export function machineEnvironmentDragItem(
  machines: readonly MachineView[],
  id: string,
): SidebarDragItem {
  for (const machine of machines) {
    for (const environments of machine.environmentsByProject.values()) {
      const environment = environments.find(
        (candidate) =>
          candidate.key === id || (machine.bound && candidate.ref.environmentId === id),
      );
      if (environment) return { kind: "environment", name: environment.name };
    }
  }
  return null;
}

/** The folder (or repository group) a drag id names, by the label its header shows. */
export function folderDragItem<P>(
  tree: readonly ProjectTreeEntry<P>[],
  id: string,
  label: (name: string) => string = (name) => name,
): SidebarDragItem {
  const key = parseProjectFolderDragId(id);
  if (key === null) return null;
  for (const entry of tree) {
    if (entry.kind === "folder" && entry.key === key)
      return { kind: "folder", name: label(entry.name) };
  }
  return null;
}
