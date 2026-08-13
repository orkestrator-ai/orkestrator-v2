import { describe, expect, test } from "bun:test";
import {
  AGENT_PLATFORMS,
  firstEnabledAgentPlatform,
  isAgentPlatform,
  normalizeAgentPlatforms,
} from "./agent-platforms";

describe("agent platform registry", () => {
  test("publishes every supported system in product order", () => {
    expect(AGENT_PLATFORMS).toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
    expect(Object.isFrozen(AGENT_PLATFORMS)).toBe(true);
  });

  test("normalizes untrusted selections without duplicates", () => {
    expect(normalizeAgentPlatforms(["grok", "cursor", "grok", "other"])).toEqual(["cursor", "grok"]);
    expect(normalizeAgentPlatforms(null, ["claude"])).toEqual(["claude"]);
  });

  test("uses the first enabled system and rejects unknown names", () => {
    expect(firstEnabledAgentPlatform(["grok", "cursor"])).toBe("grok");
    expect(isAgentPlatform("cursor")).toBe(true);
    expect(isAgentPlatform("gemini")).toBe(false);
  });
});
