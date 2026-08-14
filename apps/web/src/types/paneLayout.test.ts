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
} from "./paneLayout";
import {
  LEGACY_PANE_LAYOUT_VERSION as SHARED_LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION as SHARED_PANE_LAYOUT_VERSION,
} from "@orkestrator/protocol/pane-layout";

describe("pane layout runtime helpers", () => {
  test("exports supported schema and depth constants", () => {
    expect(LEGACY_PANE_LAYOUT_VERSION).toBe(1);
    expect(PANE_LAYOUT_VERSION).toBe(3);
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

  test("reads assigned and durable unassigned native-agent identities", () => {
    expect(getNativeAgentData({
      id: "claude",
      type: "agent-native",
      nativeAgentData: { platform: "claude", environmentId: "env", sessionId: "session" },
    })).toEqual({ platform: "claude", environmentId: "env", sessionId: "session" });
    expect(getNativeAgentData({
      id: "unassigned",
      type: "agent-native",
      nativeAgentData: { environmentId: "env" },
    })).toEqual({ environmentId: "env" });
  });

  test("rejects non-native tabs and malformed identities", () => {
    expect(getNativeAgentData({ id: "plain", type: "plain" })).toBeNull();
    expect(getNativeAgentData({
      id: "bad",
      type: "agent-native",
      nativeAgentData: { environmentId: "", platform: "codex" },
    })).toBeNull();
    expect(getNativeAgentData({
      id: "bad-port",
      type: "agent-native",
      nativeAgentData: { environmentId: "env", hostPort: 0 },
    })).toBeNull();
    expect(getNativeAgentData({
      id: "tmux",
      type: "claude-tmux",
      claudeTmuxData: { environmentId: "env" },
    })).toBeNull();
  });
});
