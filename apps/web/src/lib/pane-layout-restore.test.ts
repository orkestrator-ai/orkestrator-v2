import { describe, expect, test } from "bun:test";
import { reconcilePersistedLayout } from "./pane-layout-restore";
import type { PersistedPaneLayout } from "@/types/paneLayout";

function saved(root: unknown, overrides: Partial<PersistedPaneLayout> = {}): PersistedPaneLayout {
  return {
    version: 1,
    environmentId: "env-1",
    containerId: "container-1",
    activePaneId: "missing-pane",
    root,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

const context = {
  environmentId: "env-1",
  containerId: "container-1",
  isLocal: false,
};

describe("reconcilePersistedLayout", () => {
  test("rejects version, environment, and container mismatches", () => {
    const root = { kind: "leaf", id: "pane", tabs: [{ id: "tab", type: "plain" }], activeTabId: "tab" };
    expect(reconcilePersistedLayout(saved(root, { version: 2 }), context)).toBeNull();
    expect(reconcilePersistedLayout(saved(root, { environmentId: "other" }), context)).toBeNull();
    expect(reconcilePersistedLayout(saved(root, { containerId: "other" }), context)).toBeNull();
  });

  test("sanitizes tabs, one-shot fields, native connection data, and active pointers", () => {
    const restored = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane-1",
      tabs: [
        { id: "unknown", type: "future-tab" },
        {
          id: "native",
          type: "claude-native",
          initialPrompt: "do not resend",
          initialCommands: ["do not rerun"],
          claudeNativeData: {
            environmentId: "wrong",
            containerId: "wrong",
            hostPort: 9999,
            sessionId: "session-1",
            isLocal: true,
          },
        },
        {
          id: "setup",
          type: "plain",
          initialCommands: ["setup"],
          isSetupTab: true,
        },
      ],
      activeTabId: "unknown",
    }), context);

    expect(restored).not.toBeNull();
    expect(restored?.activePaneId).toBe("pane-1");
    expect(restored?.root).toMatchObject({
      kind: "leaf",
      activeTabId: "native",
      tabs: [
        {
          id: "native",
          type: "claude-native",
          claudeNativeData: {
            environmentId: "env-1",
            containerId: "container-1",
            sessionId: "session-1",
            isLocal: false,
          },
        },
        { id: "setup", type: "plain" },
      ],
    });
    const json = JSON.stringify(restored);
    expect(json).not.toContain("initialPrompt");
    expect(json).not.toContain("initialCommands");
    expect(json).not.toContain("hostPort");
    expect(json).not.toContain("isSetupTab");
  });

  test("deduplicates tabs, drops missing build tabs, and collapses empty leaves", () => {
    const restored = reconcilePersistedLayout(saved({
      kind: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [20, 80],
      children: [
        {
          kind: "leaf",
          id: "empty-pane",
          tabs: [{
            id: "build",
            type: "claude-build",
            buildTabData: { environmentId: "env-1", pipelineId: "missing", taskId: "task-1" },
          }],
          activeTabId: "build",
        },
        {
          kind: "leaf",
          id: "kept-pane",
          tabs: [
            { id: "tab-1", type: "plain" },
            { id: "tab-1", type: "claude" },
          ],
          activeTabId: "tab-1",
        },
      ],
    }), context);

    expect(restored?.root).toEqual({
      kind: "leaf",
      id: "kept-pane",
      tabs: [{ id: "tab-1", type: "plain" }],
      activeTabId: "tab-1",
    });
    expect(restored?.activePaneId).toBe("kept-pane");
  });

  test("rejects malformed trees and duplicate node ids", () => {
    expect(reconcilePersistedLayout(saved({ kind: "leaf", id: "pane", tabs: "bad" }), context)).toBeNull();
    expect(reconcilePersistedLayout(saved({
      kind: "split",
      id: "split",
      direction: "vertical",
      sizes: [50, 50],
      children: [
        { kind: "leaf", id: "duplicate", tabs: [{ id: "a", type: "plain" }], activeTabId: "a" },
        { kind: "leaf", id: "duplicate", tabs: [{ id: "b", type: "plain" }], activeTabId: "b" },
      ],
    }), context)).toBeNull();
  });
});
