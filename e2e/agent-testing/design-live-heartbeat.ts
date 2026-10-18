type Schedule = (emit: () => void, intervalMs: number) => () => void;

const scheduleInterval: Schedule = (emit, intervalMs) => {
  const timer = setInterval(emit, intervalMs);
  return () => clearInterval(timer);
};

/** Keep the logged runner alive even when a projection or approval never changes. */
export async function withDesignLiveHeartbeat<T>(
  provider: string,
  run: () => Promise<T>,
  schedule: Schedule = scheduleInterval,
): Promise<T> {
  const stop = schedule(() => console.log(`[design-live] ${provider} heartbeat`), 60_000);
  try {
    return await run();
  } finally {
    stop();
  }
}
