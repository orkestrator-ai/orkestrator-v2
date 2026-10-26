import type { FileNode, FileSubtree } from "@/lib/backend";

/**
 * The file tree is read with a node budget, so a large workspace leaves deeper
 * directories `truncated`. The panel reads such a directory when it is
 * expanded; these helpers graft those reads onto the bounded tree.
 */

function depthOf(path: string): number {
  return path.split("/").length;
}

function graftSubtree(nodes: FileNode[], directory: string, subtree: FileSubtree): FileNode[] {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (!node.isDirectory) continue;
    if (node.path === directory) {
      // A tree that now lists the directory in full is newer than the read.
      if (!node.truncated) return nodes;
      const { truncated: _truncated, ...rest } = node;
      const next = nodes.slice();
      next[index] = subtree.truncated
        ? { ...rest, children: subtree.children, truncated: true }
        : { ...rest, children: subtree.children };
      return next;
    }
    if (node.children && directory.startsWith(`${node.path}/`)) {
      const children = graftSubtree(node.children, directory, subtree);
      if (children === node.children) return nodes;
      const next = nodes.slice();
      next[index] = { ...node, children };
      return next;
    }
  }
  return nodes;
}

/**
 * Graft loaded directory contents onto `tree`, ancestors before descendants.
 * A load whose directory is not (or no longer) a truncated node is ignored.
 * Returns `tree` itself when nothing applies.
 */
export function mergeFileSubtrees(
  tree: FileNode[],
  subtrees: Readonly<Record<string, FileSubtree>>,
): FileNode[] {
  const directories = Object.keys(subtrees);
  if (directories.length === 0) return tree;
  directories.sort((a, b) => depthOf(a) - depthOf(b));
  let merged = tree;
  for (const directory of directories) {
    merged = graftSubtree(merged, directory, subtrees[directory]!);
  }
  return merged;
}

/** Expanded directories reachable through expanded ancestors. */
export function expandedDirectories(
  tree: FileNode[],
  expandedFolders: ReadonlySet<string>,
  truncatedOnly = false,
): string[] {
  const result: string[] = [];
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (!node.isDirectory || !expandedFolders.has(node.path)) continue;
      if (!truncatedOnly || node.truncated) result.push(node.path);
      if (node.children) visit(node.children);
    }
  };
  visit(tree);
  return result;
}

/** Expanded truncated directories reachable through expanded ancestors. */
export function expandedTruncatedDirectories(
  tree: FileNode[],
  expandedFolders: ReadonlySet<string>,
): string[] {
  return expandedDirectories(tree, expandedFolders, true);
}
