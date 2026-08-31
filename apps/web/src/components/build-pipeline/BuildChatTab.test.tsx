import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as realBackend from "@/lib/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { restoreMatchMedia, setMobileViewport } from "../../../../../tests/mocks/match-media";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/**
 * The props the tab handed the transcript list on its last render.
 *
 * `computeItemKey`, `find` and the scroll wiring are the list's contract with
 * the tab and never reach the DOM, so the stub records them rather than letting
 * them go unasserted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listProps: any = null;

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Every native chat tab's suite stubs it the same way to assert on
 * the transcript the shared renderer produced.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: (props: any) => {
    listProps = props;
    const { messages, renderMessage, resolvePreviousMessage, emptyState, footer } = props;
    return (
      <div>
        {messages.length === 0 ? emptyState : null}
        {messages.map((message: unknown, index: number) => (
          <div key={index}>
            {renderMessage(
              index,
              message,
              // Mirror the real list so the tab's resolver actually runs here.
              resolvePreviousMessage
                ? resolvePreviousMessage(messages, index)
                : index > 0
                  ? messages[index - 1]
                  : null,
            )}
          </div>
        ))}
        {footer}
      </div>
    );
  },
}));
const pauseBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "paused" as const,
  backendRevision: 9,
}));
const resumeBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  backendRevision: 10,
}));
const cancelBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "failed" as const,
  error: "Build cancelled",
  backendRevision: 11,
}));
const sendMessageMock = mock(async (pipelineId: string, text: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  pendingUserMessages: [{ id: "queued-1", text, createdAt: "2026-07-29T00:02:00.000Z" }],
  backendRevision: 12,
}));
const retryReviewMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "reviewing" as const,
  backendRevision: 13,
}));
const retryStageMock = mock(async (pipelineId: string): Promise<BuildPipeline> => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  error: undefined,
  failureContext: undefined,
  backendRevision: 14,
}));
const retryInteractionFailureMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  error: undefined,
  failureContext: undefined,
  backendRevision: useBuildPipelineStore.getState().pipelines.get(pipelineId)!.backendRevision + 1,
}));
const getBuildPipelineConditionalMock = mock(async (_pipelineId: string) => null as unknown);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  pauseBuildPipeline: pauseBuildPipelineMock,
  resumeBuildPipeline: resumeBuildPipelineMock,
  cancelBuildPipeline: cancelBuildPipelineMock,
  sendBuildPipelineMessage: sendMessageMock,
  retryBuildPipelineReview: retryReviewMock,
  retryBuildPipelineStage: retryStageMock,
  retryBuildPipelineInteractionFailure: retryInteractionFailureMock,
  getBuildPipelineConditional: getBuildPipelineConditionalMock,
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  restoreMatchMedia();
});

const pipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-1",
  environmentType: "local",
  agentType: "codex",
  phase: "complete",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: "build-key",
      sdkSessionId: "build-session",
      status: "idle",
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Build Session",
      messages: [
        {
          id: "answer-1",
          role: "assistant",
          parts: [{ type: "text", content: "Implementation complete" }],
        },
      ],
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "idle",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messages: [
        {
          info: { id: "answer-2", role: "assistant" },
          parts: [{ type: "text", text: "All criteria pass" }],
        },
      ],
    },
  ],
  currentSessionIndex: 1,
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
  backendRevision: 8,
  controller: "backend",
};

describe("BuildChatTab backend projection", () => {
  beforeEach(() => {
    cleanup();
    pauseBuildPipelineMock.mockClear();
    resumeBuildPipelineMock.mockClear();
    cancelBuildPipelineMock.mockClear();
    sendMessageMock.mockClear();
    retryReviewMock.mockClear();
    retryStageMock.mockClear();
    retryInteractionFailureMock.mockClear();
    mockToastError.mockClear();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineConditionalMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
    });
  });

  test("renders the same backend sessions and transcripts for every client", () => {
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    expect(screen.getByText("Backend-owned build")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    fireEvent.click(screen.getByText("Build Session"));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("renders loading and empty-stage states from incomplete snapshots", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    const { rerender } = render(
      <BuildChatTab
        data={{
          pipelineId: "missing",
          environmentId: "env-1",
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();

    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "empty",
      phase: "building",
      sessions: [],
      currentSessionIndex: -1,
      backendRevision: 9,
    });
    rerender(
      <BuildChatTab
        data={{
          pipelineId: "empty",
          environmentId: "env-1",
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    expect(screen.getByText("The backend is preparing the first stage.")).toBeTruthy();
    expect(screen.getByText("Waiting for the backend to start a build stage.")).toBeTruthy();
  });

  test("ignores malformed transcript entries and renders terminal errors", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "malformed",
      phase: "failed",
      error: "Verification crashed",
      sessions: [
        {
          ...pipeline.sessions[0]!,
          status: "error",
          messages: [null, 42, {}, { content: [] }] as unknown[],
        },
      ],
      currentSessionIndex: 0,
      backendRevision: 9,
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: "malformed",
          environmentId: "env-1",
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    expect(screen.getByText("Verification crashed")).toBeTruthy();
    expect(screen.getByText("No text transcript was produced for this stage.")).toBeTruthy();
  });

  test("runs pause, resume, and cancel controls against authoritative backend snapshots", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    const data = {
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    };
    render(<BuildChatTab data={data} />);

    expect(screen.getByRole("button", { name: "Pause" }).getAttribute("data-variant")).toBe(
      "outline",
    );
    expect(screen.getByRole("button", { name: "Cancel" }).getAttribute("data-variant")).toBe(
      "outline",
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByText("Build cancelled")).toBeTruthy());
  });

  test("routes the mobile icon controls through their backend actions", async () => {
    setMobileViewport(true);
    try {
      pauseBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => ({
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        phase: "paused" as const,
        backendRevision: 14,
      }));
      resumeBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => ({
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        phase: "building" as const,
        backendRevision: 15,
      }));
      cancelBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => ({
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        phase: "failed" as const,
        error: "Build cancelled",
        backendRevision: 16,
      }));
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        phase: "building",
        backendRevision: 9,
      });
      const data = {
        pipelineId: pipeline.id,
        environmentId: pipeline.environmentId,
        taskId: pipeline.taskId,
        isLocal: true,
      };
      render(<BuildChatTab data={data} />);

      fireEvent.click(screen.getByRole("button", { name: "Retry Review" }));
      await waitFor(() => expect(retryReviewMock).toHaveBeenCalledWith(pipeline.id));
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await waitFor(() => expect(resumeBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(cancelBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    } finally {
      setMobileViewport(false);
    }
  });

  test("routes the mobile failed-stage icon through the retry action", async () => {
    setMobileViewport(true);
    try {
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        phase: "failed",
        error: "Verification did not complete",
        failureContext: {
          phase: "verifying",
          kind: "stage-transition",
          sessionId: "verify-session",
        },
        backendRevision: 9,
      });
      render(
        <BuildChatTab
          data={{
            pipelineId: pipeline.id,
            environmentId: pipeline.environmentId,
            taskId: pipeline.taskId,
            isLocal: true,
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Retry Verification Stage" }));
      await waitFor(() => expect(retryStageMock).toHaveBeenCalledWith(pipeline.id));
    } finally {
      setMobileViewport(false);
    }
  });

  test("re-enables a control when the backend rejects it", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    pauseBuildPipelineMock.mockRejectedValueOnce(new Error("pause unavailable"));
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    const pause = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    fireEvent.click(pause);
    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pause.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to pause build", {
      description: "pause unavailable",
    });
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("building");
  });

  test("reports a non-Error resume rejection and re-enables the control", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "paused",
      backendRevision: 9,
    });
    resumeBuildPipelineMock.mockRejectedValueOnce("resume unavailable");
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    const resume = screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement;
    fireEvent.click(resume);

    await waitFor(() => expect(resumeBuildPipelineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(resume.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to resume build", {
      description: "resume unavailable",
    });
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("paused");
  });

  test("reports a cancelled-control failure without replacing the snapshot", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    cancelBuildPipelineMock.mockRejectedValueOnce(503);
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    fireEvent.click(cancel);

    await waitFor(() => expect(cancelBuildPipelineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cancel.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to cancel build", {
      description: "503",
    });
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("building");
  });

  test("sends one control request however fast the button is clicked", async () => {
    let release: (() => void) | undefined;
    pauseBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        phase: "paused" as const,
        backendRevision: 14,
      };
    });
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    const pause = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    fireEvent.click(pause);
    // The disabled attribute alone is not the guard — a click dispatched before
    // React commits it would still reach the handler and pause twice.
    fireEvent.click(pause);
    await waitFor(() => expect(pause.disabled).toBe(true));
    fireEvent.click(pause);

    expect(pauseBuildPipelineMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("paused");
  });

  test("surfaces persisted GitHub completion-comment recovery in the build tab", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      source: {
        type: "github",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 42,
        issueUrl: "https://github.com/acme/widget/issues/42",
        status: "closed",
      },
      completionCommentStatus: "failed",
      completionCommentError: "GitHub unavailable",
      backendRevision: 9,
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    expect(screen.getByText(/GitHub completion comment failed/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Retry GitHub completion comment",
      }),
    ).toBeTruthy();
  });

  test("offers only the interaction retry and renders its failure message once", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "failed",
      error: "Unexpected authorization",
      failureContext: {
        phase: "building",
        kind: "interactive-request",
        sessionId: "build-session",
        requestId: "permission-1",
      },
      backendRevision: 15,
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    expect(screen.getAllByText("Unexpected authorization")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry Review" }) === null).toBe(true);
    const retry = screen.getByRole("button", { name: "Retry failed build phase" });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(retryInteractionFailureMock).toHaveBeenCalledWith(pipeline.id);
      expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("building");
    });
  });
});

describe("BuildChatTab presentation", () => {
  const reviewSession: BuildPipeline["sessions"][number] = {
    phase: "review",
    iteration: 0,
    sessionKey: "review-key",
    sdkSessionId: "review-session",
    status: "idle",
    startedAt: "2026-07-29T00:00:30.000Z",
    label: "Review Session",
    structuredRequestId: "review-request",
    structuredResultStatus: "accepted",
    messages: [
      {
        id: "review-answer",
        role: "assistant",
        content: "The review is complete",
        parts: [
          { type: "text", content: "The review is complete" },
          {
            type: "tool-invocation",
            content: "shell",
            toolName: "shell",
            toolArgs: { command: "git diff --stat" },
            toolState: "success",
            toolOutput: "1 file changed",
          },
        ],
      },
    ],
  };
  const reviewed: BuildPipeline = {
    ...pipeline,
    sessions: [pipeline.sessions[0]!, reviewSession, pipeline.sessions[1]!],
    currentSessionIndex: 2,
    structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
    structuredReviewRequestId: "review-request",
    backendRevision: 40,
  };

  function renderTab(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: next.id,
          environmentId: next.environmentId,
          taskId: next.taskId,
          isLocal: true,
        }}
      />,
    );
  }

  /*
   * The pipeline transcript runs through the same adapter as the chat tabs, so
   * tool activity arrives grouped into a `tool-group` and one provider turn is
   * split into several timestamped rows. These helpers flatten both so the
   * assertions below stay about *which* activity survived payload filtering
   * rather than about the section boundaries, which `pipeline-transcript.test.ts`
   * owns.
   */
  interface RenderedPart {
    type: string;
    content: string;
    parts?: RenderedPart[];
  }

  function renderedParts(): RenderedPart[] {
    return (listProps.messages as Array<{ parts: RenderedPart[] }>).flatMap(
      (message) => message.parts,
    );
  }

  function visibleToolInvocations(): string[] {
    const collect = (parts: RenderedPart[]): string[] =>
      parts.flatMap((part) => {
        if (part.type === "tool-invocation") return [part.content];
        if (part.type === "tool-group" || part.type === "agent-group") {
          return collect(part.parts ?? []);
        }
        return [];
      });
    return collect(renderedParts());
  }

  function visibleTextContents(): string[] {
    return renderedParts()
      .filter((part) => part.type === "text")
      .map((part) => part.content);
  }

  beforeEach(() => {
    cleanup();
    retryStageMock.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
  });

  test("marks the shown stage as selected in the stage list", async () => {
    renderTab(reviewed);

    const selected = () =>
      screen
        .getAllByRole("tab")
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
        .map((tab) => tab.textContent);

    // The pipeline is followed to its current stage until the user picks one.
    expect(selected()).toEqual([expect.stringContaining("Verification Session")]);

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(selected()).toEqual([expect.stringContaining("Build Session")]));
  });

  test("renders tool activity through the shared transcript components", () => {
    renderTab(reviewed);
    fireEvent.click(screen.getByText("Review Session"));

    // The tool row, not a flattened dump of every part's text.
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(screen.getByText("git diff --stat")).toBeTruthy();
    expect(screen.getByText("The review is complete")).toBeTruthy();
    expect(screen.queryByText(/"toolArgs"/) === null).toBe(true);
  });

  test("shows the structured review report only on the stage that produced it", async () => {
    renderTab(reviewed);
    const reportLabel = "Structured review report";

    // The pipeline is following its verification stage, which did not review.
    expect(screen.queryByLabelText(reportLabel) === null).toBe(true);

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(screen.getByLabelText(reportLabel)).toBeTruthy());

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.queryByLabelText(reportLabel) === null).toBe(true));
  });

  test("shows every multi-model reviewer report and the consolidated report in its transcript", async () => {
    const reviewerOneReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "Reviewer one found the dispatch race.",
    };
    const reviewerTwoReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "Reviewer two found the recovery gap.",
    };
    const consolidationReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "The consolidation retained both findings.",
    };
    const reviewerOnePayload = JSON.stringify(reviewerOneReport);
    const reviewSessions: BuildPipeline["sessions"] = [
      {
        ...reviewSession,
        sessionKey: "review-1-key",
        sdkSessionId: "review-1-session",
        label: "Review 1",
        reviewReport: reviewerOneReport,
        messages: [
          {
            id: "review-1-answer",
            role: "assistant",
            content: reviewerOnePayload,
            parts: [
              { type: "text", content: reviewerOnePayload },
              {
                type: "tool-invocation",
                content: "git diff --stat",
                toolName: "shell",
                toolState: "success",
              },
            ],
          },
        ],
      },
      {
        ...reviewSession,
        sessionKey: "review-2-key",
        sdkSessionId: "review-2-session",
        label: "Review 2",
        reviewReport: reviewerTwoReport,
      },
      {
        ...reviewSession,
        sessionKey: "consolidation-key",
        sdkSessionId: "consolidation-session",
        label: "Consolidation",
        structuredRequestId: "consolidation-request",
        reviewReport: consolidationReport,
      },
    ];
    renderTab({
      ...reviewed,
      reviewers: [{ agent: "codex" }, { agent: "claude" }],
      sessions: [pipeline.sessions[0]!, ...reviewSessions, pipeline.sessions[1]!],
      currentSessionIndex: 4,
      structuredReview: consolidationReport,
      structuredReviewRequestId: "consolidation-request",
    });

    fireEvent.click(screen.getByText("Review 1"));
    expect(await screen.findByLabelText("Reviewer report")).toBeTruthy();
    expect(visibleTextContents()).not.toContain(reviewerOnePayload);
    expect(visibleToolInvocations()).toEqual(["git diff --stat"]);
    fireEvent.click(screen.getByRole("button", { name: "Review summary" }));
    expect(screen.getByText("Reviewer one found the dispatch race.")).toBeTruthy();

    fireEvent.click(screen.getByText("Review 2"));
    expect(await screen.findByLabelText("Reviewer report")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review summary" }));
    expect(screen.getByText("Reviewer two found the recovery gap.")).toBeTruthy();

    fireEvent.click(screen.getByText("Consolidation"));
    expect(await screen.findByLabelText("Consolidated Multi Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review summary" }));
    expect(screen.getByText("The consolidation retained both findings.")).toBeTruthy();
  });

  test("shows live fan-out reports but hides discarded session reports after a retry", async () => {
    const reviewerReport = {
      ...TEST_STRUCTURED_REVIEW_REPORT,
      reviewSummary: "This report belongs to the abandoned panel.",
    };
    const reviewer = {
      ...reviewSession,
      sessionKey: "retained-review-key",
      sdkSessionId: "retained-review-session",
      label: "Retained Review",
      reviewReport: reviewerReport,
    };
    const base = {
      ...reviewed,
      reviewers: [{ agent: "codex" as const }, { agent: "claude" as const }],
      sessions: [pipeline.sessions[0]!, reviewer, pipeline.sessions[1]!],
      currentSessionIndex: 2,
      structuredReview: undefined,
      structuredReviewRequestId: undefined,
    };

    renderTab({
      ...base,
      reviewFanout: {
        reviewers: [
          {
            id: "reviewer-1",
            agent: "codex",
            model: "gpt-5",
            status: "completed",
          },
          {
            id: "reviewer-2",
            agent: "claude",
            model: "opus",
            status: "running",
          },
        ],
      },
    });
    fireEvent.click(screen.getByText("Retained Review"));
    expect(await screen.findByLabelText("Reviewer report")).toBeTruthy();
    expect(screen.getByText(/Report ·/)).toBeTruthy();

    cleanup();
    renderTab(base);
    fireEvent.click(screen.getByText("Retained Review"));
    expect(screen.queryByLabelText("Reviewer report") === null).toBe(true);
    expect(screen.queryByLabelText("Consolidated Multi Review") === null).toBe(true);
    expect(screen.queryByText(/Report ·/) === null).toBe(true);
  });

  test("hides provisional transcript reports and shows the authoritative report once", async () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      issues: [],
      testCoverageGaps: [],
      verdict: {
        ready: "no",
        reasoning: "Review work is still in progress.",
      },
    });
    const final = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    renderTab({
      ...reviewed,
      sessions: reviewed.sessions.map((session) =>
        session.phase === "review"
          ? {
              ...session,
              messages: [
                {
                  id: "review-answer",
                  role: "assistant",
                  content: final,
                  parts: [
                    { type: "text", content: provisional },
                    {
                      type: "tool-invocation",
                      content: "git diff --stat",
                      toolName: "shell",
                      toolState: "success",
                    },
                    { type: "text", content: final },
                  ],
                },
              ],
            }
          : session,
      ),
    });

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());

    expect(screen.getAllByText("Structured review report")).toHaveLength(1);
    expect(screen.queryByText(/Ready: no/) === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["git diff --stat"]);
    // Both the provisional and the final payload are schema-shaped text, so the
    // transcript keeps only the tool activity between them.
    expect(visibleTextContents()).toEqual([]);
  });

  test("withholds a half-written report draft and keeps the reviewer's prose", async () => {
    // What a provider that answers a schema-constrained turn in the text
    // channel actually streams: prose progress, then longer and longer drafts
    // of the report. A draft validates as nothing, so no payload filter claims
    // it, and it would otherwise render as a wall of raw JSON. The review
    // prompt tells the agent this withholding happens.
    const draft = '{"reviewScope":{"targetBranch":"main","filesReviewed":["a.ts"';
    const fencedDraft = '```json\n{"issues":[{"severity":"P1",\n```';
    renderTab({
      ...reviewed,
      sessions: reviewed.sessions.map((session) =>
        session.phase === "review"
          ? {
              ...session,
              messages: [
                {
                  id: "review-answer",
                  role: "assistant",
                  content: draft,
                  parts: [
                    { type: "text", content: "Inspecting the changed files." },
                    { type: "text", content: draft },
                    {
                      type: "tool-invocation",
                      content: "git diff --stat",
                      toolName: "shell",
                      toolState: "success",
                    },
                    { type: "text", content: fencedDraft },
                    {
                      type: "text",
                      content: 'The config `{"strict":true}` is already covered.',
                    },
                  ],
                },
              ],
            }
          : session,
      ),
    });

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(screen.getByText("Inspecting the changed files.")).toBeTruthy());

    expect(visibleTextContents()).toEqual([
      "Inspecting the changed files.",
      'The config `{"strict":true}` is already covered.',
    ]);
    expect(visibleToolInvocations()).toEqual(["git diff --stat"]);
    expect(screen.queryByText(/filesReviewed/) === null).toBe(true);
  });

  test("shows only the completed turn's final verification verdict", async () => {
    const inspecting = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    const testing = JSON.stringify({
      complete: false,
      rationale: "The branch is clean; I am running tests now.",
    });
    const final = JSON.stringify({
      complete: true,
      rationale: "All acceptance criteria and validation checks passed.",
    });
    renderTab({
      ...pipeline,
      verificationResult: "pass",
      verificationFeedback: "All acceptance criteria and validation checks passed.",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: final,
              parts: [
                { type: "text", content: inspecting },
                {
                  type: "tool-invocation",
                  content: "bun test",
                  toolName: "bash",
                  toolState: "success",
                },
                { type: "text", content: testing },
                {
                  type: "tool-invocation",
                  content: "bun run build",
                  toolName: "bash",
                  toolState: "success",
                },
                { type: "text", content: final },
              ],
            },
          ],
        },
      ],
    });

    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(screen.getAllByText("Verification passed")).toHaveLength(1);
    expect(visibleToolInvocations()).toEqual(["bun test", "bun run build"]);
  });

  test("shows only an accepted final verdict extracted from concatenated progress JSON", () => {
    const prose = "Running the full validation suite.";
    const inspecting = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    const testing = JSON.stringify({
      complete: false,
      rationale: "The branch is clean; I am running tests now.",
    });
    const final = JSON.stringify({
      complete: true,
      rationale: "All acceptance criteria and validation checks passed.",
    });
    const concatenated = `${inspecting}${testing}${final}`;
    renderTab({
      ...pipeline,
      verificationResult: "pass",
      verificationFeedback: "All acceptance criteria and validation checks passed.",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          structuredResultStatus: "accepted",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: `${prose}${concatenated}`,
              parts: [
                { type: "text", content: prose },
                { type: "text", content: concatenated },
              ],
            },
          ],
        },
      ],
    });

    expect(screen.getAllByText("Verification passed")).toHaveLength(1);
    expect(screen.queryByText(final) === null).toBe(true);
    expect(visibleTextContents()).toEqual([prose, final]);
    expect(JSON.stringify(listProps.messages)).not.toContain("I am inspecting the committed diff.");
    expect(JSON.stringify(listProps.messages)).not.toContain("The branch is clean");
  });

  test("does not call a provisional running verdict a verification failure", () => {
    const inspecting = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          status: "running",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: inspecting,
              parts: [
                { type: "text", content: inspecting },
                {
                  type: "tool-invocation",
                  content: "bun test",
                  toolName: "bash",
                  toolState: "pending",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["bun test"]);
    expect(visibleTextContents()).toEqual([]);
  });

  test("shows prose updates while withholding concatenated and streaming verification JSON", () => {
    const waiting = JSON.stringify({
      complete: false,
      rationale: "The full suite is still running.",
    });
    const checking = JSON.stringify({
      complete: false,
      rationale: "Four concurrent test groups remain active.",
    });
    const streaming = '{"complete":false,"rationale":"Inspecting the last test group';
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          agent: "codex",
          status: "running",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "verification-progress",
              role: "assistant",
              content: streaming,
              parts: [
                { type: "text", content: "The full suite is still running." },
                { type: "text", content: `${waiting}${checking}` },
                {
                  type: "tool-invocation",
                  content: "bun run test",
                  toolName: "bash",
                  toolState: "pending",
                },
                { type: "text", content: streaming },
              ],
            },
          ],
        },
      ],
    });

    expect(visibleTextContents()).toEqual(["The full suite is still running."]);
    expect(visibleToolInvocations()).toEqual(["bun run test"]);
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(JSON.stringify(listProps.messages)).not.toContain("Four concurrent test groups");
    expect(JSON.stringify(listProps.messages)).not.toContain("Inspecting the last test group");
  });

  test("does not reveal an idle provisional verdict after pause or cancellation", () => {
    const provisional = JSON.stringify({
      complete: false,
      rationale: "Validation has not finished yet.",
    });
    const verification = {
      ...pipeline.sessions[1]!,
      agent: "codex" as const,
      status: "idle" as const,
      structuredResultStatus: "pending" as const,
      messages: [
        {
          id: "verification-answer",
          role: "assistant",
          content: provisional,
          parts: [
            { type: "text", content: provisional },
            {
              type: "tool-invocation",
              content: "bun test",
              toolName: "bash",
              toolState: "pending",
            },
          ],
        },
      ],
    };

    renderTab({
      ...pipeline,
      phase: "paused",
      pausedFromPhase: "verifying",
      sessions: [pipeline.sessions[0]!, verification],
    });
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["bun test"]);
    expect(visibleTextContents()).toEqual([]);

    cleanup();
    renderTab({
      ...pipeline,
      phase: "failed",
      error: "Build cancelled",
      sessions: [pipeline.sessions[0]!, verification],
    });
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(screen.getByText("Build cancelled")).toBeTruthy();
  });

  test("does not reveal a verdict while an idle session awaits structured output", () => {
    const provisional = JSON.stringify({
      complete: false,
      rationale: "The provider is still finalizing its result.",
    });
    renderTab({
      ...pipeline,
      phase: "verifying",
      sessions: [
        pipeline.sessions[0]!,
        {
          ...pipeline.sessions[1]!,
          status: "idle",
          structuredResultStatus: "pending",
          messages: [
            {
              id: "verification-answer",
              role: "assistant",
              content: provisional,
              parts: [{ type: "text", content: provisional }],
            },
          ],
        },
      ],
    });

    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(listProps.messages).toEqual([]);
  });

  test("keeps an accepted report visible on an older review stage", async () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "Still reviewing." },
    });
    const historical = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    const oldReview = {
      ...reviewSession,
      sessionKey: "old-review-key",
      sdkSessionId: "old-review-session",
      structuredRequestId: "old-review-request",
      label: "Old Review Session",
      messages: [
        {
          id: "old-review-answer",
          role: "assistant",
          content: historical,
          parts: [
            { type: "text", content: provisional },
            { type: "text", content: historical },
          ],
        },
      ],
    };
    const latestReview = {
      ...reviewSession,
      sessionKey: "latest-review-key",
      sdkSessionId: "latest-review-session",
      structuredRequestId: "latest-review-request",
      label: "Latest Review Session",
    };
    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, oldReview, latestReview, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      structuredReviewRequestId: "latest-review-request",
    });

    fireEvent.click(screen.getByText("Old Review Session"));
    await waitFor(() => expect(screen.getByText("Structured review report")).toBeTruthy());
    expect(listProps.messages[0]?.parts.map((part: { content: string }) => part.content)).toEqual([
      historical,
    ]);
    expect(screen.queryByText("Still reviewing.") === null).toBe(true);
  });

  test("reveals a legacy historical review only while the pipeline still holds its report", async () => {
    const provisional = JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      verdict: { ready: "no", reasoning: "Still reviewing." },
    });
    const historical = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    // A snapshot written before `structuredResultStatus` existed: the stage is
    // idle and the pipeline has moved on, so the fallback decides from the
    // pipeline's own bookkeeping rather than provider activity.
    const legacyReview = {
      ...reviewSession,
      structuredResultStatus: undefined,
      sessionKey: "legacy-review-key",
      sdkSessionId: "legacy-review-session",
      label: "Legacy Review Session",
      messages: [
        {
          id: "legacy-review-answer",
          role: "assistant",
          content: historical,
          parts: [
            { type: "text", content: provisional },
            { type: "text", content: historical },
          ],
        },
      ],
    };
    const latestReview = {
      ...reviewSession,
      sessionKey: "latest-review-key",
      sdkSessionId: "latest-review-session",
      structuredRequestId: "latest-review-request",
      label: "Latest Review Session",
    };

    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, legacyReview, latestReview, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      structuredReviewRequestId: "latest-review-request",
    });

    fireEvent.click(screen.getByText("Legacy Review Session"));
    await waitFor(() => expect(screen.getByText("Structured review report")).toBeTruthy());
    expect(listProps.messages[0]?.parts.map((part: { content: string }) => part.content)).toEqual([
      historical,
    ]);
    expect(screen.queryByText("Still reviewing.") === null).toBe(true);

    cleanup();
    renderTab({
      ...reviewed,
      sessions: [pipeline.sessions[0]!, legacyReview, latestReview, pipeline.sessions[1]!],
      currentSessionIndex: 3,
      // A retry deletes the accepted report before the replacement review lands,
      // so the legacy stage's last payload was never authoritative.
      structuredReview: undefined,
      structuredReviewRequestId: undefined,
    });

    fireEvent.click(screen.getByText("Legacy Review Session"));
    expect(screen.queryByText("Structured review report") === null).toBe(true);
    expect(listProps.messages).toEqual([]);
  });

  test("reveals a legacy completed verification only while the verdict is recorded", () => {
    const provisional = JSON.stringify({
      complete: false,
      rationale: "I am inspecting the committed diff.",
    });
    const final = JSON.stringify({
      complete: true,
      rationale: "All acceptance criteria and validation checks passed.",
    });
    const legacyVerify = {
      ...pipeline.sessions[1]!,
      agent: "codex" as const,
      structuredResultStatus: undefined,
      messages: [
        {
          id: "verification-answer",
          role: "assistant",
          content: final,
          parts: [
            { type: "text", content: provisional },
            {
              type: "tool-invocation",
              content: "bun test",
              toolName: "bash",
              toolState: "success",
            },
            { type: "text", content: final },
          ],
        },
      ],
    };
    const prSession = {
      phase: "pr" as const,
      iteration: 0,
      sessionKey: "pr-key",
      sdkSessionId: "pr-session",
      status: "idle" as const,
      startedAt: "2026-07-29T00:03:00.000Z",
      label: "PR Session",
      messages: [],
    };

    renderTab({
      ...pipeline,
      verificationResult: "pass",
      verificationFeedback: "All acceptance criteria and validation checks passed.",
      currentSessionIndex: 2,
      sessions: [pipeline.sessions[0]!, legacyVerify, prSession],
    });
    fireEvent.click(screen.getByText("Verification Session"));
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(screen.getAllByText("Verification passed")).toHaveLength(1);
    expect(visibleToolInvocations()).toEqual(["bun test"]);

    cleanup();
    renderTab({
      ...pipeline,
      verificationResult: undefined,
      verificationFeedback: undefined,
      currentSessionIndex: 2,
      sessions: [pipeline.sessions[0]!, legacyVerify, prSession],
    });
    fireEvent.click(screen.getByText("Verification Session"));
    expect(screen.queryByText("Verification failed") === null).toBe(true);
    expect(visibleToolInvocations()).toEqual(["bun test"]);
    expect(visibleTextContents()).toEqual([]);
  });

  test("keeps the report's sections collapsed and its JSON out of the transcript", async () => {
    renderTab(reviewed);
    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Inspect raw JSON/ }) === null).toBe(true);
    expect(screen.queryByLabelText("Raw structured review JSON") === null).toBe(true);
    expect(screen.queryByText("Updates the review workflow.") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    await waitFor(() => expect(screen.getByText("Updates the review workflow.")).toBeTruthy());
  });

  test("falls back to the newest review stage for a report with no request id", async () => {
    renderTab({
      ...reviewed,
      structuredReviewRequestId: undefined,
      sessions: reviewed.sessions.map((session) =>
        session.sessionKey === "review-key"
          ? { ...session, structuredRequestId: undefined }
          : session,
      ),
      backendRevision: 41,
    });

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("falls back to the newest review stage when the request id matches none", async () => {
    // A pipeline can outlive the session its report was requested from. The
    // report is still real, so it must land somewhere rather than vanish.
    renderTab({
      ...reviewed,
      structuredReviewRequestId: "a-request-no-session-claims",
      backendRevision: 46,
    });

    const hint = screen.getByRole("button", { name: /The review reported/ });
    expect(hint.textContent).toContain("Review Session");

    fireEvent.click(hint);
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("moves between stages with the arrow keys, as a tablist promises", async () => {
    renderTab(reviewed);
    const tablist = screen.getByRole("tablist");
    const selected = () =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent ?? null;

    expect(selected()).toContain("Verification Session");

    // `aria-orientation="vertical"` advertises Up/Down specifically.
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    await waitFor(() => expect(selected()).toContain("Review Session"));
    expect(screen.getByText("The review is complete")).toBeTruthy();

    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    await waitFor(() => expect(selected()).toContain("Verification Session"));

    fireEvent.keyDown(tablist, { key: "Home" });
    await waitFor(() => expect(selected()).toContain("Build Session"));

    fireEvent.keyDown(tablist, { key: "End" });
    await waitFor(() => expect(selected()).toContain("Verification Session"));

    // A tablist wraps rather than stopping at its ends.
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    await waitFor(() => expect(selected()).toContain("Build Session"));
  });

  test("holds the arrow-key stage the same way it holds a clicked one", async () => {
    renderTab(reviewed);
    const tablist = screen.getByRole("tablist");

    fireEvent.keyDown(tablist, { key: "Home" });
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // Selecting from the keyboard is a choice, not an auto-follow, so a later
    // backend push must not drag the user off the stage they picked.
    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...reviewed,
        currentSessionIndex: 1,
        backendRevision: 47,
      });
    });

    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(screen.queryByText("The review is complete") === null).toBe(true);
  });

  test("keeps one stage in the page tab sequence, not all of them", async () => {
    renderTab(reviewed);
    const tabStops = () =>
      screen
        .getAllByRole("tab")
        .filter((tab) => tab.getAttribute("tabindex") === "0")
        .map((tab) => tab.textContent);

    // Otherwise Tab walks every stage before reaching the transcript.
    expect(tabStops()).toEqual([expect.stringContaining("Verification Session")]);

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(tabStops()).toEqual([expect.stringContaining("Build Session")]));
  });

  test("ignores keys that mean nothing to a tablist", () => {
    renderTab(reviewed);
    const tablist = screen.getByRole("tablist");
    const selected = () =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent ?? null;

    fireEvent.keyDown(tablist, { key: "a" });
    fireEvent.keyDown(tablist, { key: "PageDown" });
    fireEvent.keyDown(tablist, { key: "Enter" });

    expect(selected()).toContain("Verification Session");
  });

  test("points at the stage holding the report while showing another", async () => {
    renderTab(reviewed);

    // The tab follows the pipeline past review, so without this nothing on
    // screen would say a review had happened at all.
    const hint = screen.getByRole("button", { name: /The review reported/ });
    expect(hint.textContent).toContain("1 issue");
    expect(hint.textContent).toContain("Review Session");

    fireEvent.click(hint);
    await waitFor(() => expect(screen.getByLabelText("Structured review report")).toBeTruthy());
    // Once the report is on screen the pointer to it is redundant.
    expect(screen.queryByRole("button", { name: /The review reported/ }) === null).toBe(true);
  });

  test("badges the stage that holds the report, and only that stage", () => {
    renderTab(reviewed);

    const badged = screen
      .getAllByRole("tab")
      .filter((tab) => tab.textContent?.includes("Report · 1 issue"))
      .map((tab) => tab.textContent);
    expect(badged).toEqual([expect.stringContaining("Review Session")]);
  });

  test("says nothing about a review for a pipeline that has not had one", () => {
    renderTab({ ...pipeline, backendRevision: 42 });

    expect(screen.queryByRole("button", { name: /The review reported/ }) === null).toBe(true);
    expect(screen.queryByText(/Report ·/) === null).toBe(true);
  });

  test("names the transcript panel after the stage whose tab is selected", async () => {
    renderTab(reviewed);
    const panel = screen.getByRole("tabpanel");
    const selectedTabId = () =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.id ??
      null;

    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTabId());

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(panel.getAttribute("aria-labelledby")).toBe(selectedTabId()));
    // Two build tabs can be mounted at once, so the ids cannot be constants.
    expect(panel.id).not.toBe("build-stage-transcript");
    expect(screen.getAllByRole("tab").every((tab) => tab.id.length > 0)).toBe(true);
  });

  test("distinguishes a running stage from a failed one in the stage list", () => {
    renderTab({
      ...reviewed,
      sessions: [
        { ...reviewed.sessions[0]!, status: "error" },
        { ...reviewed.sessions[1]!, status: "running", messages: [] },
      ],
      currentSessionIndex: 1,
      backendRevision: 43,
    });

    const [failed, running] = screen.getAllByRole("tab");
    expect(failed!.querySelector(".text-destructive")).toBeTruthy();
    expect(running!.querySelector(".animate-spin")).toBeTruthy();
    // A running stage with nothing synchronized yet says so.
    expect(screen.getByText(/This stage is running/)).toBeTruthy();
  });

  test("names the warned active stage while a historical stage is pinned", async () => {
    renderTab({
      ...reviewed,
      phase: "verifying",
      stallWarning: {
        sessionId: "verify-session",
        detectedAt: "2026-07-29T00:12:00.000Z",
      },
      backendRevision: 48,
    });

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());
    const warning = screen.getByText(/transcript has not changed/);
    expect(warning.textContent).toContain("Verification Session is still running");
    expect(warning.textContent).not.toContain("Build Session is still running");
  });

  test("keeps the stall warning off a pipeline that is no longer running", () => {
    const stalled = {
      sessionId: "verify-session",
      detectedAt: "2026-07-29T00:12:00.000Z",
    };

    // The banner asserts the stage "is still running". The backend clears the
    // warning on every terminal and paused transition, so a snapshot that still
    // carries one was written by an older build and must not make that claim.
    renderTab({ ...reviewed, phase: "paused", stallWarning: stalled, backendRevision: 54 });
    expect(screen.queryByText(/transcript has not changed/) === null).toBe(true);

    cleanup();
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "Verification crashed",
      stallWarning: stalled,
      backendRevision: 55,
    });
    expect(screen.queryByText(/transcript has not changed/) === null).toBe(true);
    expect(screen.getByText("Verification crashed")).toBeTruthy();
  });

  test("names the active stage when the warned session is not in the snapshot", () => {
    renderTab({
      ...reviewed,
      phase: "verifying",
      // A retry can replace the session list under a warning the backend has
      // not cleared yet; the banner is still true, so it must still render.
      stallWarning: {
        sessionId: "a-session-no-stage-claims",
        detectedAt: "2026-07-29T00:12:00.000Z",
      },
      backendRevision: 56,
    });

    const warning = screen.getByText(/transcript has not changed/);
    expect(warning.textContent).toContain("The active stage is still running");
  });

  test("keeps the error and offers a retry for the failed stage", async () => {
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "The prompt was never dispatched",
      failureContext: { phase: "building", kind: "prompt-dispatch", sessionId: "build-session" },
      backendRevision: 57,
    });

    // Only an interactive-request failure moves the message and the control
    // into the recovery banner; every other failure keeps both here.
    expect(screen.getAllByText("The prompt was never dispatched")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry Review" }) === null).toBe(true);
    const retry = screen.getByRole("button", { name: "Retry Build Stage" });
    expect(screen.queryByRole("button", { name: "Retry failed build phase" }) === null).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(retryStageMock).toHaveBeenCalledWith(reviewed.id));
  });

  test("shows a retry rejection and re-enables the failed-stage control", async () => {
    retryStageMock.mockRejectedValueOnce(new Error("retry command unavailable"));
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "The prompt was never dispatched",
      failureContext: { phase: "building", kind: "prompt-dispatch" },
      backendRevision: 58,
    });

    const retry = screen.getByRole("button", {
      name: "Retry Build Stage",
    }) as HTMLButtonElement;
    fireEvent.click(retry);

    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to restart the stage", {
      description: "retry command unavailable",
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Failed stage restarted");
  });

  test("reports a retry that resolves to another failed snapshot", async () => {
    const failedAgain: BuildPipeline = {
      ...reviewed,
      phase: "failed",
      error: "fresh session could not be created",
      failureContext: { phase: "building", kind: "stage-transition" },
      backendRevision: 59,
    };
    retryStageMock.mockResolvedValueOnce(failedAgain);
    renderTab({
      ...reviewed,
      phase: "failed",
      error: "The prompt was never dispatched",
      failureContext: { phase: "building", kind: "prompt-dispatch" },
      backendRevision: 58,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry Build Stage" }));

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(reviewed.id)).toEqual(failedAgain);
    });
    expect(mockToastError).toHaveBeenCalledWith("Failed to restart the stage", {
      description: "fresh session could not be created",
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Failed stage restarted");
  });

  test("labels the failed-stage retry for every resumable phase", () => {
    const cases: Array<[ResumableBuildPhase, string]> = [
      ["creating-environment", "Retry Environment Creation"],
      ["starting-environment", "Retry Environment Start"],
      ["waiting-for-setup", "Retry Setup"],
      ["building", "Retry Build Stage"],
      ["reviewing", "Retry Review Stage"],
      ["addressing", "Retry Address Stage"],
      ["verifying", "Retry Verification Stage"],
      ["fixing", "Retry Fix Stage"],
      ["creating-pr", "Retry PR Stage"],
      ["resolving-conflicts", "Retry Conflict Resolution"],
    ];
    for (const [phase, label] of cases) {
      cleanup();
      renderTab({
        ...reviewed,
        phase: "failed",
        error: "stage failed",
        failureContext: {
          phase,
          kind: "stage-transition",
          sessionId: "failed-session",
        },
        backendRevision: 60,
      });
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  test("badges no stage that declined nothing", () => {
    renderTab({
      ...pipeline,
      autoDeclineCount: 0,
      sessions: [
        { ...pipeline.sessions[0]!, autoDeclineCount: 0 },
        // Written before the counter existed, so it carries none at all.
        pipeline.sessions[1]!,
      ],
      backendRevision: 58,
    });

    expect(screen.queryByText(/input request/) === null).toBe(true);
    expect(screen.queryByText(/auto-declined/) === null).toBe(true);
  });

  test("shows singular and plural auto-decline badges and passes each stage history", async () => {
    const interaction = (id: string, title: string) => ({
      id,
      provider: "codex" as const,
      kind: "question" as const,
      phase: "build" as const,
      requestedAt: 1,
      resolvedAt: 2,
      outcome: "auto-declined-headless" as const,
      title,
      questions: [],
    });
    renderTab({
      ...pipeline,
      id: "interaction-history",
      autoDeclineCount: 3,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          autoDeclineCount: 1,
          interactionTranscript: [interaction("build-question", "Build choice")],
        },
        {
          ...pipeline.sessions[1]!,
          autoDeclineCount: 2,
          interactionTranscript: [interaction("verify-question", "Verify choice")],
        },
      ],
      currentSessionIndex: 1,
      backendRevision: 49,
    });

    const [buildTab, verifyTab] = screen.getAllByRole("tab");
    expect(buildTab!.textContent).toContain("1 input request auto-declined");
    expect(verifyTab!.textContent).toContain("2 input requests auto-declined");
    expect(screen.getByText(/3 unattended input requests were auto-declined/)).toBeTruthy();
    expect(screen.getByText(/Verify choice/)).toBeTruthy();

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.getByText(/Build choice/)).toBeTruthy());
    expect(screen.queryByText(/Verify choice/) === null).toBe(true);
  });
});

describe("BuildChatTab transcript wiring", () => {
  beforeEach(() => {
    cleanup();
    listProps = null;
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
    });
    useEnvironmentStore.setState({
      environments: [{ id: "env-1", containerId: "container-1" }],
    } as never);
  });

  afterAll(() => {
    useEnvironmentStore.setState({ environments: [] } as never);
  });

  function renderTab(props: { isActive?: boolean; ownsGlobalShortcuts?: boolean } = {}) {
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
        {...props}
      />,
    );
  }

  test("keys each row on its message id so a re-render does not remount it", () => {
    renderTab();

    expect(listProps.messages.map((message: { id: string }) => message.id)).toEqual(["answer-2"]);
    expect(listProps.computeItemKey(0, listProps.messages[0])).toBe("answer-2");
  });

  test("resolves each row's predecessor past empty assistant placeholders", () => {
    renderTab();

    // Without this the transcript would anchor attribution and duration on an
    // info-only placeholder instead of the message that produced the content.
    expect(listProps.resolvePreviousMessage).toBe(findPreviousNativeMessage);

    const messages = [
      { id: "u", role: "user", content: "Q", createdAt: "2026-03-21T10:00:00.000Z", parts: [] },
      {
        id: "empty",
        role: "assistant",
        content: "",
        createdAt: "2026-03-21T10:00:10.000Z",
        parts: [],
      },
      {
        id: "answer",
        role: "assistant",
        content: "A",
        createdAt: "2026-03-21T10:00:20.000Z",
        parts: [{ type: "text", content: "A" }],
      },
    ];
    expect(listProps.resolvePreviousMessage(messages, 2)).toBe(messages[0]);
  });

  test("claims the find shortcut only while its pane owns the keyboard", () => {
    // `useAgentChatFind` binds Cmd+F on the document, so a split layout would
    // otherwise open two find bars from one keystroke.
    renderTab({ isActive: true, ownsGlobalShortcuts: false });
    expect(listProps.find.isActive).toBe(false);
    expect(typeof listProps.find.getSearchText).toBe("function");

    cleanup();
    renderTab({ isActive: true, ownsGlobalShortcuts: true });
    expect(listProps.find.isActive).toBe(true);
  });

  test("defaults shortcut ownership to visibility for a caller that omits it", () => {
    renderTab({ isActive: true });
    expect(listProps.find.isActive).toBe(true);
  });

  test("gives every row the agent's label and the environment's container", () => {
    renderTab();

    // Images the agent wrote inside a Dockerised environment are readable only
    // through its container.
    const row = listProps.renderMessage(0, listProps.messages[0], null);
    expect(row.props).toMatchObject({
      assistantLabel: "Codex",
      containerId: "container-1",
    });
  });

  test("renders rows without a container when the environment is not known yet", () => {
    // A local environment has no container, and a Dockerised one is absent from
    // the store until it has been hydrated. Passing `null` through would make
    // the renderer try to read files out of a container called "null".
    useEnvironmentStore.setState({ environments: [] } as never);
    renderTab();

    const row = listProps.renderMessage(0, listProps.messages[0], null);
    expect(row.props.containerId).toBeUndefined();
    expect(row.props.assistantLabel).toBe("Codex");
  });

  test("uses each provider's own name on its rows", () => {
    for (const [agentType, label] of [
      ["claude", "Claude"],
      ["opencode", "OpenCode"],
    ] as const) {
      cleanup();
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        agentType,
        backendRevision: 44 + label.length,
      });
      renderTab();

      const row = listProps.renderMessage(0, listProps.messages[0], null);
      expect(row.props.assistantLabel).toBe(label);
    }
  });
});

describe("BuildChatTab per-step harnesses", () => {
  /**
   * A Codex turn that delegated to a subagent.
   *
   * `subagent` is one of the part types the Claude adapter drops, so decoding
   * this through the pipeline's build agent rather than the session's own would
   * silently lose the delegation entirely.
   */
  const codexReview: BuildPipeline["sessions"][number] = {
    phase: "review",
    agent: "codex",
    iteration: 0,
    sessionKey: "codex-review-key",
    sdkSessionId: "codex-review-session",
    status: "idle",
    startedAt: "2026-07-29T00:02:00.000Z",
    label: "Codex Review Session",
    messages: [
      {
        id: "codex-review-answer",
        role: "assistant",
        parts: [
          { type: "text", content: "Reviewed the diff" },
          {
            type: "subagent",
            content: "diff-auditor",
            subagentId: "sub-1",
            subagentName: "diff-auditor",
            subagentActions: [],
          },
        ],
      },
    ],
  };

  /**
   * A Claude turn whose child tool is grouped under the Task that spawned it.
   *
   * Only the Claude adapter performs that grouping, so this stage tells the two
   * decoders apart in the opposite direction from the Codex one.
   */
  const claudeBuild: BuildPipeline["sessions"][number] = {
    phase: "build",
    agent: "claude",
    iteration: 0,
    sessionKey: "claude-build-key",
    sdkSessionId: "claude-build-session",
    status: "idle",
    startedAt: "2026-07-29T00:00:00.000Z",
    label: "Claude Build Session",
    messages: [
      {
        id: "claude-build-answer",
        role: "assistant",
        content: "",
        timestamp: "2026-07-29T00:00:10.000Z",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Task",
            toolUseId: "task-1",
            toolArgs: { description: "Audit the diff" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            parentTaskUseId: "task-1",
            toolArgs: { command: "git diff" },
          },
        ],
      },
    ],
  };

  // The build ran on Claude; the launcher configured the review step on Codex,
  // so `agentType` describes only the build stage.
  const mixed: BuildPipeline = {
    ...pipeline,
    id: "mixed",
    agentType: "claude",
    steps: { build: { agent: "claude" }, review: { agent: "codex" } },
    sessions: [claudeBuild, codexReview],
    currentSessionIndex: 1,
    backendRevision: 60,
  };

  function renderTab(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: next.id,
          environmentId: next.environmentId,
          taskId: next.taskId,
          isLocal: true,
        }}
      />,
    );
  }

  function partTypes(): string[] {
    return (listProps.messages as Array<{ parts: Array<{ type: string }> }>).flatMap((message) =>
      message.parts.map((part) => part.type),
    );
  }

  beforeEach(() => {
    cleanup();
    listProps = null;
  });

  test("decodes a Codex stage with the Codex adapter on a Claude-built pipeline", () => {
    renderTab(mixed);

    // Decoded through the pipeline's `agentType` the subagent part would be
    // filtered out by the Claude adapter, and the delegation would vanish.
    expect(partTypes()).toEqual(["text", "subagent"]);
    expect(screen.getByText("diff-auditor")).toBeTruthy();
    expect(screen.getByText("Reviewed the diff")).toBeTruthy();
  });

  test("names the harness of the stage on screen, not the build agent", async () => {
    renderTab(mixed);

    // The status line and the transcript's assistant label both describe the
    // session being read, which per-step configuration makes different from the
    // pipeline's build agent.
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.queryByText("claude") === null).toBe(true);
    expect(listProps.renderMessage(0, listProps.messages[0], null).props).toMatchObject({
      assistantLabel: "Codex",
    });

    fireEvent.click(screen.getByText("Claude Build Session"));
    await waitFor(() => expect(screen.getByText("claude")).toBeTruthy());
    expect(screen.queryByText("codex") === null).toBe(true);
    expect(listProps.renderMessage(0, listProps.messages[0], null).props).toMatchObject({
      assistantLabel: "Claude",
    });
  });

  test("re-decodes with the right adapter each time the stage changes", async () => {
    renderTab(mixed);
    expect(partTypes()).toEqual(["text", "subagent"]);

    // Only the Claude adapter groups a child tool under its Task.
    fireEvent.click(screen.getByText("Claude Build Session"));
    await waitFor(() => expect(partTypes()).toEqual(["task-group"]));

    // And switching back must not leave the Claude decoder in place.
    fireEvent.click(screen.getByText("Codex Review Session"));
    await waitFor(() => expect(partTypes()).toEqual(["text", "subagent"]));
  });

  test("falls back to the build agent for a stage recorded before per-step harnesses", () => {
    const { agent: _agent, ...legacySession } = codexReview;
    renderTab({
      ...pipeline,
      id: "legacy",
      agentType: "opencode",
      sessions: [legacySession],
      currentSessionIndex: 0,
      backendRevision: 61,
    });

    // A snapshot written before sessions recorded their harness still renders:
    // `agentType` is the only answer available, and no answer at all would blank
    // the transcript.
    expect(partTypes()).toEqual(["text", "subagent"]);
    expect(screen.getByText("Reviewed the diff")).toBeTruthy();
    expect(screen.getByText("opencode")).toBeTruthy();
    expect(listProps.renderMessage(0, listProps.messages[0], null).props).toMatchObject({
      assistantLabel: "OpenCode",
    });
  });
});

describe("BuildChatTab rehydration", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineConditionalMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("fetches the authoritative snapshot when the store has none", async () => {
    // App hydrates pipelines once per project. If that never ran for this
    // project or failed, the tab would otherwise sit on its loading state
    // forever with no way back — the rehydrate-on-mount invariant.
    getBuildPipelineConditionalMock.mockImplementation(async () => ({
      version: 2,
      id: pipeline.id,
      projectId: pipeline.projectId,
      environmentId: pipeline.environmentId,
      snapshot: pipeline,
      revision: 8,
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));

    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Backend-owned build")).toBeTruthy();
    });
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledWith(pipeline.id, undefined, undefined);
  });

  test("does not refetch in a loop when the pipeline genuinely does not exist", async () => {
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: "missing",
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    await waitFor(() => expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
  });

  test("warns once when hydration rejects and does not retry on store changes", async () => {
    const hydrationError = new Error("snapshot unavailable");
    const warnMock = mock(() => {});
    const realWarn = console.warn;
    console.warn = warnMock;
    getBuildPipelineConditionalMock.mockRejectedValueOnce(hydrationError);

    try {
      render(
        <BuildChatTab
          data={{
            environmentId: "env-1",
            pipelineId: pipeline.id,
            taskId: "task-1",
            isLocal: true,
          }}
        />,
      );

      await waitFor(() => {
        expect(warnMock).toHaveBeenCalledWith(
          "[BuildChatTab] Failed to hydrate build pipeline:",
          hydrationError,
        );
      });

      // Make the effect observe both a present and then absent snapshot. The
      // per-pipeline attempt guard must still prevent a second backend read.
      act(() => {
        useBuildPipelineStore.getState().replacePipeline(pipeline);
      });
      act(() => {
        useBuildPipelineStore.setState({
          pipelines: new Map(),
          buildEnvironmentIds: new Set(),
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = realWarn;
    }
  });

  test("does not fetch when the store already has the snapshot", async () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    expect(screen.getByText("Backend-owned build")).toBeTruthy();
    expect(getBuildPipelineConditionalMock).not.toHaveBeenCalled();
  });
});

describe("BuildChatTab stage following", () => {
  function renderWith(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
  }

  beforeEach(() => {
    cleanup();
    renderWith(pipeline);
  });

  test("follows the pipeline to each new stage until the user picks one", async () => {
    const building: BuildPipeline = {
      ...pipeline,
      phase: "building",
      sessions: [pipeline.sessions[0]!],
      currentSessionIndex: 0,
    };
    renderWith(building);
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    expect(screen.getByText("Implementation complete")).toBeTruthy();

    // The backend advances to the verification stage.
    renderWith({ ...pipeline, phase: "verifying" });

    await waitFor(() => {
      expect(screen.getByText("All criteria pass")).toBeTruthy();
    });
  });

  test("holds a stage the user selected even as the pipeline advances", async () => {
    renderWith({ ...pipeline, phase: "verifying" });
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A new snapshot arrives; the explicit choice must survive it.
    renderWith({ ...pipeline, phase: "complete", backendRevision: 20 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("resumes following when the selected stage leaves the snapshot", async () => {
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A retry replaced the session list; the pinned id no longer exists, so
    // holding it would leave the transcript permanently blank.
    renderWith({
      ...pipeline,
      sessions: [pipeline.sessions[1]!],
      currentSessionIndex: 0,
      backendRevision: 30,
    });

    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());
  });
});

describe("BuildChatTab agent messaging", () => {
  const running: BuildPipeline = { ...pipeline, phase: "building" };

  beforeEach(() => {
    cleanup();
    sendMessageMock.mockClear();
    retryReviewMock.mockClear();
    retryStageMock.mockClear();
    mockToastError.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, running]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
  });

  function renderTab() {
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: running.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
  }

  test("queues a message through the backend and clears the box", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "  also update the README  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(running.id, "also update the README"),
    );
    await waitFor(() => expect(box.value).toBe(""));
    // The authoritative reply is installed, so the queue depth is visible.
    await waitFor(() => expect(screen.getByText(/1 message queued/)).toBeTruthy());
  });

  test("renders a compact ArrowUp send control", () => {
    renderTab();
    const button = screen.getByRole("button", { name: "Send message" });

    expect(button.getAttribute("data-size")).toBe("icon");
    expect(button.className).toContain("h-7");
    expect(button.className).toContain("w-7");
    expect(button.className).toContain("rounded-lg");
    expect(button.querySelector(".lucide-arrow-up")).toBeTruthy();
  });

  test("submits on Enter and inserts a newline on Shift+Enter", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    fireEvent.change(box, { target: { value: "ship it" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith(running.id, "ship it"));
  });

  test("does not queue the same text twice from a second Enter", async () => {
    let release: (() => void) | undefined;
    sendMessageMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [],
        backendRevision: 53,
      };
    });
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    fireEvent.change(box, { target: { value: "ship it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // The send button disables itself, but the textarea stays focusable and
    // enabled — Enter is the path with no visible guard on it.
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("caps the draft at the length the backend will accept", () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    // Truncating in the browser beats a rejected round trip that loses the text.
    expect(box.getAttribute("maxlength")).toBe(String(MAX_PIPELINE_USER_MESSAGE_LENGTH));
  });

  test("keeps the draft when the backend refuses the message", async () => {
    sendMessageMock.mockImplementationOnce(async () => {
      throw new Error("queue is full");
    });
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "do not lose me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith("Failed to send the message", {
      description: "queue is full",
    });
    // Losing the user's typing on a transient failure is worse than the failure.
    expect(box.value).toBe("do not lose me");
  });

  test("formats a non-Error message rejection in the failure toast", async () => {
    sendMessageMock.mockRejectedValueOnce("queue disconnected");
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to send the message", {
        description: "queue disconnected",
      });
    });
    expect(box.value).toBe("keep this draft");
  });

  test("refuses to send an empty or whitespace-only message", () => {
    renderTab();
    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Send a message to the agent"), {
      target: { value: "   " },
    });
    expect(button.disabled).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("hides the compose box once the build has finished", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
  });

  test("hides the compose box while multi-model review owns the phase", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          running.id,
          {
            ...running,
            phase: "reviewing",
            reviewers: [
              { agent: "claude", model: "opus" },
              { agent: "codex", model: "gpt-5.6" },
            ],
          },
        ],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
  });

  test("keeps the compose box hidden when multi-model review is paused", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          running.id,
          {
            ...running,
            phase: "paused",
            pausedFromPhase: "reviewing",
            reviewers: [
              { agent: "claude", model: "opus" },
              { agent: "codex", model: "gpt-5.6" },
            ],
          },
        ],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
  });

  test("restarts the review through the backend", async () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /Retry Review/ }));

    await waitFor(() => expect(retryReviewMock).toHaveBeenCalledWith(running.id));
    await waitFor(() =>
      expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase).toBe("reviewing"),
    );
  });

  test("reports a queue of more than one message as a queue", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      pendingUserMessages: [
        { id: "q1", text: "one", createdAt: "2026-07-29T00:02:00.000Z" },
        { id: "q2", text: "two", createdAt: "2026-07-29T00:03:00.000Z" },
      ],
      backendRevision: 50,
    });
    renderTab();

    expect(screen.getByText(/2 messages queued/)).toBeTruthy();
    expect(screen.queryByText(/1 message queued/) === null).toBe(true);
  });

  test("disables the send button and shows progress while a send is in flight", async () => {
    let release: (() => void) | undefined;
    sendMessageMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [],
        backendRevision: 51,
      };
    });
    renderTab();
    fireEvent.change(screen.getByLabelText("Send a message to the agent"), {
      target: { value: "hold on" },
    });

    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    // A second click would queue the same text twice.
    expect(button.disabled).toBe(true);
    const spinner = button.querySelector(".lucide-loader-circle");
    expect(spinner).toBeTruthy();
    expect(spinner?.classList.contains("h-3.5")).toBe(true);
    expect(spinner?.classList.contains("w-3.5")).toBe(true);
    expect(spinner?.classList.contains("animate-spin")).toBe(true);
    expect(button.querySelector(".lucide-arrow-up") === null).toBe(true);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(button.querySelector(".animate-spin") === null).toBe(true);
    expect(button.querySelector(".lucide-arrow-up")).toBeTruthy();
  });

  test("re-enables the retry control when the backend refuses a review restart", async () => {
    retryReviewMock.mockRejectedValueOnce(new Error("no review stage"));
    renderTab();

    const retry = screen.getByRole("button", {
      name: /Retry Review/,
    }) as HTMLButtonElement;
    fireEvent.click(retry);

    await waitFor(() => expect(retryReviewMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to restart the review", {
      description: "no review stage",
    });
    expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase).toBe("building");
  });

  test("formats a non-Error review restart rejection", async () => {
    retryReviewMock.mockRejectedValueOnce("review provider offline");
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /Retry Review/ }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to restart the review", {
        description: "review provider offline",
      });
    });
    expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase).toBe("building");
  });

  test("follows the restarted review instead of the stage the user was reading", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A retry appends a new stage. Holding the pinned one would leave the user
    // watching a transcript that has stopped moving.
    retryReviewMock.mockImplementationOnce(async (pipelineId: string) => {
      const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      return {
        ...current,
        phase: "reviewing" as const,
        sessions: [
          ...current.sessions,
          {
            phase: "review" as const,
            iteration: 1,
            sessionKey: "retry-key",
            sdkSessionId: "retry-session",
            status: "idle" as const,
            startedAt: "2026-07-29T00:05:00.000Z",
            label: "Retry Review Session",
            messages: [
              {
                id: "retry-answer",
                role: "assistant",
                content: "Reviewing again",
              },
            ],
          },
        ],
        currentSessionIndex: current.sessions.length,
        backendRevision: 52,
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /Retry Review/ }));

    await waitFor(() => expect(screen.getByText("Reviewing again")).toBeTruthy());
  });

  test("does not offer a review retry before the first stage exists", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          running.id,
          {
            ...running,
            sessions: [],
            currentSessionIndex: -1,
          },
        ],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByRole("button", { name: /Retry Review/ }) === null).toBe(true);
  });
});
