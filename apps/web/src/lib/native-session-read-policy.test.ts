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

  test("quiet backoff needs a qualified provider and a backend that announces transitions", () => {
    // The single qualification switch, shared with the backend capability matrix.
    expect([...NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS].sort()).toEqual(
      ["cursor", "grok", "opencode", "pi"].sort(),
    );
    for (const platform of AGENT_PLATFORMS) {
      // An older backend (no stamped activity announcements) keeps the baseline.
      expect(nativeSessionReadDemand(platform, "idle", { active: true }).quietBackoffMs).toBeNull();
      expect(
        nativeSessionReadDemand(platform, "idle", { active: true, observationEvents: true })
          .quietBackoffMs,
      ).toEqual(
        NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS.has(platform)
          ? NATIVE_QUIET_BACKOFF_TRIAL_MS
          : null,
      );
    }
    // Claude and Codex idle views change without a transition to announce.
    expect(NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS.has("claude")).toBe(false);
    expect(NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS.has("codex")).toBe(false);
  });

  test("a qualified provider backs off only while idle", () => {
    const qualifiedProviders = new Set(["codex"] as const);
    const options = { active: true, qualifiedProviders, observationEvents: true };
    expect(nativeSessionReadDemand("codex", "idle", options).quietBackoffMs).toEqual(
      NATIVE_QUIET_BACKOFF_TRIAL_MS,
    );
    for (const phase of ["running", "blocked", "cancelling", "recovering"]) {
      expect(nativeSessionReadDemand("codex", phase, options).quietBackoffMs).toBeNull();
    }
    expect(nativeSessionReadDemand("claude", "idle", options).quietBackoffMs).toBeNull();
  });
});
