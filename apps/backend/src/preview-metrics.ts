import type {
  PreviewClientCounterName,
  PreviewClientHistogramName,
  PreviewClientMetricsReport,
} from "@orkestrator/protocol/preview-client-metrics";
import type { PreviewErrorCategory } from "@orkestrator/protocol/preview-services";

/** Fixed metric names; labels are limited to transport and failure category. */
export type PreviewMetricName =
  | "http.completed"
  | "http.client_aborted"
  | "http.failed"
  | "http.rejected"
  | "upstream.opened"
  | "upstream.reused"
  | "upstream.stale_retry"
  | "upgrade.open"
  | "upgrade.failed"
  | "upgrade.rejected"
  | "tunnel.open"
  | "tunnel.failed"
  | "tunnel.rejected"
  | "tunnel.closed"
  | "bootstrap.completed"
  | "bootstrap.failed"
  | "revocation.closed"
  | PreviewClientCounterName;

export type PreviewHistogramName =
  "http.connect_ms" | "http.first_byte_ms" | "tunnel.open_ms" | PreviewClientHistogramName;

const HISTOGRAM_SAMPLES = 512;

/** The last {@link HISTOGRAM_SAMPLES} values. Quantiles ignore order, so only the slot moves. */
interface SampleRing {
  values: number[];
  next: number;
}

/**
 * Bounded counters and sample histograms for preview transports. Never holds
 * URLs, paths, headers, payloads, or identifiers — only fixed names and the
 * safe failure category, so label cardinality is bounded by construction.
 */
export class PreviewMetrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<PreviewHistogramName, SampleRing>();
  private readonly gauges = new Map<string, () => number>();

  increment(name: PreviewMetricName, category?: PreviewErrorCategory, count = 1): void {
    const key = category ? `${name}{${category}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + count);
  }

  observe(name: PreviewHistogramName, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    let samples = this.histograms.get(name);
    if (!samples) {
      samples = { values: [], next: 0 };
      this.histograms.set(name, samples);
    }
    // Once full, the newest overwrites the oldest in place.
    samples.values[samples.next] = valueMs;
    samples.next = (samples.next + 1) % HISTOGRAM_SAMPLES;
  }

  /**
   * Fold in a client's validated report (`parsePreviewClientMetricsReport`).
   * Its names are a fixed vocabulary, so cardinality stays bounded.
   */
  merge(report: PreviewClientMetricsReport): void {
    for (const entry of report.counters) this.increment(entry.name, entry.category, entry.count);
    for (const [name, samples] of Object.entries(report.histograms) as Array<
      [PreviewClientHistogramName, number[]]
    >) {
      for (const sample of samples) this.observe(name, sample);
    }
  }

  gauge(name: string, read: () => number): void {
    this.gauges.set(name, read);
  }

  snapshot() {
    const histograms: Record<string, { count: number; p50: number; p95: number; max: number }> = {};
    for (const [name, samples] of this.histograms) {
      const sorted = [...samples.values].sort((a, b) => a - b);
      const at = (quantile: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
      histograms[name] = {
        count: sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? 0,
      };
    }
    const gauges: Record<string, number> = {};
    for (const [name, read] of this.gauges) {
      try {
        gauges[name] = read();
      } catch {
        gauges[name] = -1;
      }
    }
    return { counters: Object.fromEntries(this.counters), histograms, gauges };
  }
}
