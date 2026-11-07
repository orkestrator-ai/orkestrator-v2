import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { ConditionalSnapshot, FileSubtree } from "@/lib/backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedSlot } from "@/lib/node-scope-slots";
import { filesPanelStore } from "@/stores/filesPanelStore";

const log = createLogger("web.files");

const MAX_CONCURRENT_READS = 4;

/**
 * One node's directory reads (plan item 3007, report Appendix B): shared by
 * that node's panel mounts, including target switches, and bounded to four at
 * once per node. A refresh joins one queued follow-up, never the observation
 * that was already running at its boundary.
 */
interface SubtreeLoads {
  pending: Map<symbol, { promise: Promise<boolean>; followup?: Promise<void> }>;
  running: number;
  waiting: Array<() => void>;
}

const subtreeLoads = defineScopedSlot<SubtreeLoads>("file-subtree-loads", () => ({
  pending: new Map(),
  running: 0,
  waiting: [],
}));

async function admitted<T>(loads: SubtreeLoads, read: () => Promise<T>): Promise<T> {
  if (loads.running >= MAX_CONCURRENT_READS) {
    await new Promise<void>((resolve) => loads.waiting.push(resolve));
  } else loads.running += 1;
  try {
    return await read();
  } finally {
    const next = loads.waiting.shift();
    if (next) next();
    else loads.running -= 1;
  }
}

/** Reads `directory` of the target `key` into `scope`'s files panel store. */
export async function loadFileSubtree(
  scope: NodeScope,
  key: string,
  directory: string,
  reload: boolean,
  read: (knownDigest: string | undefined) => Promise<ConditionalSnapshot<FileSubtree> | null>,
): Promise<void> {
  // Held across awaits: the scope may be disposed while a read is in flight.
  const store = scope.store(filesPanelStore);
  const loads = subtreeLoads(scope);
  const { pending } = loads;
  const state = store.getState();
  if (state.fileSubtreeKey !== key || !state.expandedFolders.includes(directory)) return;
  const current = state.folderLoadTokens.get(directory);
  const previous = current ? pending.get(current) : undefined;
  if (previous) {
    if (!reload) {
      await previous.promise;
      return;
    }
    previous.followup ??= previous.promise.then(async (accepted) => {
      if (accepted && !scope.disposed) await loadFileSubtree(scope, key, directory, true, read);
    });
    return previous.followup;
  }
  const token = state.beginFolderLoad(key, directory, reload);
  if (!token) return;
  const promise = admitted(loads, async () => {
    // Queued work may have been collapsed or superseded before admission.
    const admittedState = store.getState();
    if (admittedState.folderLoadTokens.get(directory) !== token) return false;
    // Only a directory still held can be answered "unchanged".
    const knownDigest = Object.hasOwn(admittedState.fileSubtrees, directory)
      ? admittedState.fileSubtreeDigests[directory]
      : undefined;
    let snapshot: ConditionalSnapshot<FileSubtree> | null = null;
    try {
      snapshot = await read(knownDigest);
    } catch (err) {
      log.error("folder.load-failed", { error: formatLogError(err) });
    }
    const { finishFolderLoad } = store.getState();
    return snapshot?.unchanged
      ? finishFolderLoad(key, directory, token, "unchanged")
      : finishFolderLoad(key, directory, token, snapshot?.value ?? null, snapshot?.digest);
  });
  pending.set(token, { promise });
  try {
    await promise;
  } finally {
    pending.delete(token);
  }
}
