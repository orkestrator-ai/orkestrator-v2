/**
 * Operational contract for web annotations: the backend rollout switch and
 * the content-free metrics snapshot.
 *
 * Rollout modes:
 *
 * - `enabled`: every implemented capability (default).
 * - `read-only`: recovery mode. Read threads, resolve/reopen, save editor
 *   drafts, and inspect/cancel/recover requests already sent. No new capture,
 *   authoring, migration, preparation, or dispatch.
 * - `disabled`: every client entry point is off. Persisted data is kept and
 *   the backend reconciler keeps settling requests that were already sent.
 *
 * `ORKESTRATOR_WEB_ANNOTATIONS_MODE` (environment) overrides the persisted
 * `config.global.webAnnotations.mode` setting.
 */

export const WEB_ANNOTATION_ROLLOUT_MODES = Object.freeze([
  "enabled",
  "read-only",
  "disabled",
] as const);
export type WebAnnotationRolloutMode = (typeof WEB_ANNOTATION_ROLLOUT_MODES)[number];

export const WEB_ANNOTATION_ROLLOUT_ENV = "ORKESTRATOR_WEB_ANNOTATIONS_MODE";
export const DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE: WebAnnotationRolloutMode = "enabled";

export interface WebAnnotationRolloutSettings {
  mode: WebAnnotationRolloutMode;
}

export interface WebAnnotationRolloutSnapshot {
  /** The mode in force (environment override wins over the setting). */
  mode: WebAnnotationRolloutMode;
  /** The persisted setting. */
  configured: WebAnnotationRolloutMode;
  /** Set when `ORKESTRATOR_WEB_ANNOTATIONS_MODE` overrides the setting. */
  override: WebAnnotationRolloutMode | null;
}

export function isWebAnnotationRolloutMode(value: unknown): value is WebAnnotationRolloutMode {
  return (
    typeof value === "string" && (WEB_ANNOTATION_ROLLOUT_MODES as readonly string[]).includes(value)
  );
}

export function normalizeWebAnnotationRolloutSettings(
  value: unknown,
): WebAnnotationRolloutSettings {
  const mode =
    typeof value === "object" && value !== null ? (value as { mode?: unknown }).mode : undefined;
  return { mode: isWebAnnotationRolloutMode(mode) ? mode : DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE };
}

/** Parse the environment override; unknown values are ignored (no override). */
export function parseWebAnnotationRolloutOverride(
  value: string | undefined,
): WebAnnotationRolloutMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "readonly" || normalized === "read_only") return "read-only";
  if (normalized === "off" || normalized === "0" || normalized === "false") return "disabled";
  if (normalized === "on" || normalized === "1" || normalized === "true") return "enabled";
  return isWebAnnotationRolloutMode(normalized) ? normalized : null;
}

export interface WebAnnotationDurationSummary {
  count: number;
  totalMs: number;
  maxMs: number;
  /** Cumulative counts at `WEB_ANNOTATION_METRIC_BUCKETS_MS` upper bounds. */
  buckets: number[];
}

/** Histogram bucket upper bounds in milliseconds (the last is +Infinity). */
export const WEB_ANNOTATION_METRIC_BUCKETS_MS = Object.freeze([
  10, 50, 100, 250, 500, 1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000,
]);

/**
 * Bounded, content-free series. Names are `family|label=value|...` built only
 * from closed vocabularies (command names, request states, error codes,
 * operations); never ids, text, URLs, selectors, or paths.
 */
export interface WebAnnotationMetricsSnapshot {
  counters: Record<string, number>;
  durations: Record<string, WebAnnotationDurationSummary>;
  gauges: Record<string, number>;
  droppedSeries: number;
}
