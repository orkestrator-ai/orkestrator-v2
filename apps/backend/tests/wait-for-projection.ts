/** Subscribe before reading a snapshot, and drain every started read on exit. */
export async function waitForProjection<T>(options: {
  projection: () => Promise<T>;
  subscribe: (signal: AbortSignal) => AsyncGenerator<void>;
  accept: (projection: T) => boolean;
  description: string;
  diagnostics?: (last: T | undefined) => string;
}): Promise<T> {
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(30_000);
  const abort = () => controller.abort(deadline.reason);
  deadline.addEventListener("abort", abort, { once: true });
  const events = options.subscribe(controller.signal);
  // Convert rejection to a value immediately: the snapshot may return or fail
  // before fetch/read rejects, including when cleanup itself aborts the read.
  const next = () =>
    events.next().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  let pending: ReturnType<typeof next> | undefined;
  let last: T | undefined;
  try {
    pending = next();
    last = await options.projection();
    while (!options.accept(last)) {
      const result = await pending;
      if (!result.ok) throw result.error;
      if (result.value.done) throw new Error("bridge event stream ended");
      // Start the next read before the snapshot as well, retaining events that
      // arrive during that read. The first frame also triggers a snapshot.
      pending = next();
      last = await options.projection();
    }
    return last;
  } catch (error) {
    throw new Error(
      `Failed waiting for ${options.description}: ${String(error)}\n${options.diagnostics?.(last) ?? ""}`,
    );
  } finally {
    deadline.removeEventListener("abort", abort);
    // Abort before return(): an async generator queues return behind next(),
    // which may still be blocked on the connection or a reader.read().
    controller.abort();
    await pending;
    await events.return(undefined);
  }
}
