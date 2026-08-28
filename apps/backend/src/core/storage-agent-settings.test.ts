import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import {
  resolveStartupLaunch,
  resolveStartupLaunchFromSettings,
} from "@orkestrator/protocol/startup-launch";
import {
  migrateEnvironmentAgentSettings,
  migrateGlobalAgentSettings,
  migrateRepositoryAgentSettings,
} from "./storage-agent-settings.js";

type JsonRecord = Record<string, unknown>;

/**
 * Every legacy tier combination worth replaying.
 *
 * Deliberately includes partial and contradictory configs: the cases that
 * actually break on upgrade are the half-filled ones a long-lived install
 * accumulates, not the tidy ones.
 */
const LEGACY_CASES: Array<{
  name: string;
  environment?: JsonRecord;
  repository?: JsonRecord;
  global?: JsonRecord;
}> = [
  { name: "empty everything" },
  { name: "global claude native only", global: { defaultAgent: "claude", claudeMode: "native" } },
  { name: "global claude terminal", global: { defaultAgent: "claude", claudeMode: "terminal" } },
  {
    name: "repository agentStyle overrides global claude mode",
    repository: { agentStyle: "native" },
    global: { defaultAgent: "claude", claudeMode: "terminal" },
  },
  {
    name: "environment claude mode wins over repository agentStyle",
    environment: { defaultAgent: "claude", claudeMode: "terminal" },
    repository: { agentStyle: "native" },
    global: { defaultAgent: "claude", claudeMode: "native" },
  },
  {
    name: "codex native from environment",
    environment: { defaultAgent: "codex", codexMode: "native" },
    global: { defaultAgent: "claude", codexMode: "terminal" },
  },
  {
    name: "codex ignores the repository tier, as it always did",
    repository: { agentStyle: "native" },
    global: { defaultAgent: "codex", codexMode: "terminal" },
  },
  {
    name: "opencode native from global",
    global: { defaultAgent: "opencode", opencodeMode: "native" },
  },
  {
    name: "cursor rides the opencode mode",
    global: { defaultAgent: "cursor", opencodeMode: "native", codexMode: "terminal" },
  },
  {
    name: "grok rides the opencode mode",
    global: { defaultAgent: "grok", opencodeMode: "terminal" },
  },
  {
    name: "claude tmux backend from the repository",
    environment: { defaultAgent: "claude", claudeMode: "native" },
    repository: { claudeNativeBackend: "tmux" },
    global: { defaultAgent: "claude", claudeNativeBackend: "sdk" },
  },
  {
    name: "environment backend outranks repository",
    environment: { defaultAgent: "claude", claudeMode: "native", claudeNativeBackend: "sdk" },
    repository: { claudeNativeBackend: "tmux" },
  },
  {
    name: "repository agent with no mode anywhere",
    repository: { defaultAgent: "opencode" },
    global: { defaultAgent: "claude" },
  },
  {
    name: "a fully populated install",
    environment: { defaultAgent: "codex", codexMode: "native", claudeMode: "terminal" },
    repository: { defaultAgent: "claude", agentStyle: "native", claudeNativeBackend: "tmux" },
    global: {
      defaultAgent: "opencode",
      claudeMode: "native",
      codexMode: "terminal",
      opencodeMode: "native",
      claudeNativeBackend: "sdk",
      claudeModel: "claude-sonnet-5",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
      opencodeModel: "opencode/claude-sonnet-5",
    },
  },
];

function migrateAll(legacy: (typeof LEGACY_CASES)[number]) {
  const global = legacy.global ?? {};
  const globalDefaultAgent = (
    AGENT_PLATFORMS.includes(global.defaultAgent as AgentPlatform) ? global.defaultAgent : "claude"
  ) as AgentPlatform;
  return {
    environment: migrateEnvironmentAgentSettings(legacy.environment ?? {}),
    repository: migrateRepositoryAgentSettings(legacy.repository ?? {}, globalDefaultAgent),
    global: migrateGlobalAgentSettings(global),
  };
}

describe("migration preserves every launch decision", () => {
  // This is the test that makes the upgrade safe. The stored shape changes
  // wholesale; what must not change is the answer any of it produces.
  for (const legacy of LEGACY_CASES) {
    test(legacy.name, () => {
      const before = resolveStartupLaunch({
        environment: legacy.environment as never,
        repository: legacy.repository as never,
        global: legacy.global as never,
      });
      const after = resolveStartupLaunchFromSettings(migrateAll(legacy));
      expect(after).toEqual(before);
    });
  }
});

describe("migrateGlobalAgentSettings", () => {
  test("moves the four invisible model fields into their platform columns", () => {
    const migrated = migrateGlobalAgentSettings({
      defaultAgent: "claude",
      claudeModel: "claude-sonnet-5",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
      opencodeModel: "opencode/claude-sonnet-5",
    });
    expect(migrated.platforms?.claude?.model).toBe("claude-sonnet-5");
    expect(migrated.platforms?.codex).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(migrated.platforms?.opencode?.model).toBe("opencode/claude-sonnet-5");
    // Neither ACP platform ever had a model field of its own.
    expect(migrated.platforms?.cursor?.model).toBeUndefined();
    expect(migrated.platforms?.grok?.model).toBeUndefined();
  });

  test("seeds Grok from the OpenCode mode while Cursor stays SDK-only", () => {
    const migrated = migrateGlobalAgentSettings({ opencodeMode: "native" });
    expect(migrated.platforms?.opencode?.mode).toBe("native");
    expect(migrated.platforms?.cursor).toBeUndefined();
    expect(migrated.platforms?.grok?.mode).toBe("native");
  });

  test("carries action defaults across", () => {
    const migrated = migrateGlobalAgentSettings({
      actionDefaults: { review: { platform: "codex", model: "gpt-5.4" } },
    });
    expect(migrated.actionDefaults?.review).toEqual({ platform: "codex", model: "gpt-5.4" });
  });

  test("an already-migrated block is authoritative and legacy fields are ignored", () => {
    // Re-reading the legacy fields here would resurrect values the user has
    // since changed through the new panes.
    const migrated = migrateGlobalAgentSettings({
      claudeMode: "terminal",
      agentSettings: { platforms: { claude: { mode: "native" } } },
    });
    expect(migrated.platforms?.claude?.mode).toBe("native");
  });

  test("migrates the legacy fast-mode defaults onto each platform block", () => {
    const migrated = migrateGlobalAgentSettings({
      claudeNativeFastModeDefault: true,
      codexNativeFastModeDefault: false,
    });
    expect(migrated.platforms?.claude?.fastMode).toBe(true);
    expect(migrated.platforms?.codex?.fastMode).toBe(false);
  });

  test("fills an unset speed in an already-migrated block from a still-present legacy key", () => {
    const migrated = migrateGlobalAgentSettings({
      agentSettings: {
        platforms: {
          claude: { model: "sonnet" },
          codex: { fastMode: false },
        },
      },
      claudeNativeFastModeDefault: true,
      codexNativeFastModeDefault: true,
    });

    expect(migrated.platforms?.claude).toEqual({ model: "sonnet", fastMode: true });
    // A value already written through the new settings surface remains
    // authoritative over the stale legacy key.
    expect(migrated.platforms?.codex?.fastMode).toBe(false);
  });
});

describe("migrateRepositoryAgentSettings", () => {
  test("agentStyle becomes Claude's mode, the only platform that read it", () => {
    const migrated = migrateRepositoryAgentSettings({ agentStyle: "native" }, "claude");
    expect(migrated.platforms?.claude?.mode).toBe("native");
    expect(migrated.platforms?.codex).toBeUndefined();
    expect(migrated.platforms?.opencode).toBeUndefined();
  });

  test("pins defaultModel to the repository's own default agent", () => {
    const migrated = migrateRepositoryAgentSettings(
      { defaultAgent: "codex", defaultModel: "gpt-5.6-sol", defaultEffort: "xhigh" },
      "claude",
    );
    expect(migrated.platforms?.codex).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
    // The defect being fixed: this model must not be reachable from Claude.
    expect(resolveAgentPlatformSettings({ repository: migrated }, "claude").model).toBeUndefined();
  });

  test("pins defaultModel to the app default agent when the repository inherits one", () => {
    const migrated = migrateRepositoryAgentSettings({ defaultModel: "opus[1m]" }, "claude");
    expect(migrated.platforms?.claude?.model).toBe("opus[1m]");
    // Inheriting the agent must stay inherited: writing an explicit one here
    // would silently pin the repository to today's app default.
    expect(migrated.defaultAgent).toBeUndefined();
  });

  test('drops the "default" sentinel, which meant no override at all', () => {
    const migrated = migrateRepositoryAgentSettings(
      { defaultAgent: "claude", defaultModel: "default", defaultEffort: "default" },
      "claude",
    );
    // Every consumer skipped this value and fell through to the app tier.
    // Storing it would turn "inherit" into a real value that outranks it.
    expect(migrated.platforms?.claude?.model).toBeUndefined();
    expect(migrated.platforms?.claude?.reasoningEffort).toBeUndefined();
  });

  test("merges a Claude model into the same block as agentStyle", () => {
    const migrated = migrateRepositoryAgentSettings(
      { agentStyle: "native", claudeNativeBackend: "tmux", defaultModel: "opus[1m]" },
      "claude",
    );
    expect(migrated.platforms?.claude).toEqual({
      mode: "native",
      model: "opus[1m]",
      claudeNativeBackend: "tmux",
    });
  });
});

describe("migrateEnvironmentAgentSettings", () => {
  test("renames the per-platform modes it already had", () => {
    const migrated = migrateEnvironmentAgentSettings({
      defaultAgent: "codex",
      claudeMode: "terminal",
      codexMode: "native",
      opencodeMode: "native",
      claudeNativeBackend: "tmux",
    });
    expect(migrated.defaultAgent).toBe("codex");
    expect(migrated.platforms?.claude).toEqual({ mode: "terminal", claudeNativeBackend: "tmux" });
    expect(migrated.platforms?.codex).toEqual({ mode: "native" });
    expect(migrated.platforms?.cursor).toBeUndefined();
    expect(migrated.platforms?.grok).toEqual({ mode: "native" });
  });

  test("an environment that overrode nothing still overrides nothing", () => {
    // "Use global default" on every control has to survive as an empty tier,
    // or the migration would pin the environment to today's resolved values.
    expect(migrateEnvironmentAgentSettings({})).toEqual({});
  });
});

describe("migration is idempotent", () => {
  test("re-running over its own output changes nothing", () => {
    for (const legacy of LEGACY_CASES) {
      const once = migrateAll(legacy);
      const twice = {
        environment: migrateEnvironmentAgentSettings({ agentSettings: once.environment }),
        repository: migrateRepositoryAgentSettings({ agentSettings: once.repository }, "claude"),
        global: migrateGlobalAgentSettings({ agentSettings: once.global }),
      };
      expect(twice).toEqual(once);
    }
  });
});
