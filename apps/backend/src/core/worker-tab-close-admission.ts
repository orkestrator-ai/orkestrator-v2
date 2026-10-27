/** Admission spans asynchronous delegation persistence and coordinator tab close. */
const closing = new Set<string>();
const pending = new Map<string, number>();
const keyFor = (environmentId: string, tabId: string) => `${environmentId}\0${tabId}`;

export function beginWorkerTabClose(environmentId: string, tabId: string): () => void {
  const key = keyFor(environmentId, tabId);
  if (closing.has(key) || pending.has(key))
    throw new Error("This tab has work being admitted; retry closing later");
  closing.add(key);
  return () => {
    closing.delete(key);
  };
}

export function beginWorkerTabDelegation(environmentId: string, tabId: string): () => void {
  const key = keyFor(environmentId, tabId);
  if (closing.has(key))
    throw new Error("This tab is being closed; retry the delegation on an open tab");
  pending.set(key, (pending.get(key) ?? 0) + 1);
  return () => {
    const count = (pending.get(key) ?? 1) - 1;
    if (count) pending.set(key, count);
    else pending.delete(key);
  };
}
