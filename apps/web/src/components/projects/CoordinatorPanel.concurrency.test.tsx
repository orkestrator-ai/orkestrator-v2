/**
 * What the panel does while several things happen at once: first sends in two
 * tab groups, a Git action beside a conversation action, and a turn in a
 * conversation other than the focused one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import {
  reconcileCoordinatorLayout,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { resetUpstreamCheckForTests } from "@/lib/coordinator-upstream-check";
import { createSessionKey } from "@/lib/utils";
import { useCoordinatorPaneLayoutStore } from "@/stores/coordinatorPaneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useProjectStore } from "@/stores/projectStore";

const backendSnapshot = { ...realBackend };
const nativeAgentSnapshot = { ...realNativeAgent };

const gitStatus: ProjectGitStatus = {
  projectId: "project-1",
  repositoryRoot: "/checkout",
  revision: 1,
  branch: "main",
  detached: false,
  unborn: false,
  headCommit: "a".repeat(40),
  upstream: "origin/main",
  remote: "origin",
  ahead: 0,
  behind: 1,
  remoteState: "fresh",
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
  id: "main-1",
  tabId: "tab-main",
  logicalSessionKey: "coordinator-coordinator-1:main-1",
  agent: "codex",
  title: "Coordinator",
  role: "main",
  createdAt: new Date(0).toISOString(),
  mailboxIncarnationId: "incarnation-1",
};

function sideConversation(ordinal: number): CoordinatorConversation {
  return {
    ...mainConversation,
    id: `side-${ordinal}`,
    tabId: `tab-side-${ordinal}`,
    logicalSessionKey: `coordinator-coordinator-1:side-${ordinal}`,
    title: `Side ${ordinal}`,
    role: "side",
    sideOrdinal: ordinal,
  };
}

function snapshotOf(
  conversations: CoordinatorConversation[],
  selectedConversationId = conversations[0]!.id,
): CoordinatorSnapshot {
  return {
    workspace: {
      version: 1,
      id: "coordinator-1",
      projectId: "project-1",
      executionPolicy: "coordinator-read-only",
      lifecycleState: "ready",
      conversations,
      selectedConversationId,
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
}

function projectionOf(
  conversation: CoordinatorConversation,
  phase: NativeAgentSessionProjection["turn"]["phase"],
  messages: unknown[] = [],
): NativeAgentSessionProjection {
  return {
    platform: "codex",
    environmentId: coordinatorRuntimeId("coordinator-1", conversation.id),
    sessionId: `${conversation.id}-session`,
    connection: "connected",
    turn: { phase },
    messages,
    interactions: [],
    composerControls: [],
    capabilities: {},
    revision: 1,
    generation: "concurrency-test",
  } as unknown as NativeAgentSessionProjection;
}

const sessionKeyOf = (conversation: CoordinatorConversation) =>
  createSessionKey(coordinatorRuntimeId("coordinator-1", conversation.id), conversation.tabId);

function setPhase(
  conversation: CoordinatorConversation,
  phase: NativeAgentSessionProjection["turn"]["phase"],
  messages: unknown[] = [],
) {
  act(() => {
    useNativeAgentProjectionStore
      .getState()
      .setProjection(sessionKeyOf(conversation), projectionOf(conversation, phase, messages));
  });
}

let ensuredSnapshot = snapshotOf([mainConversation]);
let ensuredGit = gitStatus;
const ensure = mock(async () => ensuredSnapshot);
const getCoordinatorView = mock(async () => ({
  status: "snapshot",
  generation: "view-gen",
  revision: Date.now(),
  snapshot: ensuredSnapshot,
}));
const getGit = mock(async () => ensuredGit);
const fetchGit = mock(async () => ensuredGit);
const syncGit = mock(async () => ensuredGit);
const assignAgent = mock(
  async (_projectId: string, conversationId: string, platform: string): Promise<unknown> => {
    ensuredSnapshot = {
      ...ensuredSnapshot,
      workspace: {
        ...ensuredSnapshot.workspace,
        conversations: ensuredSnapshot.workspace.conversations.map((item) =>
          item.id === conversationId ? { ...item, agent: platform as "claude" } : item,
        ),
      },
    };
    return ensuredSnapshot;
  },
);
const closeConversation = mock(async (): Promise<CoordinatorSnapshot> => ensuredSnapshot);

mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  ensureProjectCoordinator: ensure,
  getProjectCoordinator: ensure,
  getProjectCoordinatorView: getCoordinatorView,
  getProjectGitStatus: getGit,
  fetchProjectGit: fetchGit,
  syncProjectGit: syncGit,
  checkCoordinatorUpstreamMerge: mock(async () => null),
  assignCoordinatorConversationAgent: assignAgent,
  closeCoordinatorConversation: closeConversation,
  selectCoordinatorConversation: mock(async () => ensuredSnapshot),
}));

mock.module("@/components/native-agent", () => ({
  ...nativeAgentSnapshot,
  AgentNativeTab: (props: Parameters<typeof realNativeAgent.AgentNativeTab>[0]) => (
    <div
      data-testid="native-agent"
      data-tab-id={props.tabId}
      data-initial-prompt={props.initialPrompt ?? ""}
    >
      {props.onAssignPlatform ? (
        <button
          type="button"
          onClick={() =>
            void props.onAssignPlatform!("claude", `First prompt for ${props.tabId}`, {
              fastMode: false,
            })
          }
        >
          {`Send in ${props.tabId}`}
        </button>
      ) : null}
    </div>
  ),
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

/** Two tab groups, each showing one of `first` and `second`. */
function showInTwoGroups(first: CoordinatorConversation, second: CoordinatorConversation) {
  const single = reconcileCoordinatorLayout(null, [first.id, second.id]);
  useCoordinatorPaneLayoutStore
    .getState()
    .setLayout(
      "project-1",
      splitCoordinatorPaneAtEdge(
        single,
        single.activePaneId,
        "right",
        second.id,
        single.activePaneId,
      ),
    );
}

const promptOf = (tabId: string) =>
  screen
    .getAllByTestId("native-agent")
    .find((agent) => agent.getAttribute("data-tab-id") === tabId)
    ?.getAttribute("data-initial-prompt");

beforeEach(() => {
  ensuredSnapshot = snapshotOf([mainConversation]);
  ensuredGit = gitStatus;
  for (const fn of [ensure, getCoordinatorView, getGit, fetchGit, syncGit, assignAgent]) {
    fn.mockClear();
  }
  closeConversation.mockClear();
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
  useNativeAgentProjectionStore.getState().reset();
  useCoordinatorPaneLayoutStore.getState().reset();
  resetUpstreamCheckForTests();
  resetClientStateCapabilitiesForTests();
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});

afterAll(() => {
  mock.module("@/lib/backend", () => backendSnapshot);
  mock.module("@/components/native-agent", () => nativeAgentSnapshot);
});

describe("first sends in two tab groups", () => {
  const unassignedSides = () => {
    const first = { ...sideConversation(1), agent: undefined };
    const second = { ...sideConversation(2), agent: undefined };
    ensuredSnapshot = snapshotOf([{ ...mainConversation }, first, second], first.id);
    showInTwoGroups(first, second);
    return { first, second };
  };

  test("each keeps its own prompt until its own turn is observed", async () => {
    const { first, second } = unassignedSides();
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("button", { name: "Send in tab-side-1" });

    // The second send lands before the first conversation's first projection.
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-1" }));
    await waitFor(() => expect(promptOf(first.tabId)).toBe("First prompt for tab-side-1"));
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-2" }));
    await waitFor(() => expect(promptOf(second.tabId)).toBe("First prompt for tab-side-2"));
    expect(promptOf(first.tabId)).toBe("First prompt for tab-side-1");

    // Each is released by its own observation and by nothing else.
    setPhase(first, "running");
    await waitFor(() => expect(promptOf(first.tabId)).toBe(""));
    expect(promptOf(second.tabId)).toBe("First prompt for tab-side-2");
    setPhase(second, "idle", [{ id: "opening", role: "user", text: "First prompt" }]);
    await waitFor(() => expect(promptOf(second.tabId)).toBe(""));
  });

  test("both observed in one update release together", async () => {
    const { first, second } = unassignedSides();
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("button", { name: "Send in tab-side-1" });
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-2" }));
    await waitFor(() => expect(promptOf(second.tabId)).toBe("First prompt for tab-side-2"));
    await waitFor(() => expect(promptOf(first.tabId)).toBe("First prompt for tab-side-1"));

    act(() => {
      const store = useNativeAgentProjectionStore.getState();
      store.setProjection(sessionKeyOf(first), projectionOf(first, "running"));
      store.setProjection(sessionKeyOf(second), projectionOf(second, "running"));
    });
    await waitFor(() => {
      expect(promptOf(first.tabId)).toBe("");
      expect(promptOf(second.tabId)).toBe("");
    });
  });

  test("closing a conversation lets go of the prompt its turn can no longer consume", async () => {
    const { first, second } = unassignedSides();
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("button", { name: "Send in tab-side-1" });
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-2" }));
    await waitFor(() => expect(promptOf(second.tabId)).toBe("First prompt for tab-side-2"));

    closeConversation.mockImplementationOnce(async () => {
      ensuredSnapshot = {
        ...ensuredSnapshot,
        workspace: {
          ...ensuredSnapshot.workspace,
          conversations: ensuredSnapshot.workspace.conversations.map((item) =>
            item.id === second.id ? { ...item, closedAt: new Date(0).toISOString() } : item,
          ),
        },
      };
      return ensuredSnapshot;
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Side 2" }));
    await waitFor(() => expect(promptOf(second.tabId)).toBeUndefined());
    expect(promptOf(first.tabId)).toBe("First prompt for tab-side-1");
  });
});

describe("Git and conversation actions", () => {
  const behindGit = () => ({ ...gitStatus, upstream: "origin/main", behind: 1, ahead: 0 });
  const refresh = () => screen.getByRole("button", { name: "Refresh repository status" });
  const newSideAgent = () =>
    screen
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("New side agent")) as HTMLButtonElement;
  const pauseButton = () => screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<T>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  async function renderSettled() {
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    await waitFor(() => expect(fetchGit).toHaveBeenCalled());
    await waitFor(() => expect(refresh().hasAttribute("disabled")).toBe(false));
  }

  test("a fetch in flight leaves the conversation controls enabled", async () => {
    ensuredGit = behindGit();
    await renderSettled();
    const fetch = deferred<ProjectGitStatus>();
    fetchGit.mockImplementationOnce(() => fetch.promise);
    fireEvent.click(refresh());

    await waitFor(() => expect(refresh().hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Sync" }).hasAttribute("disabled")).toBe(true);
    expect(newSideAgent().disabled).toBe(false);
    expect(pauseButton().disabled).toBe(false);

    await act(async () => fetch.resolve(ensuredGit));
    await waitFor(() => expect(refresh().hasAttribute("disabled")).toBe(false));
  });

  test("a conversation action in flight leaves the Git controls enabled", async () => {
    ensuredGit = behindGit();
    ensuredSnapshot = snapshotOf([mainConversation, sideConversation(1)]);
    await renderSettled();
    const close = deferred<CoordinatorSnapshot>();
    closeConversation.mockImplementationOnce(() => close.promise);
    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));

    await waitFor(() => expect(newSideAgent().disabled).toBe(true));
    expect(pauseButton().disabled).toBe(true);
    expect(refresh().hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Sync" }).hasAttribute("disabled")).toBe(false);

    await act(async () => close.resolve(ensuredSnapshot));
    await waitFor(() => expect(newSideAgent().disabled).toBe(false));
  });

  test("the first of two overlapping actions to finish does not release the other", async () => {
    ensuredSnapshot = snapshotOf([mainConversation, sideConversation(1), sideConversation(2)]);
    await renderSettled();
    const first = deferred<CoordinatorSnapshot>();
    const second = deferred<CoordinatorSnapshot>();
    closeConversation.mockImplementationOnce(() => first.promise);
    closeConversation.mockImplementationOnce(() => second.promise);
    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Side 2" }));
    await waitFor(() => expect(closeConversation).toHaveBeenCalledTimes(2));

    await act(async () => first.resolve(ensuredSnapshot));
    expect(newSideAgent().disabled).toBe(true);
    await act(async () => second.resolve(ensuredSnapshot));
    await waitFor(() => expect(newSideAgent().disabled).toBe(false));
  });

  test("closing a conversation clears the error an earlier action left", async () => {
    ensuredSnapshot = snapshotOf([mainConversation, sideConversation(1)]);
    await renderSettled();
    fetchGit.mockImplementationOnce(async () => {
      throw new Error("fetch went wrong");
    });
    fireEvent.click(refresh());
    expect(await screen.findByText("fetch went wrong")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));
    await waitFor(() => expect(closeConversation).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("fetch went wrong")).toBeNull());
  });
});
