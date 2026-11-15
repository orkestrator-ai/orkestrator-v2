/**
 * Contract suite for the single pane-level native agent tab: sign-in, the
 * composer, pickers, and launching the first prompt.
 *
 * Every provider exercises the shared authoritative-projection path. Setup is
 * shared with the sibling suites through `AgentNativeTab.test-support`.
 */
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { extractMarkedAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentAuthStatus,
  NativeAgentDispatchOutcome,
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as modelPicker from "@/components/chat/AgentModelPicker";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeDraft, nativeComposeStore } from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { pipelineSessionTabOptions } from "@/components/build-pipeline/PipelineFlowView";
import { build, session } from "@/components/build-pipeline/pipeline-test-fixture";
import { getNativeAgentData } from "@/types/paneLayout";
import { composeDraftKey } from "@/lib/compose-draft-persistence";
import { createSessionKey } from "@/lib/utils";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { GLOBAL_SETTINGS_REQUEST_EVENT } from "@/lib/settings-navigation";
import { MODEL_CATALOG_REFRESHED_EVENT } from "@/components/settings/agent/refresh-model-catalog";
import { TerminalProvider } from "@/contexts";
import { CLAUDE_AUTH_LOGIN_COMMAND, CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND } from "@/lib/claude-auth";
import { mockToastError, mockToastInfo } from "../../../../../tests/mocks/sonner";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { appCommandStore } from "@/test/app-command-store";
import {
  flushPaneLayoutNowMock,
  getNativeAgentModelCatalogMock,
  getAgentModelCatalogCacheMock,
  awaitBridgeReadyMock,
  adoptNativeAgentSessionMock,
  beginNativeAgentSignInMock,
  cancelNativeAgentSignInMock,
  openInBrowserMock,
  getNativeAgentAuthStatusMock,
  defaultEnsureNativeAgentSession,
  ensureNativeAgentSessionMock,
  listNativeAgentResumableSessionsMock,
  setNativeAgentResumableSessionArchivedMock,
  getNativeAgentSignInResendMock,
  dispatchNativeAgentIntentMock,
  renameEnvironmentFromPromptMock,
  resumeNativeAgentSessionMock,
  defaultProjection,
  sessionProjectionMock,
  startAgentAccountLoginMock,
  getAgentAccountLoginMock,
  listAgentAccountsMock,
  getLocalFileTreeMock,
  writeCoordinatorAttachmentMock,
  writeBugReportAttachmentMock,
  composeDraftRecords,
  latestPasteOptions,
  deliverResourceChange,
  identity,
  seedUnassignedDefaultCatalog,
  expectUnassignedPicker,
  pendingInteraction,
  freshTab,
  TerminalTabHarness,
  seedEnvTab,
  PaneBackedAgentNativeTab,
  seedUnassignedPane,
  fixtureState,
  installAgentNativeTabFixture,
  AgentNativeTab,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

describe("AgentNativeTab", () => {
  for (const platform of [undefined, "codex"] as const) {
    for (const modifier of ["metaKey", "ctrlKey"] as const) {
      test(`${platform ?? "unassigned"} tab owns ${modifier}+I only while focused`, async () => {
        const data: NativeAgentTabData = platform
          ? identity(platform)
          : { environmentId: "env-1", containerId: "container-1", isLocal: false };
        const tab = (isActive: boolean, ownsGlobalShortcuts?: boolean) => (
          <>
            <div data-pane-leaf="">
              <button type="button">Pane action</button>
              <AgentNativeTab
                tabId="focus-shortcut-tab"
                data={data}
                isActive={isActive}
                ownsGlobalShortcuts={ownsGlobalShortcuts}
              />
            </div>
            <div data-pane-leaf="">
              <button type="button">Terminal pane</button>
            </div>
          </>
        );
        const view = renderInAppCommandScope(tab(true));
        const input = await screen.findByRole("textbox");
        expect(input.getAttribute("contenteditable")).toBe("true");
        const action = screen.getByRole("button", { name: "Pane action" });
        const press = (target: Element) =>
          fireEvent.keyDown(target, {
            key: "i",
            code: "KeyI",
            [modifier]: true,
          });
        action.focus();
        expect(press(action)).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(press(input)).toBe(false);
        const sibling = screen.getByRole("button", { name: "Terminal pane" });
        sibling.focus();
        expect(press(sibling)).toBe(true);
        expect(document.activeElement).toBe(sibling);

        view.rerender(tab(true, false));
        action.focus();
        expect(press(action)).toBe(true);
        expect(document.activeElement).toBe(action);
        view.rerender(tab(false));
        expect(press(document.body)).toBe(true);
        expect(document.activeElement).toBe(action);
        view.rerender(tab(true));
        action.focus();
        expect(press(action)).toBe(false);
        expect(document.activeElement).toBe(input);
      });
    }
  }

  test("agent transcript loopback links carry the actual AgentNativeTab identity", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const content = "Ready at [seeded app](http://localhost:5173/).";
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id: "seeded-link",
          role: "assistant" as const,
          content,
          parts: [{ type: "text" as const, content }],
          createdAt: "2026-11-03T00:00:00Z",
        },
      ],
    }));
    const requests: unknown[] = [];
    const record = (event: Event) => requests.push((event as CustomEvent).detail);
    const { TERMINAL_BROWSER_TAB_REQUEST_EVENT } = await import("@/lib/terminal-links");
    window.addEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, record);
    try {
      renderInAppCommandScope(
        <AgentNativeTab tabId="seeded-agent-tab" data={identity("cursor")} isActive />,
      );
      const link = await screen.findByRole("link", { name: "seeded app" });
      fireEvent.click(link, { metaKey: true, shiftKey: true });
      expect(requests).toEqual([
        {
          environmentId: "env-1",
          sourceTabId: "seeded-agent-tab",
          url: "http://localhost:5173/",
          origin: "agent",
        },
      ]);
    } finally {
      window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, record);
    }
  });

  test("a resumed pipeline stage dispatches a manual message under its own request and tab identity", async () => {
    const stage = session("build", "stage-key", 0, {
      sdkSessionId: "claude-session",
      agent: "claude",
      structuredRequestId: "pipeline-owned-request",
      structuredResultStatus: "pending",
    });
    const pipeline = build({ sessions: [stage] });
    const options = pipelineSessionTabOptions(pipeline, { title: "Build", session: stage })!;
    const tabId = options.tabId!;
    const data: NativeAgentTabData = {
      ...identity("claude"),
      sessionId: options.resumeSessionId,
      requireExistingResumeSession: options.requireExistingResumeSession,
    };
    seedEnvTab({ id: tabId, type: "agent-native", nativeAgentData: data, ...options });
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await screen.findByTestId("shared-native-compose-bar");
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(adoptNativeAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      providerSessionId: stage.sdkSessionId,
      logicalSessionKey: createSessionKey("env-1", tabId),
    });
    act(() => {
      appCommandStore(nativeComposeStore).getState().updateDraft(createSessionKey("env-1", tabId), {
        text: "Explain the implementation so far",
      });
    });
    fireEvent.click(await screen.findByTitle("Send"));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const dispatch = dispatchNativeAgentIntentMock.mock.calls[0]![0];
    expect(dispatch).toMatchObject({
      agent: "claude",
      environmentId: "env-1",
      logicalSessionKey: createSessionKey("env-1", tabId),
      prompt: "Explain the implementation so far",
      origin: "interactive-native",
    });
    expect(dispatch.requestId).toBeTruthy();
    expect(dispatch.requestId).not.toBe(stage.structuredRequestId);
    expect(dispatch.logicalSessionKey).not.toBe(stage.sessionKey);
    expect(dispatch).not.toHaveProperty("schema");
    expect(dispatch).not.toHaveProperty("agentMcp");
    expect(stage.structuredRequestId).toBe("pipeline-owned-request");
  });

  test("hides streaming and completed datasets through the legacy workflow-tab fallback", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const commentary = "The tree is clean. Validation will run as separate commands.";
    const dataset = JSON.stringify({ headRef: "a".repeat(40), commands: [{ id: "check" }] });
    const draft = '{"headRef":"abc';
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id: "preparation-result",
          role: "assistant" as const,
          content: `${commentary} ${draft}`,
          parts: [{ type: "text" as const, content: `${commentary} ${draft}` }],
          createdAt: "2026-09-08T20:00:00.000Z",
        },
      ],
    }));

    const tabId = "multi-review-review:workflow-1";
    renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("cursor")} isActive />);

    expect(await screen.findByText(commentary)).toBeTruthy();
    expect(screen.getByTestId("native-agent-transcript-test-list").textContent).not.toContain(
      '"headRef"',
    );

    const sessionKey = createSessionKey("env-1", tabId);
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
              id: "preparation-result",
              role: "assistant",
              content: `${commentary} ${dataset}`,
              parts: [{ type: "text", content: `${commentary} ${dataset}` }],
              createdAt: "2026-09-08T20:00:00.000Z",
            },
          ],
        });
    });

    await waitFor(() =>
      expect(screen.getByTestId("native-agent-transcript-test-list").textContent).not.toContain(
        '"headRef"',
      ),
    );
    expect(screen.getByText(commentary)).toBeTruthy();
  });

  test("keeps provider JSON visible in a non-review native tab", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const combined = 'This is ordinary provider output. {"headRef":"abc';
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id: "ordinary-result",
          role: "assistant" as const,
          content: combined,
          parts: [{ type: "text" as const, content: combined }],
          createdAt: "2026-09-08T20:00:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="ordinary-tab" data={identity("cursor")} isActive />,
    );

    expect(await screen.findByText(combined)).toBeTruthy();
    expect(screen.getByTestId("native-agent-transcript-test-list").textContent).toContain(
      '"headRef"',
    );
  });

  test("routes questions and plan reviews into the transcript while action approvals stay pinned", async () => {
    fixtureState.renderVirtualizedMessages = true;
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      interactions: [
        pendingInteraction("question", "question-1"),
        pendingInteraction("plan-approval", "plan-1"),
        pendingInteraction("command-approval", "approval-1"),
      ],
    }));

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-question-routing" data={identity("claude")} isActive />,
    );

    const question = await screen.findByTestId("agent-question-card");
    const transcript = screen.getByTestId("native-agent-transcript-test-list");
    const composeDock = screen.getByTestId("compose-dock");
    const composer = screen.getByTestId("shared-native-compose-bar");
    const approval = screen.getByText("Approve command");
    const plan = screen.getByText("Show the plan in the transcript.");
    const planCard = screen
      .getByText("Approve Claude's plan")
      .closest<HTMLElement>('[role="group"]');

    expect(transcript.contains(question)).toBe(true);
    expect(transcript.contains(plan)).toBe(true);
    expect(planCard).toBeTruthy();
    expect(
      (within(planCard!).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(composeDock.contains(question)).toBe(false);
    expect(composeDock.contains(plan)).toBe(false);
    expect(composeDock.contains(approval)).toBe(true);
    expect(composeDock.className).not.toContain("top-1/2");
    // The layout margin sits on the wrapper that also holds the queue strip.
    const composerFrame = composer.parentElement!;
    expect(composerFrame.className).toContain("mb-4");
    expect(composerFrame.className).toContain("mt-2");
    expect(composerFrame.className).not.toContain("my-0");
  });

  test("uses transcript plan content when the provider plan body is unavailable", async () => {
    fixtureState.renderVirtualizedMessages = true;
    const unavailable = pendingInteraction("plan-approval", "plan-unavailable");
    unavailable.presentation = {
      title: "Claude's plan is unavailable for approval",
      body: "Claude asked to leave plan mode without providing a readable plan. Approval is disabled.",
      planAvailable: false,
      questions: [],
      confirmLabel: "Approve",
      declineLabel: "Deny",
      confirmDisabled: true,
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id: "assistant-plan-write",
          role: "assistant",
          content: "",
          createdAt: "2026-08-29T12:00:00.000Z",
          parts: [
            {
              type: "tool-invocation",
              content: "Write",
              toolName: "Write",
              toolArgs: {
                file_path: "/home/node/.claude/plans/fallback-plan.md",
                content: "# Transcript plan\n\n1. Recover this plan for display.",
              },
            },
          ],
        },
      ],
      interactions: [unavailable],
    }));

    renderInAppCommandScope(
      <TerminalProvider>
        <AgentNativeTab tabId="tab-plan-fallback" data={identity("claude")} isActive />
      </TerminalProvider>,
    );

    expect(await screen.findByText("Recover this plan for display.")).toBeTruthy();
    expect(
      screen.getByText(
        "Claude asked to leave plan mode without providing a readable plan. Approval is disabled.",
      ),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test.each(["pending", "succeeded"] as const)(
    "keeps isolated-container recovery terminal-only during host reauthentication %s",
    async (state) => {
      fixtureState.accountLoginProgress = {
        state,
        platform: "claude",
        mode: "reauthenticate",
        operationId: "host-reauth",
        accountId: "default",
      };
      getAgentAccountLoginMock.mockClear();
      startAgentAccountLoginMock.mockClear();
      listAgentAccountsMock.mockClear();
      fixtureState.renderVirtualizedMessages = true;
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ useHostClaudeCredentials: false });
      const createTab = mock(() => true);
      const error = "Failed to authenticate: OAuth session expired and could not be refreshed";
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        messages: [
          {
            id: "native-terminal:error:auth-failure",
            role: "system",
            content: error,
            createdAt: "2026-09-03T14:45:00.000Z",
            parts: [{ type: "text", content: error }],
          },
        ],
      }));

      renderInAppCommandScope(
        <TerminalProvider>
          <TerminalTabHarness createTab={createTab}>
            <AgentNativeTab tabId="tab-auth-recovery" data={identity("claude")} isActive />
          </TerminalTabHarness>
        </TerminalProvider>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
      expect(screen.queryByText("Signed in. Resend your message to continue.") === null).toBe(true);
      expect(screen.queryByLabelText("Sign-in code") === null).toBe(true);
      expect(getAgentAccountLoginMock).not.toHaveBeenCalled();
      expect(startAgentAccountLoginMock).not.toHaveBeenCalled();
      expect(listAgentAccountsMock).not.toHaveBeenCalled();
      expect(createTab).toHaveBeenCalledWith("plain", {
        displayTitle: "Claude sign-in",
        initialCommands: [CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND],
      });
    },
  );

  function claudeAuthFailureProjection(id: string, error: string) {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id,
          role: "system",
          content: error,
          createdAt: "2026-09-03T14:45:00.000Z",
          parts: [{ type: "text", content: error }],
        },
      ],
    }));
  }

  test("signs the host Claude login in from the app for a local environment", async () => {
    fixtureState.renderVirtualizedMessages = true;
    fixtureState.accountLoginProgress = { state: "idle" };
    startAgentAccountLoginMock.mockClear();
    const createTab = mock(() => true);
    claudeAuthFailureProjection(
      "native-terminal:error:auth-local",
      "authentication_error: Invalid authentication credentials",
    );

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab
            tabId="tab-auth-recovery-local"
            data={{ ...identity("claude"), containerId: undefined, isLocal: true }}
            isActive
          />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));

    expect(await screen.findByLabelText("Sign-in code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open sign-in page" })).toBeTruthy();
    expect(startAgentAccountLoginMock).toHaveBeenCalledWith(
      "claude",
      { reauthenticate: true },
      undefined,
    );
    expect(createTab).not.toHaveBeenCalled();
  });

  test("still offers the terminal for a local environment", async () => {
    fixtureState.renderVirtualizedMessages = true;
    fixtureState.accountLoginProgress = { state: "idle" };
    const createTab = mock(() => true);
    claudeAuthFailureProjection(
      "native-terminal:error:auth-local-terminal",
      "authentication_error: Invalid authentication credentials",
    );

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab
            tabId="tab-auth-recovery-local-terminal"
            data={{ ...identity("claude"), containerId: undefined, isLocal: true }}
            isActive
          />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use a terminal instead" }));
    expect(createTab).toHaveBeenCalledWith("plain", {
      displayTitle: "Claude sign-in",
      initialCommands: [CLAUDE_AUTH_LOGIN_COMMAND],
    });
  });

  test("signs in a container that shares the host login from the app, not a terminal", async () => {
    fixtureState.renderVirtualizedMessages = true;
    fixtureState.accountLoginProgress = { state: "idle" };
    startAgentAccountLoginMock.mockClear();
    appCommandStore(configStore).getState().updateGlobalConfig({ useHostClaudeCredentials: true });
    const createTab = mock(() => true);
    claudeAuthFailureProjection(
      "native-terminal:error:auth-shared-docker",
      "API Error: 401 unauthorized",
    );

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab tabId="tab-auth-recovery-shared" data={identity("claude")} isActive />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));

    expect(await screen.findByLabelText("Sign-in code")).toBeTruthy();
    expect(startAgentAccountLoginMock).toHaveBeenCalledWith(
      "claude",
      { reauthenticate: true },
      undefined,
    );
    expect(screen.queryByRole("button", { name: "Use a terminal instead" }) === null).toBe(true);
    expect(createTab).not.toHaveBeenCalled();
  });

  test("offers sign-in under Claude's own not-logged-in reply until the user sends again", async () => {
    fixtureState.accountLoginProgress = { state: "idle" };
    const notice = "Not logged in · Please run /login";
    const prompt = {
      id: "user-1",
      role: "user" as const,
      content: "hello",
      createdAt: "2026-09-03T14:44:00.000Z",
      parts: [{ type: "text" as const, content: "hello" }],
    };
    const reply = {
      id: "assistant-1",
      role: "assistant" as const,
      content: notice,
      createdAt: "2026-09-03T14:45:00.000Z",
      parts: [{ type: "text" as const, content: notice }],
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [prompt, reply],
    }));

    const { unmount } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-not-logged-in" data={identity("claude")} isActive />,
    );
    expect(await screen.findByRole("region", { name: "Sign in to Claude" })).toBeTruthy();
    unmount();

    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [prompt, reply, { ...prompt, id: "user-2", createdAt: "2026-09-03T14:46:00.000Z" }],
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-not-logged-in-later" data={identity("claude")} isActive />,
    );
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Sign in to Claude" }) === null).toBe(true);
  });

  describe("after Claude refuses a prompt with its not-logged-in notice", () => {
    const notice = "Not logged in · Please run /login";
    function answerWithRefusal() {
      fixtureState.accountLoginProgress = { state: "idle" };
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            content: "Fix the garbled text",
            createdAt: "2026-10-31T00:23:00.000Z",
            parts: [{ type: "text" as const, content: "Fix the garbled text" }],
          },
          {
            id: "assistant-1",
            role: "assistant" as const,
            content: notice,
            createdAt: "2026-10-31T00:23:01.000Z",
            parts: [{ type: "text" as const, content: notice }],
          },
        ],
      }));
    }

    test("says the prompt goes out again when the backend holds it, and sends nothing itself", async () => {
      answerWithRefusal();
      getNativeAgentSignInResendMock.mockResolvedValue({ pending: true });
      const tabId = "tab-backend-holds-prompt";
      renderInAppCommandScope(<AgentNativeTab tabId={tabId} data={identity("claude")} isActive />);

      expect(await screen.findByText(/Your message is sent again once you sign in\./)).toBeTruthy();
      expect(getNativeAgentSignInResendMock).toHaveBeenCalledWith({
        environmentId: "env-1",
        agent: "claude",
        logicalSessionKey: createSessionKey("env-1", tabId),
      });

      fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
      await screen.findByLabelText("Sign-in code");
      fixtureState.accountLoginProgress = {
        state: "succeeded",
        platform: "claude",
        mode: "reauthenticate",
        completedAt: new Date().toISOString(),
      };
      expect(
        await screen.findByText("Signed in. Sending your message again…", undefined, {
          timeout: 4_000,
        }),
      ).toBeTruthy();
      // The backend re-dispatches: this client neither holds nor sends the prompt.
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    });

    test.each([
      ["answers that it holds nothing", async () => ({ pending: false })],
      [
        "predates the feature",
        async (): Promise<{ pending: boolean }> => {
          throw new Error("Unknown backend command: get_native_agent_sign_in_resend");
        },
      ],
    ] as const)("asks the user to resend when the backend %s", async (label, answer) => {
      answerWithRefusal();
      getNativeAgentSignInResendMock.mockImplementation(answer);
      renderInAppCommandScope(
        <AgentNativeTab
          tabId={`tab-resend-by-hand-${label.length}`}
          data={identity("claude")}
          isActive
        />,
      );

      expect(
        await screen.findByText(/After signing in, return here and resend your message/),
      ).toBeTruthy();
      expect(screen.queryByText(/Your message is sent again once you sign in/) === null).toBe(true);
    });
  });

  test("does not mistake another provider's reply for Claude's notice", async () => {
    const notice = "Not logged in · Please run /login";
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          content: notice,
          createdAt: "2026-09-03T14:45:00.000Z",
          parts: [{ type: "text" as const, content: notice }],
        },
      ],
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-not-logged-in-codex" data={identity("codex")} isActive />,
    );
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Sign in to Claude" }) === null).toBe(true);
  });

  test("does not duplicate createTab's own failure notification", async () => {
    fixtureState.renderVirtualizedMessages = true;
    appCommandStore(configStore).getState().updateGlobalConfig({ useHostClaudeCredentials: false });
    mockToastError.mockClear();
    const createTab = mock(() => {
      mockToastError("Maximum tab limit reached");
      return false;
    });
    const error = "Failed to authenticate";
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      messages: [
        {
          id: "native-terminal:error:auth-tab-limit",
          role: "system",
          content: error,
          createdAt: "2026-09-03T14:45:00.000Z",
          parts: [{ type: "text", content: error }],
        },
      ],
    }));

    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab tabId="tab-auth-recovery-refused" data={identity("claude")} isActive />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith("Maximum tab limit reached");
  });

  test("keeps an unauthenticated Cursor composer stable and routes recovery to settings", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message:
          "Cursor is not signed in. Sign in from Settings › Cursor, or set a Cursor API key.",
      },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "signed-out",
      signIn: { kind: "terminal" },
    }));
    let requestedSection: unknown;
    const onSettings = (event: Event) => {
      requestedSection = (event as CustomEvent<unknown>).detail;
    };
    window.addEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, onSettings);
    try {
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-cursor-auth-required" data={identity("cursor")} isActive />,
      );

      expect(await screen.findByText(/Cursor is not signed in/)).toBeTruthy();
      const dock = screen.getByTestId("compose-dock");
      expect(dock.className).toContain("top-1/2");
      expect(
        (screen.getByTitle("Sign in to Cursor Agent before sending") as HTMLButtonElement).disabled,
      ).toBe(true);

      const input = screen.getByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Test" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      expect(dock.className).toContain("top-1/2");

      fireEvent.click(await screen.findByRole("button", { name: "Open Cursor Agent settings" }));
      expect(requestedSection).toBe("cursor");
    } finally {
      window.removeEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, onSettings);
    }
  });

  test("Codex keeps rereading a signed-in account until the auth notice clears, then unlocks", async () => {
    let needsAuth = true;
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      notices: needsAuth
        ? [
            {
              kind: "auth" as const,
              state: "needs-auth" as const,
              message: "Sign in to Codex again",
              occurrenceId: "failure-1",
            },
          ]
        : [],
    }));
    getNativeAgentAuthStatusMock.mockResolvedValue({
      state: "signed-out",
      signIn: { kind: "browser-url" },
    });
    installFakeReadCoordinator();
    const reread = installControlledTimeout(10_000, { label: "Codex sign-out reread" });
    try {
      const view = renderInAppCommandScope(
        <AgentNativeTab
          tabId="tab-codex-reread"
          data={identity("codex")}
          isActive
          refreshRequestId={0}
        />,
      );
      await screen.findByText("Sign in to Codex again");
      expect(
        (screen.getByTitle("Sign in to Codex before sending") as HTMLButtonElement).disabled,
      ).toBe(true);
      await waitFor(() => expect(reread.pendingCount()).toBe(1));
      const calls = getNativeAgentAuthStatusMock.mock.calls.length;
      getNativeAgentAuthStatusMock.mockResolvedValue({
        state: "signed-in",
        signIn: { kind: "browser-url" },
      });
      await act(async () => {
        expect(reread.advance()).toBe(1);
      });
      expect(getNativeAgentAuthStatusMock.mock.calls.length).toBe(calls + 1);
      // Account status can recover before the authoritative session snapshot.
      expect(reread.pendingCount()).toBe(1);
      expect(
        (screen.getByTitle("Sign in to Codex before sending") as HTMLButtonElement).disabled,
      ).toBe(true);
      needsAuth = false;
      view.rerender(
        <AgentNativeTab
          tabId="tab-codex-reread"
          data={identity("codex")}
          isActive
          refreshRequestId={1}
        />,
      );
      await waitFor(() =>
        expect(screen.queryByTitle("Sign in to Codex before sending") === null).toBe(true),
      );
      expect(reread.pendingCount()).toBe(0);
      const input = screen.getByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Recovered" } });
      await waitFor(() =>
        expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(false),
      );
      expect(reread.advance()).toBe(0);
      expect(getNativeAgentAuthStatusMock.mock.calls.length).toBe(calls + 1);
    } finally {
      cleanup();
      reread.restore();
      resetReadCoordinatorForTests();
    }
  });

  test("hiding a signed-out Codex tab cancels its outstanding reread timer", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "Codex needs sign-in",
        signIn: { kind: "browser-url" as const },
      },
    }));
    getNativeAgentAuthStatusMock.mockResolvedValue({
      state: "signed-out",
      signIn: { kind: "browser-url" },
    });
    installFakeReadCoordinator();
    const reread = installControlledTimeout(10_000, { label: "Codex sign-out reread" });
    try {
      const view = renderInAppCommandScope(
        <AgentNativeTab tabId="tab-codex-hidden" data={identity("codex")} isActive />,
      );
      await waitFor(() => expect(reread.pendingCount()).toBe(1));
      await act(async () => {
        reread.advance();
      });
      expect(reread.pendingCount()).toBe(1);
      view.rerender(
        <AgentNativeTab tabId="tab-codex-hidden" data={identity("codex")} isActive={false} />,
      );
      await waitFor(() => expect(reread.pendingCount()).toBe(0));
      const reads = getNativeAgentAuthStatusMock.mock.calls.length;
      await act(async () => {
        expect(reread.advance()).toBe(0);
      });
      expect(getNativeAgentAuthStatusMock.mock.calls.length).toBe(reads);
    } finally {
      cleanup();
      reread.restore();
      resetReadCoordinatorForTests();
    }
  });

  test("pending auth options never show the settings fallback", async () => {
    let resolveAuth!: (value: NativeAgentAuthStatus) => void;
    getNativeAgentAuthStatusMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    );
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Account needs sign-in" },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-auth-pending" data={identity("codex")} isActive />,
    );
    await screen.findByText("Account needs sign-in");
    expect(screen.queryByRole("button", { name: "Open Codex settings" }) === null).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Checking sign-in options…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => resolveAuth({ state: "signed-out", signIn: { kind: "browser-url" } }));
    expect(await screen.findByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
  });

  test.each(["reject", "null"])(
    "recovers from a %s auth read without remounting",
    async (failure) => {
      let reads = 0;
      getNativeAgentAuthStatusMock.mockImplementation(async () => {
        if (++reads === 1) {
          if (failure === "reject") throw new Error("Bridge unavailable");
          return null;
        }
        return { state: "signed-out", signIn: { kind: "browser-url" } };
      });
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        readiness: { state: "authentication-required" as const, message: "Account needs sign-in" },
      }));
      // The automatic re-read waits 1 s; control that delay instead of sleeping
      // through it. The fake coordinator keeps background reads off the real
      // clock, and every async query below names a timeout other than Testing
      // Library's 1 s default, so the auth retry is the only timer at 1 s.
      installFakeReadCoordinator();
      const authRetry = installControlledTimeout(1_000, { label: "native auth re-read" });
      const query = { timeout: 2_000 };
      try {
        renderInAppCommandScope(
          <AgentNativeTab tabId="tab-auth-retry" data={identity("codex")} isActive />,
        );
        await screen.findByRole("button", { name: "Retry sign-in options" }, query);
        expect(screen.queryByRole("button", { name: "Open Codex settings" }) === null).toBe(true);
        expect(reads).toBe(1);
        await waitFor(() => expect(authRetry.pendingCount()).toBe(1), query);
        await act(async () => {
          authRetry.advance();
        });
        expect(await screen.findByRole("button", { name: "Sign in to Codex" }, query)).toBeTruthy();
        expect(reads).toBe(2);
      } finally {
        cleanup();
        authRetry.restore();
        resetReadCoordinatorForTests();
      }
    },
  );

  test.each(["terminal", "none"] as const)(
    "confirmed %s auth options use settings",
    async (kind) => {
      getNativeAgentAuthStatusMock.mockImplementation(async () => ({
        state: "signed-out",
        signIn: { kind },
      }));
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        readiness: { state: "authentication-required" as const, message: "Account needs sign-in" },
      }));
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-auth-settings" data={identity("codex")} isActive />,
      );
      expect(await screen.findByRole("button", { name: "Open Codex settings" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Sign in to Codex" }) === null).toBe(true);
    },
  );

  test("a failed auth read has a manual retry while still authentication-required", async () => {
    let available = false;
    getNativeAgentAuthStatusMock.mockImplementation(async () =>
      available ? { state: "signed-out", signIn: { kind: "device-code" } } : null,
    );
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Account needs sign-in" },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-auth-manual-retry" data={identity("codex")} isActive />,
    );
    const retry = await screen.findByRole("button", { name: "Retry sign-in options" });
    available = true;
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
  });

  test("an expired Codex sign-in offers to sign in from the tab", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "You've been signed out of Codex. Sign in again to keep working.",
      },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth" as const,
      signIn: { kind: "browser-url" as const },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-codex-signed-out" data={identity("codex")} isActive />,
    );

    expect(await screen.findByText(/signed out of Codex/)).toBeTruthy();
    // Asked only because sign-in is required; the projection no longer carries it.
    await screen.findByRole("button", { name: "Sign in to Codex" });
    expect(getNativeAgentAuthStatusMock.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: createSessionKey("env-1", "tab-codex-signed-out"),
    });
    expect(screen.queryByRole("button", { name: "Open Codex settings" }) === null).toBe(true);
    const send = screen.getByTitle("Sign in to Codex before sending") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Blocked prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));

    await waitFor(() =>
      expect(openInBrowserMock).toHaveBeenCalledWith("https://auth.example.test/login"),
    );
    expect(beginNativeAgentSignInMock.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: createSessionKey("env-1", "tab-codex-signed-out"),
    });
    // A local backend shares this machine's browser, so its callback is reachable.
    expect(beginNativeAgentSignInMock.mock.calls[0]?.[0]).not.toHaveProperty("deviceCode");
    expect(mockToastInfo).toHaveBeenCalledWith("Finish signing in to Codex in your browser");
    const link = screen.getByRole("link", { name: "Open sign-in link" });
    expect(link.getAttribute("href")).toBe("https://auth.example.test/login");
    // The desktop shell denies target=_blank, so the link must go through the opener.
    openInBrowserMock.mockClear();
    expect(fireEvent.click(link)).toBe(false);
    expect(openInBrowserMock).toHaveBeenCalledWith("https://auth.example.test/login");
  });

  test("an abandoned Codex sign-in is cancelled on the provider's side", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Sign in to Codex" },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth" as const,
      signIn: { kind: "browser-url" as const },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-codex-cancel" data={identity("codex")} isActive />,
    );

    expect(screen.queryByRole("button", { name: "Cancel sign-in" }) === null).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));

    await waitFor(() => expect(cancelNativeAgentSignInMock).toHaveBeenCalledTimes(1));
    expect(cancelNativeAgentSignInMock.mock.calls[0]?.[0]).toEqual({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: createSessionKey("env-1", "tab-codex-cancel"),
    });
    expect(screen.queryByRole("link", { name: "Open sign-in link" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel sign-in" }) === null).toBe(true);
    // The sign-in can be started again.
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
  });

  test.each(["javascript:alert(1)", "not a URL"])(
    "cancels an invalid sign-in URL %s while retaining device cancellation",
    async (url) => {
      sessionProjectionMock.mockImplementation(async (input) => ({
        ...(await defaultProjection(input as never)),
        readiness: { state: "authentication-required" as const, message: "Sign in to Codex" },
      }));
      getNativeAgentAuthStatusMock.mockImplementation(async () => ({
        state: "needs-auth" as const,
        signIn: { kind: "device-code" as const },
      }));
      beginNativeAgentSignInMock.mockImplementation(async () => ({ url, code: "SAFE-CODE" }));
      renderInAppCommandScope(
        <AgentNativeTab tabId="invalid-sign-in" data={identity("codex")} isActive />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));
      await waitFor(() => expect(cancelNativeAgentSignInMock).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("SAFE-CODE")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Open sign-in link" }) === null).toBe(true);
      expect(openInBrowserMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      await waitFor(() => expect(cancelNativeAgentSignInMock).toHaveBeenCalledTimes(2));
    },
  );

  test("a Codex auth notice offers sign-in even when readiness remains ready", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      notices: [
        {
          kind: "auth" as const,
          state: "needs-auth" as const,
          message: "Sign in to Codex again",
          occurrenceId: "auth-1",
        },
      ],
    }));
    getNativeAgentAuthStatusMock.mockResolvedValue({
      state: "needs-auth",
      signIn: { kind: "browser-url" },
    });
    renderInAppCommandScope(
      <AgentNativeTab tabId="notice-sign-in" data={identity("codex")} isActive />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));
    await waitFor(() => expect(beginNativeAgentSignInMock).toHaveBeenCalledTimes(1));
  });

  test("reports when the Codex sign-in link cannot be opened", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Sign in to Codex" },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth" as const,
      signIn: { kind: "browser-url" as const },
    }));
    openInBrowserMock.mockImplementation(async () => {
      throw new Error("browser unavailable");
    });
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-codex-open-failure" data={identity("codex")} isActive />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Could not open the Codex sign-in link: browser unavailable",
      ),
    );
    expect(openInBrowserMock).toHaveBeenCalledWith("https://auth.example.test/login");
    expect(screen.getByRole("link", { name: "Open sign-in link" })).toBeTruthy();
  });

  test("keeps a delayed Codex sign-in link available when the popup is blocked", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Sign in to Codex" },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth" as const,
      signIn: { kind: "browser-url" as const },
    }));
    let resolveSignIn!: (value: { url: string }) => void;
    beginNativeAgentSignInMock.mockImplementation(
      () => new Promise((resolve) => (resolveSignIn = resolve)),
    );
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-codex-delayed" data={identity("codex")} isActive />,
    );
    const button = await screen.findByRole("button", { name: "Sign in to Codex" });
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "Open sign-in link" }) === null).toBe(true);
    resolveSignIn({ url: "https://auth.example.test/login" });
    const link = await screen.findByRole("link", { name: "Open sign-in link" });
    expect(link.getAttribute("href")).toBe("https://auth.example.test/login");
    expect(openInBrowserMock).toHaveBeenCalledWith("https://auth.example.test/login");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  test("reports a device code and a sign-in startup failure", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Sign in to Codex" },
    }));
    let pendingSignIn: NativeAgentAuthStatus["pendingSignIn"];
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth" as const,
      signIn: { kind: "device-code" as const },
      ...(pendingSignIn ? { pendingSignIn } : {}),
    }));
    beginNativeAgentSignInMock.mockImplementationOnce(async () => {
      pendingSignIn = {
        url: "https://auth.example.test/device",
        code: "ABCD-1234",
        expiresAt: Date.now() + 60_000,
      };
      return { url: pendingSignIn.url, code: pendingSignIn.code };
    });
    beginNativeAgentSignInMock.mockImplementationOnce(async () => {
      pendingSignIn = undefined;
      throw new Error("login unavailable");
    });
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-codex-device" data={identity("codex")} isActive />,
    );
    const button = await screen.findByRole("button", { name: "Sign in to Codex" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(mockToastInfo).toHaveBeenCalledWith(
        "Enter code ABCD-1234 to finish signing in to Codex",
      ),
    );
    expect(screen.getByRole("link", { name: "Open sign-in link" }).getAttribute("href")).toBe(
      "https://auth.example.test/device",
    );
    // The code stays in the banner for as long as the sign-in takes.
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    const retryButton = await screen.findByRole("button", { name: "Sign in to Codex" });
    await waitFor(() => expect((retryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retryButton);
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Could not start Codex sign-in: login unavailable",
      ),
    );
    expect(screen.queryByRole("link", { name: "Open sign-in link" }) === null).toBe(true);
    expect(screen.queryByText("ABCD-1234") === null).toBe(true);
  });

  test("rehydrates a pending device login after switching environments and a renderer reload without starting another login", async () => {
    let pendingSignIn: NativeAgentAuthStatus["pendingSignIn"];
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "Sign in to Codex",
        signIn: { kind: "browser-url" as const },
      },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async (input) => ({
      state: "needs-auth",
      signIn: { kind: "browser-url" },
      ...(input.environmentId === identity("codex").environmentId && pendingSignIn
        ? { pendingSignIn }
        : {}),
    }));
    beginNativeAgentSignInMock.mockImplementation(async () => {
      pendingSignIn = {
        url: "https://auth.example.test/device",
        code: "SAME-CODE",
        expiresAt: Date.now() + 60_000,
      };
      return { url: pendingSignIn.url, code: pendingSignIn.code };
    });
    const mount = () =>
      renderInAppCommandScope(
        <AgentNativeTab tabId="pending-device-login" data={identity("codex")} isActive />,
      );
    let view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));
    await screen.findByText("SAME-CODE");
    view.unmount();
    appCommandStore(environmentStore).setState({
      environments: [
        ...appCommandStore(environmentStore).getState().environments,
        {
          id: "other-environment",
          projectId: "project-1",
          name: "Other environment",
          order: 1,
          setupPhase: "ready",
        } as never,
      ],
    });
    const away = renderInAppCommandScope(
      <AgentNativeTab
        tabId="other-environment"
        data={{ ...identity("codex"), environmentId: "other-environment" }}
        isActive
      />,
    );
    await screen.findByRole("button", { name: "Sign in to Codex" });
    expect(screen.queryByText("SAME-CODE") === null).toBe(true);
    away.unmount();
    view = mount();
    await screen.findByText("SAME-CODE");
    expect(screen.getByRole("link", { name: "Open sign-in link" }).getAttribute("href")).toBe(
      pendingSignIn!.url,
    );
    view.unmount();
    // Reload loses every renderer projection, leaving only the backend fixture's live login.
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    mount();
    await screen.findByText("SAME-CODE");
    expect(screen.getByRole("link", { name: "Open sign-in link" }).getAttribute("href")).toBe(
      pendingSignIn!.url,
    );
    expect(beginNativeAgentSignInMock).toHaveBeenCalledTimes(1);
    expect(openInBrowserMock).toHaveBeenCalledTimes(1);
  });

  test("asks for a device code when the backend is on another machine", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: { state: "authentication-required" as const, message: "Sign in to Codex" },
    }));
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth" as const,
      signIn: { kind: "browser-url" as const },
    }));
    const previousGateway = window.orkestratorGateway;
    // The Electron preload publishes `desktop` only for a remote connection.
    window.orkestratorGateway = { enabled: true, desktop: true };
    try {
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-codex-remote" data={identity("codex")} isActive />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));
      await waitFor(() => expect(beginNativeAgentSignInMock).toHaveBeenCalled());
      expect(beginNativeAgentSignInMock.mock.calls[0]?.[0]).toMatchObject({
        agent: "codex",
        deviceCode: true,
      });
    } finally {
      window.orkestratorGateway = previousGateway;
    }
  });

  test("opens a Grok sign-in terminal from the route its readiness names", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "Grok Build isn't signed in.",
        signIn: { kind: "terminal" as const, hint: "Open a terminal and run grok login." },
      },
    }));
    const createTab = mock(() => true);
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab tabId="tab-grok-auth-required" data={identity("grok")} isActive />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    expect(await screen.findByText("Grok Build isn't signed in.")).toBeTruthy();
    expect(screen.getByText("Open a terminal and run grok login.")).toBeTruthy();
    // The tab is in a container, where the login is the container's own copy.
    expect(screen.getByText(/lasts until it restarts/)).toBeTruthy();
    expect(
      (screen.getByTitle("Sign in to Grok Build before sending") as HTMLButtonElement).disabled,
    ).toBe(true);
    // Grok's settings cannot sign in, so they are not offered.
    expect(screen.queryByRole("button", { name: "Open Grok Build settings" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in from a terminal" }));
    expect(createTab).toHaveBeenCalledWith("plain", {
      displayTitle: "Grok Build sign-in",
      initialCommands: ["grok login"],
    });
    // The readiness named the route, so the account was never read.
    expect(getNativeAgentAuthStatusMock).not.toHaveBeenCalled();
  });

  test("sends a local OpenCode tab to Settings rather than the CLI on PATH", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "OpenCode has no connected model provider. Sign one in from Settings → OpenCode.",
        signIn: {
          kind: "terminal" as const,
          hint: "Sign OpenCode Go in from Settings → OpenCode.",
        },
      },
    }));
    const createTab = mock(() => true);
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab
            tabId="tab-opencode-auth-required"
            data={{ ...identity("opencode"), containerId: undefined, isLocal: true }}
            isActive
          />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    expect(await screen.findByText("Sign OpenCode Go in from Settings → OpenCode.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in from a terminal" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "Open OpenCode settings" })).toBeTruthy();
    expect(createTab).not.toHaveBeenCalled();
  });

  test("opens OpenCode container sign-in in its terminal", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "OpenCode needs a provider login.",
        signIn: { kind: "terminal" as const },
      },
    }));
    const createTab = mock(() => true);
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab
            tabId="container-opencode-login"
            data={{ ...identity("opencode"), containerId: "container-opencode", isLocal: false }}
            isActive
          />
        </TerminalTabHarness>
      </TerminalProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in from a terminal" }));
    expect(createTab).toHaveBeenCalledWith("plain", {
      displayTitle: "OpenCode sign-in",
      initialCommands: ["opencode auth login"],
    });
    expect(
      screen.getByText(/A sign-in made in this container lasts until it restarts/),
    ).toBeTruthy();
  });

  test("terminal login clears authoritative readiness while away and survives a renderer reload", async () => {
    const locked = {
      state: "authentication-required" as const,
      message: "Grok Build isn't signed in.",
      signIn: { kind: "terminal" as const, hint: "Open a terminal and run grok login." },
    };
    // Backend fixture: login changes only its authoritative projection. No
    // event is delivered to the original tree while another environment is open.
    let signedIn = false;
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      revision: signedIn ? 2 : 1,
      readiness: input.environmentId === "env-1" && !signedIn ? locked : undefined,
    }));
    const createTab = mock(() => true);
    const mount = (environmentId: string) =>
      renderInAppCommandScope(
        <TerminalProvider>
          <TerminalTabHarness createTab={createTab}>
            <AgentNativeTab
              tabId="tab-grok-login-cycle"
              data={{ ...identity("grok"), environmentId }}
              isActive
            />
          </TerminalTabHarness>
        </TerminalProvider>,
      );
    appCommandStore(environmentStore).setState({
      environments: [
        ...appCommandStore(environmentStore).getState().environments,
        {
          id: "env-other",
          projectId: "project-1",
          name: "Other environment",
          order: 1,
          setupPhase: "ready",
        } as never,
      ],
    });
    const original = mount("env-1");
    await screen.findByText(locked.message);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { textContent: "hello after login" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in from a terminal" }));
    expect(createTab).toHaveBeenCalledWith("plain", {
      displayTitle: "Grok Build sign-in",
      initialCommands: ["grok login"],
    });
    original.unmount();
    const other = mount("env-other");
    await waitFor(() =>
      expect(
        sessionProjectionMock.mock.calls.some(([input]) => input.environmentId === "env-other"),
      ).toBe(true),
    );
    signedIn = true;
    other.unmount();
    const returned = mount("env-1");
    await screen.findByTitle("Send");
    await waitFor(() => expect(screen.queryByText(locked.message) === null).toBe(true));
    expect(screen.queryByTitle("Sign in to Grok Build before sending") === null).toBe(true);
    returned.unmount();
    // Reload discards all renderer projections; the backend fixture still
    // holds the successful login, so recovery cannot depend on a live event.
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    sessionProjectionMock.mockClear();
    mount("env-1");
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    await screen.findByTitle("Send");
    await waitFor(() => expect(screen.queryByText(locked.message) === null).toBe(true));
    fireEvent.input(screen.getByRole("textbox"), { target: { textContent: "hello after login" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Sign in from a terminal" }) === null).toBe(true);
  });

  test("Enter in an empty composer does nothing", async () => {
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-empty-send" data={identity("codex")} isActive />,
    );
    await screen.findByTitle("Send");
    const input = screen.getByRole("textbox");

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.input(input, { target: { textContent: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/message is empty/) === null).toBe(true);
  });

  test("asks an older bridge's auth status for the route and its hint", async () => {
    getNativeAgentAuthStatusMock.mockImplementation(async () => ({
      state: "needs-auth",
      signIn: { kind: "terminal", hint: "Open a Pi terminal tab and run /login." },
    }));
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "Pi has no signed-in model provider.",
      },
    }));
    const createTab = mock(() => true);
    renderInAppCommandScope(
      <TerminalProvider>
        <TerminalTabHarness createTab={createTab}>
          <AgentNativeTab
            tabId="tab-pi-auth-required"
            data={{ ...identity("pi"), containerId: undefined, isLocal: true }}
            isActive
          />
        </TerminalTabHarness>
      </TerminalProvider>,
    );

    expect(await screen.findByText("Open a Pi terminal tab and run /login.")).toBeTruthy();
    expect(screen.queryByText(/lasts until it restarts/) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in from a terminal" }));
    expect(createTab).toHaveBeenCalledWith("plain", {
      displayTitle: "Pi sign-in",
      initialCommands: ["pi"],
    });
    expect(getNativeAgentAuthStatusMock).toHaveBeenCalledTimes(1);
  });

  test("offers inline sign-in straight from a browser-url readiness route", async () => {
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "Sign in to Codex",
        signIn: { kind: "browser-url" as const },
      },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-codex-route" data={identity("codex")} isActive />,
    );

    expect(await screen.findByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Checking sign-in options…" }) === null).toBe(true);
    // The route is available immediately; the account read also recovers a pending code.
    expect(getNativeAgentAuthStatusMock).toHaveBeenCalledTimes(1);
  });

  test("does not take an earlier Claude sign-in as the answer to a current lock", async () => {
    // Yesterday's renewal finished before this lock was seen, so it says
    // nothing about the login Claude is missing now.
    fixtureState.accountLoginProgress = {
      state: "succeeded",
      platform: "claude",
      mode: "reauthenticate",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: {
        state: "authentication-required" as const,
        message: "Claude isn't signed in. Sign in to Claude to keep working.",
      },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-stale-renewal" data={identity("claude")} isActive />,
    );

    expect(await screen.findByRole("region", { name: "Sign in to Claude" })).toBeTruthy();
    await waitFor(() => expect(getAgentAccountLoginMock).toHaveBeenCalled());
    expect(screen.queryByText(/Signed in\. Resend your message/) === null).toBe(true);
    expect(screen.getByRole("button", { name: "Sign in to Claude" })).toBeTruthy();
  });

  test("routes Claude's sign-in readiness to its own sign-in card, once", async () => {
    fixtureState.accountLoginProgress = { state: "idle" };
    const notice = "Not logged in · Please run /login";
    const readiness = {
      state: "authentication-required" as const,
      message: "Claude isn't signed in. Sign in to Claude to keep working.",
      signIn: {
        kind: "terminal" as const,
        hint: "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
      },
    };
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness,
    }));
    const { unmount } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-readiness" data={identity("claude")} isActive />,
    );

    const readinessCard = await screen.findByRole("region", { name: "Sign in to Claude" });
    expect(screen.getAllByRole("region", { name: "Sign in to Claude" })).toHaveLength(1);
    expect(screen.getByTestId("compose-dock").contains(readinessCard)).toBe(true);
    expect(
      (screen.getByTitle("Sign in to Claude before sending") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Open Claude settings" }) === null).toBe(true);
    expect(
      screen.queryByText(
        "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
      ) === null,
    ).toBe(true);
    unmount();

    // Claude's own reply and the readiness ask for the same card.
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness,
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          content: notice,
          createdAt: "2026-09-03T14:45:00.000Z",
          parts: [{ type: "text" as const, content: notice }],
        },
      ],
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-claude-readiness-reply" data={identity("claude")} isActive />,
    );
    await screen.findByRole("region", { name: "Sign in to Claude" });
    expect(screen.getAllByRole("region", { name: "Sign in to Claude" })).toHaveLength(1);
  });

  test("an assigned Grok composer restores its image after a cold remount", async () => {
    const tabId = "tab-grok-draft-remount";
    const sessionKey = createSessionKey("env-1", tabId);
    const draftKey = composeDraftKey("grok", "env-1", sessionKey);
    const image = {
      id: "grok-image-1",
      type: "image",
      name: "layout.png",
      path: "/tmp/layout.png",
      previewUrl: "data:image/png;base64,abc",
    };
    composeDraftRecords.set(draftKey, {
      draftKey,
      ownerType: "environment",
      ownerId: "env-1",
      value: { text: "Review the layout", mentions: [], attachments: [image] },
      updatedAt: "2026-09-15T00:00:00.000Z",
      revision: 1,
    });

    // Both the shell's initial settle and the draft debounce take 400 ms.
    // Advance both explicitly; revision checks below prove the save also ran.
    const saveDebounce = installControlledTimeout(400, {
      label: "native compose draft save and column settle",
      maxPending: 2,
    });
    const flushSave = async () => {
      await waitFor(() => expect(saveDebounce.pendingCount()).toBe(2));
      await act(async () => {
        expect(saveDebounce.advance()).toBe(2);
      });
      saveDebounce.assertDrained();
    };
    try {
      const first = renderInAppCommandScope(
        <AgentNativeTab tabId={tabId} data={identity("grok")} isActive />,
      );
      expect(await screen.findByRole("button", { name: "Remove layout.png" })).toBeTruthy();
      await flushSave();
      await waitFor(() => expect(composeDraftRecords.get(draftKey)?.revision).toBeGreaterThan(1));
      const savedRevision = composeDraftRecords.get(draftKey)!.revision;
      first.unmount();
      appCommandStore(nativeComposeStore).setState({ drafts: new Map() });

      const remounted = renderInAppCommandScope(
        <AgentNativeTab tabId={tabId} data={identity("grok")} isActive />,
      );
      expect(await screen.findByRole("button", { name: "Remove layout.png" })).toBeTruthy();
      expect((await screen.findByRole("textbox")).textContent).toBe("Review the layout");
      await flushSave();
      await waitFor(() =>
        expect(composeDraftRecords.get(draftKey)?.revision).toBeGreaterThan(savedRevision),
      );
      expect(composeDraftRecords.get(draftKey)?.value).toMatchObject({ attachments: [image] });
      remounted.unmount();
    } finally {
      cleanup();
      saveDebounce.restore();
    }
  });

  test("unlocks a preserved draft when authoritative readiness recovers", async () => {
    let authenticationRequired = true;
    sessionProjectionMock.mockImplementation(async (input) => ({
      ...(await defaultProjection(input as never)),
      readiness: authenticationRequired
        ? {
            state: "authentication-required" as const,
            message: "Cursor authentication is required.",
          }
        : { state: "ready" as const },
    }));
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-cursor-auth-recovery" data={identity("cursor")} isActive />,
    );

    expect(await screen.findByText("Cursor authentication is required.")).toBeTruthy();
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Preserved draft" } });

    authenticationRequired = false;
    await deliverResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 2,
    });

    await waitFor(() =>
      expect(screen.queryByText("Cursor authentication is required.") === null).toBe(true),
    );
    expect(input.textContent).toBe("Preserved draft");
    expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "cursor", prompt: "Preserved draft" }),
    );
  });

  test("does not move an empty composer while its first prompt is rejected", async () => {
    let rejectPrompt!: (outcome: NativeAgentDispatchOutcome) => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      () =>
        new Promise<NativeAgentDispatchOutcome>((resolve) => {
          rejectPrompt = resolve;
        }),
    );
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-stable-rejection" data={identity("codex")} isActive />,
    );

    const input = await screen.findByRole("textbox");
    const dock = screen.getByTestId("compose-dock");
    fireEvent.input(input, { target: { textContent: "Test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dock.className).toContain("top-1/2");

    await act(async () => {
      rejectPrompt({ outcome: "rejected", error: "Prompt was rejected" });
    });
    expect(await screen.findByText("Prompt was rejected")).toBeTruthy();
    expect(dock.className).toContain("top-1/2");
  });

  test("keeps an unassigned tab composer-only without loading a bridge controller", () => {
    const { container } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-unassigned" data={{ environmentId: "env-1" }} isActive />,
    );

    const input = container.querySelector<HTMLElement>(".native-compose-input")!;
    expect(input.className).toContain("native-compose-input");
    expect(input.style.minHeight).toBe("28px");
    expect(screen.getByText("Ask an agent anything…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeTruthy();
    expect(screen.getByText("Ready to build")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume Session" })).toBeTruthy();
    expect(screen.getByTestId("compose-dock").className).toContain("top-1/2");
    expect(screen.getByTestId("unassigned-native-compose-bar").className).toContain("rounded-xl");
  });

  test("the attach control follows the session's capabilities, not only its platform's", async () => {
    // OpenCode's table offers attachments; this session's projection narrows them away.
    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      return {
        ...projection,
        capabilities: { ...projection.capabilities, attachments: { files: false, images: false } },
      };
    });
    const { unmount } = renderInAppCommandScope(
      <AgentNativeTab tabId="tab-narrowed" data={identity("opencode")} isActive />,
    );
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add attachment" }) === null).toBe(true),
    );
    unmount();
    sessionProjectionMock.mockImplementation(defaultProjection);
    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-full" data={identity("opencode")} isActive />,
    );
    expect(await screen.findByRole("button", { name: "Add attachment" })).toBeTruthy();
  });

  test("an annotation-only first prompt starts the selected agent", async () => {
    seedUnassignedDefaultCatalog();
    const tabId = "tab-design-annotation-first";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        annotations: [
          {
            id: "design-context",
            source: "design",
            text: "Canvas context: inspect the heading",
            comment: "",
          },
        ],
      });
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    const start = await screen.findByRole("button", { name: "Start agent" });
    expect(start.hasAttribute("disabled")).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0].prompt).toContain(
      "Canvas context: inspect the heading",
    );
  });

  test("clearing first-prompt annotations preserves unrelated attachments", async () => {
    seedUnassignedDefaultCatalog();
    const tabId = "tab-design-annotation-clear";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    const unrelated = {
      id: "unrelated",
      type: "file" as const,
      name: "notes.txt",
      path: "/workspace/notes.txt",
    };
    const otherAnnotation = { ...unrelated, id: "other", annotationId: "other-context" };
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        platform: "claude",
        annotations: [
          { id: "design-context", source: "design", text: "Canvas context", comment: "" },
        ],
        attachments: [
          unrelated,
          otherAnnotation,
          { ...unrelated, id: "linked", annotationId: "design-context" },
        ],
      });
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove design context" }));
    expect(
      nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey).annotations,
    ).toEqual([]);
    expect(
      nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey).attachments,
    ).toEqual([unrelated, otherAnnotation]);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("an ordinary unassigned local tab keeps its worktree paste destination", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Local worker",
          order: 0,
          setupPhase: "ready",
          worktreePath: "/tmp/local-worker",
        } as never,
      ],
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-local-unassigned" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() => expect(latestPasteOptions).not.toBeNull());
    expect(latestPasteOptions?.worktreePath).toBe("/tmp/local-worker");
    expect(latestPasteOptions?.writeImage).toBeUndefined();
  });

  for (const assigned of [false, true]) {
    test(`a ${assigned ? "assigned" : "unassigned"} bug-report composer stages pasted images by report ID`, async () => {
      seedUnassignedDefaultCatalog();
      appCommandStore(environmentStore).setState({ environments: [] });
      renderInAppCommandScope(
        <AgentNativeTab
          tabId={`bug-report-paste-${assigned}`}
          data={{
            environmentId: "bug-report:report-1",
            isLocal: true,
            ...(assigned ? { platform: "claude" as const } : {}),
          }}
          isActive
          coordinatorWorkspacePath="/tmp/orkestrator-bug-report-report-1"
          onAssignPlatform={async () => undefined}
          availablePlatforms={["claude", "codex"]}
        />,
      );
      await waitFor(() => expect(latestPasteOptions?.writeImage).toBeDefined());
      expect(latestPasteOptions?.worktreePath ?? null).toBeNull();
      expect(await latestPasteOptions?.writeImage?.("clipboard.png", "cG5n")).toBe(
        "/tmp/orkestrator-bug-report-report-1/screenshots/clipboard.png",
      );
      expect(writeBugReportAttachmentMock).toHaveBeenCalledWith(
        "report-1",
        "clipboard.png",
        "cG5n",
      );
      expect(writeCoordinatorAttachmentMock).not.toHaveBeenCalled();
    });
  }

  test("a coordinator tab assigns through the backend instead of locking a pane", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: { defaultAgent: "claude" },
      });
    appCommandStore(environmentStore).setState({ environments: [] });
    const onAssignPlatform = mock<
      (platform: AgentPlatform, prompt: string, options: unknown) => Promise<void>
    >(async () => undefined);

    const { container } = renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab"
        data={{ environmentId: "coordinator:workspace-1:conversation-1", isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        onAssignPlatform={onAssignPlatform}
        availablePlatforms={["claude", "codex"]}
        unassignedPlaceholder="Ask the coordinator to inspect or plan…"
      />,
    );

    expect(screen.getByText("Ask the coordinator to inspect or plan…")).toBeTruthy();
    // A coordinator conversation owns its provider session, so there is no
    // rollout for it to adopt.
    expect(screen.queryByRole("button", { name: "Resume Session" }) === null).toBe(true);

    const input = container.querySelector<HTMLElement>(".native-compose-input")!;
    fireEvent.input(input, { target: { textContent: "Inspect this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onAssignPlatform).toHaveBeenCalledTimes(1));
    expect(onAssignPlatform.mock.calls[0]![0]).toBe("claude");
    expect(onAssignPlatform.mock.calls[0]![1]).toContain("Inspect this");
    // The pane store owns a normal tab's lock; a coordinator conversation is
    // backend state and must not be locked locally.
    expect(appCommandStore(paneLayoutStore).getState().environments.size).toBe(0);
  });

  test("a platform-locked tab filters favourites and merges visible reorder into their original slots", async () => {
    const favoriteModels = [
      { platform: "codex" as const, modelId: "gpt-5.4" },
      { platform: "claude" as const, modelId: "claude-a" },
      { platform: "opencode" as const, modelId: "hidden" },
      { platform: "claude" as const, modelId: "claude-b" },
    ];
    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      return {
        ...projection,
        composer: {
          ...projection.composer,
          models: [
            { platform: "claude", id: "claude-a", label: "Claude A" },
            { platform: "claude", id: "claude-b", label: "Claude B" },
          ],
        },
      } as NativeAgentSessionProjection<NativeMessage>;
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        favoriteModels,
      });
    let pickerProps: Parameters<typeof modelPicker.AgentModelPicker>[0] | undefined;
    const OriginalPicker = modelPicker.AgentModelPicker;
    const picker = spyOn(modelPicker, "AgentModelPicker").mockImplementation((props) => {
      pickerProps = props;
      return <OriginalPicker {...props} />;
    });
    const persist = spyOn(realBackend, "patchGlobalConfig").mockImplementation(async (patch) => ({
      ...appCommandStore(configStore).getState().config,
      global: { ...appCommandStore(configStore).getState().config.global, ...patch },
    }));
    try {
      renderInAppCommandScope(
        <AgentNativeTab
          tabId="locked-favourites"
          data={{ environmentId: "env-1", platform: "claude" }}
          isActive
        />,
      );
      fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
      fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("menuitemradio")
            .map((item) => item.textContent)
            .filter((row) => row?.startsWith("Claude ")),
        ).toEqual(["Claude AClaude", "Claude BClaude"]),
      );
      expect(screen.queryByRole("menuitemradio", { name: /GPT-5.4/ }) === null).toBe(true);
      expect(pickerProps?.platformSelectionLocked).toBe(true);
      expect(pickerProps?.favorites).toEqual([favoriteModels[1]!, favoriteModels[3]!]);
      await act(async () => {
        pickerProps!.onReorderFavorites!([favoriteModels[3]!, favoriteModels[1]!]);
      });
      const reordered = [
        favoriteModels[0]!,
        favoriteModels[3]!,
        favoriteModels[2]!,
        favoriteModels[1]!,
      ];
      await waitFor(() =>
        expect(appCommandStore(configStore).getState().config.global.favoriteModels).toEqual(
          reordered,
        ),
      );
      expect(persist).toHaveBeenCalledWith({ favoriteModels: reordered });
    } finally {
      cleanup();
      picker.mockRestore();
      persist.mockRestore();
    }
  });

  test("an unassigned coordinator composer hides favourites for platforms it cannot use", async () => {
    seedUnassignedDefaultCatalog();
    const favoriteModels: Array<{ platform: AgentPlatform; modelId: string }> = [
      { platform: "opencode", modelId: "anthropic/opencode-only-model" },
      { platform: "codex", modelId: "gpt-5.4" },
      { platform: "claude", modelId: "claude-sonnet-5" },
    ];
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        favoriteModels,
        agentSettings: { defaultAgent: "claude" },
      } as never);
    appCommandStore(environmentStore).setState({ environments: [] });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab-favorites"
        data={{ environmentId: "coordinator:workspace-1:conversation-6", isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        onAssignPlatform={async () => undefined}
        availablePlatforms={["claude", "codex"]}
      />,
    );

    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));
    // Model rows only; the speed choices are radio items too.
    const modelRows = () =>
      screen
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent ?? "")
        .filter((row) => !row.includes("credit rate"));
    await waitFor(() => expect(modelRows()).toEqual(["GPT-5.4Codex", "Claude SonnetClaude"]));
    // The hidden favourite is still a favourite.
    expect(appCommandStore(configStore).getState().config.global.favoriteModels).toEqual(
      favoriteModels,
    );
  });

  test("an unassigned coordinator composer searches the checkout and stages pastes outside it", async () => {
    // Before its first prompt a conversation has no Environment record, so the
    // composer used to have no workspace to search and nowhere to put a pasted
    // image — and the one path it must never take is writing into the checkout.
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: { defaultAgent: "claude" },
      });
    appCommandStore(environmentStore).setState({ environments: [] });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab-attachments"
        data={{ environmentId: "coordinator:workspace-1:conversation-5", isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        coordinatorWorkspacePath="/tmp/project"
        onAssignPlatform={async () => undefined}
        availablePlatforms={["claude", "codex"]}
      />,
    );

    await waitFor(() => expect(getLocalFileTreeMock).toHaveBeenCalledWith("/tmp/project"));
    await waitFor(() => expect(latestPasteOptions).not.toBeNull());
    expect(latestPasteOptions?.worktreePath ?? null).toBeNull();
    expect(await latestPasteOptions?.writeImage?.("clipboard.png", "cG5n")).toBe(
      "/data/coordinator-attachments/coordinator:workspace-1:conversation-5/clipboard.png",
    );
    expect(writeCoordinatorAttachmentMock).toHaveBeenCalledWith(
      "coordinator:workspace-1:conversation-5",
      "clipboard.png",
      "cG5n",
    );
  });

  test("a failed coordinator assignment is reported and leaves the composer usable", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: { defaultAgent: "claude" },
      });
    appCommandStore(environmentStore).setState({ environments: [] });
    const onAssignPlatform = mock(async () => {
      throw new Error("Coordinator provider is unavailable");
    });

    const { container } = renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab-failure"
        data={{ environmentId: "coordinator:workspace-1:conversation-2", isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        onAssignPlatform={onAssignPlatform}
        availablePlatforms={["claude", "codex"]}
      />,
    );

    const input = container.querySelector<HTMLElement>(".native-compose-input")!;
    fireEvent.input(input, { target: { textContent: "Inspect this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Coordinator provider is unavailable")).toBeTruthy();
  });

  test("an unassigned coordinator tab with no qualified platform explains itself", () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: { defaultAgent: "claude" },
      });
    appCommandStore(environmentStore).setState({ environments: [] });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab-empty"
        data={{ environmentId: "coordinator:workspace-1:conversation-3", isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        onAssignPlatform={mock(async () => undefined)}
        availablePlatforms={["grok"]}
        emptyPlatformsMessage="No agent platform meets this coordinator's read-only requirement."
      />,
    );

    // Offering a Send button that can only fail is worse than saying why.
    expect(
      screen.getByText("No agent platform meets this coordinator's read-only requirement."),
    ).toBeTruthy();
    expect(screen.queryByTestId("unassigned-native-compose-bar") === null).toBe(true);
  });

  test("a coordinator platform caveat is shown inside the picker", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex"],
        agentSettings: { defaultAgent: "claude" },
      });
    appCommandStore(environmentStore).setState({ environments: [] });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="coordinator-tab-note"
        data={{ environmentId: "coordinator:workspace-1:conversation-4", isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        onAssignPlatform={mock(async () => undefined)}
        availablePlatforms={["claude", "codex"]}
        platformNotes={{ claude: "Claude's command sandbox is unavailable on this host." }}
      />,
    );

    fireEvent.pointerDown(await screen.findByTitle(/Choose model/));
    expect(document.querySelector("[data-native-platform-caveat='claude']")?.textContent).toContain(
      "command sandbox is unavailable",
    );
    // The caveat moved into the picker; the old paragraph beside the composer
    // must not return.
    expect(screen.queryByTestId("unassigned-platform-note") === null).toBe(true);
  });

  test("unassigned composer adopts the environment default agent and model", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { model: "claude-sonnet-5" },
            codex: { model: "o3", reasoningEffort: "medium" },
          },
        },
      });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
          agentSettings: {
            defaultAgent: "codex",
            platforms: {
              codex: { model: "gpt-5.4", reasoningEffort: "high", fastMode: true },
            },
          },
        } as never,
      ],
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-unassigned-env" data={{ environmentId: "env-1" }} isActive />,
    );

    await expectUnassignedPicker("codex", "GPT-5.4");
    expect(screen.getByText("High")).toBeTruthy();
    expect(document.querySelector("[data-native-model-platform='claude']") === null).toBe(true);
    fireEvent.pointerDown(screen.getByTitle(/Choose model/));
    expect(screen.getByRole("menuitemradio", { name: /^Fast/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  test("unassigned composer preselects the create-dialog model without locking the tab", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
        },
      });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
          agentSettings: { defaultAgent: "codex" },
        } as never,
      ],
    });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-create-dialog-preselect"
        data={{ environmentId: "env-1" }}
        isActive
        initialAgentModel="gpt-5.4"
        initialReasoningEffort="high"
        initialFastMode
      />,
    );

    await expectUnassignedPicker("codex", "GPT-5.4");
    const reasoning = screen.getByText("High");
    const composeBar = screen.getByTestId("unassigned-native-compose-bar");
    expect(reasoning).toBeTruthy();
    expect(composeBar).toBeTruthy();
    fireEvent.pointerDown(screen.getByTitle(/Choose model/));
    expect(screen.getByRole("menuitemradio", { name: /^Fast/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  test("unassigned composer preselects an explicit create-dialog provider over the environment default", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { model: "claude-sonnet-5" },
            codex: { model: "o3" },
          },
        },
      });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
          agentSettings: { defaultAgent: "claude" },
        } as never,
      ],
    });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-create-dialog-provider"
        data={{ environmentId: "env-1" }}
        isActive
        initialAgentPlatform="codex"
        initialAgentModel="gpt-5.4"
        initialReasoningEffort="high"
      />,
    );

    await expectUnassignedPicker("codex", "GPT-5.4");
    const composeBar = screen.getByTestId("unassigned-native-compose-bar");
    expect(composeBar).toBeTruthy();
    expect(document.querySelector("[data-native-model-platform='claude']") === null).toBe(true);
  });

  test("keeps a user provider switch after create-dialog preselect and dispatches through it", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        favoriteModels: [{ platform: "claude", modelId: "claude-sonnet-5" }],
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { model: "claude-sonnet-5", fastMode: false },
            codex: { model: "o3", reasoningEffort: "medium", fastMode: true },
          },
        },
      } as never);
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
          agentSettings: { defaultAgent: "claude" },
        } as never,
      ],
    });
    const tabId = "tab-preselect-then-switch";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(paneLayoutStore).setState((state) => {
      const environment = state.environments.get("env-1");
      if (!environment || environment.root.kind !== "leaf") return state;
      return {
        ...state,
        environments: new Map(state.environments).set("env-1", {
          ...environment,
          root: {
            ...environment.root,
            tabs: environment.root.tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    initialAgentPlatform: "codex",
                    initialAgentModel: "gpt-5.4",
                    initialReasoningEffort: "high",
                    initialFastMode: true,
                  }
                : tab,
            ),
          },
        }),
      };
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await expectUnassignedPicker("codex", "GPT-5.4");

    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Claude Sonnet/ }));

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.platform).toBe(
        "claude",
      ),
    );
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.modelId).toBe(
      "claude-sonnet-5",
    );
    const root = appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.root;
    expect(root?.kind).toBe("leaf");
    if (!root || root.kind !== "leaf") throw new Error("Expected leaf pane");
    expect(
      getNativeAgentData(root.tabs.find((tab) => tab.id === tabId)!)?.platform,
    ).toBeUndefined();

    // The picker stays open after a choice; dismiss it to reach the composer.
    fireEvent.keyDown(document.body, { key: "Escape" });
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Use Claude instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
    const lockedRoot = appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.root;
    expect(lockedRoot?.kind).toBe("leaf");
    if (!lockedRoot || lockedRoot.kind !== "leaf") throw new Error("Expected leaf pane");
    expect(getNativeAgentData(lockedRoot.tabs.find((tab) => tab.id === tabId)!)?.platform).toBe(
      "claude",
    );
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      agent: "claude",
      prompt: "Use Claude instead",
    });
  });

  test("does not re-seed create-dialog values after a deliberate platform switch", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        favoriteModels: [{ platform: "claude", modelId: "claude-sonnet-5" }],
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            claude: { model: "claude-sonnet-5", fastMode: false },
            codex: { model: "gpt-5.4", reasoningEffort: "high", fastMode: true },
          },
        },
      } as never);
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
    const tabId = "tab-one-shot-preselect";
    const sessionKey = createSessionKey("env-1", tabId);

    const view = renderInAppCommandScope(
      <AgentNativeTab
        tabId={tabId}
        data={{ environmentId: "env-1" }}
        isActive
        initialAgentPlatform="codex"
        initialAgentModel="gpt-5.4"
        initialReasoningEffort="high"
        initialExecutionProfileId="plan"
        initialFastMode
      />,
    );

    await expectUnassignedPicker("codex", "GPT-5.4");
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toMatchObject({
      platform: "codex",
      modelId: "gpt-5.4",
      reasoningId: "high",
      executionProfileId: "plan",
    });

    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "claude",
      modelId: undefined,
      reasoningId: undefined,
      executionProfileId: undefined,
      fastMode: false,
    });
    view.rerender(
      <AgentNativeTab
        tabId={tabId}
        data={{ environmentId: "env-1" }}
        isActive
        initialAgentPlatform="codex"
        initialAgentModel="gpt-5.4"
        initialReasoningEffort="high"
        initialExecutionProfileId="plan"
        initialFastMode
      />,
    );

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.platform).toBe(
        "claude",
      ),
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.modelId,
    ).toBeUndefined();
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.reasoningId,
    ).toBeUndefined();
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.executionProfileId,
    ).toBe(undefined);
  });

  test("does not overwrite a user pick when create-dialog fields arrive later", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
        },
      });
    const tabId = "tab-user-pick-before-republish";
    const sessionKey = createSessionKey("env-1", tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "codex",
      modelId: "gpt-5.4",
      reasoningId: "medium",
    });

    const view = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={{ environmentId: "env-1" }} isActive />,
    );
    await expectUnassignedPicker("codex", "GPT-5.4");

    view.rerender(
      <AgentNativeTab
        tabId={tabId}
        data={{ environmentId: "env-1" }}
        isActive
        initialAgentPlatform="claude"
        initialAgentModel="claude-sonnet-5"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toMatchObject({
        platform: "codex",
        modelId: "gpt-5.4",
        reasoningId: "medium",
      }),
    );
    expect(document.querySelector("[data-native-model-platform='claude']") === null).toBe(true);
  });

  test("unassigned composer adopts the repository default when the environment inherits", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { model: "claude-sonnet-5" },
            codex: { model: "o3" },
          },
        },
      });
    appCommandStore(configStore)
      .getState()
      .setRepositoryConfig("project-1", {
        defaultBranch: "main",
        prBaseBranch: "main",
        agentSettings: {
          defaultAgent: "codex",
          platforms: { codex: { model: "gpt-5.4" } },
        },
      });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-unassigned-repo" data={{ environmentId: "env-1" }} isActive />,
    );

    await expectUnassignedPicker("codex", "GPT-5.4");
    expect(document.querySelector("[data-native-model-platform='claude']") === null).toBe(true);
  });

  test("unassigned composer uses the application default when every tier inherits", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
        },
      });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-unassigned-app" data={{ environmentId: "env-1" }} isActive />,
    );

    await expectUnassignedPicker("claude", "Claude Sonnet");
    expect(document.querySelector("[data-native-model-platform='codex']") === null).toBe(true);
  });

  test("uses an execution profile for OpenCode's first prompt without carrying a stale mode", async () => {
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "opencode",
            id: "opencode/sonnet",
            label: "OpenCode Sonnet",
            supportsSpeed: false,
            supportsMode: false,
          },
          {
            platform: "codex",
            id: "codex-m",
            label: "Codex M",
            supportsSpeed: true,
            supportsMode: true,
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Mode gate",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["opencode", "codex"],
        favoriteModels: [],
      } as never);
    const tabId = "tab-opencode-initial-profile";
    seedUnassignedPane(tabId);
    const sessionKey = createSessionKey("env-1", tabId);
    // Simulate a persisted Plan conversation-mode draft from Codex, with fast
    // mode on. OpenCode's execution profile has its own field, so this must
    // start at Build instead of displaying Plan while dispatching Build — and
    // neither the mode nor the fast toggle may follow the draft across to a
    // platform whose capability table has no surface to apply them.
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "codex",
      modelId: "codex-m",
      mode: "plan",
      fastMode: true,
    });
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "opencode",
      modelId: "opencode/sonnet",
    });
    sessionProjectionMock.mockImplementation(async (input) => {
      const projection = await defaultProjection(input);
      if (input.agent !== "opencode") return projection;
      return {
        ...projection,
        composer: {
          models: projection.composer?.models ?? [],
          fastModeEnabled: projection.composer?.fastModeEnabled ?? false,
          fastModeAvailable: projection.composer?.fastModeAvailable ?? false,
          modes: [],
          selectedModeId: undefined,
          executionProfiles: [
            { id: "build", label: "Build agent" },
            { id: "plan", label: "Plan agent" },
          ],
          selectedExecutionProfileId: "plan",
        },
        capabilities: {
          ...projection.capabilities,
          composer: {
            ...projection.capabilities.composer,
            mode: false,
            executionProfile: true,
          },
        },
      };
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    expect(screen.queryByTestId("launch-mode-picker") === null).toBe(true);
    const profileButton = await screen.findByTestId("launch-execution-profile-picker");
    expect(profileButton.getAttribute("aria-label")).toBe("Mode: Build");
    fireEvent.pointerDown(profileButton);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Plan" }));

    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Plan the change" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(ensureNativeAgentSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "opencode",
          executionProfileId: "plan",
          sessionMode: undefined,
          // Not the stale `true` the Codex draft left behind.
          fastMode: false,
        }),
      ),
    );
    await waitFor(() =>
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "opencode",
          prompt: "Plan the change",
          executionAgent: "plan",
          mode: undefined,
        }),
      ),
    );
    expect(JSON.stringify(flushPaneLayoutNowMock.mock.calls[0]?.[1])).toContain(
      '"initialExecutionProfileId":"plan"',
    );
  });

  test("starts the first prompt's session in the launcher's approval mode", async () => {
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "codex",
            id: "codex-m",
            label: "Codex M",
            supportsSpeed: false,
            supportsMode: true,
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Approvals",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["codex"],
        favoriteModels: [],
      } as never);
    const tabId = "tab-codex-initial-approvals";
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(createSessionKey("env-1", tabId), {
      platform: "codex",
      modelId: "codex-m",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    const trigger = await screen.findByTestId("launch-approval-mode-picker");
    expect(trigger.getAttribute("aria-label")).toBe("Approvals: Full access");
    fireEvent.pointerDown(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Untrusted" }));

    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Change it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "codex", approvalMode: "untrusted" }),
      ),
    );
  });

  test("describes Codex's sandbox-edge approval modes as what they do in a container", async () => {
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "codex",
            id: "codex-m",
            label: "Codex M",
            supportsSpeed: false,
            supportsMode: true,
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Container approvals",
          order: 0,
          setupPhase: "ready",
          environmentType: "containerized",
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["codex"],
        favoriteModels: [],
      } as never);
    const tabId = "tab-codex-container-approvals";
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(createSessionKey("env-1", tabId), {
      platform: "codex",
      modelId: "codex-m",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    fireEvent.pointerDown(await screen.findByTestId("launch-approval-mode-picker"));
    const onRequest = await screen.findByRole("menuitemradio", { name: "On request" });
    expect(onRequest.getAttribute("title")).toContain("never asks; choose Untrusted");
  });

  test("shows a draft's annotations as removable chips and sends them with the first prompt", async () => {
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "codex",
            id: "codex-m",
            label: "Codex M",
            supportsSpeed: false,
            supportsMode: true,
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Annotations",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["codex"],
        favoriteModels: [],
      } as never);
    const tabId = "tab-unassigned-annotations";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    // What the design dialog leaves in a new conversation's draft.
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        platform: "codex",
        modelId: "codex-m",
        text: "Look at this",
        annotations: [
          { id: "design-1", source: "design", text: "Design context\nCanvas: x", comment: "" },
        ],
      });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    const pill = await screen.findByTestId("compose-annotation-count");
    expect(pill.textContent).toContain("Design context");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalled());
    const prompt = String(
      (dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0] as { prompt?: string })?.prompt,
    );
    expect(prompt.startsWith("Look at this")).toBe(true);
    expect(prompt).toContain("<orkestrator_transcript_annotations>");
    expect(prompt).toContain("Design context");
  });

  test("removes a draft's annotations from the unassigned composer", async () => {
    const tabId = "tab-unassigned-clear-annotations";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        annotations: [{ id: "design-1", source: "design", text: "Design context", comment: "" }],
      });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove design context" }));
    expect(
      nativeComposeDraft(appCommandStore(nativeComposeStore).getState(), sessionKey).annotations,
    ).toEqual([]);
  });

  test("cycles the launcher's execution profile with Shift+Tab", async () => {
    // Shift+Tab is the Plan/Build toggle on a platform with conversation modes.
    // A platform whose Plan/Build is an execution profile has to answer the same
    // keystroke, and the two handlers must stay mutually exclusive so one
    // keystroke never writes both fields.
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "opencode",
            id: "opencode/sonnet",
            label: "OpenCode Sonnet",
            supportsSpeed: false,
            supportsMode: false,
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Profile cycle",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["opencode"],
        favoriteModels: [],
      } as never);
    const tabId = "tab-opencode-profile-cycle";
    seedUnassignedPane(tabId);
    const sessionKey = createSessionKey("env-1", tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "opencode",
      modelId: "opencode/sonnet",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);

    const profileButton = await screen.findByTestId("launch-execution-profile-picker");
    expect(profileButton.getAttribute("aria-label")).toBe("Mode: Build");
    const input = screen.getByRole("textbox");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.executionProfileId,
      ).toBe("plan"),
    );
    // The conversation-mode field still holds its default: only one of the two
    // handlers may claim the keystroke, and the mode one would have flipped
    // this to "plan".
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.mode).toBe(
      "build",
    );

    // Wraps back round rather than running off the end of the pair.
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.executionProfileId,
      ).toBe("build"),
    );

    // A plain Tab is still the browser's focus move, not a profile change.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.executionProfileId,
    ).toBe("build");
  });

  test("drops the previous platform's effort when one click also switches platform", async () => {
    // The picker calls onPlatformChange and onModelChange from a single event,
    // so the render closure is still holding the pre-switch draft. Reading the
    // effort from that closure would carry it onto the new provider even though
    // the platform switch just cleared it.
    const reasoning = [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "xhigh", label: "Extra high" },
    ];
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "claude",
            id: "claude-m",
            label: "Claude M",
            reasoning,
            defaultReasoningId: "medium",
            supportsSpeed: true,
          },
          {
            platform: "codex",
            id: "codex-m",
            label: "Codex M",
            reasoning,
            defaultReasoningId: "medium",
            supportsSpeed: true,
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Effort switch",
          order: 0,
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex"],
        favoriteModels: [{ platform: "codex", modelId: "codex-m" }],
        agentSettings: {
          platforms: {
            claude: { fastMode: false },
            codex: { fastMode: true },
          },
        },
      } as never);
    const sessionKey = createSessionKey("env-1", "tab-effort-platform-switch");
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "claude",
      modelId: "claude-m",
      reasoningId: "xhigh",
    });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-effort-platform-switch"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    // The favorites view lists models across platforms without switching the
    // platform itself, which is what makes the single-click path reachable.
    fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Codex M/ }));

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.modelId).toBe(
        "codex-m",
      ),
    );
    // "xhigh" is a supported effort on the new model, so only a stale read
    // could produce it here.
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.reasoningId).toBe(
      "medium",
    );
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.platform).toBe(
      "codex",
    );
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.fastMode).toBe(
      true,
    );
  });

  test("keeps a still-supported effort when the model switch stays on one platform", async () => {
    const reasoning = [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "xhigh", label: "Extra high" },
    ];
    getNativeAgentModelCatalogMock.mockImplementation(
      async () =>
        [
          {
            platform: "claude",
            id: "claude-m",
            label: "Claude M",
            reasoning,
            defaultReasoningId: "medium",
          },
          {
            platform: "claude",
            id: "claude-n",
            label: "Claude N",
            reasoning,
            defaultReasoningId: "medium",
          },
        ] as never,
    );
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Effort same platform",
          order: 0,
        } as never,
      ],
    });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude"],
        favoriteModels: [],
      } as never);
    const sessionKey = createSessionKey("env-1", "tab-same-platform-switch");
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      platform: "claude",
      modelId: "claude-m",
      reasoningId: "xhigh",
    });

    renderInAppCommandScope(
      <AgentNativeTab
        tabId="tab-same-platform-switch"
        data={{ environmentId: "env-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    fireEvent.click(await screen.findByRole("button", { name: "claude models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Claude N/ }));

    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.modelId).toBe(
        "claude-n",
      ),
    );
    // No platform change, so an explicit choice the new model still supports
    // must survive rather than resetting to the advertised default.
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.reasoningId).toBe(
      "xhigh",
    );
  });

  test("asks for a platform before opening that provider's normal resume flow", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: [...AGENT_PLATFORMS],
      });
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
                  id: "tab-resume",
                  type: "agent-native",
                  nativeAgentData: { environmentId: "env-1" },
                },
              ],
              activeTabId: "tab-resume",
            },
            activePaneId: "default",
            containerId: null,
          },
        ],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Resume a session")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Claude/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Codex/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Cursor Agent/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Grok Build/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /OpenCode/ })).toBeTruthy();

    expect(
      (within(dialog).getByRole("button", { name: /Cursor Agent/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(dialog).getByRole("button", { name: /Grok Build/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: /Cursor Agent/ }));

    expect(await screen.findByRole("dialog", { name: "Resume Session" })).toBeTruthy();
    await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
  });

  function seedUnassignedResumeTab(tabId: string) {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: [...AGENT_PLATFORMS],
      });
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: tabId, type: "agent-native", nativeAgentData: { environmentId: "env-1" } },
              ],
              activeTabId: tabId,
            },
            activePaneId: "default",
            containerId: null,
          },
        ],
      ]),
      hydration: new Map([["env-1", "done"]]),
      activeEnvironmentId: "env-1",
    });
  }

  async function openGrokResumePicker(tabId: string) {
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Grok Build/ }));
    return await screen.findByRole("dialog", { name: "Resume Session" });
  }

  test.each([true, false])(
    "resume mapping preserves fork lineage and gates archive by capability (%s)",
    async (archive) => {
      listNativeAgentResumableSessionsMock.mockImplementation(
        async () =>
          [
            {
              sessionId: "fork-session",
              title: "Forked request",
              parentId: "parent-session",
              branchLabel: "Alternative branch",
            },
            { sessionId: "unnamed-fork", title: "Unnamed fork", parentId: "base" },
            { sessionId: "archived-session", title: "Archived request", archived: true },
          ] as never,
      );
      seedUnassignedResumeTab("tab-lineage");
      renderInAppCommandScope(<PaneBackedAgentNativeTab tabId="tab-lineage" />);
      fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: archive ? /Codex/ : /Grok Build/,
        }),
      );
      const picker = await screen.findByRole("dialog", { name: "Resume Session" });
      expect(await within(picker).findByText("Alternative branch")).toBeTruthy();
      expect(within(picker).getByText("Fork of base")).toBeTruthy();
      const listInput = listNativeAgentResumableSessionsMock.mock.calls.at(-1)?.[0];
      expect(listInput).toMatchObject({ agent: archive ? "codex" : "grok" });
      if (!archive) expect(listInput).not.toHaveProperty("includeArchived");
      expect(within(picker).queryByText("Archived request") === null).toBe(true);
      if (archive) {
        expect(listInput).toMatchObject({ includeArchived: true });
        fireEvent.click(within(picker).getByLabelText("Show archived (1)"));
        expect(await within(picker).findByText("Archived request")).toBeTruthy();
        fireEvent.click(within(picker).getAllByRole("button", { name: /Remove.*list/ })[0]!);
        await waitFor(() => expect(setNativeAgentResumableSessionArchivedMock).toHaveBeenCalled());
        expect(setNativeAgentResumableSessionArchivedMock.mock.calls[0]?.[0]).toMatchObject({
          agent: "codex",
          environmentId: "env-1",
          resumableSessionId: "fork-session",
          archived: true,
        });
      } else {
        expect(Boolean(within(picker).queryByRole("button", { name: /Remove.*list/ }))).toBe(false);
      }
    },
  );

  test("the OpenCode picker archives 2.x rows and offers no remove on 1.x rows", async () => {
    listNativeAgentResumableSessionsMock.mockImplementation(
      async () =>
        [
          { sessionId: "ses_legacy", title: "Legacy request", archivable: false },
          { sessionId: "opencode2:ses_new", title: "New request" },
        ] as never,
    );
    seedUnassignedResumeTab("tab-opencode-archive");
    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId="tab-opencode-archive" />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /OpenCode/ }));
    const picker = await screen.findByRole("dialog", { name: "Resume Session" });
    expect(await within(picker).findByText("Legacy request")).toBeTruthy();
    expect(listNativeAgentResumableSessionsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      agent: "opencode",
      includeArchived: true,
    });
    const removes = within(picker).getAllByRole("button", { name: /Remove.*list/ });
    expect(removes).toHaveLength(1);
    fireEvent.click(removes[0]!);
    await waitFor(() => expect(setNativeAgentResumableSessionArchivedMock).toHaveBeenCalled());
    expect(setNativeAgentResumableSessionArchivedMock.mock.calls[0]?.[0]).toMatchObject({
      agent: "opencode",
      resumableSessionId: "opencode2:ses_new",
      archived: true,
    });
  });

  test("a tab opened only to resume creates no session before the choice", async () => {
    const calls: string[] = [];
    ensureNativeAgentSessionMock.mockImplementation(async (input) => {
      calls.push("ensure");
      return defaultEnsureNativeAgentSession(input);
    });
    resumeNativeAgentSessionMock.mockImplementationOnce(async (input) => {
      calls.push(`resume ${input.providerSessionId}`);
      return {
        ...(await defaultProjection({ agent: input.agent!, environmentId: input.environmentId })),
        sessionId: input.providerSessionId,
        generation: `resumed:${input.providerSessionId}`,
      };
    });
    listNativeAgentResumableSessionsMock.mockImplementation(
      async () =>
        [
          {
            sessionId: "grok-earlier",
            title: "Earlier work",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ] as never,
    );
    seedUnassignedResumeTab("tab-resume-only");

    const picker = await openGrokResumePicker("tab-resume-only");
    expect(screen.getByText("Choose a Grok Build session to resume.")).toBeTruthy();
    // The list is read without a session of the tab's own.
    await waitFor(() => expect(listNativeAgentResumableSessionsMock).toHaveBeenCalled());
    expect(calls).toEqual([]);

    fireEvent.click(await within(picker).findByRole("button", { name: /Earlier work/ }));

    await waitFor(() =>
      expect(
        appCommandStore(paneLayoutStore).getState().getAllTabs("env-1")[0]?.nativeAgentData
          ?.sessionId,
      ).toBe("grok-earlier"),
    );
    await waitFor(() => expect(adoptNativeAgentSessionMock).toHaveBeenCalled());
    expect(calls).toEqual(["resume grok-earlier"]);
    // No composer exists yet, so no controls: an all-empty update is refused.
    const resumed = resumeNativeAgentSessionMock.mock.calls[0]?.[0] as
      { controls?: unknown } | undefined;
    expect(resumed).toBeDefined();
    expect(resumed?.controls).toBeUndefined();
  });

  test("dismissing the resume picker starts the tab's own session", async () => {
    seedUnassignedResumeTab("tab-resume-dismissed");

    const picker = await openGrokResumePicker("tab-resume-dismissed");
    expect(ensureNativeAgentSessionMock).not.toHaveBeenCalled();

    fireEvent.keyDown(picker, { key: "Escape" });

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(ensureNativeAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      agent: "grok",
      environmentId: "env-1",
    });
    expect(resumeNativeAgentSessionMock).not.toHaveBeenCalled();
  });

  test("a failed resume falls back to the tab's own session", async () => {
    listNativeAgentResumableSessionsMock.mockImplementation(
      async () => [{ sessionId: "grok-gone", title: "Gone" }] as never,
    );
    resumeNativeAgentSessionMock.mockImplementationOnce(async () => {
      throw new Error("Grok session is gone");
    });
    seedUnassignedResumeTab("tab-resume-failed");

    const picker = await openGrokResumePicker("tab-resume-failed");
    fireEvent.click(await within(picker).findByRole("button", { name: /Gone/ }));

    await waitFor(() => expect(ensureNativeAgentSessionMock).toHaveBeenCalledTimes(1));
    expect(resumeNativeAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  test("renders the backend-normalized OpenCode catalogue in a new tab", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Cached models",
          order: 0,
        } as never,
      ],
    });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-cached-models"), { platform: "opencode" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "opencode/model-a",
        platform: "opencode",
        label: "OpenCode A",
        providerLabel: "opencode",
      },
      {
        id: "opencode-go/model-b",
        platform: "opencode",
        label: "OpenCode Go B",
        providerLabel: "opencode-go",
      },
    ]);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-cached-models" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() =>
      expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1", "opencode"),
    );
    const picker = await screen.findByTitle(/Choose model/);
    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "opencode models" }));

    expect(screen.getByRole("menuitemradio", { name: /OpenCode A/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /OpenCode Go B/ })).toBeTruthy();
    expect(
      within(screen.getByRole("menuitemradio", { name: /OpenCode A/ })).getByText("opencode"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("menuitemradio", { name: /OpenCode Go B/ })).getByText("opencode-go"),
    ).toBeTruthy();
  });

  test("renders the cached Cursor catalogue without starting its SDK bridge", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["cursor"],
      });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Cursor models",
          order: 0,
        } as never,
      ],
    });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-cursor-models"), { platform: "cursor" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "composer-2.5",
        platform: "cursor",
        label: "Composer 2.5",
        providerLabel: "Cursor",
        reasoning: [{ id: "medium", label: "Medium" }],
        defaultReasoningId: "medium",
        supportsSpeed: true,
        supportsMode: true,
      },
    ]);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-cursor-models" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() =>
      expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1", "cursor"),
    );
    expect(awaitBridgeReadyMock).not.toHaveBeenCalled();
    const picker = await screen.findByTitle(/Choose model/);
    fireEvent.pointerDown(picker);
    fireEvent.click(screen.getByRole("button", { name: "cursor models" }));
    expect(screen.getByRole("menuitemradio", { name: /Composer 2.5/ })).toBeTruthy();
    expect(
      appCommandStore(agentModelCatalogStore)
        .getState()
        .cursorModels.map((model) => model.id),
    ).toEqual(["composer-2.5"]);
  });

  test("requests a first-use Pi catalogue when the selected platform has no cached list", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["pi"],
      });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Pi models",
          order: 0,
        } as never,
      ],
    });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-pi-models"), { platform: "pi" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "openai-codex/gpt-5.4",
        platform: "pi",
        label: "GPT-5.4",
        providerLabel: "OpenAI Codex",
        reasoning: [{ id: "high", label: "High" }],
        defaultReasoningId: "high",
        supportsSpeed: false,
        supportsMode: false,
      },
    ]);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-pi-models" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1", "pi"));
    expect((await screen.findByTitle(/Choose model/)).textContent).toContain("GPT-5.4");
    expect(
      appCommandStore(agentModelCatalogStore)
        .getState()
        .piModels.map((model) => model.id),
    ).toEqual(["openai-codex/gpt-5.4"]);
  });

  test("deduplicates the first-use request across StrictMode effect replay", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["pi"] });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-pi-strict"), { platform: "pi" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => []);

    renderInAppCommandScope(
      <StrictMode>
        <AgentNativeTab tabId="tab-pi-strict" data={{ environmentId: "env-1" }} isActive />
      </StrictMode>,
    );

    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1));
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1", "pi");
  });

  test("retries a transient first-use failure once and publishes the recovered catalogue", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["pi"] });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-pi-retry"), { platform: "pi" });
    const logs = captureLogs();
    let attempts = 0;
    getNativeAgentModelCatalogMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("catalogue temporarily unavailable");
      return [
        {
          id: "openai-codex/gpt-5.4",
          platform: "pi",
          label: "GPT-5.4",
          providerLabel: "OpenAI Codex",
          supportsSpeed: false,
          supportsMode: false,
        },
      ];
    });

    try {
      renderInAppCommandScope(
        <AgentNativeTab tabId="tab-pi-retry" data={{ environmentId: "env-1" }} isActive />,
      );

      await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByTitle(/Choose model/).textContent).toContain("GPT-5.4"),
      );
      expect(
        appCommandStore(agentModelCatalogStore)
          .getState()
          .piModels.map((model) => model.id),
      ).toEqual(["openai-codex/gpt-5.4"]);
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "web.native-agent",
          event: "model-catalogue.load-failed",
        }),
      );
    } finally {
      logs.restore();
    }
  });

  // The catalogue is environment-scoped and already holds every platform, so a
  // platform switch must filter what is loaded rather than clearing the list or
  // refetching a platform the current snapshot already contains.
  test("does not refetch the catalogue when the composer platform changes", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Model catalogue",
          order: 0,
        } as never,
      ],
    });
    const sessionKey = createSessionKey("env-1", "tab-platform-switch");
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "cursor" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => [
      {
        id: "composer-2.5",
        platform: "cursor",
        label: "Composer 2.5",
        providerLabel: "Cursor",
        supportsSpeed: true,
        supportsMode: true,
      },
      {
        id: "grok-build",
        platform: "grok",
        label: "Grok Build",
        providerLabel: "Grok",
        supportsSpeed: false,
        supportsMode: true,
      },
    ]);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-platform-switch" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() =>
      expect(screen.getByTitle(/Choose model/).textContent).toContain("Composer 2.5"),
    );
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);

    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "grok" });

    // The grok half of the same catalogue resolves immediately: no refetch, and
    // no transient "No models available".
    await waitFor(() =>
      expect(screen.getByTitle(/Choose model/).textContent).toContain("Grok Build"),
    );
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No models available") === null).toBe(true);
  });

  // A first-use response is scoped to the platform whose bridge just started,
  // so it legitimately arrives without the platform the picker already had.
  // Replacing rather than merging would empty the picker the user came from.
  test("keeps an already-loaded platform when a first-use response omits it", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["cursor", "pi"],
      });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "First-use merge",
          order: 0,
        } as never,
      ],
    });
    const sessionKey = createSessionKey("env-1", "tab-first-use-merge");
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "cursor" });
    const cursorModel = {
      id: "composer-2.5",
      platform: "cursor" as const,
      label: "Composer 2.5",
      providerLabel: "Cursor",
      supportsSpeed: true,
      supportsMode: true,
    };
    const piModel = {
      id: "openai-codex/gpt-5.4",
      platform: "pi" as const,
      label: "GPT-5.4",
      providerLabel: "OpenAI Codex",
      supportsSpeed: false,
      supportsMode: false,
    };
    // The Pi bridge was not running for the first read, so its rows only appear
    // once the picker asks for that platform by name.
    getNativeAgentModelCatalogMock.mockImplementation(async (_environmentId, ensureAgent) =>
      ensureAgent === "pi" ? [piModel] : [cursorModel],
    );

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-first-use-merge" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() =>
      expect(screen.getByTitle(/Choose model/).textContent).toContain("Composer 2.5"),
    );

    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "pi" });
    await waitFor(() => expect(screen.getByTitle(/Choose model/).textContent).toContain("GPT-5.4"));
    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1", "pi"));

    // Back to Cursor: its rows survived the Pi-only response.
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "cursor" });
    await waitFor(() =>
      expect(screen.getByTitle(/Choose model/).textContent).toContain("Composer 2.5"),
    );
    expect(screen.queryByText("No models available") === null).toBe(true);
  });

  // The memo is keyed per environment and platform, so a platform whose bridge
  // genuinely has no models must not re-trigger a bridge start on every render.
  test("does not repeat a first-use request that came back without the platform", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["pi"] });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "First-use empty",
          order: 0,
        } as never,
      ],
    });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-first-use-empty"), { platform: "pi" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => []);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-first-use-empty" data={{ environmentId: "env-1" }} isActive />,
    );

    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledWith("env-1", "pi"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);
  });

  test("does not restart an empty bridge-backed catalogue on window focus", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["grok"] });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-grok-focus"), { platform: "grok" });
    getNativeAgentModelCatalogMock.mockImplementation(async () => []);

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-grok-focus" data={{ environmentId: "env-1" }} isActive />,
    );
    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);
  });

  test("does not invalidate a catalogue request while it is still in flight", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["opencode"] });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-opencode-in-flight"), {
        platform: "opencode",
      });
    let resolveRequest!: (
      models: Awaited<ReturnType<typeof realBackend.getNativeAgentModelCatalog>>,
    ) => void;
    getNativeAgentModelCatalogMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-opencode-in-flight" data={{ environmentId: "env-1" }} isActive />,
    );
    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event(MODEL_CATALOG_REFRESHED_EVENT));
    });
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveRequest([]));
  });

  test("retries after a catalogue refresh, hydrates the cache, and stops once models arrive", async () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["opencode"] });
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", "tab-opencode-refresh"), {
        platform: "opencode",
      });
    let attempts = 0;
    getNativeAgentModelCatalogMock.mockImplementation(async () => {
      attempts += 1;
      return attempts === 1
        ? []
        : [
            {
              id: "openai/gpt-5.4",
              platform: "opencode",
              label: "GPT-5.4",
              providerLabel: "OpenAI",
            },
          ];
    });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-opencode-refresh" data={{ environmentId: "env-1" }} isActive />,
    );
    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event(MODEL_CATALOG_REFRESHED_EVENT)));
    await waitFor(() => expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle(/Choose model/).textContent).toContain("GPT-5.4"));
    await waitFor(() => expect(getAgentModelCatalogCacheMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event(MODEL_CATALOG_REFRESHED_EVENT));
    });
    await act(async () => Promise.resolve());
    expect(getNativeAgentModelCatalogMock).toHaveBeenCalledTimes(2);
  });

  test("drops attachments the newly selected platform cannot receive", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Attachment reconcile",
          order: 0,
        } as never,
      ],
    });
    const sessionKey = createSessionKey("env-1", "tab-attachment-switch");
    const file = {
      id: "attachment-file",
      type: "file" as const,
      path: "/workspace/docs/notes.md",
      name: "notes.md",
    };
    const image = {
      id: "attachment-image",
      type: "image" as const,
      path: "/workspace/docs/shot.png",
      previewUrl: "blob:preview",
      name: "shot.png",
    };
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        platform: "claude",
        text: "review these",
        attachments: [file, image],
      });

    renderInAppCommandScope(
      <AgentNativeTab tabId="tab-attachment-switch" data={{ environmentId: "env-1" }} isActive />,
    );
    // Claude takes both, so nothing is reconciled away.
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.attachments,
      ).toEqual([file, image]),
    );

    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "codex" });

    /*
     * Codex accepts images and refuses files, and its bridge rejects the whole
     * prompt rather than dropping the entry it cannot use. Keeping the file
     * here would fail the next send with an error naming an attachment the
     * composer had stopped offering.
     */
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.attachments,
      ).toEqual([image]),
    );
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "review these",
    );

    // Cursor reads inline images but takes no files, so the same
    // reconcile applies: back to a provider that accepts both, then across.
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        platform: "claude",
        attachments: [file, image],
      });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.attachments,
      ).toEqual([file, image]),
    );

    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, { platform: "cursor" });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.attachments,
      ).toEqual([image]),
    );
  });

  test.each(["button", "Enter"])(
    "dispatches the first prompt after %s and immediate unmount, before any projection read",
    async (trigger) => {
      let releaseSave!: () => void;
      flushPaneLayoutNowMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSave = resolve;
          }),
      );
      let releaseDispatch!: () => void;
      dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
        return { outcome: "accepted", requestId: input.requestId };
      });
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
                    id: "tab-first-prompt",
                    type: "agent-native",
                    nativeAgentData: { environmentId: "env-1" },
                  },
                ],
                activeTabId: "tab-first-prompt",
              },
              activePaneId: "default",
              containerId: null,
            },
          ],
        ]),
        hydration: new Map([["env-1", "done"]]),
        activeEnvironmentId: "env-1",
      });
      appCommandStore(nativeComposeStore)
        .getState()
        .updateDraft(createSessionKey("env-1", "tab-first-prompt"), {
          text: "Review @widget.ts",
          mentions: [
            {
              id: "mention-1",
              filename: "widget.ts",
              relativePath: "src/widget.ts",
            },
          ],
          attachments: [
            {
              id: "image-1",
              type: "image",
              name: "layout.png",
              path: "/workspace/.orkestrator/clipboard/layout.png",
              previewUrl: "data:image/png;base64,abc",
            },
          ],
        });

      const view = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId="tab-first-prompt" />);
      if (trigger === "button")
        fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
      else fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      // Switch away before even the provider-lock save has acknowledged. There
      // must be no mounted controller left to create the session or send later.
      view.unmount();

      await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
      const root = appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.root;
      expect(root?.kind).toBe("leaf");
      if (!root || root.kind !== "leaf") throw new Error("Expected leaf pane");
      const tab = root.tabs.find((candidate) => candidate.id === "tab-first-prompt");
      expect(getNativeAgentData(tab!)?.platform).toBe("claude");
      expect(tab?.initialPrompt).toBeUndefined();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      releaseSave();
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      expect(ensureNativeAgentSessionMock).not.toHaveBeenCalled();
      expect(sessionProjectionMock).not.toHaveBeenCalled();
      expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
        sessionMode: "build",
        parameterValues: { thinking: "adaptive", context1m: false },
        attachments: [
          {
            type: "image",
            path: "/workspace/.orkestrator/clipboard/layout.png",
            filename: "layout.png",
          },
        ],
      });
      expect(
        extractMarkedAttachmentReferences(dispatchNativeAgentIntentMock.mock.calls[0]![0].prompt),
      ).toEqual({
        prompt: "Review [@widget.ts](src/widget.ts)",
        attachments: [{ name: "layout.png", path: "/workspace/.orkestrator/clipboard/layout.png" }],
      });
      expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0].executionProfileId).toBeUndefined();
      const sessionKey = createSessionKey("env-1", "tab-first-prompt");
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
      ).toBe(true);
      // Return while dispatch is pending, then leave again. Rehydration must not
      // send it twice or enable another send before the first acknowledgement.
      const returned = renderInAppCommandScope(
        <PaneBackedAgentNativeTab tabId="tab-first-prompt" />,
      );
      expect(screen.queryByTitle("Send") === null).toBe(true);
      returned.unmount();
      releaseDispatch();
      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey),
        ).toBeUndefined(),
      );
      renderInAppCommandScope(<PaneBackedAgentNativeTab tabId="tab-first-prompt" />);
      await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    },
  );

  test("settles a first prompt after the remounted composer is edited while dispatch is pending", async () => {
    let releaseDispatch!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      return { outcome: "accepted", requestId: input.requestId };
    });
    const tabId = "tab-first-prompt-edit-pending";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      text: "Ship the original prompt",
      platform: "claude",
    });

    const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    first.unmount();

    const remounted = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    // A content write that drops requestId is the settlement-mismatch case:
    // submissionPending must still clear or the remounted controller stays locked.
    appCommandStore(nativeComposeStore).setState((state) => {
      const current = state.drafts.get(sessionKey);
      if (!current) return state;
      const drafts = new Map(state.drafts);
      const next = { ...current, text: "A follow-up typed during send" };
      delete next.requestId;
      drafts.set(sessionKey, next);
      return { drafts };
    });
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.requestId,
    ).toBeUndefined();
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
    ).toBe(true);
    releaseDispatch();

    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
      ).not.toBe(true),
    );
    await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTitle("Send")).toBeTruthy());
    remounted.unmount();
  });

  test.each([
    {
      name: "rejected",
      settle: async (input: { requestId: string }) => ({
        outcome: "rejected" as const,
        requestId: input.requestId,
        error: "Provider refused the first prompt.",
      }),
      expectedError: "Provider refused the first prompt.",
    },
    {
      name: "unknown",
      settle: async (input: { requestId: string }) => ({
        outcome: "unknown" as const,
        requestId: input.requestId,
        error: "The response was lost",
      }),
      expectedError: undefined,
    },
    {
      name: "thrown transport",
      settle: async () => {
        throw new Error("socket closed");
      },
      expectedError:
        "The connection dropped before your message was confirmed. Retry with the same message to check its submission.",
    },
  ])(
    "unlocks a remounted first-prompt composer after a $name dispatch",
    async ({ name, settle, expectedError }) => {
      let releaseDispatch!: () => void;
      dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
        return settle(input);
      });
      const tabId = `tab-first-prompt-${name.replace(/\s+/g, "-")}-remount`;
      const sessionKey = createSessionKey("env-1", tabId);
      seedUnassignedPane(tabId);
      appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
        text: "Retry this first prompt",
        platform: "claude",
      });

      const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
      fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      first.unmount();

      const remounted = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
      ).toBe(true);
      releaseDispatch();

      await waitFor(() =>
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
        ).toBe(false),
      );
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionError,
      ).toBe(expectedError);
      if (!expectedError) {
        expect(
          appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)
            ?.pendingTranscriptConfirmation?.requestId,
        ).toMatch(/\S/);
      }
      await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTitle("Send")).toBeTruthy());
      remounted.unmount();
    },
  );

  test("restores a pending first draft after a cold remount onto the locked provider key", async () => {
    let releaseDispatch!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      return { outcome: "accepted", requestId: input.requestId };
    });
    const tabId = "tab-first-prompt-cold-remount";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      text: "Survive a renderer restart",
      platform: "claude",
      requestId: "first-prompt-request-1",
    });

    const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        composeDraftRecords.get(composeDraftKey("claude", "env-1", sessionKey))?.value,
      ).toMatchObject({
        text: "Survive a renderer restart",
        metadata: { requestId: "first-prompt-request-1" },
      }),
    );
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    first.unmount();
    appCommandStore(nativeComposeStore).setState({ drafts: new Map() });

    const remounted = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toMatchObject({
        text: "Survive a renderer restart",
        requestId: "first-prompt-request-1",
      }),
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
    ).not.toBe(true);
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("textbox")).textContent).toBe("Survive a renderer restart");
    remounted.unmount();
    releaseDispatch();
  });

  test("clears an unknown first prompt after remount sees the authoritative user row", async () => {
    let releaseDispatch!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      return {
        outcome: "unknown" as const,
        requestId: input.requestId,
        error: "The response was lost",
      };
    });
    const tabId = "tab-first-prompt-unknown-echo";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      text: "Run the focused tests",
      platform: "claude",
    });

    const first = renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    releaseDispatch();
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
          id: "first-prompt-echo",
          role: "user" as const,
          content: "Run the focused tests",
          parts: [{ type: "text" as const, content: "Run the focused tests" }],
          createdAt: "2026-08-26T14:00:00.000Z",
        },
      ],
    }));

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
    expect((await screen.findByRole("textbox")).textContent).toBe("");
  });

  test("auto-sends design-seeded images in the first native prompt exactly once across remount", async () => {
    const { addDesignImagesToDraft } = await import("../design/design-prompt-images");
    const tabId = "design-agent-opening-image";
    const sessionKey = createSessionKey("env-1", tabId);
    const path = "/tmp/wt/.orkestrator/clipboard/design.png";
    expect(
      addDesignImagesToDraft(sessionKey, [
        { id: "design-image", type: "image", path, name: "design.png" },
      ]),
    ).toBe(true);
    const props = {
      tabId,
      data: freshTab("claude"),
      initialPrompt: "Create a design matching this screenshot",
      isActive: true,
    };
    const view = renderInAppCommandScope(<AgentNativeTab {...props} />);
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
      agent: "claude",
      prompt: expect.stringContaining("Create a design matching this screenshot"),
      attachments: [{ type: "image", path, filename: "design.png" }],
    });
    await waitFor(() =>
      expect(
        appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.attachments ?? [],
      ).toEqual([]),
    );
    view.unmount();
    renderInAppCommandScope(<AgentNativeTab {...props} initialPrompt={undefined} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
  });

  test("carries a coordinator-staged image through assignment as a structured attachment", async () => {
    seedUnassignedDefaultCatalog();
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: { defaultAgent: "claude" },
      });
    appCommandStore(environmentStore).setState({ environments: [] });
    const tabId = "coordinator-tab-first-attachment";
    const environmentId = "coordinator:workspace-1:conversation-7";
    const sessionKey = createSessionKey(environmentId, tabId);
    const attachmentPath = "/data/coordinator-attachments/workspace-1/conversation-7/layout.png";
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(sessionKey, {
        platform: "claude",
        text: "Review the layout",
        attachments: [
          {
            id: "coordinator-image-1",
            type: "image",
            name: "layout.png",
            path: attachmentPath,
            previewUrl: "data:image/png;base64,abc",
          },
        ],
      });
    const onAssignPlatform = mock<
      (
        platform: AgentPlatform,
        prompt: string,
        options: {
          modelId?: string;
          reasoningId?: string;
          fastMode: boolean;
          mode?: "build" | "plan";
          executionProfileId?: string;
        },
      ) => Promise<void>
    >(async () => undefined);
    const view = renderInAppCommandScope(
      <AgentNativeTab
        tabId={tabId}
        data={{ environmentId, isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        coordinatorWorkspacePath="/tmp/project"
        onAssignPlatform={onAssignPlatform}
        availablePlatforms={["claude", "codex"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(onAssignPlatform).toHaveBeenCalledTimes(1));
    const [, prompt, options] = onAssignPlatform.mock.calls[0]!;

    view.rerender(
      <AgentNativeTab
        tabId={tabId}
        data={{ platform: "claude", environmentId, isLocal: true }}
        isActive
        executionPolicy="coordinator-read-only"
        coordinatorProjectId="project-1"
        coordinatorWorkspacePath="/tmp/project"
        initialPrompt={prompt}
        initialAgentModel={options.modelId}
        initialReasoningEffort={options.reasoningId}
        initialConversationMode={options.mode}
        initialFastMode={options.fastMode}
        initialExecutionProfileId={options.executionProfileId}
      />,
    );

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      agent: "claude",
      attachments: [{ type: "image", path: attachmentPath, filename: "layout.png" }],
    });
  });

  test("retries a failed first-prompt provider-lock save without losing the draft", async () => {
    const tabId = "tab-retry-send";
    const sessionKey = createSessionKey("env-1", tabId);
    seedUnassignedPane(tabId);
    appCommandStore(nativeComposeStore).getState().updateDraft(sessionKey, {
      text: "Keep this prompt",
      platform: "claude",
    });
    flushPaneLayoutNowMock.mockImplementationOnce(async () => {
      throw new Error("temporary save failure");
    });

    renderInAppCommandScope(<PaneBackedAgentNativeTab tabId={tabId} />);
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(
      await screen.findByText("The agent choice is locked, but could not be saved."),
    ).toBeTruthy();
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Keep this prompt",
    );
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionPending,
    ).toBe(false);
    expect(
      appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.submissionError,
    ).toBe("The agent choice could not be saved. Your message has not been sent.");
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    expect(await screen.findByTestId("shared-native-compose-bar")).toBeTruthy();
    expect(flushPaneLayoutNowMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Keep this prompt",
    });
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined();
  });

  test("keeps a first prompt durable and non-reentrant while backend dispatch is pending", async () => {
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
      await dispatchGate;
      return { outcome: "accepted", requestId: input.requestId };
    });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "20260415-123456",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
    const tabId = "tab-rename-durable";
    const sessionKey = createSessionKey("env-1", tabId);
    const view = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Keep this first prompt" } });
    const sendButton = await screen.findByTitle("Send");
    fireEvent.click(sendButton);

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(renameEnvironmentFromPromptMock).not.toHaveBeenCalled();
    const pendingDraft = appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey);
    expect(pendingDraft?.text).toBe("Keep this first prompt");
    expect(pendingDraft?.requestId).toMatch(/\S/);
    await waitFor(() => expect(screen.queryByTitle("Send") === null).toBe(true));
    expect(input.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "Keep this first prompt",
    );
    const remounted = renderInAppCommandScope(
      <AgentNativeTab tabId={tabId} data={identity("claude")} isActive />,
    );
    expect((await screen.findByRole("textbox")).textContent).toBe("Keep this first prompt");
    remounted.unmount();

    const stableRequestId = pendingDraft!.requestId;
    releaseDispatch();
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Keep this first prompt",
      requestId: stableRequestId,
    });
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)).toBeUndefined(),
    );
  });
});
