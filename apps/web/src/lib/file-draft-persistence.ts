import * as backend from "@/lib/backend";

const writeChains = new Map<string, Promise<void>>();

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
  void next.finally(() => {
    if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
  });
  return next;
}

export function persistFileDraft(
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
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
  return enqueue(draftKey, () => backend.deleteFileDraft(draftKey));
}
