/**
 * The conversation tab strip: tab semantics, the Main marker, Change agent,
 * the keyboard menu that moves tabs between groups, one selection write per
 * tab click, and the labelled loading state.
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
import {
  selectCoordinatorPaneLayout,
  useCoordinatorPaneLayoutStore,
} from "@/stores/coordinatorPaneLayoutStore";
import {
  collectCoordinatorLeaves,
  focusCoordinatorPane,
  moveCoordinatorConversation,
  reconcileCoordinatorLayout,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
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
/** Leaves the first read unanswered, so the panel stays in its loading state. */
let hangLoads = false;
const hang = () => new Promise<never>(() => {});
const ensure = mock(async () => (hangLoads ? hang() : ensuredSnapshot));
let viewRevision = 0;
let viewBody: CoordinatorSnapshot | null = null;
const getCoordinatorView = mock(
  async (_projectId: string, known: { generation: string; revision: number } | null) => {
    if (hangLoads) return hang();
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
const createConversation = mock(async (): Promise<CoordinatorSnapshot> => ensuredSnapshot);
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
  createCoordinatorConversation: createConversation,
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
        data-platform={props.data.platform ?? ""}
      />
    ),
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

describe("CoordinatorPanel tab strip", () => {
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
    closeConversation.mockImplementation(async () => ensuredSnapshot);
    createConversation.mockClear();
    createConversation.mockImplementation(async () => ensuredSnapshot);
    dispatchIntent.mockClear();
    ensureSession.mockClear();
    viewBody = null;
    hangLoads = false;
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

  function storedLayout() {
    return selectCoordinatorPaneLayout("project-1")(useCoordinatorPaneLayoutStore.getState())!;
  }

  test("marks the main tab only once side agents are open beside it", async () => {
    const single = render(<CoordinatorPanel projectId="project-1" />);
    const alone = await screen.findByRole("tab", { name: "Coordinator, Codex" });
    expect(alone.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-coordinator-main-marker]")).toBeNull();
    single.unmount();

    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    render(<CoordinatorPanel projectId="project-1" />);
    const main = await screen.findByRole("tab", { name: "Coordinator, main, Codex" });
    expect(main.querySelector("[data-coordinator-main-marker]")?.textContent).toBe("Main");
    const side = screen.getByRole("tab", { name: "Side 1, Codex" });
    expect(side.querySelector("[data-coordinator-main-marker]")).toBeNull();
    expect(main.getAttribute("aria-selected")).toBe("true");
    expect(side.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tablist", { name: "Coordinator conversations" })).toBeTruthy();
    // Change agent belongs to the main only.
    expect(screen.getAllByRole("button", { name: "Change agent" })).toHaveLength(1);
  });

  test("Change agent closes the main and opens an unassigned main in its place", async () => {
    const closedMain = { ...mainConversation, closedAt: new Date(1).toISOString() };
    const nextMain: CoordinatorConversation = {
      ...mainConversation,
      id: "main-2",
      tabId: "coordinator-tab-2",
      logicalSessionKey: "coordinator-coordinator-1:main-2",
      agent: undefined,
    };
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    closeConversation.mockImplementation(async () => {
      ensuredSnapshot = withWorkspace({
        conversations: [closedMain, sideConversation],
        selectedConversationId: "side-1",
      });
      return ensuredSnapshot;
    });
    createConversation.mockImplementation(async () => {
      ensuredSnapshot = withWorkspace({
        conversations: [closedMain, sideConversation, nextMain],
        selectedConversationId: "main-2",
      });
      return ensuredSnapshot;
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("tab", { name: "Coordinator, main, Codex" });

    fireEvent.click(screen.getByRole("button", { name: "Change agent" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Change the coordinator's agent?");
    expect(dialog.textContent).toContain("where you choose its agent");
    expect(dialog.textContent).toContain("Open delegations move to the new main");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep open" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(closeConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change agent" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Change agent" }));
    await waitFor(() => expect(createConversation).toHaveBeenCalledTimes(1));
    expect(closeConversation).toHaveBeenCalledWith("project-1", "conversation-1");
    expect(closeConversation.mock.invocationCallOrder[0]!).toBeLessThan(
      createConversation.mock.invocationCallOrder[0]!,
    );
    // The fresh main is unassigned, so its composer offers every platform.
    const fresh = await screen.findByRole("tab", {
      name: "Coordinator, main, no agent chosen yet",
    });
    await waitFor(() => expect(fresh.getAttribute("aria-selected")).toBe("true"));
    expect(
      screen
        .getAllByTestId("native-agent")
        .some((agent) => agent.getAttribute("data-tab-id") === "coordinator-tab-2"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Change agent" }) === null).toBe(true);
  });

  test("closing the main explains Change agent only when there is an agent to change", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    const assigned = render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("tab", { name: "Coordinator, main, Codex" });
    fireEvent.click(screen.getByRole("button", { name: /^Close Coordinator\./ }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "use Change agent instead",
    );
    assigned.unmount();

    ensuredSnapshot = withWorkspace({
      conversations: [{ ...mainConversation, agent: undefined }, sideConversation],
    });
    render(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("tab", { name: "Coordinator, main, no agent chosen yet" });
    fireEvent.click(screen.getByRole("button", { name: /^Close Coordinator\./ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("open delegations move to it");
    expect(dialog.textContent).not.toContain("Change agent");
  });

  test("the tab menu opens from the keyboard and moves a tab to a new group and back", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    render(<CoordinatorPanel projectId="project-1" />);
    const side = await screen.findByRole("tab", { name: "Side 1, Codex" });

    act(() => side.focus());
    fireEvent.keyDown(side, { key: "ContextMenu" });
    let menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Change agent…" }) === null).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to new group" }));
    await waitFor(() => expect(collectCoordinatorLeaves(storedLayout().root)).toHaveLength(2));
    const [left, right] = collectCoordinatorLeaves(storedLayout().root);
    expect(left!.conversationIds).toEqual(["conversation-1"]);
    expect(right!.conversationIds).toEqual(["side-1"]);
    expect(storedLayout().activePaneId).toBe(right!.id);
    await waitFor(() => expect(select).toHaveBeenCalledWith("project-1", "side-1"));
    await waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));

    const moved = screen.getByRole("tab", { name: "Side 1, Codex" });
    act(() => moved.focus());
    fireEvent.keyDown(moved, { key: "F10", shiftKey: true });
    menu = await screen.findByRole("menu");
    // A lone tab cannot open a group of its own.
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Move to new group" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to group 1" }));
    await waitFor(() => expect(collectCoordinatorLeaves(storedLayout().root)).toHaveLength(1));
    expect(collectCoordinatorLeaves(storedLayout().root)[0]!.conversationIds).toEqual([
      "conversation-1",
      "side-1",
    ]);

    // Right-click opens the same menu, with Change agent on the main.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Coordinator, main, Codex" }));
    menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Change agent…" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Change agent…" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "Change the coordinator's agent?",
    );
  });

  test("a click on a tab in another group writes the selection once", async () => {
    const sideTwo: CoordinatorConversation = {
      ...sideConversation,
      id: "side-2",
      tabId: "coordinator-side-2",
      logicalSessionKey: "coordinator-coordinator-1:side-2",
      title: "Side 2",
      sideOrdinal: 2,
    };
    ensuredSnapshot = withWorkspace({
      conversations: [mainConversation, sideConversation, sideTwo],
    });
    // Left: the main (focused). Right: Side 1 in front of Side 2.
    const single = reconcileCoordinatorLayout(null, ["conversation-1", "side-1", "side-2"]);
    const split = splitCoordinatorPaneAtEdge(
      single,
      single.activePaneId,
      "right",
      "side-1",
      single.activePaneId,
    );
    const [, right] = collectCoordinatorLeaves(split.root);
    const grouped = focusCoordinatorPane(
      moveCoordinatorConversation(split, single.activePaneId, right!.id, "side-2"),
      right!.id,
      "side-1",
    );
    useCoordinatorPaneLayoutStore
      .getState()
      .setLayout("project-1", { ...grouped, activePaneId: single.activePaneId });
    render(<CoordinatorPanel projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
    await waitFor(() => expect(storedLayout().activePaneId).toBe(single.activePaneId));
    select.mockClear();

    const tab = screen.getByRole("tab", { name: "Side 2, Codex" });
    fireEvent.pointerDown(tab);
    fireEvent.mouseDown(tab);
    fireEvent.focus(tab);
    fireEvent.mouseUp(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(select).toHaveBeenCalledWith("project-1", "side-2"));
    await waitFor(() => expect(storedLayout().activePaneId).toBe(right!.id));
    expect(select).toHaveBeenCalledTimes(1);
  });

  test("the loading state is announced, and New side agent keeps its name when only its icon shows", async () => {
    hangLoads = true;
    const loading = render(<CoordinatorPanel projectId="project-1" />);
    expect((await screen.findByRole("status")).textContent).toBe("Loading coordinator");
    loading.unmount();

    hangLoads = false;
    render(<CoordinatorPanel projectId="project-1" />);
    const create = await screen.findByRole("button", { name: "New side agent" });
    expect(create.getAttribute("title")).toBe("New side agent");
    expect(create.querySelector("span")?.className).toContain("max-sm:sr-only");
  });
});
