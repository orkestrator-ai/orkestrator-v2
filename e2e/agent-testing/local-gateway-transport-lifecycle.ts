import type { ChildProcess } from "node:child_process";
import { stopProcessGroup } from "../process-cleanup";

/** Keep ownership until startup succeeds; callers cannot clean up a rejected result. */
export async function withStartingProcess<T>(
  child: ChildProcess,
  ready: () => Promise<T>,
): Promise<T> {
  try {
    return await ready();
  } catch (error) {
    try {
      await stopProcessGroup(child);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Startup and process cleanup failed");
    }
    throw error;
  }
}

/** Stop both recordings even if work, startup, or the other stop fails. */
export async function withProfilers<T>(
  hooks: {
    startTrace: () => Promise<unknown>;
    startCpu: () => Promise<unknown>;
    stopTrace: () => Promise<unknown>;
    stopCpu: () => Promise<unknown>;
  },
  work: () => Promise<T>,
): Promise<T> {
  let tracing = false;
  let cpu = false;
  const errors: unknown[] = [];
  let result: T | undefined;
  try {
    await hooks.startTrace();
    tracing = true;
    await hooks.startCpu();
    cpu = true;
    result = await work();
  } catch (error) {
    errors.push(error);
  } finally {
    if (cpu) {
      try {
        await hooks.stopCpu();
      } catch (error) {
        errors.push(error);
      }
    }
    if (tracing) {
      try {
        await hooks.stopTrace();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Profiling and cleanup failed");
  return result as T;
}
