type Invoker = { invoke(command: string, args: Record<string, unknown>): unknown };
type Queue = { tail: Promise<unknown>; revision: unknown; count: number; released?: boolean };

/** Bounded, main-owned CAS chains. A failed revision fences every queued successor. */
export class DesktopFileDraftWrites {
  private queues = new Map<string, Queue>();
  private bytes = 0;
  private count = 0;

  releaseSender(senderId: number): void {
    this.releaseMatching(senderId);
  }

  /** Fence a disposed renderer client; admitted writes finish before removal. */
  releaseClient(senderId: number, clientId: unknown): void {
    if (typeof clientId !== "string" || clientId.length > 100)
      throw new Error("Invalid desktop draft client");
    this.releaseMatching(senderId, clientId);
  }

  private releaseMatching(senderId: number, clientId?: string): void {
    for (const [key, queue] of Array.from(this.queues)) {
      const [owner, client] = JSON.parse(key);
      if (owner !== senderId || (clientId !== undefined && client !== clientId)) continue;
      queue.released = true;
      const remove = () => {
        if (this.queues.get(key) === queue) this.queues.delete(key);
      };
      if (queue.count === 0) remove();
      else void queue.tail.then(remove, remove);
    }
  }

  write(senderId: number, args: Record<string, unknown>, backend: Invoker): Promise<unknown> {
    const { command, clientId, draftKey, expectedRevision, ...payload } = args;
    if (
      (command !== "save_file_draft" && command !== "delete_file_draft") ||
      typeof clientId !== "string" ||
      clientId.length > 100 ||
      typeof draftKey !== "string" ||
      draftKey.length > 8192
    ) {
      return Promise.reject(new Error("Invalid desktop draft write"));
    }
    const bytes = Buffer.byteLength(JSON.stringify(args));
    if (this.count >= 128 || this.bytes + bytes > 64 * 1024 * 1024) {
      return Promise.reject(new Error("Desktop draft write capacity exceeded"));
    }
    const key = JSON.stringify([senderId, clientId, draftKey]);
    let queue = this.queues.get(key);
    if (!queue) {
      if (this.queues.size >= 1024)
        return Promise.reject(new Error("Desktop draft client capacity exceeded"));
      queue = { tail: Promise.resolve(), revision: expectedRevision, count: 0 };
      this.queues.set(key, queue);
    }
    if (queue.released) return Promise.reject(new Error("Desktop draft client released"));
    const current = queue;
    current.count += 1;
    this.count += 1;
    this.bytes += bytes;
    const result = current.tail.then(async () => {
      const saved = (await backend.invoke(command, {
        ...payload,
        draftKey,
        expectedRevision: current.revision,
      })) as { revision: number } | null;
      current.revision = command === "delete_file_draft" ? 0 : saved?.revision;
      return saved;
    });
    current.tail = result.then(() => undefined);
    void current.tail.catch(() => undefined);
    void result
      .finally(() => {
        this.bytes -= bytes;
        this.count -= 1;
        current.count -= 1;
        // Keep the cursor until explicit release/navigation: an IPC response may still
        // be in transit when the next write is admitted.
      })
      .catch(() => undefined);
    return result;
  }
}
