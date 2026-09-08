import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import { useProjectStore } from "@/stores/projectStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeNoticeDismissalStore } from "@/stores/nativeNoticeDismissalStore";
import { createSessionKey } from "@/lib/utils";

const backendSnapshot = { ...realBackend };
const nativeAgentSnapshot = { ...realNativeAgent };
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
const syncGit = mock(async () => ensuredGit);
const getCoordinator = mock(async () => ensuredSnapshot);
const assignAgent = mock(async () => ensuredSnapshot);

mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  ensureProjectCoordinator: ensure,
  getProjectCoordinator: getCoordinator,
  getProjectGitStatus: getGit,
  fetchProjectGit: mock(async () => ensuredGit),
  switchProjectGitBranch: switchBranch,
  syncProjectGit: syncGit,
  pauseProjectCoordinator: pause,
  resumeProjectCoordinator: resume,
  selectCoordinatorConversation: select,
  createCoordinatorConversation: createConversation,
  closeCoordinatorConversation: closeConversation,
  assignCoordinatorConversationAgent: assignAgent,
}));

const renderAgentNativeTab = mock((props: Record<string, unknown>) => (
  <div
    data-testid="native-agent"
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
  AgentNativeTab: renderAgentNativeTab,
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { useUIStore } from "@/stores";

describe("CoordinatorPanel", () => {
  beforeEach(() => {
    pause.mockClear();
    select.mockClear();
    resume.mockClear();
    createConversation.mockClear();
    closeConversation.mockClear();
    ensure.mockClear();
    getGit.mockClear();
    switchBranch.mockClear();
    syncGit.mockClear();
    getCoordinator.mockClear();
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
  });

  test("forwards the project id to the coordinator native-agent tab", async () => {
    render(<CoordinatorPanel projectId="project-1" />);

    const agent = await screen.findByTestId("native-agent");
    expect(agent.getAttribute("data-coordinator-project-id")).toBe("project-1");
    expect(renderAgentNativeTab.mock.calls.at(-1)?.[0]).toMatchObject({
      coordinatorProjectId: "project-1",
    });
  });

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

  test("the opening prompt is held until the turn is observed, not dropped on the next render", async () => {
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
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Assign claude" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledTimes(1));
    const assigned = await screen.findByTestId("native-agent");
    await waitFor(() => expect(assigned.getAttribute("data-platform")).toBe("claude"));
    expect(assigned.getAttribute("data-initial-prompt")).toBe("Inspect the repository");

    // The snapshot poll re-renders the panel within a second or two. The agent
    // tab dispatches only after its own first authoritative read, so dropping
    // the prompt here raced that read and left it unsent in the composer.
    act(() => {
      ensuredSnapshot = { ...assignedSnapshot };
    });
    await waitFor(() => expect(getCoordinator).toHaveBeenCalled());
    expect((await screen.findByTestId("native-agent")).getAttribute("data-initial-prompt")).toBe(
      "Inspect the repository",
    );

    // Evidence of the turn is what releases it.
    const sessionKey = createSessionKey(
      coordinatorRuntimeId("coordinator-1", "conversation-1"),
      "coordinator-tab",
    );
    act(() => {
      useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
        platform: "claude",
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
    });
    await waitFor(() =>
      expect(screen.getByTestId("native-agent").getAttribute("data-initial-prompt")).toBe(""),
    );
  });

  test("a caveat on an available platform reaches the composer, an unavailable one does not", async () => {
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

  afterEach(cleanup);
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
    const newConversation = await screen.findAllByRole("button", { name: "New conversation" });
    fireEvent.click(newConversation.at(-1)!);
    expect(await screen.findByText("create failed")).toBeTruthy();
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
      repositoryOperationBlockedReason: "Commit or discard changes.",
    };
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/2 tracked/)).toBeTruthy();
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
    fireEvent.focus(window);
    await waitFor(() => expect(getGit.mock.calls.length).toBeGreaterThan(callsAfterLoad));

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "origin/feature" }));
    await waitFor(() =>
      expect(switchBranch).toHaveBeenCalledWith("project-1", "refs/remotes/origin/feature"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(syncGit).toHaveBeenCalledWith("project-1"));
  });

  test("disables Git mutations during an active turn and persists dismissed context warnings", async () => {
    ensuredGit = {
      ...gitStatus,
      upstream: "origin/main",
      remote: "origin",
      behind: 1,
      ahead: 0,
      remoteState: "fresh",
    };
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        repositoryContextRevision: 1,
        repositoryContextEvents: [
          {
            revision: 1,
            branch: "main",
            headCommit: "b".repeat(40),
            occurredAt: new Date(1).toISOString(),
          },
        ],
      },
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

    const active = render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/Earlier analysis may be stale/)).toBeTruthy();
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Sync" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss repository context notice" }));
    expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
    active.unmount();

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
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

  test("hides repository context warnings acknowledged by the selected conversation", async () => {
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        repositoryContextRevision: 1,
        repositoryContextEvents: [
          {
            revision: 1,
            branch: "main",
            headCommit: "b".repeat(40),
            occurredAt: new Date(1).toISOString(),
          },
        ],
        conversations: snapshot.workspace.conversations.map((conversation) => ({
          ...conversation,
          repositoryContextRevisionAcknowledged: 1,
        })),
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
  });

  test("dismisses repository context warnings without a selected conversation across remounts", async () => {
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [],
        selectedConversationId: null,
        repositoryContextRevision: 1,
        repositoryContextEvents: [
          {
            revision: 1,
            branch: "main",
            headCommit: "b".repeat(40),
            occurredAt: new Date(1).toISOString(),
          },
        ],
      },
    };

    const active = render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/Earlier analysis may be stale/)).toBeTruthy();
    expect(screen.getByText("No open coordinator conversation.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss repository context notice" }));
    expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
    active.unmount();

    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByText("No open coordinator conversation.");
    expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
  });

  test("shows a newer repository context warning after dismissing an earlier revision", async () => {
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        repositoryContextRevision: 1,
        repositoryContextEvents: [
          {
            revision: 1,
            branch: "main",
            headCommit: "b".repeat(40),
            occurredAt: new Date(1).toISOString(),
          },
        ],
      },
    };

    const first = render(<CoordinatorPanel projectId="project-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss repository context notice" }),
    );
    first.unmount();

    ensuredSnapshot = {
      ...ensuredSnapshot,
      workspace: {
        ...ensuredSnapshot.workspace,
        repositoryContextRevision: 2,
        repositoryContextEvents: [
          ...(ensuredSnapshot.workspace.repositoryContextEvents ?? []),
          {
            revision: 2,
            branch: "feature",
            headCommit: "c".repeat(40),
            occurredAt: new Date(2).toISOString(),
          },
        ],
      },
    };

    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/context r2/)).toBeTruthy();
  });

  test("scopes dismissed repository context warnings to one conversation", async () => {
    const secondConversation = {
      ...snapshot.workspace.conversations[0]!,
      id: "conversation-2",
      tabId: "coordinator-tab-2",
      logicalSessionKey: "coordinator-coordinator-1:conversation-2",
      title: "Second",
      mailboxIncarnationId: "incarnation-2",
    };
    ensuredSnapshot = {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        conversations: [...snapshot.workspace.conversations, secondConversation],
        repositoryContextRevision: 1,
        repositoryContextEvents: [
          {
            revision: 1,
            branch: "main",
            headCommit: "b".repeat(40),
            occurredAt: new Date(1).toISOString(),
          },
        ],
      },
    };

    const first = render(<CoordinatorPanel projectId="project-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss repository context notice" }),
    );
    first.unmount();

    ensuredSnapshot = {
      ...ensuredSnapshot,
      workspace: {
        ...ensuredSnapshot.workspace,
        selectedConversationId: secondConversation.id,
      },
    };
    render(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(/Earlier analysis may be stale/)).toBeTruthy();
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
});
