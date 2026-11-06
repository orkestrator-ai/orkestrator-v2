import { useCallback, useEffect, useRef, useState } from "react";
import { hydrationRequests, type RequestLimiter } from "@/lib/hydration-request-limiter";
import { recordRealmBootStep } from "@/lib/realm-boot-timing";

const nextTask = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * Resolves once the limiter has had nothing in flight or queued across two
 * further tasks. Restores are started from effects and zero-delay timers
 * (the environment batcher's), so an idle limiter in the same task as the
 * last environment list is not yet the end of the fan-out.
 */
export async function waitForHydrationQuiet(
  limiter: RequestLimiter = hydrationRequests,
  wait: () => Promise<void> = nextTask,
): Promise<void> {
  for (;;) {
    await limiter.whenIdle();
    const started = limiter.started;
    await wait();
    await wait();
    if (limiter.started === started && limiter.inFlight === 0 && limiter.queued === 0) return;
  }
}

/** When a realm's boot started reading environments, shared by the two hooks below. */
export type RealmBootClock = { current: number | null };

/**
 * Wraps a realm's authoritative per-project environment load to time the
 * first `get_environments` (`first-environments`), and starts the clock that
 * `useRealmFanOutTiming` stops. A no-op outside a desktop realm.
 */
export function useTimedEnvironmentLoad<T>(load: (projectId: string) => Promise<T>): {
  load: (projectId: string) => Promise<T>;
  clock: RealmBootClock;
  settled: ReadonlyMap<string, boolean>;
} {
  const clock = useRef<number | null>(null);
  const [settled, setSettled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const timedLoad = useCallback(
    async (projectId: string) => {
      const started = monotonicNow();
      clock.current ??= started;
      let succeeded = false;
      try {
        const result = await load(projectId);
        succeeded = true;
        recordRealmBootStep("first-environments", monotonicNow() - started, { outcome: "ok" });
        return result;
      } catch (error) {
        recordRealmBootStep("first-environments", monotonicNow() - started, {
          outcome: "failed",
        });
        throw error;
      } finally {
        const outcome = succeeded;
        setSettled((previous) =>
          previous.has(projectId) ? previous : new Map(previous).set(projectId, outcome),
        );
      }
    },
    [load],
  );
  return { load: timedLoad, clock, settled };
}

/**
 * Once every project's environment list has settled, waits for the boot's
 * hydration reads to go quiet and reports `fan-out-complete` with how many
 * hydration requests the document sent. Reported once per realm document.
 */
export function useRealmFanOutTiming(
  environmentsSettled: boolean,
  clock: RealmBootClock,
  failed = false,
): void {
  const reported = useRef(false);
  useEffect(() => {
    if (!environmentsSettled || reported.current) return;
    reported.current = true;
    const startedAt = clock.current ?? monotonicNow();
    void waitForHydrationQuiet().then(() => {
      recordRealmBootStep("fan-out-complete", monotonicNow() - startedAt, {
        requests: hydrationRequests.started,
        outcome: failed ? "failed" : "ok",
      });
    });
  }, [clock, environmentsSettled, failed]);
}
