import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { getNativeAgentAdapter, nativeAgentAdapters } from "./adapter";

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
});
