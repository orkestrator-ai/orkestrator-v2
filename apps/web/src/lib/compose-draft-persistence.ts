import * as backend from "@/lib/backend";

const writeChains = new Map<string, Promise<void>>();

export function composeDraftKey(
  namespace: string,
  environmentId: string,
  localKey: string,
): string {
  return `${namespace}:${environmentId}:${encodeURIComponent(localKey)}`;
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
 * Read a draft after every save/delete already queued for the same key.
 *
 * This matters when a tab is closed and immediately reopened: the new mount
 * must not hydrate the value that the close path has already queued to delete.
 */
export async function loadComposeDraft<T>(
  draftKey: string,
): Promise<Awaited<ReturnType<typeof backend.getComposeDraft<T>>>> {
  await (writeChains.get(draftKey) ?? Promise.resolve()).catch(() => undefined);
  return backend.getComposeDraft<T>(draftKey);
}

export function persistComposeDraft<T>(
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: T,
): Promise<void> {
  return enqueue(
    draftKey,
    () => backend.saveComposeDraft(draftKey, ownerType, ownerId, value),
  );
}

export function discardComposeDraft(draftKey: string): Promise<void> {
  return enqueue(draftKey, () => backend.deleteComposeDraft(draftKey));
}
