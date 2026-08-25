export const DEFAULT_DEBUG_LOG_RETENTION_DAYS = 7;
export const MIN_DEBUG_LOG_RETENTION_DAYS = 1;
export const MAX_DEBUG_LOG_RETENTION_DAYS = 3650;

export function isValidDebugLogRetentionDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_DEBUG_LOG_RETENTION_DAYS &&
    value <= MAX_DEBUG_LOG_RETENTION_DAYS
  );
}

export function normalizeDebugLogRetentionDays(value: unknown): number {
  return isValidDebugLogRetentionDays(value) ? value : DEFAULT_DEBUG_LOG_RETENTION_DAYS;
}
