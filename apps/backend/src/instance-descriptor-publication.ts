import { publishInstanceDescriptor } from "./instance-descriptor.js";

/** Subscribe before the first snapshot; serialize writes and drain before removal. */
export function createInstanceDescriptorPublication(options: {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => Parameters<typeof publishInstanceDescriptor>[0] | null;
  onError: (error: unknown) => void;
  publish?: typeof publishInstanceDescriptor;
}) {
  let closed = false;
  let writes = Promise.resolve();
  let queued: Promise<void> | null = null;
  let remove: (() => Promise<void>) | null = null;
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (queued) return queued;
    const write = writes.then(async () => {
      queued = null;
      if (closed) return;
      const snapshot = options.snapshot();
      if (snapshot) remove = await (options.publish ?? publishInstanceDescriptor)(snapshot);
    });
    // One active write and at most one queued snapshot, even during a slow disk write.
    queued = write;
    writes = write.catch(() => undefined);
    return write;
  }
  const unsubscribe = options.subscribe(() => {
    void refresh().catch(options.onError);
  });
  return {
    refresh,
    get published() {
      return remove !== null;
    },
    async close(): Promise<void> {
      closed = true;
      unsubscribe();
      await writes;
      await remove?.().catch(() => undefined);
    },
  };
}
