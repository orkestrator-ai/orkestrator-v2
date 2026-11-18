import type { ConditionalSnapshot, FileNode } from "@/lib/backend";
import { defineScopedSlot } from "@/lib/node-scope-slots";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { FileCandidate } from "@/types";

const REUSE_MS = 3_000;
const MAX_WORKSPACES = 8;

interface IndexSnapshot {
  files: FileCandidate[];
  digest: string;
  checkedAt: number;
}

const indexesForScope = defineScopedSlot("composer-file-index", (scope) => {
  const recent = new Map<string, IndexSnapshot>();
  const pending = new Map<string, Promise<FileCandidate[]>>();
  scope.onDispose("composer-file-index", () => {
    recent.clear();
    pending.clear();
  });
  return { recent, pending };
});

export function flattenFileTree(tree: FileNode[]): FileCandidate[] {
  const files: FileCandidate[] = [];
  function visit(nodes: FileNode[]) {
    for (const node of nodes) {
      files.push({
        filename: node.name,
        relativePath: node.path,
        isDirectory: node.isDirectory,
        ...(node.isDirectory ? {} : { extension: node.extension }),
      });
      if (node.isDirectory && node.children) visit(node.children);
    }
  }
  visit(tree);
  return files;
}

export async function readComposerFileIndex(
  scope: NodeScope,
  workspace: string,
  read: (digest?: string) => Promise<ConditionalSnapshot<FileNode[]>>,
): Promise<FileCandidate[]> {
  const { recent, pending } = indexesForScope(scope);
  const inFlight = pending.get(workspace);
  if (inFlight) return inFlight;

  const previous = recent.get(workspace);
  if (previous && performance.now() - previous.checkedAt < REUSE_MS) {
    recent.delete(workspace);
    recent.set(workspace, previous);
    return previous.files;
  }
  if (pending.size >= MAX_WORKSPACES) throw new Error("Too many workspace file reads");

  // Move expired data out of the cache while revalidating. Its digest can
  // still save a full response and a second flatten when the tree is unchanged.
  recent.delete(workspace);
  const request = Promise.resolve().then(async () => {
    try {
      const snapshot = await read(previous?.digest);
      if (scope.disposed) throw new Error("The workspace node is disconnected");
      const files = snapshot.unchanged
        ? previous?.digest === snapshot.digest
          ? previous.files
          : undefined
        : snapshot.value && flattenFileTree(snapshot.value);
      if (!files) throw new Error("Missing workspace file index");

      recent.set(workspace, { files, digest: snapshot.digest, checkedAt: performance.now() });
      if (recent.size > MAX_WORKSPACES) {
        const oldest = recent.keys().next();
        if (!oldest.done) recent.delete(oldest.value);
      }
      return files;
    } finally {
      pending.delete(workspace);
    }
  });
  pending.set(workspace, request);
  return request;
}
