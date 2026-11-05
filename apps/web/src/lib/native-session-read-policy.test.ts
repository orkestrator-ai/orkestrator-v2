import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentDiscoveryView } from "@orkestrator/protocol/native-agent";
import { DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS } from "./data-saving-policy";
import {
  ACTIVE_PROJECTION_REFRESH_MS,
  DISCOVERY_BACKSTOP_MS,
  IDLE_PROJECTION_REFRESH_MS,
  NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PROVIDERS,
  NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS,
  NATIVE_QUIET_BACKOFF_TRIAL_MS,
  NativeDiscoveryReadSchedule,
  nativeSessionReadDemand,
} from "./native-session-read-policy";

describe("native session read policy", () => {
  test("preserves the baseline foreground cadence for every phase", () => {
    for (const phase of ["running", "blocked", "cancelling", "recovering"]) {
      expect(nativeSessionReadDemand("codex", phase, { active: true })).toEqual({
        active: true,
        intervalMs: ACTIVE_PROJECTION_REFRESH_MS,
        priority: "critical",
        quietBackoffMs: null,
        dataSaving: { intervalMs: DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS },
      });
    }
    for (const phase of ["idle", "completed", undefined]) {
      expect(nativeSessionReadDemand("claude", phase, { active: false })).toMatchObject({
        active: false,
        intervalMs: IDLE_PROJECTION_REFRESH_MS,
        quietBackoffMs: null,
      });
    }
    expect(ACTIVE_PROJECTION_REFRESH_MS).toBe(500);
    expect(IDLE_PROJECTION_REFRESH_MS).toBe(1_500);
  });

  test("quiet backoff needs a qualified provider and a backend that announces transitions", () => {
    // The single qualification switch, shared with the backend capability matrix.
    expect([...NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS].sort() as string[]).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
    for (const platform of AGENT_PLATFORMS) {
      // An older backend (no stamped activity announcements) keeps the baseline.
      expect(nativeSessionReadDemand(platform, "idle", { active: true }).quietBackoffMs).toBeNull();
      expect(
        nativeSessionReadDemand(platform, "idle", {
          active: true,
          observationEvents: true,
          quietObservation: true,
        }).quietBackoffMs,
      ).toEqual(
        NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS.has(platform)
          ? NATIVE_QUIET_BACKOFF_TRIAL_MS
          : null,
      );
    }
  });

  test("Claude and Codex back off only while the session is marked quietObservation", () => {
    expect([...NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PROVIDERS].sort() as string[]).toEqual([
      "claude",
      "codex",
    ]);
    for (const platform of ["claude", "codex"] as const) {
      // An older bridge, or a session before its first observation: baseline.
      expect(
        nativeSessionReadDemand(platform, "idle", { active: true, observationEvents: true })
          .quietBackoffMs,
      ).toBeNull();
      expect(
        nativeSessionReadDemand(platform, "idle", {
          active: true,
          observationEvents: true,
          quietObservation: true,
        }).quietBackoffMs,
      ).toEqual(NATIVE_QUIET_BACKOFF_TRIAL_MS);
    }
    // The other qualified providers never needed the flag.
    expect(
      nativeSessionReadDemand("cursor", "idle", { active: true, observationEvents: true })
        .quietBackoffMs,
    ).toEqual(NATIVE_QUIET_BACKOFF_TRIAL_MS);
  });

  test("a qualified provider backs off only while idle", () => {
    const qualifiedProviders = new Set(["pi"] as const);
    const options = { active: true, qualifiedProviders, observationEvents: true };
    expect(nativeSessionReadDemand("pi", "idle", options).quietBackoffMs).toEqual(
      NATIVE_QUIET_BACKOFF_TRIAL_MS,
    );
    for (const phase of ["running", "blocked", "cancelling", "recovering"]) {
      expect(nativeSessionReadDemand("pi", phase, options).quietBackoffMs).toBeNull();
    }
    expect(nativeSessionReadDemand("cursor", "idle", options).quietBackoffMs).toBeNull();
  });

  test("data saving slows only the responsive backstop poll", () => {
    expect(DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS).toBe(1_000);
    for (const phase of ["running", "blocked", "cancelling", "recovering"]) {
      const demand = nativeSessionReadDemand("claude", phase, {
        active: true,
        observationEvents: true,
      });
      // Still critical, so a resume reads it first and never spreads it.
      expect(demand.priority).toBe("critical");
      expect(demand.dataSaving).toEqual({ intervalMs: DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS });
    }
    // An idle view keeps its cadence and its (qualified) quiet backoff.
    for (const phase of ["idle", "completed", undefined]) {
      expect(
        nativeSessionReadDemand("cursor", phase, { active: true, observationEvents: true })
          .dataSaving,
      ).toBeNull();
    }
  });
});

describe("NativeDiscoveryReadSchedule", () => {
  const view = (
    availability: "ready" | "loading" | "stale" | "unavailable",
  ): NativeAgentDiscoveryView =>
    ({
      identity: {},
      sections: {
        models: { availability: "ready", revision: 1 },
        runtime: { availability, revision: 1 },
      },
    }) as unknown as NativeAgentDiscoveryView;

  /** A schedule that already read once at time 0 and holds a settled view. */
  function settled(phase = "running") {
    const schedule = new NativeDiscoveryReadSchedule();
    expect(schedule.claim(0, phase)).toBe(true);
    schedule.observe(view("ready"));
    return schedule;
  }

  test("reads on the first round, then only at the backstop", () => {
    const schedule = settled();
    expect(schedule.claim(500, "running")).toBe(false);
    expect(schedule.claim(DISCOVERY_BACKSTOP_MS - 1, "running")).toBe(false);
    expect(schedule.claim(DISCOVERY_BACKSTOP_MS, "running")).toBe(true);
    expect(schedule.claim(DISCOVERY_BACKSTOP_MS + 500, "running")).toBe(false);
    expect(DISCOVERY_BACKSTOP_MS).toBe(30_000);
  });

  test("a due mark is spent by exactly one read", () => {
    const schedule = settled();
    schedule.markDue();
    schedule.markDue();
    expect(schedule.claim(500, "running")).toBe(true);
    expect(schedule.claim(1_000, "running")).toBe(false);
  });

  test("a phase change reads once", () => {
    const schedule = settled();
    expect(schedule.claim(500, "idle")).toBe(true);
    expect(schedule.claim(2_000, "idle")).toBe(false);
  });

  test("learning the phase for the first time is not a change", () => {
    const schedule = new NativeDiscoveryReadSchedule();
    expect(schedule.claim(0, undefined)).toBe(true);
    expect(schedule.claim(500, "running")).toBe(false);
    expect(schedule.claim(1_000, "idle")).toBe(true);
  });

  test("an explicit read restarts the backstop and spends the due mark", () => {
    const schedule = settled();
    schedule.markDue();
    schedule.claimExplicit(10_000, "running");
    expect(schedule.claim(10_500, "running")).toBe(false);
    expect(schedule.claim(39_999, "running")).toBe(false);
    expect(schedule.claim(40_000, "running")).toBe(true);
  });

  test("a loading or stale section is looked at again until it settles", () => {
    for (const availability of ["loading", "stale"] as const) {
      const schedule = settled();
      schedule.observe(view(availability));
      expect(schedule.claim(1_999, "running")).toBe(false);
      expect(schedule.claim(2_000, "running")).toBe(true);
      schedule.observe(view("ready"));
      expect(schedule.claim(4_000, "running")).toBe(false);
    }
  });

  test("an unavailable section waits for the backend's own retry", () => {
    const schedule = settled();
    schedule.observe(view("unavailable"));
    expect(schedule.claim(4_999, "running")).toBe(false);
    expect(schedule.claim(5_000, "running")).toBe(true);
  });
});
