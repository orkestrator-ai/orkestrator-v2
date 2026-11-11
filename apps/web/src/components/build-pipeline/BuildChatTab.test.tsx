import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { setMobileViewport } from "../../../../../tests/mocks/match-media";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
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
  skipStepMock,
  stopReviewValidationCommandMock,
  validationResult,
  validationRun,
  cleanupBuildChatScope,
  pipelineStore,
  renderInBuildChat,
} from "./build-chat-tab-test-support";

/**
 * The build tab against backend-owned snapshots: controls, validation, loading.
 */

afterAll(restoreBuildChatTabMocks);
afterEach(cleanupBuildChatScope);

/** Radix ContextMenu opens on a touch hold after this fixed, unexported delay. */
const RADIX_CONTEXT_MENU_LONG_PRESS_MS = 700;

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
    skipStepMock.mockClear();
    retryInteractionFailureMock.mockClear();
    stopReviewValidationCommandMock.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineConditionalMock.mockImplementation(async () => null);
    pipelineStore().setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
      viewedSessionIds: new Map(),
    });
  });

  test("renders the same backend sessions and transcripts for every client", () => {
    renderInBuildChat(
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
    selectNode("Verify");
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    selectNode("Build");
    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(pipelineStore().getState().viewedSessionIds.get(pipeline.id)).toBe("build-session");
  });

  test("offers restart from a graph node's context menu", async () => {
    renderInBuildChat(<BuildChatTab data={tabData} />);

    fireEvent.contextMenu(graphNode("Build"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart from here" }));

    await waitFor(() => expect(restartStepMock).toHaveBeenCalledWith(pipeline.id, "build-session"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Stage restarted");
  });

  test.each(["Build", "Reviewer 1", "Consolidation"])(
    "restarts %s with a changed provider, model, effort and speed",
    async (title) => {
      const phase = title === "Build" ? "build" : "review";
      const label = title === "Reviewer 1" ? "Review 1" : title;
      pipelineStore()
        .getState()
        .replacePipeline({
          ...pipeline,
          reviewers: [
            { agent: "claude", model: "opus" },
            { agent: "codex", model: "gpt-test" },
          ],
          sessions: [
            { ...pipeline.sessions[0]!, phase, label, agent: "opencode", model: "old-model" },
          ],
          currentSessionIndex: 0,
        });
      renderInBuildChat(<BuildChatTab data={tabData} />);

      fireEvent.contextMenu(graphNode(title));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Restart in…" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("heading", { name: `Restart ${title}` })).toBeTruthy();
      const picker = within(dialog).getByRole("combobox");
      fireEvent.pointerDown(picker);
      fireEvent.click(screen.getByRole("button", { name: "codex models" }));
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.pointerDown(picker);
      fireEvent.click(
        within(screen.getByRole("group", { name: "Speed mode" })).getByRole("menuitemradio", {
          name: /Fast/,
        }),
      );
      fireEvent.click(
        within(screen.getByRole("group", { name: "Reasoning" })).getByRole("menuitemradio", {
          name: "High",
        }),
      );
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.click(within(dialog).getByRole("button", { name: `Restart ${title}` }));
      await waitFor(() =>
        expect(restartStepMock).toHaveBeenCalledWith(
          pipeline.id,
          "build-session",
          expect.objectContaining({
            agent: "codex",
            model: expect.any(String),
            reasoningEffort: "high",
            fastMode: true,
          }),
        ),
      );
      await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
      expect(mockToastSuccess).toHaveBeenCalledWith("Stage restarted");
    },
  );

  test("keeps the Restart in dialog open with the reason when the restart is refused", async () => {
    restartStepMock.mockImplementationOnce(async () => {
      throw new Error("This build's pull request has been merged.");
    });
    renderInBuildChat(<BuildChatTab data={tabData} />);

    fireEvent.contextMenu(graphNode("Build"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart in…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart Build" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "pull request has been merged",
    );
  });

  test("offers validation restart from a touch long press", async () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        validationRun: validationRun({ id: "validation-long-press" }),
      });
    const longPress = installControlledTimeout(RADIX_CONTEXT_MENU_LONG_PRESS_MS, {
      label: "context-menu long press",
    });
    try {
      renderInBuildChat(<BuildChatTab data={tabData} />);

      fireEvent.pointerDown(graphNode("Prepare"), {
        pointerType: "touch",
        pointerId: 71,
        isPrimary: true,
        button: 0,
        clientX: 20,
        clientY: 20,
      });
      await act(async () => {
        expect(longPress.advance()).toBe(1);
      });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Restart validation" }));

      await waitFor(() =>
        expect(restartStepMock).toHaveBeenCalledWith(
          pipeline.id,
          "validation:validation-long-press",
        ),
      );
    } finally {
      longPress.restore();
    }
  });

  test("skips running validation from the node menu and the Tests view", async () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "building",
        validationRun: validationRun({
          id: "validation-skip",
          status: "running",
          completedAt: undefined,
          results: [{ ...validationResult("passed"), status: "running", exitCode: null }],
        }),
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

    fireEvent.contextMenu(graphNode("Prepare"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip validation" }));
    await waitFor(() =>
      expect(skipStepMock).toHaveBeenCalledWith(pipeline.id, "validation:validation-skip"),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Step skipped");

    skipStepMock.mockClear();
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipelineStore().getState().pipelines.get(pipeline.id)!,
        phase: "building",
        backendRevision: 18,
      });
    selectNode("Prepare");
    fireEvent.click(screen.getByRole("button", { name: /Stop tests and continue/ }));
    await waitFor(() =>
      expect(skipStepMock).toHaveBeenCalledWith(pipeline.id, "validation:validation-skip"),
    );
  });

  test("skips the running stage to the next one, but not a finished stage", async () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "verifying",
        sessions: [pipeline.sessions[0]!, { ...pipeline.sessions[1]!, status: "running" }],
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

    fireEvent.contextMenu(graphNode("Build"));
    await screen.findByRole("menuitem", { name: "Restart from here" });
    expect(screen.queryByRole("menuitem", { name: /^Skip/ }) === null).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.contextMenu(graphNode("Verify"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip verification" }));
    await waitFor(() => expect(skipStepMock).toHaveBeenCalledWith(pipeline.id, "verify-session"));
  });

  test("renders loading and not-yet-started states from incomplete snapshots", () => {
    pipelineStore().setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
    const { rerender } = renderInBuildChat(
      <BuildChatTab data={{ ...tabData, pipelineId: "missing" }} />,
    );
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();

    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        id: "empty",
        phase: "building",
        sessions: [],
        currentSessionIndex: -1,
        backendRevision: 9,
      });
    rerender(<BuildChatTab data={{ ...tabData, pipelineId: "empty" }} />);
    // Nothing has run yet, so every step ahead is a placeholder.
    expect(nodeTitles()).toEqual([
      "Ticket",
      "Setup",
      "Build",
      "Review",
      "Verify",
      "Ship",
      "PR",
      "Notes",
    ]);
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
    pipelineStore()
      .getState()
      .replacePipeline({
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

    const view = renderInBuildChat(<BuildChatTab data={tabData} isActive />);
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
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "reviewing",
        sessions: [pipeline.sessions[0]!, packageSession, reviewOne, reviewTwo],
        currentSessionIndex: 3,
        validationRun: validationRun({ id: "validation-ordered" }),
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

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
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "building",
        validationRun: run,
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

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
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        validationRun: validationRun({ results: [result] }),
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

    const chip = graphNode("Prepare").querySelector("[data-validation-status]")!;
    expect(chip.getAttribute("data-validation-status")).toBe(status);
    expect(graphNode("Prepare").getAttribute("data-flow-state")).toBe(
      status === "failed" || status === "incomplete" ? "failed" : "complete",
    );
  });

  test("marks a run-level validation fault as a failed Prepare node with its error", () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        validationRun: validationRun({ status: "failed", error: "HEAD moved during validation" }),
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

    const node = graphNode("Prepare");
    expect(node.getAttribute("data-flow-state")).toBe("failed");
    expect(node.querySelector("[data-flow-node-error]")?.textContent).toBe(
      "HEAD moved during validation",
    );
  });

  test("marks a cancelled validation run as stopped, not failed", () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        validationRun: validationRun({ status: "cancelled" }),
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

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
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "reviewing",
        sessions: [pipeline.sessions[0]!, reviewOne, pipeline.sessions[1]!],
        currentSessionIndex: 2,
        validationRun: validationRun({ id: "validation-fallback" }),
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

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
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "reviewing",
        sessions: [preparedBuild, reviewOne],
        currentSessionIndex: 1,
        validationRun: validationRun({ id: "validation-reused" }),
        backendRevision: 9,
      });
    renderInBuildChat(<BuildChatTab data={tabData} />);

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
    pipelineStore().setState({
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
    renderInBuildChat(<BuildChatTab data={tabData} />);

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
    pipelineStore().getState().replacePipeline(withRun);
    renderInBuildChat(<BuildChatTab data={tabData} />);

    selectNode("Prepare");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();

    act(() => {
      const next = { ...withRun, backendRevision: 10 };
      delete next.validationRun;
      pipelineStore().getState().replacePipeline(next);
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
    pipelineStore().setState({
      pipelines: new Map([[pipeline.id, withRun]]),
      viewedSessionIds: new Map(),
    });
    renderInBuildChat(<BuildChatTab data={tabData} />);

    selectNode("Build");
    selectNode("Prepare");
    showInspectorTab("Tests");
    expect(screen.getByLabelText("Review validation")).toBeTruthy();

    act(() => {
      pipelineStore()
        .getState()
        .replacePipeline({
          ...withRun,
          validationRun: validationRun({ id: "validation-new", status: "running" }),
          backendRevision: 10,
        });
    });

    await waitFor(() => expect(selectedTitle()).toBe("Prepare"));
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
  });

  test("ignores malformed transcript entries and renders terminal errors", () => {
    pipelineStore()
      .getState()
      .replacePipeline({
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
    renderInBuildChat(<BuildChatTab data={{ ...tabData, pipelineId: "malformed" }} />);

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
    pipelineStore()
      .getState()
      .replacePipeline({
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
    renderInBuildChat(<BuildChatTab data={data} />);

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
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        phase: "paused" as const,
        backendRevision: 14,
      }));
      resumeBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => ({
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        phase: "building" as const,
        backendRevision: 15,
      }));
      cancelBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => ({
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        phase: "failed" as const,
        error: "Build cancelled",
        backendRevision: 16,
      }));
      pipelineStore()
        .getState()
        .replacePipeline({
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
      renderInBuildChat(<BuildChatTab data={data} />);

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
      pipelineStore()
        .getState()
        .replacePipeline({
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
      renderInBuildChat(
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
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "building",
        backendRevision: 9,
      });
    pauseBuildPipelineMock.mockRejectedValueOnce(new Error("pause unavailable"));
    renderInBuildChat(
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
    expect(pipelineStore().getState().pipelines.get(pipeline.id)?.phase).toBe("building");
  });

  test("reports a non-Error resume rejection and re-enables the control", async () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "paused",
        backendRevision: 9,
      });
    resumeBuildPipelineMock.mockRejectedValueOnce("resume unavailable");
    renderInBuildChat(
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
    expect(pipelineStore().getState().pipelines.get(pipeline.id)?.phase).toBe("paused");
  });

  test("reports a cancelled-control failure without replacing the snapshot", async () => {
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "building",
        backendRevision: 9,
      });
    cancelBuildPipelineMock.mockRejectedValueOnce(503);
    renderInBuildChat(
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
    expect(pipelineStore().getState().pipelines.get(pipeline.id)?.phase).toBe("building");
  });

  test("sends one control request however fast the button is clicked", async () => {
    let release: (() => void) | undefined;
    pauseBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...pipelineStore().getState().pipelines.get(pipelineId)!,
        phase: "paused" as const,
        backendRevision: 14,
      };
    });
    pipelineStore()
      .getState()
      .replacePipeline({
        ...pipeline,
        phase: "building",
        backendRevision: 9,
      });
    renderInBuildChat(
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
    expect(pipelineStore().getState().pipelines.get(pipeline.id)?.phase).toBe("paused");
  });

  test("surfaces persisted GitHub completion-comment recovery in the build tab", () => {
    pipelineStore()
      .getState()
      .replacePipeline({
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
    renderInBuildChat(
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
    pipelineStore()
      .getState()
      .replacePipeline({
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
    renderInBuildChat(
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
      expect(pipelineStore().getState().pipelines.get(pipeline.id)?.phase).toBe("building");
    });
  });
});
