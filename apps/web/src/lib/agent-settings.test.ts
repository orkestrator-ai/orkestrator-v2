import { describe, expect, test } from "bun:test";
import { resolvedActionDefault } from "./agent-settings";

describe("resolvedActionDefault", () => {
  const enabled = ["claude", "codex", "cursor", "grok", "opencode"] as const;

  test("resolves action entries independently across all three tiers", () => {
    const tiers = {
      global: {
        actionDefaults: {
          review: { platform: "claude" as const },
          pr: { platform: "grok" as const, model: "grok-4" },
        },
      },
      repository: { actionDefaults: { review: { platform: "codex" as const } } },
      environment: { actionDefaults: { review: { platform: "cursor" as const } } },
    };

    expect(resolvedActionDefault(tiers, "review", enabled)).toEqual({ agent: "cursor" });
    expect(resolvedActionDefault(tiers, "pr", enabled)).toEqual({
      agent: "grok",
      model: "grok-4",
    });
  });

  test("a narrower generic agent wins when that tier does not set the action", () => {
    expect(
      resolvedActionDefault(
        {
          global: { actionDefaults: { review: { platform: "claude" } } },
          repository: { defaultAgent: "codex" },
          environment: { defaultAgent: "cursor" },
        },
        "review",
        enabled,
      ),
    ).toEqual({ agent: "cursor" });
  });

  test("an action at a tier wins over that tier's generic agent", () => {
    expect(
      resolvedActionDefault(
        {
          global: { defaultAgent: "claude" },
          repository: {
            defaultAgent: "codex",
            actionDefaults: { review: { platform: "grok", reasoningEffort: "high" } },
          },
        },
        "review",
        enabled,
      ),
    ).toEqual({ agent: "grok", reasoningEffort: "high" });
  });
});
