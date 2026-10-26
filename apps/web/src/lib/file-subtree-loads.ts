import type { FileSubtree } from "@/lib/backend";
import { useFilesPanelStore } from "@/stores/filesPanelStore";

// Shared by panel mounts, including target switches. A refresh joins one queued
// follow-up, never the observation that was already running at its boundary.
const pending = new Map<symbol, { promise: Promise<boolean>; followup?: Promise<void> }>();
const MAX_CONCURRENT_READS = 4;
let running = 0;
const waiting: Array<() => void> = [];

async function admitted<T>(read: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_READS) await new Promise<void>((resolve) => waiting.push(resolve));
  else running += 1;
  try {
    return await read();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

export async function loadFileSubtree(
  key: string,
  directory: string,
  reload: boolean,
  read: () => Promise<FileSubtree | null>,
): Promise<void> {
  const state = useFilesPanelStore.getState();
  if (state.fileSubtreeKey !== key || !state.expandedFolders.includes(directory)) return;
  const current = state.folderLoadTokens.get(directory);
  const previous = current ? pending.get(current) : undefined;
  if (previous) {
    if (!reload) {
      await previous.promise;
      return;
    }
    previous.followup ??= previous.promise.then(async (accepted) => {
      if (accepted) await loadFileSubtree(key, directory, true, read);
    });
    return previous.followup;
  }
  const token = state.beginFolderLoad(key, directory, reload);
  if (!token) return;
  const promise = admitted(async () => {
    // Queued work may have been collapsed or superseded before admission.
    if (useFilesPanelStore.getState().folderLoadTokens.get(directory) !== token) return false;
    let subtree: FileSubtree | null = null;
    try {
      subtree = await read();
    } catch (err) {
      console.error(`Failed to load folder ${directory}:`, err);
    }
    return useFilesPanelStore.getState().finishFolderLoad(key, directory, token, subtree);
  });
  pending.set(token, { promise });
  try {
    await promise;
  } finally {
    pending.delete(token);
  }
}
