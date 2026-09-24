import type { RecurringWorkSnapshot } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * The one read-only surface for recurring-work diagnostics, shared by the
 * `get_recurring_work_diagnostics` command and the gateway's `/api/metrics`.
 * Everything returned is aggregate and content-free: kinds, counts and ages —
 * never a key, target, path or identifier. Reading it performs no I/O.
 */

export interface RecurringWorkDiagnostics {
  metrics: RecurringWorkSnapshot;
}

export function recurringWorkDiagnostics(
  metrics: RecurringWorkMetrics = recurringWorkMetrics,
): RecurringWorkDiagnostics {
  return { metrics: metrics.snapshot() };
}
