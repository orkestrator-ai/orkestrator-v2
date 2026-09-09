import { describe, expect, test } from "bun:test";
import { WorkflowResultMetrics } from "./workflow-result-metrics.js";
import { WorkflowResultRollout } from "./workflow-result-rollout.js";

describe("WorkflowResultRollout", () => {
  test("defaults to the qualified providers before any configuration is read", () => {
    const rollout = new WorkflowResultRollout(async () => undefined);
    expect(rollout.allows("codex", "review-report")).toBe(true);
    expect(rollout.allows("claude", "feature-plan-state")).toBe(true);
    expect(rollout.allows("opencode", "review-report")).toBe(false);
    expect(rollout.allows("cursor", "fix-result")).toBe(false);
  });

  test("the master switch closes admission for every combination", async () => {
    const rollout = new WorkflowResultRollout(async () => ({ enabled: false }));
    await rollout.refresh();
    expect(rollout.allows("codex", "review-report")).toBe(false);
    expect(rollout.allows("claude", "verification-result")).toBe(false);
  });

  test("configuration cannot enable a provider the code has not qualified", async () => {
    const rollout = new WorkflowResultRollout(async () => ({
      enabled: true,
      providers: ["opencode", "cursor", "grok", "pi", "codex"],
      kinds: ["review-report"],
    }));
    await rollout.refresh();
    // These four have no per-turn capability channel. Admitting them would
    // dispatch a turn the model could never submit against.
    expect(rollout.allows("opencode", "review-report")).toBe(false);
    expect(rollout.allows("cursor", "review-report")).toBe(false);
    expect(rollout.allows("grok", "review-report")).toBe(false);
    expect(rollout.allows("pi", "review-report")).toBe(false);
    expect(rollout.allows("codex", "review-report")).toBe(true);
  });

  test("a combination can be enabled per provider and per kind", async () => {
    const rollout = new WorkflowResultRollout(async () => ({
      enabled: true,
      providers: ["codex"],
      kinds: ["review-report"],
    }));
    await rollout.refresh();
    expect(rollout.allows("codex", "review-report")).toBe(true);
    expect(rollout.allows("codex", "fix-result")).toBe(false);
    expect(rollout.allows("claude", "review-report")).toBe(false);
  });

  test("a failed configuration read keeps the previous snapshot", async () => {
    let fail = false;
    const rollout = new WorkflowResultRollout(async () => {
      if (fail) throw new Error("config unavailable");
      return { enabled: true, providers: ["claude"], kinds: ["review-report"] };
    });
    await rollout.refresh();
    fail = true;
    await rollout.refresh();
    expect(rollout.snapshot()).toEqual({
      enabled: true,
      providers: ["claude"],
      kinds: ["review-report"],
    });
  });

  test("concurrent refreshes share one configuration read", async () => {
    let reads = 0;
    const rollout = new WorkflowResultRollout(async () => {
      reads += 1;
      return { enabled: true };
    });
    await Promise.all([rollout.refresh(), rollout.refresh(), rollout.refresh()]);
    expect(reads).toBe(1);
  });

  test("the snapshot is a copy a caller cannot use to widen admission", async () => {
    const rollout = new WorkflowResultRollout(async () => ({ providers: ["codex"] }));
    await rollout.refresh();
    const snapshot = rollout.snapshot();
    snapshot.providers.push("opencode");
    expect(rollout.allows("opencode", "review-report")).toBe(false);
  });
});

describe("WorkflowResultMetrics", () => {
  test("series names carry only fixed dimensions", () => {
    const metrics = new WorkflowResultMetrics();
    metrics.recordAttempt({
      provider: "codex",
      kind: "review-report",
      transport: "tool-v1",
      schemaVersion: 1,
    });
    metrics.recordSubmission({
      provider: "codex",
      kind: "review-report",
      outcome: "rejected",
      code: "invalid_result",
    });
    const keys = Object.keys(metrics.snapshot().counters);
    expect(keys).toEqual([
      "attempts|provider=codex|kind=review-report|transport=tool-v1|schema=1",
      "submissions|provider=codex|kind=review-report|outcome=rejected|code=invalid_result",
    ]);
  });

  test("the series table is bounded and reports what it dropped", () => {
    const metrics = new WorkflowResultMetrics();
    for (let index = 0; index < 600; index += 1) {
      metrics.recordAttempt({
        provider: "codex",
        kind: "review-report",
        transport: "tool-v1",
        schemaVersion: index,
      });
    }
    const snapshot = metrics.snapshot();
    expect(Object.keys(snapshot.counters).length).toBe(512);
    expect(snapshot.droppedSeries).toBe(88);
  });

  test("durations summarise without retaining individual observations", () => {
    const metrics = new WorkflowResultMetrics();
    metrics.recordValidationDuration("review-report", 10);
    metrics.recordValidationDuration("review-report", 30);
    metrics.recordValidationDuration("review-report", -1);
    expect(metrics.snapshot().durations["validation_ms|kind=review-report"]).toEqual({
      count: 2,
      totalMs: 40,
      maxMs: 30,
    });
  });

  test("gauges refuse non-finite values and never go negative", () => {
    const metrics = new WorkflowResultMetrics();
    metrics.setGauge("pending_bytes", Number.NaN);
    expect(metrics.snapshot().gauges.pending_bytes).toBeUndefined();
    metrics.setGauge("pending_calls", -4);
    expect(metrics.snapshot().gauges.pending_calls).toBe(0);
  });
});
