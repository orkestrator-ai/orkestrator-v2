import { expect, test } from "bun:test";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";
import {
  UNKNOWN_USAGE_MODEL_ID,
  shiftUsageDay,
  usageDayKey,
} from "@orkestrator/protocol/usage-history";
import {
  MAX_RECORDED_DAYS,
  MAX_RECORDED_MODELS_PER_DAY,
  applyTurnToRecord,
  emptyUsageSessionRecord,
  usageTurnDay,
  usageTurnKey,
} from "./usage-history-record.js";

const AT = "2026-10-20T09:00:00.000Z";
const DAY = "2026-10-20";

function turn(turnId: string, overrides: Partial<NativeAgentTurnUsage> = {}): NativeAgentTurnUsage {
  return { turnId, inputTokens: 100, modelId: "model-a", ...overrides };
}

function dayTotals(models: Record<string, { totalTokens: number; turns: number }>) {
  return Object.values(models).reduce(
    (sum, totals) => ({
      totalTokens: sum.totalTokens + totals.totalTokens,
      turns: sum.turns + totals.turns,
    }),
    { totalTokens: 0, turns: 0 },
  );
}

test("folding a day's overflow models keeps the day's totals exact", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  const models = MAX_RECORDED_MODELS_PER_DAY + 6;
  for (let index = 0; index < models; index += 1) {
    applyTurnToRecord(record, turn(`t${index}`, { modelId: `model-${index}` }), DAY, AT);
  }
  const bucket = record.days[DAY]!;
  // The list is cut, but nothing is lost: the models that no longer fit are
  // folded into the unnamed bucket rather than dropped. The bound is a
  // ceiling, not a target — the fold target is itself subject to the next cut.
  expect(Object.keys(bucket.models).length).toBeLessThanOrEqual(MAX_RECORDED_MODELS_PER_DAY);
  expect(bucket.models[UNKNOWN_USAGE_MODEL_ID]).toBeDefined();
  expect(dayTotals(bucket.models)).toEqual({ totalTokens: models * 100, turns: models });
});

test("an already-folded unnamed bucket keeps absorbing later overflow", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  // A heavy unnamed bucket survives the cut, so the fold has to add into it.
  applyTurnToRecord(record, turn("heavy", { inputTokens: 10_000, modelId: "   " }), DAY, AT);
  const models = MAX_RECORDED_MODELS_PER_DAY + 6;
  for (let index = 0; index < models; index += 1) {
    applyTurnToRecord(record, turn(`t${index}`, { modelId: `model-${index}` }), DAY, AT);
  }
  const bucket = record.days[DAY]!;
  expect(Object.keys(bucket.models).length).toBeLessThanOrEqual(MAX_RECORDED_MODELS_PER_DAY);
  expect(dayTotals(bucket.models)).toEqual({
    totalTokens: 10_000 + models * 100,
    turns: models + 1,
  });
});

test("a row keeps a bounded number of day buckets, oldest first out", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  const extra = 10;
  const oldest = shiftUsageDay(DAY, MAX_RECORDED_DAYS + extra - 1);
  for (let index = 0; index < MAX_RECORDED_DAYS + extra; index += 1) {
    applyTurnToRecord(record, turn(`t${index}`), shiftUsageDay(oldest, -index), AT);
  }
  const days = Object.keys(record.days).sort();
  expect(days.length).toBe(MAX_RECORDED_DAYS);
  expect(days.at(-1)).toBe(DAY);
  expect(days[0]).toBe(shiftUsageDay(oldest, -extra));
  expect(record.days[oldest]).toBeUndefined();
});

test("a turn number reused by the next conversation in the same tab is still counted", () => {
  const record = emptyUsageSessionRecord("env-1", "grok", AT);
  // The ACP and Pi bridges number turns per session, so a replaced
  // conversation starts again at `turn-1`.
  expect(applyTurnToRecord(record, turn("turn-1"), DAY, AT, "conv-a")).toBe(true);
  expect(applyTurnToRecord(record, turn("turn-1"), DAY, AT, "conv-a")).toBe(false);
  expect(applyTurnToRecord(record, turn("turn-1"), DAY, AT, "conv-b")).toBe(true);
  expect(record.days[DAY]!.models["model-a"]!.turns).toBe(2);
  expect(record.turnIds).toEqual([
    usageTurnKey("turn-1", "conv-a"),
    usageTurnKey("turn-1", "conv-b"),
  ]);
});

test("an unscoped id written by an older build is still refused", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  record.turnIds.push("turn-1");
  // Rows written before turn ids were scoped hold bare ids. Re-recording the
  // turns the provider is still republishing would count them twice.
  expect(applyTurnToRecord(record, turn("turn-1"), DAY, AT, "conv-a")).toBe(false);
  expect(record.days[DAY]).toBeUndefined();
});

test("a turn with no id is never recorded", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  expect(applyTurnToRecord(record, turn(""), DAY, AT, "conv-a")).toBe(false);
  expect(record.turnIds).toEqual([]);
});

test("a turn is bucketed by the day its bridge finalized it", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  // A conversation observed for the first time republishes its backlog. Each
  // turn belongs to the day it ran, not to the day it was read.
  applyTurnToRecord(record, turn("old", { at: "2026-08-03T22:30:00.000Z" }), DAY, AT);
  applyTurnToRecord(record, turn("new", { at: "2026-10-20T08:00:00.000Z" }), DAY, AT);
  const days = Object.keys(record.days).sort();
  expect(days).toEqual([usageDayKey(new Date("2026-08-03T22:30:00.000Z")), DAY]);
  expect(Object.keys(record.days[DAY]!.models)).toEqual(["model-a"]);
});

test("a turn its bridge could not date falls back to the day it was seen", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  applyTurnToRecord(record, turn("undated"), DAY, AT);
  applyTurnToRecord(record, turn("unparseable", { at: "not a date" }), DAY, AT);
  expect(Object.keys(record.days)).toEqual([DAY]);
  expect(record.days[DAY]!.models["model-a"]!.turns).toBe(2);
});

test("a turn dated ahead of the observation day is clamped back to it", () => {
  const record = emptyUsageSessionRecord("env-1", "claude", AT);
  // A clock that moved, or a bridge on another host. A bucket past the end of
  // every range a pane can ask for would never be reported at all.
  applyTurnToRecord(record, turn("ahead", { at: "2027-01-01T00:00:00.000Z" }), DAY, AT);
  expect(Object.keys(record.days)).toEqual([DAY]);
});

test("usageTurnDay reads the turn's own day, the fallback, and nothing else", () => {
  expect(usageTurnDay({ turnId: "t" }, DAY)).toBe(DAY);
  expect(usageTurnDay({ turnId: "t", at: "" }, DAY)).toBe(DAY);
  expect(usageTurnDay({ turnId: "t", at: "nonsense" }, DAY)).toBe(DAY);
  expect(usageTurnDay({ turnId: "t", at: "2026-10-20T23:00:00.000Z" }, "2026-10-21")).toBe(
    usageDayKey(new Date("2026-10-20T23:00:00.000Z")),
  );
});
