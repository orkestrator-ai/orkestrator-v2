import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms";
import {
  DEFAULT_REASONING_ID,
  FALLBACK_REASONING_ID,
  fallbackReasoningId,
  isNativeAgentTabData,
  resolveReasoningId,
} from "./native-agent";

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

  test("rejects values that are not identity records at all", () => {
    for (const value of [undefined, null, "codex", 7, true, [], [{ platform: "codex" }]]) {
      expect(isNativeAgentTabData(value)).toBe(false);
    }
    expect(isNativeAgentTabData({ environmentId: "env" })).toBe(true);
    expect(isNativeAgentTabData({ platform: "codex" })).toBe(false);
  });

  test("rejects a host port that is not a usable TCP port", () => {
    const base = { platform: "codex", environmentId: "env" };
    for (const hostPort of [-1, 0, 1.5, NaN, Infinity, "4123", null, 2 ** 53]) {
      expect(isNativeAgentTabData({ ...base, hostPort })).toBe(false);
    }
    expect(isNativeAgentTabData({ ...base, hostPort: 1 })).toBe(true);
    expect(isNativeAgentTabData({ ...base, hostPort: 65535 })).toBe(true);
  });

  test("rejects optional fields of the wrong type", () => {
    const base = { platform: "codex", environmentId: "env" };
    expect(isNativeAgentTabData({ ...base, containerId: 1 })).toBe(false);
    expect(isNativeAgentTabData({ ...base, sessionId: {} })).toBe(false);
    expect(isNativeAgentTabData({ ...base, isLocal: "true" })).toBe(false);
  });

  test("accepts an identity whose optional fields are explicitly absent", () => {
    expect(isNativeAgentTabData({
      platform: "claude",
      environmentId: "env",
      containerId: undefined,
      hostPort: undefined,
      sessionId: undefined,
      isLocal: undefined,
    })).toBe(true);
  });
});

describe("fallbackReasoningId", () => {
  test("prefers an explicit default option over high", () => {
    expect(fallbackReasoningId(["default", "low", "high"])).toBe(DEFAULT_REASONING_ID);
    expect(fallbackReasoningId([{ id: "high" }, { id: "default" }])).toBe(DEFAULT_REASONING_ID);
  });

  test("prefers high when the catalog has no default option", () => {
    expect(fallbackReasoningId(["low", "medium", "high", "xhigh"])).toBe(FALLBACK_REASONING_ID);
  });

  test("falls back to the first option when neither default nor high exists", () => {
    expect(fallbackReasoningId(["medium"])).toBe("medium");
    expect(fallbackReasoningId(["fast", "deep"])).toBe("fast");
  });

  test("keeps an advertised default when high is not offered", () => {
    expect(fallbackReasoningId(["low", "medium", "xhigh"], "medium")).toBe("medium");
  });

  test("overrides an advertised medium default when high is offered", () => {
    expect(fallbackReasoningId(["low", "medium", "high"], "medium")).toBe(FALLBACK_REASONING_ID);
  });

  test("returns undefined for an empty catalog", () => {
    expect(fallbackReasoningId([])).toBeUndefined();
  });
});

describe("resolveReasoningId", () => {
  test("keeps a still-supported preference", () => {
    expect(resolveReasoningId(["low", "high"], "low")).toBe("low");
  });

  test("drops an unsupported preference and applies the fallback policy", () => {
    expect(resolveReasoningId(["low", "high"], "xhigh")).toBe(FALLBACK_REASONING_ID);
    expect(resolveReasoningId(["default", "fast"], "missing")).toBe(DEFAULT_REASONING_ID);
  });
});
