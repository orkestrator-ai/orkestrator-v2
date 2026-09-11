/**
 * Cursor plan-quota windows, shared by the bridge and the backend.
 *
 * Cursor reports plan percentages — Cursor Models / Other Models / overall —
 * from its dashboard rather than from a session. The bridge reads them to fold
 * into a running session's account panel, and the backend reads the same
 * endpoint for the settings card. Both map the payload here so a shape change
 * is fixed once.
 *
 * Only provider-reported percentages become bars. Included dollar spend and
 * limit stay out: those do not share the quota denominator and would produce a
 * meter Cursor never reported.
 */
import type { NativeAgentAccountUsageWindow } from "./native-agent.js";

const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_EPOCH_MS = Date.UTC(2100, 0, 1);

export const CURSOR_PLAN_WINDOW = {
  auto: "cursor-internal-auto",
  api: "cursor-internal-api",
  total: "billing_cycle",
} as const;

export const DEFAULT_PLAN_LABELS = {
  auto: "Cursor Models",
  api: "Other Models",
  total: "Cursor quota",
} as const;

/** Whether a window id is account plan quota rather than session spend. */
export function isPlanQuotaWindow(window: string): boolean {
  return (
    window === CURSOR_PLAN_WINDOW.auto ||
    window === CURSOR_PLAN_WINDOW.api ||
    window === CURSOR_PLAN_WINDOW.total
  );
}

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finitePercent(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function unixMilliseconds(value: unknown): number | undefined {
  const milliseconds = finiteNumber(value);
  if (
    milliseconds === undefined ||
    milliseconds < MIN_PLAUSIBLE_EPOCH_MS ||
    milliseconds > MAX_PLAUSIBLE_EPOCH_MS
  ) {
    return undefined;
  }
  return milliseconds;
}

function unixMsToIso(value: unknown): string | undefined {
  const milliseconds = unixMilliseconds(value);
  return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Map Cursor's current-period payload onto the generic account windows. */
export function accountWindowsFromPlanUsage(
  currentPeriodValue: unknown,
  labels: { auto: string; api: string; total: string } = DEFAULT_PLAN_LABELS,
): NativeAgentAccountUsageWindow[] {
  const currentPeriod = record(currentPeriodValue);
  const planUsage = record(currentPeriod?.planUsage);
  if (!planUsage) return [];

  const cycleStartMs = unixMilliseconds(currentPeriod?.billingCycleStart);
  const cycleEndMs = unixMilliseconds(currentPeriod?.billingCycleEnd);
  const resetsAt = unixMsToIso(cycleEndMs);
  const windowMinutes =
    cycleStartMs !== undefined && cycleEndMs !== undefined && cycleEndMs > cycleStartMs
      ? (cycleEndMs - cycleStartMs) / 60_000
      : undefined;
  const timing = {
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  };
  const windows: NativeAgentAccountUsageWindow[] = [];
  const autoPercentUsed = finitePercent(planUsage.autoPercentUsed);
  const apiPercentUsed = finitePercent(planUsage.apiPercentUsed);
  const totalPercentUsed = finitePercent(planUsage.totalPercentUsed);

  if (autoPercentUsed !== undefined) {
    windows.push({
      window: CURSOR_PLAN_WINDOW.auto,
      label: labels.auto,
      usedPercent: autoPercentUsed,
      ...timing,
    });
  }
  if (apiPercentUsed !== undefined) {
    windows.push({
      window: CURSOR_PLAN_WINDOW.api,
      label: labels.api,
      usedPercent: apiPercentUsed,
      ...timing,
    });
  }
  if (windows.length === 0 && totalPercentUsed !== undefined) {
    windows.push({
      window: CURSOR_PLAN_WINDOW.total,
      label: labels.total,
      usedPercent: totalPercentUsed,
      ...timing,
    });
  }
  return windows;
}
