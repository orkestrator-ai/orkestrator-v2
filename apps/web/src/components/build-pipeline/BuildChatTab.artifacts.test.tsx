/**
 * Published artifacts in a build-pipeline stage transcript: the stage
 * session's own key owns them, and their cards resolve in that conversation.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { invoke } from "@/lib/native/backend";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import * as realBackend from "@/lib/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { clearArtifactPublicationCache } from "@/hooks/useArtifactPublications";
import { clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import {
  installWorkflowArtifactBackend,
  listedConversations,
  workflowArtifactRef,
  workflowPublicationView,
  workflowPublishCall,
} from "@/lib/chat/workflow-artifact-test-support";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/* react-virtuoso renders no rows under happy-dom; stubbed as the sibling suites do. */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: (props: {
    messages: unknown[];
    renderMessage: (index: number, message: unknown, previous: unknown) => ReactNode;
    emptyState?: ReactNode;
    header?: ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      {props.header}
      {props.messages.length === 0 ? props.emptyState : null}
      {props.messages.map((message, index) => (
        <div key={index}>{props.renderMessage(index, message, null)}</div>
      ))}
      {props.footer}
    </div>
  ),
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getBuildPipelineConditional: mock(async () => null),
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const STAGE_KEY = "pipeline-1:build:0:stage-uuid";

const pipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-build",
  environmentType: "local",
  agentType: "claude",
  phase: "complete",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: STAGE_KEY,
      sdkSessionId: "build-session",
      status: "idle",
      startedAt: "2026-10-20T10:00:00.000Z",
      label: "Build Session",
      messageRevision: 1,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          createdAt: "2026-10-20T10:00:01.000Z",
          parts: [
            { type: "text", content: "Publishing the coverage chart" },
            workflowPublishCall("toolu_stage", "art_stage0001"),
          ],
        },
      ],
    },
  ],
  currentSessionIndex: 0,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-10-20T10:00:00.000Z",
  taskTitle: "Stage artifacts",
  taskSnapshot: {
    title: "Stage artifacts",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 3,
  controller: "backend",
};

describe("published artifacts in a build-pipeline stage transcript", () => {
  beforeEach(() => {
    cleanup();
    resetTranscriptArtifactCapabilities();
    clearArtifactRequestCache();
    clearArtifactPublicationCache();
    invokeMock.mockReset();
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
      viewedSessionIds: new Map(),
    });
  });

  test("the stage's own publication renders as a card beside its publish call", async () => {
    installWorkflowArtifactBackend(invokeMock, [
      {
        environmentId: "env-build",
        logicalSessionKey: STAGE_KEY,
        publications: [
          workflowPublicationView(workflowArtifactRef("art_stage0001", "Coverage by package"), {
            toolCallId: "toolu_stage",
          }),
        ],
      },
      {
        // The same key in another environment is another conversation.
        environmentId: "env-other",
        logicalSessionKey: STAGE_KEY,
        publications: [workflowPublicationView(workflowArtifactRef("art_other0001", "Not mine"))],
      },
    ]);
    const { container } = render(
      <BuildChatTab
        isActive
        data={{
          environmentId: "env-build",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    expect(await screen.findByText("Coverage by package")).toBeTruthy();
    expect(screen.getByText("Publishing the coverage chart")).toBeTruthy();
    expect(container.querySelector('[data-rich-block="artifact"]') === null).toBe(false);
    expect(container.querySelector('[data-artifact-notice="detached"]') === null).toBe(true);
    expect(screen.queryByText("Not mine") === null).toBe(true);
    await waitFor(() =>
      expect(listedConversations(invokeMock)).toContain(`env-build/${STAGE_KEY}`),
    );
    expect(
      listedConversations(invokeMock).every((entry) => entry === `env-build/${STAGE_KEY}`),
    ).toBe(true);
  });
});
