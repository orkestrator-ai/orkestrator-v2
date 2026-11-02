import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
  type ProjectGitSwitchConfirmation,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import type { AgentMailMailboxSnapshot } from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useProjectStore } from "@/stores/projectStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeNoticeDismissalStore } from "@/stores/nativeNoticeDismissalStore";
import {
  selectCoordinatorPaneLayout,
  useCoordinatorPaneLayoutStore,
} from "@/stores/coordinatorPaneLayoutStore";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import {
  LEGACY_UPSTREAM_DECLINE_KEY,
  resetUpstreamCheckForTests,
} from "@/lib/coordinator-upstream-check";
import { clearLegacyPersistedState, readLegacyPersistedState } from "@/lib/legacy-local-state";
import {
  collectCoordinatorLeaves,
  focusedCoordinatorConversationId,
  moveCoordinatorConversation,
  reconcileCoordinatorLayout,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { resetNativeAgentSyncCapabilityForTests } from "@/hooks/useNativeAgentSession";
import * as paneTree from "./CoordinatorPaneTree";
import { createSessionKey } from "@/lib/utils";

const backendSnapshot = { ...realBackend };
const nativeAgentSnapshot = { ...realNativeAgent };
let useRealAgentTab = false;
const initialConfig = useConfigStore.getState().config;
const pause = mock(async (): Promise<CoordinatorSnapshot> => {
  throw new Error("pause failed");
});
const select = mock(async (): Promise<CoordinatorSnapshot> => {
  throw new Error("select failed");
});
const resume = mock(async (): Promise<CoordinatorSnapshot> => {
  throw new Error("resume failed");
});
const createConversation = mock(async (): Promise<CoordinatorSnapshot> => {
  throw new Error("create failed");
});
const closeConversation = mock(async (): Promise<CoordinatorSnapshot> => {
  throw new Error("close failed");
});
let ensuredSnapshot: CoordinatorSnapshot;
let ensuredGit: ProjectGitStatus;
let ensureFailure: Error | null = null;

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

const snapshot: CoordinatorSnapshot = {
  workspace: {
    version: 1,
    id: "coordinator-1",
    projectId: "project-1",
    executionPolicy: "coordinator-read-only",
    lifecycleState: "ready",
    conversations: [
      {
        id: "conversation-1",
        tabId: "coordinator-tab",
        logicalSessionKey: "coordinator-coordinator-1:conversation-1",
        agent: "codex",
        title: "First",
        createdAt: new Date(0).toISOString(),
        mailboxIncarnationId: "incarnation-1",
      },
    ],
    selectedConversationId: "conversation-1",
    repositoryContextRevision: 0,
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
ensuredSnapshot = snapshot;
ensuredGit = gitStatus;
const ensure = mock(async () => {
  if (ensureFailure) throw ensureFailure;
  return ensuredSnapshot;
});
const getGit = mock(async () => ensuredGit);
const switchBranch = mock(async () => ensuredGit);
const preparedSwitch: ProjectGitSwitchConfirmation = {
  token: "confirm-token",
  projectId: "project-1",
  ref: "refs/heads/feature",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  trackedChanges: 1,
  untrackedFiles: 5,
  nestedRepositories: [],
  dirtySubmodules: [],
  requiresEnhancedConfirmation: false,
};
let nextPreparedSwitch: ProjectGitSwitchConfirmation = preparedSwitch;
const prepareSwitch = mock(async (_projectId: string, ref: string) => ({
  ...nextPreparedSwitch,
  ref,
}));
const syncGit = mock(async () => ensuredGit);
const fetchGit = mock(async () => ensuredGit);
const getCoordinator = mock(async () => ensuredSnapshot);
/** Conditional view reads: a stand-in owner that stamps by body identity. */
let viewRevision = 0;
let viewBody: CoordinatorSnapshot | null = null;
const getCoordinatorView = mock(
  async (
    _projectId: string,
    known: { generation: string; revision: number } | null,
  ): Promise<unknown> => {
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
const assignAgent = mock(async () => ensuredSnapshot);

const firstUpstreamTip = "b".repeat(40);
const checkUpstream = mock(async (): Promise<unknown> => null);
const declineUpstream = mock(async (): Promise<unknown> => undefined);

function storedDecline(): unknown {
  const declines = readLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY)?.declines;
  return Array.isArray(declines)
    ? declines.find((entry) => entry.projectId === "project-1")
    : undefined;
}

function storedLayout() {
  return selectCoordinatorPaneLayout("project-1")(useCoordinatorPaneLayoutStore.getState())!;
}
const runCommand = mock(async () => undefined);
const launchEnvironmentId = coordinatorRuntimeId("coordinator-1", "conversation-1");
const launchSessionKey = createSessionKey(launchEnvironmentId, "coordinator-tab");
const openingPrompt = "Inspect the repository";
function launchProjection(
  phase: NativeAgentSessionProjection["turn"]["phase"],
  messages: unknown[] = [],
  revision = 1,
): NativeAgentSessionProjection {
  return {
    platform: "claude",
    environmentId: launchEnvironmentId,
    sessionId: "claude-session",
    connection: phase === "recovering" ? "connecting" : "connected",
    turn: { phase },
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
    revision,
    generation: "launch-test",
  };
}
const getAgentProjection = mock(async (): Promise<NativeAgentSessionProjection> =>
  launchProjection("idle"),
);
const dispatchIntent = mock(
  async (input: Parameters<typeof realBackend.dispatchNativeAgentIntent>[0]) => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }),
);

function prepareUnassignedLaunch() {
  const conversation = { ...snapshot.workspace.conversations[0]!, agent: undefined };
  ensuredSnapshot = {
    ...snapshot,
    workspace: { ...snapshot.workspace, conversations: [conversation] },
  };
  const assignedSnapshot: CoordinatorSnapshot = {
    ...snapshot,
    workspace: {
      ...snapshot.workspace,
      conversations: [{ ...conversation, agent: "claude" }],
    },
  };
  assignAgent.mockImplementation(async () => assignedSnapshot);
  return assignedSnapshot;
}

async function refreshCoordinator(assignedSnapshot: CoordinatorSnapshot, revision: number) {
  const reads = getCoordinatorView.mock.calls.length;
  await act(async () => {
    ensuredSnapshot = {
      ...assignedSnapshot,
      workspace: {
        ...assignedSnapshot.workspace,
        conversations: assignedSnapshot.workspace.conversations.map((conversation) => ({
          ...conversation,
          title: `Refreshed ${revision}`,
        })),
      },
    };
    dispatchResourceChange({
      resource: "coordinator",
      id: "project-1",
      projectId: "project-1",
      revision,
    });
  });
  await waitFor(() => expect(getCoordinatorView.mock.calls.length).toBeGreaterThan(reads));
  await screen.findByRole("button", { name: `Refreshed ${revision}, Claude Code` });
}

mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  getLocalFileTree: mock(async () => []),
  getNativeAgentModelCatalog: mock(async () => [
    { platform: "claude", id: "claude-sonnet-5", label: "Claude Sonnet" },
  ]),
  ensureProjectCoordinator: ensure,
  getProjectCoordinator: getCoordinator,
  getProjectCoordinatorView: getCoordinatorView,
  getProjectGitStatus: getGit,
  fetchProjectGit: fetchGit,
  checkCoordinatorUpstreamMerge: checkUpstream,
  declineCoordinatorUpstreamMerge: declineUpstream,
  switchProjectGitBranch: switchBranch,
  prepareProjectGitBranchSwitch: prepareSwitch,
  syncProjectGit: syncGit,
  pauseProjectCoordinator: pause,
  resumeProjectCoordinator: resume,
  selectCoordinatorConversation: select,
  createCoordinatorConversation: createConversation,
  closeCoordinatorConversation: closeConversation,
  assignCoordinatorConversationAgent: assignAgent,
  getNativeAgentSyncCapabilities: async () => ({ projectionSyncVersions: [] }),
  ensureNativeAgentSession: async (
    input: Parameters<typeof realBackend.ensureNativeAgentSession>[0],
  ) => ({
    ...input,
    providerSessionId: "claude-session",
  }),
  getNativeAgentProjection: getAgentProjection,
  dismissNativeAgentSuggestedPrompt: async () => ({
    ...(await getAgentProjection()),
    suggestedPrompt: undefined,
    revision: 51,
  }),
  dispatchNativeAgentIntent: dispatchIntent,
  runUserCommand: runCommand,
}));

const renderAgentNativeTab = mock((props: Record<string, unknown>) => (
  <div
    data-testid="native-agent"
    data-tab-id={String(props.tabId ?? "")}
    data-owns-shortcuts={String(props.ownsGlobalShortcuts ?? "")}
    data-coordinator-project-id={String(props.coordinatorProjectId ?? "")}
    data-platform={String((props.data as { platform?: string } | undefined)?.platform ?? "")}
    data-available-platforms={(props.availablePlatforms as string[] | undefined)?.join(",") ?? ""}
    data-initial-prompt={String(props.initialPrompt ?? "")}
    data-initial-model={String(props.initialAgentModel ?? "")}
    data-platform-notes={JSON.stringify(props.platformNotes ?? {})}
  >
    {props.onAssignPlatform ? (
      <button
        type="button"
        onClick={() => {
          // The real tab awaits this and renders a failure itself, so the stub
          // has to absorb the rejection the same way rather than turning a
          // reported error into an unhandled one.
          void (
            props.onAssignPlatform as (
              platform: string,
              prompt: string,
              options: Record<string, unknown>,
            ) => Promise<void>
          )("claude", "Inspect the repository", { modelId: "opus", fastMode: false }).catch(
            () => undefined,
          );
        }}
      >
        Assign claude
      </button>
    ) : null}
  </div>
));

mock.module("@/components/native-agent", () => ({
  ...nativeAgentSnapshot,
  AgentNativeTab: (props: Parameters<typeof realNativeAgent.AgentNativeTab>[0]) =>
    useRealAgentTab ? (
      <nativeAgentSnapshot.AgentNativeTab {...props} />
    ) : (
      renderAgentNativeTab(props as unknown as Record<string, unknown>)
    ),
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import { COORDINATOR_FOCUS_PROBE_MIN_INTERVAL_MS } from "./useCoordinatorPanelData";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { useUIStore } from "@/stores";

describe("CoordinatorPanel", () => {
  beforeEach(() => {
    useRealAgentTab = false;
    resetNativeAgentSyncCapabilityForTests();
    getAgentProjection.mockReset();
    getAgentProjection.mockImplementation(async () => launchProjection("idle"));
    dispatchIntent.mockReset();
    dispatchIntent.mockImplementation(async (input) => ({
      outcome: "accepted" as const,
      requestId: input.requestId,
    }));
    useConfigStore.setState({ config: initialConfig });
    useNativeComposeStore
      .getState()
      .clearDraft(createSessionKey("coordinator:coordinator-1:conversation-1", "coordinator-tab"));
    pause.mockClear();
    select.mockClear();
    resume.mockClear();
    createConversation.mockClear();
    closeConversation.mockClear();
    ensure.mockClear();
    getGit.mockClear();
    switchBranch.mockClear();
    prepareSwitch.mockClear();
    nextPreparedSwitch = preparedSwitch;
    syncGit.mockReset();
    syncGit.mockImplementation(async () => ensuredGit);
    fetchGit.mockReset();
    fetchGit.mockImplementation(async () => ensuredGit);
    getCoordinator.mockClear();
    getCoordinatorView.mockClear();
    viewBody = null;
    assignAgent.mockClear();
    renderAgentNativeTab.mockClear();
    ensuredSnapshot = snapshot;
    ensuredGit = gitStatus;
    ensureFailure = null;
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
    useUIStore.setState({ projectBoardTab: "coordinator" });
    useNativeAgentProjectionStore.getState().reset();
    useNativeNoticeDismissalStore.getState().clear();
    useCoordinatorPaneLayoutStore.getState().reset();
    clearLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY);
    resetUpstreamCheckForTests();
    resetClientStateCapabilitiesForTests();
    checkUpstream.mockReset();
    declineUpstream.mockReset();
    runCommand.mockClear();
  });

  test("forwards the project id to the coordinator native-agent tab", async () => {
    render(<CoordinatorPanel projectId="project-1" />);

    const agent = await screen.findByTestId("native-agent");
    expect(agent.closest("[data-agent-scope]")?.id).toBe("project-panel-coordinator");
    expect(agent.getAttribute("data-coordinator-project-id")).toBe("project-1");
    expect(renderAgentNativeTab.mock.calls.at(-1)?.[0]).toMatchObject({
      coordinatorProjectId: "project-1",
    });
  });

  test.each([true, false])(
    "shows stored mail guidance with platform availability %s",
    async (available) => {
      const conversation = { ...snapshot.workspace.conversations[0]!, agent: undefined };
      ensuredSnapshot = {
        ...snapshot,
        workspace: { ...snapshot.workspace, conversations: [conversation] },
        ...(!available ? { providerAvailability: {} } : {}),
      };
      const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
      const mailboxId = `${environmentId}\0${conversation.tabId}`;
      useAgentMailStore.setState({
        summary: new Map([
          [
            mailboxId,
            {
              mailboxId,
              projectId: "project-1",
              environmentId,
              tabId: conversation.tabId,
              unreadCount: 2,
              userUnseenCount: 2,
              agentUnackedCount: 2,
              pendingInjectCount: 0,
              failedInjectCount: 0,
              revision: 1,
            },
          ],
        ]),
        mailboxes: new Map([
          [
            mailboxId,
            {
              descriptor: {
                capabilities: { canPull: false, canSend: false, canInject: false },
                injectPolicy: "off",
                presence: "unknown",
              },
              messages: ["first", "second"].map((id) => ({
                id,
                placement: "stored",
                placementReason: "recipient-cannot-inject",
              })),
            } as unknown as AgentMailMailboxSnapshot,
          ],
        ]),
        refreshSummary: async () => undefined,
        refreshMailbox: async () => undefined,
      });
      try {
        render(<CoordinatorPanel projectId="project-1" />);
        expect(
          await screen.findByText(
            available
              ? "2 messages in inbox · waiting for an agent"
              : "2 messages in inbox · enable a qualified agent in Settings",
          ),
        ).toBeTruthy();
      } finally {
        useAgentMailStore.setState(useAgentMailStore.getInitialState());
      }
    },
  );

  test("an unassigned conversation offers every qualified platform and binds on first send", async () => {
    const unassignedConversation = {
      ...snapshot.workspace.conversations[0]!,
      agent: undefined,
    };
    ensuredSnapshot = {
      ...snapshot,
      workspace: { ...snapshot.workspace, conversations: [unassignedConversation] },
    };
    const assignedSnapshot: CoordinatorSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [{ ...unassignedConversation, agent: "claude" }],
      },
    };
    assignAgent.mockImplementation(async () => assignedSnapshot);

    render(<CoordinatorPanel projectId="project-1" />);
    const agent = await screen.findByTestId("native-agent");
    // The composer, not a locked provider: this is the state the user reported
    // as "locked to codex".
    expect(agent.getAttribute("data-platform")).toBe("");
    expect(agent.getAttribute("data-available-platforms")).toBe("claude,codex");
    const unassignedTab = screen.getByRole("button", { name: "First, no agent chosen yet" });
    expect(unassignedTab.querySelector("svg.text-muted-foreground")).toBeTruthy();
    expect(screen.getByText("Choose agent")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    await waitFor(() =>
      expect(assignAgent).toHaveBeenCalledWith("project-1", "conversation-1", "claude"),
    );
    const assigned = await screen.findByTestId("native-agent");
    await waitFor(() => expect(assigned.getAttribute("data-platform")).toBe("claude"));
    // The first prompt and its model reach the newly bound tab rather than
    // being discarded with the composer.
    expect(assigned.getAttribute("data-initial-prompt")).toBe("Inspect the repository");
    expect(assigned.getAttribute("data-initial-model")).toBe("opus");
  });

  test.each([
    { phase: "running", messages: [] },
    { phase: "blocked", messages: [] },
    { phase: "cancelling", messages: [] },
    {
      phase: "idle",
      messages: [{ id: "opening-user-message", role: "user", text: openingPrompt }],
    },
    {
      phase: "error",
      messages: [{ id: "opening-user-message", role: "user", text: openingPrompt }],
    },
  ] satisfies { phase: NativeAgentSessionProjection["turn"]["phase"]; messages: unknown[] }[])(
    "retains the opening prompt through empty error and recovery, then releases on %p",
    async ({ phase, messages }) => {
      const assignedSnapshot = prepareUnassignedLaunch();
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
      await waitFor(() =>
        expect(screen.getByTestId("native-agent").getAttribute("data-platform")).toBe("claude"),
      );
      const expectPrompt = (prompt: string) =>
        expect(screen.getByTestId("native-agent").getAttribute("data-initial-prompt")).toBe(prompt);
      expectPrompt(openingPrompt);

      // Prove a resource-driven read actually reached the rendered panel.
      await refreshCoordinator(assignedSnapshot, 2);
      expectPrompt(openingPrompt);

      let revision = 0;
      for (const placeholder of ["idle", "recovering", "error", "recovering"] as const) {
        act(() => {
          useNativeAgentProjectionStore
            .getState()
            .setProjection(launchSessionKey, launchProjection(placeholder, [], ++revision));
        });
        expectPrompt(openingPrompt);
      }
      await refreshCoordinator(assignedSnapshot, 3);
      expectPrompt(openingPrompt);

      act(() => {
        useNativeAgentProjectionStore
          .getState()
          .setProjection(launchSessionKey, launchProjection(phase, messages, ++revision));
      });
      await waitFor(() => expectPrompt(""));
      // Releasing is permanent even when the next snapshot is quiet again.
      act(() => {
        useNativeAgentProjectionStore
          .getState()
          .setProjection(launchSessionKey, launchProjection("idle", [], ++revision));
      });
      await refreshCoordinator(assignedSnapshot, 4);
      expectPrompt("");
    },
  );

  test("the real tab dispatches the opening prompt once after a delayed authoritative read", async () => {
    useRealAgentTab = true;
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude"],
      agentSettings: { defaultAgent: "claude" },
    });
    const assignedSnapshot = prepareUnassignedLaunch();
    let resolveRead!: (projection: NativeAgentSessionProjection) => void;
    const pendingRead = new Promise<NativeAgentSessionProjection>((resolve) => {
      resolveRead = resolve;
    });
    getAgentProjection.mockImplementationOnce(() => pendingRead);
    const panel = render(<CoordinatorPanel projectId="project-1" />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: openingPrompt } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getAgentProjection).toHaveBeenCalledTimes(1));
    expect(dispatchIntent).not.toHaveBeenCalled();

    await refreshCoordinator(assignedSnapshot, 2);
    panel.rerender(<CoordinatorPanel projectId="project-1" />);
    await refreshCoordinator(assignedSnapshot, 3);
    expect(dispatchIntent).not.toHaveBeenCalled();

    await act(async () => resolveRead(launchProjection("idle")));
    await waitFor(() => expect(dispatchIntent).toHaveBeenCalledTimes(1));
    expect(dispatchIntent.mock.calls[0]?.[0]).toMatchObject({
      agent: "claude",
      environmentId: launchEnvironmentId,
      logicalSessionKey: launchSessionKey,
      prompt: openingPrompt,
      requestId: `initial-prompt:${launchEnvironmentId}:coordinator-tab`,
    });

    // Exercise rerenders both while the parent still holds the prompt and
    // after the authoritative turn releases it.
    await refreshCoordinator(assignedSnapshot, 4);
    panel.rerender(<CoordinatorPanel projectId="project-1" />);
    act(() => {
      useNativeAgentProjectionStore
        .getState()
        .setProjection(launchSessionKey, launchProjection("running", [], 2));
    });
    await refreshCoordinator(assignedSnapshot, 5);
    expect(dispatchIntent).toHaveBeenCalledTimes(1);
  });

  test("a caveat on an available platform reaches the picker, an unavailable one does not", async () => {
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [{ ...snapshot.workspace.conversations[0]!, agent: undefined }],
      },
      providerAvailability: {
        codex: { tier: "enforced", available: true, delegation: true },
        pi: {
          tier: "enforced",
          available: true,
          reason: "Pi has no MCP client.",
          delegation: false,
        },
        cursor: {
          tier: "provider-configured",
          available: true,
          reason: "Cursor applies the restriction.",
          delegation: true,
        },
        grok: {
          tier: "advisory",
          available: false,
          reason: "Grok is only asked to comply.",
          delegation: true,
        },
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    const agent = await screen.findByTestId("native-agent");
    const notes = JSON.parse(agent.getAttribute("data-platform-notes") ?? "{}");
    expect(notes.pi).toBe("Pi has no MCP client.");
    // A weaker tier says so explicitly; an enforced one does not need the
    // disclaimer and must not carry it.
    expect(notes.cursor).toContain("cannot verify this boundary independently");
    expect(notes.codex).toBeUndefined();
    expect(notes.grok).toBeUndefined();
  });

  test("explains an assigned conversation whose platform became unavailable", async () => {
    ensuredSnapshot = {
      ...snapshot,
      providerAvailability: {
        codex: {
          tier: "enforced",
          available: false,
          reason: "Codex is turned off in settings.",
          delegation: true,
        },
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("Codex is turned off in settings.")).toBeTruthy();
    expect(screen.getByText(/Codex is unavailable for Coordinator/)).toBeTruthy();
  });

  const behindGit = (overrides: Partial<ProjectGitStatus> = {}): ProjectGitStatus => ({
    ...gitStatus,
    upstream: "origin/main",
    upstreamCommit: firstUpstreamTip,
    remote: "origin",
    ahead: 0,
    behind: 3,
    remoteState: "fresh",
    fetchedAt: new Date(0).toISOString(),
    ...overrides,
  });
  const mergeDialog = () => screen.queryByRole("alertdialog");
  // Fetches after the panel's own fetch-on-open, which lands after first render.
  const fetchesAfterOpen = async () => {
    await waitFor(() => expect(fetchGit).toHaveBeenCalled());
    return fetchGit.mock.calls.length;
  };
  const pressEscape = () => fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

  test("asks before the first prompt and merges by default before starting", async () => {
    prepareUnassignedLaunch();
    ensuredGit = behindGit();
    const order: string[] = [];
    syncGit.mockImplementation(async () => {
      order.push("sync");
      return behindGit({ behind: 0, headCommit: firstUpstreamTip });
    });
    assignAgent.mockImplementation(async () => {
      order.push("assign");
      return ensuredSnapshot;
    });

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    expect(await screen.findByText("Merge 3 upstream commits?")).toBeTruthy();
    expect(
      screen.getByText(
        /There are 3 upstream commits on origin\/main that haven’t been merged into main\. Do you wish to merge them\?/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" }) === null).toBe(true);
    // Enter activates the focused default action: merging.
    const merge = screen.getByRole("button", { name: "Merge and send" });
    await waitFor(() => expect(document.activeElement).toBe(merge));
    expect(order).toEqual([]);
    fireEvent.click(merge);
    await waitFor(() => expect(order).toEqual(["sync", "assign"]));
    expect(mergeDialog() === null).toBe(true);
  });

  test("Escape starts without merging and the first prompt's decline is remembered", async () => {
    prepareUnassignedLaunch();
    ensuredGit = behindGit({ behind: 1 });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    expect(await screen.findByText("Merge 1 upstream commit?")).toBeTruthy();
    expect(screen.getByText(/There is 1 upstream commit on origin\/main that hasn’t/)).toBeTruthy();
    pressEscape();
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    expect(syncGit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(storedDecline()).toMatchObject({
        upstream: "origin/main",
        upstreamCommit: firstUpstreamTip,
      }),
    );
  });

  describe("against a backend that decides the merge question", () => {
    beforeEach(() => {
      resetClientStateCapabilitiesForTests({
        coordinatorPaneLayouts: false,
        coordinatorUpstreamMerge: true,
        noticeDismissals: false,
        environmentAttention: false,
      });
    });

    test("shows the question only when the backend says to, and records the decline there", async () => {
      prepareUnassignedLaunch();
      const status = behindGit({ behind: 2 });
      checkUpstream.mockImplementation(async () => ({ offer: true, status }));
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      fetchGit.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
      expect(await screen.findByText("Merge 2 upstream commits?")).toBeTruthy();
      expect(fetchGit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Don\u2019t merge" }));
      await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(declineUpstream).toHaveBeenCalledWith("project-1", {
          upstream: "origin/main",
          upstreamCommit: firstUpstreamTip,
        }),
      );
      expect(storedDecline()).toBeUndefined();
    });

    test("sends without asking when the backend declines to offer", async () => {
      prepareUnassignedLaunch();
      checkUpstream.mockImplementation(async () => ({
        offer: false,
        reason: "turn-running",
        status: null,
      }));
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
      await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
      expect(mergeDialog() === null).toBe(true);
      expect(checkUpstream).toHaveBeenCalledWith("project-1");
    });
  });

  test("Don't merge is the same answer as Escape", async () => {
    prepareUnassignedLaunch();
    ensuredGit = behindGit();
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don’t merge" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    expect(syncGit).not.toHaveBeenCalled();
  });

  test.each([
    { label: "up to date", status: { behind: 0 } },
    { label: "without an upstream", status: { upstream: null, behind: null, ahead: null } },
    { label: "diverged", status: { ahead: 2, behind: 1 } },
    { label: "with tracked changes", status: { trackedChanges: 1 } },
    { label: "with untracked files", status: { untrackedChanges: 1 } },
    {
      label: "mid-merge",
      status: {
        mergeInProgress: true,
        repositoryOperationBlockedReason: "Finish the current merge first.",
      },
    },
  ] satisfies { label: string; status: Partial<ProjectGitStatus> }[])(
    "starts without asking when the checkout is $label",
    async ({ status }) => {
      prepareUnassignedLaunch();
      ensuredGit = behindGit(status);
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      const fetches = await fetchesAfterOpen();
      fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
      await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
      // The pre-send fetch still ran; it found nothing that could be merged.
      expect(fetchGit.mock.calls.length).toBe(fetches + 1);
      expect(mergeDialog() === null).toBe(true);
      expect(syncGit).not.toHaveBeenCalled();
    },
  );

  test("a failed pre-start fetch still assigns without asking", async () => {
    prepareUnassignedLaunch();
    ensuredGit = behindGit();
    fetchGit.mockRejectedValue(new Error("offline"));
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    expect(mergeDialog() === null).toBe(true);
    expect(syncGit).not.toHaveBeenCalled();
  });

  test("a rejected fast-forward keeps the real composer's draft and allows retry", async () => {
    useRealAgentTab = true;
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude"],
      agentSettings: { defaultAgent: "claude" },
    });
    prepareUnassignedLaunch();
    ensuredGit = behindGit({ behind: 2 });
    syncGit.mockRejectedValueOnce(new Error("Fast-forward refused"));
    const { container } = render(<CoordinatorPanel projectId="project-1" />);
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Inspect my draft after syncing" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Merge and send" }));
    expect(await screen.findByText("Fast-forward refused")).toBeTruthy();
    expect(syncGit).toHaveBeenCalledTimes(1);
    expect(assignAgent).not.toHaveBeenCalled();
    expect(input.textContent).toBe("Inspect my draft after syncing");
    expect(container.querySelector(".animate-spin") === null).toBe(true);
    const key = createSessionKey("coordinator:coordinator-1:conversation-1", "coordinator-tab");
    expect(useNativeComposeStore.getState().drafts.get(key)?.text).toBe(
      "Inspect my draft after syncing",
    );
    // A failure is not a decline: the next Enter asks again, and merging sends.
    expect(storedDecline()).toBeUndefined();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Merge and send" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    expect(syncGit).toHaveBeenCalledTimes(2);
  });

  describe("follow-up messages to the main coordinator", () => {
    const sendFollowUp = async (text: string) => {
      const input = await screen.findByRole("textbox");
      await waitFor(() => expect(input.getAttribute("contenteditable")).not.toBe("false"));
      fireEvent.input(input, { target: { textContent: text } });
      fireEvent.keyDown(input, { key: "Enter" });
      return input;
    };
    const sentPrompts = () =>
      dispatchIntent.mock.calls.map((call) => (call[0] as { prompt?: string }).prompt);
    const renderAssigned = async (platform: "claude" | "codex" = "claude") => {
      useRealAgentTab = true;
      useConfigStore.getState().updateGlobalConfig({
        enabledAgentPlatforms: [platform],
        agentSettings: { defaultAgent: platform },
      });
      ensuredSnapshot = {
        ...snapshot,
        workspace: {
          ...snapshot.workspace,
          conversations: [
            {
              ...snapshot.workspace.conversations[0]!,
              role: "main",
              agent: platform,
              providerSessionId: `${platform}-session`,
            },
          ],
        },
      };
      const view = render(<CoordinatorPanel projectId="project-1" />);
      await waitFor(() => expect(getAgentProjection).toHaveBeenCalled());
      return view;
    };

    test("a slow fetch permits one send at the timeout and cannot send again on completion", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      await fetchesAfterOpen();
      let finishFetch!: (value: ProjectGitStatus) => void;
      fetchGit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFetch = resolve;
          }),
      );
      const timeout = installControlledTimeout(5_000, { label: "upstream preflight" });
      try {
        await sendFollowUp("Send despite a slow remote");
        expect(timeout.pendingCount()).toBe(1);
        expect(dispatchIntent).not.toHaveBeenCalled();
        await act(async () => {
          expect(timeout.advance()).toBe(1);
        });
        await waitFor(() => expect(sentPrompts()).toEqual(["Send despite a slow remote"]));
        await act(async () => finishFetch(behindGit()));
        expect(dispatchIntent).toHaveBeenCalledTimes(1);
        expect(syncGit).not.toHaveBeenCalled();
        expect(mergeDialog() === null).toBe(true);
      } finally {
        expect(timeout.restore()).toBe(0);
      }
    });

    test("a suggestion added during fetch remains in the draft", async () => {
      getAgentProjection.mockImplementation(async () => ({
        ...launchProjection("idle", [
          {
            id: "previous",
            role: "assistant",
            content: "Ready",
            parts: [],
            createdAt: new Date(0).toISOString(),
          },
        ]),
        suggestedPrompt: "Also run the tests",
      }));
      await renderAssigned();
      await fetchesAfterOpen();
      act(() =>
        useNativeAgentProjectionStore.getState().setProjection(launchSessionKey, {
          ...launchProjection(
            "idle",
            [
              {
                id: "previous",
                role: "assistant",
                content: "Ready",
                parts: [],
                createdAt: new Date(0).toISOString(),
              },
            ],
            50,
          ),
          suggestedPrompt: "Also run the tests",
        }),
      );
      let finishFetch!: (value: ProjectGitStatus) => void;
      fetchGit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFetch = resolve;
          }),
      );
      await sendFollowUp("Inspect this");
      fireEvent.click(await screen.findByRole("button", { name: "Suggested: Also run the tests" }));
      await act(async () => finishFetch(gitStatus));
      expect(
        await screen.findByText(
          "The draft changed while preparing to send. Review it and send again.",
        ),
      ).toBeTruthy();
      expect(dispatchIntent).not.toHaveBeenCalled();
      expect(useNativeComposeStore.getState().drafts.get(launchSessionKey)?.text).toBe(
        "Inspect this\n\nAlso run the tests",
      );
      fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
      await waitFor(() => expect(sentPrompts()).toEqual(["Inspect this\n\nAlso run the tests"]));
    });

    test.each(["fetch", "dialog"] as const)(
      "unmount during %s settles without sending or declining; a remount can retry",
      async (stage) => {
        ensuredGit = behindGit();
        const view = await renderAssigned();
        await fetchesAfterOpen();
        let finishFetch!: (value: ProjectGitStatus) => void;
        if (stage === "fetch")
          fetchGit.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishFetch = resolve;
              }),
          );
        await sendFollowUp("Keep across remount");
        if (stage === "dialog") await screen.findByText("Merge 3 upstream commits?");
        await act(async () => view.unmount());
        if (stage === "fetch") await act(async () => finishFetch(behindGit()));
        expect(dispatchIntent).not.toHaveBeenCalled();
        expect(syncGit).not.toHaveBeenCalled();
        expect(storedDecline()).toBeUndefined();
        expect(useNativeComposeStore.getState().drafts.get(launchSessionKey)?.text).toBe(
          "Keep across remount",
        );
        await renderAssigned();
        expect(dispatchIntent).not.toHaveBeenCalled();
        fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
        fireEvent.click(await screen.findByRole("button", { name: "Don’t merge" }));
        await waitFor(() => expect(sentPrompts()).toEqual(["Keep across remount"]));
      },
    );

    test.each(["fetch", "dialog"] as const)(
      "unmount explicitly settles the %s preflight before any late fetch",
      async (stage) => {
        ensuredGit = behindGit();
        const view = render(<CoordinatorPanel projectId="project-1" />);
        await screen.findByTestId("native-agent");
        await fetchesAfterOpen();
        let finishFetch!: (value: ProjectGitStatus) => void;
        if (stage === "fetch")
          fetchGit.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishFetch = resolve;
              }),
          );
        const beforeSend = renderAgentNativeTab.mock.calls.at(-1)![0].beforeSend as () => Promise<
          void | boolean
        >;
        let pending!: Promise<void | boolean>;
        act(() => {
          pending = beforeSend();
        });
        if (stage === "dialog") await screen.findByText("Merge 3 upstream commits?");
        await act(async () => view.unmount());
        await expect(pending).resolves.toBe(false);
        if (stage === "fetch") await act(async () => finishFetch(behindGit()));
        expect(syncGit).not.toHaveBeenCalled();
        expect(storedDecline()).toBeUndefined();
      },
    );

    test("ignores an empty message before upstream preflight", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      const fetches = await fetchesAfterOpen();
      await sendFollowUp("  ");
      await act(async () => {});
      expect(
        useNativeComposeStore.getState().drafts.get(launchSessionKey)?.submissionError,
      ).toBeUndefined();
      expect(fetchGit.mock.calls.length).toBe(fetches);
      expect(syncGit).not.toHaveBeenCalled();
      expect(dispatchIntent).not.toHaveBeenCalled();
      expect(mergeDialog() === null).toBe(true);
      expect(storedDecline()).toBeUndefined();
    });

    test.each(["attachment", "command"] as const)(
      "rejects %s locally before upstream preflight",
      async (kind) => {
        ensuredGit = behindGit();
        if (kind === "attachment")
          getAgentProjection.mockImplementation(async () => ({
            ...launchProjection("idle"),
            platform: "codex",
            sessionId: "codex-session",
          }));
        await renderAssigned(kind === "attachment" ? "codex" : "claude");
        const fetches = await fetchesAfterOpen();
        if (kind === "attachment")
          act(() =>
            useNativeComposeStore.getState().updateDraft(launchSessionKey, {
              attachments: [
                { id: "unsupported", name: "notes.pdf", path: "/notes.pdf", type: "file" },
              ],
            }),
          );
        if (kind === "command")
          act(() =>
            useNativeComposeStore.getState().updateDraft(launchSessionKey, {
              annotations: [{ id: "a1", text: "Reference", comment: "" }],
            }),
          );
        await sendFollowUp(kind === "command" ? "!git status" : "Read the attachment");
        await waitFor(() =>
          expect(
            useNativeComposeStore.getState().drafts.get(launchSessionKey)?.submissionError,
          ).toBeTruthy(),
        );
        expect(fetchGit.mock.calls.length).toBe(fetches);
        expect(syncGit).not.toHaveBeenCalled();
        expect(dispatchIntent).not.toHaveBeenCalled();
        expect(mergeDialog() === null).toBe(true);
        expect(storedDecline()).toBeUndefined();
      },
    );

    test("the send button passes through upstream preflight", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      const input = await screen.findByRole("textbox");
      fireEvent.input(input, { target: { textContent: "Send with the button" } });
      fireEvent.click(screen.getByTitle("Send"));
      fireEvent.click(await screen.findByRole("button", { name: "Don’t merge" }));
      await waitFor(() => expect(sentPrompts()).toEqual(["Send with the button"]));
    });

    test("a recovering sibling prevents the first-send merge offer", async () => {
      const unassigned = { ...snapshot.workspace.conversations[0]!, agent: undefined };
      ensuredSnapshot = {
        ...snapshot,
        workspace: {
          ...snapshot.workspace,
          conversations: [
            unassigned,
            {
              ...snapshot.workspace.conversations[0]!,
              id: "recovering",
              tabId: "recovering-tab",
              role: "side",
            },
          ],
        },
      };
      ensuredGit = behindGit();
      useNativeAgentProjectionStore
        .getState()
        .setProjection(
          createSessionKey(coordinatorRuntimeId("coordinator-1", "recovering"), "recovering-tab"),
          launchProjection("recovering"),
        );
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      const fetches = await fetchesAfterOpen();
      fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
      await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
      expect(fetchGit.mock.calls.length).toBe(fetches);
      expect(syncGit).not.toHaveBeenCalled();
      expect(mergeDialog() === null).toBe(true);
    });

    test.each(["recovering", "project-home"] as const)(
      "does not offer a merge during %s activity",
      async (kind) => {
        ensuredGit = behindGit();
        await renderAssigned();
        const fetches = await fetchesAfterOpen();
        const previousEnvironments = useEnvironmentStore.getState().environments;
        try {
          act(() => {
            if (kind === "recovering") {
              useNativeAgentProjectionStore
                .getState()
                .setProjection(launchSessionKey, launchProjection("recovering", [], 50));
            } else {
              useEnvironmentStore.setState({
                environments: [
                  ...previousEnvironments,
                  {
                    id: "home",
                    projectId: "project-1",
                    projectHome: true,
                    name: "Home",
                    order: 0,
                  } as never,
                ],
              });
              useNativeAgentProjectionStore
                .getState()
                .setProjection(createSessionKey("home", "home-tab"), {
                  ...launchProjection("running"),
                  environmentId: "home",
                });
            }
          });
          await sendFollowUp("Send while checkout is in use");
          if (kind === "project-home")
            await waitFor(() => expect(sentPrompts()).toEqual(["Send while checkout is in use"]));
          else expect(dispatchIntent).not.toHaveBeenCalled();
          expect(fetchGit.mock.calls.length).toBe(fetches);
          expect(syncGit).not.toHaveBeenCalled();
          expect(mergeDialog() === null).toBe(true);
        } finally {
          useEnvironmentStore.setState({ environments: previousEnvironments });
        }
      },
    );

    test("busy admission after the merge offer sends without syncing or recording a decline", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      await sendFollowUp("Continue after busy refusal");
      syncGit.mockRejectedValueOnce(
        new Error("Stop the active coordinator turn before changing the checkout"),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Merge and send" }));
      await waitFor(() => expect(sentPrompts()).toEqual(["Continue after busy refusal"]));
      expect(storedDecline()).toBeUndefined();
    });

    test("Enter merges, then sends", async () => {
      ensuredGit = behindGit();
      const order: string[] = [];
      syncGit.mockImplementation(async () => {
        order.push("sync");
        return behindGit({ behind: 0, headCommit: firstUpstreamTip });
      });
      dispatchIntent.mockImplementation(async (input) => {
        order.push("send");
        return { outcome: "accepted" as const, requestId: input.requestId };
      });
      await renderAssigned();
      await sendFollowUp("Plan the next step");
      const merge = await screen.findByRole("button", { name: "Merge and send" });
      expect(dispatchIntent).not.toHaveBeenCalled();
      await waitFor(() => expect(document.activeElement).toBe(merge));
      fireEvent.click(merge);
      await waitFor(() => expect(order).toEqual(["sync", "send"]));
      expect(sentPrompts()).toEqual(["Plan the next step"]);
    });

    test("Escape sends without merging, and the same upstream tip is not asked about again", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      await sendFollowUp("First follow-up");
      await screen.findByText("Merge 3 upstream commits?");
      pressEscape();
      await waitFor(() => expect(sentPrompts()).toEqual(["First follow-up"]));
      expect(syncGit).not.toHaveBeenCalled();

      const fetches = await fetchesAfterOpen();
      await sendFollowUp("Second follow-up");
      await waitFor(() => expect(sentPrompts()).toEqual(["First follow-up", "Second follow-up"]));
      expect(fetchGit.mock.calls.length).toBe(fetches + 1);
      expect(mergeDialog() === null).toBe(true);

      // A new upstream commit asks again.
      ensuredGit = behindGit({ behind: 4, upstreamCommit: "c".repeat(40) });
      await sendFollowUp("Third follow-up");
      expect(await screen.findByText("Merge 4 upstream commits?")).toBeTruthy();
      expect(sentPrompts()).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Merge and send" }));
      await waitFor(() => expect(sentPrompts()).toHaveLength(3));
      expect(syncGit).toHaveBeenCalledTimes(1);
    });

    test("a failed merge keeps the draft unsent", async () => {
      ensuredGit = behindGit();
      syncGit.mockRejectedValueOnce(new Error("Fast-forward refused"));
      await renderAssigned();
      const input = await sendFollowUp("Keep this draft");
      fireEvent.click(await screen.findByRole("button", { name: "Merge and send" }));
      expect(await screen.findByText("Fast-forward refused")).toBeTruthy();
      expect(dispatchIntent).not.toHaveBeenCalled();
      expect(input.textContent).toBe("Keep this draft");
      expect(useNativeComposeStore.getState().drafts.get(launchSessionKey)?.text).toBe(
        "Keep this draft",
      );
    });

    test("a ! command runs without asking", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      const fetches = await fetchesAfterOpen();
      await sendFollowUp("!git status");
      await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
      expect(fetchGit.mock.calls.length).toBe(fetches);
      expect(mergeDialog() === null).toBe(true);
    });

    test("does not ask while a coordinator turn is running", async () => {
      ensuredGit = behindGit();
      await renderAssigned();
      act(() => {
        useNativeAgentProjectionStore
          .getState()
          .setProjection(launchSessionKey, launchProjection("running", [], 50));
      });
      const fetches = await fetchesAfterOpen();
      await sendFollowUp("Sent after the turn");
      // The checkout cannot change under a running turn, so nothing is fetched
      // or asked; the composer's own busy rules decide what happens to it.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(fetchGit.mock.calls.length).toBe(fetches);
      expect(mergeDialog() === null).toBe(true);
    });
  });

  test("side agents are never asked", async () => {
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [
          {
            ...snapshot.workspace.conversations[0]!,
            role: "side",
            sideOrdinal: 1,
            agent: undefined,
          },
        ],
      },
    };
    ensuredGit = behindGit();
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(renderAgentNativeTab.mock.calls.at(-1)?.[0].beforeSend).toBeUndefined();
    const fetches = await fetchesAfterOpen();
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    expect(fetchGit.mock.calls.length).toBe(fetches);
  });

  test("reports an assignment failure without binding the conversation", async () => {
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [{ ...snapshot.workspace.conversations[0]!, agent: undefined }],
      },
    };
    assignAgent.mockImplementation(async () => {
      throw new Error("assignment failed");
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    // Still unassigned, so the user can retry or pick a different platform.
    const agent = await screen.findByTestId("native-agent");
    expect(agent.getAttribute("data-platform")).toBe("");
  });

  afterEach(() => {
    cleanup();
    resetReadCoordinatorForTests();
  });
  afterAll(() => {
    mock.module("@/lib/backend", () => backendSnapshot);
    mock.module("@/components/native-agent", () => nativeAgentSnapshot);
  });

  test("reports selection and pause failures", async () => {
    const first = render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "First, Codex" }));
    expect(await screen.findByText("select failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("pause failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close First" }));
    expect(await screen.findByText("close failed")).toBeTruthy();
    first.unmount();

    ensuredSnapshot = {
      ...snapshot,
      workspace: { ...snapshot.workspace, lifecycleState: "paused" },
    };
    const paused = render(<CoordinatorPanel projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(await screen.findByText("resume failed")).toBeTruthy();
    paused.unmount();

    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [],
        selectedConversationId: null,
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    // With no main open, the action starts the main coordinator.
    const newConversation = await screen.findAllByRole("button", { name: "Start coordinator" });
    fireEvent.click(newConversation.at(-1)!);
    expect(await screen.findByText("create failed")).toBeTruthy();
  });

  test("pins the main coordinator first and offers side agents once it is open", async () => {
    const base = snapshot.workspace.conversations[0]!;
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [
          {
            ...base,
            id: "side-1",
            tabId: "coordinator-side-1",
            title: "Side 1",
            role: "side",
            sideOrdinal: 1,
          },
          { ...base, title: "Coordinator", role: "main" },
        ],
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    const main = await screen.findByRole("button", { name: "Coordinator, Codex" });
    const side = screen.getByRole("button", { name: "Side 1, Codex" });
    expect(main.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "New side agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start coordinator" }) === null).toBe(true);
  });

  test("selects a conversation from the full tab shell and shows its agent brand", async () => {
    render(<CoordinatorPanel projectId="project-1" />);

    const selectionButton = await screen.findByRole("button", { name: "First, Codex" });
    expect(selectionButton.querySelector("svg.text-emerald-400")).toBeTruthy();

    const tabShell = selectionButton.parentElement;
    expect(tabShell).toBeTruthy();
    fireEvent.click(tabShell!);

    await waitFor(() => expect(select).toHaveBeenCalledWith("project-1", "conversation-1"));
  });

  test("renders missing-checkout, unavailable, paused, startup-error, and dirty states", async () => {
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, localPath: null })),
    }));
    const first = render(<CoordinatorPanel projectId="project-1" />);
    expect(screen.getByText("Connect a local checkout")).toBeTruthy();
    first.unmount();

    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, localPath: "/checkout" })),
    }));
    ensuredSnapshot = {
      ...snapshot,
      providerAvailability: {
        codex: { tier: "enforced", available: false, reason: "Sign in first", delegation: true },
      },
    };
    const unavailable = render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("Sign in first")).toBeTruthy();
    unavailable.unmount();

    ensuredSnapshot = {
      ...snapshot,
      workspace: { ...snapshot.workspace, lifecycleState: "paused" },
    };
    const paused = render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/Coordination is paused/)).toBeTruthy();
    paused.unmount();

    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        lifecycleState: "error",
        lastStartupError: "bridge failed",
      },
    };
    const failed = render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("bridge failed")).toBeTruthy();
    failed.unmount();

    ensuredSnapshot = snapshot;
    ensuredGit = {
      ...gitStatus,
      trackedChanges: 2,
      repositoryOperationBlockedReason:
        "Commit or discard local checkout changes before switching or syncing.",
    };
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/2 tracked/)).toBeTruthy();
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);
  });

  test("rehydrates from the backend after remount and shows load failures", async () => {
    const first = render(<CoordinatorPanel projectId="project-1" />);
    await first.findByTestId("native-agent");
    first.unmount();
    const second = render(<CoordinatorPanel projectId="project-1" />);
    await second.findByTestId("native-agent");
    expect(ensure).toHaveBeenCalledTimes(2);
    second.unmount();

    ensureFailure = new Error("checkout disappeared");
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("Coordinator unavailable")).toBeTruthy();
    expect(screen.getByText("checkout disappeared")).toBeTruthy();
  });

  test("unmounts the previous project's chat before loading the next project", async () => {
    const rendered = render(<ProjectWorkspace projectId="project-1" />);
    await screen.findByTestId("native-agent");
    useProjectStore.setState((state) => ({
      projects: [
        ...state.projects,
        {
          ...state.projects[0]!,
          id: "project-2",
          name: "Second project",
          localPath: "/second-checkout",
        },
      ],
    }));
    ensureFailure = new Error("second checkout disappeared");

    rendered.rerender(<ProjectWorkspace projectId="project-2" />);

    expect(await screen.findByText("second checkout disappeared")).toBeTruthy();
    expect(screen.queryByTestId("native-agent") === null).toBe(true);
  });

  test("rehydrates on focus and exposes authoritative branch and sync controls", async () => {
    ensuredGit = {
      ...gitStatus,
      upstream: "origin/main",
      remote: "origin",
      behind: 1,
      ahead: 0,
      remoteState: "fresh",
      branches: [
        ...gitStatus.branches,
        { ref: "refs/remotes/origin/feature", name: "origin/feature", kind: "remote" },
      ],
    };
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.getByRole("button", { name: "Sync" })).toBeTruthy();
    expect(screen.getByRole("combobox").textContent).toContain("main");

    const callsAfterLoad = getGit.mock.calls.length;
    // A focus right after opening is served by the opening read.
    fireEvent.focus(window);
    await act(async () => Promise.resolve());
    expect(getGit.mock.calls.length).toBe(callsAfterLoad);
    // Later, focus and visibility arriving together probe once, not twice.
    const now = Date.now();
    const nowSpy = spyOn(Date, "now").mockImplementation(
      () => now + COORDINATOR_FOCUS_PROBE_MIN_INTERVAL_MS + 1,
    );
    try {
      fireEvent.focus(window);
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(getGit.mock.calls.length).toBe(callsAfterLoad + 1));
      await waitFor(() => expect(getCoordinatorView).toHaveBeenCalled());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(getGit.mock.calls.length).toBe(callsAfterLoad + 1);
    } finally {
      nowSpy.mockRestore();
    }

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "origin/feature" }));
    await waitFor(() =>
      expect(switchBranch).toHaveBeenCalledWith("project-1", "refs/remotes/origin/feature", {}),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(syncGit).toHaveBeenCalledWith("project-1"));
  });

  test("keeps branch switching available without an upstream and confirms dirty discard", async () => {
    ensuredGit = {
      ...gitStatus,
      trackedChanges: 1,
      untrackedChanges: 2,
      repositoryOperationBlockedReason:
        "Commit or discard local checkout changes before switching or syncing.",
      branches: [
        ...gitStatus.branches,
        { ref: "refs/heads/feature", name: "feature", kind: "local" },
      ],
    };
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");

    const branchPicker = screen.getByRole("combobox");
    expect(branchPicker.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("No upstream configured")).toBeTruthy();

    fireEvent.click(branchPicker);
    fireEvent.click(await screen.findByRole("option", { name: "feature" }));
    expect(await screen.findByText("Discard changes and switch branch?")).toBeTruthy();
    await waitFor(() =>
      expect(prepareSwitch).toHaveBeenCalledWith("project-1", "refs/heads/feature"),
    );
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "1 tracked changes and 5 untracked files",
    );
    expect(switchBranch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep changes" }));
    expect(switchBranch).not.toHaveBeenCalled();

    fireEvent.click(branchPicker);
    fireEvent.click(await screen.findByRole("option", { name: "feature" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and switch" }));
    await waitFor(() =>
      expect(switchBranch).toHaveBeenCalledWith("project-1", "refs/heads/feature", {
        confirmationToken: "confirm-token",
        includeNestedRepositories: false,
      }),
    );
  });

  test("does not promise a discard confirmation when switching is blocked by a merge", async () => {
    ensuredGit = {
      ...gitStatus,
      trackedChanges: 2,
      mergeInProgress: true,
      repositoryOperationBlockedReason: "Finish the current merge first.",
      branches: [
        ...gitStatus.branches,
        { ref: "refs/heads/feature", name: "feature", kind: "local" },
      ],
    };
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/2 tracked/)).toBeTruthy();
    expect(screen.getByText("Finish the current merge first.")).toBeTruthy();
    expect(screen.queryByText(/switching branches will ask before discarding/) === null).toBe(true);
    expect(screen.queryByText("Discard changes and switch branch?") === null).toBe(true);
  });

  test("disables Git mutations during an active turn", async () => {
    ensuredGit = {
      ...gitStatus,
      upstream: "origin/main",
      remote: "origin",
      behind: 1,
      ahead: 0,
      remoteState: "fresh",
    };
    const sessionKey = createSessionKey(
      coordinatorRuntimeId("coordinator-1", "conversation-1"),
      "coordinator-tab",
    );
    useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
      platform: "codex",
      environmentId: "coordinator:coordinator-1:conversation-1",
      connection: "connected",
      turn: { phase: "running" },
      messages: [],
      interactions: [],
      composerControls: [],
      capabilities: {},
      revision: 1,
      generation: "test",
    } as never);

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Sync" }).hasAttribute("disabled")).toBe(true);
    cleanup();

    act(() => {
      useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
        ...useNativeAgentProjectionStore.getState().projections.get(sessionKey)!,
        turn: { phase: "idle" },
        revision: 2,
      });
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);
  });

  test("shows no repository context notice when a context-change event arrives", async () => {
    const contextEvent = (revision: number, branch: string, commitChar: string) => ({
      revision,
      branch,
      headCommit: commitChar.repeat(40),
      occurredAt: new Date(revision).toISOString(),
    });
    const expectNoContextNotice = () => {
      expect(screen.queryByText(/Repository context changed/) === null).toBe(true);
      expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
      expect(screen.queryByText(/\(context r\d+\)/) === null).toBe(true);
      expect(
        screen.queryByRole("button", { name: "Dismiss repository context notice" }) === null,
      ).toBe(true);
    };
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        repositoryContextRevision: 1,
        repositoryContextEvents: [contextEvent(1, "main", "b")],
      },
    };

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expectNoContextNotice();

    // A later merge on the base branch arrives as a new, unacknowledged
    // context revision on the next authoritative read.
    const reads = getCoordinatorView.mock.calls.length;
    await act(async () => {
      ensuredSnapshot = {
        ...ensuredSnapshot,
        workspace: {
          ...ensuredSnapshot.workspace,
          repositoryContextRevision: 2,
          repositoryContextEvents: [
            ...(ensuredSnapshot.workspace.repositoryContextEvents ?? []),
            contextEvent(2, "main", "c"),
          ],
          conversations: ensuredSnapshot.workspace.conversations.map((conversation) => ({
            ...conversation,
            title: "After context change",
          })),
        },
      };
      dispatchResourceChange({
        resource: "coordinator",
        id: "project-1",
        projectId: "project-1",
        revision: 2,
      });
    });
    await waitFor(() => expect(getCoordinatorView.mock.calls.length).toBeGreaterThan(reads));
    await screen.findAllByRole("button", { name: "After context change, Codex" });
    expectNoContextNotice();
    cleanup();

    // Nor with no conversation selected.
    ensuredSnapshot = {
      ...ensuredSnapshot,
      workspace: {
        ...ensuredSnapshot.workspace,
        conversations: [],
        selectedConversationId: null,
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByText(/No coordinator is open/);
    expectNoContextNotice();
  });

  test("shows waiting workers only for the selected conversation", async () => {
    const secondConversation = {
      ...snapshot.workspace.conversations[0]!,
      id: "conversation-2",
      tabId: "coordinator-tab-2",
      logicalSessionKey: "coordinator-coordinator-1:conversation-2",
      title: "Second",
    };
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [...snapshot.workspace.conversations, secondConversation],
        selectedConversationId: "conversation-1",
      },
      workflows: [
        {
          id: "first-worker",
          coordinatorId: "coordinator-1",
          projectId: "project-1",
          conversationId: "conversation-1",
          kind: "environment",
          resourceId: "worker-for-first",
          requestId: "first",
          createdAt: new Date(0).toISOString(),
          delegation: {
            requestedAt: new Date(0).toISOString(),
            workerTabId: "agent-1",
            state: "running",
          },
        },
        {
          id: "second-worker",
          coordinatorId: "coordinator-1",
          projectId: "project-1",
          conversationId: "conversation-2",
          kind: "environment",
          resourceId: "worker-for-second",
          requestId: "second",
          createdAt: new Date(0).toISOString(),
          delegation: {
            requestedAt: new Date(0).toISOString(),
            workerTabId: "agent-2",
            state: "running",
          },
        },
      ],
    };

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    const badge = screen.getByText(/Waiting on 1 worker/);
    expect(badge.getAttribute("title")).toContain("worker-for-first");
    expect(badge.getAttribute("title")).not.toContain("worker-for-second");
  });

  test("marks a delegated worker waiting on a person once its episode is announced", async () => {
    const delegation = (id: string, resourceId: string) => ({
      id,
      coordinatorId: "coordinator-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      kind: "environment" as const,
      resourceId,
      requestId: id,
      createdAt: new Date(0).toISOString(),
      delegation: {
        requestedAt: new Date(0).toISOString(),
        workerTabId: "startup-agent",
        state: "running" as const,
      },
    });
    const quiet = delegation("quiet", "worker-quiet");
    const blocked = delegation("blocked", "worker-blocked");
    ensuredSnapshot = { ...snapshot, workflows: [quiet, blocked] };

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    const badge = () => screen.getByText(/Waiting on 2 workers/);
    expect(badge().textContent).not.toContain("needs you");
    expect(badge().getAttribute("data-workers-need-person")).toBeNull();

    ensuredSnapshot = {
      ...snapshot,
      workflows: [
        quiet,
        {
          ...blocked,
          delegation: { ...blocked.delegation, waiting: { since: new Date(0).toISOString() } },
        },
      ],
    };
    await act(async () => {
      dispatchResourceChange({
        resource: "coordinator",
        id: "project-1",
        projectId: "project-1",
        revision: 2,
      });
    });
    await waitFor(() => expect(badge().textContent).toContain("1 needs you"));
    expect(badge().getAttribute("data-workers-need-person")).toBe("1");
    const title = badge().getAttribute("title") ?? "";
    expect(title).toContain(
      "worker-blocked: waiting for you (an approval or a question in its tab)",
    );
    expect(title).not.toContain("worker-quiet: waiting for you");
  });

  test("shows a side agent split into its own tab group beside the main coordinator", async () => {
    const base = snapshot.workspace.conversations[0]!;
    const side = {
      ...base,
      id: "side-1",
      tabId: "coordinator-side-1",
      logicalSessionKey: "coordinator-coordinator-1:side-1",
      title: "Side 1",
      role: "side" as const,
      sideOrdinal: 1,
    };
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [{ ...base, title: "Coordinator", role: "main" }, side],
        selectedConversationId: "conversation-1",
      },
    };
    // What dragging the side tab onto the right edge of the group leaves behind.
    const single = reconcileCoordinatorLayout(null, ["conversation-1", "side-1"]);
    const split = splitCoordinatorPaneAtEdge(
      single,
      single.activePaneId,
      "right",
      "side-1",
      single.activePaneId,
    );
    useCoordinatorPaneLayoutStore.getState().setLayout("project-1", split);

    render(<CoordinatorPanel projectId="project-1" />);

    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    const agents = screen.getAllByTestId("native-agent");
    expect(agents.map((agent) => agent.getAttribute("data-tab-id"))).toEqual([
      "coordinator-tab",
      "coordinator-side-1",
    ]);
    // Each group has its own strip, holding only its own tab.
    const mainPane = agents[0]!.closest("[data-coordinator-pane]")!;
    const sidePane = agents[1]!.closest("[data-coordinator-pane]")!;
    expect(mainPane).not.toBe(sidePane);
    expect(mainPane.textContent).toContain("Coordinator");
    expect(mainPane.textContent).not.toContain("Side 1");
    expect(sidePane.textContent).toContain("Side 1");
    // The backend's selection is revealed: the main's group owns shortcuts.
    await waitFor(() => expect(agents[0]!.getAttribute("data-owns-shortcuts")).toBe("true"));
    expect(agents[1]!.getAttribute("data-owns-shortcuts")).toBe("false");

    // Working in the side group focuses it and selects its conversation.
    fireEvent.click(agents[1]!);
    await waitFor(() => expect(select).toHaveBeenCalledWith("project-1", "side-1"));
    expect(screen.getAllByTestId("native-agent")[1]!.getAttribute("data-owns-shortcuts")).toBe(
      "true",
    );
  });

  function setupGroups() {
    const base = snapshot.workspace.conversations[0]!;
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [
          { ...base, role: "main", title: "Coordinator" },
          {
            ...base,
            id: "side-1",
            tabId: "side-tab",
            role: "side",
            title: "Side 1",
            sideOrdinal: 1,
          },
          {
            ...base,
            id: "side-2",
            tabId: "side-tab-2",
            role: "side",
            title: "Side 2",
            sideOrdinal: 2,
          },
        ],
      },
    };
    const single = reconcileCoordinatorLayout(
      null,
      ensuredSnapshot.workspace.conversations.map((item) => item.id),
    );
    const split = splitCoordinatorPaneAtEdge(
      single,
      single.activePaneId,
      "right",
      "side-1",
      single.activePaneId,
    );
    useCoordinatorPaneLayoutStore.getState().setLayout("project-1", split);
    return split;
  }

  test("keeps the newest pane intent through deferred selection answers and view reads", async () => {
    setupGroups();
    const initial = ensuredSnapshot;
    let resolveSide!: (value: CoordinatorSnapshot) => void;
    let resolveMain!: (value: CoordinatorSnapshot) => void;
    select.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSide = resolve;
        }),
    );
    select.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMain = resolve;
        }),
    );
    render(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    const agents = screen.getAllByTestId("native-agent");
    fireEvent.click(agents[1]!);
    fireEvent.click(agents[0]!);
    expect(select).toHaveBeenCalledTimes(1);
    const sideSelected = {
      ...initial,
      workspace: { ...initial.workspace, selectedConversationId: "side-1" },
    };
    ensuredSnapshot = sideSelected;
    await act(async () => {
      resolveSide(sideSelected);
    });
    await waitFor(() => expect(select).toHaveBeenLastCalledWith("project-1", "conversation-1"));
    // An authoritative reconciliation snapshot of B must not steal focus while A waits.
    const reads = getCoordinatorView.mock.calls.length;
    await act(async () => {
      dispatchResourceChange({
        resource: "coordinator",
        id: "project-1",
        projectId: "project-1",
        revision: 1,
      });
    });
    await waitFor(() => expect(getCoordinatorView.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.getAllByTestId("native-agent")[0]!.getAttribute("data-owns-shortcuts")).toBe(
      "true",
    );
    ensuredSnapshot = initial;
    await act(async () => {
      resolveMain(initial);
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("native-agent")[0]!.getAttribute("data-owns-shortcuts")).toBe(
        "true",
      ),
    );
    expect(focusedCoordinatorConversationId(storedLayout())).toBe("conversation-1");
    expect(select).toHaveBeenCalledTimes(2);
  });

  test("focus entry and stopped pointer bubbling transfer shortcut ownership", async () => {
    setupGroups();
    select.mockImplementationOnce(async () => {
      ensuredSnapshot = {
        ...ensuredSnapshot,
        workspace: { ...ensuredSnapshot.workspace, selectedConversationId: "side-1" },
      };
      return ensuredSnapshot;
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    const agents = screen.getAllByTestId("native-agent");
    fireEvent.focusIn(agents[1]!, { relatedTarget: agents[0] });
    await waitFor(() => expect(select).toHaveBeenCalledWith("project-1", "side-1"));
    expect(agents[1]!.getAttribute("data-owns-shortcuts")).toBe("true");
    const stop = (event: Event) => event.stopPropagation();
    agents[0]!.addEventListener("pointerdown", stop);
    fireEvent.pointerDown(agents[0]!);
    await waitFor(() => expect(select).toHaveBeenLastCalledWith("project-1", "conversation-1"));
    expect(agents[0]!.getAttribute("data-owns-shortcuts")).toBe("true");
    agents[0]!.removeEventListener("pointerdown", stop);
  });

  test.each(["split", "move"])(
    "a drag %s selects its newly focused conversation",
    async (action) => {
      const layout = setupGroups();
      let changeLayout!: Parameters<typeof paneTree.CoordinatorPaneTree>[0]["onLayoutChange"];
      const original = paneTree.CoordinatorPaneTree;
      const treeSpy = spyOn(paneTree, "CoordinatorPaneTree").mockImplementation((props) => {
        changeLayout = props.onLayoutChange;
        return original(props);
      });
      try {
        select.mockImplementationOnce(async () => ({
          ...ensuredSnapshot,
          workspace: { ...ensuredSnapshot.workspace, selectedConversationId: "side-2" },
        }));
        render(<CoordinatorPanel projectId="project-1" />);
        await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
        const [left, right] = collectCoordinatorLeaves(layout.root);
        act(() =>
          changeLayout((current) =>
            action === "split"
              ? splitCoordinatorPaneAtEdge(current, left!.id, "bottom", "side-2", left!.id)
              : moveCoordinatorConversation(current, left!.id, right!.id, "side-2"),
          ),
        );
        await waitFor(() => expect(select).toHaveBeenCalledWith("project-1", "side-2"));
        expect(focusedCoordinatorConversationId(storedLayout())).toBe("side-2");
      } finally {
        treeSpy.mockRestore();
      }
    },
  );

  test("New side agent from a non-focused group places and focuses the created conversation there", async () => {
    const layout = setupGroups();
    const beforeCreate = ensuredSnapshot;
    let resolveFocus!: (value: CoordinatorSnapshot) => void;
    select.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFocus = resolve;
        }),
    );
    select.mockImplementationOnce(async () => ensuredSnapshot);
    const [, right] = collectCoordinatorLeaves(layout.root);
    const created = {
      ...ensuredSnapshot.workspace.conversations[1]!,
      id: "side-3",
      tabId: "side-tab-3",
      title: "Side 3",
      sideOrdinal: 3,
    };
    createConversation.mockImplementationOnce(async () => {
      ensuredSnapshot = {
        ...ensuredSnapshot,
        workspace: {
          ...ensuredSnapshot.workspace,
          conversations: [...ensuredSnapshot.workspace.conversations, created],
          selectedConversationId: created.id,
        },
      };
      return ensuredSnapshot;
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    const sidePane = screen.getAllByTestId("native-agent")[1]!.closest("[data-coordinator-pane]")!;
    const newButton = Array.from(sidePane.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New side agent"),
    )!;
    fireEvent.pointerDown(newButton);
    fireEvent.click(newButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "Side 3, Codex" })).toBeTruthy());
    await act(async () => {
      resolveFocus({
        ...beforeCreate,
        workspace: { ...beforeCreate.workspace, selectedConversationId: "side-1" },
      });
    });
    await waitFor(() => expect(select).toHaveBeenLastCalledWith("project-1", "side-3"));
    await waitFor(() => expect(focusedCoordinatorConversationId(storedLayout())).toBe("side-3"));
    const stored = storedLayout();
    expect(stored.activePaneId).toBe(right!.id);
    expect(collectCoordinatorLeaves(stored.root)[1]!.conversationIds).toEqual(["side-1", "side-3"]);
    expect(focusedCoordinatorConversationId(stored)).toBe("side-3");
  });

  test("New side agent names the empty unassigned side agents for the backend to close", async () => {
    const base = snapshot.workspace.conversations[0]!;
    const side = (id: string, sideOrdinal: number) => ({
      ...base,
      id,
      tabId: `tab-${id}`,
      title: `Side ${sideOrdinal}`,
      role: "side" as const,
      sideOrdinal,
      agent: undefined,
    });
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [
          { ...base, role: "main" as const },
          side("side-empty", 1),
          side("side-typed", 2),
        ],
      },
    };
    const typedKey = createSessionKey(
      coordinatorRuntimeId(snapshot.workspace.id, "side-typed"),
      "tab-side-typed",
    );
    useNativeComposeStore.getState().updateDraft(typedKey, { text: "Not sent yet" });
    createConversation.mockImplementationOnce(async () => ensuredSnapshot);
    try {
      render(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      const newButton = screen
        .getAllByRole("button")
        .find((button) => button.textContent?.includes("New side agent"))!;
      fireEvent.click(newButton);
      await waitFor(() => expect(createConversation).toHaveBeenCalled());
      expect(createConversation.mock.calls[0] as unknown[]).toEqual([
        "project-1",
        undefined,
        ["side-empty"],
      ]);
    } finally {
      useNativeComposeStore.getState().clearDraft(typedKey);
    }
  });

  test("closing the only tab of a split group collapses the group", async () => {
    const base = snapshot.workspace.conversations[0]!;
    const side = {
      ...base,
      id: "side-1",
      tabId: "coordinator-side-1",
      title: "Side 1",
      role: "side" as const,
      sideOrdinal: 1,
    };
    const both = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [{ ...base, title: "Coordinator", role: "main" as const }, side],
      },
    };
    ensuredSnapshot = both;
    const single = reconcileCoordinatorLayout(null, ["conversation-1", "side-1"]);
    useCoordinatorPaneLayoutStore
      .getState()
      .setLayout(
        "project-1",
        splitCoordinatorPaneAtEdge(
          single,
          single.activePaneId,
          "right",
          "side-1",
          single.activePaneId,
        ),
      );
    closeConversation.mockImplementationOnce(async () => ({
      ...both,
      workspace: {
        ...both.workspace,
        conversations: [
          both.workspace.conversations[0]!,
          { ...side, closedAt: new Date(1).toISOString() },
        ],
      },
    }));

    render(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));

    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(1));
    expect(document.querySelectorAll("[data-coordinator-pane]")).toHaveLength(1);
  });
});
