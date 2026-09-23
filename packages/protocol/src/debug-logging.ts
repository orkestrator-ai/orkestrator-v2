export const DEFAULT_DEBUG_LOG_RETENTION_DAYS = 7;
export const MIN_DEBUG_LOG_RETENTION_DAYS = 1;
export const MAX_DEBUG_LOG_RETENTION_DAYS = 3650;

// Only these exact messages may cross from the renderer console into the
// persistent desktop log. Never forward arbitrary console/error contents.
export const DESKTOP_STARTUP_EVENTS = [
  "checking",
  "ready",
  "bridge-unavailable",
  "backend-unavailable",
  "renderer-load-failed",
  "renderer-error",
  "unhandled-rejection",
] as const;
export type DesktopStartupEvent = (typeof DESKTOP_STARTUP_EVENTS)[number];

export function desktopStartupMessage(event: DesktopStartupEvent): string {
  return `[DesktopStartup] ${event}`;
}

export function isDesktopStartupMessage(message: string): boolean {
  return DESKTOP_STARTUP_EVENTS.some((event) => desktopStartupMessage(event) === message);
}

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
