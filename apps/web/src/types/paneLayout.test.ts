import { describe, expect, test } from "bun:test";
import {
  MAX_SPLIT_DEPTH,
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  createDraggableTabId,
  createEdgeDroppableId,
  createTabbarDroppableId,
  getNativeAgentData,
  isGitFileStatus,
  isPaneLeaf,
  isPaneSplit,
  parseDraggableTabId,
  parseEdgeDroppableId,
  toLegacyNativeAgentData,
} from "./paneLayout";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  LEGACY_PANE_LAYOUT_VERSION as SHARED_LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION as SHARED_PANE_LAYOUT_VERSION,
} from "@orkestrator/protocol/pane-layout";

describe("pane layout runtime helpers", () => {
  test("exports supported schema and depth constants", () => {
    expect(LEGACY_PANE_LAYOUT_VERSION).toBe(1);
    expect(PANE_LAYOUT_VERSION).toBe(2);
    expect(LEGACY_PANE_LAYOUT_VERSION).toBe(SHARED_LEGACY_PANE_LAYOUT_VERSION);
    expect(PANE_LAYOUT_VERSION).toBe(SHARED_PANE_LAYOUT_VERSION);
    expect(MAX_SPLIT_DEPTH).toBe(9);
  });

  test("recognizes pane node and git status variants", () => {
    const leaf = { kind: "leaf" as const, id: "pane", tabs: [], activeTabId: null };
    expect(isPaneLeaf(leaf)).toBe(true);
    expect(isPaneSplit({
      kind: "split",
      id: "split",
      direction: "horizontal",
      children: [leaf, { ...leaf, id: "pane-2" }],
      sizes: [50, 50],
      depth: 1,
    })).toBe(true);
    for (const status of ["M", "A", "D", "?", "R", "C"]) expect(isGitFileStatus(status)).toBe(true);
    for (const value of ["X", "", null, 1]) expect(isGitFileStatus(value)).toBe(false);
  });

  test("creates and parses drag identifiers", () => {
    expect(createDraggableTabId("tab-one", "pane-two")).toBe("tab:tab-one:pane:pane-two");
    expect(parseDraggableTabId("tab:tab-one:pane:pane-two")).toEqual({ tabId: "tab-one", paneId: "pane-two" });
    expect(parseDraggableTabId("not-a-tab")).toBeNull();
    expect(createEdgeDroppableId("pane:one", "left")).toBe("edge:pane:one:left");
    expect(parseEdgeDroppableId("edge:pane:one:left")).toEqual({ paneId: "pane:one", direction: "left" });
    expect(parseEdgeDroppableId("edge:pane:one:diagonal")).toBeNull();
    expect(createTabbarDroppableId("pane:one")).toBe("tabbar:pane:one");
  });

  test("normalizes every legacy native tab onto one data contract", () => {
    expect(getNativeAgentData({
      id: "claude",
      type: "claude-native",
      claudeNativeData: { environmentId: "env", sessionId: "session" },
    })).toEqual({
      platform: "claude",
      environmentId: "env",
      sessionId: "session",
    });
    expect(getNativeAgentData({
      id: "cursor",
      type: "cursor-native",
      acpNativeData: { provider: "cursor", environmentId: "env" },
    })).toEqual({ platform: "cursor", environmentId: "env" });
    expect(getNativeAgentData({ id: "plain", type: "plain" })).toBeNull();
  });

  test("prefers the canonical identity over the legacy record", () => {
    expect(getNativeAgentData({
      id: "codex",
      type: "codex-native",
      codexNativeData: { environmentId: "env", sessionId: "stale" },
      nativeAgentData: {
        platform: "codex",
        environmentId: "env",
        sessionId: "current",
      },
    })).toEqual({
      platform: "codex",
      environmentId: "env",
      sessionId: "current",
    });
  });

  test("covers every registered platform through its tab type", () => {
    const tabTypes: Record<string, string> = {
      claude: "claude-native",
      codex: "codex-native",
      opencode: "opencode-native",
      cursor: "cursor-native",
      grok: "grok-native",
    };
    for (const platform of AGENT_PLATFORMS) {
      expect(getNativeAgentData({
        id: platform,
        type: tabTypes[platform] as "codex-native",
        nativeAgentData: { platform, environmentId: "env" },
      })).toEqual({ platform, environmentId: "env" });
    }
  });

  test("falls back to the legacy record when the canonical identity is unusable", () => {
    // The tab type owns the platform. A canonical field naming another
    // provider, or one that fails validation, must not reach the adapter
    // registry — it would select the wrong controller or none at all.
    const legacy = { environmentId: "env", sessionId: "session" };
    const cases = [
      { platform: "claude", environmentId: "env" },
      { platform: "codex", environmentId: "" },
      { platform: "not-a-platform", environmentId: "env" },
      { platform: "codex", environmentId: "env", hostPort: 0 },
      { platform: "codex", environmentId: "env", hostPort: 1.5 },
      "not-an-object",
      null,
    ];
    for (const nativeAgentData of cases) {
      expect(getNativeAgentData({
        id: "codex",
        type: "codex-native",
        codexNativeData: legacy,
        nativeAgentData: nativeAgentData as never,
      })).toEqual({ platform: "codex", ...legacy });
    }
  });

  test("returns null when neither projection is usable", () => {
    expect(getNativeAgentData({
      id: "codex",
      type: "codex-native",
      nativeAgentData: { platform: "claude", environmentId: "env" },
    })).toBeNull();
    // An environment id is the one field with no authoritative fallback.
    expect(getNativeAgentData({
      id: "codex",
      type: "codex-native",
      codexNativeData: { environmentId: "" },
    })).toBeNull();
    expect(getNativeAgentData({
      id: "tmux",
      type: "claude-tmux",
      claudeTmuxData: { environmentId: "env" },
    })).toBeNull();
  });

  test("drops the platform when projecting back onto a legacy record", () => {
    expect(toLegacyNativeAgentData({
      platform: "claude",
      environmentId: "env",
      containerId: "container",
      sessionId: "session",
      isLocal: false,
    })).toEqual({
      environmentId: "env",
      containerId: "container",
      sessionId: "session",
      isLocal: false,
    });
    expect(
      toLegacyNativeAgentData({ platform: "grok", environmentId: "env" }),
    ).not.toHaveProperty("platform");
  });
});
