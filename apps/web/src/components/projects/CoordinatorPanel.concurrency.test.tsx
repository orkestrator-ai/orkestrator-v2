/**
 * What the panel does while several things happen at once: first sends in two
 * tab groups, a Git action beside a conversation action, and a turn in a
 * conversation other than the focused one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import type { CoordinatorCheckoutTurn } from "@orkestrator/protocol/coordinator-activity";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import * as realObservation from "@/lib/native-observation-events";
import type { NativeObservationInvalidation } from "@/lib/native-observation-events";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import {
  reconcileCoordinatorLayout,
  revealCoordinatorConversation,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { resetUpstreamCheckForTests } from "@/lib/coordinator-upstream-check";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { createSessionKey } from "@/lib/utils";
import { coordinatorPaneLayoutStore } from "@/stores/coordinatorPaneLayoutStore";
import { environmentStore } from "@/stores/environmentStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { projectStore } from "@/stores/projectStore";

const observationSnapshot = { ...realObservation };
const observationListeners = new Set<(hint: NativeObservationInvalidation) => void>();
mock.module("@/lib/native-observation-events", () => ({
  ...observationSnapshot,
  subscribeNativeObservationInvalidations: (
    listener: (hint: NativeObservationInvalidation) => void,
  ) => {
    observationListeners.add(listener);
    return () => {
      observationListeners.delete(listener);
    };
  },
}));
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
    appCommandStore(nativeAgentProjectionStore)
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
const switchBranch = mock(async () => ensuredGit);
const prepareSwitch = mock(async (_projectId: string, ref: string) => ({
  ref,
  token: "confirm-token",
  trackedChanges: 1,
  untrackedFiles: 0,
  nestedRepositories: [],
  dirtySubmodules: [],
  requiresEnhancedConfirmation: false,
}));
const getCheckoutTurn = mock(async (): Promise<CoordinatorCheckoutTurn | null> => null);

mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  ensureProjectCoordinator: ensure,
  getProjectCoordinatorView: getCoordinatorView,
  getProjectGitStatus: getGit,
  fetchProjectGit: fetchGit,
  syncProjectGit: syncGit,
  switchProjectGitBranch: switchBranch,
  prepareProjectGitBranchSwitch: prepareSwitch,
  checkCoordinatorUpstreamMerge: mock(async () => null),
  assignCoordinatorConversationAgent: assignAgent,
  closeCoordinatorConversation: closeConversation,
  getCoordinatorCheckoutTurn: getCheckoutTurn,
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
import { appCommandStore } from "@/test/app-command-store";

/** Two tab groups, each showing one of `first` and `second`. */
function showInTwoGroups(first: CoordinatorConversation, second: CoordinatorConversation) {
  const single = reconcileCoordinatorLayout(null, [first.id, second.id]);
  appCommandStore(coordinatorPaneLayoutStore)
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
  switchBranch.mockClear();
  prepareSwitch.mockClear();
  getCheckoutTurn.mockReset();
  getCheckoutTurn.mockImplementation(async () => null);
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(projectStore).setState({
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
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  appCommandStore(coordinatorPaneLayoutStore).getState().reset();
  resetUpstreamCheckForTests();
  resetClientStateCapabilitiesForTests();
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});

afterAll(() => {
  mock.module("@/lib/backend", () => backendSnapshot);
  mock.module("@/lib/native-observation-events", () => observationSnapshot);
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("button", { name: "Send in tab-side-1" });
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Send in tab-side-2" }));
    await waitFor(() => expect(promptOf(second.tabId)).toBe("First prompt for tab-side-2"));
    await waitFor(() => expect(promptOf(first.tabId)).toBe("First prompt for tab-side-1"));

    act(() => {
      const store = appCommandStore(nativeAgentProjectionStore).getState();
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
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

  test("a pending conversation action prevents a second shell close", async () => {
    ensuredSnapshot = snapshotOf([mainConversation, sideConversation(1), sideConversation(2)]);
    await renderSettled();
    const first = deferred<CoordinatorSnapshot>();
    closeConversation.mockImplementationOnce(() => first.promise);
    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));
    await waitFor(() => expect(closeConversation).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Close Side 2" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(newSideAgent().disabled).toBe(true);

    await act(async () => first.resolve(ensuredSnapshot));
    await waitFor(() => expect(newSideAgent().disabled).toBe(false));
    expect(screen.getByRole("button", { name: "Close Side 2" })).toBeTruthy();
    expect(closeConversation).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(screen.queryByText("fetch went wrong") === null).toBe(true));
  });
});

describe("branch switch and Sync while any turn runs", () => {
  const side = sideConversation(1);
  const branchPicker = () => screen.getByRole("combobox");
  const sync = () => screen.getByRole("button", { name: "Sync" });
  const refresh = () => screen.getByRole("button", { name: "Refresh repository status" });
  const gated = () => branchPicker().hasAttribute("disabled") && sync().hasAttribute("disabled");

  /** The side agent in front; the main conversation's tab is behind it, so it is not mounted. */
  async function renderSideFocused() {
    ensuredSnapshot = snapshotOf([mainConversation, side], side.id);
    appCommandStore(coordinatorPaneLayoutStore)
      .getState()
      .setLayout(
        "project-1",
        revealCoordinatorConversation(
          reconcileCoordinatorLayout(null, [mainConversation.id, side.id]),
          side.id,
        ),
      );
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("native-agent").getAttribute("data-tab-id")).toBe(side.tabId),
    );
    await waitFor(() => expect(getCheckoutTurn).toHaveBeenCalled());
  }

  let checkoutHintRevision = 10000;
  async function backendAnswers(turn: CoordinatorCheckoutTurn | null) {
    const reads = getCheckoutTurn.mock.calls.length;
    getCheckoutTurn.mockImplementation(async () => turn);
    await act(async () => {
      dispatchResourceChange({
        resource: "coordinator",
        id: "project-1",
        projectId: "project-1",
        revision: ++checkoutHintRevision,
      });
    });
    await waitFor(() => expect(getCheckoutTurn.mock.calls.length).toBeGreaterThan(reads), {
      timeout: 3000,
    });
  }

  test("a turn in a conversation behind the focused side agent disables both and names it", async () => {
    getCheckoutTurn.mockImplementation(async () => ({
      kind: "conversation",
      conversationId: mainConversation.id,
    }));
    await renderSideFocused();

    await waitFor(() => expect(gated()).toBe(true));
    const reason =
      "Coordinator is running a turn. Branch switching and Sync wait for it to finish.";
    expect(branchPicker().getAttribute("title")).toBe(reason);
    expect(sync().closest("span")?.getAttribute("title")).toBe(reason);
    // Reading the remote changes nothing a turn is working on.
    expect(refresh().hasAttribute("disabled")).toBe(false);

    await backendAnswers(null);
    await waitFor(() => expect(gated()).toBe(false));
    expect(branchPicker().getAttribute("title")).toBe("Switch branch");
    expect(sync().closest("span")?.hasAttribute("title")).toBe(false);
  });

  test.each([
    { kind: "project-home" } as const,
    { kind: "conversation", conversationId: mainConversation.id } as const,
  ])("an open discard confirmation waits for %j to finish", async (turn) => {
    ensuredGit = {
      ...gitStatus,
      trackedChanges: 1,
      branches: [
        ...gitStatus.branches,
        { ref: "refs/heads/feature", name: "feature", kind: "local" },
      ],
    };
    await renderSideFocused();
    await waitFor(() => expect(branchPicker().hasAttribute("disabled")).toBe(false));
    fireEvent.click(branchPicker());
    fireEvent.click(await screen.findByRole("option", { name: "feature" }));
    const confirm = await screen.findByRole("button", { name: "Discard and switch" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await backendAnswers(turn);
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("alertdialog").querySelector('[role="status"]')?.textContent).toContain(
      "is running a turn",
    );
    fireEvent.click(confirm);
    expect(switchBranch).not.toHaveBeenCalled();
    await backendAnswers(null);
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(switchBranch).toHaveBeenCalledWith("project-1", "refs/heads/feature", {
        confirmationToken: "confirm-token",
        includeNestedRepositories: false,
      }),
    );
  });

  test("a failed read retains the last Home blocker until a successful idle answer", async () => {
    const { clock } = installFakeReadCoordinator();
    getCheckoutTurn.mockImplementation(async () => ({ kind: "project-home" }));
    await renderSideFocused();
    await waitFor(() => expect(gated()).toBe(true));
    const reads = getCheckoutTurn.mock.calls.length;
    let reject!: (error: Error) => void;
    getCheckoutTurn.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    act(() =>
      dispatchResourceChange({
        resource: "coordinator",
        id: "project-1",
        revision: ++checkoutHintRevision,
      }),
    );
    await waitFor(() => expect(getCheckoutTurn.mock.calls.length).toBeGreaterThan(reads), {
      timeout: 3000,
    });
    await act(async () => reject(new Error("Home activity unavailable")));
    expect(gated()).toBe(true);
    expect(branchPicker().getAttribute("title")).toStartWith("Home is running a turn.");
    getCheckoutTurn.mockImplementation(async () => null);
    await act(async () => {
      await clock.advance(30_000);
    });
    await waitFor(() => expect(gated()).toBe(false));
  });

  test.each(["observation", "session"] as const)(
    "%s hints filter by Home and workspace runtime IDs",
    async (source) => {
      appCommandStore(environmentStore).setState({
        environments: [
          { id: "home-1", projectId: "project-1", projectHome: true },
          { id: "other-home", projectId: "other-project", projectHome: true },
          { id: "ordinary", projectId: "project-1", projectHome: false },
        ] as never,
      });
      await renderSideFocused();
      await waitFor(() => expect(gated()).toBe(false));
      let revision = 1000;
      const hint = (environmentId: string) =>
        act(() => {
          if (source === "observation") {
            for (const listener of observationListeners)
              listener({ kind: "session", environmentId });
          } else
            dispatchResourceChange({
              resource: "native-agent-session",
              id: environmentId,
              revision: revision++,
            });
        });
      const reads = getCheckoutTurn.mock.calls.length;
      hint("other-home");
      hint("ordinary");
      hint(coordinatorRuntimeId("another-workspace", mainConversation.id));
      // A matching hint below is a scheduling barrier: only that hint should read.
      getCheckoutTurn.mockImplementation(async () => ({ kind: "project-home" }));
      hint("home-1");
      await waitFor(() => expect(gated()).toBe(true));
      expect(getCheckoutTurn.mock.calls.length).toBe(reads + 1);
      getCheckoutTurn.mockImplementation(async () => null);
      hint(coordinatorRuntimeId("coordinator-1", side.id));
      await waitFor(() => expect(gated()).toBe(false));
      expect(getCheckoutTurn.mock.calls.length).toBe(reads + 2);
      if (source === "observation") {
        getCheckoutTurn.mockImplementation(async () => ({ kind: "project-home" }));
        act(() => {
          for (const listener of observationListeners) listener({ kind: "all", reason: "gap" });
        });
        await waitFor(() => expect(gated()).toBe(true));
      }
    },
  );

  test("the project home's turn disables both and is named", async () => {
    getCheckoutTurn.mockImplementation(async () => ({ kind: "project-home" }));
    await renderSideFocused();
    await waitFor(() => expect(gated()).toBe(true));
    expect(branchPicker().getAttribute("title")).toStartWith("Home is running a turn.");
  });

  test("coming back to the panel sees a turn that started while it was away", async () => {
    const away = renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(getCheckoutTurn).toHaveBeenCalled());
    await screen.findByTestId("native-agent");
    await waitFor(() => expect(gated()).toBe(false));
    away.unmount();

    // Started from the project home's own tab: nothing hints a panel that is not there.
    getCheckoutTurn.mockImplementation(async () => ({ kind: "project-home" }));
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(gated()).toBe(true));
    expect(branchPicker().getAttribute("title")).toStartWith("Home is running a turn.");
  });

  test("a turn that ended behind another tab does not hold the controls", async () => {
    // Nothing rewrites this projection while its tab is not mounted, so it still
    // says running. The backend is the one that knows the turn is over.
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(sessionKeyOf(mainConversation), projectionOf(mainConversation, "running"));
    await renderSideFocused();
    await waitFor(() => expect(gated()).toBe(false));
  });

  test("a mounted conversation counts before the backend has observed its turn", async () => {
    ensuredSnapshot = snapshotOf([mainConversation, side], side.id);
    showInTwoGroups(mainConversation, side);
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    await waitFor(() => expect(getCheckoutTurn).toHaveBeenCalled());
    await waitFor(() => expect(gated()).toBe(false));

    setPhase(mainConversation, "running");
    await waitFor(() => expect(gated()).toBe(true));
    expect(branchPicker().getAttribute("title")).toStartWith("Coordinator is running a turn.");

    setPhase(mainConversation, "idle");
    await waitFor(() => expect(gated()).toBe(false));
  });

  test.each([
    ["has no such command", () => Promise.reject(new Error("Unknown backend command: x"))],
    ["has not answered yet", () => new Promise<null>(() => undefined)],
  ])("a backend that %s leaves every projection to go on", async (_name, answer) => {
    getCheckoutTurn.mockImplementation(answer);
    appCommandStore(environmentStore).setState({
      environments: [{ id: "home-1", projectId: "project-1", projectHome: true } as never],
    });
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(sessionKeyOf(mainConversation), projectionOf(mainConversation, "running"));
    await renderSideFocused();
    await waitFor(() => expect(gated()).toBe(true));
    expect(branchPicker().getAttribute("title")).toStartWith("Coordinator is running a turn.");

    setPhase(mainConversation, "idle");
    await waitFor(() => expect(gated()).toBe(false));
    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection("home-session", {
          ...projectionOf(mainConversation, "running"),
          environmentId: "home-1",
        });
    });
    await waitFor(() => expect(gated()).toBe(true));
    expect(branchPicker().getAttribute("title")).toStartWith("Home is running a turn.");
  });
});
