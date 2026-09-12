import type { FileNode } from "@/lib/backend";

export function collectVisibleFilePaths(
  nodes: FileNode[],
  expandedFolders: ReadonlySet<string> | readonly string[],
): string[] {
  const expanded = expandedFolders instanceof Set ? expandedFolders : new Set(expandedFolders);
  const paths: string[] = [];

  const visit = (items: FileNode[]) => {
    for (const node of items) {
      if (node.isDirectory) {
        if (expanded.has(node.path) && node.children) {
          visit(node.children);
        }
        continue;
      }
      paths.push(node.path);
    }
  };

  visit(nodes);
  return paths;
}

export function collectAllFilePaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) =>
    node.isDirectory ? collectAllFilePaths(node.children ?? []) : [node.path],
  );
}

export type FileSelectionResult =
  | { type: "single"; path: string }
  | { type: "add"; path: string }
  | { type: "remove"; path: string }
  | { type: "range"; paths: string[] };

export function resolveFileSelection(
  path: string,
  modifiers: { shiftKey?: boolean; metaKey?: boolean },
  visiblePaths: readonly string[],
  anchorPath: string | null,
  selectedPaths: readonly string[] = [],
): FileSelectionResult {
  if (modifiers.shiftKey) {
    const clickedIndex = visiblePaths.indexOf(path);
    if (clickedIndex === -1) {
      return { type: "single", path };
    }
    if (!anchorPath) {
      return { type: "range", paths: [path] };
    }
    const anchorIndex = visiblePaths.indexOf(anchorPath);
    if (anchorIndex === -1) {
      return { type: "range", paths: [path] };
    }
    const start = Math.min(anchorIndex, clickedIndex);
    const end = Math.max(anchorIndex, clickedIndex);
    return { type: "range", paths: visiblePaths.slice(start, end + 1) };
  }

  if (modifiers.metaKey) {
    // Additive click toggles: a second Command/Control click removes the file
    // so the user can correct a mis-click without opening or rebuilding the
    // whole selection.
    return selectedPaths.includes(path) ? { type: "remove", path } : { type: "add", path };
  }

  return { type: "single", path };
}

export function encodeWorkspaceFileDrag(paths: readonly string[]): string {
  return JSON.stringify(paths);
}

export function decodeWorkspaceFileDrag(data: string): string[] {
  if (!data) return [];
  try {
    const parsed: unknown = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed.filter((item) => item.length > 0);
    }
  } catch {
    // Legacy single-path payloads are plain strings, not JSON.
  }
  return [data];
}

export function pathsForFileAction(
  clickedPath: string,
  selectedPaths: ReadonlySet<string>,
): string[] {
  if (selectedPaths.has(clickedPath) && selectedPaths.size > 1) {
    return Array.from(selectedPaths);
  }
  return [clickedPath];
}
