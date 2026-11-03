import { isPreviewErrorCategory, type PreviewErrorCategory } from "./preview-services.js";

/**
 * Preview metrics a client measures and reports to the backend it previews
 * through, so they appear in `get_preview_diagnostics` beside the backend's
 * own series. Only these fixed names, a safe failure category and numbers ever
 * cross: never URLs, paths, headers, payloads, identifiers or credentials.
 */
export const PREVIEW_CLIENT_COUNTER_NAMES = [
  /** A desktop tunnel had to reattach (labelled by the category that forced it). */
  "desktop.reconnect",
  /** A reattach failed (labelled by its failure category). */
  "desktop.reconnect_failed",
] as const;

export const PREVIEW_CLIENT_HISTOGRAM_NAMES = [
  /** Desktop ingress: tunnel WebSocket connect through `OPEN_OK`, for a new upstream. */
  "desktop.connect_ms",
  /** Desktop ingress: request start until the upstream response head arrived. */
  "desktop.first_byte_ms",
] as const;

export type PreviewClientCounterName = (typeof PREVIEW_CLIENT_COUNTER_NAMES)[number];
export type PreviewClientHistogramName = (typeof PREVIEW_CLIENT_HISTOGRAM_NAMES)[number];

export const PREVIEW_CLIENT_METRICS_LIMITS = {
  /** Samples kept per histogram between reports (newest win). */
  samplesPerSeries: 512,
  /** Largest single counter increment one report may carry. */
  countPerReport: 100_000,
  /** Samples above this are not a latency, they are a stuck request. */
  sampleMaxMs: 10 * 60_000,
  /** How often a client reports what it has buffered. */
  reportIntervalMs: 30_000,
} as const;

export interface PreviewClientCounterEntry {
  name: PreviewClientCounterName;
  category?: PreviewErrorCategory;
  count: number;
}

export interface PreviewClientMetricsReport {
  counters: PreviewClientCounterEntry[];
  histograms: Partial<Record<PreviewClientHistogramName, number[]>>;
}

function isCounterName(value: unknown): value is PreviewClientCounterName {
  return (
    typeof value === "string" && (PREVIEW_CLIENT_COUNTER_NAMES as readonly string[]).includes(value)
  );
}

function isHistogramName(value: unknown): value is PreviewClientHistogramName {
  return (
    typeof value === "string" &&
    (PREVIEW_CLIENT_HISTOGRAM_NAMES as readonly string[]).includes(value)
  );
}

function isSample(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= PREVIEW_CLIENT_METRICS_LIMITS.sampleMaxMs
  );
}

/**
 * Validate a report from a client. Anything outside the fixed vocabulary or
 * the bounds rejects the whole report rather than being trimmed, so a newer
 * client cannot smuggle a free-form label through an older backend.
 */
export function parsePreviewClientMetricsReport(value: unknown): PreviewClientMetricsReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { counters, histograms } = value as Record<string, unknown>;
  if (!Array.isArray(counters) || !histograms || typeof histograms !== "object") return null;
  if (Array.isArray(histograms)) return null;
  const maxCounters = PREVIEW_CLIENT_COUNTER_NAMES.length * 64;
  if (counters.length > maxCounters) return null;
  const parsedCounters: PreviewClientCounterEntry[] = [];
  for (const entry of counters) {
    if (!entry || typeof entry !== "object") return null;
    const { name, category, count } = entry as Record<string, unknown>;
    if (!isCounterName(name)) return null;
    if (category !== undefined && !isPreviewErrorCategory(category)) return null;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > PREVIEW_CLIENT_METRICS_LIMITS.countPerReport
    )
      return null;
    parsedCounters.push(category === undefined ? { name, count } : { name, category, count });
  }
  const parsedHistograms: PreviewClientMetricsReport["histograms"] = {};
  for (const [name, samples] of Object.entries(histograms)) {
    if (!isHistogramName(name) || !Array.isArray(samples)) return null;
    if (samples.length > PREVIEW_CLIENT_METRICS_LIMITS.samplesPerSeries) return null;
    if (!samples.every(isSample)) return null;
    parsedHistograms[name] = [...samples];
  }
  return { counters: parsedCounters, histograms: parsedHistograms };
}

/**
 * Client-side buffer between reports. Bounded by construction: counters are
 * keyed by fixed name and category, and each histogram keeps its newest
 * `samplesPerSeries` samples.
 */
export class PreviewClientMetricsBuffer {
  private counters = new Map<string, PreviewClientCounterEntry>();
  private histograms = new Map<PreviewClientHistogramName, number[]>();

  increment(name: PreviewClientCounterName, category?: PreviewErrorCategory): void {
    const key = category ? `${name}{${category}}` : name;
    const entry = this.counters.get(key);
    if (entry)
      entry.count = Math.min(entry.count + 1, PREVIEW_CLIENT_METRICS_LIMITS.countPerReport);
    else this.counters.set(key, category ? { name, category, count: 1 } : { name, count: 1 });
  }

  observe(name: PreviewClientHistogramName, valueMs: number): void {
    if (!isSample(valueMs)) return;
    const samples = this.histograms.get(name) ?? [];
    samples.push(valueMs);
    if (samples.length > PREVIEW_CLIENT_METRICS_LIMITS.samplesPerSeries) samples.shift();
    this.histograms.set(name, samples);
  }

  get empty(): boolean {
    return this.counters.size === 0 && this.histograms.size === 0;
  }

  /** Hand over everything buffered and start again from empty. */
  take(): PreviewClientMetricsReport | null {
    if (this.empty) return null;
    const report: PreviewClientMetricsReport = {
      counters: Array.from(this.counters.values()),
      histograms: Object.fromEntries(this.histograms),
    };
    this.counters = new Map();
    this.histograms = new Map();
    return report;
  }
}
