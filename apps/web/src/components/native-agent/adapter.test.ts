import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  findNativeAgentAdapter,
  getNativeAgentAdapter,
  nativeAgentAdapters,
} from "./adapter";

describe("native agent adapter registry", () => {
  test("registers every supported platform exactly once", () => {
    expect(Object.keys(nativeAgentAdapters).sort()).toEqual([...AGENT_PLATFORMS].sort());
    for (const platform of AGENT_PLATFORMS) {
      const adapter = getNativeAgentAdapter(platform);
      expect(adapter.platform).toBe(platform);
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(typeof adapter.loadController).toBe("function");
      expect(typeof adapter.normalizeMessages).toBe("function");
    }
  });

  test("publishes provider differences as capabilities", () => {
    expect(getNativeAgentAdapter("claude").capabilities.backgroundTasks).toBe(true);
    expect(getNativeAgentAdapter("codex").capabilities.resume).toBe(true);
    expect(getNativeAgentAdapter("cursor").capabilities.attachments.files).toBe(false);
  });

  test("resolves an unnarrowed platform only when it is registered", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(findNativeAgentAdapter(platform)?.platform).toBe(platform);
    }
    expect(findNativeAgentAdapter("gemini")).toBeUndefined();
    expect(findNativeAgentAdapter("")).toBeUndefined();
    // Registry keys are looked up as own properties: a persisted record naming
    // an `Object.prototype` member must not resolve to a non-adapter.
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(findNativeAgentAdapter(key)).toBeUndefined();
    }
  });
});
