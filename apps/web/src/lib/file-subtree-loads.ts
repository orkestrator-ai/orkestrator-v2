import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { ConditionalSnapshot, FileSubtree } from "@/lib/backend";
import { useFilesPanelStore } from "@/stores/filesPanelStore";

const log = createLogger("web.files");

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
  read: (knownDigest: string | undefined) => Promise<ConditionalSnapshot<FileSubtree> | null>,
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
    const admittedState = useFilesPanelStore.getState();
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
    const { finishFolderLoad } = useFilesPanelStore.getState();
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
