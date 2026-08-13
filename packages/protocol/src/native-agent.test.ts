import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms";
import { isNativeAgentTabData } from "./native-agent";

describe("native agent protocol", () => {
  test("accepts every provider through one tab-data contract", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(isNativeAgentTabData({
        platform,
        environmentId: "environment-1",
        sessionId: "session-1",
        hostPort: 4123,
        isLocal: true,
      })).toBe(true);
    }
  });

  test("rejects malformed persisted identities", () => {
    expect(isNativeAgentTabData({ platform: "other", environmentId: "env" })).toBe(false);
    expect(isNativeAgentTabData({ platform: "codex", environmentId: "" })).toBe(false);
    expect(isNativeAgentTabData({ platform: "codex", environmentId: "env", hostPort: 0 })).toBe(false);
  });
});

