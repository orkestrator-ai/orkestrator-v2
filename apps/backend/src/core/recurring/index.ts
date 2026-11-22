// The recurring domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the backend's bounded recurring-work machinery
// (docs/architecture/recurring-work.md): the keyed scheduler
// (`scheduler.ts`), the process-wide work metrics and their spans
// (`work-metrics.ts`), and the diagnostics registry that collects scheduler,
// signal-health and cache-gauge sources into one snapshot (`diagnostics.ts`).
// `test-support.ts` holds the manual clock and deferred helpers its tests and
// many other backend tests share. The owners that schedule work
// (`backend-activity-jobs.ts`, `work-admission.ts`, `machine-load.ts`, …)
// stay with their own groups.
//
// Two modules are named exceptions in the `apps/backend/src/**` pattern of
// `.oxlintrc.json`:
//
// - `work-metrics.ts`, which `native-session-invalidation-metrics.ts` imports
//   directly. `diagnostics.ts` reads the native session invalidation metrics
//   at runtime, so routing that importer through this file would close a
//   runtime import cycle. It is still re-exported here, and every other
//   importer uses this file (its `recurringMetricsEnabled` is used only
//   there, so it is not re-exported).
// - `test-support.ts`, the shared manual clock and deferred helpers, which
//   is not part of this surface. Most of its importers are tests or
//   `*test-support*` files, which the pattern exempts, but
//   `review/fanout-interleaving-support.ts` is test support whose name the
//   exemption does not match (as with `previews/test-support.js`).
//
// The `tests/unit/**` pattern needs no exception: no `tests/unit` file imports
// the domain.
export {
  armedSignalHealth,
  emptySignalHealthStates,
  recurringDiagnosticsRegistry,
  recurringWorkDiagnostics,
  type CacheGaugeName,
  type CacheGaugeSource,
  type RecurringDiagnosticsRegistry,
  type SignalDemotionReason,
  type SignalHealthState,
  type SignalHealthStatus,
} from "./diagnostics.js";
export {
  RecurringScheduler,
  type RecurringRunContext,
  type RecurringRunResult,
  type RecurringSchedulerLimits,
  type RecurringSchedulerStatus,
  type RecurringTimerFactory,
} from "./scheduler.js";
export {
  recurringWorkMetrics,
  spawnWorkUnit,
  RecurringWorkMetrics,
  type RecurringWorkSpan,
} from "./work-metrics.js";
