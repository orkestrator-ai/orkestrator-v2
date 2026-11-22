/** Boot evidence belongs to a backend's start marker and may be absent in older history. */
export interface BootEvidence {
  bootAt?: number | null;
  bootId?: string | null;
}

export function isBootId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Clock corrections can move the estimated boot time when there is no stable boot ID. */
export const SAME_BOOT_TOLERANCE_MS = 5 * 60 * 1000;

interface BackendStart extends BootEvidence {
  startedAt: number;
}

/** Use the first non-overlapping successor, even if its own start marker is missing. */
export function nextBackendStart(
  starts: readonly BackendStart[],
  run: BackendStart & { lastAt: number },
): BackendStart | undefined {
  return starts.find((start) => start.startedAt > run.startedAt && start.startedAt >= run.lastAt);
}

/** True when the immediate successor's boot is newer than the run's last row. */
export function hostRestartedAfter(
  lastAt: number,
  run: BootEvidence,
  next: BootEvidence | undefined,
): boolean {
  const bootAt = next?.bootAt;
  if (typeof bootAt !== "number" || !Number.isFinite(bootAt) || bootAt <= lastAt) return false;
  if (isBootId(run.bootId) && isBootId(next?.bootId)) return run.bootId !== next.bootId;
  return (
    typeof run.bootAt !== "number" ||
    !Number.isFinite(run.bootAt) ||
    Math.abs(bootAt - run.bootAt) >= SAME_BOOT_TOLERANCE_MS
  );
}
