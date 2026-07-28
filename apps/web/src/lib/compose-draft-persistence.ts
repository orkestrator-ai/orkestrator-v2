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
  void next.finally(() => {
    if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
  });
  return next;
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
