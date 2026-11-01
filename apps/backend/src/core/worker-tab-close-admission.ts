/**
 * Admission spans asynchronous delegation persistence and coordinator tab close.
 * Per backend but still module state: the coordinator store calls it with no
 * runtime in reach. Not moved yet
 * (docs/todo/backend-structure/1070-backend-module-state-beyond-0390.md).
 */
const closing = new Set<string>();
const pending = new Map<string, number>();
// A remote tab lives in the command node's namespace, independently of a local
// tab with the same environment and tab IDs.
const scopeFor = (environmentId: string, nodeId?: string) =>
  JSON.stringify([nodeId ?? null, environmentId]);
const keyFor = (environmentId: string, tabId: string | undefined, nodeId?: string) =>
  `${scopeFor(environmentId, nodeId)}\0${tabId ?? ""}`;

export function beginWorkerTabClose(
  environmentId: string,
  tabId: string,
  nodeId?: string,
): () => void {
  const key = keyFor(environmentId, tabId, nodeId);
  if (closing.has(key) || pending.has(key) || pending.has(keyFor(environmentId, undefined, nodeId)))
    throw new Error("This tab has work being admitted; retry closing later");
  closing.add(key);
  return () => {
    closing.delete(key);
  };
}

export function beginWorkerTabDelegation(
  environmentId: string,
  tabId: string | undefined,
  nodeId?: string,
): () => void {
  const key = keyFor(environmentId, tabId, nodeId);
  // Mail without an explicit tab lets the leaf choose the recipient. Fence the
  // environment until that choice and its delegation have been persisted.
  const anyClosing =
    tabId === undefined &&
    Array.from(closing).some((entry) => entry.startsWith(`${scopeFor(environmentId, nodeId)}\0`));
  if (closing.has(key) || anyClosing)
    throw new Error("This tab is being closed; retry the delegation on an open tab");
  pending.set(key, (pending.get(key) ?? 0) + 1);
  return () => {
    const count = (pending.get(key) ?? 1) - 1;
    if (count) pending.set(key, count);
    else pending.delete(key);
  };
}
