import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realSortable from "@dnd-kit/sortable";
import * as realUtilities from "@dnd-kit/utilities";
import type { TabInfo } from "@/types/paneLayout";
import { createDraggableTabId } from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useFileDirtyStore } from "@/stores";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";

const realSortableSnapshot = { ...realSortable };
const realUtilitiesSnapshot = { ...realUtilities };

// Mutable so a test can exercise the isDragging styling branch. The factory
// result is cached by Bun, but the hook body re-reads this on every render.
let sortableIsDragging = false;
let sortableAttributes: Record<string, unknown> = {};
let sortableListeners: Record<string, unknown> = {};
let sortableTransform: unknown = null;
let sortableTransition: string | null = null;
let sortableHookId: unknown;
let sortableTransformInput: unknown;
let sortableTransformString = "";
const sortableSetNodeRefMock = mock((_node: HTMLElement | null) => {});
const sortablePointerDownMock = mock((_event: unknown) => {});

function resetSortableMock() {
  sortableIsDragging = false;
  sortableAttributes = {};
  sortableListeners = {};
  sortableTransform = null;
  sortableTransition = null;
  sortableHookId = undefined;
  sortableTransformInput = undefined;
  sortableTransformString = "";
  sortableSetNodeRefMock.mockReset();
  sortablePointerDownMock.mockReset();
}

mock.module("@dnd-kit/sortable", () => ({
  useSortable: ({ id }: { id: unknown }) => {
    sortableHookId = id;
    return {
      attributes: sortableAttributes,
      listeners: sortableListeners,
      setNodeRef: sortableSetNodeRefMock,
      transform: sortableTransform,
      transition: sortableTransition,
      isDragging: sortableIsDragging,
    };
  },
}));

mock.module("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: (transform: unknown) => {
        sortableTransformInput = transform;
        return sortableTransformString;
      },
    },
  },
}));

const { DraggableTab } = await import("./DraggableTab");

afterAll(() => {
  mock.module("@dnd-kit/sortable", () => realSortableSnapshot);
  mock.module("@dnd-kit/utilities", () => realUtilitiesSnapshot);
});

function renderTab(tab: TabInfo, index = 0) {
  return render(
    <DraggableTab
      tab={tab}
      paneId="pane-1"
      index={index}
      isActive={false}
      canClose
      onSelect={() => {}}
    />,
  );
}

/** Seed a build pipeline whose only field the tab reads is taskTitle. */
function seedPipeline(pipelineId: string, taskTitle: string) {
  useBuildPipelineStore.setState({
    pipelines: new Map([[pipelineId, { id: pipelineId, taskTitle } as never]]),
  });
}

describe("DraggableTab title precedence", () => {
  beforeEach(() => {
    cleanup();
    resetSortableMock();
    useSessionStore.setState({ sessions: new Map() });
    useClaudeStore.setState({ sessions: new Map() });
    useCodexStore.setState({ sessions: new Map() });
    useOpenCodeStore.setState({ sessions: new Map() });
    useBuildPipelineStore.setState({ pipelines: new Map() });
    useFileDirtyStore.setState({ dirtyFiles: new Map() });
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  afterEach(() => {
    cleanup();
  });

  test("session.name beats every other source", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      displayTitle: "Implementation",
      nativeAgentData: { platform: "claude", environmentId: "env-1" },
    };

    useSessionStore.setState({
      sessions: new Map([
        ["sess-1", {
          id: "sess-1",
          environmentId: "env-1",
          tabId: "tab-a",
          name: "Custom",
          status: "connected",
          sessionType: "claude",
          containerId: "c-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastActivityAt: "2024-01-01T00:00:00.000Z",
          order: 0,
        }],
      ]),
    });
    useClaudeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "Auto Title" } as never],
      ]),
    });

    renderTab(tab, 2);

    expect(screen.getByText("Custom 3")).toBeDefined();
  });

  test("review tabs keep their numbered workflow title after the agent names the session", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      displayTitle: "Review",
      isReviewTab: true,
      nativeAgentData: { platform: "claude", environmentId: "env-1" },
    };

    useClaudeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "Auto Title" } as never],
      ]),
    });

    renderTab(tab, 0);

    expect(screen.getByText("Review 1")).toBeDefined();
    expect(screen.queryByText("Auto Title") === null).toBe(true);
  });

  test("workflow tabs keep their label and reveal the user-defined session name on hover", async () => {
    const tab: TabInfo = {
      id: "tab-review",
      type: "agent-native",
      displayTitle: "Review",
      isReviewTab: true,
      nativeAgentData: { platform: "claude", environmentId: "env-1" },
    };
    useSessionStore.setState({
      sessions: new Map([
        ["session-review", {
          id: "session-review",
          environmentId: "env-1",
          tabId: "tab-review",
          name: "Payment retry review",
          status: "connected",
          sessionType: "claude",
          containerId: "container-1",
          createdAt: "2026-07-20T10:00:00.000Z",
          lastActivityAt: "2026-07-20T10:00:00.000Z",
          order: 0,
        }],
      ]),
    });
    useClaudeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-review"), { title: "Generated review title" } as never],
      ]),
    });

    renderTab(tab);

    const trigger = screen.getByText("Review 1").closest("div")!;
    expect(screen.queryByText("Payment retry review") === null).toBe(true);
    expect(screen.queryByText("Generated review title") === null).toBe(true);
    fireEvent.mouseEnter(trigger);

    await waitFor(() => {
      expect(screen.getByText("Payment retry review")).toBeTruthy();
    });
    expect(screen.queryByText("Generated review title") === null).toBe(true);
  });

  test("workflow hover text falls back to the agent-generated session title", async () => {
    const tab: TabInfo = {
      id: "tab-pr",
      type: "agent-native",
      displayTitle: "PR",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };
    useCodexStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-pr"), { title: "Prepare release pull request" } as never],
      ]),
    });

    renderTab(tab);

    const trigger = screen.getByText("PR 1").closest("div")!;
    fireEvent.mouseEnter(trigger);

    await waitFor(() => {
      expect(screen.getByText("Prepare release pull request")).toBeTruthy();
    });
  });

  test("PR tabs keep their numbered workflow title after Codex names the session", () => {
    const tab: TabInfo = {
      id: "tab-codex",
      type: "agent-native",
      displayTitle: "PR",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };
    useCodexStore.setState({
      sessions: new Map([
        [createSessionKey("env-2", "tab-codex"), { title: "Wrong environment" } as never],
        [createSessionKey("env-1", "other-tab"), { title: "Wrong tab" } as never],
        [createSessionKey("env-1", "tab-codex"), { title: "Codex title" } as never],
      ]),
    });

    renderTab(tab);

    expect(screen.getByText("PR 1")).toBeDefined();
    expect(screen.queryByText("Codex title") === null).toBe(true);
  });

  test("resolve tabs keep their numbered workflow title after OpenCode names the session", () => {
    const tab: TabInfo = {
      id: "tab-opencode",
      type: "agent-native",
      displayTitle: "Resolve",
      nativeAgentData: { platform: "opencode", environmentId: "env-1" },
    };
    useOpenCodeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-opencode"), { title: "OpenCode title" } as never],
      ]),
    });

    renderTab(tab, 2);

    expect(screen.getByText("Resolve 3")).toBeDefined();
    expect(screen.queryByText("OpenCode title") === null).toBe(true);
  });

  test("restored legacy Conflict tabs use the Resolve label", () => {
    const tab: TabInfo = {
      id: "tab-codex",
      type: "agent-native",
      displayTitle: "Conflict",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };
    useCodexStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-codex"), { title: "Codex title" } as never],
      ]),
    });

    renderTab(tab, 1);

    expect(screen.getByText("Resolve 2")).toBeDefined();
    expect(screen.queryByText("Codex title") === null).toBe(true);
  });

  test("uses the OpenCode title before the workflow display title", () => {
    const tab: TabInfo = {
      id: "tab-opencode",
      type: "agent-native",
      displayTitle: "Implementation",
      nativeAgentData: { platform: "opencode", environmentId: "env-1" },
    };
    useOpenCodeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-opencode"), { title: "OpenCode title" } as never],
      ]),
    });

    renderTab(tab);

    expect(screen.getByText("OpenCode title")).toBeDefined();
    expect(screen.queryByText("Implementation 1") === null).toBe(true);
  });

  test("a custom terminal session name beats a Codex session title", () => {
    const tab: TabInfo = {
      id: "tab-codex",
      type: "agent-native",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };
    useSessionStore.setState({
      sessions: new Map([
        ["terminal-session", {
          id: "terminal-session",
          environmentId: "env-1",
          tabId: "tab-codex",
          name: "Pinned name",
          status: "connected",
          sessionType: "codex",
          containerId: "container-1",
          createdAt: "2026-07-20T10:00:00.000Z",
          lastActivityAt: "2026-07-20T10:00:00.000Z",
          order: 0,
        }],
      ]),
    });
    useCodexStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-codex"), { title: "Codex title" } as never],
      ]),
    });

    renderTab(tab, 2);

    expect(screen.getByText("Pinned name 3")).toBeDefined();
    expect(screen.queryByText("Codex title") === null).toBe(true);
  });

  test("displayTitle is used when no claude session title exists", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      displayTitle: "Review",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };

    renderTab(tab, 0);

    expect(screen.getByText("Review 1")).toBeDefined();
  });

  test("displayTitle includes the tab number from index + 1", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      displayTitle: "PR",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };

    renderTab(tab, 4);

    expect(screen.getByText("PR 5")).toBeDefined();
  });

  test("falls back to type-default when no title sources are present", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      nativeAgentData: { platform: "codex", environmentId: "env-1" },
    };

    renderTab(tab, 1);

    expect(screen.getByText("Codex 2")).toBeDefined();
  });

  test("claude-tmux tab falls back to the Claude default label", () => {
    const tab: TabInfo = {
      id: "tab-tmux",
      type: "claude-tmux",
      claudeTmuxData: { environmentId: "env-1" },
    };
    renderTab(tab, 0);
    expect(screen.getByText("Claude 1")).toBeDefined();
  });

  test("claude-tmux tab uses displayTitle when provided", () => {
    const tab: TabInfo = {
      id: "tab-tmux",
      type: "claude-tmux",
      displayTitle: "Custom Tmux",
      claudeTmuxData: { environmentId: "env-1" },
    };
    renderTab(tab, 2);
    expect(screen.getByText("Custom Tmux 3")).toBeDefined();
  });

  test("browser tabs use the browser label", () => {
    renderTab({ id: "browser-a", type: "browser", browserData: { url: "" } }, 1);
    expect(screen.getByText("Browser 2")).toBeDefined();
  });

  test("looped-review tabs show their default title and workflow icon", () => {
    const view = renderTab({
      id: "looped-a",
      type: "looped-review",
      loopedReviewTabData: {
        environmentId: "env-1",
        workflowId: "workflow-1",
      },
    }, 1);

    expect(screen.getByText("Looped Review 2")).toBeDefined();
    expect(view.container.querySelector("svg.text-cyan-400")).toBeTruthy();
  });

  test("looped-review tabs reflect completed workflow state", () => {
    const workflow = loopedReviewFixture({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
      phase: "completed",
      pr: { status: "created", url: "https://github.com/acme/repo/pull/1" },
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);

    renderTab({
      id: "looped-complete",
      type: "looped-review",
      loopedReviewTabData: {
        environmentId: "env-1",
        workflowId: workflow.id,
      },
    });

    expect(screen.getByText("Looped Review ✓")).toBeDefined();
  });

  test("file tab title uses the basename and ignores displayTitle", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "file",
      displayTitle: "Should not show",
      fileData: { filePath: "src/components/Foo/Bar.tsx" },
    };

    renderTab(tab, 0);

    expect(screen.getByText("Bar.tsx")).toBeDefined();
  });

  test("file tab title ignores trailing path separators", () => {
    renderTab({
      id: "tab-directory-like-path",
      type: "file",
      fileData: { filePath: "src/components/Foo/" },
    });

    expect(screen.getByText("Foo")).toBeDefined();
    expect(screen.queryByText("src/components/Foo/") === null).toBe(true);
  });

  test("a Claude-native tab ignores a same-key Codex session title", () => {
    // The ?? chain is claude ?? codex ?? openCode, and each selector is scoped
    // to its own tab type. A stale Codex entry under the same key must never
    // win over — or stand in for — the Claude title on a Claude tab.
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      displayTitle: "Review",
      nativeAgentData: { platform: "claude", environmentId: "env-1" },
    };
    useClaudeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "Claude title" } as never],
      ]),
    });
    useCodexStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "Codex title" } as never],
      ]),
    });
    useOpenCodeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "OpenCode title" } as never],
      ]),
    });

    renderTab(tab, 0);

    expect(screen.getByText("Claude title")).toBeDefined();
    expect(screen.queryByText("Codex title") === null).toBe(true);
    expect(screen.queryByText("OpenCode title") === null).toBe(true);
  });

  test("a Claude-native tab with only Codex and OpenCode titles falls back to displayTitle", () => {
    // Proves the other two selectors are type-scoped rather than key-scoped:
    // with no Claude entry the chain yields undefined, not the Codex title.
    const tab: TabInfo = {
      id: "tab-a",
      type: "agent-native",
      displayTitle: "Review",
      nativeAgentData: { platform: "claude", environmentId: "env-1" },
    };
    useCodexStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "Codex title" } as never],
      ]),
    });
    useOpenCodeStore.setState({
      sessions: new Map([
        [createSessionKey("env-1", "tab-a"), { title: "OpenCode title" } as never],
      ]),
    });

    renderTab(tab, 0);

    expect(screen.getByText("Review 1")).toBeDefined();
  });

  test("build tabs use the pipeline task title", () => {
    seedPipeline("pipeline-1", "Add search");

    renderTab({
      id: "tab-build",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
      },
    }, 0);

    expect(screen.getByText("Build: Add search")).toBeDefined();
  });

  test("build tabs fall back to the numbered Build label when the pipeline is unknown", () => {
    renderTab({
      id: "tab-build",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "missing-pipeline",
        taskId: "task-1",
      },
    }, 2);

    expect(screen.getByText("Build 3")).toBeDefined();
  });

  test("build tabs prefer displayTitle over the pipeline task title", () => {
    seedPipeline("pipeline-1", "Add search");

    renderTab({
      id: "tab-build",
      type: "claude-build",
      displayTitle: "Pipeline",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipeline-1",
        taskId: "task-1",
      },
    }, 0);

    expect(screen.getByText("Pipeline 1")).toBeDefined();
    expect(screen.queryByText("Build: Add search") === null).toBe(true);
  });

  test("root tabs use the ROOT label", () => {
    renderTab({ id: "tab-root", type: "root" }, 1);

    expect(screen.getByText("ROOT 2")).toBeDefined();
  });

  test("falls back to a generic Tab label when no branch matches", () => {
    // A file tab without fileData skips the basename branch and every
    // type-default branch below it.
    renderTab({ id: "tab-unknown", type: "file" }, 3);

    expect(screen.getByText("Tab 4")).toBeDefined();
  });
});

describe("DraggableTab icons", () => {
  beforeEach(() => {
    cleanup();
    resetSortableMock();
    useSessionStore.setState({ sessions: new Map() });
    useClaudeStore.setState({ sessions: new Map() });
    useCodexStore.setState({ sessions: new Map() });
    useOpenCodeStore.setState({ sessions: new Map() });
    useBuildPipelineStore.setState({ pipelines: new Map() });
    useFileDirtyStore.setState({ dirtyFiles: new Map() });
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  afterEach(() => {
    cleanup();
  });

  const iconCases: Array<{ name: string; tab: TabInfo; selector: string }> = [
    {
      name: "file",
      tab: { id: "t", type: "file", fileData: { filePath: "a/b.ts" } },
      selector: "svg.lucide-file-code",
    },
    {
      name: "browser",
      tab: { id: "t", type: "browser", browserData: { url: "" } },
      selector: "svg.text-sky-400",
    },
    {
      name: "opencode",
      tab: { id: "t", type: "opencode" },
      selector: "svg.text-green-500",
    },
    {
      name: "agent-native",
      tab: {
        id: "t",
        type: "agent-native",
        nativeAgentData: { platform: "opencode", environmentId: "env-1" },
      },
      selector: "svg.text-green-500",
    },
    {
      name: "claude",
      tab: { id: "t", type: "claude" },
      selector: "svg.text-orange-400",
    },
    {
      name: "agent-native",
      tab: {
        id: "t",
        type: "agent-native",
        nativeAgentData: { platform: "claude", environmentId: "env-1" },
      },
      selector: "svg.text-orange-400",
    },
    {
      name: "claude-tmux",
      tab: {
        id: "t",
        type: "claude-tmux",
        claudeTmuxData: { environmentId: "env-1" },
      },
      selector: "svg.text-orange-400",
    },
    {
      name: "codex",
      tab: { id: "t", type: "codex" },
      selector: "svg.text-emerald-400",
    },
    {
      name: "agent-native",
      tab: {
        id: "t",
        type: "agent-native",
        nativeAgentData: { platform: "codex", environmentId: "env-1" },
      },
      selector: "svg.text-emerald-400",
    },
    {
      name: "claude-build",
      tab: {
        id: "t",
        type: "claude-build",
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
        },
      },
      selector: "svg.lucide-hammer.text-yellow-400",
    },
    {
      name: "looped-review",
      tab: {
        id: "t",
        type: "looped-review",
        loopedReviewTabData: { environmentId: "env-1", workflowId: "w-1" },
      },
      selector: "svg.lucide-repeat-2.text-cyan-400",
    },
    {
      name: "plain",
      tab: { id: "t", type: "plain" },
      selector: "svg.lucide-terminal",
    },
    {
      name: "root",
      tab: { id: "t", type: "root" },
      selector: "svg.lucide-terminal",
    },
  ];

  for (const { name, tab, selector } of iconCases) {
    test(`renders the ${name} icon`, () => {
      const { container } = renderTab(tab, 0);

      expect(container.querySelector(selector)).toBeTruthy();
    });
  }

  test("the browser icon is the globe rather than the default terminal", () => {
    const { container } = renderTab(
      { id: "t", type: "browser", browserData: { url: "" } },
      0,
    );

    expect(container.querySelector("svg.lucide-earth")).toBeTruthy();
    expect(container.querySelector("svg.lucide-terminal") === null).toBe(true);
  });
});

describe("DraggableTab tooltip and context menu structure", () => {
  beforeEach(() => {
    cleanup();
    resetSortableMock();
    useSessionStore.setState({ sessions: new Map() });
    useClaudeStore.setState({ sessions: new Map() });
    useCodexStore.setState({ sessions: new Map() });
    useOpenCodeStore.setState({ sessions: new Map() });
    useBuildPipelineStore.setState({ pipelines: new Map() });
    useFileDirtyStore.setState({ dirtyFiles: new Map() });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows a path tooltip for file tabs", async () => {
    const tab: TabInfo = {
      id: "tab-file",
      type: "file",
      fileData: { filePath: "src/components/Foo/Bar.tsx" },
    };

    renderTab(tab, 0);

    const trigger = screen.getByText("Bar.tsx").closest("div");
    expect(trigger).toBeTruthy();
    fireEvent.mouseEnter(trigger!);

    await waitFor(() => {
      expect(screen.getByText("src/components/Foo/Bar.tsx")).toBeTruthy();
    });
  });

  test("does not wrap the title of a non-file tab in a tooltip trigger", () => {
    const tab: TabInfo = {
      id: "tab-terminal",
      type: "plain",
    };

    renderTab(tab, 0);

    expect(screen.getByText("Terminal 1").getAttribute("data-slot") === null).toBe(true);
  });

  test("marks an active tab with an accent even when its pane is not focused", () => {
    const { container } = render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive
        isFocused={false}
        canClose={false}
        onSelect={() => {}}
      />,
    );

    const indicator = container.querySelector("[aria-hidden='true'].bg-primary");
    expect(indicator).toBeTruthy();
    expect(indicator?.className).toContain("opacity-60");
  });

  test("renders a close button that calls onClose without selecting the tab", () => {
    const onClose = mock(() => {});
    const onSelect = mock(() => {});

    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onClose).toHaveBeenCalledTimes(1);
    // handleClose stops propagation so the tab is not also selected.
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("does not render a close button when canClose is false", () => {
    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole("button") === null).toBe(true);
  });

  test("exposes the close actions through the context menu", () => {
    const onClose = mock(() => {});

    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    expect(screen.getByText("Close")).toBeDefined();
    expect(screen.getByText("Close all")).toBeDefined();
    expect(screen.getByText("Close others")).toBeDefined();
    expect(screen.getByText("Close to the right")).toBeDefined();
    expect(screen.queryByText("Refresh") === null).toBe(true);

    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("exposes Refresh for server-backed agent tabs", () => {
    const onRefresh = mock(() => {});

    render(
      <DraggableTab
        tab={{
          id: "tab-claude",
          type: "agent-native",
          nativeAgentData: { platform: "claude", environmentId: "env-1" },
        }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Claude 1"));
    fireEvent.click(screen.getByText("Refresh"));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("hides the file tooltip again on mouse leave", async () => {
    renderTab({
      id: "tab-file",
      type: "file",
      fileData: { filePath: "src/components/Foo/Bar.tsx" },
    }, 0);

    const trigger = screen.getByText("Bar.tsx").closest("div")!;
    fireEvent.mouseEnter(trigger);
    await waitFor(() => {
      expect(screen.getByText("src/components/Foo/Bar.tsx")).toBeTruthy();
    });

    fireEvent.mouseLeave(trigger);

    await waitFor(() => {
      expect(screen.queryByText("src/components/Foo/Bar.tsx") === null).toBe(true);
    }, { timeout: 10_000 });
  }, 20_000);

  test("shows the file tooltip on focus and hides it on blur", async () => {
    renderTab({
      id: "tab-file",
      type: "file",
      fileData: { filePath: "src/lib/util.ts" },
    }, 0);

    const trigger = screen.getByText("util.ts").closest("div")!;
    fireEvent.focus(trigger);
    await waitFor(() => {
      expect(screen.getByText("src/lib/util.ts")).toBeTruthy();
    });

    fireEvent.blur(trigger);

    await waitFor(() => {
      expect(screen.queryByText("src/lib/util.ts") === null).toBe(true);
    }, { timeout: 10_000 });
  }, 20_000);

  test("marks a focused active tab with a full-opacity accent", () => {
    const { container } = render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive
        isFocused
        canClose={false}
        onSelect={() => {}}
      />,
    );

    const indicator = container.querySelector("[aria-hidden='true'].bg-primary");
    expect(indicator).toBeTruthy();
    expect(indicator?.className).not.toContain("opacity-60");
  });

  test("dims and raises the tab while it is being dragged", () => {
    sortableIsDragging = true;

    renderTab({ id: "tab-terminal", type: "plain" }, 0);

    const tab = screen.getByText("Terminal 1").closest("div")!;
    expect(tab.className).toContain("opacity-50");
    expect(tab.className).toContain("z-50");
  });

  test("wires the pane-scoped sortable identity, ref, styles, attributes, and listeners", () => {
    sortableAttributes = { "data-sortable-attribute": "attached" };
    sortableListeners = { onPointerDown: sortablePointerDownMock };
    sortableTransform = { x: 12, y: 6, scaleX: 1, scaleY: 1 };
    sortableTransition = "transform 200ms ease";
    sortableTransformString = "translate3d(12px, 6px, 0)";

    renderTab({ id: "tab-terminal", type: "plain" });

    const tab = screen.getByText("Terminal 1").closest("div")!;
    expect(sortableHookId).toBe(createDraggableTabId("tab-terminal", "pane-1"));
    expect(sortableSetNodeRefMock).toHaveBeenCalledWith(tab);
    expect(sortableTransformInput).toEqual(sortableTransform);
    expect(tab.style.transform).toBe("translate3d(12px, 6px, 0)");
    expect(tab.style.transition).toBe("transform 200ms ease");
    expect(tab.getAttribute("data-sortable-attribute")).toBe("attached");

    fireEvent.pointerDown(tab);
    expect(sortablePointerDownMock).toHaveBeenCalledTimes(1);
  });

  test("does not dim the tab when it is not being dragged", () => {
    renderTab({ id: "tab-terminal", type: "plain" }, 0);

    const tab = screen.getByText("Terminal 1").closest("div")!;
    expect(tab.className).not.toContain("opacity-50");
    expect(tab.className).not.toContain("z-50");
  });

  test("renders an unsaved-changes dot for a dirty file tab", () => {
    useFileDirtyStore.setState({
      dirtyFiles: new Map([
        ["tab-file", { content: "edited", originalContent: "on disk" }],
      ]),
    });

    const { container } = renderTab({
      id: "tab-file",
      type: "file",
      fileData: { filePath: "src/lib/util.ts" },
    }, 0);

    expect(container.querySelector("[title='Unsaved changes']")).toBeTruthy();
  });

  test("renders no dot when the file tab content matches disk", () => {
    useFileDirtyStore.setState({
      dirtyFiles: new Map([
        ["tab-file", { content: "same", originalContent: "same" }],
      ]),
    });

    const { container } = renderTab({
      id: "tab-file",
      type: "file",
      fileData: { filePath: "src/lib/util.ts" },
    }, 0);

    expect(container.querySelector("[title='Unsaved changes']") === null).toBe(true);
  });

  test("never renders the dot for a non-file tab sharing the dirty tab id", () => {
    useFileDirtyStore.setState({
      dirtyFiles: new Map([
        ["tab-terminal", { content: "edited", originalContent: "on disk" }],
      ]),
    });

    const { container } = renderTab({ id: "tab-terminal", type: "plain" }, 0);

    expect(container.querySelector("[title='Unsaved changes']") === null).toBe(true);
  });

  test("invokes the bulk close handlers from the context menu", () => {
    const onCloseAll = mock(() => {});
    const onCloseOthers = mock(() => {});
    const onCloseToRight = mock(() => {});

    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
        onClose={() => {}}
        onCloseAll={onCloseAll}
        onCloseOthers={onCloseOthers}
        onCloseToRight={onCloseToRight}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    fireEvent.click(screen.getByText("Close all"));
    expect(onCloseAll).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByText("Terminal 1"));
    fireEvent.click(screen.getByText("Close others"));
    expect(onCloseOthers).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByText("Terminal 1"));
    fireEvent.click(screen.getByText("Close to the right"));
    expect(onCloseToRight).toHaveBeenCalledTimes(1);
  });

  test("disables the bulk close items when the pane says they are unavailable", () => {
    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        canCloseAll={false}
        canCloseOthers={false}
        canCloseToRight={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    for (const label of ["Close all", "Close others", "Close to the right"]) {
      expect(screen.getByText(label).getAttribute("aria-disabled")).toBe("true");
    }
    // Close itself stays available: canClose is true and onClose was provided.
    expect(screen.getByText("Close").getAttribute("aria-disabled") === null).toBe(true);
  });

  test("disables bulk close items when their handlers are absent", () => {
    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    for (const label of ["Close all", "Close others", "Close to the right"]) {
      expect(screen.getByText(label).getAttribute("aria-disabled")).toBe("true");
    }
  });

  test("disables Close when the tab cannot be closed", () => {
    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    expect(screen.getByText("Close").getAttribute("aria-disabled")).toBe("true");
  });

  test("disables Close when no onClose handler was supplied", () => {
    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    expect(screen.getByText("Close").getAttribute("aria-disabled")).toBe("true");
  });
});
