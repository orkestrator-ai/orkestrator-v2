import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function watchChild(child: ChildProcess) {
  let spawnError: Error | undefined;
  // Register immediately: an OS spawn failure emits error and close, with no exit.
  child.on("error", (error) => {
    spawnError ??= error;
  });
  let closed = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (resolve) =>
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal, error: spawnError });
      }),
  );
  const settledWithin = async (ms: number): Promise<boolean> => {
    const cancel = new AbortController();
    try {
      return await Promise.race([
        done.then(() => true),
        delay(ms, false, { signal: cancel.signal }),
      ]);
    } finally {
      cancel.abort();
    }
  };
  const signal = (name: NodeJS.Signals) => {
    if (!closed && child.exitCode === null && child.signalCode === null && child.pid)
      child.kill(name);
  };
  return {
    child,
    done,
    failure: () => spawnError,
    closed: () => closed,
    async stop(graceMs = 2_000) {
      if (closed) return;
      signal("SIGTERM");
      if (await settledWithin(graceMs)) return;
      signal("SIGKILL");
      if (!(await settledWithin(2_000)))
        throw new Error("Owned child did not close after SIGKILL.");
    },
  };
}
