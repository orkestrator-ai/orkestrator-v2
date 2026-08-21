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
      dispatchedByBackend: true,
    });
  });

  test("reads the repository Claude style when the environment has none", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude" },
        repository: { agentStyle: "native" },
        global: { claudeMode: "terminal" },
      }),
    ).toMatchObject({ mode: "native", dispatchedByBackend: true });
  });

  test("lets an environment Claude style override the repository", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude", claudeMode: "terminal" },
        repository: { agentStyle: "native" },
        global: { claudeMode: "native" },
      }),
    ).toMatchObject({ mode: "terminal", dispatchedByBackend: false });
  });

  test("leaves a tmux-backed Claude launch with the terminal coordinator", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude", claudeMode: "native" },
        repository: { claudeNativeBackend: "tmux" },
        global: {},
      }),
    ).toMatchObject({
      mode: "native",
      claudeNativeBackend: "tmux",
      dispatchedByBackend: false,
    });
  });

  test("dispatches an sdk-backed native Claude launch from the backend", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "claude", claudeMode: "native" },
        global: { claudeNativeBackend: "sdk" },
      }).dispatchedByBackend,
    ).toBe(true);
  });

  test.each([
    ["codex", { codexMode: "native" as const }],
    ["opencode", { opencodeMode: "native" as const }],
  ])("dispatches a native %s launch from the backend", (agent, modes) => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: agent as "codex" | "opencode", ...modes },
      }).dispatchedByBackend,
    ).toBe(true);
  });

  test("routes platforms without their own mode through the OpenCode mode", () => {
    // Mirrors the backend's own resolution: cursor and grok have no dedicated
    // mode field, so they follow `opencodeMode`.
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "grok" },
        global: { opencodeMode: "native", codexMode: "terminal" },
      }),
    ).toMatchObject({ mode: "native", dispatchedByBackend: true });

    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "cursor" },
        global: { opencodeMode: "terminal" },
      }).dispatchedByBackend,
    ).toBe(false);
  });

  test("keeps the conservative terminal fallback for non-Claude agents", () => {
    expect(
      resolveStartupLaunch({
        environment: { defaultAgent: "codex" },
        global: { defaultAgent: "codex" },
      }).dispatchedByBackend,
    ).toBe(false);
  });
});

/**
 * `dispatchedByBackend` is the attachment-ownership contract: the backend's
 * `reconcileInitialLaunchOnce` and the renderer's `TerminalContainer` both call
 * this exact function over the same three tiers, and when they disagree either
 * both consume the initial prompt's images or neither delivers them.
 *
 * Cursor and Grok are the two platforms that gained a mode column of their own
 * in the agent-settings migration, so they are the pair most able to drift.
 */
describe("resolveStartupLaunchFromSettings", () => {
  for (const platform of ["cursor", "grok"] as const) {
    test(`${platform} reads its own mode column across all three tiers`, () => {
      // Shipped default: neither platform expands what the backend dispatches.
      expect(resolveStartupLaunchFromSettings({ global: { defaultAgent: platform } })).toEqual({
        agent: platform,
        mode: "terminal",
        claudeNativeBackend: "sdk",
        dispatchedByBackend: false,
      });

      // A tier that opts in hands the launch to the backend...
      expect(
        resolveStartupLaunchFromSettings({
          global: { defaultAgent: platform, platforms: { [platform]: { mode: "native" } } },
        }),
      ).toMatchObject({ agent: platform, mode: "native", dispatchedByBackend: true });

      // ...and a narrower tier that opts back out takes it away again.
      expect(
        resolveStartupLaunchFromSettings({
          global: { defaultAgent: platform, platforms: { [platform]: { mode: "native" } } },
          repository: { platforms: { [platform]: { mode: "terminal" } } },
        }),
      ).toMatchObject({ mode: "terminal", dispatchedByBackend: false });

      expect(
        resolveStartupLaunchFromSettings({
          global: { defaultAgent: platform, platforms: { [platform]: { mode: "terminal" } } },
          repository: { platforms: { [platform]: { mode: "terminal" } } },
          environment: { platforms: { [platform]: { mode: "native" } } },
        }),
      ).toMatchObject({ mode: "native", dispatchedByBackend: true });
    });

    test(`${platform} does not follow another platform's mode column`, () => {
      // The migration seeds cursor and grok from the OpenCode mode once. After
      // that they are independent, so a later OpenCode change must not move
      // them — which is what the pre-migration mode ternary did.
      expect(
        resolveStartupLaunchFromSettings({
          global: {
            defaultAgent: platform,
            platforms: { opencode: { mode: "native" }, codex: { mode: "native" } },
          },
        }),
      ).toMatchObject({ mode: "terminal", dispatchedByBackend: false });
    });
  }

  test("a tmux-backed Claude launch stays with the terminal coordinator", () => {
    // Native, but the renderer still owns it: a tmux session needs a real PTY
    // projection, so this is the one case where native does not mean dispatched.
    expect(
      resolveStartupLaunchFromSettings({
        global: {
          defaultAgent: "claude",
          platforms: { claude: { mode: "native", claudeNativeBackend: "tmux" } },
        },
      }),
    ).toMatchObject({ mode: "native", dispatchedByBackend: false });
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
      dispatchedByBackend: true,
    });
  });
});
