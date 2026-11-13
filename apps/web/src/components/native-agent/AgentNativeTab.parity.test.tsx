/**
 * Contract suite for the native agent tab's reads and its capability-driven
 * parity across providers.
 *
 * Setup is shared with the sibling suites through `AgentNativeTab.test-support`.
 */
import { nativeAgentSteerRejectionMessage } from "@orkestrator/protocol/native-agent";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import { nativeAsyncQuestionRequestId } from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as scrollState from "@/hooks/useVirtuosoScrollState";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeDraft, nativeComposeStore } from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeNoticeDismissalStore } from "@/stores/nativeNoticeDismissalStore";
import { createSessionKey } from "@/lib/utils";
import { AGENT_HANDOFF_VERSION } from "@/lib/agent-handoff";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@orkestrator/protocol/git-workflow-prompts";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import {
  mockToastDismiss,
  mockToastError,
  mockToastInfo,
  mockToastLoading,
  mockToastWarning,
} from "../../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";
import {
  virtualizedMessageListRenderCount,
  latestRenderedMessageActions,
  nativeMessageRenderCounts,
  latestTranscriptAnnotationProps,
  defaultAdoptNativeAgentSession,
  adoptNativeAgentSessionMock,
  forkNativeAgentSessionMock,
  listNativeAgentResumableSessionsMock,
  getAgentHandoffMock,
  performNativeAgentSessionActionMock,
  steerNativeAgentQueuedPromptMock,
  enqueuePromptQueueMessageMock,
  removePromptQueueMessageMock,
  dismissNativeAgentSuggestedPromptMock,
  updateNativeAgentControlsMock,
  dispatchNativeAgentIntentMock,
  retryNativeAgentDispatchMock,
  discardNativeAgentDispatchMock,
  resumeNativeAgentSessionMock,
  stopNativeAgentSessionMock,
  defaultProjection,
  sessionProjectionMock,
  sessionHistoryMock,
  sessionBackend,
  getAgentAccountLoginMock,
  EMPTY_AGENT_ACCOUNTS,
  stopNativeAgentBackgroundTaskMock,
  latestPasteOptions,
  deliverResourceChange,
  settleCoordinatedReads,
  fakeReadCoordinator,
  firstPartAgentState,
  identity,
  seedEnvTab,
  grokToCursorHandoff,
  PaneBackedAgentNativeTab,
  NativeSessionHarness,
  NativeSessionIdentityHarness,
  fixtureState,
  installAgentNativeTabFixture,
  AgentNativeTab,
  enqueueNativeAsyncQuestionResponse,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

describe("AgentNativeTab", () => {
  test("returns to connecting after Retry on an empty session read", async () => {
    sessionProjectionMock.mockImplementation(async () => null as never);
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-retry-empty" data={identity("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());

    let settleRetry: (() => void) | undefined;
    adoptNativeAgentSessionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleRetry = () =>
            resolve(
              defaultAdoptNativeAgentSession({
                agent: "cursor",
                providerSessionId: "cursor-session",
                logicalSessionKey: createSessionKey("env-1", "tab-retry-empty"),
                environmentId: "env-1",
              }),
            );
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // Retry starts adoption immediately, but transcript loading has not begun
    // yet. Clear the stale failure without claiming that history is loading.
    await waitFor(() => expect(screen.queryByText("Connection Failed") === null).toBe(true));
    expect(screen.queryByText("Refreshing Cursor Agent session…") === null).toBe(true);
    expect(screen.queryByText("Connection Failed") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    await act(async () => {
      settleRetry!();
    });
  });

  test("returns to connecting after Retry on a failed connect", async () => {
    adoptNativeAgentSessionMock.mockImplementation(async () => {
      throw new Error("bridge refused the session");
    });
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-retry-connect" data={identity("codex")} isActive />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());

    let settleRetry: (() => void) | undefined;
    adoptNativeAgentSessionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleRetry = () =>
            resolve(
              defaultAdoptNativeAgentSession({
                agent: "codex",
                providerSessionId: "codex-session",
                logicalSessionKey: createSessionKey("env-1", "tab-retry-connect"),
                environmentId: "env-1",
              }),
            );
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByText("Connection Failed") === null).toBe(true));
    expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
    expect(screen.queryByText("Connection Failed") === null).toBe(true);
    expect(screen.queryByText("bridge refused the session") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    await act(async () => {
      settleRetry!();
    });
  });

  test("does not keep a failed connection after the tab identity changes", async () => {
    sessionProjectionMock.mockImplementation(async () => null as never);
    const { rerender } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-identity-swap" data={identity("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());

    let settleOpenCode: (() => void) | undefined;
    adoptNativeAgentSessionMock.mockImplementation((input) => {
      if (input.agent !== "opencode") {
        return defaultAdoptNativeAgentSession(input);
      }
      return new Promise((resolve) => {
        settleOpenCode = () => resolve(defaultAdoptNativeAgentSession(input));
      });
    });
    rerender(<AgentNativeTab tabId="tab-identity-swap" data={identity("opencode")} isActive />);

    // The cursor read answered "no session". That must not keep vouching for
    // OpenCode, which has not been asked yet.
    await waitFor(() => expect(screen.queryByText("Connection Failed") === null).toBe(true));
    expect(screen.queryByText("Refreshing OpenCode session…") === null).toBe(true);
    expect(screen.queryByText("Connection Failed") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    await act(async () => {
      settleOpenCode!();
    });
  });

  test("does not let a completed empty read mark a later identity as failed", async () => {
    let settleOpenCode: (() => void) | undefined;
    sessionProjectionMock.mockImplementation(async (input: { agent: string }) => {
      if (input.agent !== "opencode") return null as never;
      await new Promise<void>((resolve) => {
        settleOpenCode = resolve;
      });
      return null as never;
    });

    const { rerender } = renderInAppCommandScope(
      <NativeSessionIdentityHarness platform="cursor" />,
    );
    await waitFor(() => expect(screen.getByTestId("has-completed-read").textContent).toBe("true"));

    rerender(<NativeSessionIdentityHarness platform="opencode" />);
    await waitFor(() => expect(screen.getByTestId("has-completed-read").textContent).toBe("false"));
    expect(settleOpenCode).toBeDefined();
    await act(async () => {
      settleOpenCode!();
    });
  });

  test("forgets a completed read when the hook is no longer allowed to read", async () => {
    sessionProjectionMock.mockImplementation(async () => null as never);

    const { rerender } = renderInAppCommandScope(
      <NativeSessionIdentityHarness platform="cursor" />,
    );
    await waitFor(() => expect(screen.getByTestId("has-completed-read").textContent).toBe("true"));

    rerender(<NativeSessionIdentityHarness platform="cursor" enabled={false} />);
    await waitFor(() => expect(screen.getByTestId("has-completed-read").textContent).toBe("false"));
  });

  test("does not let a stale projection refresh undo a resumed session", async () => {
    let resolveStale!: (projection: NativeAgentSessionProjection<NativeMessage>) => void;
    const staleProjection = new Promise<NativeAgentSessionProjection<NativeMessage>>((resolve) => {
      resolveStale = resolve;
    });
    // The harness adopts `session-a`, so that is the session the backend serves.
    const sessionA = async (input: Parameters<typeof defaultProjection>[0]) => ({
      ...(await defaultProjection(input)),
      sessionId: "session-a",
    });
    sessionProjectionMock
      .mockImplementationOnce(sessionA)
      .mockImplementationOnce(async () => staleProjection)
      .mockImplementation(sessionA);

    renderInAppCommandScope(<NativeSessionHarness />);
    await waitFor(() =>
      expect(screen.getByTestId("hook-session-id").textContent).toBe("session-a"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Resume B" }));
    await waitFor(() =>
      expect(screen.getByTestId("hook-session-id").textContent).toBe("session-b"),
    );

    resolveStale({
      ...(await defaultProjection({ agent: "claude", environmentId: "env-1" })),
      sessionId: "session-a",
      generation: "stale-session-a",
      revision: 999,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId("hook-session-id").textContent).toBe("session-b");
  });

  test("hydrates a cached session while its remount adoption probe is still pending", async () => {
    const sessionKey = createSessionKey("env-1", "tab-hook-race");
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(sessionKey, {
        ...(await defaultProjection({ agent: "claude", environmentId: "env-1" })),
        sessionId: "session-a",
        messages: [
          {
            id: "assistant-stale",
            role: "assistant",
            content: "stale transcript",
            parts: [],
            createdAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      });
    let releaseAdoption!: () => void;
    adoptNativeAgentSessionMock.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        releaseAdoption = resolve;
      });
      return {
        providerSessionId: input.providerSessionId,
        logicalSessionKey: input.logicalSessionKey,
        environmentId: input.environmentId,
        agent: input.agent,
      };
    });
    sessionProjectionMock.mockImplementationOnce(async (input) => ({
      ...(await defaultProjection(input as never)),
      sessionId: "session-a",
      messages: [
        {
          id: "assistant-latest",
          role: "assistant",
          content: "latest transcript",
          parts: [],
          createdAt: "2026-08-14T10:00:01.000Z",
        },
      ],
      revision: 2,
    }));

    renderInAppCommandScope(<NativeSessionHarness />);
    expect(screen.getByTestId("hook-message").textContent).toBe("stale transcript");
    await waitFor(() =>
      expect(screen.getByTestId("hook-message").textContent).toBe("latest transcript"),
    );
    expect(adoptNativeAgentSessionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseAdoption();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  /**
   * Park the very first projection read so the invalidation below is
   * guaranteed to land while a read is genuinely in flight. Gating a later
   * read instead races the mount's own reads, and a dispatch that arrives with
   * nothing in flight takes the ordinary path and proves nothing.
   */
  async function parkFirstProjectionRead(): Promise<() => void> {
    let releaseRefresh!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    sessionProjectionMock.mockImplementationOnce(async (input) => {
      await parked;
      return {
        ...(await defaultProjection(input as never)),
        sessionId: "session-a",
        messages: [
          {
            id: "assistant-stale",
            role: "assistant",
            content: "stale transcript",
            parts: [],
            createdAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      };
    });
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      sessionId: "session-a",
      messages: [
        {
          id: "assistant-latest",
          role: "assistant",
          content: "latest transcript",
          parts: [],
          createdAt: "2026-08-14T10:00:01.000Z",
        },
      ],
      revision: 2,
    }));
    return releaseRefresh;
  }

  test("coalesces a resource invalidation into one trailing projection read", async () => {
    const releaseRefresh = await parkFirstProjectionRead();
    renderInAppCommandScope(<NativeSessionHarness />);
    await waitFor(() => expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(0));
    const callsWhileParked = sessionProjectionMock.mock.calls.length;

    // Delivered through the dispatcher's coalescing timer, so the invalidation
    // reaches the hook while the read above is still parked.
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });
    // Coalesced, not executed: proof the read below is the trailing
    // reconciliation rather than the invalidation's own read.
    expect(sessionProjectionMock.mock.calls.length).toBe(callsWhileParked);

    await act(async () => {
      releaseRefresh();
    });
    // Only the trailing read answers with the latest transcript; once it shows
    // and the coordinator is idle, the read count is final.
    await waitFor(() =>
      expect(screen.getByTestId("hook-message").textContent).toBe("latest transcript"),
    );
    await settleCoordinatedReads();
    expect(sessionProjectionMock.mock.calls.length).toBe(callsWhileParked + 1);
  });

  test("drops the queued reconciliation read when the tab stops being active", async () => {
    const releaseRefresh = await parkFirstProjectionRead();
    const { rerender } = renderInAppCommandScope(<NativeSessionHarness />);
    await waitFor(() => expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(0));
    const callsWhileParked = sessionProjectionMock.mock.calls.length;

    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });
    expect(sessionProjectionMock.mock.calls.length).toBe(callsWhileParked);
    // The tab stops being visible before the in-flight read drains. A tab the
    // user cannot see must not keep reading; the next activation reconnects
    // and reads authoritatively anyway.
    rerender(<NativeSessionHarness isActive={false} />);

    await act(async () => {
      releaseRefresh();
      // A full macrotask turn drains every queued microtask, so a trailing
      // read would already have been recorded by the time this resolves.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(sessionProjectionMock.mock.calls.length).toBe(callsWhileParked);
  });

  test("drops the queued reconciliation read when the tab unmounts", async () => {
    const releaseRefresh = await parkFirstProjectionRead();
    const { unmount } = renderInAppCommandScope(<NativeSessionHarness />);
    await waitFor(() => expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(0));
    const callsWhileParked = sessionProjectionMock.mock.calls.length;

    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });
    expect(sessionProjectionMock.mock.calls.length).toBe(callsWhileParked);
    unmount();

    await act(async () => {
      releaseRefresh();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(sessionProjectionMock.mock.calls.length).toBe(callsWhileParked);
  });

  test("polls an active tab faster while a turn runs and stops entirely when inactive", async () => {
    /*
     * The backend no longer refreshes projections on a timer, so this poll is
     * the only thing that advances a visible transcript. Assert the cadence
     * the read coordinator schedules rather than waiting on wall-clock ticks.
     */
    const { clock, coordinator } = installFakeReadCoordinator();
    const sessionCadence = () =>
      coordinator
        .getDiagnostics()
        .entries.filter((entry) => entry.id.includes("native-agent-session") && entry.subscribers)
        .map((entry) => entry.cadenceMs);
    try {
      // The harness adopts `session-a`, so that is the session the backend serves.
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        sessionId: "session-a",
      }));
      const view = renderInAppCommandScope(<NativeSessionHarness />);
      await waitFor(() =>
        expect(screen.getByTestId("hook-session-id").textContent).toBe("session-a"),
      );
      expect(sessionCadence()).toEqual([1_500]);

      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        sessionId: "session-a",
        turn: { phase: "running" as const },
      }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(sessionCadence()).toEqual([500]));

      // Unmounting is the inactive path: no timer may outlive the tree.
      const before = sessionProjectionMock.mock.calls.length;
      view.unmount();
      expect(sessionCadence()).toEqual([]);
      expect(clock.pending).toBe(0);
      await act(() => clock.advance(5_000));
      expect(sessionProjectionMock.mock.calls.length).toBe(before);
    } finally {
      resetReadCoordinatorForTests();
    }
  });

  test("reports a completed turn's duration from the transcript on a fresh mount", async () => {
    /*
     * The tab that started this turn may never have seen it end — it could have
     * been unmounted while another environment was active. Both ends of the
     * duration come from backend clocks in the transcript, so a first mount
     * against the projection still reports it.
     */
    sessionProjectionMock.mockImplementation(async (input) => ({
      platform: input.agent,
      environmentId: input.environmentId,
      sessionId: "claude-session",
      connection: "connected" as const,
      turn: { phase: "idle" as const },
      messages: [
        {
          id: "user-1",
          role: "user" as const,
          content: "Refactor the parser",
          parts: [{ type: "text" as const, content: "Refactor the parser" }],
          createdAt: "2026-08-14T10:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant" as const,
          content: "Done",
          parts: [
            {
              type: "text" as const,
              content: "Done",
              createdAt: "2026-08-14T10:00:45.000Z",
            },
          ],
          createdAt: "2026-08-14T10:00:05.000Z",
        },
      ],
      interactions: [],
      composerControls: [],
      composer: {
        models: [],
        fastModeEnabled: false,
        fastModeAvailable: false,
        selectedModeId: "build" as const,
        modes: [{ id: "build" as const, label: "Build" }],
      },
      capabilities: {
        attachments: { files: false, images: false },
        queue: false,
        resume: false,
        fork: false,
        slashCommands: false,
        backgroundTasks: false,
        composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      },
      revision: 1,
      generation: "test-generation",
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-elapsed" data={identity("claude")} isActive ownsGlobalShortcuts />,
    );

    // 10:00:00 prompt → 10:00:45 newest response section, both backend-stamped.
    expect(await screen.findByText("Completed in 45s")).toBeTruthy();
  });

  test("restores review follow-up, manual refresh, notices, and Escape stop in the shared tab", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      platform: input.agent,
      environmentId: input.environmentId,
      sessionId: "claude-session",
      connection: "connected" as const,
      turn: { phase: "idle" as const },
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          content: "Review",
          parts: [],
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
      interactions: [],
      composerControls: [],
      composer: {
        models: [],
        fastModeEnabled: false,
        fastModeAvailable: false,
        selectedModeId: "plan" as const,
        modes: [
          { id: "build" as const, label: "Build" },
          { id: "plan" as const, label: "Plan" },
        ],
      },
      capabilities: {
        attachments: { files: true, images: true },
        queue: true,
        resume: true,
        fork: true,
        slashCommands: true,
        backgroundTasks: true,
        composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      },
      notices: [{ kind: "warning" as const, message: "Recovered provider notice" }],
      revision: 1,
      generation: "test-generation",
    }));
    const view = renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-review"
        data={identity("claude")}
        isActive
        ownsGlobalShortcuts
        isReviewTab
        refreshRequestId={0}
      />,
    );
    await waitFor(() =>
      expect(mockToastWarning).toHaveBeenCalledWith(
        "Recovered provider notice",
        expect.objectContaining({ duration: Infinity }),
      ),
    );
    expect(screen.queryByText("Recovered provider notice") === null).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Address all" }));
    await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
    expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      update: { mode: "build" },
    });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
    expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      prompt: ADDRESS_ALL_REVIEW_PROMPT,
      mode: "build",
    });

    const readsBeforeRefresh = sessionProjectionMock.mock.calls.length;
    view.rerender(
      <AgentNativeTab
        tabId="tab-review"
        data={identity("claude")}
        isActive
        ownsGlobalShortcuts
        isReviewTab
        refreshRequestId={1}
      />,
    );
    await waitFor(() =>
      expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(readsBeforeRefresh),
    );

    sessionProjectionMock.mockImplementation(async (input) => ({
      platform: input.agent,
      environmentId: input.environmentId,
      sessionId: "claude-session",
      connection: "connected" as const,
      turn: { phase: "running" as const },
      messages: [],
      interactions: [],
      composerControls: [],
      composer: { models: [], fastModeEnabled: false, fastModeAvailable: false, modes: [] },
      capabilities: {
        attachments: { files: true, images: true },
        queue: true,
        resume: true,
        fork: true,
        slashCommands: true,
        backgroundTasks: true,
        composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      },
      revision: 2,
      generation: "test-generation",
    }));
    view.rerender(
      <AgentNativeTab
        tabId="tab-review-running"
        data={identity("claude")}
        isActive
        ownsGlobalShortcuts
      />,
    );
    await waitFor(() => expect(screen.getByTitle("Stop current query")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(stopNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .turnStopMarkers.get(createSessionKey("env-1", "tab-review-running"))?.sessionId,
    ).toBe("claude-session");
  });

  test("stops from the transcript in its pane but ignores sidebar Escape", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      turn: { phase: "running" as const },
      messages: [
        {
          id: "assistant-running",
          role: "assistant" as const,
          content: "Running transcript",
          parts: [],
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    }));
    renderInAppCommandScope(
      <>
        <div data-pane-leaf="">
          <AgentNativeTab
            tabId="tab-escape-scope"
            data={identity("claude")}
            isActive
            ownsGlobalShortcuts
          />
        </div>
        <input aria-label="Sidebar search" />
      </>,
    );

    await screen.findByTitle("Stop current query");
    fireEvent.keyDown(screen.getByLabelText("Sidebar search"), { key: "Escape" });
    expect(stopNativeAgentSessionMock).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("virtuoso-scroller"), { key: "Escape" });
    await waitFor(() => expect(stopNativeAgentSessionMock).toHaveBeenCalledTimes(1));
  });

  describe("capability-driven parity", () => {
    test("adds transcript annotations and comments to the next dispatched prompt", async () => {
      seedProjection();
      const tabId = "tab-annotation-send";
      const sessionKey = createSessionKey("env-1", tabId);
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);

      await screen.findByTestId("shared-native-compose-bar");
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, {
            text: "Please revise this",
            annotations: [
              {
                id: "annotation-1",
                text: "Removed the large coloured left rail",
                comment: "Keep this wording",
              },
            ],
          });
      });

      expect(screen.getByTestId("compose-annotation-count").textContent).toContain("1 annotation");
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      const dispatchInput = dispatchNativeAgentIntentMock.mock.calls[0]?.[0] as
        { prompt?: string } | undefined;
      const prompt = dispatchInput?.prompt ?? "";
      expect(prompt).toContain("Please revise this");
      expect(prompt).toContain('"selectedText": "Removed the large coloured left rail"');
      expect(prompt).toContain('"userComment": "Keep this wording"');
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
        ).toBeUndefined(),
      );
    });

    test("sends an annotation-only prompt", async () => {
      seedProjection();
      const tabId = "tab-annotation-only-send";
      const sessionKey = createSessionKey("env-1", tabId);
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      await screen.findByTestId("shared-native-compose-bar");
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, {
            annotations: [
              { id: "annotation-1", text: "The referenced answer", comment: "Explain this" },
            ],
          });
      });

      fireEvent.click(await screen.findByTitle("Send"));

      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      const dispatchInput = dispatchNativeAgentIntentMock.mock.calls[0]?.[0] as unknown as {
        prompt: string;
      };
      expect(dispatchInput.prompt).toStartWith("<orkestrator_transcript_annotations>");
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
        ).toBeUndefined(),
      );
    });

    test("blocks sending a visible image that the selected model cannot read", async () => {
      seedProjection({
        composer: {
          models: [
            {
              platform: "codex",
              id: "text-only-model",
              label: "Text Only",
              supportsImageInput: false,
              reasoning: [],
            },
          ],
          selectedModelId: "text-only-model",
        },
      });
      const tabId = "tab-unsupported-image-send";
      const sessionKey = createSessionKey("env-1", tabId);
      const image = {
        id: "visible-image",
        type: "image" as const,
        path: "/workspace/screenshot.png",
        previewUrl: "blob:preview",
        name: "screenshot.png",
      };
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      await screen.findByTestId("shared-native-compose-bar");
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, {
            text: "Describe this image",
            attachments: [image],
          });
      });

      fireEvent.click(await screen.findByTitle("Send"));

      expect(
        await screen.findByText(/This attachment is not supported.*screenshot\.png/),
      ).toBeTruthy();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.attachments,
      ).toEqual([image]);
    });

    test("consumes a submitted browser annotation from the other native drafts", async () => {
      seedProjection();
      const tabId = "tab-browser-annotation-send";
      const sessionKey = createSessionKey("env-1", tabId);
      const otherSessionKey = createSessionKey("env-1", "other-native-tab");
      const shared = {
        id: "browser-annotation-1",
        source: "browser" as const,
        text: "Browser element annotation\nCSS path: html > body > button",
        comment: "Make this clearer",
        screenshotPath: "/workspace/.orkestrator/annotations/button.png",
      };
      const screenshot = {
        id: "browser-screenshot-1",
        annotationId: shared.id,
        type: "image" as const,
        path: shared.screenshotPath,
        name: "button.png",
      };
      appCommandStore(nativeComposeStore)
        .getState()
        .updateDraft(otherSessionKey, {
          text: "Keep my other draft",
          annotations: [
            shared,
            { id: "transcript-1", text: "Earlier answer", comment: "Keep this too" },
          ],
          attachments: [screenshot],
        });
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      await screen.findByTestId("shared-native-compose-bar");
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, {
            annotations: [shared],
            attachments: [screenshot],
          });
      });

      fireEvent.click(await screen.findByTitle("Send"));

      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(otherSessionKey),
        ).toMatchObject({
          text: "Keep my other draft",
          annotations: [{ id: "transcript-1", text: "Earlier answer", comment: "Keep this too" }],
          attachments: [],
        }),
      );
    });

    test("explains the annotation cap when another selection is added", async () => {
      seedProjection();
      const tabId = "tab-annotation-cap";
      const sessionKey = createSessionKey("env-1", tabId);
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      await screen.findByTestId("shared-native-compose-bar");
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, {
            annotations: Array.from({ length: 20 }, (_, index) => ({
              id: String(index),
              text: `reference-${index}`,
              comment: "",
            })),
          });
      });

      act(() => {
        expect(latestTranscriptAnnotationProps?.onAdd("One more reference")).toBeNull();
      });

      expect(mockToastError).toHaveBeenCalledWith("A prompt can include up to 20 annotations");
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.annotations,
      ).toHaveLength(20);
    });

    test("preserves annotations when dispatch is rejected", async () => {
      seedProjection();
      dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
        outcome: "rejected" as const,
        requestId: input.requestId,
        error: "Provider rejected the prompt",
      }));
      const tabId = "tab-annotation-rejected";
      const sessionKey = createSessionKey("env-1", tabId);
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      await screen.findByTestId("shared-native-compose-bar");
      const annotations = [
        { id: "annotation-1", text: "The referenced answer", comment: "Keep this" },
      ];
      act(() => {
        appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
          text: "Try this",
          annotations,
        });
      });

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      await screen.findByText("Provider rejected the prompt");
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.annotations,
      ).toEqual(annotations);
    });

    test.each(["accepted", "unknown"] as const)(
      "blocks transcript annotation capture while a %s dispatch is pending",
      async (outcome) => {
        seedProjection();
        let releaseDispatch!: () => void;
        const dispatchGate = new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
        dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
          await dispatchGate;
          return outcome === "accepted"
            ? { outcome, requestId: input.requestId }
            : { outcome, requestId: input.requestId, error: "Response was lost" };
        });
        const tabId = `tab-annotation-pending-${outcome}`;
        const sessionKey = createSessionKey("env-1", tabId);
        renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
        const input = await screen.findByRole("textbox");
        const submittedAnnotations = [
          { id: "annotation-1", text: "Submitted reference", comment: "Original comment" },
        ];
        act(() => {
          appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
            annotations: submittedAnnotations,
          });
        });
        fireEvent.input(input, { target: { textContent: "Submit this" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));

        await waitFor(() => expect(latestTranscriptAnnotationProps?.enabled).toBe(false));
        act(() => {
          expect(latestTranscriptAnnotationProps?.onAdd("Unsent reference")).toBeNull();
          latestTranscriptAnnotationProps?.onUpdateComment("annotation-1", "Mutated comment");
        });
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.annotations,
        ).toEqual(submittedAnnotations);

        releaseDispatch();
        if (outcome === "accepted") {
          await waitFor(() =>
            expect(
              appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
            ).toBeUndefined(),
          );
        } else {
          // An unconfirmed dispatch leaves the submitted annotations untouched
          // and releases the capture lock once the send has settled.
          await waitFor(() => expect(latestTranscriptAnnotationProps?.enabled).toBe(true));
          expect(
            appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.annotations,
          ).toEqual(submittedAnnotations);
        }
      },
    );

    /** A running turn on a provider that reports the given capabilities. */
    function seedProjection(
      overrides: {
        connection?: NativeAgentSessionProjection["connection"];
        phase?: NativeAgentSessionProjection["turn"]["phase"];
        turnActivity?: NativeAgentSessionProjection["turn"]["activity"];
        actions?: NativeAgentSessionProjection["capabilities"]["actions"];
        messageWindow?: NativeAgentSessionProjection["messageWindow"];
        queue?: NativeAgentSessionProjection["queue"];
        suggestedPrompt?: string;
        promptSuggestions?: boolean;
        messages?: NativeMessage[];
        recoverableDispatch?: NativeAgentSessionProjection["recoverableDispatch"];
        notices?: NativeAgentSessionProjection["notices"];
        composer?: Partial<NonNullable<NativeAgentSessionProjection["composer"]>>;
        composerCapabilities?: Partial<NativeAgentSessionProjection["capabilities"]["composer"]>;
        contextUsage?: NativeAgentSessionProjection["contextUsage"];
        backgroundTasks?: NativeAgentSessionProjection["backgroundTasks"];
        sessionId?: string;
        runtimeHealthAuthoritative?: boolean;
      } = {},
    ) {
      sessionProjectionMock.mockImplementation(async (input) => ({
        platform: input.agent,
        environmentId: input.environmentId,
        sessionId: overrides.sessionId ?? `${input.agent}-session`,
        connection: overrides.connection ?? ("connected" as const),
        turn: {
          // Explicit undefined exercises an incomplete provider snapshot.
          phase: (Object.hasOwn(overrides, "phase")
            ? overrides.phase
            : "idle") as NativeAgentSessionProjection["turn"]["phase"],
          ...(overrides.turnActivity ? { activity: overrides.turnActivity } : {}),
        },
        messages: overrides.messages ?? [
          {
            id: "assistant-1",
            role: "assistant" as const,
            content: "Working",
            parts: [],
            createdAt: "2026-08-14T10:00:00.000Z",
          },
        ],
        ...(overrides.messageWindow ? { messageWindow: overrides.messageWindow } : {}),
        ...(overrides.queue ? { queue: overrides.queue } : {}),
        ...(overrides.recoverableDispatch
          ? { recoverableDispatch: overrides.recoverableDispatch }
          : {}),
        ...(overrides.suggestedPrompt ? { suggestedPrompt: overrides.suggestedPrompt } : {}),
        ...(overrides.backgroundTasks ? { backgroundTasks: overrides.backgroundTasks } : {}),
        ...(overrides.contextUsage ? { contextUsage: overrides.contextUsage } : {}),
        ...(overrides.notices ? { notices: overrides.notices } : {}),
        ...(overrides.runtimeHealthAuthoritative === undefined
          ? {}
          : { runtimeHealthAuthoritative: overrides.runtimeHealthAuthoritative }),
        interactions: [],
        composerControls: [],
        composer: {
          models: [
            {
              platform: input.agent,
              id: "model-a",
              label: "Model A",
              reasoning: [{ id: "high", label: "High" }],
            },
          ],
          selectedModelId: "model-a",
          fastModeEnabled: false,
          fastModeAvailable: false,
          selectedModeId: "build" as const,
          modes: [
            { id: "build" as const, label: "Build" },
            { id: "plan" as const, label: "Plan" },
          ],
          ...(overrides.promptSuggestions === undefined
            ? {}
            : { promptSuggestionsEnabled: overrides.promptSuggestions }),
          ...overrides.composer,
        },
        capabilities: {
          attachments: { files: true, images: true },
          queue: true,
          resume: true,
          fork: true,
          slashCommands: true,
          backgroundTasks: overrides.backgroundTasks !== undefined,
          composer: {
            provider: true,
            model: true,
            reasoning: true,
            speed: true,
            mode: true,
            ...(overrides.promptSuggestions === undefined ? {} : { promptSuggestions: true }),
            ...overrides.composerCapabilities,
          },
          ...(overrides.actions ? { actions: overrides.actions } : {}),
        },
        revision: 1,
        generation: "test-generation",
      }));
    }

    test("keeps existing transcript actions stable across unrelated controller renders", async () => {
      fixtureState.renderVirtualizedMessages = true;
      const tabId = "tab-stable-transcript-actions";
      const sessionKey = createSessionKey("env-1", tabId);
      seedProjection({
        phase: "running",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Inspect the renderer",
            parts: [{ type: "text", content: "Inspect the renderer" }],
            createdAt: "2026-08-14T10:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "I am checking it.",
            parts: [{ type: "text", content: "I am checking it." }],
            createdAt: "2026-08-14T10:00:01.000Z",
          },
        ],
      });
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);

      await waitFor(() => expect(latestRenderedMessageActions.get("user-1")).toBeTruthy());
      const firstAction = latestRenderedMessageActions.get("user-1");
      const firstRenderCount = virtualizedMessageListRenderCount;
      const firstUserRenders = nativeMessageRenderCounts.get("user-1");
      const firstAssistantRenders = nativeMessageRenderCounts.get("assistant-1");

      // Draft edits re-render the controller without touching displayMessages.
      // Already-painted rows must keep their action element *and* skip
      // NativeMessage so a later change that churns some other controller prop
      // cannot restore the flicker while this identity check still passes.
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, { text: "A draft update" });
      });
      await waitFor(() =>
        expect(virtualizedMessageListRenderCount).toBeGreaterThan(firstRenderCount),
      );

      expect(latestRenderedMessageActions.get("user-1")).toBe(firstAction);
      expect(nativeMessageRenderCounts.get("user-1")).toBe(firstUserRenders);
      expect(nativeMessageRenderCounts.get("assistant-1")).toBe(firstAssistantRenders);
    });

    test("keeps earlier transcript rows stable while a new tool call streams", async () => {
      fixtureState.renderVirtualizedMessages = true;
      const tabId = "tab-stable-transcript-stream";
      const sessionKey = createSessionKey("env-1", tabId);
      seedProjection({
        phase: "running",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Inspect the renderer",
            parts: [{ type: "text", content: "Inspect the renderer" }],
            createdAt: "2026-08-14T10:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "I am checking it.",
            parts: [{ type: "text", content: "I am checking it." }],
            createdAt: "2026-08-14T10:00:01.000Z",
            turnId: "turn-1",
          },
          {
            id: "assistant-2",
            role: "assistant",
            content: "Still looking.",
            parts: [{ type: "text", content: "Still looking." }],
            createdAt: "2026-08-14T10:00:02.000Z",
            turnId: "turn-1",
          },
        ],
      });
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);

      await waitFor(() => expect(latestRenderedMessageActions.get("user-1")).toBeTruthy());
      await waitFor(() => expect(latestRenderedMessageActions.get("assistant-1")).toBeTruthy());
      const firstUserAction = latestRenderedMessageActions.get("user-1");
      const firstAssistantAction = latestRenderedMessageActions.get("assistant-1");
      const firstRenderCount = virtualizedMessageListRenderCount;
      const firstUserRenders = nativeMessageRenderCounts.get("user-1");
      const firstAssistantRenders = nativeMessageRenderCounts.get("assistant-1");

      // A streaming tool row rebuilds forkPlan and renderMessageActions. Earlier
      // rows stay skippable only if renderForkAction's cache — and every other
      // NativeMessage prop — survives that frame.
      const current = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;
      act(() => {
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProjection(sessionKey, {
            ...current,
            revision: current.revision + 1,
            messages: [
              ...current.messages,
              {
                id: "assistant-tool-1",
                role: "assistant",
                content: "",
                parts: [
                  {
                    type: "tool-invocation",
                    content: "Read",
                    toolName: "Read",
                    toolUseId: "tool-read-1",
                    toolState: "pending",
                  },
                ],
                createdAt: "2026-08-14T10:00:03.000Z",
              },
            ],
          });
      });
      await waitFor(() =>
        expect(virtualizedMessageListRenderCount).toBeGreaterThan(firstRenderCount),
      );
      await waitFor(() => expect(latestRenderedMessageActions.has("assistant-tool-1")).toBe(true));

      expect(latestRenderedMessageActions.get("user-1")).toBe(firstUserAction);
      expect(latestRenderedMessageActions.get("assistant-1")).toBe(firstAssistantAction);
      expect(nativeMessageRenderCounts.get("user-1")).toBe(firstUserRenders);
      expect(nativeMessageRenderCounts.get("assistant-1")).toBe(firstAssistantRenders);
    });

    test("in-tab OpenCode response forks adopt the source composer controls", async () => {
      fixtureState.renderVirtualizedMessages = true;
      const controls = {
        modelId: "opencode-go/deepseek-v4-flash",
        reasoningId: "high",
        executionProfileId: "reviewer",
      };
      forkNativeAgentSessionMock.mockImplementation(async () => ({
        sessionId: "opencode-fork",
        controls,
      }));
      seedProjection({
        composer: { selectedModelId: controls.modelId, selectedReasoningId: controls.reasoningId },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="opencode-source" data={identity("opencode")} isActive />,
      );
      const forkButton = await screen.findByRole("button", { name: /Fork.*response/i });
      fireEvent.click(forkButton);
      await waitFor(() =>
        expect(adoptNativeAgentSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: "opencode",
            providerSessionId: "opencode-fork",
            controls,
          }),
        ),
      );
      expect(forkNativeAgentSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "opencode", messageId: undefined }),
      );
    });

    test("keeps a catalog-omitted Pi selection visible on the locked Pi picker", async () => {
      seedProjection({
        composer: {
          models: [
            {
              platform: "pi",
              id: "google/gemini-3-flash",
              label: "Gemini 3 Flash",
              reasoning: [{ id: "high", label: "High" }],
              defaultReasoningId: "high",
            },
          ],
          selectedModelId: "anthropic/claude-opus-4-5",
          selectedReasoningId: "default",
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-pi-omitted-model" data={identity("pi")} isActive />,
      );

      const trigger = await screen.findByTitle(/Choose model/);
      expect(trigger.getAttribute("aria-label")).toContain("claude-opus-4-5");
      fireEvent.pointerDown(trigger);
      expect(screen.getByRole("menuitemradio", { name: /claude-opus-4-5/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "opencode models" }) === null).toBe(true);
      expect(document.querySelector('[data-native-model-row-platform="opencode"]') === null).toBe(
        true,
      );
      expect(document.querySelector('[data-native-model-row-platform="pi"]')).toBeTruthy();
    });

    test("deduplicates a projection-recovered background Agent and rehydrates it", async () => {
      seedProjection({
        backgroundTasks: [
          {
            id: "child-task",
            description: "Review the bridge",
            status: "running",
          },
        ],
        messages: [
          {
            id: "assistant-background-agent",
            role: "assistant",
            content: "",
            createdAt: "2026-08-16T10:00:00.000Z",
            parts: [
              {
                type: "tool-invocation",
                content: "Agent",
                toolName: "Agent",
                toolUseId: "agent-launch",
                backgroundTaskId: "child-task",
                toolState: "success",
                toolArgs: {
                  description: "Review the bridge",
                  run_in_background: true,
                },
              },
            ],
          },
        ],
      });

      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-claude-background-agent"
          data={identity("claude")}
          isActive={false}
        />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(screen.queryByRole("button", { name: /Review the bridge/ }) === null).toBe(true);

      view.rerender(
        <AgentNativeTab tabId="tab-claude-background-agent" data={identity("claude")} isActive />,
      );
      expect(
        await screen.findByRole("status", {
          name: "1 background task running: Review the bridge.",
        }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Task Review the bridge/ }) === null).toBe(true);

      view.unmount();
      appCommandStore(nativeAgentProjectionStore).getState().reset();
      sessionProjectionMock.mockClear();
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-claude-background-agent" data={identity("claude")} isActive />,
      );
      expect(
        await screen.findByRole("status", {
          name: "1 background task running: Review the bridge.",
        }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Task Review the bridge/ }) === null).toBe(true);
    });

    test("renders a rowless live task as one stoppable transcript card", async () => {
      /*
       * Paint the virtualized rows for this integration boundary: the adapter
       * builds the missing row, the controller supplies it to the transcript,
       * and the real NativeMessage card must wire Stop back to the provider.
       */
      fixtureState.renderVirtualizedMessages = true;
      seedProjection({
        backgroundTasks: [
          {
            id: "orphan-task",
            description: "Watch the server",
            status: "running",
          },
        ],
        messages: [],
      });

      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-claude-orphan-task" data={identity("claude")} isActive />,
      );

      expect(
        await screen.findByRole("status", {
          name: "1 background task running: Watch the server.",
        }),
      ).toBeTruthy();
      expect(
        screen.getAllByRole("button", {
          name: /Task Watch the server Running/,
        }),
      ).toHaveLength(1);
      expect(
        screen.getAllByRole("button", {
          name: "Stop Watch the server",
        }),
      ).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Stop Watch the server" }));
      await waitFor(() =>
        expect(stopNativeAgentBackgroundTaskMock).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: "orphan-task" }),
        ),
      );
    });

    test("withdraws a foreground command's task card when its snapshot settles", async () => {
      fixtureState.renderVirtualizedMessages = true;
      const tabId = "tab-claude-foreground-task-transition";
      const sessionKey = createSessionKey("env-1", tabId);
      const task = {
        id: "foreground-suite",
        toolUseId: "bash-foreground-suite",
        description: "Run the tests",
        status: "running" as const,
      };
      seedProjection({
        backgroundTasks: [task],
        messages: [
          {
            id: "assistant-foreground-command",
            role: "assistant",
            content: "",
            createdAt: "2026-08-16T10:00:00.000Z",
            parts: [
              {
                type: "tool-invocation",
                content: "Bash",
                toolName: "Bash",
                toolUseId: task.toolUseId,
                toolState: "success",
                toolArgs: { command: "bun test", description: task.description },
              },
            ],
          },
        ],
      });
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);

      expect(
        await screen.findAllByRole("button", { name: /Task Run the tests Running/ }),
      ).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Stop Run the tests" })).toBeTruthy();

      const projection = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;
      act(() => {
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProjection(sessionKey, {
            ...projection,
            revision: projection.revision + 1,
            backgroundTasks: [
              {
                ...task,
                status: "completed",
                settledAt: "2026-08-16T10:01:00.000Z",
              },
            ],
          });
      });

      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /Task Run the tests/ }) === null).toBe(true),
      );
      expect(screen.queryByRole("button", { name: "Stop Run the tests" }) === null).toBe(true);
      expect(screen.getAllByText("bun test")).toHaveLength(1);
    });

    test("places a rowless task that settled inside the loaded window", async () => {
      /*
       * The other half of the rowless path, end to end: a task that stopped
       * while the reader could see it keeps a card, and holds the position the
       * backend recorded rather than falling to the bottom of the transcript.
       * The row the tab synthesised is not itself a position, so it must land
       * under the real transcript row it settled after, not under the earlier
       * rowless card.
       */
      fixtureState.renderVirtualizedMessages = true;
      const transcriptRow = (id: string, createdAt: string): NativeMessage => ({
        id,
        role: "assistant",
        content: "",
        createdAt,
        parts: [{ type: "text", content: id }],
      });
      seedProjection({
        backgroundTasks: [
          {
            id: "settled-early",
            description: "Build the image",
            status: "completed",
            settledAt: "2026-08-16T10:00:30.000Z",
          },
          {
            id: "settled-late",
            description: "Run the suite",
            status: "completed",
            settledAt: "2026-08-16T10:01:30.000Z",
          },
          {
            id: "settled-before-window",
            description: "Ancient task",
            status: "completed",
            settledAt: "2026-08-16T09:00:00.000Z",
          },
        ],
        messages: [
          transcriptRow("assistant-1", "2026-08-16T10:00:00.000Z"),
          transcriptRow("assistant-2", "2026-08-16T10:01:00.000Z"),
        ],
      });

      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-claude-settled-task" data={identity("claude")} isActive />,
      );

      expect(
        await screen.findByRole("button", {
          name: /Task Build the image/,
        }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: /Task Run the suite/ })).toBeTruthy();
      // It settled before anything the reader can see, so it has no position
      // here and no card — the transcript never mentioned it.
      expect(screen.queryByRole("button", { name: /Task Ancient task/ }) === null).toBe(true);

      const rows = [...screen.getByTestId("native-agent-transcript-test-list").children].map(
        (row) => row.textContent ?? "",
      );
      const indexOf = (needle: string) => {
        const index = rows.findIndex((row) => row.includes(needle));
        // An ordering assertion against a missing row compares -1 and passes
        // for the wrong reason, so absence fails here instead.
        if (index < 0) throw new Error(`no transcript row contains "${needle}"`);
        return index;
      };

      // Each card sits after the row the conversation had reached when the
      // backend recorded it stopping, not at the bottom with the other.
      expect(indexOf("assistant-1")).toBeLessThan(indexOf("Build the image"));
      expect(indexOf("Build the image")).toBeLessThan(indexOf("assistant-2"));
      expect(indexOf("assistant-2")).toBeLessThan(indexOf("Run the suite"));
    });

    test("keeps reporting the task once the transcript renders its launch", async () => {
      /*
       * The synthesised row exists only because the transcript cannot show the
       * task. The moment the launch row arrives it withdraws, since keeping both
       * would put two stop controls on screen for one task with nothing to tell
       * the reader which is which — `native-message-adapters.test.ts` asserts
       * that handover directly, because neither card is paintable here.
       */
      const launchRow = {
        id: "assistant-late-launch",
        role: "assistant" as const,
        content: "",
        createdAt: "2026-08-16T10:00:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolUseId: "bash-launch",
            toolState: "success",
            toolArgs: {
              command: "bun run dev",
              description: "Run the dev server",
              run_in_background: true,
            },
          },
        ],
      };
      const seed = (messages: unknown[]) =>
        seedProjection({
          backgroundTasks: [
            {
              id: "bg-dev",
              toolUseId: "bash-launch",
              description: "Run the dev server",
              status: "running",
            },
          ],
          messages: messages as never,
        });

      seed([]);
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-claude-fallback-retire"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );

      expect(
        await screen.findByRole("status", {
          name: "1 background task running: Run the dev server.",
        }),
      ).toBeTruthy();

      seed([launchRow]);
      view.rerender(
        <AgentNativeTab
          tabId="tab-claude-fallback-retire"
          data={identity("claude")}
          isActive
          refreshRequestId={1}
        />,
      );

      // The task is still live, and the tab still says so — now on the strength
      // of the launch row the transcript finally supplied.
      expect(
        await screen.findByRole("status", {
          name: "1 background task running: Run the dev server.",
        }),
      ).toBeTruthy();
    });

    test("announces background task pause and stop lifecycle accurately", async () => {
      const seedBackgroundStatus = (status: "running" | "paused" | "killed") =>
        seedProjection({
          backgroundTasks: [
            {
              id: "bg-suite",
              toolUseId: "bash-launch",
              description: "Run the full suite",
              status,
            },
          ],
          messages: [
            {
              id: "assistant-background-command",
              role: "assistant",
              content: "",
              createdAt: "2026-08-16T10:00:00.000Z",
              parts: [
                {
                  type: "tool-invocation",
                  content: "Bash",
                  toolName: "Bash",
                  toolUseId: "bash-launch",
                  toolState: "success",
                  toolArgs: {
                    command: "bun test",
                    description: "Run the full suite",
                    run_in_background: true,
                  },
                },
              ],
            },
          ],
        });

      seedBackgroundStatus("running");
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-claude-task-announcement"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );
      expect(
        await screen.findByRole("status", {
          name: "1 background task running: Run the full suite.",
        }),
      ).toBeTruthy();

      seedBackgroundStatus("paused");
      view.rerender(
        <AgentNativeTab
          tabId="tab-claude-task-announcement"
          data={identity("claude")}
          isActive
          refreshRequestId={1}
        />,
      );
      expect(
        await screen.findByRole("status", {
          name: "Run the full suite paused.",
        }),
      ).toBeTruthy();

      seedBackgroundStatus("killed");
      view.rerender(
        <AgentNativeTab
          tabId="tab-claude-task-announcement"
          data={identity("claude")}
          isActive
          refreshRequestId={2}
        />,
      );
      expect(
        await screen.findByRole("status", {
          name: "Run the full suite stopped.",
        }),
      ).toBeTruthy();
    });

    test("announces an active Cursor Task pinned to the transcript", async () => {
      seedProjection({
        messages: [
          {
            id: "assistant-cursor-subagent",
            role: "assistant",
            content: "Parent response complete",
            createdAt: "2026-08-15T10:00:00.000Z",
            parts: [
              {
                type: "tool-invocation",
                content: "Task: Validate the implementation",
                toolName: "task",
                toolTitle: "Task: Validate the implementation",
                toolUseId: "cursor-subagent-1",
                toolState: "success",
                agentState: "active",
                toolArgs: { description: "Validate the implementation" },
              },
            ],
          },
        ],
      });

      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-cursor-subagent" data={identity("cursor")} isActive />,
      );

      await screen.findByRole("textbox");
      expect(
        await screen.findByRole("status", {
          name: "1 sub-agent working: Validate the implementation.",
        }),
      ).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      expect(screen.getByTestId("transcript-bottom-spacer").className).toContain("h-32");
    });

    test("announces and rehydrates an active Grok Build sub-agent", async () => {
      seedProjection({
        messages: [
          {
            id: "assistant-grok-subagent",
            role: "assistant",
            content: "Parent response complete",
            createdAt: "2026-08-15T10:00:00.000Z",
            parts: [
              {
                type: "tool-invocation",
                content: "Launch validation agent",
                toolName: "spawn_subagent",
                toolTitle: "Launch validation agent",
                toolUseId: "grok-subagent-1",
                toolState: "success",
                agentState: "active",
                toolArgs: {
                  variant: "Task",
                  run_in_background: true,
                  description: "Validate the implementation",
                  subagent_type: "explore",
                },
              },
            ],
          },
        ],
      });

      const view = renderInAppCommandScope(
        <AgentNativeTab tabId="tab-grok-subagent" data={identity("grok")} isActive={false} />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(screen.queryByRole("button", { name: /Validate the implementation/i }) === null).toBe(
        true,
      );

      await act(async () => {
        view.rerender(
          <AgentNativeTab tabId="tab-grok-subagent" data={identity("grok")} isActive />,
        );
      });

      await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
      expect(
        await screen.findByRole("status", {
          name: "1 sub-agent working: Validate the implementation.",
        }),
      ).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      expect(screen.getByTestId("transcript-bottom-spacer").className).toContain("h-32");

      // Simulate leaving the environment and then reloading the renderer: the
      // in-memory projection is gone, so the transcript row must rehydrate from
      // the next authoritative snapshot rather than a live event the old tree observed.
      view.unmount();
      appCommandStore(nativeAgentProjectionStore).getState().reset();
      sessionProjectionMock.mockClear();
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-grok-subagent" data={identity("grok")} isActive />,
      );

      await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
      expect(
        await screen.findByRole("status", {
          name: "1 sub-agent working: Validate the implementation.",
        }),
      ).toBeTruthy();
      expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      expect(sessionProjectionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "grok",
          logicalSessionKey: createSessionKey("env-1", "tab-grok-subagent"),
        }),
      );
    });

    test.each([
      ["finished", "finished"],
      ["failed", "failed"],
    ] as const)(
      "announces a Cursor Task lifecycle that becomes %s",
      async (agentState, announcementState) => {
        const tabId = `tab-cursor-subagent-${agentState}`;
        seedProjection({
          messages: [
            {
              id: "assistant-cursor-subagent-transition",
              role: "assistant",
              content: "",
              createdAt: "2026-08-15T10:00:00.000Z",
              parts: [
                {
                  type: "tool-invocation",
                  content: "Task: Validate the implementation",
                  toolName: "task",
                  toolUseId: "cursor-subagent-1",
                  toolState: "success",
                  agentState: "active",
                  toolArgs: { description: "Validate the implementation" },
                },
              ],
            },
          ],
        });

        const view = renderInAppCommandScope(
          <AgentNativeTab tabId={tabId} data={identity("cursor")} isActive refreshRequestId={0} />,
        );
        await screen.findByRole("textbox");
        expect(
          await screen.findByRole("status", {
            name: "1 sub-agent working: Validate the implementation.",
          }),
        ).toBeTruthy();

        seedProjection({
          messages: [
            {
              id: "assistant-cursor-subagent-transition",
              role: "assistant",
              content: "",
              createdAt: "2026-08-15T10:00:00.000Z",
              parts: [
                {
                  type: "tool-invocation",
                  content: "Task: Validate the implementation",
                  toolName: "task",
                  toolUseId: "cursor-subagent-1",
                  toolState: "success",
                  agentState,
                  toolArgs: { description: "Validate the implementation" },
                },
              ],
            },
          ],
        });
        view.rerender(
          <AgentNativeTab tabId={tabId} data={identity("cursor")} isActive refreshRequestId={1} />,
        );

        await waitFor(() =>
          expect(firstPartAgentState(createSessionKey("env-1", tabId))).toBe(agentState),
        );
        expect(
          await screen.findByRole("status", {
            name: `Validate the implementation ${announcementState}.`,
          }),
        ).toBeTruthy();
        expect(screen.queryByTestId("active-subagent-rail") === null).toBe(true);
      },
    );

    /**
     * The restart half of the stuck-Review-tab incident. The bridge maps an
     * in-flight prompt to an error whose outcome is unknown, and the Task card
     * to a settled state — the tab has to follow the snapshot rather than the
     * last "thinking" event the previous tree observed.
     */
    test("drops the thinking indicator and the Active badge when the bridge reports an unknown outcome", async () => {
      const tabId = "tab-cursor-subagent-restart";
      const activeTask = {
        type: "tool-invocation" as const,
        content: "Task: Run snapshot validation",
        toolName: "task",
        toolUseId: "cursor-subagent-1",
        toolState: "success" as const,
        agentState: "active" as const,
        toolArgs: { description: "Run snapshot validation" },
      };
      seedProjection({
        phase: "running",
        messages: [
          {
            id: "assistant-cursor-subagent-restart",
            role: "assistant",
            content: "",
            createdAt: "2026-08-24T14:30:00.000Z",
            parts: [activeTask],
          },
        ],
      });

      const view = renderInAppCommandScope(
        <AgentNativeTab tabId={tabId} data={identity("cursor")} isActive refreshRequestId={0} />,
      );
      await screen.findByRole("textbox");
      expect(
        await screen.findByRole("status", {
          name: "1 sub-agent working: Run snapshot validation.",
        }),
      ).toBeTruthy();
      // A launch that succeeded with a background child still running is the
      // one case where `toolState: "success"` must stay Active.
      await waitFor(() =>
        expect(screen.queryByText("Cursor Agent is thinking...") === null).toBe(false),
      );

      seedProjection({
        phase: "error",
        messages: [
          {
            id: "assistant-cursor-subagent-restart",
            role: "assistant",
            content: "",
            createdAt: "2026-08-24T14:30:00.000Z",
            parts: [{ ...activeTask, agentState: "failed" as const }],
          },
        ],
      });
      view.rerender(
        <AgentNativeTab tabId={tabId} data={identity("cursor")} isActive refreshRequestId={1} />,
      );

      await waitFor(() =>
        expect(firstPartAgentState(createSessionKey("env-1", tabId))).toBe("failed"),
      );
      // Transcript and session state are separate reads: the failed row can
      // land a moment before the turn's error phase does.
      await waitFor(() => {
        expect(screen.queryByText("Cursor Agent is thinking...") === null).toBe(true);
        expect(
          screen.queryByRole("status", {
            name: "1 sub-agent working: Run snapshot validation.",
          }) === null,
        ).toBe(true);
      });
      expect(
        await screen.findByRole("status", { name: "Run snapshot validation failed." }),
      ).toBeTruthy();
    });

    /** One assistant row carrying `count` identically-labelled active children. */
    function subagentMessage(
      count: number,
      state: (index: number) => "active" | "finished" | "failed",
    ): NativeMessage {
      return {
        id: "assistant-many-subagents",
        role: "assistant",
        content: "Parent response complete",
        createdAt: "2026-08-15T10:00:00.000Z",
        parts: Array.from({ length: count }, (_unused, index) => ({
          type: "tool-invocation" as const,
          content: "Task",
          toolName: "task",
          toolUseId: `shared-label-task-${index}`,
          toolState: "success" as const,
          agentState: state(index),
          toolArgs: { description: "Sub-agent" },
        })),
      };
    }

    test("announces the plural active summary and a simultaneous finish and start", async () => {
      seedProjection({
        messages: [subagentMessage(2, () => "active")],
      });

      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-plural-subagents"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );

      expect(
        await screen.findByRole("status", {
          name: "2 sub-agents working: Sub-agent, Sub-agent.",
        }),
      ).toBeTruthy();

      // The first child finishes in the same update that starts a third one, so
      // the lifecycle line and the refreshed summary must both be announced.
      seedProjection({
        messages: [subagentMessage(3, (index) => (index === 0 ? "finished" : "active"))],
      });
      view.rerender(
        <AgentNativeTab
          tabId="tab-plural-subagents"
          data={identity("cursor")}
          isActive
          refreshRequestId={1}
        />,
      );

      expect(
        await screen.findByRole("status", {
          name: "Sub-agent finished. 2 sub-agents working: Sub-agent, Sub-agent.",
        }),
      ).toBeTruthy();
    });

    test("re-announces an identical lifecycle message for a second child", async () => {
      // Both children resolve to the same label, so the second "finished" line is
      // byte-identical to the first. It still has to reach the live region.
      seedProjection({ messages: [subagentMessage(2, () => "active")] });

      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-repeat-announcement"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );
      await screen.findByRole("status", {
        name: "2 sub-agents working: Sub-agent, Sub-agent.",
      });

      const liveRegionText = () =>
        screen.getByRole("status", { name: /Sub-agent/ }).firstElementChild;

      seedProjection({
        messages: [subagentMessage(2, (index) => (index === 0 ? "finished" : "active"))],
      });
      view.rerender(
        <AgentNativeTab
          tabId="tab-repeat-announcement"
          data={identity("cursor")}
          isActive
          refreshRequestId={1}
        />,
      );
      const firstFinish = await screen.findByRole("status", {
        name: "Sub-agent finished.",
      });
      const firstNode = liveRegionText();

      seedProjection({ messages: [subagentMessage(2, () => "finished")] });
      view.rerender(
        <AgentNativeTab
          tabId="tab-repeat-announcement"
          data={identity("cursor")}
          isActive
          refreshRequestId={2}
        />,
      );

      await waitFor(() => expect(liveRegionText() === firstNode).toBe(false));
      expect(screen.getByRole("status", { name: "Sub-agent finished." })).toBe(firstFinish);
      expect(liveRegionText()?.textContent).toBe("Sub-agent finished.");
    });

    test("routes native notices through the global toast system", async () => {
      seedProjection({
        notices: [{ kind: "warning", message: "Recovered provider notice" }],
      });

      renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-pinned-notice"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );

      await waitFor(() =>
        expect(mockToastWarning).toHaveBeenCalledWith(
          "Recovered provider notice",
          expect.objectContaining({ duration: Infinity }),
        ),
      );
      expect(screen.queryByText("Recovered provider notice") === null).toBe(true);
      expect(screen.getByTestId("transcript-bottom-spacer").className).toContain("h-32");
    });

    test("dismisses notice toasts while their tab is inactive and restores them on return", async () => {
      seedProjection({
        notices: [{ kind: "warning", message: "Recovered provider notice" }],
      });
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-active-notice"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      const toastId = (mockToastWarning.mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id;

      view.rerender(
        <AgentNativeTab
          tabId="tab-active-notice"
          data={identity("cursor")}
          isActive={false}
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith(toastId));

      view.rerender(
        <AgentNativeTab
          tabId="tab-active-notice"
          data={identity("cursor")}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(2));
    });

    test("dismisses each open notice toast exactly once on unmount", async () => {
      seedProjection({
        notices: [{ kind: "warning", message: "Recovered provider notice" }],
      });
      const view = renderInAppCommandScope(
        <StrictMode>
          <AgentNativeTab
            tabId="tab-unmount-notice"
            data={identity("cursor")}
            isActive
            refreshRequestId={0}
          />
        </StrictMode>,
      );
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      const toastId = (mockToastWarning.mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id;
      mockToastDismiss.mockClear();

      view.unmount();
      await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledTimes(1));
      expect(mockToastDismiss).toHaveBeenCalledWith(toastId);
    });

    test("refines the running indicator with the provider's reported activity", async () => {
      seedProjection({ phase: "running", turnActivity: { thinkingTokens: 1_200 } });
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-turn-activity"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );
      expect(
        (await screen.findByText(/is thinking\.\.\./)).closest('[role="status"]')?.textContent,
      ).toContain("~1.2k tokens");

      // Compaction outranks thinking: it is the reason nothing is moving.
      seedProjection({
        phase: "running",
        turnActivity: { compacting: true, thinkingTokens: 1_200 },
      });
      view.rerender(
        <AgentNativeTab
          tabId="tab-turn-activity"
          data={identity("claude")}
          isActive
          refreshRequestId={1}
        />,
      );
      expect(await screen.findByText("Compacting conversation…")).toBeTruthy();
    });

    test("dismisses the reconnect toast as soon as the session recovers", async () => {
      seedProjection({
        connection: "connecting",
        phase: "recovering",
        notices: [{ kind: "recovery", message: "Reconnecting to the native agent runtime…" }],
      });
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-recovery-toast"
          data={identity("codex")}
          isActive
          refreshRequestId={0}
        />,
      );

      await waitFor(() =>
        expect(mockToastLoading).toHaveBeenCalledWith(
          "Reconnecting to the native agent runtime…",
          expect.objectContaining({ duration: Infinity }),
        ),
      );
      const toastId = (mockToastLoading.mock.calls.at(-1)?.[1] as { id?: unknown } | undefined)?.id;

      seedProjection({ connection: "connected", phase: "idle", notices: [] });
      view.rerender(
        <AgentNativeTab
          tabId="tab-recovery-toast"
          data={identity("codex")}
          isActive
          refreshRequestId={1}
        />,
      );

      await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith(toastId));
    });

    test("uses the matching toast severity and persists a user dismissal", async () => {
      seedProjection({
        notices: [
          { kind: "warning", message: "First provider notice" },
          { kind: "advisory", message: "Second provider notice", severity: "error" },
        ],
      });

      renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-dismissible-notices"
          data={identity("codex")}
          isActive
          refreshRequestId={0}
        />,
      );

      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      expect(mockToastError).toHaveBeenCalledWith(
        "Second provider notice",
        expect.objectContaining({ duration: Infinity }),
      );
      const warningOptions = mockToastWarning.mock.calls.at(-1)?.[1] as
        { onDismiss?: () => void } | undefined;
      act(() => warningOptions?.onDismiss?.());

      await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledTimes(1));
      expect(useNativeNoticeDismissalStore.getState().sessions[0]?.occurrenceIds).toContain(
        "warning\u0000warning\u0000First provider notice",
      );
    });

    test("shows a turn-time sign-in notice as a warning the user can act on", async () => {
      seedProjection({
        notices: [
          {
            kind: "auth",
            state: "expired",
            message: "Claude's login was refused. Sign in to Claude again to keep working.",
            occurrenceId: "assistant-1",
          },
        ],
      });

      renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-auth-notice"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );

      await waitFor(() =>
        expect(mockToastWarning).toHaveBeenCalledWith(
          "Claude's login was refused. Sign in to Claude again to keep working.",
          expect.objectContaining({ duration: Infinity }),
        ),
      );
      expect(mockToastError).not.toHaveBeenCalled();
      // The warning sits beside a sign-in the user can act on, without locking
      // the composer: Claude's expired login ends the turn as an ordinary reply.
      expect(await screen.findByRole("region", { name: "Sign in to Claude" })).toBeTruthy();
      expect(screen.queryByTitle("Sign in to Claude before sending") === null).toBe(true);
    });

    test("shows Claude's sign-in card inline for a turn-time auth notice until it clears", async () => {
      // A reply that is not one of Claude's fixed refusals: only the notice
      // asks for the card, so the card lasts as long as the notice.
      const reply = "The request could not be completed.";
      const messages: NativeMessage[] = [
        {
          id: "user-1",
          role: "user",
          content: "Reply with the single word: pong",
          createdAt: "2026-10-26T00:32:00.000Z",
          parts: [{ type: "text", content: "Reply with the single word: pong" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: reply,
          createdAt: "2026-10-26T00:32:06.000Z",
          parts: [{ type: "text", content: reply }],
        },
      ];
      seedProjection({
        messages,
        notices: [
          {
            kind: "auth",
            state: "expired",
            message: "Claude's login was refused. Sign in to Claude again to keep working.",
            occurrenceId: "assistant-1",
          },
        ],
      });
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-auth-notice-card"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );
      const card = await screen.findByRole("region", { name: "Sign in to Claude" });
      expect(screen.getAllByRole("region", { name: "Sign in to Claude" })).toHaveLength(1);
      expect(screen.getByTestId("transcript-cards").contains(card)).toBe(true);

      // A real answer clears the notice on the bridge, and the card goes with it.
      seedProjection({ messages, notices: [] });
      view.rerender(
        <AgentNativeTab
          tabId="tab-auth-notice-card"
          data={identity("claude")}
          isActive
          refreshRequestId={1}
        />,
      );
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Sign in to Claude" }) === null).toBe(true),
      );
    });

    test("keeps Claude's inline sign-in card under its login refusal after the notice clears", async () => {
      // Claude Code 2.1.319 answers a login past its time limit with this
      // fixed reply. The notice that accompanies it is in-memory bridge state
      // and can go first; the reply in the transcript keeps the card.
      fixtureState.agentAccounts = {
        accounts: [
          {
            id: "work",
            platform: "claude",
            label: "Work",
            isDefault: false,
            isActive: true,
            signedIn: false,
            identity: { email: "dev@example.com" },
          },
        ],
        active: { ...EMPTY_AGENT_ACCOUNTS.active, claude: "work" },
      };
      const reply =
        "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs";
      const messages: NativeMessage[] = [
        {
          id: "user-1",
          role: "user",
          content: "OK, please go ahead",
          createdAt: "2026-11-08T22:23:00.000Z",
          parts: [{ type: "text", content: "OK, please go ahead" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: reply,
          createdAt: "2026-11-08T22:23:01.000Z",
          parts: [{ type: "text", content: reply }],
        },
      ];
      seedProjection({
        messages,
        notices: [
          {
            kind: "auth",
            state: "expired",
            message: "Claude's login was refused. Sign in to Claude again to keep working.",
            occurrenceId: "assistant-1",
          },
        ],
      });
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-auth-refusal-card"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );
      const card = await screen.findByRole("region", { name: "Sign in to Claude" });
      expect(screen.getByTestId("transcript-cards").contains(card)).toBe(true);
      // It names the login a sign-in renews: the machine's active account.
      await waitFor(() =>
        expect(within(card).getByTestId("claude-sign-in-account").textContent).toBe(
          "AccountWork (dev@example.com)",
        ),
      );

      seedProjection({ messages, notices: [] });
      const reads = sessionProjectionMock.mock.calls.length;
      view.rerender(
        <AgentNativeTab
          tabId="tab-auth-refusal-card"
          data={identity("claude")}
          isActive
          refreshRequestId={1}
        />,
      );
      // The notice-free snapshot has been read and settled.
      await waitFor(() => expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(reads));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getAllByRole("region", { name: "Sign in to Claude" })).toHaveLength(1);

      // Once the user sends again the refusal is history, and so is the card.
      const resent: NativeMessage = {
        id: "user-2",
        role: "user",
        content: "Try again",
        createdAt: "2026-11-08T22:30:00.000Z",
        parts: [{ type: "text", content: "Try again" }],
      };
      seedProjection({ messages: [...messages, resent], notices: [] });
      view.rerender(
        <AgentNativeTab
          tabId="tab-auth-refusal-card"
          data={identity("claude")}
          isActive
          refreshRequestId={2}
        />,
      );
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Sign in to Claude" }) === null).toBe(true),
      );
    });

    test("Claude notice timestamps reject an old sign-in when a new failure occurrence replaces it", async () => {
      const timestamp = spyOn(Date.prototype, "toISOString").mockReturnValue(
        "2026-10-26T10:00:00.000Z",
      );
      fixtureState.accountLoginProgress = {
        state: "succeeded",
        platform: "claude",
        mode: "reauthenticate",
        completedAt: "2026-10-26T10:01:00.000Z",
      };
      const notice = (occurrenceId: string) => ({
        kind: "auth" as const,
        state: "expired" as const,
        message: "Claude login failed",
        occurrenceId,
      });
      try {
        seedProjection({ notices: [notice("failure-1")] });
        const view = renderInAppCommandScope(
          <AgentNativeTab
            tabId="tab-claude-new-failure"
            data={identity("claude")}
            isActive
            refreshRequestId={0}
          />,
        );
        await screen.findByText("Signed in. Resend your message to continue.");
        timestamp.mockReturnValue("2026-10-26T10:02:00.000Z");
        seedProjection({ notices: [notice("failure-1")] });
        view.rerender(
          <AgentNativeTab
            tabId="tab-claude-new-failure"
            data={identity("claude")}
            isActive
            refreshRequestId={1}
          />,
        );
        // Re-reading the same occurrence preserves when it was first seen.
        expect(await screen.findByText("Signed in. Resend your message to continue.")).toBeTruthy();
        seedProjection({ notices: [notice("failure-2")] });
        const reads = getAgentAccountLoginMock.mock.calls.length;
        view.rerender(
          <AgentNativeTab
            tabId="tab-claude-new-failure"
            data={identity("claude")}
            isActive
            refreshRequestId={2}
          />,
        );
        await waitFor(() =>
          expect(getAgentAccountLoginMock.mock.calls.length).toBeGreaterThan(reads),
        );
        expect(screen.queryByText("Signed in. Resend your message to continue.") === null).toBe(
          true,
        );
        expect(screen.getByRole("button", { name: "Sign in to Claude" })).toBeTruthy();
      } finally {
        timestamp.mockRestore();
      }
    });

    test("does not pin a second Claude sign-in card over a terminal auth error row", async () => {
      seedProjection({
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "hello",
            createdAt: "2026-10-26T00:32:00.000Z",
            parts: [{ type: "text", content: "hello" }],
          },
          {
            id: "native-terminal:error:turn-1",
            role: "system",
            content: "Failed to authenticate. API Error: 401",
            createdAt: "2026-10-26T00:32:06.000Z",
            parts: [{ type: "text", content: "Failed to authenticate. API Error: 401" }],
          },
        ],
        notices: [
          {
            kind: "auth",
            state: "expired",
            message: "Claude's login was refused. Sign in to Claude again to keep working.",
            occurrenceId: "turn-1",
          },
        ],
      });
      renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-auth-notice-row"
          data={identity("claude")}
          isActive
          refreshRequestId={0}
        />,
      );
      // The notice has arrived; the row's own card (rendered by the transcript,
      // which happy-dom does not lay out) answers it, so nothing is pinned.
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
      expect(screen.queryByRole("region", { name: "Sign in to Claude" }) === null).toBe(true);
    });

    test("persists a dismissed occurrence but shows a newer occurrence and another session", async () => {
      const tabId = "tab-notice-lifecycle";
      const notice = (occurrenceId: string) => [
        {
          kind: "advisory" as const,
          message: "Codex reported warning",
          severity: "warning" as const,
          occurrenceId,
        },
      ];
      seedProjection({ sessionId: "session-a", notices: notice("occurrence-1") });

      let view = renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      const firstOptions = mockToastWarning.mock.calls.at(-1)?.[1] as
        { onDismiss?: () => void } | undefined;
      act(() => firstOptions?.onDismiss?.());

      view.unmount();
      appCommandStore(nativeAgentProjectionStore).getState().reset();
      sessionProjectionMock.mockClear();
      mockToastWarning.mockClear();
      view = renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
      expect(mockToastWarning).not.toHaveBeenCalled();

      seedProjection({ sessionId: "session-a", notices: notice("occurrence-2") });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={1}
        />,
      );
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      const secondOptions = mockToastWarning.mock.calls.at(-1)?.[1] as
        { onDismiss?: () => void } | undefined;
      act(() => secondOptions?.onDismiss?.());

      seedProjection({ sessionId: "session-b", notices: notice("occurrence-2") });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-b" }}
          isActive
          refreshRequestId={2}
        />,
      );
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(2));
    });

    test("keeps a repeated active condition dismissed until a clean snapshot retires it", async () => {
      const tabId = "tab-stable-notice-lifecycle";
      const notice = {
        kind: "advisory" as const,
        message: "github MCP failed to start",
        severity: "error" as const,
        occurrenceId: "mcp:thread-1:github",
      };
      seedProjection({ sessionId: "session-a", notices: [notice] });

      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
      const firstOptions = mockToastError.mock.calls.at(-1)?.[1] as
        { onDismiss?: () => void } | undefined;
      act(() => firstOptions?.onDismiss?.());
      mockToastError.mockClear();

      seedProjection({ sessionId: "session-a", notices: [notice] });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={1}
        />,
      );
      expect(mockToastError).not.toHaveBeenCalled();

      seedProjection({ sessionId: "session-a", notices: [] });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={2}
        />,
      );
      await waitFor(() =>
        expect(
          useNativeNoticeDismissalStore
            .getState()
            .sessions.some((session) => session.sessionIdentity.includes("session-a")),
        ).toBe(false),
      );

      seedProjection({ sessionId: "session-a", notices: [notice] });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={3}
        />,
      );
      await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    });

    test("does not retire a dismissal from an unavailable runtime-health snapshot", async () => {
      const tabId = "tab-unavailable-notice-health";
      const notice = {
        kind: "advisory" as const,
        message: "github MCP failed to start",
        severity: "error" as const,
        occurrenceId: "mcp:thread-1:github",
      };
      seedProjection({
        sessionId: "session-a",
        notices: [notice],
        runtimeHealthAuthoritative: true,
      });
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
      const options = mockToastError.mock.calls.at(-1)?.[1] as
        { onDismiss?: () => void } | undefined;
      act(() => options?.onDismiss?.());
      mockToastError.mockClear();

      seedProjection({
        sessionId: "session-a",
        notices: [],
        runtimeHealthAuthoritative: false,
      });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={1}
        />,
      );
      await waitFor(() =>
        expect(
          useNativeNoticeDismissalStore
            .getState()
            .sessions.some((session) => session.sessionIdentity.includes("session-a")),
        ).toBe(true),
      );

      seedProjection({
        sessionId: "session-a",
        notices: [notice],
        runtimeHealthAuthoritative: true,
      });
      view.rerender(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("codex"), sessionId: "session-a" }}
          isActive
          refreshRequestId={2}
        />,
      );
      expect(mockToastError).not.toHaveBeenCalled();
    });

    test("routes a running-turn /steer to the session action instead of the queue", async () => {
      seedProjection({ phase: "running", actions: { steer: true } });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-steer" data={identity("codex")} isActive />,
      );

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "/steer keep the diff small" } });
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore)
            .getState()
            .drafts.get(createSessionKey("env-1", "tab-steer"))?.text,
        ).toBe("/steer keep the diff small"),
      );

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalled());
      expect(performNativeAgentSessionActionMock.mock.calls.at(-1)?.[0]).toMatchObject({
        agent: "codex",
        action: { kind: "steer", text: "keep the diff small" },
      });
      // The steering text must not also be queued as a follow-up prompt.
      expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    });

    for (const [deliveredAs, message] of [
      ["new-turn", "Codex finished the turn first, so your message was sent as a new turn."],
      ["queued", "Your message missed the active turn, so it was queued as the next turn."],
    ] as const) {
      test(`a /steer the backend delivered as ${deliveredAs} clears the draft without an error`, async () => {
        seedProjection({ phase: "running", actions: { steer: true } });
        performNativeAgentSessionActionMock.mockResolvedValueOnce({
          outcome: "applied",
          deliveredAs,
          requestId: "turn-1",
        });
        renderInAppCommandScope(
          <AgentNativeTab tabId={`tab-steer-${deliveredAs}`} data={identity("codex")} isActive />,
        );
        const sessionKey = createSessionKey("env-1", `tab-steer-${deliveredAs}`);
        const input = await screen.findByRole("textbox");
        fireEvent.input(input, { target: { textContent: "/steer keep the diff small" } });
        await waitFor(() =>
          expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
            "/steer keep the diff small",
          ),
        );

        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(mockToastInfo).toHaveBeenCalledWith(message));
        // Delivered: nothing to resend, so the draft is not given back.
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text ?? "",
        ).toBe("");
        expect(screen.queryByRole("alert") === null).toBe(true);
        expect(mockToastError).not.toHaveBeenCalled();
        // The backend owns the new turn or queue item; the renderer adds neither.
        expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
        expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      });
    }

    test("steers a queued prompt through one backend handoff", async () => {
      const queued = { id: "queued-1", text: "also update the README", mode: "build" };
      seedProjection({ phase: "running", actions: { steer: true }, queue: { items: [queued] } });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-queue-steer" data={identity("codex")} isActive />,
      );
      fireEvent.click(await screen.findByTitle("View queued prompts"));
      fireEvent.click(await screen.findByRole("button", { name: "Steer" }));
      await waitFor(() => expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledTimes(1));
      expect(steerNativeAgentQueuedPromptMock.mock.calls[0]?.[0]).toMatchObject({
        agent: "codex",
        messageId: queued.id,
      });
      expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
      expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
      expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    });

    for (const outcome of [
      "idle",
      "mismatch",
      "steer-not-recorded",
      "steer-history-unavailable",
      "steer-capacity-exceeded",
      "thrown",
      "gone",
      "unknown",
    ] as const) {
      test(`queued steer reports ${outcome} without renderer queue mutations`, async () => {
        seedProjection({
          phase: "running",
          actions: { steer: true },
          queue: { items: [{ id: "queued-1", text: "also update the README" }] },
        });
        if (outcome === "thrown")
          steerNativeAgentQueuedPromptMock.mockRejectedValueOnce(new Error("Response lost"));
        else
          steerNativeAgentQueuedPromptMock.mockResolvedValueOnce(
            outcome === "gone"
              ? null
              : outcome.startsWith("steer-")
                ? {
                    outcome: "rejected",
                    reason: outcome as "steer-not-recorded",
                    requestId: "queued-1",
                  }
                : { outcome: outcome as "idle" | "mismatch" | "unknown", requestId: "queued-1" },
          );
        renderInAppCommandScope(
          <AgentNativeTab tabId={`tab-queue-${outcome}`} data={identity("codex")} isActive />,
        );
        fireEvent.click(await screen.findByTitle("View queued prompts"));
        fireEvent.click(await screen.findByRole("button", { name: "Steer" }));
        if (outcome === "unknown") {
          await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
        } else {
          const text = (await screen.findByRole("alert")).textContent ?? "";
          if (outcome === "mismatch") expect(text).toContain("turn moved on");
          if (outcome === "idle") expect(text).toContain("finished the turn");
          if (outcome === "gone") expect(text).toContain("already left the queue");
          if (outcome === "thrown") expect(text).toContain("Response lost");
          if (outcome.startsWith("steer-")) {
            expect(text).toContain(
              nativeAgentSteerRejectionMessage({ reason: outcome as "steer-not-recorded" }),
            );
            expect(text).toContain("returned to the queue");
          }
        }
        expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
        expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
      });
    }

    test("offers steer only for text prompts while a steerable turn runs", async () => {
      seedProjection({
        phase: "running",
        actions: { steer: true },
        queue: {
          items: [
            {
              id: "queued-1",
              text: "look at this",
              attachments: [{ id: "a", type: "image", path: "/tmp/shot.png" }],
            },
          ],
        },
      });
      const view = renderInAppCommandScope(
        <AgentNativeTab tabId="tab-queue-steer-gate" data={identity("codex")} isActive />,
      );
      fireEvent.click(await screen.findByTitle("View queued prompts"));
      await screen.findByTitle("Click to edit this message");
      expect(screen.queryByRole("button", { name: "Steer" }) === null).toBe(true);
      view.unmount();

      seedProjection({
        phase: "idle",
        actions: { steer: true },
        queue: { items: [{ id: "queued-2", text: "plain text" }] },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-queue-steer-idle-gate" data={identity("codex")} isActive />,
      );
      fireEvent.click(await screen.findByTitle("View queued prompts"));
      await screen.findByTitle("Click to edit this message");
      expect(screen.queryByRole("button", { name: "Steer" }) === null).toBe(true);
    });

    for (const gate of ["command", "async-answer", "parked"] as const) {
      test(`does not offer queued steer for ${gate}`, async () => {
        seedProjection({
          phase: "running",
          actions: { steer: true },
          queue: {
            items: [
              {
                id:
                  gate === "async-answer" ? nativeAsyncQuestionRequestId("question-1") : "queued-1",
                text: "queued text",
                ...(gate === "command" ? { command: { name: "review" } } : {}),
              },
            ],
          },
          ...(gate === "parked"
            ? {
                recoverableDispatch: {
                  requestId: "other-steer",
                  createdAt: new Date().toISOString(),
                  status: "action-required" as const,
                },
              }
            : {}),
        });
        renderInAppCommandScope(
          <AgentNativeTab tabId={`tab-steer-gate-${gate}`} data={identity("codex")} isActive />,
        );
        fireEvent.click(await screen.findByTitle("View queued prompts"));
        await screen.findByTitle("Click to edit this message");
        expect(screen.queryByRole("button", { name: "Steer" }) === null).toBe(true);
      });
    }

    test("queues an async-question answer with stable identity and composer settings", async () => {
      fixtureState.renderVirtualizedMessages = true;
      const itemId = "question/item-1";
      seedProjection({
        phase: "running",
        composer: {
          selectedModelId: "model-a",
          selectedReasoningId: "high",
          selectedModeId: "plan",
          fastModeAvailable: true,
          fastModeEnabled: true,
        },
        messages: [
          {
            id: "assistant-question",
            role: "assistant",
            content: "Which target?",
            parts: [
              {
                type: "async-question",
                content: "Choose the deployment target.",
                asyncQuestion: {
                  itemId,
                  questions: [
                    {
                      id: `${itemId}:0`,
                      title: "Which target?",
                      options: ["Staging", "Production"],
                    },
                  ],
                },
              },
            ],
            createdAt: "2026-09-06T10:00:00.000Z",
          },
        ],
      });
      const tabId = "tab-async-question";
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);

      fireEvent.click(await screen.findByRole("button", { name: "Send answer" }));

      await waitFor(() =>
        expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
          `codex\0${createSessionKey("env-1", tabId)}`,
          "env-1",
          expect.objectContaining({
            id: nativeAsyncQuestionRequestId(itemId),
            text: "Answers to your questions:\n\n- Which target?: Staging",
            model: "model-a",
            reasoningEffort: "high",
            mode: "plan",
            fastMode: true,
          }),
        ),
      );
    });

    test("rejects async-question delivery for non-Codex platforms", async () => {
      const enqueue = mock(async () => undefined);
      await expect(
        enqueueNativeAsyncQuestionResponse({
          platform: "pi",
          itemId: "question-1",
          response: "Answer",
          enqueue,
        }),
      ).rejects.toThrow("Only Codex supports asynchronous questions");
      expect(enqueue).not.toHaveBeenCalled();
    });

    test.each([
      ["/steer", /Add instructions after \/steer/],
      ["/steer narrow the scope", /Remove them and retry/],
    ] as const)("does not use annotations as /steer instructions for %s", async (text, error) => {
      seedProjection({ phase: "running", actions: { steer: true } });
      const tabId = `tab-steer-annotation-${text.length}`;
      const sessionKey = createSessionKey("env-1", tabId);
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      await screen.findByRole("textbox");
      act(() => {
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, {
            text,
            annotations: [
              { id: "annotation-1", text: "Do something else", comment: "Treat this as context" },
            ],
          });
      });

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      await screen.findByText(error);
      expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
      expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    });

    test("leaves unconfirmed steer recovery to the backend", async () => {
      seedProjection({ phase: "running", actions: { steer: true } });
      performNativeAgentSessionActionMock.mockImplementation(
        async () => ({ outcome: "unknown" as const }) as never,
      );
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-steer-retry" data={identity("codex")} isActive />,
      );

      const input = await screen.findByRole("textbox");
      const steer = async () => {
        fireEvent.input(input, { target: { textContent: "/steer narrow the scope" } });
        await waitFor(() =>
          expect(
            appCommandStore(nativeComposeStore)
              .getState()
              .drafts.get(createSessionKey("env-1", "tab-steer-retry"))?.text,
          ).toBe("/steer narrow the scope"),
        );
        fireEvent.keyDown(input, { key: "Enter" });
      };

      await steer();
      await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
      // An unconfirmed steer keeps the text in the composer for manual recovery
      // and raises no transient error; the parked record, if any, is surfaced by
      // the backend projection instead.
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore)
            .getState()
            .drafts.get(createSessionKey("env-1", "tab-steer-retry"))?.text,
        ).toBe("/steer narrow the scope"),
      );
      const action = performNativeAgentSessionActionMock.mock.calls[0]![0].action;
      expect(action).toEqual({ kind: "steer", text: "narrow the scope" });
      expect(action).not.toHaveProperty("requestId");
      performNativeAgentSessionActionMock.mockImplementation(async () => ({
        outcome: "applied" as const,
      }));
    });

    test("withholds steer recovery until the steer itself has settled", async () => {
      seedProjection({ phase: "running", actions: { steer: true } });
      const tabId = "tab-steer-in-flight";
      const sessionKey = createSessionKey("env-1", tabId);
      let releaseSteer!: () => void;
      const steerGate = new Promise<void>((resolve) => {
        releaseSteer = resolve;
      });
      performNativeAgentSessionActionMock.mockImplementationOnce((async () => {
        await steerGate;
        return { outcome: "unknown" as const };
      }) as never);

      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "/steer narrow the scope" } });
      await waitFor(() =>
        expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
          "/steer narrow the scope",
        ),
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));

      // The steer record is durable before the provider can queue the text, so
      // the active-turn poll exposes it mid-flight exactly as an ordinary
      // dispatch does. A steer runs through the session action rather than the
      // dispatch call, so the send flag alone would not cover this.
      const parked = {
        requestId: "recoverable-steer-1",
        createdAt: "2026-09-09T19:12:51.000Z",
        kind: "steer" as const,
      };
      seedProjection({
        phase: "running",
        actions: { steer: true },
        recoverableDispatch: parked,
      });
      const current = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;
      act(() => {
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProjection(sessionKey, {
            ...current,
            revision: current.revision + 1,
            recoverableDispatch: parked,
          });
      });
      expect(screen.queryByRole("button", { name: "Retry steer" }) === null).toBe(true);
      expect(
        screen.queryByText(/could not confirm delivery of the steering instruction/i) === null,
      ).toBe(true);

      releaseSteer();
      expect(await screen.findByRole("button", { name: "Retry steer" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    });

    test("keeps /steer an ordinary prompt for a provider that cannot steer", async () => {
      seedProjection({ phase: "running" });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-no-steer" data={identity("claude")} isActive />,
      );

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "/steer nope" } });
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore)
            .getState()
            .drafts.get(createSessionKey("env-1", "tab-no-steer"))?.text,
        ).toBe("/steer nope"),
      );
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalled());
      expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
    });

    test.each(["cursor", "grok"] as const)(
      "queues a follow-up for a running %s turn with its composer settings",
      async (platform) => {
        seedProjection({
          phase: "running",
          composer: {
            selectedModelId: "model-a",
            selectedReasoningId: "high",
            selectedModeId: "plan",
            fastModeAvailable: true,
            fastModeEnabled: true,
          },
        });
        const tabId = `tab-${platform}-queue`;
        renderInAppCommandScope(
          <AgentNativeTab tabId={tabId} data={identity(platform)} isActive />,
        );

        const input = await screen.findByRole("textbox");
        fireEvent.input(input, { target: { textContent: "Follow up after this turn" } });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() =>
          expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
            `${platform}\u0000${createSessionKey("env-1", tabId)}`,
            "env-1",
            expect.objectContaining({
              text: "Follow up after this turn",
              model: "model-a",
              reasoningEffort: "high",
              mode: "plan",
              fastMode: true,
            }),
          ),
        );
        expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      },
    );

    test("offers both attach and mention for a provider that accepts files", async () => {
      seedProjection();
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-attach" data={identity("claude")} isActive />,
      );

      fireEvent.pointerDown(await screen.findByRole("button", { name: "Add attachment" }));
      expect(
        await screen.findByRole("menuitem", { name: "Attach file from workspace" }),
      ).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Mention file from workspace" })).toBeTruthy();
    });

    test("cycles conversation mode with Shift+Tab", async () => {
      seedProjection();
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-mode" data={identity("codex")} isActive />,
      );

      const input = await screen.findByRole("textbox");
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { mode: "plan" },
      });
    });

    test("lets an existing OpenCode session switch Plan/Build from the compose bar", async () => {
      seedProjection({
        composer: {
          modes: [],
          selectedModeId: undefined,
          fastModeEnabled: null,
          fastModeAvailable: false,
          executionProfiles: [
            { id: "build", label: "build" },
            { id: "plan", label: "plan" },
            { id: "reviewer", label: "Reviewer" },
          ],
          selectedExecutionProfileId: "build",
        },
        composerCapabilities: {
          speed: false,
          mode: false,
          executionProfile: true,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-opencode-mode" data={identity("opencode")} isActive />,
      );

      const trigger = await screen.findByTestId("native-execution-profile-picker");
      expect(trigger.getAttribute("aria-label")).toContain("Build");
      expect(screen.getByTitle(/Choose model/).textContent).not.toContain("speed");

      const input = screen.getByRole("textbox");
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { executionProfileId: "plan" },
      });

      fireEvent.pointerDown(trigger);
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Reviewer" }));
      await waitFor(() =>
        expect(updateNativeAgentControlsMock.mock.calls.length).toBeGreaterThan(1),
      );
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { executionProfileId: "reviewer" },
      });
    });

    test("keeps Plan/Build on an OpenCode session whose agent list has not arrived", async () => {
      seedProjection({
        composer: {
          modes: [],
          selectedModeId: undefined,
          executionProfiles: [],
          selectedExecutionProfileId: undefined,
        },
        composerCapabilities: {
          speed: false,
          mode: false,
          executionProfile: true,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-opencode-fallback-mode" data={identity("opencode")} isActive />,
      );

      const trigger = await screen.findByTestId("native-execution-profile-picker");
      expect(trigger.getAttribute("aria-label")).toContain("Build");
      fireEvent.pointerDown(trigger);
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Plan" }));
      await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { executionProfileId: "plan" },
      });
    });

    test("dispatches the execution profile the compose bar is showing", async () => {
      // The projection leaves `selectedExecutionProfileId` undefined whenever no
      // id was ever stored, one was cleared to null from the agent-information
      // panel, or a stored id is missing from the arrived listing. `app.agents`
      // has no defined order, so the first entry is an arbitrary primary agent —
      // showing it while dispatching `undefined` ran the turn under OpenCode's
      // own `build` default under a different agent's name.
      seedProjection({
        composer: {
          modes: [],
          selectedModeId: undefined,
          executionProfiles: [
            { id: "reviewer", label: "Reviewer" },
            { id: "build", label: "build" },
            { id: "plan", label: "plan" },
          ],
          selectedExecutionProfileId: undefined,
        },
        composerCapabilities: { speed: false, mode: false, executionProfile: true },
      });
      renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-opencode-default-profile"
          data={identity("opencode")}
          isActive
        />,
      );

      const trigger = await screen.findByTestId("native-execution-profile-picker");
      // The listed `build`, not `executionProfiles[0]`.
      expect(trigger.getAttribute("aria-label")).toContain("Build");

      const input = screen.getByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Do the thing" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
        agent: "opencode",
        executionAgent: "build",
      });
    });

    test("dispatches the first listed profile when the agent set has no build", async () => {
      // A custom agent set with no `build` makes OpenCode's own default name an
      // agent that does not exist, so the shown entry is the only valid thing to
      // send — and it still has to be the one the trigger names.
      seedProjection({
        composer: {
          modes: [],
          selectedModeId: undefined,
          executionProfiles: [
            { id: "reviewer", label: "Reviewer" },
            { id: "deploy", label: "Deploy" },
          ],
          selectedExecutionProfileId: undefined,
        },
        composerCapabilities: { speed: false, mode: false, executionProfile: true },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-opencode-no-build" data={identity("opencode")} isActive />,
      );

      const trigger = await screen.findByTestId("native-execution-profile-picker");
      expect(trigger.getAttribute("aria-label")).toContain("Reviewer");

      const input = screen.getByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Do the thing" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
        agent: "opencode",
        executionAgent: "reviewer",
      });
    });

    test("does not invent a Claude subagent when none is selected", async () => {
      // Claude's execution profile is a subagent, and it has no provider-side
      // default. Synthesising one here would silently route the turn away from
      // the main agent.
      seedProjection({
        composer: {
          executionProfiles: [
            { id: "reviewer", label: "Reviewer" },
            { id: "planner", label: "Planner" },
          ],
          selectedExecutionProfileId: undefined,
        },
        composerCapabilities: { executionProfile: true },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-claude-no-subagent" data={identity("claude")} isActive />,
      );

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Do the thing" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
        agent: "claude",
        subAgent: undefined,
      });
    });

    test("locks the execution-profile control while a turn is settling", async () => {
      seedProjection({
        phase: "running",
        composer: {
          modes: [],
          selectedModeId: undefined,
          executionProfiles: [
            { id: "build", label: "build" },
            { id: "plan", label: "plan" },
          ],
          selectedExecutionProfileId: "build",
        },
        composerCapabilities: { speed: false, mode: false, executionProfile: true },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-opencode-locked-profile" data={identity("opencode")} isActive />,
      );

      const trigger = await screen.findByTestId("native-execution-profile-picker");
      expect((trigger as HTMLButtonElement).disabled).toBe(true);

      // Shift+Tab has to be inert too: `cycleMode` is the same gate, and a
      // keystroke that bypassed the disabled trigger would change the agent
      // mid-turn.
      updateNativeAgentControlsMock.mockClear();
      const input = screen.getByRole("textbox");
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      await Promise.resolve();
      expect(updateNativeAgentControlsMock).not.toHaveBeenCalled();
    });

    test("switches the approval mode from its icon button", async () => {
      seedProjection({
        composer: {
          approvalModes: [
            { id: "default", label: "Ask", description: "Ask first", kind: "ask" },
            {
              id: "bypassPermissions",
              label: "Bypass",
              description: "Approve everything",
              kind: "auto-approve",
            },
          ],
          selectedApprovalModeId: "bypassPermissions",
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-approvals" data={identity("claude")} isActive />,
      );

      const trigger = await screen.findByRole("button", { name: "Approvals: Bypass" });
      // A mode that skips asking is named in words, not only by its icon.
      expect(trigger.textContent).toBe("Bypass");
      fireEvent.pointerDown(trigger);
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Ask" }));
      await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { approvalMode: "default" },
      });
    });

    test("keeps advanced session settings out of the input bar", async () => {
      seedProjection({
        composer: {
          executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-settings" data={identity("claude")} isActive />,
      );

      await screen.findByRole("textbox");
      expect(screen.queryByTestId("native-execution-profile-picker") === null).toBe(true);
      expect(screen.queryByText("Provider default") === null).toBe(true);
      expect(screen.queryByText("Local settings") === null).toBe(true);
      expect(screen.queryByText("Suggestions") === null).toBe(true);
    });

    test("uses a projection updated by the separate settings surface for the next prompt", async () => {
      seedProjection({
        composer: {
          executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
          includeLocalSettings: false,
          promptSuggestionsEnabled: false,
        },
      });
      const tabId = "tab-external-settings";
      const sessionKey = createSessionKey("env-1", tabId);
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
      const input = await screen.findByRole("textbox");
      const initial = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;

      act(() => {
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProjection(sessionKey, {
            ...initial,
            revision: initial.revision + 1,
            composer: {
              ...initial.composer!,
              selectedExecutionProfileId: "reviewer",
              includeLocalSettings: true,
              promptSuggestionsEnabled: true,
            },
          });
      });
      fireEvent.input(input, { target: { textContent: "use the new settings" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prompt: "use the new settings",
        subAgent: "reviewer",
        includeLocalSettings: true,
        promptSuggestions: true,
      });
    });

    for (const merged of [false, true]) {
      test(`restores the native reader after a ${merged ? "same-minute merged" : "separate row"} history page`, async () => {
        const originalHook = scrollState.useVirtuosoScrollState;
        const scrollToIndex = mock((_index: number) => true);
        const spy = spyOn(scrollState, "useVirtuosoScrollState").mockImplementation((options) => ({
          ...originalHook(options),
          scrollToIndex,
        }));
        try {
          const row = (id: string): NativeMessage => ({
            id,
            role: "assistant",
            content: merged ? "" : id,
            createdAt: "2026-10-18T01:33:20.000Z",
            parts: merged
              ? [
                  {
                    type: "tool-invocation",
                    content: "Read",
                    toolName: "Read",
                    toolUseId: `call-${id}`,
                    toolArgs: { file_path: `${id}.txt` },
                    toolState: "success",
                  },
                ]
              : [{ type: "text", content: id }],
          });
          sessionProjectionMock.mockImplementation(async (input) => ({
            ...(await defaultProjection(input)),
            messages: [row("held")],
          }));
          sessionHistoryMock.mockImplementation(async () => [row("earlier")]);
          renderInAppCommandScope(
            <AgentNativeTab tabId={`tab-held-page-${merged}`} data={identity("claude")} isActive />,
          );
          fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
          await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(merged ? 0 : 1));
        } finally {
          spy.mockRestore();
        }
      });
    }

    test("offers to load earlier messages when the transcript is windowed", async () => {
      seedProjection({ messageWindow: { limit: 512, truncated: true } });
      sessionHistoryMock.mockImplementation(async () => [
        {
          id: "earlier",
          role: "user",
          content: "earlier",
          parts: [{ type: "text", content: "earlier" }],
          createdAt: "2026-08-26T12:00:00.000Z",
        },
      ]);
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-window" data={identity("opencode")} isActive />,
      );

      const loadEarlierButton = await screen.findByRole("button", {
        name: "Load earlier messages",
      });
      // The control says everything the header needs to; a notice beside it
      // would only repeat the button, and the byte cap did not bind here.
      expect(
        screen.queryByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ) === null,
      ).toBe(true);
      expect(screen.queryByText("Earlier messages are not shown.") === null).toBe(true);
      expect(
        screen.queryByText(
          "Earlier messages in this conversation are not available here. The conversation itself is kept.",
        ) === null,
      ).toBe(true);
      fireEvent.click(loadEarlierButton);
      await waitFor(() =>
        expect(sessionBackend.api.getNativeAgentMessagePage).toHaveBeenCalledWith(
          expect.objectContaining({ before: "fake-history:1" }),
        ),
      );
    });

    test("offers to load earlier messages when the live window was trimmed by bytes", async () => {
      seedProjection({
        messageWindow: {
          limit: 100,
          truncated: true,
          truncationReason: "bytes",
          canLoadEarlier: true,
        },
      });
      sessionHistoryMock.mockImplementation(async () => [
        {
          id: "earlier",
          role: "user",
          content: "earlier",
          parts: [{ type: "text", content: "earlier" }],
          createdAt: "2026-08-26T12:00:00.000Z",
        },
      ]);
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-byte-window" data={identity("cursor")} isActive />,
      );

      const loadEarlierButton = await screen.findByRole("button", {
        name: "Load earlier messages",
      });
      expect(
        await screen.findByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("Earlier messages are not shown.") === null).toBe(true);
      fireEvent.click(loadEarlierButton);
      await waitFor(() =>
        expect(sessionBackend.api.getNativeAgentMessagePage).toHaveBeenCalledWith(
          expect.objectContaining({ before: "fake-history:1" }),
        ),
      );
    });

    test("does not offer to load earlier messages past a hard transcript byte cap", async () => {
      seedProjection({
        messageWindow: {
          limit: 100,
          truncated: true,
          truncationReason: "bytes",
          canLoadEarlier: false,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-byte-cap" data={identity("cursor")} isActive />,
      );

      expect(
        await screen.findByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true);
    });

    test("does not offer to load a count-windowed transcript the server marked unpageable", async () => {
      seedProjection({
        messageWindow: {
          limit: 100,
          truncated: true,
          truncationReason: "count",
          canLoadEarlier: false,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-count-capped" data={identity("cursor")} isActive />,
      );

      // No page can bring the start back, so the cut is said out loud rather
      // than the remainder reading as the whole conversation.
      expect(
        await screen.findByText(
          "Earlier messages in this conversation are not available here. The conversation itself is kept.",
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ) === null,
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true);
    });

    test("does not offer to load a reasonless truncated window the server marked unpageable", async () => {
      seedProjection({
        messageWindow: {
          limit: 100,
          truncated: true,
          canLoadEarlier: false,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-reasonless-cap" data={identity("cursor")} isActive />,
      );

      // No page can bring the start back, so the cut is said out loud rather
      // than the remainder reading as the whole conversation.
      expect(
        await screen.findByText(
          "Earlier messages in this conversation are not available here. The conversation itself is kept.",
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ) === null,
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true);
    });

    test("does not offer to load a part-truncated window that cannot restore omitted parts", async () => {
      seedProjection({
        messageWindow: {
          limit: 100,
          truncated: true,
          truncationReason: "bytes",
          omittedParts: 3,
          canLoadEarlier: false,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-part-cap" data={identity("cursor")} isActive />,
      );

      expect(
        await screen.findByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true);
    });

    test("retires the load-earlier control after the joined snapshot restores no messages", async () => {
      seedProjection({
        messageWindow: {
          limit: 100,
          truncated: true,
          truncationReason: "bytes",
          canLoadEarlier: true,
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-byte-no-progress" data={identity("cursor")} isActive />,
      );

      // No cursor names the omitted rows, so the click mints one through the
      // joined snapshot, which has none either.
      fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
      await waitFor(() =>
        expect(sessionBackend.api.getNativeAgentProjectionUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ syncVersion: 1, forceSnapshot: true }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true),
      );
      expect(
        screen.getByText(
          "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit.",
        ),
      ).toBeTruthy();
    });

    test.each(["removal", "refresh"] as const)(
      "inline edit reserves text and attachments during queue %s",
      async (step) => {
        const tabId = `tab-inline-edit-${step}`;
        const sessionKey = createSessionKey("env-1", tabId);
        const queued = {
          id: "queued-1",
          text: "Queued task",
          mode: "build",
          attachments: [
            { id: "file-1", type: "file", path: "/tmp/notes.txt", filename: "notes.txt" },
          ],
        };
        seedProjection({ queue: { items: [queued] } });
        let complete!: () => void;
        const pending = new Promise<void>((resolve) => {
          complete = resolve;
        });
        let refreshStarted = false;
        removePromptQueueMessageMock.mockImplementationOnce(async () => {
          if (step === "removal") await pending;
          else {
            const projection = await sessionProjectionMock({
              agent: "codex",
              environmentId: "env-1",
            });
            sessionProjectionMock.mockImplementationOnce(async () => {
              refreshStarted = true;
              await pending;
              return projection;
            });
          }
        });
        renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
        const input = await screen.findByRole("textbox");
        fireEvent.click(await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" }));
        await waitFor(() => expect(removePromptQueueMessageMock).toHaveBeenCalledTimes(1));
        if (step === "refresh") await waitFor(() => expect(refreshStarted).toBe(true));
        expect(input.getAttribute("contenteditable")).toBe("false");
        expect(
          (screen.getByRole("button", { name: "Add attachment" }) as HTMLButtonElement).disabled,
        ).toBe(true);
        fireEvent.input(input, { target: { textContent: "Typing while waiting" } });
        act(() =>
          latestPasteOptions?.onAttach?.({
            id: "new-image",
            type: "image",
            path: "/tmp/new.png",
            name: "new.png",
            previewUrl: "data:image/png;base64,AAAA",
          }),
        );
        expect(latestPasteOptions?.canAttachImage?.()).toBe(false);
        // Neither path accepted content which the queued draft would overwrite.
        expect(
          nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey),
        ).toMatchObject({
          text: "",
          attachments: [],
        });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
        expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
        await act(async () => {
          complete();
          await pending;
        });
        await waitFor(() =>
          expect(
            nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey),
          ).toMatchObject({
            text: "Queued task",
            attachments: [{ id: "file-1", name: "notes.txt", path: "/tmp/notes.txt" }],
          }),
        );
        await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("true"));
        await waitFor(() => expect(document.activeElement).toBe(input));
        fireEvent.input(input, { target: { textContent: "Queued task revised" } });
        expect(
          nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey).text,
        ).toBe("Queued task revised");
      },
    );

    test.each(["idle", "running"] as const)(
      "inline edit blocks Send and Enter until queued settings are restored (%s)",
      async (phase) => {
        seedProjection({
          phase,
          queue: {
            items: [
              {
                id: "queued-1",
                text: "Plan this",
                model: "model-b",
                reasoningEffort: "high",
                mode: "plan",
              },
            ],
          },
        });
        renderInAppCommandScope(
          <AgentNativeTab
            tabId={`tab-inline-settings-${phase}`}
            data={identity("codex")}
            isActive
          />,
        );
        const input = await screen.findByRole("textbox");
        const edit = await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" });
        let complete!: () => void;
        const pending = new Promise<void>((resolve) => {
          complete = resolve;
        });
        updateNativeAgentControlsMock.mockImplementationOnce(async () => {
          await pending;
          return sessionProjectionMock({ agent: "codex", environmentId: "env-1" });
        });
        fireEvent.click(edit);
        await waitFor(() =>
          expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
            update: { modelId: "model-b", reasoningId: "high", mode: "plan" },
          }),
        );
        expect(input.getAttribute("contenteditable")).toBe("false");
        const sendTitle = phase === "running" ? "Add to queue" : "Send";
        const send = screen.queryByTitle(sendTitle) as HTMLButtonElement | null;
        expect(send === null || send.disabled).toBe(true);
        if (send) fireEvent.click(send);
        fireEvent.keyDown(input, { key: "Enter" });
        expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
        expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
        expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
        seedProjection({
          phase,
          queue: { items: [] },
          composer: {
            models: [
              {
                platform: "codex",
                id: "model-b",
                label: "Model B",
                reasoning: [{ id: "high", label: "High" }],
              },
            ],
            selectedModelId: "model-b",
            selectedReasoningId: "high",
            selectedModeId: "plan",
          },
        });
        await act(async () => {
          complete();
          await pending;
        });
        await waitFor(() => expect(input.textContent).toBe("Plan this"));
        await waitFor(() =>
          expect((screen.getByTitle(sendTitle) as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.keyDown(input, { key: "Enter" });
        if (phase === "running") {
          await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalled());
          expect(enqueuePromptQueueMessageMock.mock.calls.at(-1)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                text: "Plan this",
                model: "model-b",
                reasoningEffort: "high",
                mode: "plan",
              }),
            ]),
          );
        } else {
          await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
          expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
            model: "model-b",
            reasoningEffort: "high",
            mode: "plan",
          });
        }
      },
    );

    test("inline edit failure preserves the queued item and releases the composer", async () => {
      seedProjection({ queue: { items: [{ id: "queued-1", text: "Queued task", mode: "plan" }] } });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-inline-settings-error" data={identity("codex")} isActive />,
      );
      const input = await screen.findByRole("textbox");
      const edit = await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" });
      updateNativeAgentControlsMock.mockRejectedValueOnce(new Error("Settings failed"));
      mockToastError.mockClear();
      fireEvent.click(edit);
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "Could not confirm the prompt queue update. Wait for the queue to refresh before retrying.",
        ),
      );
      expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
      expect(input.textContent).toBe("");
      await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("true"));
      fireEvent.input(input, { target: { textContent: "Still usable" } });
      expect(
        nativeComposeDraft(
          appCommandStore(nativeComposeStore).getState(),
          createSessionKey("env-1", "tab-inline-settings-error"),
        ).text,
      ).toBe("Still usable");
    });

    test("inline edit mid-turn skips the settings change when they already match", async () => {
      // Claude refuses any settings change while a turn runs, so a prompt
      // queued with the composer's own settings must not ask for one.
      seedProjection({
        phase: "running",
        composer: { selectedReasoningId: "high" },
        queue: {
          items: [
            {
              id: "queued-1",
              text: "Queued task",
              model: "model-a",
              reasoningEffort: "high",
              mode: "build",
              fastMode: false,
            },
          ],
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-inline-edit-running" data={identity("claude")} isActive />,
      );
      const input = await screen.findByRole("textbox");
      updateNativeAgentControlsMock.mockClear();
      mockToastError.mockClear();
      fireEvent.click(await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" }));
      await waitFor(() => expect(input.textContent).toBe("Queued task"));
      expect(removePromptQueueMessageMock).toHaveBeenCalled();
      expect(updateNativeAgentControlsMock).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
    });

    test("inline edit mid-turn explains a refused settings restore and keeps the prompt", async () => {
      seedProjection({
        phase: "running",
        queue: { items: [{ id: "queued-1", text: "Queued task", mode: "plan" }] },
      });
      renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-inline-edit-running-refused"
          data={identity("claude")}
          isActive
        />,
      );
      const input = await screen.findByRole("textbox");
      updateNativeAgentControlsMock.mockRejectedValueOnce(
        new Error("Claude session config update failed (HTTP 409): Session is running"),
      );
      mockToastError.mockClear();
      fireEvent.click(await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" }));
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "This prompt was queued with different settings, which can't be restored while Claude is working. It is still queued; edit it once the turn finishes.",
        ),
      );
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { mode: "plan" },
      });
      expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
      expect(input.textContent).toBe("");
      await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("true"));
      fireEvent.input(input, { target: { textContent: "Still usable" } });
      expect(
        nativeComposeDraft(
          appCommandStore(nativeComposeStore).getState(),
          createSessionKey("env-1", "tab-inline-edit-running-refused"),
        ).text,
      ).toBe("Still usable");
    });

    test.each([
      ["claude", "running", "Disconnected"],
      ["claude", "running", "Invalid model selection"],
      ["claude", "running", "Invalid reasoning selection"],
      ["claude", "running", "Native agent controls are unavailable"],
      ["claude", "running", "Session is running"],
      ["codex", "running", "Claude session config update failed (HTTP 409): Session is running"],
      ["codex", "running", "Disconnected"],
      ["claude", undefined, "Disconnected"],
    ] as const)(
      "inline edit preserves unrelated %s settings failure (%s, %s)",
      async (platform, phase, errorMessage) => {
        // A running turn re-reads the queue on the coordinator's 500 ms cadence.
        const { clock } = fakeReadCoordinator();
        const tabId = "tab-inline-edit-unrelated-failure";
        seedProjection({
          phase,
          queue: { items: [{ id: "queued-1", text: "Queued task", mode: "plan" }] },
        });
        renderInAppCommandScope(
          <AgentNativeTab tabId={tabId} data={identity(platform)} isActive />,
        );
        const input = await screen.findByRole("textbox");
        updateNativeAgentControlsMock.mockRejectedValueOnce(new Error(errorMessage));
        mockToastError.mockClear();
        fireEvent.click(await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" }));
        await waitFor(() =>
          expect(mockToastError).toHaveBeenCalledWith(
            "Could not confirm the prompt queue update. Wait for the queue to refresh before retrying.",
          ),
        );
        expect(mockToastError).toHaveBeenCalledTimes(1);
        expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
        expect(input.textContent).toBe("");
        await act(() => clock.advance(500));
        await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("true"));
        fireEvent.input(input, { target: { textContent: "Still usable" } });
        expect(
          nativeComposeDraft(
            appCommandStore(nativeComposeStore).getState(),
            createSessionKey("env-1", tabId),
          ).text,
        ).toBe("Still usable");
      },
    );

    test.each(["steer", "edit", "remove"] as const)(
      "inline %s uses queue error toasts",
      async (action) => {
        seedProjection({
          phase: "running",
          actions: { steer: true },
          queue: { items: [{ id: "queued-1", text: "Queued task" }] },
        });
        renderInAppCommandScope(
          <AgentNativeTab tabId={`tab-inline-error-${action}`} data={identity("codex")} isActive />,
        );
        const name =
          action === "steer"
            ? "Steer queued prompt 1 of 1: Queued task"
            : action === "edit"
              ? "Edit queued prompt 1 of 1"
              : "Remove queued prompt 1 of 1";
        const button = await screen.findByRole("button", { name });
        if (action === "steer")
          steerNativeAgentQueuedPromptMock.mockRejectedValueOnce(new Error("Disconnected"));
        else removePromptQueueMessageMock.mockRejectedValueOnce(new Error("Disconnected"));
        mockToastError.mockClear();
        fireEvent.click(button);
        await waitFor(() =>
          expect(mockToastError).toHaveBeenCalledWith(
            action === "steer"
              ? "Could not steer the running turn: Disconnected"
              : "Could not confirm the prompt queue update. Wait for the queue to refresh before retrying.",
          ),
        );
        await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
      },
    );

    test.each([
      ["steer", 1, "head"],
      ["steer", 2, "tail"],
      ["remove", 1, "head"],
      ["remove", 2, "tail"],
    ] as const)(
      "inline %s on strip %d targets that queued prompt",
      async (action, position, id) => {
        seedProjection({
          phase: "running",
          actions: { steer: true },
          queue: {
            items: [
              { id: "head", text: "First" },
              { id: "tail", text: "Second" },
            ],
          },
        });
        renderInAppCommandScope(
          <AgentNativeTab tabId={`tab-inline-${action}-${id}`} data={identity("codex")} isActive />,
        );
        fireEvent.click(
          await screen.findByRole("button", {
            name:
              action === "steer"
                ? `Steer queued prompt ${position} of 2: ${position === 1 ? "First" : "Second"}`
                : `Remove queued prompt ${position} of 2`,
          }),
        );
        if (action === "steer") {
          await waitFor(() =>
            expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledWith(
              expect.objectContaining({ messageId: id }),
            ),
          );
          expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
        } else {
          await waitFor(() =>
            expect(removePromptQueueMessageMock).toHaveBeenCalledWith(
              expect.any(String),
              "env-1",
              id,
            ),
          );
        }
      },
    );

    test("ArrowUp from the composer reaches every actionable queued prompt", async () => {
      seedProjection({
        phase: "running",
        actions: { steer: true },
        queue: {
          items: [
            { id: "head", text: "First" },
            { id: "image", text: "Has an image", attachments: [{ type: "image", path: "/i.png" }] },
            { id: "tail", text: "Third" },
          ],
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-inline-arrows" data={identity("codex")} isActive />,
      );
      const input = await screen.findByRole("textbox");
      const head = await screen.findByRole("button", { name: "Steer queued prompt 1 of 3: First" });
      expect(screen.queryByRole("button", { name: /^Steer queued prompt 2 of 3/ }) === null).toBe(
        true,
      );
      act(() => input.focus());
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(document.activeElement).toBe(head);
      fireEvent.keyDown(head, { key: "ArrowUp" });
      const edit = screen.getByRole("button", { name: "Edit queued prompt 2 of 3" });
      expect(document.activeElement).toBe(edit);
      fireEvent.keyDown(edit, { key: "ArrowUp" });
      const tail = screen.getByRole("button", { name: "Steer queued prompt 3 of 3: Third" });
      expect(document.activeElement).toBe(tail);
      fireEvent.click(tail);
      await waitFor(() =>
        expect(steerNativeAgentQueuedPromptMock).toHaveBeenCalledWith(
          expect.objectContaining({ messageId: "tail" }),
        ),
      );
    });

    test("keyboard Edit loads a queued prompt with the caret at its end", async () => {
      const text = "Queued task to revise";
      seedProjection({ queue: { items: [{ id: "queued-1", text }] } });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-keyboard-edit-caret" data={identity("codex")} isActive />,
      );
      const input = await screen.findByRole("textbox");
      const edit = await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" });
      act(() => {
        input.focus();
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(true);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(document.activeElement).toBe(edit);
      fireEvent.keyDown(edit, { key: "Enter" });
      fireEvent.click(edit);
      await waitFor(() => expect(input.textContent).toBe(text));
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
        const caret = window.getSelection()!.getRangeAt(0);
        const before = document.createRange();
        before.selectNodeContents(input);
        before.setEnd(caret.startContainer, caret.startOffset);
        expect(before.toString().length).toBe(text.length);
      });
    });

    test.each([
      "annotation",
      "attachment",
      "command",
      "async-id",
      "async-request",
      "idle",
    ] as const)("inline queue controls respect the %s head", async (gate) => {
      seedProjection({
        phase: gate === "idle" ? "idle" : "running",
        actions: { steer: true },
        queue: {
          items: [
            {
              id: gate === "async-id" ? nativeAsyncQuestionRequestId("question-1") : "queued-1",
              text: "Queued task",
              ...(gate === "annotation"
                ? { origin: { kind: "web-annotation", requestId: "req-1", bodyHash: "hash-1" } }
                : {}),
              ...(gate === "attachment"
                ? { attachments: [{ type: "image", path: "/tmp/image.png" }] }
                : {}),
              ...(gate === "command" ? { command: { name: "review" } } : {}),
              ...(gate === "async-request"
                ? { requestId: nativeAsyncQuestionRequestId("question-1") }
                : {}),
            },
          ],
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId={`tab-inline-gate-${gate}`} data={identity("codex")} isActive />,
      );
      const strip = within(await screen.findByTestId("compose-queue-strip"));
      expect(strip.queryByRole("button", { name: /^Steer queued prompt/ }) === null).toBe(true);
      for (const name of ["Edit queued prompt 1 of 1", "Remove queued prompt 1 of 1"]) {
        expect(Boolean(strip.queryByRole("button", { name }))).toBe(gate !== "annotation");
      }
    });

    test("inline edit refuses an occupied composer without moving its caret", async () => {
      seedProjection({ queue: { items: [{ id: "queued-1", text: "Queued task" }] } });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-inline-occupied" data={identity("codex")} isActive />,
      );
      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Unsent draft" } });
      act(() => input.focus());
      const edit = await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" });
      mockToastError.mockClear();
      expect(fireEvent.mouseDown(edit)).toBe(false);
      fireEvent.click(edit);
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "The composer already has an unsent draft. Send or clear it before editing a queued prompt.",
        ),
      );
      expect(document.activeElement).toBe(input);
      expect(input.textContent).toBe("Unsent draft");
      expect(removePromptQueueMessageMock).not.toHaveBeenCalled();
    });

    test("refuses to load a queued prompt over an occupied composer", async () => {
      seedProjection({
        queue: { items: [{ id: "queued-1", text: "second prompt" }] },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-queue" data={identity("claude")} isActive />,
      );

      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "half-written message" } });
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore)
            .getState()
            .drafts.get(createSessionKey("env-1", "tab-queue"))?.text,
        ).toBe("half-written message"),
      );

      fireEvent.click(await screen.findByTitle("View queued prompts"));
      fireEvent.click(await screen.findByTitle("Click to edit this message"));

      await waitFor(() => expect(removePromptQueueMessageMock).not.toHaveBeenCalled());
      expect(
        appCommandStore(nativeComposeStore)
          .getState()
          .drafts.get(createSessionKey("env-1", "tab-queue"))?.text,
      ).toBe("half-written message");
    });

    test("shows provider status and detail in the shared resume picker", async () => {
      // An empty transcript centers the composer, where the picker's entry
      // point is the visible one.
      seedProjection({ messages: [] });
      listNativeAgentResumableSessionsMock.mockImplementation(
        async () =>
          [
            {
              sessionId: "older-session",
              title: "Earlier work",
              updatedAt: "2026-08-01T00:00:00.000Z",
              status: "running" as const,
              detail: "12 messages",
            },
          ] as never,
      );
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-resume-detail" data={identity("claude")} isActive />,
      );

      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      expect(within(dialog).getByText("Earlier work")).toBeTruthy();
      expect(within(dialog).getByText("12 messages")).toBeTruthy();
      expect(within(dialog).getByText(/Running/)).toBeTruthy();
    });

    test("passes the complete composer control set when resuming", async () => {
      seedProjection({
        messages: [],
        composer: {
          selectedModelId: "model-a",
          selectedReasoningId: "high",
          selectedModeId: "plan",
          fastModeEnabled: true,
          selectedExecutionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      });
      listNativeAgentResumableSessionsMock.mockImplementation(
        async () =>
          [
            {
              sessionId: "older-session",
              title: "Earlier work",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ] as never,
      );
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-resume-controls" data={identity("claude")} isActive />,
      );

      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      fireEvent.click(within(dialog).getByRole("button", { name: /Earlier work/ }));
      await waitFor(() =>
        expect(resumeNativeAgentSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            providerSessionId: "older-session",
            controls: {
              modelId: "model-a",
              reasoningId: "high",
              mode: "plan",
              fastMode: true,
              executionProfileId: "reviewer",
              includeLocalSettings: true,
              promptSuggestions: true,
            },
          }),
        ),
      );
    });

    test("resuming a different session detaches a consumed handoff", async () => {
      const snapshot = grokToCursorHandoff("handoff-resume-other");
      getAgentHandoffMock.mockResolvedValue({
        id: snapshot.id,
        environmentId: snapshot.environmentId,
        version: AGENT_HANDOFF_VERSION,
        snapshot,
      });
      seedProjection({ sessionId: "claude-session" });
      listNativeAgentResumableSessionsMock.mockImplementation(
        async () =>
          [
            {
              sessionId: "older-session",
              title: "Earlier work",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ] as never,
      );
      const tabId = "tab-resume-handoff-other";
      seedEnvTab({
        id: tabId,
        type: "agent-native",
        agentHandoffId: snapshot.id,
        consumedAgentHandoffId: snapshot.id,
        nativeAgentData: identity("claude"),
      });

      renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      fireEvent.click(within(dialog).getByRole("button", { name: /Earlier work/ }));

      await waitFor(() =>
        expect(
          appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.agentHandoffId,
        ).toBeUndefined(),
      );
      expect(
        appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.consumedAgentHandoffId,
      ).toBe(snapshot.id);
    });

    test("resuming the current session leaves a consumed handoff intact", async () => {
      const snapshot = grokToCursorHandoff("handoff-resume-same");
      getAgentHandoffMock.mockResolvedValue({
        id: snapshot.id,
        environmentId: snapshot.environmentId,
        version: AGENT_HANDOFF_VERSION,
        snapshot,
      });
      seedProjection({ sessionId: "claude-session" });
      listNativeAgentResumableSessionsMock.mockImplementation(
        async () =>
          [
            {
              sessionId: "claude-session",
              title: "Current destination",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
            {
              sessionId: "older-session",
              title: "Earlier work",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
          ] as never,
      );
      const tabId = "tab-resume-handoff-same";
      seedEnvTab({
        id: tabId,
        type: "agent-native",
        agentHandoffId: snapshot.id,
        consumedAgentHandoffId: snapshot.id,
        nativeAgentData: identity("claude"),
      });

      renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      expect(within(dialog).queryByRole("button", { name: /Current destination/ }) === null).toBe(
        true,
      );
      expect(within(dialog).getByText("Earlier work")).toBeTruthy();
      expect(appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]).toMatchObject({
        agentHandoffId: snapshot.id,
        consumedAgentHandoffId: snapshot.id,
      });
    });

    test("a failed resume does not detach a consumed handoff", async () => {
      const snapshot = grokToCursorHandoff("handoff-resume-fail");
      getAgentHandoffMock.mockResolvedValue({
        id: snapshot.id,
        environmentId: snapshot.environmentId,
        version: AGENT_HANDOFF_VERSION,
        snapshot,
      });
      seedProjection({ sessionId: "claude-session" });
      listNativeAgentResumableSessionsMock.mockImplementation(
        async () =>
          [
            {
              sessionId: "older-session",
              title: "Earlier work",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ] as never,
      );
      resumeNativeAgentSessionMock.mockRejectedValueOnce(new Error("resume failed"));
      const tabId = "tab-resume-handoff-fail";
      seedEnvTab({
        id: tabId,
        type: "agent-native",
        agentHandoffId: snapshot.id,
        consumedAgentHandoffId: snapshot.id,
        nativeAgentData: identity("claude"),
      });

      renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
      fireEvent.click((await screen.findAllByRole("button", { name: /Resume Session/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
      fireEvent.click(within(dialog).getByRole("button", { name: /Earlier work/ }));

      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]).toMatchObject({
        agentHandoffId: snapshot.id,
        consumedAgentHandoffId: snapshot.id,
      });
    });

    test("dismisses an accepted suggestion for any provider that tracks them", async () => {
      seedProjection({ suggestedPrompt: "Run the tests", promptSuggestions: true });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-suggest" data={identity("claude")} isActive />,
      );

      fireEvent.click(await screen.findByRole("button", { name: /Suggested: Run the tests/ }));
      await waitFor(() => expect(dismissNativeAgentSuggestedPromptMock).toHaveBeenCalledTimes(1));
      expect(
        appCommandStore(nativeComposeStore)
          .getState()
          .drafts.get(createSessionKey("env-1", "tab-suggest"))?.text,
      ).toBe("Run the tests");
    });

    test("retries an ambiguous dispatch through the backend-owned replay", async () => {
      seedProjection({
        recoverableDispatch: {
          requestId: "recoverable-1",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      });
      const sessionKey = createSessionKey("env-1", "tab-recoverable");
      appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
        text: "Retry this prompt",
        requestId: "recoverable-1",
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-recoverable" data={identity("codex")} isActive />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Retry send" }));
      await waitFor(() =>
        expect(retryNativeAgentDispatchMock).toHaveBeenCalledWith({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: sessionKey,
          requestId: "recoverable-1",
        }),
      );
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined();
    });

    test("rehydrates a parked dispatch after the environment unmounts and the renderer cache resets", async () => {
      seedProjection({
        recoverableDispatch: {
          requestId: "recoverable-remount-1",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      });
      const first = renderInAppCommandScope(
        <AgentNativeTab tabId="tab-recoverable-remount" data={identity("codex")} isActive />,
      );
      expect(await screen.findByRole("button", { name: "Retry send" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();

      // Switching environments unmounts this tree. Resetting the shared store
      // additionally models a renderer reload, so the second banner can only
      // come from the backend-owned projection returned during reconnect.
      first.unmount();
      appCommandStore(nativeAgentProjectionStore).getState().reset();
      sessionProjectionMock.mockClear();
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-recoverable-remount" data={identity("codex")} isActive />,
      );

      expect(await screen.findByRole("button", { name: "Retry send" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
      // Drafting remains available, but there is no action that can submit a
      // second request id while the recovered one is parked.
      expect(screen.queryByTitle("Send") === null).toBe(true);
      expect(sessionProjectionMock).toHaveBeenCalled();
    });

    test("discards an ambiguous dispatch without re-sending it", async () => {
      seedProjection({
        recoverableDispatch: {
          requestId: "recoverable-1",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-discard" data={identity("codex")} isActive />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
      await waitFor(() =>
        expect(discardNativeAgentDispatchMock).toHaveBeenCalledWith({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: createSessionKey("env-1", "tab-discard"),
          requestId: "recoverable-1",
        }),
      );
      expect(retryNativeAgentDispatchMock).not.toHaveBeenCalled();
    });

    test("refuses a new prompt while a dispatch is still parked", async () => {
      seedProjection({
        recoverableDispatch: {
          requestId: "recoverable-1",
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-parked" data={identity("codex")} isActive />,
      );

      const composer = await screen.findByRole("textbox");
      fireEvent.input(composer, { target: { textContent: "Something else" } });
      fireEvent.keyDown(composer, { key: "Enter" });

      // The backend refuses a second request id while one is parked, so sending
      // anyway would surface an internal message the user cannot act on. Say
      // which two controls clear it instead.
      expect(await screen.findByText(/Resolve the unconfirmed message above/)).toBeTruthy();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    });

    test.each(["codex", "cursor"] as const)(
      "shows a plan review card for an idle %s plan-mode turn",
      async (platform) => {
        seedProjection({
          composer: { selectedModeId: "plan" },
          messages: [
            {
              id: "assistant-plan",
              role: "assistant",
              content: "Here is the plan",
              planReview: true,
              parts: [],
              createdAt: "2026-09-08T10:00:00.000Z",
            },
          ],
        });
        renderInAppCommandScope(
          <AgentNativeTab tabId={`tab-plan-${platform}`} data={identity(platform)} isActive />,
        );

        expect(await screen.findByRole("button", { name: "Approve Plan" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Switch To Build" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
      },
    );

    test("Cursor createPlan without planReview still offers approve and dismiss", async () => {
      fixtureState.renderVirtualizedMessages = true;
      seedProjection({
        composer: { selectedModeId: "plan" },
        messages: [
          {
            id: "assistant-create-plan",
            role: "assistant",
            content: "Here is the approach.",
            parts: [
              {
                type: "tool-invocation",
                content: "Plan",
                toolName: "createPlan",
                toolState: "success",
                toolOutput: "# Split discovery\n\nDo the work.",
              },
            ],
            createdAt: "2026-09-08T10:00:00.000Z",
          },
        ],
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-cursor-create-plan" data={identity("cursor")} isActive />,
      );

      expect(await screen.findByRole("button", { name: "Approve Plan" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Split discovery" })).toBeTruthy();
      expect(screen.getByText("Do the work.")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Approve Plan" }) === null).toBe(true),
      );
      expect(screen.getByRole("heading", { name: "Split discovery" })).toBeTruthy();
    });

    test("approving a Cursor plan switches to build and asks the agent to implement", async () => {
      seedProjection({
        composer: { selectedModeId: "plan" },
        messages: [
          {
            id: "assistant-plan",
            role: "assistant",
            content: "Ready",
            planReview: true,
            parts: [],
            createdAt: "2026-09-08T10:00:00.000Z",
          },
        ],
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-cursor-approve" data={identity("cursor")} isActive />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Approve Plan" }));

      await waitFor(() => expect(updateNativeAgentControlsMock).toHaveBeenCalled());
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { mode: "build" },
      });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prompt: "The plan is approved. Exit plan mode and implement it.",
        mode: "build",
      });
    });

    test("reports a rejected Cursor plan implementation after switching to build", async () => {
      mockToastError.mockClear();
      dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
        outcome: "rejected" as const,
        requestId: input.requestId,
        error: "Cursor rejected the implementation prompt",
      }));
      seedProjection({
        composer: { selectedModeId: "plan" },
        messages: [
          {
            id: "assistant-plan-rejected",
            role: "assistant",
            content: "Ready",
            planReview: true,
            parts: [],
            createdAt: "2026-09-08T10:00:00.000Z",
          },
        ],
      });
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-cursor-rejected" data={identity("cursor")} isActive />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Approve Plan" }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Cursor rejected the implementation prompt"),
      );
      expect(updateNativeAgentControlsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        update: { mode: "build" },
      });
      expect(screen.queryByRole("button", { name: "Approve Plan" }) === null).toBe(true);
    });
  });
});
