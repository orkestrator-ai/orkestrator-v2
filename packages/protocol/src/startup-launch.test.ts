import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLAUDE_MODE,
  DEFAULT_STARTUP_LAUNCH_AGENT,
  resolveStartupLaunch,
  resolveStartupLaunchFromSettings,
} from "./startup-launch.js";

describe("resolveStartupLaunch", () => {
  test("prefers the environment over the repository over the global tier", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "codex", codexMode: "native" },
        repository: { defaultAgent: "opencode" },
        global: { defaultAgent: "claude", codexMode: "terminal" },
      }).agent,
    ).toBe("codex");

    expect(
      resolveStartupLaunch({
        environment: {},
        repository: { defaultAgent: "opencode" },
        global: { defaultAgent: "claude" },
      }).agent,
    ).toBe("opencode");

    expect(
      resolveStartupLaunch({
        environment: {},
        repository: {},
        global: { defaultAgent: "codex" },
      }).agent,
    ).toBe("codex");
  });

  test("falls back to the native Claude default when nothing is configured", () => {
    expect(resolveStartupLaunch({})).toEqual({
      agent: DEFAULT_STARTUP_LAUNCH_AGENT,
      mode: DEFAULT_CLAUDE_MODE,
      claudeNativeBackend: "sdk",
    });
  });

  test("reads the repository Claude style when the environment has none", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude" },
        repository: { agentStyle: "native" },
        global: { claudeMode: "terminal" },
      }),
    ).toMatchObject({ mode: "native" });
  });

  test("lets an environment Claude style override the repository", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude", claudeMode: "terminal" },
        repository: { agentStyle: "native" },
        global: { claudeMode: "native" },
      }),
    ).toMatchObject({ mode: "terminal" });
  });

  test("dispatches a tmux-backed Claude launch from the backend", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude", claudeMode: "native" },
        repository: { claudeNativeBackend: "tmux" },
        global: {},
      }),
    ).toMatchObject({
      mode: "native",
      claudeNativeBackend: "tmux",
    });
  });

  test("resolves an sdk-backed native Claude launch", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude", claudeMode: "native" },
        global: { claudeNativeBackend: "sdk" },
      }),
    ).toMatchObject({ mode: "native", claudeNativeBackend: "sdk" });
  });

  test.each([
    ["codex", { codexMode: "native" as const }],
    ["opencode", { opencodeMode: "native" as const }],
  ])("resolves a native %s launch", (agent, modes) => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: agent as "codex" | "opencode", ...modes },
      }),
    ).toMatchObject({ mode: "native" });
  });

  test("routes Grok through the legacy OpenCode mode and Cursor through its SDK", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "grok" },
        global: { opencodeMode: "native", codexMode: "terminal" },
      }),
    ).toMatchObject({ mode: "native" });

    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "cursor" },
        global: { opencodeMode: "terminal" },
      }),
    ).toMatchObject({ mode: "native" });
  });

  test("resolves terminal-mode non-Claude agents", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "codex" },
        global: { defaultAgent: "codex" },
      }),
    ).toMatchObject({ mode: "terminal" });
  });
});

/**
 * Grok gained a mode column in the agent-settings migration. Cursor is
 * SDK-only and must stay native even when a legacy tier says terminal.
 */
describe("resolveStartupLaunchFromSettings", () => {
  test("Cursor stays SDK-native across all three tiers", () => {
    for (const tiers of [
      { global: { defaultAgent: "cursor" as const } },
      {
        global: {
          defaultAgent: "cursor" as const,
          platforms: { cursor: { mode: "terminal" as const } },
        },
      },
      {
        global: { defaultAgent: "cursor" as const },
        repository: { platforms: { cursor: { mode: "terminal" as const } } },
      },
      {
        global: { defaultAgent: "cursor" as const },
        environment: { platforms: { cursor: { mode: "terminal" as const } } },
      },
    ]) {
      expect(resolveStartupLaunchFromSettings(tiers)).toMatchObject({
        agent: "cursor",
        mode: "native",
      });
    }
  });

  test("Grok reads its own mode column across all three tiers", () => {
    const platform = "grok" as const;
    expect(resolveStartupLaunchFromSettings({ global: { defaultAgent: platform } })).toEqual({
      agent: platform,
      mode: "terminal",
      claudeNativeBackend: "sdk",
    });

    // A tier that opts in changes the surface while retaining backend ownership...
    expect(
      resolveStartupLaunchFromSettings({
        global: { defaultAgent: platform, platforms: { [platform]: { mode: "native" } } },
      }),
    ).toMatchObject({ agent: platform, mode: "native" });

    // ...and a narrower tier can opt back to a terminal surface.
    expect(
      resolveStartupLaunchFromSettings({
        global: { defaultAgent: platform, platforms: { [platform]: { mode: "native" } } },
        repository: { platforms: { [platform]: { mode: "terminal" } } },
      }),
    ).toMatchObject({ mode: "terminal" });

    expect(
      resolveStartupLaunchFromSettings({
        global: { defaultAgent: platform, platforms: { [platform]: { mode: "terminal" } } },
        repository: { platforms: { [platform]: { mode: "terminal" } } },
        environment: { platforms: { [platform]: { mode: "native" } } },
      }),
    ).toMatchObject({ mode: "native" });
  });

  for (const platform of ["cursor", "grok"] as const) {
    test(`${platform} does not follow another platform's mode column`, () => {
      expect(
        resolveStartupLaunchFromSettings({
          global: {
            defaultAgent: platform,
            platforms: { opencode: { mode: "native" }, codex: { mode: "native" } },
          },
        }),
      ).toMatchObject(platform === "cursor" ? { mode: "native" } : { mode: "terminal" });
    });
  }

  test("resolves a tmux-backed Claude launch", () => {
    expect(
      resolveStartupLaunchFromSettings({
        global: {
          defaultAgent: "claude",
          platforms: { claude: { mode: "native", claudeNativeBackend: "tmux" } },
        },
      }),
    ).toMatchObject({ mode: "native" });
  });

  test("the Claude backend is read from Claude's own column whatever the agent is", () => {
    // The field is only meaningful for Claude, and the legacy tiers stored it
    // once rather than per platform, so a Cursor launch must not pick it up
    // from the cursor block.
    expect(
      resolveStartupLaunchFromSettings({
        global: {
          defaultAgent: "cursor",
          platforms: {
            claude: { claudeNativeBackend: "tmux" },
            cursor: { mode: "native" },
          },
        },
      }),
    ).toEqual({
      agent: "cursor",
      mode: "native",
      claudeNativeBackend: "tmux",
    });
  });
});
