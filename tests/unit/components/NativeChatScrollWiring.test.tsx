import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import * as realHooks from "@/hooks";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import * as realBackend from "@/lib/backend";

const realHooksSnapshot = { ...realHooks };
const realBackendSnapshot = { ...realBackend };
/** Whether the hook reports the transcript as pinned to its tail. */
let isAtBottom = true;
const scrollToBottomMock = mock(() => {});
const useVirtuosoScrollStateMock = mock((options: any = {}) => ({
  isAtBottom,
  isAtBottomRef: { current: isAtBottom },
  scrollToBottom: scrollToBottomMock,
  virtuosoRef: { current: null },
  scrollProps: {
    followOutput: () => false,
    atBottomStateChange: () => {},
    atBottomThreshold: 50,
    totalListHeightChanged: () => {},
    restoreStateFrom: undefined,
    scrollerRef: () => {},
  },
  __options: options,
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: useVirtuosoScrollStateMock,
  useElapsedTimer: () => ({ elapsedSeconds: 0, finalElapsedSeconds: null }),
  clearPersistedVirtuosoState: () => {},
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  adoptNativeAgentSession: async (input: { providerSessionId: string }) => ({
    providerSessionId: input.providerSessionId,
  }),
  getNativeAgentProjection: async (input: {
    agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
    environmentId: string;
  }) => ({
    platform: input.agent,
    environmentId: input.environmentId,
    sessionId: `${input.agent}-session`,
    connection: "connected" as const,
    turn: { phase: "idle" as const },
    messages: [],
    interactions: [],
    composerControls: [],
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: {
        provider: true,
        model: true,
        reasoning: true,
        speed: true,
        mode: true,
      },
    },
    revision: 1,
    generation: "test",
  }),
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

const { AgentNativeTab } = await import("@/components/native-agent/AgentNativeTab");
const { ClaudeTmuxChatTab } = await import("@/components/claude/ClaudeTmuxChatTab");
const { BuildChatTab } = await import("@/components/build-pipeline/BuildChatTab");

const buildPipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-build",
  environmentType: "local",
  agentType: "codex",
  phase: "building",
  sessions: [{
    phase: "build",
    iteration: 0,
    sessionKey: "build-key",
    sdkSessionId: "build-session",
    status: "idle",
    startedAt: "2026-07-29T00:00:00.000Z",
    label: "Build Session",
    messages: [{
      id: "answer-1",
      role: "assistant",
      parts: [{ type: "text", content: "Implementation complete" }],
    }],
  }],
  currentSessionIndex: 0,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-07-29T00:00:00.000Z",
  taskTitle: "Backend-owned build",
  taskSnapshot: {
    title: "Backend-owned build",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 1,
  controller: "backend",
};

describe("native chat scroll wiring", () => {
  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
    mock.module("@/lib/backend", () => realBackendSnapshot);
  });

  beforeEach(() => {
    cleanup();
    useVirtuosoScrollStateMock.mockClear();
    scrollToBottomMock.mockClear();
    isAtBottom = true;

    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
    });

    useClaudeStore.setState({
      clients: new Map(),
      sessions: new Map(),
      pendingQuestions: new Map(),
      pendingPlanApprovals: new Map(),
      messageQueue: new Map(),
      draftText: new Map(),
      attachments: new Map(),
    });
    useClaudeTmuxStore.setState({
      tabs: new Map(),
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
      effortLevels: new Map(),
    });
    useBuildPipelineStore.setState({ pipelines: new Map() });
  });

  test.each(["claude", "codex", "opencode", "cursor", "grok"] as const)(
    "%s native passes its environmentId to the shared Virtuoso scroll hook",
    (platform) => {
      render(
        <AgentNativeTab
          tabId={`tab-${platform}`}
          data={{
            platform,
            environmentId: `env-${platform}`,
            containerId: "container-1",
            sessionId: `${platform}-session`,
          }}
          isActive={false}
        />,
      );

      expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
        isActive: false,
        persistKey: `env-env-${platform}:tab-${platform}`,
        environmentId: `env-${platform}`,
        stickToBottomOnActivation: true,
      });
    },
  );

  test("Claude tmux passes its environmentId to the Virtuoso scroll hook", () => {
    render(
      <ClaudeTmuxChatTab
        tabId="tab-tmux"
        data={{ environmentId: "env-tmux" }}
        isActive={false}
      />,
    );

    expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
      isActive: false,
      persistKey: "claude-tmux-env:env-tmux:tab:tab-tmux",
      environmentId: "env-tmux",
      stickToBottomOnActivation: true,
    });
  });

  // The build transcript renders through the same virtualized list as the
  // native tabs, so it needs the same scroll wiring: a stage that streams while
  // the user is on another tab must be scrolled to its tail on return.
  test("the build transcript passes its environmentId to the Virtuoso scroll hook", () => {
    render(
      <BuildChatTab
        data={{ environmentId: "env-build", pipelineId: "pipeline-1", taskId: "task-1" }}
        isActive={false}
      />,
    );

    expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
      isActive: false,
      persistKey: "build-pipeline:pipeline-1",
      environmentId: "env-build",
      stickToBottomOnActivation: true,
    });
  });

  test("the build transcript offers a way back to the tail once scrolled away", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[buildPipeline.id, buildPipeline]]),
    });

    // Pinned to the tail there is nothing to return to, so no affordance.
    const view = render(
      <BuildChatTab
        data={{ environmentId: "env-build", pipelineId: buildPipeline.id, taskId: "task-1" }}
        isActive
      />,
    );
    expect(view.queryByLabelText("Scroll to bottom of transcript")).toBeNull();

    cleanup();
    isAtBottom = false;
    const scrolled = render(
      <BuildChatTab
        data={{ environmentId: "env-build", pipelineId: buildPipeline.id, taskId: "task-1" }}
        isActive
      />,
    );

    fireEvent.click(scrolled.getByLabelText("Scroll to bottom of transcript"));
    expect(scrollToBottomMock).toHaveBeenCalledTimes(1);
  });

  test("the build transcript keeps the way back after the composer is gone", () => {
    // A finished build has no compose box, and the button lives in the same
    // footer — losing it there would strand the user mid-transcript.
    useBuildPipelineStore.setState({
      pipelines: new Map([[buildPipeline.id, { ...buildPipeline, phase: "complete" as const }]]),
    });
    isAtBottom = false;

    const view = render(
      <BuildChatTab
        data={{ environmentId: "env-build", pipelineId: buildPipeline.id, taskId: "task-1" }}
        isActive
      />,
    );

    expect(view.queryByLabelText("Send a message to the agent")).toBeNull();
    expect(view.getByLabelText("Scroll to bottom of transcript")).toBeTruthy();
  });
});
