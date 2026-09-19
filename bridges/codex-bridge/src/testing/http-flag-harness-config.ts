const DEFAULT_READY_TIMEOUT_MS = 5_000;
const READY_POLL_INTERVAL_MS = 50;

export interface HttpHarnessReadyProbeConfig {
  timeoutMs: number;
  attempts: number;
  pollIntervalMs: number;
}

export function resolveHttpHarnessReadyProbeConfig(
  configuredTimeoutMs: string | undefined,
): HttpHarnessReadyProbeConfig {
  const parsedTimeoutMs =
    Number.parseInt(configuredTimeoutMs ?? String(DEFAULT_READY_TIMEOUT_MS), 10) ||
    DEFAULT_READY_TIMEOUT_MS;
  const timeoutMs = Math.max(READY_POLL_INTERVAL_MS, parsedTimeoutMs);

  return {
    timeoutMs,
    attempts: Math.ceil(timeoutMs / READY_POLL_INTERVAL_MS),
    pollIntervalMs: READY_POLL_INTERVAL_MS,
  };
}
