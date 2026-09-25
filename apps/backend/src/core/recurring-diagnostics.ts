import type { RecurringWorkSnapshot } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import type { RecurringSchedulerStatus } from "./recurring-scheduler.js";
import type { AdmissionPoolStatus } from "./work-admission.js";

/**
 * The one read-only surface for recurring-work diagnostics, shared by the
 * `get_recurring_work_diagnostics` command and the gateway's `/api/metrics`.
 *
 * Schedulers and admission pools register themselves here when constructed
 * (and unregister on dispose/close), so diagnostics report every live instance
 * without each owner threading a reference through the command context.
 * Everything returned is aggregate and content-free: kinds, classes, counts
 * and ages — never a key, target, path or identifier. Reading it performs no
 * I/O.
 */

/** Live instances are few (one per owning service); the bound guards a leak. */
export const MAX_DIAGNOSTIC_SOURCES = 32;

type StatusSource<T> = { status(): T };

export interface RecurringWorkDiagnostics {
  metrics: RecurringWorkSnapshot;
  schedulers: RecurringSchedulerStatus[];
  admission: AdmissionPoolStatus[];
  /** Registrations refused because the source table was full. */
  droppedSources: number;
  /** Sources whose `status()` threw; they are skipped, never propagated. */
  faultedSources: number;
}

export class RecurringDiagnosticsRegistry {
  private readonly schedulers = new Set<StatusSource<RecurringSchedulerStatus>>();
  private readonly pools = new Set<StatusSource<AdmissionPoolStatus>>();
  private droppedSources = 0;

  /** Returns an idempotent unregister function. */
  addScheduler(source: StatusSource<RecurringSchedulerStatus>): () => void {
    return this.add(this.schedulers, source);
  }

  addPool(source: StatusSource<AdmissionPoolStatus>): () => void {
    return this.add(this.pools, source);
  }

  snapshot(metrics: RecurringWorkMetrics = recurringWorkMetrics): RecurringWorkDiagnostics {
    let faultedSources = 0;
    const collect = <T>(sources: Set<StatusSource<T>>): T[] => {
      const result: T[] = [];
      for (const source of sources) {
        try {
          result.push(source.status());
        } catch {
          faultedSources += 1;
        }
      }
      return result;
    };
    const schedulers = collect(this.schedulers);
    const admission = collect(this.pools);
    return {
      metrics: metrics.snapshot(),
      schedulers,
      admission,
      droppedSources: this.droppedSources,
      faultedSources,
    };
  }

  private add<T>(set: Set<StatusSource<T>>, source: StatusSource<T>): () => void {
    if (!set.has(source) && this.schedulers.size + this.pools.size >= MAX_DIAGNOSTIC_SOURCES) {
      this.droppedSources += 1;
      return () => undefined;
    }
    set.add(source);
    return () => {
      set.delete(source);
    };
  }
}

export const recurringDiagnosticsRegistry = new RecurringDiagnosticsRegistry();

export function recurringWorkDiagnostics(
  metrics: RecurringWorkMetrics = recurringWorkMetrics,
): RecurringWorkDiagnostics {
  return recurringDiagnosticsRegistry.snapshot(metrics);
}
