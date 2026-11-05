/**
 * The panel's outcome-first wording and its no-dead-end states: the composer
 * placeholder and starter prompts, the isolation badge, banners that leave the
 * transcript visible, separate errors, and the main-only close confirmation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import { useConfigStore } from "@/stores/configStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useProjectStore } from "@/stores/projectStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useCoordinatorPaneLayoutStore } from "@/stores/coordinatorPaneLayoutStore";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { resetUpstreamCheckForTests } from "@/lib/coordinator-upstream-check";
import { resetNativeAgentSyncCapabilityForTests } from "@/hooks/useNativeAgentSession";
import { createSessionKey } from "@/lib/utils";

const backendSnapshot = { ...realBackend };
const nativeAgentSnapshot = { ...realNativeAgent };
const initialConfig = useConfigStore.getState().config;
let useRealAgentTab = false;

const gitStatus: ProjectGitStatus = {
  projectId: "project-1",
  repositoryRoot: "/checkout",
  revision: 1,
  branch: "main",
  detached: false,
  unborn: false,
  headCommit: "a".repeat(40),
  upstream: null,
  remote: null,
  ahead: null,
  behind: null,
  remoteState: "unknown",
  fetchedAt: null,
  trackedChanges: 0,
  untrackedChanges: 0,
  conflicts: 0,
  mergeInProgress: false,
  rebaseInProgress: false,
  sequencerInProgress: false,
  operationState: "idle",
  repositoryOperationBlockedReason: null,
  branches: [{ ref: "refs/heads/main", name: "main", kind: "local" }],
  lastError: null,
};

const mainConversation: CoordinatorConversation = {
  id: "conversation-1",
  tabId: "coordinator-tab",
  logicalSessionKey: "coordinator-coordinator-1:conversation-1",
  agent: "codex",
  title: "Coordinator",
  role: "main",
  createdAt: new Date(0).toISOString(),
  mailboxIncarnationId: "incarnation-1",
};

const sideConversation: CoordinatorConversation = {
  ...mainConversation,
  id: "side-1",
  tabId: "coordinator-side-1",
  logicalSessionKey: "coordinator-coordinator-1:side-1",
  title: "Side 1",
  role: "side",
  sideOrdinal: 1,
};

const baseSnapshot: CoordinatorSnapshot = {
  workspace: {
    version: 1,
    id: "coordinator-1",
    projectId: "project-1",
    executionPolicy: "coordinator-read-only",
    lifecycleState: "ready",
    conversations: [mainConversation],
    selectedConversationId: "conversation-1",
    repositoryContextRevision: 7,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    repositoryStatus: gitStatus,
  },
  projectPath: "/checkout",
  providerAvailability: {
    codex: { tier: "enforced", available: true, delegation: true },
    claude: { tier: "enforced", available: true, delegation: true },
  },
  controlMcp: { enabled: true, running: true, error: null },
  workflows: [],
};

function withWorkspace(
  workspace: Partial<CoordinatorSnapshot["workspace"]>,
  rest: Partial<CoordinatorSnapshot> = {},
): CoordinatorSnapshot {
  return { ...baseSnapshot, ...rest, workspace: { ...baseSnapshot.workspace, ...workspace } };
}

let ensuredSnapshot = baseSnapshot;
let ensuredGit = gitStatus;
const ensure = mock(async () => ensuredSnapshot);
let viewRevision = 0;
let viewBody: CoordinatorSnapshot | null = null;
const getCoordinatorView = mock(
  async (_projectId: string, known: { generation: string; revision: number } | null) => {
    if (ensuredSnapshot !== viewBody) {
      viewBody = ensuredSnapshot;
      viewRevision += 1;
    }
    if (known && known.generation === "view-gen" && known.revision === viewRevision) {
      return { status: "unchanged", generation: "view-gen", revision: viewRevision };
    }
    return {
      status: "snapshot",
      generation: "view-gen",
      revision: viewRevision,
      snapshot: viewBody,
    };
  },
);
const getGit = mock(async () => ensuredGit);
const fetchGit = mock(async () => ensuredGit);
const pause = mock(async (): Promise<CoordinatorSnapshot> => {
  throw new Error("pause failed");
});
const resume = mock(async (): Promise<CoordinatorSnapshot> => ensuredSnapshot);
const closeConversation = mock(async (): Promise<CoordinatorSnapshot> => ensuredSnapshot);
const select = mock(async (): Promise<CoordinatorSnapshot> => ensuredSnapshot);
const assignAgent = mock(async () => ensuredSnapshot);
const dispatchIntent = mock(
  async (input: Parameters<typeof realBackend.dispatchNativeAgentIntent>[0]) => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }),
);
const environmentId = coordinatorRuntimeId("coordinator-1", "conversation-1");
const sessionKey = createSessionKey(environmentId, "coordinator-tab");

function projection(messages: unknown[] = []): NativeAgentSessionProjection {
  return {
    platform: "codex",
    environmentId,
    sessionId: "codex-session",
    connection: "connected",
    turn: { phase: "idle" },
    messages,
    interactions: [],
    composerControls: [],
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
    generation: "outcome-test",
  } as NativeAgentSessionProjection;
}
let agentProjection = projection();

const ensureSession = mock(
  async (input: Parameters<typeof realBackend.ensureNativeAgentSession>[0]) => {
    if (ensuredSnapshot.workspace.lifecycleState !== "ready")
      throw new Error("workspace not ready");
    return { ...input, providerSessionId: "codex-session" };
  },
);

mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  getLocalFileTree: mock(async () => []),
  getNativeAgentModelCatalog: mock(async () => [
    { platform: "claude", id: "claude-sonnet-5", label: "Claude Sonnet" },
  ]),
  ensureProjectCoordinator: ensure,
  getProjectCoordinator: ensure,
  getProjectCoordinatorView: getCoordinatorView,
  getProjectGitStatus: getGit,
  fetchProjectGit: fetchGit,
  checkCoordinatorUpstreamMerge: mock(async () => null),
  declineCoordinatorUpstreamMerge: mock(async () => undefined),
  getCoordinatorUpstreamAutoMerge: mock(async () => ({ enabled: false })),
  setCoordinatorUpstreamAutoMerge: mock(async () => ({ enabled: false })),
  pauseProjectCoordinator: pause,
  resumeProjectCoordinator: resume,
  selectCoordinatorConversation: select,
  closeCoordinatorConversation: closeConversation,
  assignCoordinatorConversationAgent: assignAgent,
  getNativeAgentSyncCapabilities: async () => ({ projectionSyncVersions: [] }),
  ensureNativeAgentSession: ensureSession,
  getNativeAgentProjection: mock(async () => agentProjection),
  dispatchNativeAgentIntent: dispatchIntent,
}));

mock.module("@/components/native-agent", () => ({
  ...nativeAgentSnapshot,
  AgentNativeTab: (props: Parameters<typeof realNativeAgent.AgentNativeTab>[0]) =>
    useRealAgentTab ? (
      <nativeAgentSnapshot.AgentNativeTab {...props} />
    ) : (
      <div
        data-testid="native-agent"
        data-tab-id={props.tabId}
        data-placeholder={props.composerPlaceholder ?? ""}
        data-starter-prompts={(props.unassignedStarterPrompts ?? []).join("|")}
      />
    ),
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import { COORDINATOR_STARTER_PROMPTS } from "./CoordinatorPanelNotices";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

const unassigned = (conversation: CoordinatorConversation) => ({
  ...conversation,
  agent: undefined,
});

describe("CoordinatorPanel outcome-first wording and banners", () => {
  beforeEach(() => {
    useRealAgentTab = false;
    resetNativeAgentSyncCapabilityForTests();
    useConfigStore.setState({ config: initialConfig });
    useNativeComposeStore.getState().clearDraft(sessionKey);
    useNativeAgentProjectionStore.getState().reset();
    useCoordinatorPaneLayoutStore.getState().reset();
    resetUpstreamCheckForTests();
    resetClientStateCapabilitiesForTests();
    for (const fn of [ensure, getCoordinatorView, getGit, fetchGit, select, assignAgent]) {
      fn.mockClear();
    }
    pause.mockClear();
    resume.mockClear();
    closeConversation.mockClear();
    dispatchIntent.mockClear();
    ensureSession.mockClear();
    viewBody = null;
    ensuredSnapshot = baseSnapshot;
    ensuredGit = gitStatus;
    agentProjection = projection();
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Project",
          gitUrl: "https://example.invalid/repo.git",
          localPath: "/checkout",
          addedAt: new Date(0).toISOString(),
          order: 0,
        },
      ],
    });
  });
  afterEach(() => {
    cleanup();
    resetReadCoordinatorForTests();
  });
  afterAll(() => {
    mock.module("@/lib/backend", () => backendSnapshot);
    mock.module("@/components/native-agent", () => nativeAgentSnapshot);
  });

  test("passes the outcome-first placeholder and starter prompts only to the main conversation", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    render(<CoordinatorPanel projectId="project-1" />);
    const main = await screen.findByTestId("native-agent");
    expect(main.getAttribute("data-placeholder")).toBe("What would you like to get done?");
    expect(main.getAttribute("data-starter-prompts")).toBe(COORDINATOR_STARTER_PROMPTS.join("|"));

    fireEvent.click(screen.getByRole("tab", { name: "Side 1, Codex" }));
    await waitFor(() =>
      expect(screen.getByTestId("native-agent").getAttribute("data-tab-id")).toBe(
        "coordinator-side-1",
      ),
    );
    const side = screen.getByTestId("native-agent");
    expect(side.getAttribute("data-placeholder")).toBe("What would you like to get done?");
    expect(side.getAttribute("data-starter-prompts")).toBe("");
  });

  test("an empty conversation's starter prompt fills the real message box without sending", async () => {
    useRealAgentTab = true;
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude"],
      agentSettings: { defaultAgent: "claude" },
    });
    ensuredSnapshot = withWorkspace({ conversations: [unassigned(mainConversation)] });
    render(<CoordinatorPanel projectId="project-1" />);

    const input = await screen.findByRole("textbox", { name: "What would you like to get done?" });
    const starters = screen.getByRole("group", { name: "Starter prompts" });
    const offered = within(starters)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(offered).toEqual([
      "Build this feature and check it against these criteria: …",
      "Investigate this bug, reproduce it and fix it: …",
      "Review this branch and tell me what needs attention",
      "Take ticket … through build and review",
    ]);

    fireEvent.click(
      within(starters).getByRole("button", {
        name: "Review this branch and tell me what needs attention",
      }),
    );
    await waitFor(() =>
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.text).toBe(
        "Review this branch and tell me what needs attention",
      ),
    );
    await waitFor(() =>
      expect(input.textContent).toBe("Review this branch and tell me what needs attention"),
    );
    // A filled box hides them, so another click cannot replace the edit.
    expect(screen.queryByRole("group", { name: "Starter prompts" }) === null).toBe(true);

    // Still editable, and nothing was sent.
    fireEvent.input(input, { target: { textContent: "Review this branch for security issues" } });
    await waitFor(() =>
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.text).toBe(
        "Review this branch for security issues",
      ),
    );
    fireEvent.input(input, { target: { textContent: " \n\t" } });
    await screen.findByRole("group", { name: "Starter prompts" });
    expect(assignAgent).not.toHaveBeenCalled();
    expect(dispatchIntent).not.toHaveBeenCalled();
  });

  test("a conversation with messages shows no starter prompts", async () => {
    useRealAgentTab = true;
    agentProjection = projection([
      {
        id: "message-1",
        role: "user",
        content: "Earlier request",
        parts: [{ type: "text", content: "Earlier request" }],
        createdAt: new Date(0).toISOString(),
      },
    ]);
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("textbox");
    await waitFor(() =>
      expect(
        useNativeAgentProjectionStore.getState().projections.get(sessionKey)?.messages.length,
      ).toBe(1),
    );
    expect(screen.queryByRole("group", { name: "Starter prompts" }) === null).toBe(true);
    for (const starter of COORDINATOR_STARTER_PROMPTS) {
      expect(screen.queryByRole("button", { name: starter }) === null).toBe(true);
    }
  });

  test("the badge states isolation and keeps the path and revision in keyboard-reachable hover text", async () => {
    render(<CoordinatorPanel projectId="project-1" />);
    const badge = await screen.findByRole("button", {
      name: /Changes run in isolated environments/,
    });
    expect(badge.getAttribute("data-coordinator-isolation-badge")).toBe("enforced");
    expect(badge.className).toContain("emerald");
    expect(badge.textContent).not.toContain("advisory");
    expect(screen.queryByText("Read-only coordinator") === null).toBe(true);
    // Neither the path nor the revision is header text any more.
    expect(screen.queryByText("/checkout") === null).toBe(true);
    expect(screen.queryByText(/Context r7/) === null).toBe(true);

    act(() => badge.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("reads this checkout but never changes it");
    expect(tooltip.textContent).toContain("build pipelines or prompt environments");
    expect(tooltip.textContent).toContain("/checkout");
    expect(tooltip.textContent).toContain("r7");
    expect(tooltip.textContent).not.toContain("advisory");
  });

  test("a provider whose read-only protection is not enforced gets an amber advisory badge", async () => {
    ensuredSnapshot = withWorkspace(
      {},
      {
        providerAvailability: {
          codex: {
            tier: "provider-configured",
            available: true,
            reason: "Codex is told to deny writes.",
            delegation: true,
          },
        },
      },
    );
    render(<CoordinatorPanel projectId="project-1" />);
    const badge = await screen.findByRole("button", {
      name: /Changes run in isolated environments/,
    });
    await waitFor(() =>
      expect(badge.getAttribute("data-coordinator-isolation-badge")).toBe("advisory"),
    );
    expect(badge.textContent).toContain("Read-only protection is advisory");
    expect(badge.className).toContain("amber");
    expect(screen.queryByText(/never changes it/) === null).toBe(true);

    act(() => badge.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Codex is told not to change the checkout");
    expect(tooltip.textContent).toContain("this protection is advisory");
  });

  test("paused coordination keeps the transcript and resumes from the banner", async () => {
    ensuredSnapshot = withWorkspace({ lifecycleState: "paused" });
    resume.mockImplementationOnce(async () => withWorkspace({ lifecycleState: "ready" }));
    render(<CoordinatorPanel projectId="project-1" />);

    const banner = await screen.findByText(/Coordination is paused/);
    expect(banner.textContent).toContain("Messages will wait");
    expect(screen.getByTestId("native-agent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("project-1"));
    await waitFor(() => expect(screen.queryByText(/Coordination is paused/) === null).toBe(true));
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByTestId("native-agent")).toBeTruthy();
  });

  test("a startup failure keeps the transcript under an error banner whose Retry reloads", async () => {
    ensuredSnapshot = withWorkspace({ lifecycleState: "error", lastStartupError: "bridge failed" });
    render(<CoordinatorPanel projectId="project-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Coordinator startup failed");
    expect(alert.textContent).toContain("bridge failed");
    expect(screen.getByTestId("native-agent")).toBeTruthy();
    // The banner sits above the conversation, not in place of it.
    expect(
      alert.compareDocumentPosition(screen.getByTestId("native-agent")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const calls = ensure.mock.calls.length;
    ensuredSnapshot = withWorkspace({ lifecycleState: "ready" });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(ensure.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() =>
      expect(screen.queryByText(/Coordinator startup failed/) === null).toBe(true),
    );
    expect(screen.getByTestId("native-agent")).toBeTruthy();
  });

  test.each(["error", "paused"] as const)(
    "a real assigned controller recovers from %s without a second Retry",
    async (lifecycleState) => {
      useRealAgentTab = true;
      ensuredSnapshot = withWorkspace({ lifecycleState });
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByText(
        lifecycleState === "error" ? "Coordinator startup failed." : /Coordination is paused/,
      );
      // A blocked workspace must not attempt initial session creation. Its
      // composer and draft stay mounted until readiness enables connection.
      expect(ensureSession).not.toHaveBeenCalled();
      const calls = ensureSession.mock.calls.length;
      ensuredSnapshot = withWorkspace({ lifecycleState: "ready" });
      const recoveryScope =
        lifecycleState === "error"
          ? within(
              screen
                .getByText("Coordinator startup failed.")
                .closest('[role="alert"]') as HTMLElement,
            )
          : screen;
      fireEvent.click(
        recoveryScope.getByRole("button", {
          name: lifecycleState === "error" ? "Retry" : "Resume",
        }),
      );
      await waitFor(() => expect(ensureSession.mock.calls.length).toBeGreaterThan(calls));
      await waitFor(() =>
        expect(
          useNativeAgentProjectionStore.getState().projections.get(sessionKey)?.connection,
        ).toBe("connected"),
      );
      const input = await screen.findByRole("textbox");
      expect(input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder")).toBe(
        "What would you like to get done?",
      );
      fireEvent.input(input, { target: { textContent: "Review this branch" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(dispatchIntent).toHaveBeenCalled());
      expect(input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder")).toBe(
        "What would you like to get done?",
      );
    },
  );

  test("identical repository and coordinator errors appear once", async () => {
    ensuredGit = {
      ...gitStatus,
      lastError: {
        operation: "fetch",
        message: "pause failed",
        stderr: "pause failed",
        occurredAt: new Date(0).toISOString(),
        retryable: true,
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByText("Repository error");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getAllByText("pause failed")).toHaveLength(1);
    expect(screen.queryByText("Coordinator error") === null).toBe(true);
  });

  test("an unavailable provider keeps the transcript under a banner", async () => {
    ensuredSnapshot = withWorkspace(
      {},
      {
        providerAvailability: {
          codex: { tier: "enforced", available: false, reason: "Sign in first", delegation: true },
        },
      },
    );
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("Sign in first")).toBeTruthy();
    expect(screen.getByText(/Codex is unavailable for Coordinator/)).toBeTruthy();
    expect(screen.getByTestId("native-agent")).toBeTruthy();
  });

  test("a repository error and a coordinator error are both shown", async () => {
    ensuredGit = {
      ...gitStatus,
      lastError: {
        operation: "fetch",
        message: "fetch failed",
        stderr: "fatal: could not read from remote",
        occurredAt: new Date(0).toISOString(),
        retryable: true,
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("fatal: could not read from remote")).toBeTruthy();
    expect(screen.getByText("Repository error")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByText("pause failed")).toBeTruthy();
    expect(screen.getByText("Coordinator error")).toBeTruthy();
    expect(screen.getByText("fatal: could not read from remote")).toBeTruthy();
    expect(screen.getByText("Repository error")).toBeTruthy();
  });

  test("closing the main conversation asks first; cancelling keeps it open", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");

    fireEvent.click(screen.getByRole("button", { name: /^Close Coordinator\./ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Close the main conversation?");
    expect(dialog.textContent).toContain(
      "The next message to the coordinator starts a new main conversation",
    );
    expect(closeConversation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep open" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(closeConversation).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Coordinator, main, Codex" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Close Coordinator\./ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Close conversation",
      }),
    );
    await waitFor(() =>
      expect(closeConversation).toHaveBeenCalledWith("project-1", "conversation-1"),
    );
  });

  test("closing a side conversation does not ask", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");

    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));
    await waitFor(() => expect(closeConversation).toHaveBeenCalledWith("project-1", "side-1"));
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
  });
});
