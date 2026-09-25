import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms.js";
import {
  NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS,
  orderNativeObservationStamp,
  parseNativeAgentActivityAnnouncement,
} from "./native-agent-observation.js";

describe("native agent activity announcements", () => {
  test("parses a stamped, session-scoped announcement", () => {
    expect(
      parseNativeAgentActivityAnnouncement({
        environment_id: "env-1",
        previous_state: "working",
        state: "idle",
        agent: "pi",
        logical_session_key: "env-env-1:tab-1",
        generation: "observer-1",
        revision: 3,
      }),
    ).toEqual({
      environmentId: "env-1",
      previousState: "working",
      state: "idle",
      agent: "pi",
      logicalSessionKey: "env-env-1:tab-1",
      stamp: { generation: "observer-1", revision: 3 },
    });
  });

  test("accepts an older backend's environment-only announcement", () => {
    expect(
      parseNativeAgentActivityAnnouncement({ environment_id: "env-1", state: "working" }),
    ).toEqual({ environmentId: "env-1", state: "working" });
  });

  test("rejects malformed payloads and partial stamps rather than treating them as legacy", () => {
    for (const payload of [
      null,
      [],
      "env-1",
      { state: "idle" },
      { environment_id: "", state: "idle" },
      { environment_id: "env-1" },
      { environment_id: "env-1", state: "idle", agent: 3 },
      { environment_id: "env-1", state: "idle", logical_session_key: "" },
      { environment_id: "env-1", state: "idle", generation: "observer-1" },
      { environment_id: "env-1", state: "idle", revision: 1 },
      { environment_id: "env-1", state: "idle", generation: "observer-1", revision: 0 },
      { environment_id: "env-1", state: "idle", generation: "bad value", revision: 1 },
      { environment_id: "x".repeat(1_025), state: "idle" },
    ]) {
      expect(parseNativeAgentActivityAnnouncement(payload)).toBeNull();
    }
  });

  test("orders stamps: first, next, gap, reset and duplicate", () => {
    const at = (revision: number, generation = "observer-1") => ({ generation, revision });
    expect(orderNativeObservationStamp(null, at(5))).toBe("first");
    expect(orderNativeObservationStamp(at(5), at(6))).toBe("next");
    expect(orderNativeObservationStamp(at(5), at(8))).toBe("gap");
    expect(orderNativeObservationStamp(at(5), at(5))).toBe("duplicate");
    expect(orderNativeObservationStamp(at(5), at(2))).toBe("duplicate");
    expect(orderNativeObservationStamp(at(5), at(1, "observer-2"))).toBe("reset");
  });

  test("qualifies only known platforms for quiet backoff, never Claude or Codex", () => {
    for (const platform of NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS) {
      expect(AGENT_PLATFORMS).toContain(platform);
    }
    expect(NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS).not.toContain("claude");
    expect(NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS).not.toContain("codex");
  });
});
