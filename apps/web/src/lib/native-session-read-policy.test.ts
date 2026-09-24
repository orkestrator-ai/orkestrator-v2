import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  ACTIVE_PROJECTION_REFRESH_MS,
  IDLE_PROJECTION_REFRESH_MS,
  NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS,
  NATIVE_QUIET_BACKOFF_TRIAL_MS,
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

  test("quiet backoff is gated off for every provider by default", () => {
    expect(NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS.size).toBe(0);
    for (const platform of AGENT_PLATFORMS) {
      expect(nativeSessionReadDemand(platform, "idle", { active: true }).quietBackoffMs).toBeNull();
    }
  });

  test("a qualified provider backs off only while idle", () => {
    const qualifiedProviders = new Set(["codex"] as const);
    expect(
      nativeSessionReadDemand("codex", "idle", { active: true, qualifiedProviders }).quietBackoffMs,
    ).toEqual(NATIVE_QUIET_BACKOFF_TRIAL_MS);
    expect(
      nativeSessionReadDemand("codex", "running", { active: true, qualifiedProviders })
        .quietBackoffMs,
    ).toBeNull();
    expect(
      nativeSessionReadDemand("claude", "idle", { active: true, qualifiedProviders })
        .quietBackoffMs,
    ).toBeNull();
  });
});
