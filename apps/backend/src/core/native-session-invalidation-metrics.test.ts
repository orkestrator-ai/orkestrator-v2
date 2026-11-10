import { describe, expect, test } from "bun:test";
import type { NativeSessionInvalidationCause } from "@orkestrator/protocol/native-agent-observation";
import {
  DISCOVERY_RENEWAL_PATH_LIMIT,
  NativeSessionInvalidationMetrics,
} from "./native-session-invalidation-metrics.js";
import { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

describe("NativeSessionInvalidationMetrics", () => {
  test("counts by cause and by the platform or environment an invalidation named", () => {
    let now = 100;
    const metrics = new NativeSessionInvalidationMetrics({ now: () => now });
    metrics.record("discovery-renewal", "codex");
    metrics.record("discovery-renewal", "codex");
    metrics.record("content-revision", "codex");
    metrics.record("projection-read", "claude");
    metrics.record("model-catalog-refresh");
    now = 1_600;

    expect(metrics.snapshot()).toEqual({
      enabled: true,
      windowMs: 1_500,
      total: 5,
      byCause: {
        "discovery-renewal": 2,
        "content-revision": 1,
        "projection-read": 1,
        "model-catalog-refresh": 1,
      },
      byScope: {
        codex: { "discovery-renewal": 2, "content-revision": 1 },
        claude: { "projection-read": 1 },
        environment: { "model-catalog-refresh": 1 },
      },
      droppedLabels: 0,
      discoveryRenewals: {},
    });
  });

  test("names the discovery section and changed paths of each announcement (#2062)", () => {
    const metrics = new NativeSessionInvalidationMetrics();
    metrics.recordDiscoveryRenewal("runtime", "codex", ["summary.notices[].occurrences[]"]);
    metrics.recordDiscoveryRenewal("runtime", "codex", [
      "summary.notices[].occurrences[]",
      "summary.state",
    ]);
    metrics.recordDiscoveryRenewal("mcp", "pi", ["initial"]);
    expect(metrics.snapshot().discoveryRenewals).toEqual({
      codex: {
        runtime: {
          count: 2,
          changed: { "summary.notices[].occurrences[]": 2, "summary.state": 1 },
        },
      },
      pi: { mcp: { count: 1, changed: { initial: 1 } } },
    });
    metrics.reset();
    expect(metrics.snapshot().discoveryRenewals).toEqual({});
  });

  test("discovery labels stay inside their vocabulary and bounds", () => {
    const metrics = new NativeSessionInvalidationMetrics();
    metrics.recordDiscoveryRenewal("secrets" as never, "codex", ["value"]);
    metrics.recordDiscoveryRenewal("mcp", "env-1:private-session-key", ["value"]);
    // A path that is not a structural name is dropped, not kept.
    metrics.recordDiscoveryRenewal("mcp", "codex", ["value", "a prompt with spaces"]);
    for (let index = 0; index < DISCOVERY_RENEWAL_PATH_LIMIT + 5; index += 1) {
      metrics.recordDiscoveryRenewal("commands", "codex", [`value[].k${index}`]);
    }
    const snapshot = metrics.snapshot();
    expect(snapshot.droppedLabels).toBe(3);
    expect(snapshot.discoveryRenewals?.codex?.mcp).toEqual({ count: 1, changed: { value: 1 } });
    const commands = snapshot.discoveryRenewals?.codex?.commands;
    expect(Object.keys(commands?.changed ?? {})).toHaveLength(DISCOVERY_RENEWAL_PATH_LIMIT + 1);
    expect(commands?.changed.other).toBe(5);
    expect(JSON.stringify(snapshot)).not.toContain("private-session-key");
    expect(JSON.stringify(snapshot)).not.toContain("prompt");
  });

  test("never keeps a label outside the vocabulary", () => {
    const metrics = new NativeSessionInvalidationMetrics();
    // What a caller that leaked content would pass: neither is retained.
    metrics.record("env-env-1:tab with a prompt" as NativeSessionInvalidationCause, "codex");
    metrics.record(undefined as unknown as NativeSessionInvalidationCause);
    metrics.record("hydration", "env-1:private-session-key");
    const snapshot = metrics.snapshot();
    expect(snapshot.droppedLabels).toBe(3);
    // The cause is known, so it still counts; the unknown scope does not.
    expect(snapshot.byCause).toEqual({ hydration: 1 });
    expect(snapshot.byScope).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain("prompt");
    expect(JSON.stringify(snapshot)).not.toContain("private-session-key");
  });

  test("disabled records nothing, and reset starts a new window", () => {
    let now = 0;
    const metrics = new NativeSessionInvalidationMetrics({ enabled: false, now: () => now });
    metrics.record("transition", "pi");
    expect(metrics.snapshot().total).toBe(0);
    metrics.setEnabled(true);
    metrics.record("transition", "pi");
    now = 50;
    metrics.reset();
    now = 70;
    expect(metrics.snapshot()).toMatchObject({ total: 0, byCause: {}, byScope: {}, windowMs: 20 });
  });

  test("recurring-work diagnostics report the counters", () => {
    const invalidations = new NativeSessionInvalidationMetrics();
    invalidations.record("record-dispatch", "cursor");
    const diagnostics = new RecurringDiagnosticsRegistry().snapshot(
      new RecurringWorkMetrics(),
      invalidations,
    );
    expect(diagnostics.sessionInvalidations).toMatchObject({
      total: 1,
      byScope: { cursor: { "record-dispatch": 1 } },
    });
  });
});
