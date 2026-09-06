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
  providerAvailability: { codex: { available: true } },
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
}));

mock.module("@/components/native-agent", () => ({
  ...nativeAgentSnapshot,
  AgentNativeTab: () => <div data-testid="native-agent" />,
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
  });

  afterEach(cleanup);
  afterAll(() => {
    mock.module("@/lib/backend", () => backendSnapshot);
    mock.module("@/components/native-agent", () => nativeAgentSnapshot);
  });

  test("reports selection and pause failures", async () => {
    const first = render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "First" }));
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
      providerAvailability: { codex: { available: false, reason: "Sign in first" } },
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

  test("disables Git mutations during an active turn and clears acknowledged context warnings", async () => {
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
    active.unmount();

    ensuredSnapshot = {
      ...ensuredSnapshot,
      workspace: {
        ...ensuredSnapshot.workspace,
        conversations: ensuredSnapshot.workspace.conversations.map((conversation) => ({
          ...conversation,
          repositoryContextRevisionAcknowledged: 1,
        })),
      },
    };
    act(() => {
      useNativeAgentProjectionStore.getState().setProjection(sessionKey, {
        ...useNativeAgentProjectionStore.getState().projections.get(sessionKey)!,
        turn: { phase: "idle" },
        revision: 2,
      });
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(screen.queryByText(/Earlier analysis may be stale/) === null).toBe(true);
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);
  });
});
