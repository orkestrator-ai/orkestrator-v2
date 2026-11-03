import { describe, expect, test } from "bun:test";

import {
  parsePreviewClientMetricsReport,
  PREVIEW_CLIENT_METRICS_LIMITS,
  PreviewClientMetricsBuffer,
} from "./preview-client-metrics";

describe("preview client metrics", () => {
  test("a buffered report round-trips through the parser", () => {
    const buffer = new PreviewClientMetricsBuffer();
    buffer.increment("desktop.reconnect", "access-expired");
    buffer.increment("desktop.reconnect", "access-expired");
    buffer.increment("desktop.reconnect_failed", "capacity-exceeded");
    buffer.observe("desktop.connect_ms", 12.5);
    buffer.observe("desktop.first_byte_ms", 40);
    const report = buffer.take();
    expect(report).toEqual({
      counters: [
        { name: "desktop.reconnect", category: "access-expired", count: 2 },
        { name: "desktop.reconnect_failed", category: "capacity-exceeded", count: 1 },
      ],
      histograms: { "desktop.connect_ms": [12.5], "desktop.first_byte_ms": [40] },
    });
    expect(parsePreviewClientMetricsReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    // Taking empties the buffer; an empty buffer reports nothing.
    expect(buffer.empty).toBe(true);
    expect(buffer.take()).toBeNull();
  });

  test("the buffer is bounded and ignores values that are not latencies", () => {
    const buffer = new PreviewClientMetricsBuffer();
    const limit = PREVIEW_CLIENT_METRICS_LIMITS.samplesPerSeries;
    for (let index = 0; index < limit + 10; index += 1) buffer.observe("desktop.connect_ms", index);
    buffer.observe("desktop.connect_ms", Number.NaN);
    buffer.observe("desktop.connect_ms", -1);
    buffer.observe("desktop.connect_ms", PREVIEW_CLIENT_METRICS_LIMITS.sampleMaxMs + 1);
    const samples = buffer.take()!.histograms["desktop.connect_ms"]!;
    expect(samples).toHaveLength(limit);
    // Newest samples win.
    expect(samples[0]).toBe(10);
    expect(samples.at(-1)).toBe(limit + 9);
  });

  test("anything outside the fixed vocabulary rejects the whole report", () => {
    const valid = {
      counters: [{ name: "desktop.reconnect", category: "generation-changed", count: 1 }],
      histograms: { "desktop.first_byte_ms": [5] },
    };
    expect(parsePreviewClientMetricsReport(valid)).not.toBeNull();
    const invalid: unknown[] = [
      null,
      "desktop.reconnect",
      [],
      { counters: [], histograms: [] },
      { counters: {}, histograms: {} },
      // Free-form names and labels could carry URLs or identifiers.
      { counters: [{ name: "desktop.reconnect{http://svc/?token=x}", count: 1 }], histograms: {} },
      { counters: [{ name: "http.completed", count: 1 }], histograms: {} },
      { counters: [{ name: "desktop.reconnect", category: "/secret", count: 1 }], histograms: {} },
      { counters: [{ name: "desktop.reconnect", count: 0 }], histograms: {} },
      { counters: [{ name: "desktop.reconnect", count: 1.5 }], histograms: {} },
      {
        counters: [
          { name: "desktop.reconnect", count: PREVIEW_CLIENT_METRICS_LIMITS.countPerReport + 1 },
        ],
        histograms: {},
      },
      { counters: [], histograms: { "https://example.test/path": [1] } },
      { counters: [], histograms: { "tunnel.open_ms": [1] } },
      { counters: [], histograms: { "desktop.connect_ms": ["1"] } },
      { counters: [], histograms: { "desktop.connect_ms": [-1] } },
      {
        counters: [],
        histograms: {
          "desktop.connect_ms": Array.from(
            { length: PREVIEW_CLIENT_METRICS_LIMITS.samplesPerSeries + 1 },
            () => 1,
          ),
        },
      },
    ];
    for (const report of invalid) expect(parsePreviewClientMetricsReport(report)).toBeNull();
  });

  test("parsed reports carry no extra fields", () => {
    const parsed = parsePreviewClientMetricsReport({
      counters: [{ name: "desktop.reconnect", count: 1, url: "http://svc/?token=x" }],
      histograms: {},
      serviceId: "svc_secret",
    });
    expect(JSON.stringify(parsed)).not.toContain("token");
    expect(JSON.stringify(parsed)).not.toContain("svc_secret");
  });
});
