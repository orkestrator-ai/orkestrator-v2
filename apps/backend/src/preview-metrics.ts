import type { PreviewErrorCategory } from "@orkestrator/protocol/preview-services";

/** Fixed metric names; labels are limited to transport and failure category. */
export type PreviewMetricName =
  | "http.completed"
  | "http.client_aborted"
  | "http.failed"
  | "http.rejected"
  | "upgrade.open"
  | "upgrade.failed"
  | "upgrade.rejected"
  | "tunnel.open"
  | "tunnel.failed"
  | "tunnel.rejected"
  | "tunnel.closed"
  | "bootstrap.completed"
  | "bootstrap.failed"
  | "revocation.closed";

export type PreviewHistogramName = "http.connect_ms" | "http.first_byte_ms" | "tunnel.open_ms";

const HISTOGRAM_SAMPLES = 512;

/**
 * Bounded counters and sample histograms for preview transports. Never holds
 * URLs, paths, headers, payloads, or identifiers — only fixed names and the
 * safe failure category, so label cardinality is bounded by construction.
 */
export class PreviewMetrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<PreviewHistogramName, number[]>();
  private readonly gauges = new Map<string, () => number>();

  increment(name: PreviewMetricName, category?: PreviewErrorCategory): void {
    const key = category ? `${name}{${category}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: PreviewHistogramName, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const samples = this.histograms.get(name) ?? [];
    samples.push(valueMs);
    if (samples.length > HISTOGRAM_SAMPLES) samples.shift();
    this.histograms.set(name, samples);
  }

  gauge(name: string, read: () => number): void {
    this.gauges.set(name, read);
  }

  snapshot() {
    const histograms: Record<string, { count: number; p50: number; p95: number; max: number }> = {};
    for (const [name, samples] of this.histograms) {
      const sorted = [...samples].sort((a, b) => a - b);
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
