import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS, type AgentPlatform } from "./agent-platforms.js";
import {
  DEFAULT_CLAUDE_NATIVE_BACKEND,
  isEmptyAgentSettings,
  normalizeAgentSettings,
  resolveActionDefaults,
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  SHIPPED_PLATFORM_MODES,
  type AgentSettingsTier,
} from "./agent-settings.js";

const platformTier = (
  platform: AgentPlatform,
  settings: NonNullable<AgentSettingsTier["platforms"]>[AgentPlatform],
): AgentSettingsTier => ({ platforms: { [platform]: settings } });

describe("resolveDefaultAgent", () => {
  test("prefers environment over repository over global", () => {
    expect(
      resolveDefaultAgent({
        environment: { defaultAgent: "codex" },
        repository: { defaultAgent: "opencode" },
        global: { defaultAgent: "claude" },
      }),
    ).toBe("codex");
    expect(
      resolveDefaultAgent({
        repository: { defaultAgent: "opencode" },
        global: { defaultAgent: "claude" },
      }),
    ).toBe("opencode");
    expect(resolveDefaultAgent({ global: { defaultAgent: "grok" } })).toBe("grok");
    expect(resolveDefaultAgent({})).toBe("claude");
  });
});

describe("resolveAgentPlatformSettings", () => {
  test("every platform falls back to its shipped mode when no tier decides", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(resolveAgentPlatformSettings({}, platform)).toEqual({
        mode: SHIPPED_PLATFORM_MODES[platform],
        claudeNativeBackend: DEFAULT_CLAUDE_NATIVE_BACKEND,
      });
    }
  });

  test("mode prefers environment over repository over global, per platform", () => {
    const tiers = {
      environment: platformTier("codex", { mode: "native" as const }),
      repository: platformTier("codex", { mode: "terminal" as const }),
      global: platformTier("codex", { mode: "terminal" as const }),
    };
    expect(resolveAgentPlatformSettings(tiers, "codex").mode).toBe("native");
    expect(
      resolveAgentPlatformSettings({ repository: tiers.repository, global: tiers.global }, "codex")
        .mode,
    ).toBe("terminal");
  });

  test("Cursor is always native even when legacy settings request terminal mode", () => {
    const global = platformTier("cursor", { mode: "terminal" });
    expect(resolveAgentPlatformSettings({ global }, "cursor").mode).toBe("native");
    expect(normalizeAgentSettings(global)).toEqual({});
  });

  test("clearing a tier inherits the tier above rather than the shipped default", () => {
    // The settings UI expresses "inherit" by writing nothing, so an absent
    // environment block must fall through to the repository's `native` and not
    // reset to Codex's shipped `terminal`.
    const global = platformTier("codex", { mode: "terminal" as const });
    const repository = platformTier("codex", { mode: "native" as const });
    expect(
      resolveAgentPlatformSettings({ environment: {}, repository, global }, "codex").mode,
    ).toBe("native");
  });

  test("resolves each field independently", () => {
    // A repository that pins only a model still inherits the app's mode. This
    // is what the UI promises when it shows "Inherit" on one control and a
    // concrete value on its neighbour.
    const resolved = resolveAgentPlatformSettings(
      {
        repository: platformTier("claude", { model: "opus[1m]" }),
        global: platformTier("claude", {
          mode: "terminal",
          model: "sonnet",
          reasoningEffort: "low",
        }),
      },
      "claude",
    );
    expect(resolved).toEqual({
      mode: "terminal",
      model: "opus[1m]",
      reasoningEffort: "low",
      claudeNativeBackend: "sdk",
    });
  });

  test("resolves fastMode independently, including an explicit false", () => {
    // Normal is a stored choice, not "unset". A repository that pins Normal
    // must not fall through to the app's Fast.
    const resolved = resolveAgentPlatformSettings(
      {
        repository: platformTier("cursor", { fastMode: false }),
        global: platformTier("cursor", { fastMode: true, model: "grok-4.6" }),
      },
      "cursor",
    );
    expect(resolved).toEqual({
      mode: "native",
      model: "grok-4.6",
      fastMode: false,
      claudeNativeBackend: DEFAULT_CLAUDE_NATIVE_BACKEND,
    });
  });

  test("one platform's settings never leak into another", () => {
    const tiers = { global: platformTier("claude", { mode: "native", model: "opus[1m]" }) };
    expect(resolveAgentPlatformSettings(tiers, "codex")).toEqual({
      mode: SHIPPED_PLATFORM_MODES.codex,
      claudeNativeBackend: DEFAULT_CLAUDE_NATIVE_BACKEND,
    });
  });

  test("claudeNativeBackend prefers environment over repository over global", () => {
    expect(
      resolveAgentPlatformSettings(
        {
          repository: platformTier("claude", { claudeNativeBackend: "tmux" }),
          global: platformTier("claude", { claudeNativeBackend: "sdk" }),
        },
        "claude",
      ).claudeNativeBackend,
    ).toBe("tmux");
  });
});

describe("a model never leaves its own platform's column", () => {
  test("a repository model does not reach a different agent's launch", () => {
    // The defect this rule exists for: `native-agent-service-reconciliation.ts`
    // used to hand a repository's single `defaultModel` to whatever agent
    // launched, so a Claude model id could reach a Codex run.
    const repository: AgentSettingsTier = {
      defaultAgent: "claude",
      platforms: { claude: { model: "opus[1m]" } },
    };
    expect(resolveAgentPlatformSettings({ repository }, "codex").model).toBeUndefined();
    expect(resolveAgentPlatformSettings({ repository }, "claude").model).toBe("opus[1m]");
  });

  test("a lower tier switching agent leaves the higher tier's model behind", () => {
    // Repository says "Codex, gpt-5.6-sol"; the environment switches to Claude.
    // Claude must not inherit a Codex model id, but Codex keeps it if launched.
    const repository: AgentSettingsTier = {
      defaultAgent: "codex",
      platforms: { codex: { model: "gpt-5.6-sol" } },
    };
    const environment: AgentSettingsTier = { defaultAgent: "claude" };
    const tiers = { environment, repository };
    expect(resolveDefaultAgent(tiers)).toBe("claude");
    expect(resolveAgentPlatformSettings(tiers, "claude").model).toBeUndefined();
    expect(resolveAgentPlatformSettings(tiers, "codex").model).toBe("gpt-5.6-sol");
  });

  test("changing the default agent does not carry a model across", () => {
    // The Defaults page binds to `defaultAgent` plus that agent's own block, so
    // switching agent reveals that agent's model rather than retargeting one.
    const global: AgentSettingsTier = {
      defaultAgent: "codex",
      platforms: { claude: { model: "opus[1m]" }, codex: { model: "gpt-5.6-sol" } },
    };
    expect(resolveAgentPlatformSettings({ global }, resolveDefaultAgent({ global })).model).toBe(
      "gpt-5.6-sol",
    );
    const switched: AgentSettingsTier = { ...global, defaultAgent: "claude" };
    expect(
      resolveAgentPlatformSettings({ global: switched }, resolveDefaultAgent({ global: switched }))
        .model,
    ).toBe("opus[1m]");
  });
});

describe("resolveActionDefaults", () => {
  test("resolves each action independently from the narrowest tier that sets it", () => {
    const global: AgentSettingsTier = {
      actionDefaults: { review: { platform: "claude" }, pr: { platform: "grok" } },
    };
    const repository: AgentSettingsTier = { actionDefaults: { review: { platform: "codex" } } };
    expect(resolveActionDefaults({ repository, global })).toEqual({
      review: { platform: "codex" },
      pr: { platform: "grok" },
    });
    expect(resolveActionDefaults({ global }).review?.platform).toBe("claude");
  });

  test("an empty object at a narrow tier inherits rather than blanking", () => {
    // Clearing every action in a repository means "inherit", not "no defaults".
    const global: AgentSettingsTier = { actionDefaults: { pr: { platform: "grok" } } };
    expect(resolveActionDefaults({ repository: { actionDefaults: {} }, global }).pr?.platform).toBe(
      "grok",
    );
  });

  test("is empty when no tier sets any", () => {
    expect(resolveActionDefaults({})).toEqual({});
  });
});

describe("normalizeAgentSettings", () => {
  test("drops unknown platform keys and empty blocks", () => {
    const normalized = normalizeAgentSettings({
      platforms: { claude: { mode: "native" }, bogus: { mode: "native" }, codex: {} },
    });
    expect(normalized.platforms).toEqual({ claude: { mode: "native" } });
  });

  test("drops a tier-level model, which has no platform column to live in", () => {
    // A model id is only meaningful inside its own platform's catalogue, so the
    // Defaults page writes `platforms[defaultAgent].model`, never a loose one.
    expect(
      normalizeAgentSettings({
        defaultAgent: "claude",
        defaultModel: "opus[1m]",
        defaultReasoningEffort: "high",
      }),
    ).toEqual({ defaultAgent: "claude" });
  });

  test("rejects a mode that is neither terminal nor native", () => {
    expect(
      normalizeAgentSettings({ platforms: { claude: { mode: "tmux" } } }).platforms,
    ).toBeUndefined();
  });

  test("returns an empty tier for junk", () => {
    for (const junk of [null, undefined, 42, "settings", []]) {
      expect(normalizeAgentSettings(junk)).toEqual({});
    }
  });

  test("normalizing is idempotent and trims", () => {
    const once = normalizeAgentSettings({
      defaultAgent: "codex",
      platforms: { codex: { mode: "native", model: "  gpt-5.6-sol  ", reasoningEffort: " high " } },
    });
    expect(normalizeAgentSettings(once)).toEqual(once);
    expect(once.platforms?.codex).toEqual({
      mode: "native",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  test("keeps an explicit false fastMode rather than treating it as unset", () => {
    expect(
      normalizeAgentSettings({ platforms: { cursor: { fastMode: false } } }).platforms?.cursor,
    ).toEqual({ fastMode: false });
  });

  test("bounds and normalizes the extra Multi Review reviewer defaults", () => {
    expect(
      normalizeAgentSettings({
        multiReview: {
          reviewerCount: 4,
          additionalReviewers: [
            { platform: "codex", model: "  gpt-5.6-sol  ", reasoningEffort: " high " },
            { platform: "unknown", model: "ignored" },
            { platform: "claude", model: "outside-the-count" },
          ],
        },
      }).multiReview,
    ).toEqual({
      reviewerCount: 4,
      additionalReviewers: [{ platform: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
    });

    expect(
      normalizeAgentSettings({
        multiReview: { reviewerCount: 99, additionalReviewers: [{ platform: "codex" }] },
      }).multiReview,
    ).toBeUndefined();
  });
});

describe("isEmptyAgentSettings", () => {
  test("recognises a tier that inherits everything", () => {
    expect(isEmptyAgentSettings(undefined)).toBe(true);
    expect(isEmptyAgentSettings({})).toBe(true);
    expect(isEmptyAgentSettings({ actionDefaults: {}, platforms: {} })).toBe(true);
    expect(isEmptyAgentSettings({ platforms: { claude: { mode: "native" } } })).toBe(false);
    expect(isEmptyAgentSettings({ defaultAgent: "codex" })).toBe(false);
    expect(isEmptyAgentSettings({ multiReview: { reviewerCount: 3 } })).toBe(false);
  });
});
