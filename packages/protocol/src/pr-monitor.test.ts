import { describe, expect, test } from "bun:test";
import {
  PR_MONITOR_BACKOFF,
  PR_MONITOR_INTERVALS_MS,
  getEffectivePrMonitorInterval,
  isPrCheckSummary,
  isPrMonitorEvent,
  isPrMonitorMode,
  isPrMonitorSnapshot,
  type PrMonitorEnvironmentState,
} from "./pr-monitor.js";

function state(overrides: Partial<PrMonitorEnvironmentState> = {}): PrMonitorEnvironmentState {
  return {
    environmentId: "env-1",
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-07-28T00:00:00.000Z",
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    ...overrides,
  };
}

describe("getEffectivePrMonitorInterval", () => {
  test("returns the base interval with no errors", () => {
    expect(getEffectivePrMonitorInterval("normal", 0)).toBe(20_000);
    expect(getEffectivePrMonitorInterval("create-pending", 0)).toBe(5_000);
    expect(getEffectivePrMonitorInterval("merge-pending", 0)).toBe(1_000);
  });

  test("doubles per error and caps at the maximum", () => {
    expect(getEffectivePrMonitorInterval("normal", 1)).toBe(40_000);
    expect(getEffectivePrMonitorInterval("normal", 3)).toBe(160_000);
    // 20s * 2^4 = 320s, capped at 300s; further errors stay capped.
    expect(getEffectivePrMonitorInterval("normal", 4)).toBe(PR_MONITOR_BACKOFF.maxIntervalMs);
    expect(getEffectivePrMonitorInterval("normal", 99)).toBe(PR_MONITOR_BACKOFF.maxIntervalMs);
    // merge-pending backs off from a lower base and never reaches the cap
    // within the error ceiling.
    expect(getEffectivePrMonitorInterval("merge-pending", 99)).toBe(
      PR_MONITOR_INTERVALS_MS["merge-pending"] * 2 ** PR_MONITOR_BACKOFF.maxErrors,
    );
  });
});

describe("lastSuccessfulCheckAt", () => {
  test("is optional, nullable, and otherwise a string", () => {
    const event = (value: unknown) => ({
      environmentId: "env-1",
      state: { ...state(), lastSuccessfulCheckAt: value },
    });
    expect(isPrMonitorEvent({ environmentId: "env-1", state: state() })).toBe(true);
    expect(isPrMonitorEvent(event(null))).toBe(true);
    expect(isPrMonitorEvent(event("2026-07-28T00:00:00.000Z"))).toBe(true);
    expect(isPrMonitorEvent(event(42))).toBe(false);
  });
});

describe("isPrMonitorMode", () => {
  test("accepts the three modes and rejects everything else", () => {
    expect(isPrMonitorMode("normal")).toBe(true);
    expect(isPrMonitorMode("create-pending")).toBe(true);
    expect(isPrMonitorMode("merge-pending")).toBe(true);
    expect(isPrMonitorMode("idle")).toBe(false);
    expect(isPrMonitorMode(undefined)).toBe(false);
  });
});

describe("isPrCheckSummary", () => {
  test("accepts bounded aggregate counts", () => {
    expect(isPrCheckSummary({ passed: 3, total: 5, pending: 1 })).toBe(true);
    expect(isPrCheckSummary({ passed: 0, total: 0, pending: 0 })).toBe(true);
  });

  test("rejects impossible or non-integral counts", () => {
    expect(isPrCheckSummary({ passed: 4, total: 3, pending: 0 })).toBe(false);
    expect(isPrCheckSummary({ passed: 2, total: 3, pending: 2 })).toBe(false);
    expect(isPrCheckSummary({ passed: -1, total: 3, pending: 0 })).toBe(false);
    expect(isPrCheckSummary({ passed: 1.5, total: 3, pending: 0 })).toBe(false);
  });
});

describe("isPrMonitorEvent", () => {
  test("accepts state events, transitions, and removals", () => {
    expect(isPrMonitorEvent({ environmentId: "env-1", state: state() })).toBe(true);
    expect(isPrMonitorEvent({ environmentId: "env-1", removed: true })).toBe(true);
    expect(
      isPrMonitorEvent({
        environmentId: "env-1",
        state: state({ prState: "merged" }),
        transition: {
          url: "https://github.com/org/repo/pull/1",
          state: "merged",
          previousState: "open",
        },
      }),
    ).toBe(true);
  });

  test("accepts null PR fields for an environment being watched before a PR exists", () => {
    expect(
      isPrMonitorEvent({
        environmentId: "env-1",
        state: state({ prUrl: null, prState: null, hasMergeConflicts: null, lastCheckAt: null }),
      }),
    ).toBe(true);
  });

  test("rejects malformed payloads rather than trusting the wire", () => {
    expect(isPrMonitorEvent(null)).toBe(false);
    expect(isPrMonitorEvent({})).toBe(false);
    expect(isPrMonitorEvent({ environmentId: "", removed: true })).toBe(false);
    expect(isPrMonitorEvent({ environmentId: "env-1" })).toBe(false);
    expect(
      isPrMonitorEvent({
        environmentId: "env-1",
        state: state({ environmentId: "env-2" }),
      }),
    ).toBe(false);
    expect(
      isPrMonitorEvent({ environmentId: "env-1", state: state({ mode: "idle" as never }) }),
    ).toBe(false);
    expect(
      isPrMonitorEvent({ environmentId: "env-1", state: state({ consecutiveErrors: -1 }) }),
    ).toBe(false);
    expect(
      isPrMonitorEvent({
        environmentId: "env-1",
        state: state({ checkSummary: { passed: 2, total: 1, pending: 0 } }),
      }),
    ).toBe(false);
    expect(
      isPrMonitorEvent({
        environmentId: "env-1",
        state: state(),
        transition: { url: "", state: "merged", previousState: null },
      }),
    ).toBe(false);
    expect(
      isPrMonitorEvent({
        environmentId: "env-1",
        state: state(),
        transition: {
          url: "https://github.com/org/repo/pull/1",
          state: "reopened",
          previousState: null,
        },
      }),
    ).toBe(false);
  });
});

describe("isPrMonitorSnapshot", () => {
  test("accepts an entries array of states and rejects anything else", () => {
    expect(isPrMonitorSnapshot({ entries: [] })).toBe(true);
    expect(isPrMonitorSnapshot({ entries: [state(), state({ environmentId: "env-2" })] })).toBe(
      true,
    );
    expect(isPrMonitorSnapshot({ entries: [state(), { environmentId: "env-3" }] })).toBe(false);
    expect(isPrMonitorSnapshot({ entries: null })).toBe(false);
    expect(isPrMonitorSnapshot([])).toBe(false);
    expect(isPrMonitorSnapshot(null)).toBe(false);
  });
});

describe("optional revision metadata", () => {
  test("accepts stamped and legacy events, rejecting a partial or malformed stamp", () => {
    const base = { environmentId: "env-1", state: state() };
    expect(isPrMonitorEvent(base)).toBe(true);
    expect(isPrMonitorEvent({ ...base, generation: "gen-1", revision: 4 })).toBe(true);
    expect(
      isPrMonitorEvent({ environmentId: "env-1", removed: true, generation: "g", revision: 5 }),
    ).toBe(true);
    expect(isPrMonitorEvent({ ...base, generation: "gen-1" })).toBe(false);
    expect(isPrMonitorEvent({ ...base, generation: "gen-1", revision: 0 })).toBe(false);
    expect(isPrMonitorEvent({ environmentId: "env-1", removed: true, revision: 5 })).toBe(false);
  });

  test("accepts a stamped snapshot at revision zero and rejects a malformed stamp", () => {
    expect(isPrMonitorSnapshot({ entries: [], generation: "gen-1", revision: 0 })).toBe(true);
    expect(isPrMonitorSnapshot({ entries: [state()], generation: "gen-1", revision: 12 })).toBe(
      true,
    );
    expect(isPrMonitorSnapshot({ entries: [], generation: "gen 1", revision: 0 })).toBe(false);
    expect(isPrMonitorSnapshot({ entries: [], revision: 3 })).toBe(false);
  });
});
