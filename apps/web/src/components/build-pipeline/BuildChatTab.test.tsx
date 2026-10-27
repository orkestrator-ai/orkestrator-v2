import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { setMobileViewport } from "../../../../../tests/mocks/match-media";
import {
  BuildChatTab,
  showInspectorTab,
  tabData,
  cancelBuildPipelineMock,
  getBuildPipelineConditionalMock,
  graphNode,
  headerText,
  inspector,
  nodeTitles,
  pauseBuildPipelineMock,
  pipeline,
  queryGraphNode,
  restartCurrentStepMock,
  restartStepMock,
  restoreBuildChatTabMocks,
  resumeBuildPipelineMock,
  retryInteractionFailureMock,
  retryStageMock,
  selectNode,
  selectedTitle,
  sendMessageMock,
  stopReviewValidationCommandMock,
  validationResult,
  validationRun,
} from "./build-chat-tab-test-support";

/**
 * The build tab against backend-owned snapshots: controls, validation, loading.
 */

afterAll(restoreBuildChatTabMocks);

describe("BuildChatTab backend projection", () => {
  beforeEach(() => {
    cleanup();
    pauseBuildPipelineMock.mockClear();
    resumeBuildPipelineMock.mockClear();
    cancelBuildPipelineMock.mockClear();
    sendMessageMock.mockClear();
    restartCurrentStepMock.mockClear();
    retryStageMock.mockClear();
    restartStepMock.mockClear();
    retryInteractionFailureMock.mockClear();
    stopReviewValidationCommandMock.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineConditionalMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
      viewedSessionIds: new Map(),
    });
  });

  test("renders the same backend sessions and transcripts for every client", () => {
    render(
      <BuildChatTab
        isActive
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
      />,
    );

    expect(headerText("Backend-owned build")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    selectNode("Build");
    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(useBuildPipelineStore.getState().viewedSessionIds.get(pipeline.id)).toBe(
      "build-session",
    );
  });

  test("offers restart from a graph node's context menu", async () => {
    render(<BuildChatTab data={tabData} />);

    fireEvent.contextMenu(graphNode("Build"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart from here" }));

    await waitFor(() => expect(restartStepMock).toHaveBeenCalledWith(pipeline.id, "build-session"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Stage restarted");
  });

  test("offers validation restart from a touch long press", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      validationRun: validationRun({ id: "validation-long-press" }),
    });
    render(<BuildChatTab data={tabData} />);

    fireEvent.pointerDown(graphNode("Prepare"), {
      pointerType: "touch",
      pointerId: 71,
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    await act(async () => {
      await Bun.sleep(710);
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart validation" }));

    await waitFor(() =>
      expect(restartStepMock).toHaveBeenCalledWith(pipeline.id, "validation:validation-long-press"),
    );
  });

  test("renders loading and not-yet-started states from incomplete snapshots", () => {
    useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
    const { rerender } = render(<BuildChatTab data={{ ...tabData, pipelineId: "missing" }} />);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();

    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "empty",
      phase: "building",
      sessions: [],
      currentSessionIndex: -1,
      backendRevision: 9,
    });
    rerender(<BuildChatTab data={{ ...tabData, pipelineId: "empty" }} />);
    // Nothing has run yet, so every step ahead is a placeholder.
    expect(nodeTitles()).toEqual(["Ticket", "Setup", "Build", "Review", "Verify", "Ship", "PR"]);
    expect(graphNode("Build").hasAttribute("data-flow-placeholder")).toBe(true);
    expect(selectedTitle()).toBe("Setup");
    expect(within(inspector()).getByText("Local worktree")).toBeTruthy();
  });

  test("advances the live validation clock while the build tab is active", () => {
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    let now = Date.parse("2026-09-08T20:00:10.000Z");
    let tick: (() => void) | undefined;
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void;
      return 44;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => undefined) as typeof window.clearInterval;
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      validationRun: validationRun({
        status: "running",
        completedAt: undefined,
        results: [
          {
            ...validationResult("passed"),
            status: "running",
            exitCode: null,
            startedAt: "2026-09-08T20:00:05.000Z",
          },
        ],
      }),
    });

    const view = render(<BuildChatTab data={tabData} isActive />);
    try {
      selectNode("Prepare");
      expect(screen.getByText(/Validation: 6\.0s\./)).toBeTruthy();
      now = Date.parse("2026-09-08T20:00:13.000Z");
      act(() => tick?.());
      expect(screen.getByText(/Validation: 9\.0s\./)).toBeTruthy();
    } finally {
      view.unmount();
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("shows backend tests on the package preparation between build and the reviews", () => {
    const packageSession: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "fix",
      sessionKey: "package-key",
      sdkSessionId: "package-session",
      label: REVIEW_PACKAGE_SESSION_LABEL,
    };
    const reviewOne: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "review",
      sessionKey: "review-1-key",
      sdkSessionId: "review-1-session",
      label: "Review 1",
    };
    const reviewTwo: BuildPipeline["sessions"][number] = {
      ...reviewOne,
      sessionKey: "review-2-key",
      sdkSessionId: "review-2-session",
      label: "Review 2",
    };
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "reviewing",
      sessions: [pipeline.sessions[0]!, packageSession, reviewOne, reviewTwo],
      currentSessionIndex: 3,
      validationRun: validationRun({ id: "validation-ordered" }),
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    expect(nodeTitles().slice(0, 6)).toEqual([
      "Ticket",
      "Setup",
      "Build",
      "Prepare",
      "Reviewer 1",
      "Reviewer 2",
    ]);
    expect(
      graphNode("Prepare").querySelector('[data-validation-status="passed"]')?.textContent,
    ).toBe("test");

    selectNode("Prepare");
    expect(screen.queryByLabelText("Review validation") === null).toBe(true);
    showInspectorTab("Tests");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
    expect(screen.getByText("mise run test")).toBeTruthy();
    // The transcript stays mounted behind the tests.
    expect(screen.getByText("Implementation complete").closest("[hidden]")).toBeTruthy();
  });

  test("stops one running validation command from the Prepare node", async () => {
    const run = validationRun({
      id: "validation-stop-one",
      status: "running",
      completedAt: undefined,
      results: [
        {
          ...validationResult("passed"),
          status: "running",
          exitCode: null,
          startedAt: "2026-09-08T20:00:05.000Z",
        },
      ],
    });
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      validationRun: run,
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    selectNode("Prepare");
    fireEvent.click(screen.getByRole("button", { name: "Stop mise run test" }));

    await waitFor(() => expect(stopReviewValidationCommandMock).toHaveBeenCalledTimes(1));
    expect(stopReviewValidationCommandMock).toHaveBeenCalledWith(
      pipeline.environmentId,
      run,
      "test",
    );
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test.each([
    ["failed", validationResult("failed", 1)],
    [
      "incomplete",
      { ...validationResult("incomplete", null), limitation: "Host capacity wait timed out" },
    ],
    ["skipped", validationResult("skipped", 0)],
  ] as const)("shows a %s command on the Prepare node's checks", (status, result) => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      validationRun: validationRun({ results: [result] }),
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    const chip = graphNode("Prepare").querySelector("[data-validation-status]")!;
    expect(chip.getAttribute("data-validation-status")).toBe(status);
    // Checks that did not pass are evidence for the review, not a failed step.
    expect(graphNode("Prepare").getAttribute("data-flow-state")).toBe("complete");
  });

  test("marks a run-level validation fault as a failed Prepare node with its error", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      validationRun: validationRun({ status: "failed", error: "HEAD moved during validation" }),
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    const node = graphNode("Prepare");
    expect(node.getAttribute("data-flow-state")).toBe("failed");
    expect(node.querySelector("[data-flow-node-error]")?.textContent).toBe(
      "HEAD moved during validation",
    );
  });

  test("marks a cancelled validation run as stopped, not failed", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      validationRun: validationRun({ status: "cancelled" }),
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    expect(graphNode("Prepare").getAttribute("data-flow-state")).toBe("cancelled");
  });

  test("puts the Prepare node before the first review when no preparation session exists", () => {
    const reviewOne: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "review",
      sessionKey: "review-1-key",
      sdkSessionId: "review-1-session",
      label: "Review 1",
    };
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "reviewing",
      sessions: [pipeline.sessions[0]!, reviewOne, pipeline.sessions[1]!],
      currentSessionIndex: 2,
      validationRun: validationRun({ id: "validation-fallback" }),
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    expect(nodeTitles().slice(2, 6)).toEqual(["Build", "Prepare", "Reviewer 1", "Verify"]);
  });

  test("puts the Prepare node after a reused build session that produced the package plan", () => {
    const preparedBuild: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      producedReviewPackagePlan: true,
    };
    const reviewOne: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "review",
      sessionKey: "review-1-key",
      sdkSessionId: "review-1-session",
      label: "Review 1",
    };
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "reviewing",
      sessions: [preparedBuild, reviewOne],
      currentSessionIndex: 1,
      validationRun: validationRun({ id: "validation-reused" }),
      backendRevision: 9,
    });
    render(<BuildChatTab data={tabData} />);

    expect(nodeTitles().slice(2, 5)).toEqual(["Build", "Prepare", "Reviewer 1"]);
  });

  test("follows the package preparation, with its tests beside its transcript", () => {
    const packageSession: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "fix",
      sessionKey: "package-key",
      sdkSessionId: "package-session",
      label: REVIEW_PACKAGE_SESSION_LABEL,
    };
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          pipeline.id,
          {
            ...pipeline,
            phase: "fixing",
            sessions: [pipeline.sessions[0]!, packageSession],
            currentSessionIndex: 1,
            validationRun: validationRun({ id: "validation-follow" }),
            backendRevision: 9,
          },
        ],
      ]),
      viewedSessionIds: new Map(),
    });
    render(<BuildChatTab data={tabData} />);

    expect(selectedTitle()).toBe("Prepare");
    showInspectorTab("Tests");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
  });

  test("releases a pinned validation node when the validation run is removed", async () => {
    const withRun: BuildPipeline = {
      ...pipeline,
      phase: "reviewing",
      validationRun: validationRun({ id: "validation-pin" }),
      backendRevision: 9,
    };
    useBuildPipelineStore.getState().replacePipeline(withRun);
    render(<BuildChatTab data={tabData} />);

    selectNode("Prepare");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();

    act(() => {
      const next = { ...withRun, backendRevision: 10 };
      delete next.validationRun;
      useBuildPipelineStore.getState().replacePipeline(next);
    });

    await waitFor(() => expect(queryGraphNode("Prepare")).toBeNull());
    expect(selectedTitle()).toBe("Verify");
  });

  test("keeps the Prepare node and its tests selected when the run is replaced", async () => {
    const packageSession: BuildPipeline["sessions"][number] = {
      ...pipeline.sessions[0]!,
      phase: "fix",
      sessionKey: "package-key",
      sdkSessionId: "package-session",
      label: REVIEW_PACKAGE_SESSION_LABEL,
    };
    const withRun: BuildPipeline = {
      ...pipeline,
      phase: "fixing",
      sessions: [pipeline.sessions[0]!, packageSession],
      currentSessionIndex: 1,
      validationRun: validationRun({ id: "validation-old" }),
      backendRevision: 9,
    };
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, withRun]]),
      viewedSessionIds: new Map(),
    });
    render(<BuildChatTab data={tabData} />);

    selectNode("Build");
    selectNode("Prepare");
    showInspectorTab("Tests");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();

    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...withRun,
        validationRun: validationRun({ id: "validation-new", status: "running" }),
        backendRevision: 10,
      });
    });

    await waitFor(() => expect(selectedTitle()).toBe("Prepare"));
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
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
    render(<BuildChatTab data={{ ...tabData, pipelineId: "malformed" }} />);

    expect(screen.getAllByText("Verification crashed").length).toBeGreaterThan(0);
    expect(graphNode("Build").getAttribute("data-flow-state")).toBe("failed");
    // The two records carry nothing a display row has, so one notice says they
    // were not shown rather than the stage claiming it produced nothing.
    expect(
      screen.getByText(/^2 transcript entries not shown: they are in a format this app does not/),
    ).toBeTruthy();
    expect(screen.queryByText("No text transcript was produced for this stage.") === null).toBe(
      true,
    );
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

      fireEvent.click(screen.getByRole("button", { name: "Restart Build Stage" }));
      await waitFor(() => expect(restartCurrentStepMock).toHaveBeenCalledWith(pipeline.id));
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

    // One banner carries the message and the retry; the failed node keeps its
    // own copy, as every failed node does.
    expect(
      screen
        .getAllByText("Unexpected authorization")
        .filter((element) => element.closest('[role="alert"]')),
    ).toHaveLength(1);
    expect(
      within(screen.getByTestId("build-pipeline-header")).queryByRole("button", {
        name: /^Restart/,
      }) === null,
    ).toBe(true);
    const retry = screen.getByRole("button", { name: "Retry failed build phase" });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(retryInteractionFailureMock).toHaveBeenCalledWith(pipeline.id);
      expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe("building");
    });
  });
});
