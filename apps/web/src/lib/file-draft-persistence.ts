import * as backend from "@/lib/backend";

const writeChains = new Map<string, Promise<void>>();
const discardedDrafts = new Set<string>();

export function fileDraftKey(environmentId: string, filePath: string): string {
  return `file:${environmentId}:${encodeURIComponent(filePath)}`;
}

function enqueue(draftKey: string, operation: () => Promise<unknown>): Promise<void> {
  const previous = writeChains.get(draftKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .then(() => undefined);
  writeChains.set(draftKey, next);
  void next.then(
    () => {
      if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
    },
    () => {
      if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
    },
  );
  return next;
}

/**
 * Read after queued writes and honour an explicit in-process discard even when
 * the backend deletion is still in flight (or temporarily failed).
 */
export async function loadFileDraft(
  environmentId: string,
  filePath: string,
): Promise<Awaited<ReturnType<typeof backend.getFileDraft>> | null> {
  const draftKey = fileDraftKey(environmentId, filePath);
  await (writeChains.get(draftKey) ?? Promise.resolve()).catch(() => undefined);
  if (discardedDrafts.has(draftKey)) return null;
  return backend.getFileDraft(draftKey);
}

export function persistFileDraft(
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  discardedDrafts.delete(draftKey);
  return enqueue(
    draftKey,
    () => backend.saveFileDraft(
      draftKey,
      environmentId,
      filePath,
      content,
      originalContent,
    ),
  );
}

export function discardFileDraft(
  environmentId: string,
  filePath: string,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  // Set this synchronously so a close/reopen in the same tick cannot restore
  // content the user explicitly chose to discard.
  discardedDrafts.add(draftKey);
  return enqueue(draftKey, () => backend.deleteFileDraft(draftKey));
}
