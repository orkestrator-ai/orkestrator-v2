// A remote tab lives in the command node's namespace, independently of a local
// tab with the same environment and tab IDs.
const scopeFor = (environmentId: string, nodeId?: string) =>
  JSON.stringify([nodeId ?? null, environmentId]);
const keyFor = (environmentId: string, tabId: string | undefined, nodeId?: string) =>
  `${scopeFor(environmentId, nodeId)}\0${tabId ?? ""}`;

/**
 * Admission spanning asynchronous delegation persistence and coordinator tab
 * close, in one backend. Owned by `BackendRuntime` through
 * `coordinatorRequests.workerTabs`; the coordinator store receives it as an
 * argument to `openCoordinatorDelegation`, since it has no runtime in reach.
 */
export class WorkerTabCloseAdmission {
  private readonly closing = new Set<string>();
  private readonly pending = new Map<string, number>();

  beginClose(environmentId: string, tabId: string, nodeId?: string): () => void {
    const key = keyFor(environmentId, tabId, nodeId);
    if (
      this.closing.has(key) ||
      this.pending.has(key) ||
      this.pending.has(keyFor(environmentId, undefined, nodeId))
    )
      throw new Error("This tab has work being admitted; retry closing later");
    this.closing.add(key);
    return () => {
      this.closing.delete(key);
    };
  }

  beginDelegation(environmentId: string, tabId: string | undefined, nodeId?: string): () => void {
    const key = keyFor(environmentId, tabId, nodeId);
    // Mail without an explicit tab lets the leaf choose the recipient. Fence the
    // environment until that choice and its delegation have been persisted.
    const anyClosing =
      tabId === undefined &&
      Array.from(this.closing).some((entry) =>
        entry.startsWith(`${scopeFor(environmentId, nodeId)}\0`),
      );
    if (this.closing.has(key) || anyClosing)
      throw new Error("This tab is being closed; retry the delegation on an open tab");
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    return () => {
      const count = (this.pending.get(key) ?? 1) - 1;
      if (count) this.pending.set(key, count);
      else this.pending.delete(key);
    };
  }
}
