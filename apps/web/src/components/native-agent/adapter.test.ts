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
      expect(adapter.capabilities.composer).toBeDefined();
    }
  });

  test("keeps every provider registry entry metadata-only", () => {
    for (const platform of AGENT_PLATFORMS) {
      const adapter = getNativeAgentAdapter(platform);
      expect(Object.keys(adapter).sort()).toEqual([
        "capabilities",
        "label",
        "platform",
      ]);
    }
  });

  test("publishes provider differences as capabilities", () => {
    expect(getNativeAgentAdapter("claude").capabilities.backgroundTasks).toBe(true);
    expect(getNativeAgentAdapter("codex").capabilities.resume).toBe(true);
    expect(getNativeAgentAdapter("codex").capabilities.attachments).toEqual({
      files: false,
      images: true,
    });
    expect(getNativeAgentAdapter("cursor").capabilities.composer.model).toBe(true);
    expect(getNativeAgentAdapter("grok").capabilities.composer.reasoning).toBe(true);
    expect(getNativeAgentAdapter("cursor").capabilities.attachments.files).toBe(false);
    expect(getNativeAgentAdapter("cursor").capabilities.resume).toBe(true);
    expect(getNativeAgentAdapter("grok").capabilities.resume).toBe(true);
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
