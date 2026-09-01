import { describe, expect, test } from "bun:test";
import {
  preserveClientPaneSelection,
  preserveRendererLocalPaneFields,
  reconcilePersistedLayout,
} from "./pane-layout-restore";
import { mergePersistedPaneLayouts } from "./pane-layout-merge";
import {
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  type PersistedPaneLayout,
  type TabInfo,
} from "@/types/paneLayout";
import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";

function saved(root: unknown, overrides: Partial<PersistedPaneLayout> = {}): PersistedPaneLayout {
  return {
    version: PANE_LAYOUT_VERSION,
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
  test("rejects primitive and other non-object persisted roots", () => {
    for (const root of [null, undefined, true, 0, "leaf", []]) {
      expect(reconcilePersistedLayout(saved(root), context), String(root)).toBeNull();
    }
  });

  test("rejects version, environment, and container mismatches", () => {
    const root = {
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "tab", type: "plain" }],
      activeTabId: "tab",
    };
    for (const version of [0, -1, PANE_LAYOUT_VERSION + 1, "2", undefined]) {
      expect(
        reconcilePersistedLayout(
          { ...saved(root), version } as unknown as PersistedPaneLayout,
          context,
        ),
      ).toBeNull();
    }
    expect(reconcilePersistedLayout(saved(root, { environmentId: "other" }), context)).toBeNull();
    expect(reconcilePersistedLayout(saved(root, { containerId: "other" }), context)).toBeNull();
  });

  test("carries the record's revision onto the restored state", () => {
    const root = {
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "tab", type: "plain" }],
      activeTabId: "tab",
    };

    // This is the CAS token every later write is based on; losing it here would
    // make the first edit after a reload look like a create.
    expect(reconcilePersistedLayout(saved(root, { revision: 12 }), context)).toMatchObject({
      backendRevision: 12,
    });
  });

  test("accepts legacy v1 layouts for one-time selection migration", () => {
    const root = {
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "tab", type: "plain" }],
      activeTabId: "tab",
    };

    expect(
      reconcilePersistedLayout(saved(root, { version: LEGACY_PANE_LAYOUT_VERSION }), context),
    ).toMatchObject({ activePaneId: "pane", backendRevision: 1 });
  });

  test("sanitizes tabs, one-shot fields, native connection data, and active pointers", () => {
    const restored = reconcilePersistedLayout(
      saved({
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
            nativeAgentData: {
              platform: "claude",
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "session-1",
              isLocal: false,
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
      }),
      context,
    );

    expect(restored).not.toBeNull();
    expect(restored?.activePaneId).toBe("pane-1");
    expect(restored?.root).toMatchObject({
      kind: "leaf",
      activeTabId: "native",
      tabs: [
        {
          id: "native",
          type: "agent-native",
          nativeAgentData: {
            platform: "claude",
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

  test("restores a native session from canonical data when the legacy payload is absent", () => {
    const restored = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "codex",
            type: "codex-native",
            nativeAgentData: {
              platform: "codex",
              environmentId: "env-1",
              sessionId: "thread-1",
            },
          },
        ],
        activeTabId: "codex",
      }),
      context,
    );

    expect(restored?.root).toMatchObject({
      tabs: [
        {
          nativeAgentData: { platform: "codex", sessionId: "thread-1" },
        },
      ],
    });
  });

  test("restores the newer session after a native layout conflict", () => {
    const layout = (tab: TabInfo) => ({
      version: PANE_LAYOUT_VERSION,
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [tab],
        activeTabId: tab.id,
      },
    });
    const nativeTab = (sessionId: string): TabInfo => ({
      id: "codex",
      type: "agent-native",
      nativeAgentData: { platform: "codex", environmentId: "env-1", sessionId },
    });
    const base = layout(nativeTab("thread-old"));
    const local = layout(nativeTab("thread-new"));
    const remote = layout({
      ...nativeTab("thread-old"),
      displayTitle: "Remote title",
      nativeAgentData: {
        platform: "codex",
        environmentId: "env-1",
        sessionId: "thread-old",
      },
    });

    const merged = mergePersistedPaneLayouts(base, local, remote);
    const restored = reconcilePersistedLayout(
      saved(merged.root, { activePaneId: merged.activePaneId }),
      context,
    );

    expect(restored?.root).toMatchObject({
      tabs: [
        {
          displayTitle: "Remote title",
          nativeAgentData: { platform: "codex", sessionId: "thread-new" },
        },
      ],
    });
  });

  test("collapses a setup-marked tab to a plain terminal whatever type it was persisted as", () => {
    // The setup marker wins over the persisted type: the tab's identity is
    // "attach to the backend-owned `<environmentId>:setup` PTY", and any agent
    // surface restored on top of it would spawn its own session instead.
    const restored = reconcilePersistedLayout(
      saved({
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
      }),
      context,
    );

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
      {
        id: "opencode-native",
        type: "opencode-native",
        openCodeNativeData: { environmentId: "env-1" },
      },
      { id: "claude-tmux", type: "claude-tmux", claudeTmuxData: { environmentId: "env-1" } },
      { id: "claude-terminal", type: "claude" },
      { id: "codex-terminal", type: "codex" },
      { id: "opencode-terminal", type: "opencode" },
      { id: "pi-terminal", type: "pi" },
    ].map((tab) => ({
      ...tab,
      backendManagedTerminal: tab.id.endsWith("-terminal"),
      initialAgentModel: `${tab.id}-model`,
      initialReasoningEffort: "xhigh",
      initialExecutionProfileId: "plan",
    }));

    const restored = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane-1",
        tabs: agentTabs,
        activeTabId: "claude-native",
      }),
      context,
    );

    expect(restored).not.toBeNull();
    const tabs = (restored!.root as unknown as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tabs).toHaveLength(agentTabs.length);
    for (const tab of tabs) {
      expect(tab.initialAgentModel).toBe(`${tab.id}-model`);
      expect(tab.initialReasoningEffort).toBe("xhigh");
      expect(tab.initialExecutionProfileId).toBe("plan");
      if (String(tab.id).endsWith("-terminal")) {
        expect(tab.backendManagedTerminal).toBe(true);
      }
    }
  });

  test("restores strict backend-owned native session identity", () => {
    const restored = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane-1",
        tabs: [
          {
            id: "multi-review-fix:multi-1",
            type: "agent-native",
            nativeAgentData: {
              platform: "codex",
              environmentId: "env-1",
              sessionId: "provider-fix",
              requireExistingResumeSession: true,
            },
          },
        ],
        activeTabId: "multi-review-fix:multi-1",
      }),
      context,
    );

    const tab = (restored!.root as unknown as { tabs: Array<Record<string, unknown>> }).tabs[0]!;
    expect(tab.nativeAgentData).toMatchObject({
      sessionId: "provider-fix",
      requireExistingResumeSession: true,
    });
  });

  test("ignores malformed one-shot agent launch and handoff values", () => {
    for (const agentHandoffId of [["not", "a", "string"], "", "   "]) {
      const restored = reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane-1",
          tabs: [
            {
              id: "native",
              type: "claude-native",
              claudeNativeData: { environmentId: "env-1" },
              initialAgentModel: 42,
              initialReasoningEffort: { nested: true },
              initialExecutionProfileId: agentHandoffId,
              agentHandoffId,
              consumedAgentHandoffId: agentHandoffId,
            },
          ],
          activeTabId: "native",
        }),
        context,
      );

      const tab = (restored!.root as unknown as { tabs: Array<Record<string, unknown>> }).tabs[0]!;
      expect(tab.initialAgentModel).toBeUndefined();
      expect(tab.initialReasoningEffort).toBeUndefined();
      expect(tab.initialExecutionProfileId).toBeUndefined();
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
    const restored = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane-1",
        tabs: [
          {
            id: "native",
            type: "codex-native",
            codexNativeData: { environmentId: "env-1" },
            agentHandoffId: "handoff-live",
            consumedAgentHandoffId: "handoff-consumed",
          },
        ],
        activeTabId: "native",
      }),
      context,
    );

    const tab = (restored!.root as unknown as { tabs: Array<Record<string, unknown>> }).tabs[0]!;
    expect(tab.agentHandoffId).toBe("handoff-live");
    expect(tab.consumedAgentHandoffId).toBe("handoff-consumed");
  });

  test("restores the last browser address", () => {
    const result = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "browser",
            type: "browser",
            browserData: {
              url: "http://localhost:3000/app",
              history: ["http://localhost:3000/", "http://localhost:3000/app"],
              historyIndex: 1,
            },
          },
        ],
        activeTabId: "browser",
      }),
      context,
    );

    expect(result?.root).toEqual({
      kind: "leaf",
      id: "pane",
      tabs: [
        {
          id: "browser",
          type: "browser",
          browserData: {
            url: "http://localhost:3000/app",
            history: ["http://localhost:3000/", "http://localhost:3000/app"],
            historyIndex: 1,
          },
          displayTitle: undefined,
          isReviewTab: undefined,
        },
      ],
      activeTabId: "browser",
    });
  });

  test("migrates sensitive restored history without changing the current URL", () => {
    const result = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "browser",
            type: "browser",
            browserData: {
              url: "https://example.com/current?token=current#live",
              history: [
                "https://alice:secret@example.com/previous?token=old#private",
                "https://example.com/current?token=current#live",
              ],
              historyIndex: 1,
            },
          },
        ],
        activeTabId: "browser",
      }),
      context,
    );

    const browserData = result?.root.kind === "leaf" ? result.root.tabs[0]?.browserData : undefined;
    expect(browserData).toEqual({
      url: "https://example.com/current?token=current#live",
      history: ["https://example.com/previous", "https://example.com/current"],
      historyIndex: 1,
    });
  });

  test("bounds browser history and rebases and clamps its cursor", () => {
    const history = Array.from({ length: 125 }, (_, index) => `http://localhost/${index}`);
    const restore = (historyIndex: unknown) =>
      reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane",
          tabs: [
            {
              id: "browser",
              type: "browser",
              browserData: { url: history[120], history, historyIndex },
            },
          ],
          activeTabId: "browser",
        }),
        context,
      )?.root as Extract<EnvironmentPaneState["root"], { kind: "leaf" }>;

    expect(restore(120).tabs[0]?.browserData).toMatchObject({
      history: history.slice(25),
      historyIndex: 95,
    });
    expect(restore(-100).tabs[0]?.browserData?.historyIndex).toBe(0);
    expect(restore(1000).tabs[0]?.browserData?.historyIndex).toBe(99);
  });

  test("drops malformed browser history and cursors without dropping the tab", () => {
    for (const browserData of [
      { url: "http://localhost", history: ["valid", 2], historyIndex: 0 },
      { url: "http://localhost", history: ["valid"], historyIndex: 1.5 },
      { url: "http://localhost", history: "not-an-array", historyIndex: 0 },
    ]) {
      const restored = reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane",
          tabs: [{ id: "browser", type: "browser", browserData }],
          activeTabId: "browser",
        }),
        context,
      );
      expect(restored?.root).toMatchObject({
        kind: "leaf",
        tabs: [
          {
            id: "browser",
            browserData: { url: "http://localhost" },
          },
        ],
      });
      const tab = (restored!.root as Extract<EnvironmentPaneState["root"], { kind: "leaf" }>)
        .tabs[0];
      if (!Array.isArray(browserData.history)) {
        expect(tab?.browserData?.history).toBeUndefined();
      }
      if (!Number.isSafeInteger(browserData.historyIndex)) {
        expect(tab?.browserData?.historyIndex).toBeUndefined();
      }
    }
  });

  test("drops malformed browser data and normalizes a missing or non-string URL", () => {
    const malformed = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane",
        tabs: [{ id: "browser", type: "browser", browserData: "invalid" }],
        activeTabId: "browser",
      }),
      context,
    );
    expect(malformed).toBeNull();

    for (const browserData of [{}, { url: 123 }]) {
      const restored = reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane",
          tabs: [{ id: "browser", type: "browser", browserData }],
          activeTabId: "browser",
        }),
        context,
      );
      expect(restored?.root).toMatchObject({
        kind: "leaf",
        tabs: [{ id: "browser", type: "browser", browserData: { url: "" } }],
      });
    }
  });

  test("deduplicates tabs, drops missing build tabs, and collapses empty leaves", () => {
    const restored = reconcilePersistedLayout(
      saved({
        kind: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [20, 80],
        children: [
          {
            kind: "leaf",
            id: "empty-pane",
            tabs: [
              {
                id: "build",
                type: "claude-build",
                buildTabData: { environmentId: "env-1", pipelineId: "missing", taskId: "task-1" },
              },
            ],
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
      }),
      context,
    );

    expect(restored?.root).toEqual({
      kind: "leaf",
      id: "kept-pane",
      tabs: [{ id: "tab-1", type: "plain" }],
      activeTabId: "tab-1",
    });
    expect(restored?.activePaneId).toBe("kept-pane");
  });

  test("rejects malformed trees and duplicate node ids", () => {
    expect(
      reconcilePersistedLayout(saved({ kind: "leaf", id: "pane", tabs: "bad" }), context),
    ).toBeNull();
    expect(
      reconcilePersistedLayout(
        saved({
          kind: "split",
          id: "split",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            { kind: "leaf", id: "duplicate", tabs: [{ id: "a", type: "plain" }], activeTabId: "a" },
            { kind: "leaf", id: "duplicate", tabs: [{ id: "b", type: "plain" }], activeTabId: "b" },
          ],
        }),
        context,
      ),
    ).toBeNull();
  });

  test("rehydrates local files and every specialized tab against current environment data", () => {
    const localContext = {
      environmentId: "env-1",
      containerId: null,
      isLocal: true,
      worktreePath: "/worktrees/current",
      hasBuildPipeline: (pipelineId: string) => pipelineId === "pipeline-1",
      hasLoopedReview: (workflowId: string) => workflowId === "workflow-1",
      hasMultiReview: (workflowId: string) => workflowId === "multi-1",
    };
    const restored = reconcilePersistedLayout(
      saved(
        {
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
            {
              id: "codex",
              type: "codex-native",
              codexNativeData: { environmentId: "old", sessionId: "cx-1" },
            },
            {
              id: "open",
              type: "opencode-native",
              openCodeNativeData: { environmentId: "old", sessionId: "oc-1" },
            },
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
            {
              id: "multi",
              type: "multi-review",
              multiReviewTabData: {
                environmentId: "old",
                workflowId: "multi-1",
                reviewerId: "reviewer-1",
              },
            },
          ],
          activeTabId: "file",
        },
        { containerId: null },
      ),
      localContext,
    );

    expect(restored?.root).toMatchObject({
      kind: "leaf",
      tabs: [
        { id: "file", fileData: { worktreePath: "/worktrees/current", isLocalEnvironment: true } },
        {
          id: "codex",
          nativeAgentData: {
            platform: "codex",
            environmentId: "env-1",
            sessionId: "cx-1",
            isLocal: true,
          },
        },
        {
          id: "open",
          nativeAgentData: {
            platform: "opencode",
            environmentId: "env-1",
            sessionId: "oc-1",
            isLocal: true,
          },
        },
        { id: "tmux", claudeTmuxData: { environmentId: "env-1", isLocal: true } },
        {
          id: "build",
          buildTabData: {
            environmentId: "env-1",
            pipelineId: "pipeline-1",
            taskId: "task-1",
            isLocal: true,
          },
        },
        {
          id: "looped",
          loopedReviewTabData: { environmentId: "env-1", workflowId: "workflow-1", isLocal: true },
        },
        {
          id: "multi",
          multiReviewTabData: {
            environmentId: "env-1",
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
            isLocal: true,
          },
        },
      ],
    });
    expect(JSON.stringify(restored)).not.toContain("stale");
  });

  test("drops looped-review tabs whose authoritative workflow no longer exists", () => {
    const restored = reconcilePersistedLayout(
      saved({
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
      }),
      {
        ...context,
        hasLoopedReview: () => false,
      },
    );

    expect(restored?.root).toEqual({
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "plain", type: "plain" }],
      activeTabId: "plain",
    });
  });

  test("drops Multi Review tabs whose authoritative workflow no longer exists", () => {
    const restored = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane",
        tabs: [
          { id: "plain", type: "plain" },
          {
            id: "missing-multi",
            type: "multi-review",
            multiReviewTabData: { environmentId: "env-1", workflowId: "missing" },
          },
        ],
        activeTabId: "missing-multi",
      }),
      {
        ...context,
        hasMultiReview: () => false,
      },
    );

    expect(restored?.root).toEqual({
      kind: "leaf",
      id: "pane",
      tabs: [{ id: "plain", type: "plain" }],
      activeTabId: "plain",
    });
  });

  test("drops Multi Review tabs whose persisted reviewer id is unusable", () => {
    // A reviewer tab that cannot name its reviewer would silently restore as the
    // workflow overview, so an unusable id drops the tab rather than changing
    // which view the user saved.
    for (const reviewerId of ["", "   ", 7, null]) {
      const restored = reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane",
          tabs: [
            { id: "plain", type: "plain" },
            {
              id: "bad-reviewer",
              type: "multi-review",
              multiReviewTabData: { environmentId: "env-1", workflowId: "multi-1", reviewerId },
            },
          ],
          activeTabId: "bad-reviewer",
        }),
        { ...context, hasMultiReview: () => true },
      );

      expect(restored?.root, JSON.stringify(reviewerId)).toEqual({
        kind: "leaf",
        id: "pane",
        tabs: [{ id: "plain", type: "plain" }],
        activeTabId: "plain",
      });
    }
  });

  test("restores a Multi Review overview tab that never named a reviewer", () => {
    const restored = reconcilePersistedLayout(
      saved({
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "overview",
            type: "multi-review",
            multiReviewTabData: { environmentId: "env-1", workflowId: "multi-1" },
          },
        ],
        activeTabId: "overview",
      }),
      { ...context, hasMultiReview: () => true },
    );

    const [tab] = (restored!.root as unknown as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tab?.multiReviewTabData).toEqual({
      environmentId: "env-1",
      workflowId: "multi-1",
      isLocal: false,
    });
    expect(tab?.multiReviewTabData).not.toHaveProperty("reviewerId");
  });

  test("preserves child order and direction while normalizing split sizes", () => {
    const restored = reconcilePersistedLayout(
      saved({
        kind: "split",
        id: "split",
        direction: "vertical",
        sizes: [1, 999],
        children: [
          { kind: "leaf", id: "first", tabs: [{ id: "one", type: "plain" }], activeTabId: "one" },
          { kind: "leaf", id: "second", tabs: [{ id: "two", type: "plain" }], activeTabId: "two" },
        ],
      }),
      context,
    );

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
    expect(
      reconcilePersistedLayout(
        saved({
          kind: "split",
          id: "split",
          direction: "horizontal",
          sizes: [0, Number.NaN],
          children: leaves,
        }),
        context,
      )?.root,
    ).toMatchObject({ sizes: [50, 50] });
    expect(
      reconcilePersistedLayout(
        saved({ ...leaves[0], kind: "split", direction: "diagonal", children: leaves }),
        context,
      ),
    ).toBeNull();
    expect(
      reconcilePersistedLayout(
        saved({ kind: "split", id: "split", direction: "horizontal", children: [leaves[0]] }),
        context,
      ),
    ).toBeNull();

    let tooDeep: unknown = {
      kind: "leaf",
      id: "deep-leaf",
      tabs: [{ id: "deep-tab", type: "plain" }],
      activeTabId: "deep-tab",
    };
    for (let depth = 0; depth < 10; depth += 1) {
      tooDeep = {
        kind: "split",
        id: `split-${depth}`,
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          tooDeep,
          {
            kind: "leaf",
            id: `sibling-${depth}`,
            tabs: [{ id: `tab-${depth}`, type: "plain" }],
            activeTabId: `tab-${depth}`,
          },
        ],
      };
    }
    expect(reconcilePersistedLayout(saved(tooDeep), context)).toBeNull();
  });

  test("returns null when every restored tab is filtered out", () => {
    expect(
      reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "empty",
          tabs: [{ id: "future", type: "future-tab" }],
          activeTabId: "future",
        }),
        context,
      ),
    ).toBeNull();
  });

  test("drops every malformed specialized tab shape while retaining a valid sibling", () => {
    const malformedTabs: Array<{ name: string; tab: Record<string, unknown> }> = [
      { name: "file without data", tab: { id: "bad-file-data", type: "file" } },
      {
        name: "file without a path",
        tab: { id: "bad-file-path", type: "file", fileData: {} },
      },
      {
        name: "Claude native without data",
        tab: { id: "bad-claude-native", type: "claude-native" },
      },
      {
        name: "Codex native without data",
        tab: { id: "bad-codex-native", type: "codex-native" },
      },
      {
        name: "OpenCode native without data",
        tab: { id: "bad-opencode-native", type: "opencode-native" },
      },
      {
        name: "tmux without data",
        tab: { id: "bad-tmux", type: "claude-tmux" },
      },
      {
        name: "build without data",
        tab: { id: "bad-build-data", type: "claude-build" },
      },
      {
        name: "build without a task",
        tab: {
          id: "bad-build-task",
          type: "claude-build",
          buildTabData: { pipelineId: "pipeline-1" },
        },
      },
      {
        name: "build whose pipeline is absent",
        tab: {
          id: "bad-build-reference",
          type: "claude-build",
          buildTabData: { pipelineId: "missing-pipeline", taskId: "task-1" },
        },
      },
      {
        name: "review without data",
        tab: { id: "bad-review-data", type: "looped-review" },
      },
      {
        name: "review without a workflow",
        tab: {
          id: "bad-review-workflow",
          type: "looped-review",
          loopedReviewTabData: {},
        },
      },
      {
        name: "review whose workflow is absent",
        tab: {
          id: "bad-review-reference",
          type: "looped-review",
          loopedReviewTabData: { workflowId: "missing-workflow" },
        },
      },
      {
        name: "unknown tab type",
        tab: { id: "bad-unknown", type: "future-tab" },
      },
    ];
    const restoreContext = {
      ...context,
      hasBuildPipeline: () => false,
      hasLoopedReview: () => false,
    };

    for (const { name, tab } of malformedTabs) {
      const restored = reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane",
          tabs: [{ id: "valid", type: "plain" }, tab],
          activeTabId: tab.id,
        }),
        restoreContext,
      );

      expect(restored?.root, name).toMatchObject({
        kind: "leaf",
        tabs: [{ id: "valid", type: "plain" }],
        activeTabId: "valid",
      });
    }

    expect(
      reconcilePersistedLayout(
        saved({
          kind: "leaf",
          id: "pane",
          tabs: malformedTabs.map(({ tab }) => tab),
          activeTabId: "bad-file-data",
        }),
        restoreContext,
      ),
    ).toBeNull();
  });
});

describe("pane field preservation", () => {
  test("adds backend tabs without changing the client's active tab", () => {
    const current = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf" as const,
        id: "pane",
        tabs: [{ id: "review-3", type: "agent-native" as const }],
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
          { id: "review-3", type: "agent-native" as const },
          { id: "review-4", type: "agent-native" as const },
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

  test("preserves only renderer-local fields for matching tab identities and types", () => {
    const authoritative: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "pane",
      backendRevision: 7,
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "claude",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "authoritative-session",
            },
          },
          {
            id: "codex",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "authoritative-codex-session",
            },
          },
          {
            id: "opencode",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "authoritative-opencode-session",
            },
          },
          { id: "changed-type", type: "plain" },
        ],
        activeTabId: "claude",
      },
    };
    const current: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "pane",
      backendRevision: 6,
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "claude",
            type: "agent-native",
            initialPrompt: "local prompt",
            initialCommands: ["local command"],
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "stale-session",
              hostPort: 4101,
            },
          },
          {
            id: "codex",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "stale-codex-session",
              hostPort: 4102,
            },
          },
          {
            id: "opencode",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              sessionId: "stale-opencode-session",
              hostPort: 4103,
            },
          },
          {
            id: "changed-type",
            type: "agent-native",
            initialPrompt: "must not cross a type change",
            nativeAgentData: {
              environmentId: "env-1",
              hostPort: 4999,
            },
          },
        ],
        activeTabId: "claude",
      },
    };

    const reconciled = preserveRendererLocalPaneFields(authoritative, current);
    if (reconciled.root.kind !== "leaf") {
      throw new Error("expected leaf");
    }
    const [claude, codex, opencode, changedType] = reconciled.root.tabs;

    expect(claude).toMatchObject({
      initialPrompt: "local prompt",
      initialCommands: ["local command"],
      nativeAgentData: {
        sessionId: "authoritative-session",
        hostPort: 4101,
      },
    });
    expect(codex?.nativeAgentData).toMatchObject({
      sessionId: "authoritative-codex-session",
      hostPort: 4102,
    });
    expect(opencode?.nativeAgentData).toMatchObject({
      sessionId: "authoritative-opencode-session",
      hostPort: 4103,
    });
    expect(changedType).toEqual({ id: "changed-type", type: "plain" });
    expect(reconciled.backendRevision).toBe(7);

    if (current.root.kind !== "leaf") {
      throw new Error("expected current leaf");
    }
    current.root.tabs[0]!.initialCommands![0] = "mutated later";
    expect(claude?.initialCommands).toEqual(["local command"]);
  });

  test("preserves renderer-local fields when native tabs move between panes", () => {
    const nativeTabs: TabInfo[] = [
      {
        id: "claude",
        type: "agent-native",
        initialPrompt: "continue the launch",
        initialCommands: ["bun test"],
        nativeAgentData: {
          environmentId: "env-1",
          containerId: "container-1",
          sessionId: "local-claude-session",
          hostPort: 4101,
        },
      },
      {
        id: "codex",
        type: "agent-native",
        nativeAgentData: {
          environmentId: "env-1",
          containerId: "container-1",
          sessionId: "local-codex-session",
          hostPort: 4102,
        },
      },
      {
        id: "opencode",
        type: "agent-native",
        nativeAgentData: {
          environmentId: "env-1",
          containerId: "container-1",
          sessionId: "local-opencode-session",
          hostPort: 4103,
        },
      },
    ];
    const current: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "left",
      backendRevision: 6,
      root: {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: nativeTabs,
            activeTabId: "claude",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [{ id: "stable", type: "plain" }],
            activeTabId: "stable",
          },
        ],
      },
    };
    const authoritative: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "right",
      backendRevision: 7,
      root: {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [],
            activeTabId: null,
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [
              {
                id: "stable",
                type: "plain",
              },
              {
                id: "claude",
                type: "agent-native",
                nativeAgentData: {
                  environmentId: "env-1",
                  containerId: "container-1",
                  sessionId: "authoritative-claude-session",
                },
              },
              {
                id: "codex",
                type: "agent-native",
                nativeAgentData: {
                  environmentId: "env-1",
                  containerId: "container-1",
                  sessionId: "authoritative-codex-session",
                },
              },
              {
                id: "opencode",
                type: "agent-native",
                nativeAgentData: {
                  environmentId: "env-1",
                  containerId: "container-1",
                  sessionId: "authoritative-opencode-session",
                },
              },
            ],
            activeTabId: "stable",
          },
        ],
      },
    };

    const reconciled = preserveRendererLocalPaneFields(authoritative, current);
    if (reconciled.root.kind !== "split") throw new Error("expected split");
    const moved = reconciled.root.children[1];
    if (moved.kind !== "leaf") throw new Error("expected moved leaf");

    expect(moved.tabs.find((tab) => tab.id === "claude")).toMatchObject({
      initialPrompt: "continue the launch",
      initialCommands: ["bun test"],
      nativeAgentData: {
        sessionId: "authoritative-claude-session",
        hostPort: 4101,
      },
    });
    expect(moved.tabs.find((tab) => tab.id === "codex")?.nativeAgentData).toMatchObject({
      sessionId: "authoritative-codex-session",
      hostPort: 4102,
    });
    expect(moved.tabs.find((tab) => tab.id === "opencode")?.nativeAgentData).toMatchObject({
      sessionId: "authoritative-opencode-session",
      hostPort: 4103,
    });
  });

  test("carries a renderer-local host port onto the canonical identity", () => {
    // Persistence strips `hostPort` and restore never writes it onto
    // `nativeAgentData`, so the live port only ever exists on whichever
    // projection its writer used. The pane renderer reads the canonical field,
    // so it has to inherit the port regardless of where it was recorded.
    const nativeTab = (id: string, type: TabInfo["type"], legacy: Partial<TabInfo>): TabInfo => ({
      id,
      type,
      nativeAgentData: {
        platform: id as "claude",
        environmentId: "env-1",
        sessionId: `local-${id}-session`,
      },
      ...legacy,
    });
    const current: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          nativeTab("claude", "agent-native", {
            nativeAgentData: { environmentId: "env-1", hostPort: 4101 },
          }),
          nativeTab("codex", "agent-native", {
            nativeAgentData: { environmentId: "env-1", hostPort: 4102 },
          }),
          nativeTab("opencode", "agent-native", {
            nativeAgentData: { environmentId: "env-1", hostPort: 4103 },
          }),
          nativeTab("cursor", "agent-native", {
            nativeAgentData: {
              platform: "cursor",
              environmentId: "env-1",
              hostPort: 4104,
            },
          }),
        ],
        activeTabId: "claude",
      },
    };
    const authoritativeTab = (id: string, type: TabInfo["type"]): TabInfo => ({
      id,
      type,
      nativeAgentData: {
        platform: id as "claude",
        environmentId: "env-1",
        sessionId: `authoritative-${id}-session`,
      },
    });
    const authoritative: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          authoritativeTab("claude", "agent-native"),
          authoritativeTab("codex", "agent-native"),
          authoritativeTab("opencode", "agent-native"),
          authoritativeTab("cursor", "agent-native"),
        ],
        activeTabId: "claude",
      },
    };

    const reconciled = preserveRendererLocalPaneFields(authoritative, current);
    if (reconciled.root.kind !== "leaf") throw new Error("expected leaf");
    const byId = new Map(reconciled.root.tabs.map((tab) => [tab.id, tab]));

    for (const [id, hostPort] of [
      ["claude", 4101],
      ["codex", 4102],
      ["opencode", 4103],
      ["cursor", 4104],
    ] as const) {
      expect(byId.get(id)?.nativeAgentData).toMatchObject({
        sessionId: `authoritative-${id}-session`,
        hostPort,
      });
    }
  });

  test("leaves the canonical identity alone when no host port is known", () => {
    const tab: TabInfo = {
      id: "codex",
      type: "agent-native",
      nativeAgentData: {
        platform: "codex",
        environmentId: "env-1",
        sessionId: "authoritative-session",
      },
    };
    const state = (tabs: TabInfo[]): EnvironmentPaneState => ({
      containerId: "container-1",
      activePaneId: "pane",
      root: { kind: "leaf", id: "pane", tabs, activeTabId: "codex" },
    });

    const reconciled = preserveRendererLocalPaneFields(
      state([tab]),
      state([{ ...tab, nativeAgentData: { environmentId: "env-1" } }]),
    );
    if (reconciled.root.kind !== "leaf") throw new Error("expected leaf");

    expect(reconciled.root.tabs[0]?.nativeAgentData).toEqual({
      platform: "codex",
      environmentId: "env-1",
      sessionId: "authoritative-session",
    });
  });

  test("preserves selections independently across a recursive split tree", () => {
    const authoritative: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "left",
      root: {
        kind: "split",
        id: "outer",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [
              { id: "left-1", type: "plain" },
              { id: "left-2", type: "plain" },
            ],
            activeTabId: "left-2",
          },
          {
            kind: "split",
            id: "inner",
            direction: "vertical",
            sizes: [50, 50],
            depth: 2,
            children: [
              {
                kind: "leaf",
                id: "middle",
                tabs: [
                  { id: "middle-1", type: "plain" },
                  { id: "middle-2", type: "plain" },
                ],
                activeTabId: "middle-2",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [
                  { id: "right-1", type: "plain" },
                  { id: "right-2", type: "plain" },
                ],
                activeTabId: "right-2",
              },
            ],
          },
        ],
      },
    };
    const current: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "right",
      root: {
        kind: "split",
        id: "current-outer",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [
              { id: "left-1", type: "plain" },
              { id: "left-2", type: "plain" },
            ],
            activeTabId: "left-1",
          },
          {
            kind: "split",
            id: "current-inner",
            direction: "vertical",
            sizes: [50, 50],
            depth: 2,
            children: [
              {
                kind: "leaf",
                id: "middle",
                tabs: [
                  { id: "middle-1", type: "plain" },
                  { id: "middle-2", type: "plain" },
                ],
                activeTabId: "middle-1",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [
                  { id: "right-1", type: "plain" },
                  { id: "right-2", type: "plain" },
                ],
                activeTabId: "right-1",
              },
            ],
          },
        ],
      },
    };

    const reconciled = preserveClientPaneSelection(authoritative, current);
    if (reconciled.root.kind !== "split") {
      throw new Error("expected recursive split");
    }
    const [left, inner] = reconciled.root.children;
    if (left.kind !== "leaf" || inner.kind !== "split") {
      throw new Error("expected left leaf and inner split");
    }
    const [middle, right] = inner.children;
    if (middle.kind !== "leaf" || right.kind !== "leaf") {
      throw new Error("expected inner leaves");
    }

    expect(reconciled.activePaneId).toBe("right");
    expect(left.activeTabId).toBe("left-1");
    expect(middle.activeTabId).toBe("middle-1");
    expect(right.activeTabId).toBe("right-1");
  });

  test("falls back to authoritative selections when local pane or tab selections disappeared", () => {
    const authoritative: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "right",
      root: {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [{ id: "left-new", type: "plain" }],
            activeTabId: "left-new",
          },
          {
            kind: "leaf",
            id: "right",
            tabs: [{ id: "right-new", type: "plain" }],
            activeTabId: "right-new",
          },
        ],
      },
    };
    const current: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "removed-pane",
      root: {
        kind: "split",
        id: "old-split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "left",
            tabs: [{ id: "left-removed", type: "plain" }],
            activeTabId: "left-removed",
          },
          {
            kind: "leaf",
            id: "removed-pane",
            tabs: [{ id: "removed-tab", type: "plain" }],
            activeTabId: "removed-tab",
          },
        ],
      },
    };

    const reconciled = preserveClientPaneSelection(authoritative, current);

    expect(reconciled.activePaneId).toBe("right");
    expect(reconciled.root).toMatchObject({
      children: [
        { id: "left", activeTabId: "left-new" },
        { id: "right", activeTabId: "right-new" },
      ],
    });
  });

  test("does not graft a host port onto a tab the backend sent without one", () => {
    const authoritative: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "pane",
      backendRevision: 9,
      root: {
        kind: "leaf",
        id: "pane",
        // Same id and type, but the authoritative record carries no native
        // connection data at all — the session it described is gone.
        tabs: [{ id: "native", type: "agent-native" }],
        activeTabId: "native",
      },
    };
    const current: EnvironmentPaneState = {
      containerId: "container-1",
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "native",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              containerId: "container-1",
              hostPort: 4321,
              sessionId: "session-1",
            },
          },
        ],
        activeTabId: "native",
      },
    };

    const reconciled = preserveClientPaneSelection(authoritative, current);

    // Re-attaching only the port would leave a tab claiming a live bridge with
    // no session behind it.
    expect(reconciled.root).toMatchObject({
      tabs: [{ id: "native", type: "agent-native" }],
    });
    expect(
      (reconciled.root as { tabs: Array<{ nativeAgentData?: unknown }> }).tabs[0]?.nativeAgentData,
    ).toBeUndefined();
  });
});
