/**
 * Navigation for a pull request's changed files: the path tree, the search
 * and filters that narrow it, and the order "next unviewed" and "next
 * unresolved" walk. Pure, so the code tab and its tests share one answer.
 */
import type {
  GitHubPullRequestFile,
  GitHubPullRequestReviewThread,
} from "@orkestrator/protocol/github-pull-requests";

export type FileTreeDirectory = {
  kind: "directory";
  /** Shown label; single-child directory chains are joined (`src/lib/util`). */
  name: string;
  /** Full directory path, the key of its collapsed state. */
  path: string;
  children: FileTreeNode[];
  /** Files anywhere below. */
  fileCount: number;
  /** Viewed files anywhere below. */
  viewedCount: number;
  /** Unresolved review conversations on files anywhere below. */
  unresolvedCount: number;
};

export type FileTreeFile = {
  kind: "file";
  name: string;
  path: string;
  file: GitHubPullRequestFile;
  unresolvedCount: number;
};

export type FileTreeNode = FileTreeDirectory | FileTreeFile;

type MutableDirectory = {
  directories: Map<string, MutableDirectory>;
  files: GitHubPullRequestFile[];
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Unresolved conversation count per path. */
export function unresolvedByPath(
  threads: readonly GitHubPullRequestReviewThread[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (!thread.isResolved) counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
  }
  return counts;
}

/**
 * The files as a directory tree: directories before files, each sorted by
 * name, and directories with a single child directory and no files of their
 * own folded into one row.
 */
export function buildFileTree(
  files: readonly GitHubPullRequestFile[],
  unresolved: ReadonlyMap<string, number> = new Map(),
): FileTreeNode[] {
  const root: MutableDirectory = { directories: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let directory = root;
    for (const segment of segments) {
      let child = directory.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }

  const build = (directory: MutableDirectory, prefix: string): FileTreeNode[] => {
    const nodes: FileTreeNode[] = [];
    const directoryNames = Array.from(directory.directories.keys()).sort(collator.compare);
    for (const segment of directoryNames) {
      let name = segment;
      let path = prefix ? `${prefix}/${segment}` : segment;
      let current = directory.directories.get(segment)!;
      while (current.files.length === 0 && current.directories.size === 1) {
        const [childName, child] = current.directories.entries().next().value!;
        name = `${name}/${childName}`;
        path = `${path}/${childName}`;
        current = child;
      }
      const children = build(current, path);
      let fileCount = 0;
      let viewedCount = 0;
      let unresolvedCount = 0;
      for (const child of children) {
        if (child.kind === "directory") {
          fileCount += child.fileCount;
          viewedCount += child.viewedCount;
        } else {
          fileCount += 1;
          if (child.file.viewedState === "viewed") viewedCount += 1;
        }
        unresolvedCount += child.unresolvedCount;
      }
      nodes.push({
        kind: "directory",
        name,
        path,
        children,
        fileCount,
        viewedCount,
        unresolvedCount,
      });
    }
    const sortedFiles = [...directory.files].sort((a, b) =>
      collator.compare(fileName(a.path), fileName(b.path)),
    );
    for (const file of sortedFiles) {
      nodes.push({
        kind: "file",
        name: fileName(file.path),
        path: file.path,
        file,
        unresolvedCount: unresolved.get(file.path) ?? 0,
      });
    }
    return nodes;
  };
  return build(root, "");
}

function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Files in the order the tree shows them, which the list follows too. */
export function treeFileOrder(nodes: readonly FileTreeNode[]): GitHubPullRequestFile[] {
  const files: GitHubPullRequestFile[] = [];
  const walk = (list: readonly FileTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "file") files.push(node.file);
      else walk(node.children);
    }
  };
  walk(nodes);
  return files;
}

export type FileFilters = {
  /** Whitespace-separated terms, each of which must appear in the path. */
  query: string;
  unviewedOnly: boolean;
  unresolvedOnly: boolean;
};

export const NO_FILE_FILTERS: FileFilters = {
  query: "",
  unviewedOnly: false,
  unresolvedOnly: false,
};

export function filtersActive(filters: FileFilters): boolean {
  return filters.query.trim() !== "" || filters.unviewedOnly || filters.unresolvedOnly;
}

/** Case-insensitive: every term of `query` occurs in the path or its previous path. */
export function matchesFileQuery(file: GitHubPullRequestFile, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${file.path}\n${file.previousPath ?? ""}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function fileMatchesFilters(
  file: GitHubPullRequestFile,
  filters: FileFilters,
  unresolved: ReadonlyMap<string, number>,
): boolean {
  if (filters.unviewedOnly && file.viewedState === "viewed") return false;
  if (filters.unresolvedOnly && !unresolved.get(file.path)) return false;
  return matchesFileQuery(file, filters.query);
}

/**
 * The first file after `currentPath` in `files` that `accept` takes, wrapping
 * to the start. With no current path (or one not in the list) the search
 * starts at the top.
 */
export function nextFileAfter(
  files: readonly GitHubPullRequestFile[],
  currentPath: string | null,
  accept: (file: GitHubPullRequestFile) => boolean,
): GitHubPullRequestFile | null {
  if (files.length === 0) return null;
  const current = currentPath === null ? -1 : files.findIndex((file) => file.path === currentPath);
  for (let step = 1; step <= files.length; step++) {
    const file = files[(current + step) % files.length]!;
    if (file.path === currentPath) continue;
    if (accept(file)) return file;
  }
  // Only the current file qualifies.
  const self = current >= 0 ? files[current]! : null;
  return self && accept(self) ? self : null;
}

/**
 * Unresolved conversations on `files`, in file order, then by line (old-side
 * and outdated conversations after placed ones of the same file).
 */
export function unresolvedThreadOrder(
  files: readonly GitHubPullRequestFile[],
  threads: readonly GitHubPullRequestReviewThread[],
): GitHubPullRequestReviewThread[] {
  const position = new Map(files.map((file, index) => [file.path, index]));
  const rank = (thread: GitHubPullRequestReviewThread) =>
    thread.isOutdated || thread.line === null ? Number.MAX_SAFE_INTEGER : thread.line;
  return threads
    .filter((thread) => !thread.isResolved && position.has(thread.path))
    .sort(
      (a, b) =>
        position.get(a.path)! - position.get(b.path)! ||
        rank(a) - rank(b) ||
        (a.side === b.side ? 0 : a.side === "LEFT" ? 1 : -1),
    );
}

/** The conversation after `currentId` in `ordered`, wrapping to the first. */
export function nextThreadAfter(
  ordered: readonly GitHubPullRequestReviewThread[],
  currentId: string | null,
): GitHubPullRequestReviewThread | null {
  if (ordered.length === 0) return null;
  const current = currentId === null ? -1 : ordered.findIndex((thread) => thread.id === currentId);
  return ordered[(current + 1) % ordered.length]!;
}

/** Every directory path on the way to `path` (for revealing it in the tree). */
export function ancestorDirectories(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
