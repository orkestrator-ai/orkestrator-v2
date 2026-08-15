import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STARTUP_LAUNCH_AGENT,
  resolveStartupLaunch,
} from "./startup-launch.js";

describe("resolveStartupLaunch", () => {
  test("prefers the environment over the repository over the global tier", () => {
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "codex", codexMode: "native" },
      repository: { defaultAgent: "opencode" },
      global: { defaultAgent: "claude", codexMode: "terminal" },
    }).agent).toBe("codex");

    expect(resolveStartupLaunch({
      environment: {},
      repository: { defaultAgent: "opencode" },
      global: { defaultAgent: "claude" },
    }).agent).toBe("opencode");

    expect(resolveStartupLaunch({
      environment: {},
      repository: {},
      global: { defaultAgent: "codex" },
    }).agent).toBe("codex");
  });

  test("falls back to Claude in terminal mode when nothing is configured", () => {
    expect(resolveStartupLaunch({})).toEqual({
      agent: DEFAULT_STARTUP_LAUNCH_AGENT,
      mode: "terminal",
      claudeNativeBackend: "sdk",
      dispatchedByBackend: false,
    });
  });

  test("reads the repository Claude style when the environment has none", () => {
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "claude" },
      repository: { agentStyle: "native" },
      global: { claudeMode: "terminal" },
    })).toMatchObject({ mode: "native", dispatchedByBackend: true });
  });

  test("lets an environment Claude style override the repository", () => {
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "claude", claudeMode: "terminal" },
      repository: { agentStyle: "native" },
      global: { claudeMode: "native" },
    })).toMatchObject({ mode: "terminal", dispatchedByBackend: false });
  });

  test("leaves a tmux-backed Claude launch with the terminal coordinator", () => {
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "claude", claudeMode: "native" },
      repository: { claudeNativeBackend: "tmux" },
      global: {},
    })).toMatchObject({
      mode: "native",
      claudeNativeBackend: "tmux",
      dispatchedByBackend: false,
    });
  });

  test("dispatches an sdk-backed native Claude launch from the backend", () => {
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "claude", claudeMode: "native" },
      global: { claudeNativeBackend: "sdk" },
    }).dispatchedByBackend).toBe(true);
  });

  test.each([
    ["codex", { codexMode: "native" as const }],
    ["opencode", { opencodeMode: "native" as const }],
  ])("dispatches a native %s launch from the backend", (agent, modes) => {
    expect(resolveStartupLaunch({
      environment: { defaultAgent: agent as "codex" | "opencode", ...modes },
    }).dispatchedByBackend).toBe(true);
  });

  test("routes platforms without their own mode through the OpenCode mode", () => {
    // Mirrors the backend's own resolution: cursor and grok have no dedicated
    // mode field, so they follow `opencodeMode`.
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "grok" },
      global: { opencodeMode: "native", codexMode: "terminal" },
    })).toMatchObject({ mode: "native", dispatchedByBackend: true });

    expect(resolveStartupLaunch({
      environment: { defaultAgent: "cursor" },
      global: { opencodeMode: "terminal" },
    }).dispatchedByBackend).toBe(false);
  });

  test("treats an unset mode as terminal rather than guessing native", () => {
    // An unset mode must not make the renderer stand down for a backend that
    // will decline the launch; that combination loses the attachments.
    expect(resolveStartupLaunch({
      environment: { defaultAgent: "codex" },
      global: { defaultAgent: "codex" },
    }).dispatchedByBackend).toBe(false);
  });
});
