import { describe, expect, test } from "bun:test";
import {
  preserveClientPaneSelection,
  reconcilePersistedLayout,
} from "./pane-layout-restore";
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
        { id: "setup", type: "plain", isSetupTab: true },
      ],
    });
    const json = JSON.stringify(restored);
    expect(json).not.toContain("initialPrompt");
    expect(json).not.toContain("initialCommands");
    expect(json).not.toContain("hostPort");
    expect(json).toContain('"isSetupTab":true');
  });

  test("collapses a setup-marked tab to a plain terminal whatever type it was persisted as", () => {
    // The setup marker wins over the persisted type: the tab's identity is
    // "attach to the backend-owned `<environmentId>:setup` PTY", and any agent
    // surface restored on top of it would spawn its own session instead.
    const restored = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane-1",
      tabs: [
        {
          id: "setup-claude",
          type: "claude-native",
          isSetupTab: true,
          claudeNativeData: { environmentId: "env-1", sessionId: "session-1" },
        },
        { id: "setup-codex", type: "codex", isSetupTab: true },
      ],
      activeTabId: "setup-claude",
    }), context);

    expect(restored?.root).toMatchObject({
      kind: "leaf",
      tabs: [
        { id: "setup-claude", type: "plain", isSetupTab: true },
        { id: "setup-codex", type: "plain", isSetupTab: true },
      ],
    });
    // The agent connection data must not survive the collapse.
    expect(JSON.stringify(restored)).not.toContain("claudeNativeData");
  });

  test("restores unconsumed one-shot agent launch options for every agent tab type", () => {
    // `pane-layout-persistence` deliberately keeps these on disk (unlike
    // `initialPrompt`/`initialCommands`, which must never be replayed). Dropping
    // them here would make the create dialog's model choice evaporate on a
    // renderer reload: `TerminalContainer` hands ownership from the backend's
    // `pendingAgentLaunch` to the tab as soon as the layout is flushed, so the
    // tab is the only carrier left.
    const agentTabs = [
      { id: "claude-native", type: "claude-native", claudeNativeData: { environmentId: "env-1" } },
      { id: "codex-native", type: "codex-native", codexNativeData: { environmentId: "env-1" } },
      { id: "opencode-native", type: "opencode-native", openCodeNativeData: { environmentId: "env-1" } },
      { id: "claude-tmux", type: "claude-tmux", claudeTmuxData: { environmentId: "env-1" } },
      { id: "claude-terminal", type: "claude" },
      { id: "codex-terminal", type: "codex" },
      { id: "opencode-terminal", type: "opencode" },
    ].map((tab) => ({
      ...tab,
      initialAgentModel: `${tab.id}-model`,
      initialReasoningEffort: "xhigh",
    }));

    const restored = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane-1",
      tabs: agentTabs,
      activeTabId: "claude-native",
    }), context);

    expect(restored).not.toBeNull();
    const tabs = (restored?.root as unknown as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tabs).toHaveLength(agentTabs.length);
    for (const tab of tabs) {
      expect(tab.initialAgentModel).toBe(`${tab.id}-model`);
      expect(tab.initialReasoningEffort).toBe("xhigh");
    }
  });

  test("ignores malformed one-shot agent launch and handoff values", () => {
    for (const agentHandoffId of [["not", "a", "string"], "", "   "]) {
      const restored = reconcilePersistedLayout(saved({
        kind: "leaf",
        id: "pane-1",
        tabs: [{
          id: "native",
          type: "claude-native",
          claudeNativeData: { environmentId: "env-1" },
          initialAgentModel: 42,
          initialReasoningEffort: { nested: true },
          agentHandoffId,
          consumedAgentHandoffId: agentHandoffId,
        }],
        activeTabId: "native",
      }), context);

      const tab = (
        restored?.root as unknown as { tabs: Array<Record<string, unknown>> }
      ).tabs[0]!;
      expect(tab.initialAgentModel).toBeUndefined();
      expect(tab.initialReasoningEffort).toBeUndefined();
      expect(tab.agentHandoffId).toBeUndefined();
      expect(tab.consumedAgentHandoffId).toBeUndefined();
    }
  });

  test("restores a consumed handoff reference so the bootstrap stays hidden", () => {
    /*
     * A tab that resumed another session keeps only this id. It survives a
     * restart because the bootstrap prompt is still the session's first message,
     * and without the id it would render as a raw JSON frame.
     */
    const restored = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane-1",
      tabs: [{
        id: "native",
        type: "codex-native",
        codexNativeData: { environmentId: "env-1" },
        agentHandoffId: "handoff-live",
        consumedAgentHandoffId: "handoff-consumed",
      }],
      activeTabId: "native",
    }), context);

    const tab = (
      restored?.root as unknown as { tabs: Array<Record<string, unknown>> }
    ).tabs[0]!;
    expect(tab.agentHandoffId).toBe("handoff-live");
    expect(tab.consumedAgentHandoffId).toBe("handoff-consumed");
  });

  test("restores the last browser address", () => {
    const result = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane",
      tabs: [{
        id: "browser",
        type: "browser",
        browserData: { url: "http://localhost:3000/app" },
      }],
      activeTabId: "browser",
    }), context);

    expect(result?.root).toEqual({
      kind: "leaf",
      id: "pane",
      tabs: [{
        id: "browser",
        type: "browser",
        browserData: { url: "http://localhost:3000/app" },
        displayTitle: undefined,
        isReviewTab: undefined,
      }],
      activeTabId: "browser",
    });
  });

  test("drops malformed browser data and normalizes a missing or non-string URL", () => {
    const malformed = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "browser", type: "browser", browserData: "invalid" }],
      activeTabId: "browser",
    }), context);
    expect(malformed).toBeNull();

    for (const browserData of [{}, { url: 123 }]) {
      const restored = reconcilePersistedLayout(saved({
        kind: "leaf",
        id: "pane",
        tabs: [{ id: "browser", type: "browser", browserData }],
        activeTabId: "browser",
      }), context);
      expect(restored?.root).toMatchObject({
        kind: "leaf",
        tabs: [{ id: "browser", type: "browser", browserData: { url: "" } }],
      });
    }
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

  test("rehydrates local files and every specialized tab against current environment data", () => {
    const localContext = {
      environmentId: "env-1",
      containerId: null,
      isLocal: true,
      worktreePath: "/worktrees/current",
      hasBuildPipeline: (pipelineId: string) => pipelineId === "pipeline-1",
      hasLoopedReview: (workflowId: string) => workflowId === "workflow-1",
    };
    const restored = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane",
      tabs: [
        {
          id: "file",
          type: "file",
          fileData: {
            filePath: "src/index.ts",
            containerId: "stale",
            worktreePath: "/stale",
            isLocalEnvironment: false,
            language: "typescript",
            isDiff: true,
            gitStatus: "M",
            baseBranch: "main",
          },
        },
        { id: "codex", type: "codex-native", codexNativeData: { environmentId: "old", sessionId: "cx-1" } },
        { id: "open", type: "opencode-native", openCodeNativeData: { environmentId: "old", sessionId: "oc-1" } },
        { id: "tmux", type: "claude-tmux", claudeTmuxData: { environmentId: "old" } },
        {
          id: "build",
          type: "claude-build",
          buildTabData: { environmentId: "old", pipelineId: "pipeline-1", taskId: "task-1" },
        },
        {
          id: "looped",
          type: "looped-review",
          loopedReviewTabData: { environmentId: "old", workflowId: "workflow-1" },
        },
      ],
      activeTabId: "file",
    }, { containerId: null }), localContext);

    expect(restored?.root).toMatchObject({
      kind: "leaf",
      tabs: [
        { id: "file", fileData: { worktreePath: "/worktrees/current", isLocalEnvironment: true } },
        { id: "codex", codexNativeData: { environmentId: "env-1", sessionId: "cx-1", isLocal: true } },
        { id: "open", openCodeNativeData: { environmentId: "env-1", sessionId: "oc-1", isLocal: true } },
        { id: "tmux", claudeTmuxData: { environmentId: "env-1", isLocal: true } },
        { id: "build", buildTabData: { environmentId: "env-1", pipelineId: "pipeline-1", taskId: "task-1", isLocal: true } },
        { id: "looped", loopedReviewTabData: { environmentId: "env-1", workflowId: "workflow-1", isLocal: true } },
      ],
    });
    expect(JSON.stringify(restored)).not.toContain("stale");
  });

  test("drops looped-review tabs whose authoritative workflow no longer exists", () => {
    const restored = reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "pane",
      tabs: [
        { id: "plain", type: "plain" },
        {
          id: "missing-loop",
          type: "looped-review",
          loopedReviewTabData: {
            environmentId: "env-1",
            workflowId: "missing",
          },
        },
      ],
      activeTabId: "missing-loop",
    }), {
      ...context,
      hasLoopedReview: () => false,
    });

    expect(restored?.root).toEqual({
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "plain", type: "plain" }],
      activeTabId: "plain",
    });
  });

  test("preserves child order and direction while normalizing split sizes", () => {
    const restored = reconcilePersistedLayout(saved({
      kind: "split",
      id: "split",
      direction: "vertical",
      sizes: [1, 999],
      children: [
        { kind: "leaf", id: "first", tabs: [{ id: "one", type: "plain" }], activeTabId: "one" },
        { kind: "leaf", id: "second", tabs: [{ id: "two", type: "plain" }], activeTabId: "two" },
      ],
    }), context);

    expect(restored?.root).toMatchObject({
      kind: "split",
      direction: "vertical",
      sizes: [10, 90],
      depth: 1,
      children: [{ id: "first" }, { id: "second" }],
    });
  });

  test("defaults invalid sizes and rejects invalid direction, child count, and excessive depth", () => {
    const leaves = [
      { kind: "leaf", id: "first", tabs: [{ id: "one", type: "plain" }], activeTabId: "one" },
      { kind: "leaf", id: "second", tabs: [{ id: "two", type: "plain" }], activeTabId: "two" },
    ];
    expect(reconcilePersistedLayout(saved({
      kind: "split",
      id: "split",
      direction: "horizontal",
      sizes: [0, Number.NaN],
      children: leaves,
    }), context)?.root).toMatchObject({ sizes: [50, 50] });
    expect(reconcilePersistedLayout(saved({ ...leaves[0], kind: "split", direction: "diagonal", children: leaves }), context)).toBeNull();
    expect(reconcilePersistedLayout(saved({ kind: "split", id: "split", direction: "horizontal", children: [leaves[0]] }), context)).toBeNull();

    let tooDeep: unknown = { kind: "leaf", id: "deep-leaf", tabs: [{ id: "deep-tab", type: "plain" }], activeTabId: "deep-tab" };
    for (let depth = 0; depth < 10; depth += 1) {
      tooDeep = {
        kind: "split",
        id: `split-${depth}`,
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          tooDeep,
          { kind: "leaf", id: `sibling-${depth}`, tabs: [{ id: `tab-${depth}`, type: "plain" }], activeTabId: `tab-${depth}` },
        ],
      };
    }
    expect(reconcilePersistedLayout(saved(tooDeep), context)).toBeNull();
  });

  test("returns null when every restored tab is filtered out", () => {
    expect(reconcilePersistedLayout(saved({
      kind: "leaf",
      id: "empty",
      tabs: [{ id: "future", type: "future-tab" }],
      activeTabId: "future",
    }), context)).toBeNull();
  });
});

describe("preserveClientPaneSelection", () => {
  test("adds backend tabs without changing the client's active tab", () => {
    const current = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [{ id: "review-3", type: "claude-native" as const }],
        activeTabId: "review-3",
      },
    };
    const authoritative = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [
          { id: "review-3", type: "claude-native" as const },
          { id: "review-4", type: "claude-native" as const },
        ],
        activeTabId: "review-4",
      },
    };

    const reconciled = preserveClientPaneSelection(authoritative, current);

    expect(reconciled.root).toMatchObject({
      tabs: [{ id: "review-3" }, { id: "review-4" }],
      activeTabId: "review-3",
    });
  });
});
