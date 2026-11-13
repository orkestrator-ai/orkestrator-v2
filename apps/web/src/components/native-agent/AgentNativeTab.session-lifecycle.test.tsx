/**
 * Contract suite for the native agent tab's session lifecycle: dispatch
 * recovery, resumed and created sessions, and the first prompt's delivery.
 *
 * Setup is shared with the sibling suites through `AgentNativeTab.test-support`.
 */
import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentDispatchOutcome,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import {
  nativeComposeDraft,
  nativeComposePersistenceStore,
  nativeComposeStore,
} from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION,
  REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE,
  REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX,
  REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE,
  STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
} from "@orkestrator/protocol/review-evidence-frames";
import { getNativeAgentData } from "@/types/paneLayout";
import { awaitComposeDraftWrites, composeDraftKey } from "@/lib/compose-draft-persistence";
import { handTabInitialPromptToBackend } from "@/lib/tab-initial-prompt";
import { createSessionKey } from "@/lib/utils";
import {
  AGENT_HANDOFF_VERSION,
  createAgentHandoffSnapshot,
  prependAgentHandoffHistory,
} from "@/lib/agent-handoff";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@orkestrator/protocol/git-workflow-prompts";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { mockToastError, mockToastInfo, mockToastWarning } from "../../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";
import {
  latestRenderedMessageActions,
  flushPaneLayoutNowMock,
  defaultAdoptNativeAgentSession,
  adoptNativeAgentSessionMock,
  getNativeAgentAuthStatusMock,
  defaultEnsureNativeAgentSession,
  ensureNativeAgentSessionMock,
  recoverMultiReviewAddressFindingsSessionMock,
  listNativeAgentResumableSessionsMock,
  getAgentHandoffMock,
  getAgentHandoffCapabilitiesMock,
  enqueuePromptQueueMessageMock,
  dispatchNativeAgentIntentMock,
  retryNativeAgentDispatchMock,
  resumeNativeAgentSessionMock,
  defaultProjection,
  sessionProjectionMock,
  sessionHistoryMock,
  getLocalFileTreeMock,
  composeDraftRecords,
  deliverResourceChange,
  settleCoordinatedReads,
  fakeReadCoordinator,
  publishProjection,
  identity,
  seedUnassignedDefaultCatalog,
  pendingInteraction,
  freshTab,
  seedEnvTab,
  grokToCursorHandoff,
  PaneBackedAgentNativeTab,
  NativeSessionIdentityHarness,
  seedUnassignedPane,
  seedAssignedPane,
  fixtureState,
  installAgentNativeTabFixture,
  AgentNativeTab,
  SharedNativeAgentController,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

describe("AgentNativeTab", () => {
  test("does not show dispatch recovery while an ordinary send is still in flight", async () => {
    const tabId = "tab-in-flight-dispatch";
    const sessionKey = createSessionKey("env-1", tabId);
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      await dispatchGate;
      return { outcome: "accepted", requestId: input.requestId };
    });

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Move the dashboard pages" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));

    const requestId = dispatchNativeAgentIntentMock.mock.calls[0]![0].requestId;
    const current = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(sessionKey)!;
    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          revision: current.revision + 1,
          turn: { phase: "running" },
          recoverableDispatch: {
            requestId,
            createdAt: "2026-09-09T19:12:51.000Z",
          },
        });
    });

    expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true);
    expect(screen.queryByText(/could not confirm delivery of your last message/i) === null).toBe(
      true,
    );

    releaseDispatch();
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
  });

  test("settles an unconfirmed send into a reconciling hold, then a recovery choice", async () => {
    const tabId = "tab-unconfirmed-dispatch";
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      await dispatchGate;
      return { outcome: "unknown", requestId: input.requestId, error: "The transport failed" };
    });

    // The projection poll is scheduled by the read coordinator; a fake clock
    // drives one tick of the active (500 ms) cadence instead of waiting for it.
    const { clock } = fakeReadCoordinator();
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Move the dashboard pages" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));

    const requestId = dispatchNativeAgentIntentMock.mock.calls[0]![0].requestId;
    // The production combination: a lost acknowledgement the backend has parked
    // and is still trying to confirm against the provider.
    let status: "reconciling" | "action-required" = "reconciling";
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      turn: { phase: "running" as const },
      recoverableDispatch: { requestId, createdAt: "2026-09-09T19:12:51.000Z", status },
    }));

    releaseDispatch();

    // Settling unknown is not yet a choice while the record is reconciling.
    expect(await screen.findByText(/Confirming delivery with Cursor Agent/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true);

    // Once the backend's own projection poll says the window elapsed, the
    // retry/discard card arrives without any client-side store write.
    status = "action-required";
    await act(() => clock.advance(500));
    expect(await screen.findByRole("button", { name: "Retry send" })).toBeTruthy();
    expect(screen.getByText(/could not confirm delivery of your last message/i)).toBeTruthy();
  });

  test("surfaces a transport failure and restores the draft when nothing was parked", async () => {
    const tabId = "tab-transport-failed-dispatch";
    const sessionKey = createSessionKey("env-1", tabId);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async () => {
      throw new Error("The connection dropped");
    });

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The RPC failed before the backend persisted anything, so no recovery card
    // can ever arrive. The failure must still be visible rather than leaving the
    // optimistic prompt looking delivered.
    expect(
      await screen.findByText(/connection dropped before Codex confirmed your last message/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true);
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
        "Run the focused tests",
      ),
    );
  });

  test("holds the recovery card while a parked dispatch is still reconciling", async () => {
    const tabId = "tab-reconciling-dispatch";
    let status: "reconciling" | "action-required" = "reconciling";
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      turn: { phase: "running" as const },
      recoverableDispatch: {
        requestId: "reconciling-1",
        createdAt: "2026-09-09T19:12:51.000Z",
        status,
      },
    }));

    // The projection poll is scheduled by the read coordinator; a fake clock
    // drives one tick of the active (500 ms) cadence instead of waiting for it.
    const { clock } = fakeReadCoordinator();
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);

    // The record exists and locks the composer the moment it is persisted, but
    // the backend may still confirm it against the provider, so no decision is
    // required yet. The amber card must not appear; a neutral status explains
    // the lock. This is what stops the banner-flash the user complained about.
    expect(await screen.findByText(/Confirming delivery with Codex/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true);
    expect(screen.queryByText(/could not confirm delivery/i) === null).toBe(true);

    // The flip arrives through the ordinary projection poll the tab already
    // runs, not a client-side store write, so this exercises the wiring the UI
    // actually depends on.
    status = "action-required";
    await act(() => clock.advance(500));
    expect(await screen.findByRole("button", { name: "Retry send" })).toBeTruthy();
    expect(screen.getByText(/could not confirm delivery of your last message/i)).toBeTruthy();
    expect(screen.queryByText(/Confirming delivery with Codex/i) === null).toBe(true);
  });

  test("keeps a delayed retired retry warning through unmount and resends under a new id", async () => {
    const tabId = "tab-retired-retry";
    const sessionKey = createSessionKey("env-1", tabId);
    const lost =
      "Claude Code could not confirm this message, so it may not have run. Check the conversation and send it again if it did not.";
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        text: "Deploy the preview",
        requestId: "lost-1",
        pendingTranscriptConfirmation: {
          requestId: "lost-1",
          sessionId: "s-1",
          priorMessageIds: [],
        },
      });
    let parked = true;
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      ...(parked
        ? {
            recoverableDispatch: {
              requestId: "lost-1",
              createdAt: "2026-09-09T19:12:51.000Z",
              status: "action-required" as const,
            },
          }
        : {
            retiredDispatch: {
              requestId: "lost-1",
              retiredAt: new Date().toISOString(),
              message: lost,
            },
            notices: [
              {
                kind: "warning" as const,
                message: lost,
                occurrenceId: "dispatch-outcome-lost:lost-1",
              },
              {
                kind: "warning" as const,
                message: "Another retry notice",
                occurrenceId: "unrelated-retry",
              },
            ],
          }),
    }));
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    retryNativeAgentDispatchMock.mockImplementationOnce(async () => {
      await retryGate;
      parked = false;
      return { outcome: "rejected" as const, error: lost, requestIdRetired: true as const };
    });

    const mounted = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(retryNativeAgentDispatchMock).toHaveBeenCalledTimes(1));
    mounted.unmount();
    releaseRetry();
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionError,
      ).toBe(lost),
    );
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);

    // Told plainly, never shown as delivered, and the text is kept to resend.
    expect(await screen.findByText(lost)).toBeTruthy();
    await waitFor(() =>
      expect(
        mockToastWarning.mock.calls.some(([message]) => message === "Another retry notice"),
      ).toBe(true),
    );
    expect(mockToastWarning.mock.calls.some(([message]) => message === lost)).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true),
    );
    const draft = appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey);
    expect(draft?.text).toBe("Deploy the preview");
    expect(draft?.requestId).toBeUndefined();
    expect(draft?.pendingTranscriptConfirmation).toBeUndefined();

    // The bridge refuses the old id for good, so a resend needs a new one.
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const resent = dispatchNativeAgentIntentMock.mock.calls[0]![0] as { requestId?: string };
    expect(resent.requestId).toBeString();
    expect(resent.requestId).not.toBe("lost-1");
  });

  test("releases a retired direct submit id and preserves its draft warning on remount", async () => {
    const tabId = "tab-retired-direct";
    const sessionKey = createSessionKey("env-1", tabId);
    const warning = "Claude could not confirm this message, so it may not have run.";
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      text: "Deploy the preview",
      requestId: "retired-direct",
    });
    let retired = false;
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      ...(retired
        ? {
            retiredDispatch: {
              requestId: "retired-direct",
              retiredAt: new Date().toISOString(),
              message: warning,
            },
            notices: [
              {
                kind: "warning" as const,
                message: warning,
                occurrenceId: "dispatch-outcome-lost:retired-direct",
              },
              {
                kind: "warning" as const,
                message: "Another direct notice",
                occurrenceId: "unrelated-direct",
              },
            ],
          }
        : {}),
    }));
    dispatchNativeAgentIntentMock.mockImplementationOnce(async () => {
      retired = true;
      return { outcome: "rejected", error: warning, requestIdRetired: true };
    });
    const mounted = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
    await screen.findByText(warning);
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
      ).toBeUndefined(),
    );
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Deploy the preview",
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
        ?.pendingTranscriptConfirmation,
    ).toBeUndefined();
    mounted.unmount();
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    expect(await screen.findByText(warning)).toBeTruthy();
    await waitFor(() =>
      expect(
        mockToastWarning.mock.calls.some(([message]) => message === "Another direct notice"),
      ).toBe(true),
    );
    expect(mockToastWarning.mock.calls.some(([message]) => message === warning)).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true);
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(2));
    const resent = dispatchNativeAgentIntentMock.mock.calls[1]![0];
    expect(resent.requestId).toBeString();
    expect(resent.requestId).not.toBe("retired-direct");
  });

  test("settles a dispatch the backend retired on its own, without a click and on a later mount", async () => {
    const tabId = "tab-auto-retired";
    const sessionKey = createSessionKey("env-1", tabId);
    const lost =
      "Claude Code could not confirm this message, so it may not have run. Check the conversation and send it again if it did not.";
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        text: "Deploy the preview",
        requestId: "lost-auto",
        pendingTranscriptConfirmation: {
          requestId: "lost-auto",
          sessionId: "s-1",
          priorMessageIds: [],
        },
      });
    // What the backend projects once it has retired the parked dispatch: no
    // card, the content-free marker, and the notice older renderers show.
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      notices: [
        {
          kind: "warning" as const,
          message: lost,
          occurrenceId: "dispatch-outcome-lost:lost-auto",
        },
      ],
      retiredDispatch: {
        requestId: "lost-auto",
        retiredAt: "2026-10-23T10:00:00.000Z",
        message: lost,
      },
    }));

    // The tab was not mounted when it happened; it learns from the snapshot.
    const mounted = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    expect(await screen.findByText(lost)).toBeTruthy();
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
      ).toBeUndefined(),
    );
    const draft = appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey);
    expect(draft?.text).toBe("Deploy the preview");
    expect(draft?.pendingTranscriptConfirmation).toBeUndefined();
    expect(draft?.submissionError).toBe(lost);
    expect(screen.queryByRole("button", { name: "Retry send" }) === null).toBe(true);
    expect(retryNativeAgentDispatchMock).not.toHaveBeenCalled();
    // Shown once, in the composer: the duplicate notice is not toasted.
    expect(mockToastWarning.mock.calls.some(([message]) => message === lost)).toBe(false);

    // Idempotent across a remount: still shown, still no toast, still no id.
    mounted.unmount();
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    expect(await screen.findByText(lost)).toBeTruthy();
    expect(mockToastWarning.mock.calls.some(([message]) => message === lost)).toBe(false);

    // The bridge refuses the old id for good, so a resend needs a new one.
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const resent = dispatchNativeAgentIntentMock.mock.calls[0]![0] as { requestId?: string };
    expect(resent.requestId).toBeString();
    expect(resent.requestId).not.toBe("lost-auto");
  });

  test("leaves a draft that no longer owns a retired dispatch alone", async () => {
    const tabId = "tab-auto-retired-other";
    const sessionKey = createSessionKey("env-1", tabId);
    const lost =
      "Claude Code could not confirm this message, so it may not have run. Check the conversation and send it again if it did not.";
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      text: "Something newer",
      requestId: "newer",
    });
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      notices: [
        {
          kind: "warning" as const,
          message: lost,
          occurrenceId: "dispatch-outcome-lost:lost-auto",
        },
      ],
      retiredDispatch: {
        requestId: "lost-auto",
        retiredAt: "2026-10-23T10:00:00.000Z",
        message: lost,
      },
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    // The notice still tells the user; the unrelated draft keeps its id.
    await waitFor(() =>
      expect(mockToastWarning.mock.calls.some(([message]) => message === lost)).toBe(true),
    );
    const draft = appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey);
    expect(draft?.requestId).toBe("newer");
    expect(draft?.submissionError).toBeUndefined();
  });

  test("keeps the recovery card mounted and disabled while a retry is running", async () => {
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      recoverableDispatch: {
        requestId: "recoverable-slow-retry",
        createdAt: "2026-09-09T19:12:51.000Z",
      },
    }));
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    retryNativeAgentDispatchMock.mockImplementationOnce(async () => {
      await retryGate;
      return { outcome: "accepted" as const, requestId: "recoverable-slow-retry" };
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-slow-retry" data={identity("codex")} isActive />,
    );
    const retry = await screen.findByRole("button", { name: "Retry send" });
    fireEvent.click(retry);

    // The retry raises the same dispatch flag an ordinary send does. Hiding the
    // card on that flag would leave the click with no visible effect at all,
    // because a parked record also hides the send button.
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/could not confirm delivery of your last message/i)).toBeTruthy();
    fireEvent.click(retry);

    releaseRetry();
    await waitFor(() => expect(retryNativeAgentDispatchMock).toHaveBeenCalledTimes(1));
  });

  test("clears a submitted draft when the transcript confirms a dispatch whose response was lost", async () => {
    const tabId = "tab-transcript-confirmed-send";
    const sessionKey = createSessionKey("env-1", tabId);
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        attachments: [
          {
            id: "confirmation-image",
            type: "image",
            path: "/workspace/confirmation.png",
            previewUrl: "blob:confirmation",
            name: "confirmation.png",
          },
        ],
      });
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      sessionProjectionMock.mockImplementation(async (projectionInput) => ({
        ...(await defaultProjection(projectionInput)),
        turn: { phase: "running" as const },
        messages: [
          {
            id: "confirmed-user-prompt",
            role: "user" as const,
            content: "Run the focused tests",
            parts: [{ type: "text" as const, content: "Run the focused tests" }],
            createdAt: "2026-08-26T14:00:00.000Z",
          },
        ],
      }));
      return {
        outcome: "unknown" as const,
        requestId: input.requestId,
        error: "The response was lost",
      };
    });

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
    expect(input.textContent).toBe("");
  });

  test("keeps an unconfirmed prompt ahead of the streamed response", async () => {
    // OpenCode can stream the assistant rows before its authoritative user echo
    // lands. Appending the provisional prompt put the response above it and
    // pinned the prompt to the bottom of the transcript; it must instead stay
    // where it was submitted, ahead of every row the turn has produced.
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "tab-optimistic-ordering";
    const responseRow = {
      id: "assistant-streaming",
      role: "assistant" as const,
      content: "Inspecting the layout",
      parts: [{ type: "text" as const, content: "Inspecting the layout" }],
      createdAt: "2026-08-26T14:02:00.000Z",
    };
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      sessionProjectionMock.mockImplementation(async (projectionInput) => ({
        ...(await defaultProjection(projectionInput)),
        turn: { phase: "running" as const },
        messages: [responseRow],
      }));
      return {
        outcome: "unknown" as const,
        requestId: input.requestId,
        error: "The response was lost",
      };
    });

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("opencode")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Make it narrower" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));

    const list = await screen.findByTestId("native-agent-transcript-test-list");
    await waitFor(() => {
      const rows = [...list.children].map((row) => row.textContent ?? "");
      const promptIndex = rows.findIndex((row) => row.includes("Make it narrower"));
      const responseIndex = rows.findIndex((row) => row.includes("Inspecting the layout"));
      expect(responseIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeLessThan(responseIndex);
    });
  });

  test("places an unconfirmed prompt after captured history and before the streamed response", async () => {
    // The anchor set is the raw ids on screen at submit, so with history
    // present the bubble must land after that history and ahead of the rows the
    // turn produces — not at the front.
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "tab-optimistic-anchor-history";
    const earlierPrompt = {
      id: "server-earlier-prompt",
      role: "user" as const,
      content: "An earlier question",
      parts: [{ type: "text" as const, content: "An earlier question" }],
      createdAt: "2026-08-26T14:00:00.000Z",
    };
    const earlierReply = {
      id: "server-earlier-reply",
      role: "assistant" as const,
      content: "An earlier answer",
      parts: [{ type: "text" as const, content: "An earlier answer" }],
      createdAt: "2026-08-26T14:01:00.000Z",
    };
    const responseRow = {
      id: "assistant-streaming",
      role: "assistant" as const,
      content: "Inspecting the layout",
      parts: [{ type: "text" as const, content: "Inspecting the layout" }],
      createdAt: "2026-08-26T14:03:00.000Z",
    };
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      messages: [earlierPrompt, earlierReply],
    }));
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      sessionProjectionMock.mockImplementation(async (projectionInput) => ({
        ...(await defaultProjection(projectionInput)),
        turn: { phase: "running" as const },
        messages: [earlierPrompt, earlierReply, responseRow],
      }));
      return {
        outcome: "unknown" as const,
        requestId: input.requestId,
        error: "The response was lost",
      };
    });

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("opencode")} isActive />);
    await screen.findByText("An earlier answer");
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Make it narrower" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));

    const list = await screen.findByTestId("native-agent-transcript-test-list");
    await waitFor(() => {
      const rows = [...list.children].map((row) => row.textContent ?? "");
      const priorReplyIndex = rows.findIndex((row) => row.includes("An earlier answer"));
      const promptIndex = rows.findIndex((row) => row.includes("Make it narrower"));
      const responseIndex = rows.findIndex((row) => row.includes("Inspecting the layout"));
      expect(priorReplyIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThan(priorReplyIndex);
      expect(responseIndex).toBeGreaterThan(promptIndex);
    });
  });

  test("does not render a previous session's pending prompt at the top of a resumed transcript", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "tab-optimistic-session-scope";
    const sessionKey = createSessionKey("env-1", tabId);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown" as const,
      requestId: input.requestId,
      error: "The response was lost",
    }));

    renderInAppCommandScope(
      <AgentNativeTab
        tabId={tabId}
        data={{ ...identity("claude"), sessionId: undefined }}
        isActive
      />,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "PENDING-OLD-SESSION-PROMPT" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
          ?.pendingTranscriptConfirmation?.sessionId,
      ).toBe("claude-session"),
    );

    // A resume swaps in a transcript with entirely new ids, so none of the
    // captured anchors survive. The pending prompt belongs to the old session
    // and must not be spliced in above the resumed conversation.
    const current = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(sessionKey)!;
    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          sessionId: "resumed-elsewhere",
          generation: "resumed-generation",
          revision: current.revision + 1,
          messages: [
            {
              id: "resumed-session-user-row",
              role: "user" as const,
              content: "A prompt from the resumed session",
              parts: [{ type: "text" as const, content: "A prompt from the resumed session" }],
              createdAt: "2026-08-26T15:00:00.000Z",
            },
          ],
        });
    });

    const list = await screen.findByTestId("native-agent-transcript-test-list");
    await waitFor(() => {
      const rows = [...list.children].map((row) => row.textContent ?? "");
      expect(rows.some((row) => row.includes("A prompt from the resumed session"))).toBe(true);
      expect(rows.some((row) => row.includes("PENDING-OLD-SESSION-PROMPT"))).toBe(false);
    });
  });

  test("clears a submitted draft after transcript confirmation lands while the environment is unmounted", async () => {
    const tabId = "tab-transcript-confirmed-while-unmounted";
    const sessionKey = createSessionKey("env-1", tabId);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown" as const,
      requestId: input.requestId,
      error: "The response was lost",
    }));

    const first = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
          ?.pendingTranscriptConfirmation?.requestId,
      ).toMatch(/\S/),
    );
    first.unmount();

    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      turn: { phase: "running" as const },
      messages: [
        {
          id: "confirmed-while-unmounted",
          role: "user" as const,
          content: "Run the focused tests",
          parts: [{ type: "text" as const, content: "Run the focused tests" }],
          createdAt: "2026-08-26T14:00:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
    expect((await screen.findByRole("textbox")).textContent).toBe("");
  });

  test("does not mistake an older identical prompt for dispatch confirmation", async () => {
    const tabId = "tab-duplicate-prompt";
    const sessionKey = createSessionKey("env-1", tabId);
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "older-identical-prompt",
          role: "user" as const,
          content: "Run the focused tests",
          parts: [{ type: "text" as const, content: "Run the focused tests" }],
          createdAt: "2026-08-26T13:00:00.000Z",
        },
      ],
    }));
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown" as const,
      requestId: input.requestId,
      error: "The response was lost",
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
      ).toMatch(/\S/),
    );
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Run the focused tests",
    );
  });

  test("does not treat widened transcript history as dispatch confirmation", async () => {
    const tabId = "tab-window-not-confirmation";
    const sessionKey = createSessionKey("env-1", tabId);
    const recentPrompt = {
      id: "recent-user-prompt",
      role: "user" as const,
      content: "Earlier question",
      parts: [{ type: "text" as const, content: "Earlier question" }],
      createdAt: "2026-08-26T13:30:00.000Z",
    };
    const olderPrompt = {
      id: "older-user-prompt",
      role: "user" as const,
      content: "A question from before the window",
      parts: [{ type: "text" as const, content: "A question from before the window" }],
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [recentPrompt],
    }));
    sessionHistoryMock.mockImplementation(async () => [olderPrompt]);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown" as const,
      requestId: input.requestId,
      error: "The response was lost",
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
      ).toMatch(/\S/),
    );

    // Loading earlier history introduces user rows the submit never saw. They
    // are not this prompt's echo, so they must not clear the composer.
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() =>
      expect(
        appCommandStore(nativeAgentProjectionStore).getState().projections.get(sessionKey)?.messages
          .length,
      ).toBe(2),
    );

    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Run the focused tests",
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
    ).toMatch(/\S/);
  });

  test("does not treat an older user row as confirmation when the visible window starts with an assistant", async () => {
    const tabId = "tab-assistant-window-not-confirmation";
    const sessionKey = createSessionKey("env-1", tabId);
    const recentReply = {
      id: "recent-assistant-reply",
      role: "assistant" as const,
      content: "A reply whose prompt is outside the window",
      parts: [{ type: "text" as const, content: "A reply whose prompt is outside the window" }],
      createdAt: "2026-08-26T13:30:00.000Z",
    };
    const olderPrompt = {
      id: "older-user-before-assistant-window",
      role: "user" as const,
      content: "A question from before the window",
      parts: [{ type: "text" as const, content: "A question from before the window" }],
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    sessionProjectionMock.mockImplementation(async (projectionInput) => ({
      ...(await defaultProjection(projectionInput)),
      messages: [recentReply],
    }));
    sessionHistoryMock.mockImplementation(async () => [olderPrompt]);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (dispatchInput) => ({
      outcome: "unknown" as const,
      requestId: dispatchInput.requestId,
      error: "The response was lost",
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
      ).toMatch(/\S/),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() =>
      expect(
        appCommandStore(nativeAgentProjectionStore).getState().projections.get(sessionKey)?.messages
          .length,
      ).toBe(2),
    );

    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Run the focused tests",
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
        ?.pendingTranscriptConfirmation?.requestId,
    ).toMatch(/\S/);
  });

  test("honours a transcript confirmation that lands while the dispatch is still in flight", async () => {
    const tabId = "tab-echo-before-response";
    const sessionKey = createSessionKey("env-1", tabId);
    let releaseDispatch = () => {};
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      (input) =>
        new Promise<NativeAgentDispatchOutcome>((resolve) => {
          releaseDispatch = () =>
            resolve({
              outcome: "unknown",
              requestId: input.requestId,
              error: "The response was lost",
            });
        }),
    );

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));

    // The authoritative row arrives before the dispatch response does. The
    // still-pending send must adopt that verdict instead of restoring the
    // draft and reporting an unconfirmed dispatch over it.
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
            {
              id: "echoed-user-prompt",
              role: "user" as const,
              content: "Run the focused tests",
              parts: [{ type: "text" as const, content: "Run the focused tests" }],
              createdAt: "2026-08-26T14:00:00.000Z",
            },
          ],
        });
    });
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );

    await act(async () => {
      releaseDispatch();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
  });

  test.each(
    [
      { outcome: "accepted", origin: undefined },
      { outcome: "unknown", origin: "provider" },
      { outcome: "unknown", origin: "transport" },
    ].flatMap(({ outcome, origin }) => [
      { outcome, origin, recreateDraft: false },
      { outcome, origin, recreateDraft: true },
    ]) as Array<{
      outcome: "accepted" | "unknown";
      origin?: "provider" | "transport";
      recreateDraft: boolean;
    }>,
  )(
    "settles a first prompt echoed before $outcome/$origin with recreated draft: $recreateDraft",
    async ({ outcome, origin, recreateDraft }) => {
      const tabId = `tab-first-prompt-echo-before-${outcome}-${origin}`;
      fixtureState.renderVirtualizedMessages = true;
      const sessionKey = createSessionKey("env-1", tabId);
      // A brand-new tab has no provider session until its first prompt creates
      // one, and that dispatch only returns after the CLI has started.
      sessionProjectionMock.mockImplementation(async (projectionInput) => ({
        ...(await defaultProjection(projectionInput)),
        sessionId: undefined,
      }));
      let releaseDispatch = () => {};
      dispatchNativeAgentIntentMock.mockImplementationOnce(
        (input) =>
          new Promise<NativeAgentDispatchOutcome>((resolve) => {
            releaseDispatch = () =>
              resolve(
                outcome === "accepted"
                  ? { outcome, requestId: input.requestId }
                  : { outcome, origin, requestId: input.requestId, error: "The response was lost" },
              );
          }),
      );

      renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("claude"), sessionId: undefined }}
          isActive
        />,
      );
      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Free up some disk space" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
          ?.pendingTranscriptConfirmation?.sessionId,
      ).toBe("");

      const current = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;
      publishProjection(sessionKey, {
        ...current,
        sessionId: "new-claude-session",
        turn: { phase: "running" as const },
        revision: current.revision + 1,
        messages: [
          {
            id: "first-prompt-user-row",
            role: "user" as const,
            content: "Free up some disk space",
            parts: [{ type: "text" as const, content: "Free up some disk space" }],
            createdAt: "2026-10-27T11:57:00.000Z",
          },
        ],
      });
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
        ).toBeUndefined(),
      );

      expect(Array.from(latestRenderedMessageActions.keys())).toEqual(["first-prompt-user-row"]);
      // The composer is disabled during submission, but another surface can
      // still recreate its draft: design images and persistence both write here.
      const { addDesignImagesToDraft } = await import("../design/design-prompt-images");
      const nextImage = {
        id: "next-image",
        type: "image" as const,
        path: "/tmp/next.png",
        name: "next.png",
      };
      if (recreateDraft)
        act(() => {
          expect(addDesignImagesToDraft(sessionKey, [nextImage])).toBe(true);
          nativeComposePersistenceStore.getState().setDraftText(sessionKey, "And clear /tmp");
        });
      await act(async () => {
        releaseDispatch();
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(screen.getByRole("textbox").textContent).toBe(recreateDraft ? "And clear /tmp" : ""),
      );
      if (recreateDraft) {
        expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toMatchObject(
          {
            text: "And clear /tmp",
            attachments: [nextImage],
          },
        );
      } else {
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
        ).toBeUndefined();
      }
      expect(Array.from(latestRenderedMessageActions.keys())).toEqual(["first-prompt-user-row"]);
      expect(screen.queryByText(/connection dropped before/) === null).toBe(true);
      expect(screen.queryByText("The response was lost") === null).toBe(true);
      expect(mockToastError).not.toHaveBeenCalled();
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["before acceptance", "after acceptance"] as const)(
    "retires the first optimistic prompt when its session id arrives %s and its echo arrives later",
    async (adoptionOrder) => {
      fixtureState.renderVirtualizedMessages = true;
      const tabId = `tab-ack-before-echo-${adoptionOrder}`;
      const sessionKey = createSessionKey("env-1", tabId);
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input)),
        sessionId: undefined,
      }));
      let releaseDispatch = () => {};
      dispatchNativeAgentIntentMock.mockImplementationOnce(
        (input) =>
          new Promise<NativeAgentDispatchOutcome>((resolve) => {
            releaseDispatch = () => resolve({ outcome: "accepted", requestId: input.requestId });
          }),
      );
      renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={{ ...identity("claude"), sessionId: undefined }}
          isActive
        />,
      );
      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Free up some disk space" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      const adoptSession = () => {
        const current = appCommandStore(nativeAgentProjectionStore)
          .getState()
          .projections.get(sessionKey)!;
        publishProjection(sessionKey, {
          ...current,
          sessionId: "new-claude-session",
          revision: current.revision + 1,
        });
      };
      if (adoptionOrder === "before acceptance") {
        adoptSession();
        await waitFor(() =>
          expect(
            appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
              ?.pendingTranscriptConfirmation?.sessionId,
          ).toBe("new-claude-session"),
        );
        expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
          "Free up some disk space",
        );
      }
      await act(async () => {
        releaseDispatch();
      });
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
        ).toBeUndefined(),
      );
      if (adoptionOrder === "after acceptance") adoptSession();
      expect(latestRenderedMessageActions.size).toBe(1);
      const current = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;
      publishProjection(sessionKey, {
        ...current,
        revision: current.revision + 1,
        messages: [
          {
            id: "accepted-first-echo",
            role: "user",
            content: "Free up some disk space",
            parts: [{ type: "text", content: "Free up some disk space" }],
            createdAt: "2026-10-27T11:57:00.000Z",
          },
        ],
      });
      await waitFor(() =>
        expect(Array.from(latestRenderedMessageActions.keys())).toEqual(["accepted-first-echo"]),
      );
      // Removing the authoritative row must not bring the provisional row back.
      publishProjection(sessionKey, { ...current, revision: current.revision + 2, messages: [] });
      await waitFor(() => expect(latestRenderedMessageActions.size).toBe(0));
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined();
    },
  );

  test("adopts an empty first-session confirmation after remount and waits for its later echo", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "tab-first-confirmation-remount";
    const sessionKey = createSessionKey("env-1", tabId);
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      sessionId: undefined,
    }));
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown",
      requestId: input.requestId,
      origin: "provider",
    }));
    const props = { tabId, data: { ...identity("claude"), sessionId: undefined }, isActive: true };
    const view = renderInAppCommandScope(<AgentNativeTab {...props} />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Free up some disk space" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true"),
    );
    const confirmation = appCommandStore(nativeComposeStore)
      .getState()
      .drafts.get(sessionKey)!.pendingTranscriptConfirmation!;
    expect(confirmation.sessionId).toBe("");
    view.unmount();
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      sessionId: "new-claude-session",
    }));
    const remounted = renderInAppCommandScope(<AgentNativeTab {...props} />);
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
          ?.pendingTranscriptConfirmation,
      ).toEqual({ ...confirmation, sessionId: "new-claude-session" }),
    );
    expect(screen.getByRole("textbox").textContent).toBe("Free up some disk space");
    expect(latestRenderedMessageActions.size).toBe(0);
    // A second remount proves adoption lives in the draft, beyond local state.
    remounted.unmount();
    renderInAppCommandScope(<AgentNativeTab {...props} />);
    await screen.findByRole("textbox");
    const current = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(sessionKey)!;
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          revision: current.revision + 1,
          messages: [
            {
              id: "remounted-first-echo",
              role: "user",
              content: "Free up some disk space",
              parts: [{ type: "text", content: "Free up some disk space" }],
              createdAt: "2026-10-27T11:57:00.000Z",
            },
          ],
        }),
    );
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
    expect(screen.getByRole("textbox").textContent).toBe("");
    expect(Array.from(latestRenderedMessageActions.keys())).toEqual(["remounted-first-echo"]);
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
  });

  test.each(["dropped", "different request"] as const)(
    "uses the optimistic confirmation when the draft confirmation is %s",
    async (replacement) => {
      fixtureState.renderVirtualizedMessages = true;
      const tabId = `tab-confirmation-fallback-${replacement}`;
      const sessionKey = createSessionKey("env-1", tabId);
      dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
        outcome: "unknown",
        requestId: input.requestId,
        origin: "provider",
      }));
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true"),
      );
      act(() => {
        nativeComposePersistenceStore.getState().setDraftText(sessionKey, "A newer draft");
        if (replacement === "different request")
          nativeComposePersistenceStore.getState().setDraftMetadata?.(sessionKey, {
            requestId: "newer-request",
            pendingTranscriptConfirmation: {
              requestId: "newer-request",
              sessionId: "another-session",
              priorMessageIds: [],
            },
          });
      });
      const newerDraft = appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey);
      const current = appCommandStore(nativeAgentProjectionStore)
        .getState()
        .projections.get(sessionKey)!;
      act(() =>
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProjection(sessionKey, {
            ...current,
            revision: current.revision + 1,
            messages: [
              {
                id: "fallback-echo",
                role: "user",
                content: "Run the focused tests",
                parts: [{ type: "text", content: "Run the focused tests" }],
                createdAt: "2026-10-27T11:57:00.000Z",
              },
            ],
          }),
      );
      await waitFor(() =>
        expect(Array.from(latestRenderedMessageActions.keys())).toEqual(["fallback-echo"]),
      );
      act(() =>
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProjection(sessionKey, { ...current, revision: current.revision + 2, messages: [] }),
      );
      await waitFor(() => expect(latestRenderedMessageActions.size).toBe(0));
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBe(
        newerDraft,
      );
      expect(screen.getByRole("textbox").textContent).toBe("A newer draft");
    },
  );

  test("keeps a prompt typed after an unconfirmed send when the echo finally arrives", async () => {
    const tabId = "tab-late-echo-guard";
    const sessionKey = createSessionKey("env-1", tabId);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown" as const,
      requestId: input.requestId,
      error: "The response was lost",
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
      ).toMatch(/\S/),
    );

    // Editing the composer releases the dispatch's claim on the draft, which
    // is what stops a late echo deleting the prompt typed in its place.
    fireEvent.input(input, { target: { textContent: "A different question" } });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId ===
          undefined,
      ).toBe(true),
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
        ?.pendingTranscriptConfirmation,
    ).toBeUndefined();

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
            {
              id: "late-echoed-prompt",
              role: "user" as const,
              content: "Run the focused tests",
              parts: [{ type: "text" as const, content: "Run the focused tests" }],
              createdAt: "2026-08-26T14:00:00.000Z",
            },
          ],
        });
    });

    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "A different question",
    );
  });

  test("does not use a resumed session's user row to confirm the previous session's dispatch", async () => {
    const tabId = "tab-confirmation-session-scope";
    const sessionKey = createSessionKey("env-1", tabId);
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => ({
      outcome: "unknown" as const,
      requestId: input.requestId,
      error: "The response was lost",
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Run the focused tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
          ?.pendingTranscriptConfirmation?.sessionId,
      ).toBe("claude-session"),
    );

    const current = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(sessionKey)!;
    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          sessionId: "resumed-elsewhere",
          generation: "resumed-generation",
          revision: current.revision + 1,
          messages: [
            {
              id: "resumed-session-user-row",
              role: "user" as const,
              content: "A prompt from the resumed session",
              parts: [{ type: "text" as const, content: "A prompt from the resumed session" }],
              createdAt: "2026-08-26T15:00:00.000Z",
            },
          ],
        });
    });

    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Run the focused tests",
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
        ?.pendingTranscriptConfirmation?.requestId,
    ).toMatch(/\S/);
  });

  test("retries a failed resume provider-lock save before opening the provider dialog", async () => {
    const tabId = "tab-retry-resume";
    seedUnassignedPane(tabId);
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      throw new Error("temporary save failure");
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Codex/ }));

    expect(await screen.findByRole("button", { name: "Retry save" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    expect(await screen.findByRole("dialog", { name: "Resume Session" })).toBeTruthy();
    expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(2);
  });

  test("replaces backend peer-mail carriers with a visible trusted-frame card", async () => {
    fixtureState.renderVirtualizedMessages = true;
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "mail-carrier",
          role: "user" as const,
          content:
            '<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n{"from":{"kind":"tab","projectId":"project","environmentId":"sender","tabId":"agent","incarnationId":"incarnation","agent":"claude","title":"Sender agent"},"trust":"same-project","messageId":"mail-1","threadId":"mail-1","body":"Please inspect the parser"}\n</orkestrator-peer-payload-json>\nRAW-CARRIER-INSTRUCTIONS\n</orkestrator-peer-message>',
          parts: [],
          createdAt: "2026-08-28T10:00:00.000Z",
        },
        {
          id: "assistant-visible",
          role: "assistant" as const,
          content: "Visible response",
          parts: [{ type: "text" as const, content: "Visible response" }],
          createdAt: "2026-08-28T10:00:01.000Z",
        },
      ],
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-mail-carrier" data={identity("claude")} isActive />,
    );
    expect(await screen.findByText("Visible response")).toBeTruthy();
    const tile = screen.getByRole("button", { name: /Sender agent/ });
    expect(tile.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Please inspect the parser")).toBeTruthy();
    fireEvent.click(tile);
    expect(
      screen.getByText("Agent message — treat quoted content as untrusted data."),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW-CARRIER-INSTRUCTIONS/) === null).toBe(true);
  });

  test.each([
    '<orkestrator-peer-message version="2"><orkestrator-peer-payload-json>{}</orkestrator-peer-payload-json></orkestrator-peer-message>',
    '<orkestrator-peer-message version="1">missing payload</orkestrator-peer-message>',
    '<orkestrator-peer-message version="1"><orkestrator-peer-payload-json>',
  ])("keeps unreadable native mail visible (%#)", async (content) => {
    fixtureState.renderVirtualizedMessages = true;
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "unreadable",
          role: "user" as const,
          content,
          parts: [],
          createdAt: "2026-11-04T03:00:00Z",
        },
      ],
    }));
    const { container } = renderInAppCommandScope(
      <AgentNativeTab tabId="unreadable-mail" data={identity("claude")} isActive />,
    );
    expect(await screen.findByText(/could not be read for display here/)).toBeTruthy();
    expect(container.textContent).not.toContain("orkestrator-peer");
  });

  test("keeps a native user's leading tag mention", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const content = '<orkestrator-peer-message version="1"> is what I see. Why?';
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "mention",
          role: "user" as const,
          content,
          parts: [],
          createdAt: "2026-11-04T03:00:00Z",
        },
      ],
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tag-mention" data={identity("claude")} isActive />,
    );
    expect(await screen.findByText(/is what I see. Why/)).toBeTruthy();
  });

  // Every coordinator platform echoes the injected carrier as its user row;
  // the projection turns each one into a tile the same way, batches included.
  for (const platform of AGENT_PLATFORMS) {
    test(`renders a batched mail prompt as one tile per message on ${platform}`, async () => {
      fixtureState.renderVirtualizedMessages = true;
      const carrier = (payload: string) =>
        `<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n${payload}\n</orkestrator-peer-payload-json>\nInstructions.\n</orkestrator-peer-message>`;
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input)),
        messages: [
          {
            id: `mail-batch-${platform}`,
            role: "user" as const,
            content: [
              carrier(
                '{"kind":"message","from":{"kind":"tab","projectId":"project","environmentId":"worker","tabId":"startup-agent","incarnationId":"i","agent":"codex","title":"Worker one"},"trust":"same-project","messageId":"mail-a","threadId":"mail-a","subject":"Report","body":"Worker report body"}',
              ),
              carrier(
                '{"kind":"notice","from":{"kind":"system","projectId":"project","source":"workflow","resourceId":"review-1"},"trust":"same-project","messageId":"mail-b","threadId":"mail-b","subject":"Multi Review failed","notice":{"resource":{"kind":"multi-review","id":"review-1"},"state":"failed","tone":"failure"},"body":"Review failed body"}',
              ),
            ].join("\n\n"),
            parts: [],
            createdAt: "2026-08-28T10:00:00.000Z",
          },
        ],
      }));

      const { container } = renderInAppCommandScope(
        <AgentNativeTab tabId={`tab-mail-${platform}`} data={identity(platform)} isActive />,
      );
      expect(await screen.findByText("Worker report body")).toBeTruthy();
      const tiles = Array.from(container.querySelectorAll<HTMLElement>("[data-mail-tile]"));
      expect(tiles.map((tile) => [tile.dataset.mailKind, tile.dataset.mailTone])).toEqual([
        ["message", "message"],
        ["notice", "failure"],
      ]);
      expect(screen.getByText("Review failed body")).toBeTruthy();
      expect(screen.queryByText(/Instructions\./) === null).toBe(true);
    });
  }

  for (const platform of AGENT_PLATFORMS) {
    test(`routes ${platform} through the shared authoritative projection`, async () => {
      renderInAppCommandScope(
        <AgentNativeTab tabId={`tab-${platform}`} data={identity(platform)} isActive />,
      );

      expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
      expect(adoptNativeAgentSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: platform,
          environmentId: "env-1",
          logicalSessionKey: `env-env-1:tab-${platform}`,
          providerSessionId: `${platform}-session`,
        }),
      );
      expect(sessionProjectionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: platform,
          environmentId: "env-1",
        }),
      );
    });
  }

  test("carries one-shot launch options into the adoption of a resumed session", async () => {
    // Multi Review hands its consolidation session over as a Build-mode tab, so
    // the mode has to reach adoption; adopting without it would leave the fix
    // agent in whatever mode consolidation left behind (plan).
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-resume-controls"
        data={identity("claude")}
        isActive
        initialAgentModel="opus"
        initialReasoningEffort="high"
        initialConversationMode="build"
        initialFastMode={false}
      />,
    );

    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      providerSessionId: "claude-session",
      model: "opus",
      reasoningEffort: "high",
      sessionMode: "build",
      fastMode: false,
    });
  });

  test("does not overwrite a resumed session with configured defaults", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        agentSettings: { platforms: { claude: { model: "configured-default" } } },
      });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-resume-preserve-controls" data={identity("claude")} isActive />,
    );

    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    const adopted = adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(adopted).not.toHaveProperty("model");
    expect(adopted).not.toHaveProperty("reasoningEffort");
    expect(adopted).not.toHaveProperty("sessionMode");
    expect(adopted).not.toHaveProperty("fastMode");

    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        agentSettings: { platforms: { claude: { model: "claude-sonnet-5" } } },
      });
  });

  test("applies a configured Cursor fast-mode default to a new session", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["cursor"],
        agentSettings: { platforms: { cursor: { fastMode: true } } },
      });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-cursor-fast-default"
        data={{
          platform: "cursor",
          environmentId: "env-1",
          containerId: "container-1",
          isLocal: false,
        }}
        isActive
      />,
    );

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    expect(ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      agent: "cursor",
      fastMode: true,
    });
  });

  test("applies configured Claude SDK parameters after locking an unassigned tab", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: {
              claudeThinkingMode: "budget-16384",
              claudeContext1m: true,
              claudeChrome: true,
            },
          },
        },
      });
    const tabId = "tab-claude-first-send-params";
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(createSessionKey("env-1", tabId), {
      text: "Use inherited Claude controls",
      platform: "claude",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    expect(ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      agent: "claude",
      parameterValues: { thinking: "budget-16384", context1m: true, chrome: true },
    });
  });

  test("forwards an explicit disconnected OpenCode model without a fallback toast", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["opencode"],
        agentSettings: { platforms: { opencode: { model: "opencode-go/gpt-5.6-luna" } } },
      });
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-opencode-explicit"
        data={freshTab("opencode")}
        isActive
        initialAgentModel="opencode/claude-sonnet-5"
      />,
    );
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    expect(ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      model: "opencode/claude-sonnet-5",
      modelSource: "explicit",
    });
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  test("tells the user, once, when a new OpenCode session starts on a substituted model", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["opencode"],
        agentSettings: { platforms: { opencode: { model: "opencode/claude-sonnet-5" } } },
      });
    const message = "claude-sonnet-5 isn't available with your OpenCode login; using GPT-5.6 Luna.";
    ensureNativeAgentSessionMock.mockImplementation(async (input) => ({
      ...(await defaultEnsureNativeAgentSession(input)),
      modelSubstitution: {
        requestedModelId: "opencode/claude-sonnet-5",
        modelId: "opencode-go/gpt-5.6-luna",
        message,
      },
    }));
    // The session itself carries the notice, so a session its first prompt's
    // dispatch created (an answer with no room for it) still shows it.
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      notices: [
        {
          kind: "advisory" as const,
          severity: "info" as const,
          message,
          occurrenceId: "model-substitution:2026-11-09T10:00:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-opencode-substituted" data={freshTab("opencode")} isActive />,
    );

    await waitFor(() =>
      expect(mockToastInfo).toHaveBeenCalledWith(
        message,
        expect.objectContaining({ duration: Infinity }),
      ),
    );
    // Shown from the projection alone: the ensure answer does not toast it again.
    expect(mockToastInfo.mock.calls.filter(([text]) => text === message)).toHaveLength(1);
    // The configured model is still what the tab asked for; the backend owns
    // the substitution, so the saved choice survives a reconnect.
    expect(ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      agent: "opencode",
      model: "opencode/claude-sonnet-5",
      modelSource: "default",
    });
  });

  test("marks a premium-rate selection in the composer without naming the provider", async () => {
    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      return {
        ...projection,
        composer: {
          ...projection.composer!,
          selectionPricing: {
            tier: "premium" as const,
            label: "Max mode",
            description: "Bills at premium rates.",
          },
        },
      };
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-cursor-pricing" data={identity("cursor")} isActive />,
    );

    const badge = await screen.findByTestId("composer-selection-pricing");
    expect(badge.textContent).toBe("Max mode");
    expect(badge.getAttribute("title")).toBe("Bills at premium rates.");
  });

  test("applies configured Claude SDK parameters to a new session", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        agentSettings: {
          platforms: {
            claude: {
              claudeThinkingMode: "budget-16384",
              claudeContext1m: true,
              claudeChrome: true,
            },
          },
        },
      });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-sdk-defaults" data={freshTab("claude")} isActive />,
    );

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    expect(ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      agent: "claude",
      parameterValues: { thinking: "budget-16384", context1m: true, chrome: true },
    });
  });

  test("rehydrates a Chrome-enabled Claude session created while its environment is inactive", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        agentSettings: { platforms: { claude: { claudeChrome: true } } },
      });
    let settleEnsure: (() => void) | undefined;
    ensureNativeAgentSessionMock.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          settleEnsure = () => resolve(defaultEnsureNativeAgentSession(input));
        }),
    );
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      composerControls: [
        { kind: "toggle" as const, id: "parameter:chrome", label: "Chrome", value: true },
      ],
    }));

    const view = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-chrome-inactive" data={freshTab("claude")} isActive />,
    );
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(ensureNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      agent: "claude",
      parameterValues: { chrome: true },
    });
    view.rerender(
      <AgentNativeTab
        tabId="tab-claude-chrome-inactive"
        data={freshTab("claude")}
        isActive={false}
      />,
    );
    await act(async () => {
      settleEnsure!();
    });
    sessionProjectionMock.mockClear();
    view.rerender(
      <AgentNativeTab tabId="tab-claude-chrome-inactive" data={identity("claude")} isActive />,
    );
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Chrome: On" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    view.unmount();
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    sessionProjectionMock.mockClear();

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-chrome-inactive" data={identity("claude")} isActive />,
    );
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Chrome: On" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  test("renders an unrelated Claude parameter supplied by the projection", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      composerControls: [
        {
          kind: "toggle" as const,
          id: "parameter:audit",
          label: "Audit mode",
          value: false,
        },
      ],
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-hidden-parameters" data={freshTab("claude")} isActive />,
    );

    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    expect(screen.getByText(/Audit mode: Off/)).toBeTruthy();
  });

  const claudeSessionControls = [
    {
      kind: "select" as const,
      id: "parameter:thinking",
      label: "Thinking",
      value: "adaptive",
      options: [{ id: "adaptive", label: "Adaptive" }],
    },
    {
      kind: "toggle" as const,
      id: "parameter:context1m",
      label: "1M context beta",
      value: false,
    },
    {
      kind: "toggle" as const,
      id: "parameter:audit",
      label: "Audit mode",
      value: false,
    },
  ];

  const codexParameterControls = [
    {
      kind: "select" as const,
      id: "parameter:summary",
      label: "Reasoning summary",
      value: "auto",
      options: [{ id: "auto", label: "Automatic" }],
    },
    {
      kind: "select" as const,
      id: "parameter:effort",
      label: "Effort",
      value: "medium",
      options: [{ id: "medium", label: "Medium" }],
    },
    {
      kind: "toggle" as const,
      id: "parameter:audit",
      label: "Audit mode",
      value: false,
    },
  ];

  // The renderer guard keys on the platform alone, so it must behave the same
  // in an ordinary tab and a review tab. Both are covered for each provider.
  test.each([
    ["review", true],
    ["ordinary", false],
  ] as const)("hides Claude thinking and context controls in a %s tab", async (kind, review) => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      composerControls: claudeSessionControls,
    }));

    renderInAppCommandScope(
      <AgentNativeTab
        tabId={`tab-claude-${kind}-parameters`}
        data={identity("claude")}
        isActive
        isReviewTab={review}
      />,
    );

    expect(await screen.findByText(/Audit mode: Off/)).toBeTruthy();
    expect(screen.queryByText(/Thinking: Adaptive/) === null).toBe(true);
    expect(screen.queryByText(/1M context beta: Off/) === null).toBe(true);
  });

  test.each([
    ["review", true],
    ["ordinary", false],
  ] as const)("suppresses no Codex parameter control in a %s tab", async (kind, review) => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      composerControls: codexParameterControls,
    }));

    renderInAppCommandScope(
      <AgentNativeTab
        tabId={`tab-codex-${kind}-parameters`}
        data={identity("codex")}
        isActive
        isReviewTab={review}
      />,
    );

    expect(await screen.findByText(/Audit mode: Off/)).toBeTruthy();
    expect(screen.getByText(/Effort: Medium/)).toBeTruthy();
    // Codex has no suppression entry, so a descriptor named `summary` renders
    // like any other parameter; the backend simply no longer produces one.
    expect(screen.getByText(/Reasoning summary: Automatic/)).toBeTruthy();
  });

  test("renders model parameters supplied for a non-Claude platform", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      composerControls: [
        {
          kind: "select" as const,
          id: "parameter:thinking",
          label: "Thinking",
          value: "adaptive",
          options: [{ id: "adaptive", label: "Adaptive" }],
        },
        {
          kind: "toggle" as const,
          id: "parameter:context1m",
          label: "1M context beta",
          value: false,
        },
      ],
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-cursor-parameters" data={freshTab("cursor")} isActive />,
    );

    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    expect(screen.getByText(/Thinking: Adaptive/)).toBeTruthy();
    expect(screen.getByText(/1M context beta: Off/)).toBeTruthy();
  });

  test("drops a configured speed default for a model that does not support it", async () => {
    appCommandStore(agentModelCatalogStore).setState({
      cursorModels: [
        {
          platform: "cursor",
          id: "normal-only",
          label: "Normal only",
          supportsSpeed: false,
        },
      ],
      grokModels: [],
      piModels: [],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["cursor"],
        agentSettings: {
          platforms: { cursor: { model: "normal-only", fastMode: true } },
        },
      });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-cursor-unsupported-fast-default"
        data={{
          platform: "cursor",
          environmentId: "env-1",
          containerId: "container-1",
          isLocal: false,
        }}
        isActive
      />,
    );

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    const input = ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(input.fastMode).toBeUndefined();
  });

  test("consumes a mode-only launch option before a resumed tab remounts", async () => {
    const tabId = "tab-mode-only";
    seedAssignedPane(tabId, { initialConversationMode: "build" });
    const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() => {
      const tab = appCommandStore(paneLayoutStore)
        .getState()
        .getAllTabs("env-1")
        .find((candidate) => candidate.id === tabId);
      expect(tab?.initialConversationMode).toBeUndefined();
    });
    expect(adoptNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      sessionMode: "build",
    });

    first.unmount();
    adoptNativeAgentSessionMock.mockClear();
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("sessionMode");
  });

  test("consumes an execution-profile launch option before a resumed tab remounts", async () => {
    // The profile is pinned by the unassigned launcher and has to survive the
    // hand-off to the locked tab, which adopts rather than creates. Leaving it
    // on the pane would re-apply it to a later session the user never chose it
    // for, so the second mount must adopt without it.
    const tabId = "tab-profile-only";
    seedAssignedPane(tabId, { initialExecutionProfileId: "plan" });
    const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() => {
      const tab = appCommandStore(paneLayoutStore)
        .getState()
        .getAllTabs("env-1")
        .find((candidate) => candidate.id === tabId);
      expect(tab?.initialExecutionProfileId).toBeUndefined();
    });
    expect(adoptNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      executionProfileId: "plan",
    });

    first.unmount();
    adoptNativeAgentSessionMock.mockClear();
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "executionProfileId",
    );
  });

  test("consumes an explicit false fast-mode option", async () => {
    const tabId = "tab-fast-only";
    seedAssignedPane(tabId, { initialFastMode: false });
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() => {
      const tab = appCommandStore(paneLayoutStore)
        .getState()
        .getAllTabs("env-1")
        .find((candidate) => candidate.id === tabId);
      expect(tab?.initialFastMode).toBeUndefined();
    });
    expect(adoptNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      fastMode: false,
    });
  });

  test("sends a resumed tab's opening prompt once it is in the session it asked for", async () => {
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-resume-prompt"
        data={identity("claude")}
        isActive
        initialPrompt={ADDRESS_ALL_REVIEW_PROMPT}
      />,
    );

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
    expect(dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      prompt: ADDRESS_ALL_REVIEW_PROMPT,
    });
  });

  for (const failure of ["rejected", "transport"] as const) {
    for (const edited of [false, true]) {
      test(`queue hand-off owns a pending ${failure} fallback and preserves edits=${edited}`, async () => {
        const tabId = `tab-opening-race-${failure}-${edited}`;
        const sessionKey = createSessionKey("env-1", tabId);
        const key = composeDraftKey("claude", "env-1", sessionKey);
        const prompt = "Use the design MCP server to build the header";
        const image = {
          id: "opening-image",
          type: "image" as const,
          path: ".orkestrator/opening.png",
          name: "opening.png",
        };
        seedAssignedPane(tabId, { initialPrompt: prompt });
        appCommandStore(nativeComposeStore)
          .getState()
          .updateDraft(sessionKey, { attachments: [image] });
        sessionProjectionMock.mockImplementation(async (input) => {
          const projection = await defaultProjection(input);
          return {
            ...projection,
            capabilities: {
              ...projection.capabilities,
              attachments: { images: true, files: true },
            },
          };
        });
        let finish!: (outcome: NativeAgentDispatchOutcome) => void;
        dispatchNativeAgentIntentMock.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const view = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
        await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
        expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
          requestId: `initial-prompt:env-1:${tabId}`,
          prompt,
          attachments: [{ type: "image", path: image.path, filename: image.name }],
        });
        if (edited)
          act(() =>
            appCommandStore(nativeComposeStore)
              .getState()
              .updateDraft(sessionKey, { text: "My follow-up" }),
          );
        view.unmount(); // Background completion must also work without the tab mounted.
        await handTabInitialPromptToBackend({
          environmentId: "env-1",
          tabId,
          agent: "claude",
          prompt,
          options: { attachments: [{ type: "image", path: image.path }] },
        });
        await act(async () =>
          finish(
            failure === "rejected"
              ? { outcome: "rejected", error: "Busy" }
              : {
                  outcome: "unknown",
                  origin: "transport",
                  requestId: `initial-prompt:env-1:${tabId}`,
                  error: "Offline",
                },
          ),
        );
        await awaitComposeDraftWrites(key);
        expect(
          nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey),
        ).toMatchObject({
          text: edited ? "My follow-up" : "",
          attachments: [],
        });
        expect(composeDraftRecords.get(key)?.value).toMatchObject({
          text: edited ? "My follow-up" : "",
          attachments: [],
        });
        expect(
          appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.initialPrompt,
        ).toBeUndefined();
      });
    }
  }

  test("never queues an opening prompt behind a running turn", async () => {
    // The backend prompt queue may already be running this very prompt under
    // its stable id. Queueing it again would carry no id and send it twice, so
    // the tab waits for idle and sends it under the id the backend dedupes.
    let phase: "running" | "idle" = "running";
    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      return {
        ...projection,
        capabilities: { ...projection.capabilities, queue: true },
        turn: { phase },
      };
    });
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-opening-running"
        data={identity("codex")}
        isActive
        initialPrompt="Summarize this repository"
      />,
    );

    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    });
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    phase = "idle";
    await act(async () => {
      dispatchResourceChange({ resource: "native-agent-session", id: "env-1", revision: 2 });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 120);
      });
    });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Summarize this repository",
      requestId: "initial-prompt:env-1:tab-opening-running",
    });
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
  });

  test("withholds a resumed tab's opening prompt when the session was substituted", async () => {
    // Adoption falls back to creating a fresh session when the provider has
    // forgotten the rollout. "Address every finding" carries no findings of its
    // own, so firing it into an empty conversation asks the agent to act on a
    // review it cannot see.
    adoptNativeAgentSessionMock.mockImplementation(async () => {
      throw new Error("provider session was not found");
    });
    ensureNativeAgentSessionMock.mockImplementation(async (input) => ({
      ...(await defaultEnsureNativeAgentSession(input)),
      providerSessionId: "a-replacement-session",
    }));
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as Parameters<typeof defaultProjection>[0])),
      sessionId: "a-replacement-session",
    }));

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-resume-substituted"
        data={identity("claude")}
        isActive
        initialPrompt={ADDRESS_ALL_REVIEW_PROMPT}
      />,
    );

    expect(await screen.findByText(/opening message was not sent/)).toBeTruthy();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("waits for environment setup before starting the shared provider", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Setting up",
          order: 0,
          setupPhase: "running",
        } as never,
      ],
    });
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-setup" data={identity("claude")} isActive />,
    );
    expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    expect(adoptNativeAgentSessionMock).not.toHaveBeenCalled();

    appCommandStore(environmentStore).setState((state) => ({
      environments: state.environments.map((environment) => ({
        ...environment,
        setupPhase: "ready" as const,
      })),
    }));
    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalledTimes(1));
  });

  test("does not apply worker setup gating to a coordinator runtime", async () => {
    appCommandStore(environmentStore).setState({ environments: [] });
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab"
        data={{
          platform: "codex",
          environmentId: "coordinator:workspace-1:conversation-1",
          isLocal: true,
        }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorWorkspacePath="/tmp/project"
      />,
    );

    expect(screen.queryByText("Waiting for setup scripts to complete...") === null).toBe(true);
    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getLocalFileTreeMock).toHaveBeenCalledWith("/tmp/project"));
    expect(ensureNativeAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        environmentId: "coordinator:workspace-1:conversation-1",
      }),
    );
  });

  test("applies repository model defaults to a coordinator runtime", async () => {
    appCommandStore(environmentStore).setState({ environments: [] });
    appCommandStore(configStore)
      .getState()
      .setRepositoryConfig("coordinator-project", {
        defaultBranch: "main",
        prBaseBranch: "main",
        agentSettings: {
          platforms: { codex: { model: "gpt-repository", reasoningEffort: "high" } },
        },
      });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-defaults-tab"
        data={{
          platform: "codex",
          environmentId: "coordinator:workspace-1:conversation-defaults",
          isLocal: true,
        }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="coordinator-project"
        coordinatorWorkspacePath="/tmp/project"
      />,
    );

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    expect(ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "coordinator:workspace-1:conversation-defaults",
      model: "gpt-repository",
      reasoningEffort: "high",
    });
  });

  test.each([...AGENT_PLATFORMS])(
    "loads a transferred conversation for a %s tab",
    async (platform) => {
      // The destination side used to gate on the three legacy providers, so a
      // Cursor or Grok tab silently dropped the transfer it was opened to carry
      // and never even asked for it.
      renderInAppCommandScope(
        <AgentNativeTab
          tabId={`tab-handoff-${platform}`}
          data={identity(platform)}
          isActive
          agentHandoffId={`handoff-into-${platform}`}
        />,
      );

      await waitFor(() =>
        expect(getAgentHandoffMock).toHaveBeenCalledWith(`handoff-into-${platform}`),
      );
    },
  );

  test("keeps transferred Grok history visible after the first Cursor prompt", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const snapshot = createAgentHandoffSnapshot({
      id: "handoff-grok-to-cursor",
      environmentId: "env-1",
      sourceProvider: "grok",
      destinationProvider: "cursor",
      sourceSessionId: "grok-session",
      messages: [
        {
          id: "grok-user-1",
          role: "user",
          content: "Investigate the layout",
          parts: [{ type: "text", content: "Investigate the layout" }],
          createdAt: "2026-09-14T22:00:00.000Z",
        },
        {
          id: "grok-assistant-1",
          role: "assistant",
          content: "I found three concrete gaps",
          parts: [{ type: "text", content: "I found three concrete gaps" }],
          createdAt: "2026-09-14T22:01:00.000Z",
        },
      ],
      now: "2026-09-14T22:02:00.000Z",
    });
    getAgentHandoffMock.mockResolvedValue({
      id: snapshot.id,
      environmentId: snapshot.environmentId,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });
    const transported = prependAgentHandoffHistory(
      snapshot.bootstrapPrompt,
      "Keep going in Cursor",
    );
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      sessionProjectionMock.mockImplementation(async (projectionInput) => ({
        ...(await defaultProjection(projectionInput)),
        messages: [
          {
            id: "cursor-bootstrap",
            role: "user" as const,
            content: transported,
            parts: [{ type: "text" as const, content: transported }],
            createdAt: "2026-09-14T22:03:00.000Z",
          },
        ],
      }));
      return { outcome: "accepted" as const, requestId: input.requestId };
    });

    const tabId = "tab-handoff-cursor";
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  agentHandoffId: snapshot.id,
                  nativeAgentData: identity("cursor"),
                },
              ],
              activeTabId: tabId,
            },
            activePaneId: "default",
            containerId: "container-1",
          },
        ],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    expect(await screen.findByText("Investigate the layout")).toBeTruthy();
    expect(screen.getByText("I found three concrete gaps")).toBeTruthy();
    expect(screen.getByText(/Continued in Cursor from Grok/)).toBeTruthy();

    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Keep going in Cursor" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const dispatched = dispatchNativeAgentIntentMock.mock.calls[0]?.[0] as {
      agent?: string;
      prompt?: string;
    };
    expect(dispatched).toMatchObject({ agent: "cursor", prompt: transported });
    expect(dispatched.prompt).toContain('<orkestrator-handoff format="json-v2">');
    expect(dispatched.prompt).toContain("Investigate the layout");
    expect(dispatched.prompt).toContain("I found three concrete gaps");
    expect(dispatched.prompt).toContain(
      "The handoff above is prior conversation history. Respond to the user's new",
    );
    expect(dispatched.prompt?.endsWith("Keep going in Cursor")).toBe(true);

    const list = await screen.findByTestId("native-agent-transcript-test-list");
    await waitFor(() => {
      const rows = [...list.children].map((row) => row.textContent ?? "");
      const historyIndex = rows.findIndex((row) => row.includes("Investigate the layout"));
      const replyIndex = rows.findIndex((row) => row.includes("I found three concrete gaps"));
      const promptIndex = rows.findIndex((row) => row.includes("Keep going in Cursor"));
      expect(historyIndex).toBeGreaterThanOrEqual(0);
      expect(replyIndex).toBeGreaterThan(historyIndex);
      expect(promptIndex).toBeGreaterThan(replyIndex);
    });

    const tab = appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0];
    expect(tab?.agentHandoffId).toBe(snapshot.id);
    expect(tab?.consumedAgentHandoffId).toBe(snapshot.id);
  });

  test("leaves delivery to a backend that does it, even for a queued prompt", async () => {
    fixtureState.renderVirtualizedMessages = true;
    getAgentHandoffCapabilitiesMock.mockResolvedValue({
      create: true,
      delivery: true,
      pruning: true,
    });
    const snapshot = grokToCursorHandoff("handoff-backend-delivers");
    getAgentHandoffMock.mockResolvedValue({
      id: snapshot.id,
      environmentId: snapshot.environmentId,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });

    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      return {
        ...projection,
        capabilities: { ...projection.capabilities, queue: true },
        turn: { phase: "running" as const },
        messages: [],
      };
    });
    const tabId = "tab-backend-delivers";
    seedEnvTab({
      id: tabId,
      type: "agent-native",
      agentHandoffId: snapshot.id,
      nativeAgentData: identity("cursor"),
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    expect(await screen.findByText("Investigate the layout")).toBeTruthy();
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "First instruction" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Plain text: the backend adds the carrier when the queue reaches it.
    await waitFor(() =>
      expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
        `cursor\0${createSessionKey("env-1", tabId)}`,
        "env-1",
        expect.objectContaining({ text: "First instruction" }),
      ),
    );
    // Only the backend marks it consumed: enqueueing delivers nothing yet, and
    // marking it here would have the backend drop the history at dispatch.
    const tab = appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0];
    expect(tab?.agentHandoffId).toBe(snapshot.id);
    expect(tab?.consumedAgentHandoffId).toBeUndefined();
  });

  test("consumes and retains a first handoff after enqueueing on a running turn", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const snapshot = grokToCursorHandoff("handoff-queue-cursor");
    getAgentHandoffMock.mockResolvedValue({
      id: snapshot.id,
      environmentId: snapshot.environmentId,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });
    const transported = prependAgentHandoffHistory(
      snapshot.bootstrapPrompt,
      "Queue this follow-up",
    );
    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      return {
        ...projection,
        capabilities: { ...projection.capabilities, queue: true },
        turn: { phase: "running" as const },
        messages: [],
      };
    });
    const tabId = "tab-handoff-queue";
    seedEnvTab({
      id: tabId,
      type: "agent-native",
      agentHandoffId: snapshot.id,
      nativeAgentData: identity("cursor"),
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    expect(await screen.findByText("Investigate the layout")).toBeTruthy();
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Queue this follow-up" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
        `cursor\0${createSessionKey("env-1", tabId)}`,
        "env-1",
        expect.objectContaining({ text: transported }),
      ),
    );
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Investigate the layout")).toBeTruthy();
    expect(screen.getByText("I found three concrete gaps")).toBeTruthy();
    const tab = appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0];
    expect(tab?.agentHandoffId).toBe(snapshot.id);
    expect(tab?.consumedAgentHandoffId).toBe(snapshot.id);
  });

  test("drops imported history when a consumed destination session is replaced", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const snapshot = grokToCursorHandoff("handoff-replaced-session");
    getAgentHandoffMock.mockResolvedValue({
      id: snapshot.id,
      environmentId: snapshot.environmentId,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });
    adoptNativeAgentSessionMock.mockImplementation(async (input) => {
      if (input.providerSessionId === "cursor-missing") {
        throw new Error("provider session was not found");
      }
      return defaultAdoptNativeAgentSession(input);
    });
    ensureNativeAgentSessionMock.mockImplementation(async (input) => ({
      ...(await defaultEnsureNativeAgentSession(input)),
      providerSessionId: "cursor-replacement",
    }));
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      sessionId: "cursor-replacement",
    }));
    const tabId = "tab-handoff-replaced";
    seedEnvTab({
      id: tabId,
      type: "agent-native",
      agentHandoffId: snapshot.id,
      consumedAgentHandoffId: snapshot.id,
      nativeAgentData: { ...identity("cursor"), sessionId: "cursor-missing" },
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.agentHandoffId,
      ).toBeUndefined(),
    );
    await waitFor(() => {
      expect(screen.queryByText("Investigate the layout") === null).toBe(true);
      expect(screen.queryByText("I found three concrete gaps") === null).toBe(true);
    });
    const tab = appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0];
    expect(tab?.consumedAgentHandoffId).toBe(snapshot.id);
    expect(getNativeAgentData(tab!)?.sessionId).toBe("cursor-replacement");
  });

  test("remounts consumed history and hides the carrier after resuming another session", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const snapshot = grokToCursorHandoff("handoff-remount-resume");
    getAgentHandoffMock.mockResolvedValue({
      id: snapshot.id,
      environmentId: snapshot.environmentId,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });
    const transported = prependAgentHandoffHistory(
      snapshot.bootstrapPrompt,
      "Keep going in Cursor",
    );
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      sessionProjectionMock.mockImplementation(async (projectionInput) => ({
        ...(await defaultProjection(projectionInput)),
        messages: [
          {
            id: "cursor-bootstrap",
            role: "user" as const,
            content: transported,
            parts: [{ type: "text" as const, content: transported }],
            createdAt: "2026-09-14T22:03:00.000Z",
          },
        ],
      }));
      return { outcome: "accepted" as const, requestId: input.requestId };
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
    resumeNativeAgentSessionMock.mockImplementation(async (input) => {
      const resumed = {
        ...(await defaultProjection({
          agent: input.agent!,
          environmentId: input.environmentId,
        })),
        sessionId: input.providerSessionId,
        generation: `resumed:${input.providerSessionId}`,
        messages: [
          {
            id: "leftover-carrier",
            role: "user" as const,
            content: transported,
            parts: [{ type: "text" as const, content: transported }],
            createdAt: "2026-09-14T22:04:00.000Z",
          },
          {
            id: "resumed-reply",
            role: "assistant" as const,
            content: "Resumed earlier work",
            parts: [{ type: "text" as const, content: "Resumed earlier work" }],
            createdAt: "2026-09-14T22:05:00.000Z",
          },
        ],
      };
      sessionProjectionMock.mockImplementation(async () => resumed);
      return resumed;
    });

    const tabId = "tab-handoff-remount";
    seedEnvTab({
      id: tabId,
      type: "agent-native",
      agentHandoffId: snapshot.id,
      nativeAgentData: identity("cursor"),
    });

    const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    expect(await screen.findByText("Investigate the layout")).toBeTruthy();
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Keep going in Cursor" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.consumedAgentHandoffId,
      ).toBe(snapshot.id),
    );
    first.unmount();

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    expect(await screen.findByText("Investigate the layout")).toBeTruthy();
    expect(screen.getByText("I found three concrete gaps")).toBeTruthy();
    expect(screen.queryByText((text) => text.includes("orkestrator-handoff")) === null).toBe(true);

    fireEvent.click(screen.getByText("Resume Session"));
    const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Earlier work/ }));

    await waitFor(() =>
      expect(
        appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.agentHandoffId,
      ).toBeUndefined(),
    );
    expect(await screen.findByText("Resumed earlier work")).toBeTruthy();
    expect(screen.queryByText("Investigate the layout") === null).toBe(true);
    expect(screen.queryByText((text) => text.includes("orkestrator-handoff")) === null).toBe(true);
    expect(
      appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.consumedAgentHandoffId,
    ).toBe(snapshot.id);
  });

  test("does not delete a handoff when resume runs before the projection has a session id", async () => {
    const snapshot = grokToCursorHandoff("handoff-unloaded-resume");
    getAgentHandoffMock.mockResolvedValue({
      id: snapshot.id,
      environmentId: snapshot.environmentId,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });
    adoptNativeAgentSessionMock.mockImplementation(() => new Promise(() => {}));
    listNativeAgentResumableSessionsMock.mockImplementation(
      async () =>
        [
          {
            sessionId: "cursor-session",
            title: "Current destination",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ] as never,
    );
    const tabId = "tab-handoff-unloaded";
    seedEnvTab({
      id: tabId,
      type: "agent-native",
      agentHandoffId: snapshot.id,
      nativeAgentData: identity("cursor"),
    });

    renderInAppCommandScope(
      <SharedNativeAgentController
        tabId={tabId}
        data={identity("cursor")}
        isActive
        agentHandoffId={snapshot.id}
        initialResumeOpen
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Resume Session" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Current destination/ }));
    await waitFor(() => expect(resumeNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.agentHandoffId).toBe(
      snapshot.id,
    );
  });

  test("renders the coordinator hint through the real assigned controller", async () => {
    renderInAppCommandScope(
      <SharedNativeAgentController
        tabId="assigned-hint"
        data={identity("codex")}
        isActive
        composerHint="Side agents are extra read-only chats. Start a message with ! to run a command yourself."
      />,
    );
    await screen.findByTestId("shared-native-compose-bar");
    expect(screen.getByText(/Side agents are extra read-only chats/).textContent).toContain(
      "! to run a command yourself",
    );
  });

  test("renders a mismatch notice instead of throwing on an unknown platform", async () => {
    // A persisted record can name a platform this build does not ship. Failing
    // here would throw out of the pane and take its sibling tabs down with it.
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-unknown"
        data={{
          platform: "gemini" as NativeAgentTabData["platform"],
          environmentId: "env-1",
        }}
        isActive
      />,
    );

    expect(await screen.findByText(/unsupported agent/i)).toBeTruthy();
  });

  test("does not resolve a platform through the prototype chain", async () => {
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-proto"
        data={{
          platform: "constructor" as NativeAgentTabData["platform"],
          environmentId: "env-1",
        }}
        isActive
      />,
    );

    expect(await screen.findByText(/unsupported agent/i)).toBeTruthy();
  });

  test("reconnects the shared controller when a tab's platform changes", async () => {
    const { rerender } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-swap" data={identity("codex")} isActive />,
    );
    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();

    rerender(<AgentNativeTab tabId="tab-swap" data={identity("opencode")} isActive />);

    await waitFor(() =>
      expect(sessionProjectionMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "opencode" }),
      ),
    );
  });

  test("does not read or touch a provider projection while its tab is inactive", async () => {
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-inactive" data={identity("codex")} isActive={false} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sessionProjectionMock).not.toHaveBeenCalled();
    expect(adoptNativeAgentSessionMock).not.toHaveBeenCalled();
  });

  test("does not shimmer while rechecking a brand-new tab's authoritative empty transcript", async () => {
    const tabId = "tab-empty-transcript-cache";
    const sessionKey = createSessionKey("env-1", tabId);
    const cached = await defaultProjection({ agent: "codex", environmentId: "env-1" });
    appCommandStore(nativeAgentProjectionStore).getState().setProjection(sessionKey, cached);
    // Emptiness has to be recorded by the transcript surface; an empty message
    // array from a state-only snapshot is not proof of an empty transcript.
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProgressiveCache(sessionKey, {
        identity: {
          backendInstanceId: "backend-1",
          environmentId: "env-1",
          platform: "codex",
          logicalSessionKey: sessionKey,
          providerSessionId: "codex-session",
          sourceGeneration: "generation-1",
        },
        transcriptAvailability: "empty",
        transcriptRefreshing: false,
        stateAvailability: "unavailable",
      });

    let settleRead: (() => void) | undefined;
    sessionProjectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleRead = () => resolve(cached);
        }),
    );

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());

    // The pending read is only verifying an already-authoritative empty
    // transcript. No conversation has occurred, so the centered composer must
    // not grow a transcript-history shimmer above it.
    expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy();
    expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
    expect(screen.queryByTestId("session-refresh-shimmer-pinned") === null).toBe(true);

    await act(async () => {
      settleRead!();
    });
  });

  test("shimmers while a state-only empty projection's transcript is still unproven", async () => {
    const tabId = "tab-state-only-empty";
    const sessionKey = createSessionKey("env-1", tabId);
    const cached = await defaultProjection({ agent: "codex", environmentId: "env-1" });
    // A session-state read installs `messages: []` before the paired transcript
    // read resolves. Mistaking that placeholder for authoritative emptiness
    // would suppress the indicator while history may still be loading.
    appCommandStore(nativeAgentProjectionStore).getState().setProjection(sessionKey, cached);
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProgressiveCache(sessionKey, {
        identity: {
          backendInstanceId: "backend-1",
          environmentId: "env-1",
          platform: "codex",
          logicalSessionKey: sessionKey,
          providerSessionId: "codex-session",
          sourceGeneration: "generation-1",
        },
        transcriptAvailability: "unavailable",
        transcriptRefreshing: true,
        stateAvailability: "current",
      });

    let settleRead: (() => void) | undefined;
    sessionProjectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleRead = () => resolve(cached);
        }),
    );

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("codex")} isActive />);
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());

    expect(screen.getByText("Refreshing Codex session…")).toBeTruthy();
    expect(screen.getByTestId("session-refresh-shimmer-pinned")).toBeTruthy();
    expect(
      screen.getByTestId("session-refresh-shimmer-transcript").getAttribute("data-active"),
    ).toBe("false");

    await act(async () => {
      settleRead!();
    });
  });

  test.each(["codex", "cursor"] as const)(
    "does not report an inactive %s tab as failed or refreshing before reading",
    async (platform) => {
      renderInAppCommandScope(
        <AgentNativeTab
          tabId={`tab-inactive-${platform}`}
          data={identity(platform)}
          isActive={false}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Never asked, so never refused or started a transcript read. Neither a
      // failure nor a shimmer would describe work this inactive tab performed.
      const label = platform === "cursor" ? "Cursor Agent" : "Codex";
      expect(screen.queryByText(`Refreshing ${label} session…`) === null).toBe(true);
      expect(screen.queryByTestId("session-refresh-shimmer-pinned") === null).toBe(true);
      expect(screen.queryByText("Connection Failed") === null).toBe(true);
      expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    },
  );

  test("reports a settled read that found no session as a failed connection", async () => {
    sessionProjectionMock.mockImplementation(async () => null as never);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-empty-read" data={identity("cursor")} isActive />,
    );

    // The backend answered, and answered with nothing. That is recoverable
    // state the user has to be able to see and retry, not a pending connection.
    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
  });

  test("treats a recovering Pi projection as still connecting", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
      turn: { phase: "recovering" as const },
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-pi-recovering" data={identity("pi")} isActive />,
    );

    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
    // The joined read already supplied the authoritative empty transcript.
    // `connecting` now describes session state alone, so it must not keep a
    // transcript-loading shimmer alive above a brand-new composer.
    expect(screen.queryByText("Refreshing Pi session…") === null).toBe(true);
    expect(screen.queryByTestId("session-refresh-shimmer-pinned") === null).toBe(true);
    expect(screen.queryByText("Connection Failed") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });

  test("surfaces the backend's detail and a retry control once recovery is given up on", async () => {
    // The counterpart to the test above. `connecting` carries no retry control,
    // so the backend giving up on a session has to reach the user as a failure
    // they can act on — with the reason the backend gave, not a generic one.
    let reads = 0;
    sessionProjectionMock.mockImplementation(async (input) => {
      reads += 1;
      const base = await defaultProjection(input);
      return reads === 1
        ? { ...base, connection: "connecting" as const, turn: { phase: "recovering" as const } }
        : {
            ...base,
            connection: "error" as const,
            turn: {
              phase: "recovering" as const,
              error:
                "The native agent runtime no longer holds this session. Retry to start a new one.",
            },
          };
    });

    // The projection poll is scheduled by the read coordinator; a fake clock
    // drives one tick of the active (500 ms) cadence instead of waiting for it.
    const { clock } = fakeReadCoordinator();
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-pi-given-up" data={identity("pi")} isActive />,
    );

    await waitFor(() => expect(reads).toBe(1));
    await act(() => clock.advance(500));
    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());
    expect(
      screen.getByText(
        "The native agent runtime no longer holds this session. Retry to start a new one.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Connecting to Pi...") === null).toBe(true);
  });

  test("does not shimmer once an empty transcript is authoritative during recovery", async () => {
    // `recovering` polls at the active cadence, so the tab has to pick the
    // recovery up on its own. A reconnect the user has to click through would
    // defeat the point of holding the overlay in the first place.
    let reads = 0;
    sessionProjectionMock.mockImplementation(async (input) => {
      reads += 1;
      const base = await defaultProjection(input);
      return reads === 1
        ? { ...base, connection: "connecting" as const, turn: { phase: "recovering" as const } }
        : base;
    });

    // The projection poll is scheduled by the read coordinator; a fake clock
    // drives one tick of the active (500 ms) cadence instead of waiting for it.
    const { clock } = fakeReadCoordinator();
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-pi-recovered" data={identity("pi")} isActive />,
    );

    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalledTimes(1));
    await act(() => clock.advance(500));
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Refreshing Pi session…") === null).toBe(true);
    expect(screen.queryByTestId("session-refresh-shimmer-pinned") === null).toBe(true);
    expect(screen.queryByText("Connection Failed") === null).toBe(true);
  });

  test("shows a new tab's opening prompt while its first session is created", async () => {
    fixtureState.renderVirtualizedMessages = true;
    // What the backend really answers while `ensure` is still spawning the
    // agent: the logical key has no provider session to resolve yet.
    sessionProjectionMock.mockImplementation(async () => null as never);
    let settleEnsure: (() => void) | undefined;
    ensureNativeAgentSessionMock.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          settleEnsure = () =>
            resolve({
              providerSessionId: "cursor-session",
              logicalSessionKey: input.logicalSessionKey,
              environmentId: input.environmentId,
              agent: input.agent,
            });
        }),
    );

    let settleDispatch: (() => void) | undefined;
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          settleDispatch = () => resolve({ outcome: "accepted", requestId: input.requestId });
        }),
    );
    const assertPromptVisible = () => {
      const prompt = screen.getByText("Review the current changes");
      // jsdom does not apply Tailwind styles. Check the ancestor that actually
      // hides the transcript rather than only checking that its text exists.
      expect(prompt.closest(".opacity-0") === null).toBe(true);
      expect(screen.getAllByText("Review the current changes")).toHaveLength(1);
    };
    const { container, rerender } = renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-new-cursor"
        data={freshTab("cursor")}
        initialPrompt="Review the current changes"
        isActive
      />,
    );
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());

    // Invalidations are announced per environment, so every projection commit
    // by a sibling agent tab reaches this one too. With a second Cursor tab
    // open that makes this the common path, not a rare race.
    // Delivered through the dispatcher's coalescing timer, so the invalidation
    // genuinely reaches the hook while creation is still in flight.
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });

    // Cursor is still being spawned and the opening prompt cannot be injected
    // until creation finishes. The prompt is on screen anyway, with the wait
    // shown beneath it: hiding it behind the connecting logo made the prompt
    // look as if it arrived seconds late. Reconnect copy would name a session
    // that has never existed.
    assertPromptVisible();
    expect(screen.getByText("Starting Cursor Agent…")).toBeTruthy();
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
    expect(container.querySelector("svg.agent-connecting-logo") === null).toBe(true);
    expect(screen.queryByText("Refreshing Cursor Agent session…") === null).toBe(true);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Connection Failed") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);

    sessionProjectionMock.mockImplementation(defaultProjection);
    await act(async () => {
      settleEnsure!();
    });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
    // The submitted prompt's own bubble takes over; the prompt is never doubled.
    assertPromptVisible();

    // Acceptance clears the tab's initialPrompt before the turn necessarily
    // reports running. The retired latch must keep its replacement visible too.
    await act(async () => settleDispatch!());
    rerender(<AgentNativeTab tabId="tab-new-cursor" data={freshTab("cursor")} isActive />);
    assertPromptVisible();

    const sessionKey = createSessionKey("env-1", "tab-new-cursor");
    const current = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(sessionKey)!;
    const response: NativeMessage = {
      id: "opening-assistant",
      role: "assistant",
      content: "Inspecting the changes",
      parts: [{ type: "text", content: "Inspecting the changes" }],
      createdAt: "2026-10-31T00:00:01.000Z",
    };
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          revision: current.revision + 1,
          turn: { phase: "running" },
          messages: [response],
        }),
    );
    await screen.findByText("Inspecting the changes");
    assertPromptVisible();
    const list = screen.getByTestId("native-agent-transcript-test-list");
    const rows = [...list.children].map((row) => row.textContent ?? "");
    expect(rows.findIndex((row) => row.includes("Review the current changes"))).toBeLessThan(
      rows.findIndex((row) => row.includes("Inspecting the changes")),
    );
    // The delayed authoritative user echo replaces the optimistic opening row.
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          revision: current.revision + 2,
          turn: { phase: "running" },
          messages: [
            {
              id: "opening-user",
              role: "user",
              content: "Review the current changes",
              parts: [{ type: "text", content: "Review the current changes" }],
              createdAt: "2026-10-31T00:00:00.000Z",
            },
            response,
          ],
        }),
    );
    assertPromptVisible();
  });

  test("waits on the connecting logo while a prompt-less tab's first session is created", async () => {
    sessionProjectionMock.mockImplementation(async () => null as never);
    ensureNativeAgentSessionMock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-no-prompt" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());

    // Nothing to show yet, and a ready composer would invite a message the
    // session cannot accept.
    expect(screen.getByText("Connecting to Cursor Agent...")).toBeTruthy();
    expect(container.querySelector("svg.agent-connecting-logo")).toBeTruthy();
    expect(screen.queryByText(/^Starting /) === null).toBe(true);
  });

  test("shows a backend-owned startup prompt before the backend dispatches it", async () => {
    fixtureState.renderVirtualizedMessages = true;
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
          pendingAgentLaunch: true,
          initialPrompt: "Add a dark mode toggle",
          startupAgentSession: {
            tabId: "startup-agent",
            agent: "cursor",
            style: "native",
            status: "starting",
          },
        } as never,
      ],
    });
    // The backend has not created the provider session yet.
    sessionProjectionMock.mockImplementation(async () => null as never);
    let settleEnsure: (() => void) | undefined;
    ensureNativeAgentSessionMock.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          settleEnsure = () =>
            resolve({
              providerSessionId: "cursor-session",
              logicalSessionKey: input.logicalSessionKey,
              environmentId: input.environmentId,
              agent: input.agent,
            });
        }),
    );

    renderInAppCommandScope(
      <AgentNativeTab tabId="startup-agent" data={freshTab("cursor")} isActive />,
    );

    expect(await screen.findByText("Add a dark mode toggle")).toBeTruthy();
    expect(screen.getByText("Starting Cursor Agent…")).toBeTruthy();
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
    // The backend owns this dispatch; the preview never sends anything.
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    // Dispatch returned: the launch flags clear before the echo is read. The
    // prompt stays on screen through that gap rather than flickering out.
    act(() => {
      appCommandStore(environmentStore).getState().updateEnvironment("env-1", {
        pendingAgentLaunch: false,
        startupAgentSession: undefined,
      });
    });
    expect(screen.getByText("Add a dark mode toggle")).toBeTruthy();

    // The provider can stream its answer before echoing the user prompt.
    const response: NativeMessage = {
      id: "backend-assistant",
      role: "assistant",
      content: "Adding the toggle",
      parts: [{ type: "text", content: "Adding the toggle" }],
      createdAt: "2026-10-31T00:00:01.000Z",
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      turn: { phase: "running" as const },
      messages: [response],
    }));
    await act(async () => settleEnsure!());
    await screen.findByText("Adding the toggle");
    const prompt = screen.getByText("Add a dark mode toggle");
    expect(prompt.closest(".opacity-0") === null).toBe(true);
    const list = screen.getByTestId("native-agent-transcript-test-list");
    const rows = [...list.children].map((row) => row.textContent ?? "");
    expect(rows.findIndex((row) => row.includes("Add a dark mode toggle"))).toBeLessThan(
      rows.findIndex((row) => row.includes("Adding the toggle")),
    );
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    const sessionKey = createSessionKey("env-1", "startup-agent");
    const current = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(sessionKey)!;
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(sessionKey, {
          ...current,
          revision: current.revision + 1,
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Add a dark mode toggle",
              parts: [{ type: "text", content: "Add a dark mode toggle" }],
              createdAt: "2026-10-31T00:00:00.000Z",
            },
            response,
          ],
        }),
    );
    // The echo replaces the preview exactly once.
    expect(screen.getAllByText("Add a dark mode toggle")).toHaveLength(1);
    expect(screen.queryByText(/^Starting /) === null).toBe(true);
  });

  test.each(["rejected", "transport", "exception"] as const)(
    "clears startup feedback and restores the draft after an opening %s failure",
    async (failure) => {
      fixtureState.renderVirtualizedMessages = true;
      dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
        if (failure === "exception") throw new Error("Opening dispatch failed");
        if (failure === "transport")
          return {
            outcome: "unknown",
            requestId: input.requestId,
            origin: "transport",
            error: "Opening connection dropped",
          };
        return { outcome: "rejected", error: "Opening dispatch rejected" };
      });
      const tabId = `startup-failure-${failure}`;
      const { container } = renderInAppCommandScope(
        <AgentNativeTab
          tabId={tabId}
          data={freshTab("cursor")}
          initialPrompt="Recover this opening prompt"
          isActive
        />,
      );
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole("textbox").textContent).toBe("Recover this opening prompt"),
      );
      expect(screen.queryByText(/^Starting /) === null).toBe(true);
      expect(container.querySelector(".agent-thinking-shimmer") === null).toBe(true);
      expect(
        within(screen.getByTestId("native-agent-transcript-test-list")).queryByText(
          "Recover this opening prompt",
        ) === null,
      ).toBe(true);
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(createSessionKey("env-1", tabId))
          ?.text,
      ).toBe("Recover this opening prompt");
    },
  );

  test("shows a backend-owned startup prompt while setup is still running", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "running",
          pendingAgentLaunch: true,
          initialPrompt: "Add a dark mode toggle",
        } as never,
      ],
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="startup-agent" data={freshTab("cursor")} isActive />,
    );

    expect(await screen.findByText("Waiting for setup scripts to complete...")).toBeTruthy();
    expect(screen.getByTestId("setup-pending-prompt").textContent).toContain(
      "Add a dark mode toggle",
    );
  });

  test("shows the connecting logo on a created tab that connected once but is still empty", async () => {
    // A brand-new tab passes through `connected` before its first prompt. A
    // background refresh in that window reads as connecting, and with no
    // transcript the tab has nothing to protect: shimmering over a composer
    // that invites a message the session cannot accept is the wrong answer, so
    // it waits on the pulsing logo instead.
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-empty-reconnect" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });

    await waitFor(() => expect(screen.getByText("Connecting to Cursor Agent...")).toBeTruthy());
    expect(screen.queryByText("Refreshing Cursor Agent session…") === null).toBe(true);
    expect(screen.queryByTestId("shared-native-compose-bar") === null).toBe(true);
  });

  test("keeps the authentication banner reachable when an empty created tab re-enters connecting", async () => {
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "signed-out",
      signIn: { kind: "terminal" },
    }));
    // The establishment overlay replaces the whole pane, including the pinned
    // accessory row, so a background refresh over an empty transcript must not
    // swallow the one control that recovers the tab. The banner has no message
    // to protect, but it is actionable content and so counts as establishment.
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-auth-reconnect" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
      readiness: {
        state: "authentication-required" as const,
        message:
          "Cursor is not signed in. Sign in from Settings › Cursor, or set a Cursor API key.",
      },
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });

    expect(await screen.findByText(/Cursor is not signed in/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Cursor Agent settings" })).toBeTruthy();
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
  });

  test("keeps a pending question reachable when an empty created tab re-enters connecting", async () => {
    // A question with no transcript row is still a blocking prompt. Hiding it
    // behind the connecting logo would make the turn unreachable while the
    // background refresh completes.
    fixtureState.renderVirtualizedMessages = true;
    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-new-cursor-question-reconnect"
        data={freshTab("cursor")}
        isActive
      />,
    );
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
      interactions: [pendingInteraction("question", "question-1")],
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });

    expect(await screen.findByTestId("agent-question-card")).toBeTruthy();
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
  });

  test("returns to the composer when an empty created tab reconnects", async () => {
    // Establishment is derived from live content, not a latch, so the wait it
    // shows must be escapable: a connect that settles has to hand the composer
    // back rather than leaving the tab stuck on the logo.
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-empty-recover" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });
    await waitFor(() => expect(screen.getByText("Connecting to Cursor Agent...")).toBeTruthy());
    expect(screen.queryByTestId("shared-native-compose-bar") === null).toBe(true);

    sessionProjectionMock.mockImplementation(defaultProjection);
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 2,
    });

    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
  });

  test("falls back to the establishment wait once a created tab's transcript is cleared", async () => {
    // A new provider identity clears the projection along with the transcript
    // it described, so the next connect is establishment again. hasEstablished
    // Session is deliberately not monotonic for a created tab: keeping the
    // refresh layout here would shimmer over an empty pane that has no session
    // behind it yet.
    fixtureState.renderVirtualizedMessages = true;
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-cleared" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    const existingRow = {
      id: "cursor-assistant-cleared",
      role: "assistant" as const,
      content: "Cleared later",
      parts: [{ type: "text" as const, content: "Cleared later" }],
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
      messages: [existingRow],
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });
    await waitFor(() => expect(screen.getByText("Cleared later")).toBeTruthy());

    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      sessionId: "cursor-session-2",
      connection: "connecting" as const,
      messages: [],
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 2,
    });

    await waitFor(() => expect(screen.getByText("Connecting to Cursor Agent...")).toBeTruthy());
    expect(screen.queryByTestId("shared-native-compose-bar") === null).toBe(true);
  });

  test("treats a client-synthesised turn-stop row as content on an empty created tab", async () => {
    // `messages` carries rows this tab synthesised, not only provider echoes.
    // A tab whose sole row is the stop marker is still showing something the
    // user acted on, so a background connect must not replace it with the
    // establishment logo.
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "tab-new-cursor-synthetic";
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={freshTab("cursor")} isActive />);
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .markTurnStopped(createSessionKey("env-1", tabId), "cursor-session");
    });
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });

    await waitFor(() => expect(screen.getByText("Query stopped by user.")).toBeTruthy());
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
  });

  test("stays on the connecting logo after retrying a failed empty read on a fresh created tab", async () => {
    // A fresh created tab has no session id to resume, so its retry is
    // establishment rather than refresh. It must not fall back to session
    // refresh copy that names a session which does not exist yet.
    sessionProjectionMock.mockImplementation(async () => null as never);
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-retry" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());

    let settleRead: ((value: unknown) => void) | undefined;
    sessionProjectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleRead = resolve;
        }) as never,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("Connecting to Cursor Agent...")).toBeTruthy());
    expect(screen.queryByText("Refreshing Cursor Agent session…") === null).toBe(true);
    expect(screen.queryByTestId("shared-native-compose-bar") === null).toBe(true);

    await act(async () => {
      settleRead!(await defaultProjection({ agent: "cursor", environmentId: "env-1" }));
    });
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
  });

  test("removes refresh copy once a created tab's transcript is authoritative", async () => {
    // Once the created tab has produced conversation there is a transcript to
    // protect, so a subsequent connect is a refresh and keeps it reachable.
    // Nothing in the props tells this reconnect apart from the first one, which
    // is why the loaded transcript is what carries the distinction.
    fixtureState.renderVirtualizedMessages = true;
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-reconnect" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());

    const existingRow = {
      id: "cursor-assistant-1",
      role: "assistant" as const,
      content: "Already answered",
      parts: [{ type: "text" as const, content: "Already answered" }],
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      connection: "connecting" as const,
      messages: [existingRow],
    }));
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });

    await waitFor(() => expect(screen.getByText("Already answered")).toBeTruthy());
    expect(screen.queryByText("Refreshing Cursor Agent session…") === null).toBe(true);
    expect(
      screen.getByTestId("session-refresh-shimmer-transcript").getAttribute("data-active"),
    ).toBe("false");
    expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy();
    expect(screen.queryByText("Connecting to Cursor Agent...") === null).toBe(true);
  });

  test("keeps a creation failure that raced an invalidation instead of a generic one", async () => {
    // The pairing that loses the message: a sibling tab's invalidation is
    // coalesced while creation is in flight, then creation fails. The trailing
    // reconcile — and, a poll later, the refresh interval — read a session that
    // does not exist, and installing that empty read used to clear the error.
    sessionProjectionMock.mockImplementation(async () => null as never);
    let failEnsure: (() => void) | undefined;
    ensureNativeAgentSessionMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failEnsure = () => reject(new Error("Cursor SDK bridge is not available"));
        }),
    );

    // Background polls are scheduled by the read coordinator; a fake clock
    // drives the registered production poll deterministically.
    const { clock } = installFakeReadCoordinator();
    try {
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-new-cursor-fail" data={freshTab("cursor")} isActive />,
      );
      await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());

      await deliverResourceChange({
        resource: "native-agent-session",
        id: "env-1",
        revision: 1,
      });

      await act(async () => {
        failEnsure!();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());
      // The actionable reason, not "Unable to connect".
      expect(screen.getByText("Cursor SDK bridge is not available")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

      // Drive the registered production poll once. Advancing the coordinator's
      // clock is stronger and faster than sleeping beyond its nominal interval.
      const readsBeforePoll = sessionProjectionMock.mock.calls.length;
      await act(() => clock.advance(1_500));
      await waitFor(() =>
        expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(readsBeforePoll),
      );
      expect(screen.getByText("Cursor SDK bridge is not available")).toBeTruthy();
    } finally {
      resetReadCoordinatorForTests();
    }
  }, 10_000);

  test("releases a creation failure once a read finds the session", async () => {
    ensureNativeAgentSessionMock.mockImplementation(async () => {
      throw new Error("bridge refused the session");
    });
    sessionProjectionMock.mockImplementation(async () => null as never);

    // The reads that follow are the registered production poll; a fake clock
    // drives it instead of waiting out its 500/1,500 ms cadence.
    const { clock } = installFakeReadCoordinator();
    try {
      renderInAppCommandScope(<NativeSessionIdentityHarness platform="cursor" />);
      await waitFor(() =>
        expect(screen.getByTestId("runtime-error").textContent).toBe("bridge refused the session"),
      );

      // Suppression is scoped to "the session still is not there". A read that
      // does find one supersedes the failure — otherwise the message outlives what
      // it described, and the next genuine absence reports a stale cause.
      sessionProjectionMock.mockImplementation(defaultProjection);
      const readsBeforePoll = sessionProjectionMock.mock.calls.length;
      await act(() => clock.advance(1_500));
      await waitFor(() => expect(screen.getByTestId("runtime-error").textContent).toBe(""));
      expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(readsBeforePoll);

      sessionProjectionMock.mockImplementation(async () => null as never);
      const readsBeforeEmptyPoll = sessionProjectionMock.mock.calls.length;
      await act(() => clock.advance(1_500));
      await waitFor(() =>
        expect(screen.getByTestId("has-completed-read").textContent).toBe("true"),
      );
      expect(sessionProjectionMock.mock.calls.length).toBeGreaterThan(readsBeforeEmptyPoll);
      expect(screen.getByTestId("runtime-error").textContent).toBe("");
    } finally {
      resetReadCoordinatorForTests();
    }
  }, 10_000);

  test("runs the reconcile an invalidation asked for once creation completes", async () => {
    let settleEnsure: (() => void) | undefined;
    ensureNativeAgentSessionMock.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          settleEnsure = () =>
            resolve({
              providerSessionId: "cursor-session",
              logicalSessionKey: input.logicalSessionKey,
              environmentId: input.environmentId,
              agent: input.agent,
            });
        }),
    );

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-reconcile" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());
    sessionProjectionMock.mockClear();

    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
    });
    // Deferred, not dropped: reading now could only answer "not created yet".
    expect(sessionProjectionMock).not.toHaveBeenCalled();

    await act(async () => {
      settleEnsure!();
    });

    // Two reads: the one `connect` owns, and the deferred reconcile. Counting
    // matters — the connect-owned read alone would satisfy "was called" and hide
    // a dropped invalidation, which is the state the announcement described.
    // The reconcile runs through the read coordinator, so once both reads were
    // issued an idle coordinator means no further read is still coming.
    await waitFor(() => expect(sessionProjectionMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await settleCoordinatedReads();
    expect(sessionProjectionMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
  });

  test("keeps the establishment window open while a second connect is still in flight", async () => {
    // An identity change mid-establishment runs a second connect before the
    // first has returned. Counting is what makes the first completion release
    // only its own claim; a boolean — or anything that resets to zero — would
    // reopen the gate while a session is still being created, and the empty read
    // that follows is exactly the false Connection Failed this all exists to
    // prevent.
    sessionProjectionMock.mockImplementation(async () => null as never);
    const settles: Array<() => void> = [];
    ensureNativeAgentSessionMock.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          settles.push(() =>
            resolve({
              providerSessionId: `${input.agent}-session`,
              logicalSessionKey: input.logicalSessionKey,
              environmentId: input.environmentId,
              agent: input.agent,
            }),
          );
        }),
    );

    const { rerender } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-overlap" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(settles.length).toBe(1));
    rerender(<AgentNativeTab tabId="tab-overlap" data={freshTab("codex")} isActive />);
    await waitFor(() => expect(settles.length).toBe(2));

    await act(async () => {
      settles[0]!();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
    });

    sessionProjectionMock.mockClear();
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 2,
    });

    // The second connect has not returned, so there is still nothing to resolve.
    expect(sessionProjectionMock).not.toHaveBeenCalled();
    expect(screen.getByText("Connecting to Codex...")).toBeTruthy();
    expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
    expect(screen.queryByText("Connection Failed") === null).toBe(true);

    sessionProjectionMock.mockImplementation(defaultProjection);
    await act(async () => {
      settles[1]!();
    });
    // And the window does close — a stuck counter would mute this tab's
    // background refreshes for the rest of its life.
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
    sessionProjectionMock.mockClear();
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 3,
    });
    expect(sessionProjectionMock).toHaveBeenCalled();
  });

  test("rehydrates from an authoritative read after establishing while inactive", async () => {
    let settleEnsure: (() => void) | undefined;
    ensureNativeAgentSessionMock.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          settleEnsure = () =>
            resolve({
              providerSessionId: "cursor-session",
              logicalSessionKey: input.logicalSessionKey,
              environmentId: input.environmentId,
              agent: input.agent,
            });
        }),
    );

    const { rerender } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-inactive-establish" data={freshTab("cursor")} isActive />,
    );
    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalled());

    // Switching away drops the background-refresh permission that a coalesced
    // reconcile needs, so the invalidation raised during creation is discarded.
    rerender(
      <AgentNativeTab tabId="tab-inactive-establish" data={freshTab("cursor")} isActive={false} />,
    );
    await act(async () => {
      dispatchResourceChange({
        resource: "native-agent-session",
        id: "env-1",
        revision: 1,
      });
      settleEnsure!();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 120);
      });
    });

    // Returning has to recover from a snapshot rather than from the event that
    // was dropped while the tab was not the visible one.
    rerender(<AgentNativeTab tabId="tab-inactive-establish" data={freshTab("cursor")} isActive />);
    await waitFor(() => expect(screen.getByTestId("shared-native-compose-bar")).toBeTruthy());
  });

  test("reports a created session that still reads empty as a failed connection", async () => {
    sessionProjectionMock.mockImplementation(async () => null as never);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-new-cursor-empty" data={freshTab("cursor")} isActive />,
    );

    // Holding the empty read back is scoped to session creation alone. Once
    // `ensure` has returned there is a session to resolve, so an empty read is
    // the backend answering — and the user needs the retry control.
    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("reports a failed connect attempt as a failed connection", async () => {
    adoptNativeAgentSessionMock.mockImplementation(async () => {
      throw new Error("bridge refused the session");
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-connect-error" data={identity("codex")} isActive />,
    );

    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());
    expect(screen.getByText("bridge refused the session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("does not replace a missing backend-owned resume session", async () => {
    adoptNativeAgentSessionMock.mockImplementation(async () => {
      throw new Error("provider session was not found");
    });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-strict-resume"
        data={{ ...identity("codex"), requireExistingResumeSession: true }}
        isActive
      />,
    );

    await waitFor(() => expect(screen.getByText("Connection Failed")).toBeTruthy());
    expect(screen.getByText("provider session was not found")).toBeTruthy();
    expect(ensureNativeAgentSessionMock).not.toHaveBeenCalled();
  });

  test("retains create-on-missing behavior for ordinary restored tabs", async () => {
    adoptNativeAgentSessionMock.mockImplementation(async () => {
      throw new Error("provider session was not found");
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-fallback-resume" data={identity("codex")} isActive />,
    );

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
  });

  test("pins the consolidated review report above an Address Findings tab's opening prompt", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "multi-review-fix:multi-1:launch-1";
    appCommandStore(multiReviewStore)
      .getState()
      .replaceWorkflow({
        id: "multi-1",
        environmentId: "env-1",
        consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
        backendRevision: 2,
      } as never);
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "fix-address-prompt",
          role: "user" as const,
          content: STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
          parts: [
            { type: "text" as const, content: STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION },
          ],
          createdAt: "2026-09-15T14:00:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);

    const report = await screen.findByText("Structured review report");
    const prompt = screen.getByText(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(report.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("pins the report to the address prompt in a legacy multi-message Address Findings transcript", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "multi-review-fix:multi-1:legacy";
    const preparation = `${REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX}"main"${REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE}\n\n${REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE} Usually one batched inventory read`;
    appCommandStore(multiReviewStore)
      .getState()
      .replaceWorkflow({
        id: "multi-1",
        environmentId: "env-1",
        consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
        backendRevision: 2,
      } as never);
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "prep-prompt",
          role: "user" as const,
          content: preparation,
          parts: [{ type: "text" as const, content: preparation }],
          createdAt: "2026-09-15T13:00:00.000Z",
        },
        {
          id: "prep-reply",
          role: "assistant" as const,
          content: "Inventory ready.",
          parts: [{ type: "text" as const, content: "Inventory ready." }],
          createdAt: "2026-09-15T13:01:00.000Z",
        },
        {
          id: "fix-address-prompt",
          role: "user" as const,
          content: STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
          parts: [
            { type: "text" as const, content: STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION },
          ],
          createdAt: "2026-09-15T14:00:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);

    const reports = await screen.findAllByText("Structured review report");
    expect(reports).toHaveLength(1);
    const prompt = screen.getByText(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    expect(
      reports[0]!.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const preparationText = screen.getByText(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION);
    expect(
      preparationText.compareDocumentPosition(reports[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("keeps the report on the opening prompt when a later follow-up is present", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "multi-review-fix:multi-1:follow-up";
    appCommandStore(multiReviewStore)
      .getState()
      .replaceWorkflow({
        id: "multi-1",
        environmentId: "env-1",
        consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
        backendRevision: 2,
      } as never);
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messages: [
        {
          id: "fix-address-prompt",
          role: "user" as const,
          content: STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
          parts: [
            { type: "text" as const, content: STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION },
          ],
          createdAt: "2026-09-15T14:00:00.000Z",
        },
        {
          id: "fix-reply",
          role: "assistant" as const,
          content: "Working on it.",
          parts: [{ type: "text" as const, content: "Working on it." }],
          createdAt: "2026-09-15T14:01:00.000Z",
        },
        {
          id: "follow-up",
          role: "user" as const,
          content: "Please also fix the tests.",
          parts: [{ type: "text" as const, content: "Please also fix the tests." }],
          createdAt: "2026-09-15T14:02:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);

    const reports = await screen.findAllByText("Structured review report");
    expect(reports).toHaveLength(1);
    const prompt = screen.getByText(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
    const followUp = screen.getByText("Please also fix the tests.");
    expect(
      reports[0]!.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      prompt.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("does not pin the report above a later follow-up when earlier turns are still unloaded", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const tabId = "multi-review-fix:multi-1:windowed";
    appCommandStore(multiReviewStore)
      .getState()
      .replaceWorkflow({
        id: "multi-1",
        environmentId: "env-1",
        consolidatedReport: TEST_STRUCTURED_REVIEW_REPORT,
        backendRevision: 2,
      } as never);
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      messageWindow: {
        limit: 32,
        truncated: true,
        canLoadEarlier: true,
        omittedMessages: 4,
      },
      messages: [
        {
          id: "follow-up",
          role: "user" as const,
          content: "Please also fix the tests.",
          parts: [{ type: "text" as const, content: "Please also fix the tests." }],
          createdAt: "2026-09-15T14:02:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);

    expect(await screen.findByText("Please also fix the tests.")).toBeTruthy();
    expect(screen.queryByText("Structured review report") === null).toBe(true);
  });

  test("reconciles and explains a replacement Multi Review Address Findings session", async () => {
    const tabId = "multi-review-fix:multi-1:launch-1";
    adoptNativeAgentSessionMock.mockImplementation(async (input) => {
      if (input.providerSessionId === "provider-fix") {
        throw new Error("provider session was not found");
      }
      return defaultAdoptNativeAgentSession(input);
    });
    ensureNativeAgentSessionMock.mockImplementation(async (input) => ({
      ...(await defaultEnsureNativeAgentSession(input)),
      providerSessionId: "provider-replacement",
    }));
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input)),
      sessionId: "provider-replacement",
    }));
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  nativeAgentData: { ...identity("codex"), sessionId: "provider-fix" },
                },
              ],
              activeTabId: tabId,
            },
            activePaneId: "default",
            containerId: "container-1",
          },
        ],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    await waitFor(() =>
      expect(recoverMultiReviewAddressFindingsSessionMock).toHaveBeenCalledTimes(1),
    );
    expect(recoverMultiReviewAddressFindingsSessionMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      tabId,
      expectedProviderSessionId: "provider-fix",
      replacementProviderSessionId: "provider-replacement",
    });
    expect(
      await screen.findByText(
        /fresh Address Findings session was created and seeded with the consolidated findings/i,
      ),
    ).toBeTruthy();
    const root = appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.root;
    expect(root?.kind === "leaf" ? getNativeAgentData(root.tabs[0]!)?.sessionId : undefined).toBe(
      "provider-replacement",
    );
  });
});
