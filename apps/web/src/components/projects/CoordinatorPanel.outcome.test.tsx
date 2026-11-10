/**
 * The panel's outcome-first wording and its no-dead-end states: the composer
 * placeholder and starter prompts, the isolation badge, banners that leave the
 * transcript visible, separate errors, and the main-only close confirmation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import { createNativeAgentSessionBackend } from "@/test/native-agent-session-backend";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import * as clipboard from "@/lib/native/clipboard";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { onGlobalSettingsRequest } from "@/lib/settings-navigation";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { agentMailStore } from "@/stores/agentMailStore";
import { configStore } from "@/stores/configStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { projectStore } from "@/stores/projectStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { coordinatorPaneLayoutStore } from "@/stores/coordinatorPaneLayoutStore";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { resetUpstreamCheckForTests } from "@/lib/coordinator-upstream-check";
import { resetNativeAgentSyncCapabilityForTests } from "@/hooks/useNativeAgentSession";
import { createSessionKey } from "@/lib/utils";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";

/** Outside a node scope provider, components act for the app's command node. */
const commandNodeId = () => getWindowScope().commandScope().nodeId;

const backendSnapshot = { ...realBackend };
const nativeAgentSnapshot = { ...realNativeAgent };
const initialConfig = appCommandStore(configStore).getState().config;
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
const retryConversation = mock(async (): Promise<CoordinatorSnapshot> => ensuredSnapshot);
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

// The conversation's session as the fake backend holds it.
const sessionBackend = createNativeAgentSessionBackend({ readProjection: () => agentProjection });
mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  getLocalFileTree: mock(async () => []),
  getNativeAgentModelCatalog: mock(async () => [
    { platform: "claude", id: "claude-sonnet-5", label: "Claude Sonnet" },
  ]),
  ensureProjectCoordinator: ensure,
  getProjectCoordinatorView: getCoordinatorView,
  getProjectGitStatus: getGit,
  fetchProjectGit: fetchGit,
  syncProjectGit: async () => {
    ensuredGit = {
      ...ensuredGit,
      lastError: {
        operation: "sync",
        message: "sync failed",
        stderr: "sync failed",
        occurredAt: new Date(0).toISOString(),
        retryable: true,
      },
    };
    throw new Error("sync failed");
  },
  checkCoordinatorUpstreamMerge: mock(async () => null),
  declineCoordinatorUpstreamMerge: mock(async () => undefined),
  getCoordinatorUpstreamAutoMerge: mock(async () => ({ enabled: false })),
  setCoordinatorUpstreamAutoMerge: mock(async () => ({ enabled: false })),
  pauseProjectCoordinator: pause,
  resumeProjectCoordinator: resume,
  selectCoordinatorConversation: select,
  closeCoordinatorConversation: closeConversation,
  retryCoordinatorConversation: retryConversation,
  assignCoordinatorConversationAgent: assignAgent,
  ensureNativeAgentSession: ensureSession,
  ...sessionBackend.api,
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
      >
        <div data-testid="composer-hint">{props.composerHint}</div>
        {props.unassignedIntro ? <div data-testid="intro-slot">{props.unassignedIntro}</div> : null}
      </div>
    ),
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import {
  COORDINATOR_COMPOSER_PLACEHOLDER,
  COORDINATOR_STARTER_PROMPTS,
} from "./CoordinatorPanelNotices";
import { COORDINATOR_INTRO_LINES } from "./CoordinatorIntro";
import { FIRST_MESSAGE_COMMAND_RULE } from "@/components/native-agent/AgentNativeTab.helpers";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { appCommandStore } from "@/test/app-command-store";

async function openBadgeDetails(): Promise<Element> {
  return waitFor(() => {
    const element = document.querySelector("[data-coordinator-isolation-details]");
    if (!element) throw new Error("badge details not open");
    return element;
  });
}

const unassigned = (conversation: CoordinatorConversation) => ({
  ...conversation,
  agent: undefined,
});

function installPendingMail(): void {
  const environmentId = coordinatorRuntimeId("coordinator-1", mainConversation.id);
  const mailboxId = `${environmentId}\0${mainConversation.tabId}`;
  appCommandStore(agentMailStore).setState({
    summary: new Map([
      [
        mailboxId,
        {
          mailboxId,
          projectId: "project-1",
          environmentId,
          tabId: mainConversation.tabId,
          unreadCount: 1,
          userUnseenCount: 1,
          agentUnackedCount: 1,
          pendingInjectCount: 1,
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
            mailboxId,
            incarnationId: "incarnation-1",
            projectId: "project-1",
            projectName: "Project",
            environmentId,
            environmentName: "Coordinator",
            environmentStatus: "running",
            tabId: mainConversation.tabId,
            tabType: "agent-native",
            title: "Coordinator",
            displayName: "Coordinator",
            tabOrdinal: 1,
            agent: "codex",
            kind: "native",
            presence: "idle",
            injectPolicy: "idle",
            injectOverride: "idle",
            mutedInbound: false,
            mutedOutbound: false,
            unreadCount: 1,
            userUnseenCount: 1,
            agentUnackedCount: 1,
            pendingInjectCount: 1,
            failedInjectCount: 0,
            capabilities: { canPull: true, canSend: true, canInject: true },
          },
          messages: [
            {
              version: 1,
              id: "pending-mail",
              threadId: "thread-1",
              requestId: "mail-request-1",
              createdAt: new Date(0).toISOString(),
              from: { kind: "user" },
              toEnvironmentId: environmentId,
              toTabId: mainConversation.tabId,
              toIncarnationId: "incarnation-1",
              bodyBytes: 5,
              trust: "user",
              injectDepth: 0,
              threadDepth: 0,
              placement: "pending-inject",
              revision: 1,
            },
          ],
          total: 1,
          offset: 0,
          limit: 100,
          revision: 1,
        },
      ],
    ]),
    refreshSummary: async () => undefined,
    refreshMailbox: async () => undefined,
  });
}

describe("CoordinatorPanel outcome-first wording and banners", () => {
  beforeEach(() => {
    useRealAgentTab = false;
    appCommandStore(agentMailStore).setState(appCommandStore(agentMailStore).getInitialState());
    useUIChromeStore.setState({ coordinatorIntroDismissed: false });
    resetNativeAgentSyncCapabilityForTests();
    appCommandStore(configStore).setState({ config: initialConfig });
    appCommandStore(nativeComposeStore).getState().clearDraft(sessionKey);
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    appCommandStore(coordinatorPaneLayoutStore).getState().reset();
    resetUpstreamCheckForTests();
    resetClientStateCapabilitiesForTests();
    for (const fn of [ensure, getCoordinatorView, getGit, fetchGit, select, assignAgent]) {
      fn.mockClear();
    }
    pause.mockClear();
    resume.mockClear();
    closeConversation.mockClear();
    retryConversation.mockClear();
    dispatchIntent.mockClear();
    ensureSession.mockClear();
    viewBody = null;
    ensuredSnapshot = baseSnapshot;
    ensuredGit = gitStatus;
    agentProjection = projection();
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    const main = await screen.findByTestId("native-agent");
    expect(main.getAttribute("data-placeholder")).toBe(
      "What would you like to get done? Type @ to mention a file, or start with ! to run a command yourself.",
    );
    expect(main.getAttribute("data-starter-prompts")).toBe(COORDINATOR_STARTER_PROMPTS.join("|"));

    fireEvent.click(screen.getByRole("tab", { name: "Side 1, Codex" }));
    await waitFor(() =>
      expect(screen.getByTestId("native-agent").getAttribute("data-tab-id")).toBe(
        "coordinator-side-1",
      ),
    );
    const side = screen.getByTestId("native-agent");
    expect(side.getAttribute("data-placeholder")).toBe(
      "Ask a question about this project. Type @ to mention a file, or start with ! to run a command yourself.",
    );
    expect(side.getAttribute("data-starter-prompts")).toBe("");
  });

  test("only a side composer has a hint line, saying what a side agent is for", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    // The main's @ and ! guidance is in its placeholder, not a line under it.
    const mainHint = (await screen.findByTestId("composer-hint")).textContent ?? "";
    expect(mainHint).toBe("");
    expect(screen.getByTestId("intro-slot")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Side 1, Codex" }));
    await waitFor(() =>
      expect(screen.getByTestId("native-agent").getAttribute("data-tab-id")).toBe(
        "coordinator-side-1",
      ),
    );
    const sideHint = screen.getByTestId("composer-hint").textContent ?? "";
    expect(sideHint).toContain("can't launch workers");
    expect(sideHint).toContain("Good for a second opinion or a parallel investigation.");
    expect(sideHint).not.toContain("!");
    // The first-run card is the main's: a side agent never offers it.
    expect(screen.queryByTestId("intro-slot") === null).toBe(true);
  });

  test("the panel has no footer line; the header badge says where changes run", async () => {
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    expect(
      screen.queryByText(/The coordinator hands code changes, builds and fixes/) === null,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Changes run in isolated environments/ }),
    ).toBeTruthy();
  });

  test("the first-run card explains the coordinator until dismissed, and ? shows it again", async () => {
    useUIChromeStore.setState({ coordinatorIntroDismissed: false });
    useRealAgentTab = true;
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude"],
        agentSettings: { defaultAgent: "claude" },
      });
    ensuredSnapshot = withWorkspace({ conversations: [unassigned(mainConversation)] });
    const view = renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);

    const card = await screen.findByRole("region", { name: "How the coordinator works" });
    for (const line of COORDINATOR_INTRO_LINES) expect(card.textContent).toContain(line);
    expect(card.textContent).toContain("never changes it");
    expect(card.textContent).toContain("Change agent");
    // The starter prompts stay offered beside it.
    expect(screen.getByRole("group", { name: "Starter prompts" })).toBeTruthy();

    fireEvent.click(
      within(card).getByRole("button", { name: "Dismiss how the coordinator works" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "How the coordinator works" }) === null).toBe(
        true,
      ),
    );
    // Per user, in the UI store: it stays dismissed after a remount.
    expect(useUIChromeStore.getState().coordinatorIntroDismissed).toBe(true);
    view.unmount();
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("textbox", { name: COORDINATOR_COMPOSER_PLACEHOLDER });
    expect(screen.queryByRole("region", { name: "How the coordinator works" }) === null).toBe(true);

    // The toolbar's ? shows the same lines, whatever the composer's state.
    fireEvent.pointerDown(screen.getByRole("button", { name: "How the coordinator works" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await waitFor(() => {
      const element = document.querySelector("[data-coordinator-intro-menu]");
      if (!element) throw new Error("intro menu not open");
      return element;
    });
    for (const line of COORDINATOR_INTRO_LINES) expect(menu.textContent).toContain(line);
  });

  test("a first message starting with ! shows the rule under the composer, not only a toast", async () => {
    useRealAgentTab = true;
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude"],
        agentSettings: { defaultAgent: "claude" },
      });
    ensuredSnapshot = withWorkspace({ conversations: [unassigned(mainConversation)] });
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    const input = await screen.findByRole("textbox", { name: COORDINATOR_COMPOSER_PLACEHOLDER });
    expect(document.querySelector("[data-composer-hint]") === null).toBe(true);

    fireEvent.input(input, { target: { textContent: "!git status" } });
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
        "!git status",
      ),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    const rule = await screen.findByRole("alert");
    expect(rule.textContent).toBe(FIRST_MESSAGE_COMMAND_RULE);
    expect(rule.hasAttribute("data-unassigned-command-refusal")).toBe(true);
    // Nothing started, and the text is still in the box.
    expect(assignAgent).not.toHaveBeenCalled();
    expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
      "!git status",
    );

    // Still shown while the text is a command; gone once the ! is dropped.
    fireEvent.input(input, { target: { textContent: "!git status --short" } });
    await waitFor(() =>
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
        "!git status --short",
      ),
    );
    expect(screen.getByRole("alert").textContent).toBe(FIRST_MESSAGE_COMMAND_RULE);
    fireEvent.input(input, { target: { textContent: "git status --short" } });
    await waitFor(() => expect(screen.queryByText(FIRST_MESSAGE_COMMAND_RULE) === null).toBe(true));
    expect(document.querySelector("[data-composer-hint]") === null).toBe(true);
  });

  test("an empty conversation's starter prompt fills the real message box without sending", async () => {
    useRealAgentTab = true;
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude"],
        agentSettings: { defaultAgent: "claude" },
      });
    ensuredSnapshot = withWorkspace({ conversations: [unassigned(mainConversation)] });
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);

    const input = await screen.findByRole("textbox", { name: COORDINATOR_COMPOSER_PLACEHOLDER });
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
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
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
      expect(appCommandStore(nativeComposeStore).getState().drafts.get(sessionKey)?.text).toBe(
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByRole("textbox");
    await waitFor(() =>
      expect(
        appCommandStore(nativeAgentProjectionStore).getState().projections.get(sessionKey)?.messages
          .length,
      ).toBe(1),
    );
    expect(screen.queryByRole("group", { name: "Starter prompts" }) === null).toBe(true);
    for (const starter of COORDINATOR_STARTER_PROMPTS) {
      expect(screen.queryByRole("button", { name: starter }) === null).toBe(true);
    }
  });

  test("the badge names the enforced tier and keeps the path and revision one tap away", async () => {
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    const badge = await screen.findByRole("button", {
      name: /Changes run in isolated environments/,
    });
    expect(badge.getAttribute("data-coordinator-isolation-badge")).toBe("enforced");
    expect(badge.className).toContain("emerald");
    expect(badge.textContent).toContain("Read-only · Enforced");
    expect(badge.textContent).not.toContain("dvisory");
    expect(screen.queryByText("Read-only coordinator") === null).toBe(true);
    // Neither the path nor the revision is header text any more.
    expect(screen.queryByText("/checkout") === null).toBe(true);
    expect(screen.queryByText(/Context r7/) === null).toBe(true);

    // A menu, so it opens by keyboard and touch as well as by pointer.
    act(() => badge.focus());
    fireEvent.keyDown(badge, { key: "Enter" });
    const details = await openBadgeDetails();
    expect(details.textContent).toContain("reads this checkout but never changes it");
    expect(details.textContent).toContain("build pipelines or prompt environments");
    expect(details.textContent).toContain("Codex's read-only protection is enforced.");
    expect(details.textContent).toContain("blocks changes, whatever the agent attempts");
    expect(details.textContent).toContain("/checkout");
    expect(details.textContent).toContain("r7");
    expect(details.textContent).not.toContain("dvisory");
  });

  test("a provider-configured platform is named as such, never as advisory, and links its setting", async () => {
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
    const opened: string[] = [];
    const stop = onGlobalSettingsRequest((section) => opened.push(section));
    try {
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      const badge = await screen.findByRole("button", {
        name: /Changes run in isolated environments/,
      });
      await waitFor(() =>
        expect(badge.getAttribute("data-coordinator-isolation-badge")).toBe("provider-configured"),
      );
      expect(badge.textContent).toContain("Read-only · Provider-configured");
      expect(badge.textContent).not.toContain("dvisory");
      expect(badge.className).toContain("amber");

      fireEvent.pointerDown(badge, { button: 0, ctrlKey: false });
      const details = await openBadgeDetails();
      expect(details.textContent).toContain("Codex's read-only protection is provider-configured.");
      expect(details.textContent).toContain("no way for Orkestrator to verify");
      expect(details.textContent).not.toContain("dvisory");

      fireEvent.click(
        within(details as HTMLElement).getByRole("menuitem", {
          name: "Coordinator safety level in Settings",
        }),
      );
      expect(opened).toEqual(["coordinator"]);
    } finally {
      stop();
    }
  });

  test("an advisory platform is the only one the badge calls advisory", async () => {
    ensuredSnapshot = withWorkspace(
      { conversations: [{ ...mainConversation, agent: "grok" }] },
      {
        providerAvailability: {
          grok: { tier: "advisory", available: true, reason: "Grok is asked.", delegation: true },
        },
      },
    );
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    const badge = await screen.findByRole("button", {
      name: /Changes run in isolated environments/,
    });
    await waitFor(() =>
      expect(badge.getAttribute("data-coordinator-isolation-badge")).toBe("advisory"),
    );
    expect(badge.textContent).toContain("Read-only · Advisory");
    fireEvent.pointerDown(badge, { button: 0, ctrlKey: false });
    const details = await openBadgeDetails();
    expect(details.textContent).toContain("Grok Build's read-only protection is advisory.");
    expect(details.textContent).toContain("a tool that does not ask is not stopped");
  });

  test.each([
    ["paused", "Coordination is paused. Resume to send."],
    ["error", "The coordinator could not start. Retry to send."],
    ["startup-failed", "This conversation could not start. Retry to send."],
  ] as const)("a %s pane holds mail across remount until recovery", async (hold, reason) => {
    ensuredSnapshot = withWorkspace(
      hold === "startup-failed"
        ? { conversations: [{ ...mainConversation, startupError: "bridge failed" }] }
        : { lifecycleState: hold },
    );
    installPendingMail();
    const mounted = renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(`Delivery waiting: ${reason}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
    mounted.unmount();
    const remounted = renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText(`Delivery waiting: ${reason}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();

    remounted.unmount();
    ensuredSnapshot = baseSnapshot;
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByRole("button", { name: "Deliver now" })).toBeTruthy();
    expect(screen.queryByText(`Delivery waiting: ${reason}`) === null).toBe(true);
  });

  test("paused coordination keeps the transcript and resumes from the banner", async () => {
    ensuredSnapshot = withWorkspace({ lifecycleState: "paused" });
    resume.mockImplementationOnce(async () => withWorkspace({ lifecycleState: "ready" }));
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);

    const banner = await screen.findByText(/Coordination is paused/);
    expect(banner.textContent).toContain("Mail and new turns wait until you resume");
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);

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
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
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
          appCommandStore(nativeAgentProjectionStore).getState().projections.get(sessionKey)
            ?.connection,
        ).toBe("connected"),
      );
      const input = await screen.findByRole("textbox");
      expect(input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder")).toBe(
        COORDINATOR_COMPOSER_PLACEHOLDER,
      );
      fireEvent.input(input, { target: { textContent: "Review this branch" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(dispatchIntent).toHaveBeenCalled());
      expect(input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder")).toBe(
        COORDINATOR_COMPOSER_PLACEHOLDER,
      );
    },
  );

  describe("a conversation that failed to start", () => {
    const failedSide = {
      ...sideConversation,
      startupError: "codex server exited before becoming healthy",
    };

    function renderFailed(conversations: CoordinatorConversation[] = [failedSide]) {
      ensuredSnapshot = withWorkspace({
        conversations,
        selectedConversationId: conversations[0]!.id,
      });
      return renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    }

    test("is named in its own pane, whose transcript stays, and blames nothing else", async () => {
      renderFailed();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Side 1 could not start.");
      expect(alert.textContent).toContain("codex server exited before becoming healthy");
      expect(screen.getByTestId("native-agent")).toBeTruthy();
      expect(
        alert.compareDocumentPosition(screen.getByTestId("native-agent")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByText(/Coordinator startup failed/) === null).toBe(true);
    });

    test("another conversation in front shows nothing and still connects", async () => {
      useRealAgentTab = true;
      renderFailed([mainConversation, failedSide]);
      await waitFor(() => expect(ensureSession).toHaveBeenCalled());
      expect(screen.queryByText(/could not start/) === null).toBe(true);
    });

    test("Retry clears it through the backend, so the pane connects again", async () => {
      useRealAgentTab = true;
      renderFailed();
      const alert = await screen.findByRole("alert");
      expect(ensureSession).not.toHaveBeenCalled();
      retryConversation.mockImplementationOnce(async () =>
        withWorkspace({
          conversations: [sideConversation],
          selectedConversationId: sideConversation.id,
        }),
      );
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(retryConversation).toHaveBeenCalledWith("project-1", sideConversation.id),
      );
      await waitFor(() => expect(screen.queryByText(/could not start/) === null).toBe(true));
      await waitFor(() => expect(ensureSession).toHaveBeenCalled());
    });

    test("Close closes a side agent at once", async () => {
      renderFailed();
      const alert = await screen.findByRole("alert");
      fireEvent.click(within(alert).getByRole("button", { name: "Close conversation" }));
      await waitFor(() =>
        expect(closeConversation).toHaveBeenCalledWith("project-1", sideConversation.id),
      );
    });

    test("Close asks first for the main, which is what the tab's own close does", async () => {
      renderFailed([{ ...mainConversation, startupError: "bridge failed" }]);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Coordinator could not start.");
      fireEvent.click(within(alert).getByRole("button", { name: "Close conversation" }));
      expect((await screen.findByRole("alertdialog")).textContent).toContain(
        "Close the main conversation?",
      );
      expect(closeConversation).not.toHaveBeenCalled();
    });

    test("Copy error copies the error text", async () => {
      const writeText = spyOn(clipboard, "writeText").mockResolvedValue(undefined);
      try {
        renderFailed();
        const alert = await screen.findByRole("alert");
        fireEvent.click(within(alert).getByRole("button", { name: "Copy error" }));
        await waitFor(() =>
          expect(writeText).toHaveBeenCalledWith("codex server exited before becoming healthy"),
        );
      } finally {
        writeText.mockRestore();
      }
    });

    test("holds sending and establishes no session", async () => {
      useRealAgentTab = true;
      renderFailed();
      await screen.findByRole("alert");
      const input = await screen.findByRole("textbox");
      expect(input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder")).toBe(
        "This conversation could not start. Retry to send.",
      );
      expect(ensureSession).not.toHaveBeenCalled();
    });
  });

  test("an older backend's workspace failure keeps the toolbar banner and holds every pane", async () => {
    useRealAgentTab = true;
    ensuredSnapshot = withWorkspace({ lifecycleState: "error", lastStartupError: "bridge failed" });
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Coordinator startup failed");
    expect(alert.textContent).toContain("bridge failed");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(retryConversation).not.toHaveBeenCalled();
  });

  describe("reads while paused", () => {
    test("loads the saved transcript after a reload, establishing nothing and sending nothing", async () => {
      useRealAgentTab = true;
      ensuredSnapshot = withWorkspace({ lifecycleState: "paused" });
      agentProjection = projection([
        { id: "saved", role: "assistant", content: "Saved answer", parts: [] },
      ]);
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByText(/Coordination is paused/);
      await waitFor(() =>
        expect(
          appCommandStore(nativeAgentProjectionStore)
            .getState()
            .projections.get(sessionKey)
            ?.messages.map((item) => (item as { id: string }).id),
        ).toEqual(["saved"]),
      );
      const input = await screen.findByRole("textbox");
      expect(input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder")).toBe(
        "Coordination is paused. Resume to send.",
      );

      // Enter says why, keeps the draft and sends nothing.
      fireEvent.input(input, { target: { textContent: "Review this branch" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      expect(await screen.findByText("Coordination is paused. Resume to send.")).toBeTruthy();
      expect(dispatchIntent).not.toHaveBeenCalled();
      expect(ensureSession).not.toHaveBeenCalled();
    });
  });

  describe("reads while its platform is unavailable", () => {
    const unavailableCodex = (reason: string) =>
      withWorkspace(
        {},
        {
          providerAvailability: {
            codex: { tier: "advisory", available: false, reason, delegation: true },
            claude: { tier: "enforced", available: true, delegation: true },
          },
        },
      );
    const savedTranscriptShown = () =>
      waitFor(() =>
        expect(
          appCommandStore(nativeAgentProjectionStore)
            .getState()
            .projections.get(sessionKey)
            ?.messages.map((item) => (item as { id: string }).id),
        ).toEqual(["saved"]),
      );
    const placeholder = (input: HTMLElement) =>
      input.getAttribute("data-placeholder") ?? input.getAttribute("placeholder");

    test.each([
      {
        cause: "turned off",
        enabled: ["claude"] as const,
        reason: "Codex is turned off. Turn it on to send.",
        action: "Platform settings",
      },
      {
        cause: "below the safety level",
        enabled: ["codex", "claude"] as const,
        reason: "Codex is below the coordinator safety level. Change it to send.",
        action: "Coordinator settings",
      },
    ])(
      "$cause: loads the saved transcript after a reload, establishing nothing and sending nothing",
      async ({ enabled, reason, action }) => {
        useRealAgentTab = true;
        appCommandStore(configStore)
          .getState()
          .updateGlobalConfig({ enabledAgentPlatforms: [...enabled] });
        ensuredSnapshot = unavailableCodex("Why it is unavailable.");
        agentProjection = projection([
          { id: "saved", role: "assistant", content: "Saved answer", parts: [] },
        ]);
        renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
        await screen.findByText(/Codex is unavailable for Coordinator/);
        expect(screen.getByRole("button", { name: action })).toBeTruthy();
        await savedTranscriptShown();
        const input = await screen.findByRole("textbox");
        expect(placeholder(input)).toBe(reason);

        // Enter says why, keeps the draft and sends nothing.
        fireEvent.input(input, { target: { textContent: "Review this branch" } });
        fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
        expect(await screen.findByText(reason)).toBeTruthy();
        expect(dispatchIntent).not.toHaveBeenCalled();
        expect(ensureSession).not.toHaveBeenCalled();
      },
    );

    test("turning the platform back on connects the same pane and sends", async () => {
      useRealAgentTab = true;
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["claude"] });
      ensuredSnapshot = unavailableCodex("This agent platform is turned off in settings.");
      agentProjection = projection([
        { id: "saved", role: "assistant", content: "Saved answer", parts: [] },
      ]);
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByText(/Codex is unavailable for Coordinator/);
      await savedTranscriptShown();
      expect(ensureSession).not.toHaveBeenCalled();

      // What saving the setting does: the panel learns from the config change.
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["codex", "claude"] });
      ensuredSnapshot = baseSnapshot;
      act(() => {
        dispatchResourceChange({ resource: "config", id: "app", revision: 2 });
      });

      await waitFor(() =>
        expect(screen.queryByText(/Codex is unavailable for Coordinator/) === null).toBe(true),
      );
      await waitFor(() => expect(ensureSession).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          appCommandStore(nativeAgentProjectionStore).getState().projections.get(sessionKey)
            ?.connection,
        ).toBe("connected"),
      );
      const input = await screen.findByRole("textbox");
      expect(placeholder(input)).toBe(COORDINATOR_COMPOSER_PLACEHOLDER);
      fireEvent.input(input, { target: { textContent: "Review this branch" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(dispatchIntent).toHaveBeenCalled());
    });

    test("an assigned platform missing from an older snapshot holds sending too", async () => {
      useRealAgentTab = true;
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["codex", "claude"] });
      ensuredSnapshot = withWorkspace({}, { providerAvailability: {} });
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByText(/Codex is unavailable for Coordinator/);
      expect(placeholder(await screen.findByRole("textbox"))).toBe(
        "Codex is below the coordinator safety level. Change it to send.",
      );
      expect(ensureSession).not.toHaveBeenCalled();
    });

    test("mail on a platform-held pane waits for settings even with another platform available", async () => {
      ensuredSnapshot = unavailableCodex("Off.");
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["claude"] });
      const environmentId = "coordinator:coordinator-1:conversation-1";
      const mailboxId = `${environmentId}\0coordinator-tab`;
      appCommandStore(agentMailStore).setState({
        summary: new Map([
          [
            mailboxId,
            {
              mailboxId,
              projectId: "project-1",
              environmentId,
              tabId: "coordinator-tab",
              unreadCount: 1,
              userUnseenCount: 1,
              agentUnackedCount: 1,
              pendingInjectCount: 1,
              failedInjectCount: 0,
              revision: 1,
            },
          ],
        ]),
        refreshSummary: async () => undefined,
        refreshMailbox: async () => undefined,
      });
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      expect(
        await screen.findByText("Delivery waiting: Codex is turned off. Turn it on to send."),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
      expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
    });

    test.each(["running", "blocked"] as const)(
      "a held pane keeps Stop available for an existing %s turn after remount",
      async (phase) => {
        useRealAgentTab = true;
        ensuredSnapshot = unavailableCodex("Off.");
        appCommandStore(configStore)
          .getState()
          .updateGlobalConfig({ enabledAgentPlatforms: ["claude"] });
        agentProjection = { ...projection(), turn: { phase } };
        const stop = spyOn(realBackend, "stopNativeAgentSession").mockImplementation(async <
          TMessage,
        >() => {
          agentProjection = { ...agentProjection, turn: { phase: "idle" } };
          return agentProjection as NativeAgentSessionProjection<TMessage>;
        });
        const mounted = renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
        await screen.findByTitle("Stop current query");
        mounted.unmount();
        renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
        fireEvent.click(await screen.findByTitle("Stop current query"));
        await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
        expect(ensureSession).not.toHaveBeenCalled();
        stop.mockRestore();
      },
    );

    test("an unavailable platform takes precedence over pause until settings allow it", async () => {
      useRealAgentTab = true;
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["claude"] });
      ensuredSnapshot = withWorkspace(
        { lifecycleState: "paused" },
        { providerAvailability: unavailableCodex("Off.").providerAvailability },
      );
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByText(/Coordination is paused/);
      expect(placeholder(await screen.findByRole("textbox"))).toBe(
        "Codex is turned off. Turn it on to send.",
      );
      ensuredSnapshot = withWorkspace({ lifecycleState: "paused" });
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["codex", "claude"] });
      act(() => dispatchResourceChange({ resource: "config", id: "app", revision: 2 }));
      await waitFor(() =>
        expect(placeholder(screen.getByRole("textbox"))).toBe(
          "Coordination is paused. Resume to send.",
        ),
      );
    });
  });

  describe("action errors", () => {
    test("show as an announced alert, without a click, and dismiss", async () => {
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("pause failed");
      // Nothing to expand: it is not behind a disclosure.
      expect(alert.closest("details") === null).toBe(true);
      fireEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
      await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
    });

    test("clear on the next successful action", async () => {
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await screen.findByRole("alert");
      pause.mockImplementationOnce(async () => withWorkspace({ lifecycleState: "paused" }));
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await screen.findByText(/Coordination is paused/);
      expect(screen.queryByRole("alert") === null).toBe(true);
    });

    test("a failed close is visible too, and clears what came before", async () => {
      ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      await screen.findByTestId("native-agent");
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await screen.findByText("pause failed");
      closeConversation.mockImplementationOnce(async () => {
        throw new Error("close failed");
      });
      fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));
      await screen.findByText("close failed");
      expect(screen.queryByText("pause failed") === null).toBe(true);
    });
  });

  test("Pause says it holds mail and new turns for this project", async () => {
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");
    const title = screen.getByRole("button", { name: "Pause" }).getAttribute("title") ?? "";
    expect(title).toContain("this project's coordinator");
    expect(title).toContain("mail and new turns are held");
  });

  describe("the settings each state names", () => {
    function settingsRequests() {
      const sections: string[] = [];
      const off = onGlobalSettingsRequest((section) => sections.push(section));
      return { sections, off };
    }

    test("a platform held by the safety level links Coordinator settings", async () => {
      const { sections, off } = settingsRequests();
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["codex", "claude"] });
      ensuredSnapshot = withWorkspace(
        {},
        {
          providerAvailability: {
            codex: {
              tier: "advisory",
              available: false,
              reason: "Weaker than the coordinator safety level allows.",
              delegation: true,
            },
          },
        },
      );
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Coordinator settings" }));
      expect(sections).toEqual(["coordinator"]);
      off();
    });

    test("a platform turned off links Platforms", async () => {
      const { sections, off } = settingsRequests();
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({ enabledAgentPlatforms: ["claude"] });
      ensuredSnapshot = withWorkspace(
        {},
        {
          providerAvailability: {
            codex: {
              tier: "enforced",
              available: false,
              reason: "This agent platform is turned off in settings.",
              delegation: true,
            },
          },
        },
      );
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Platform settings" }));
      expect(sections).toEqual(["platforms"]);
      off();
    });

    test("no qualified platform offers Coordinator settings beside the message", async () => {
      const { sections, off } = settingsRequests();
      useRealAgentTab = true;
      ensuredSnapshot = withWorkspace(
        { conversations: [unassigned(mainConversation)] },
        { providerAvailability: {} },
      );
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      expect(await screen.findByText(/No agent platform meets/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Coordinator settings" }));
      expect(sections).toEqual(["coordinator"]);
      off();
    });

    test("no local checkout opens Repository settings", async () => {
      appCommandStore(projectStore).setState((state) => ({
        projects: state.projects.map((project) => ({ ...project, localPath: null })),
      }));
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      fireEvent.click(screen.getByRole("button", { name: "Repository settings" }));
      expect(useAppDialogStore.getState().request).toEqual({
        nodeId: commandNodeId(),
        kind: "repository-settings",
        projectId: "project-1",
      });
      useAppDialogStore.getState().close();
    });

    test("agent messaging off links Messaging", async () => {
      const { sections, off } = settingsRequests();
      ensuredSnapshot = withWorkspace({}, { agentMessaging: { enabled: false } });
      renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Turn it on in Settings → Messaging" }),
      );
      expect(sections).toEqual(["messaging"]);
      off();
    });
  });

  test("a failed Sync stays announced after identical repository status arrives and can be dismissed", async () => {
    ensuredGit = { ...gitStatus, upstream: "origin/main", behind: 1, ahead: 0 };
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(ensuredGit.lastError?.message).toBe("sync failed"));
    expect(alert.textContent).toContain("sync failed");
    expect(screen.queryByText("Repository error") === null).toBe(true);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
    expect(await screen.findByText("Repository error")).toBeTruthy();
  });

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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByText("Repository error");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getAllByText("pause failed")).toHaveLength(1);
    expect((await screen.findByRole("alert")).textContent).toContain("pause failed");
    expect(screen.queryByText("Repository error") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(await screen.findByText("Repository error")).toBeTruthy();
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    expect(await screen.findByText("fatal: could not read from remote")).toBeTruthy();
    expect(screen.getByText("Repository error")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect((await screen.findByRole("alert")).textContent).toContain("pause failed");
    expect(screen.getByText("fatal: could not read from remote")).toBeTruthy();
    expect(screen.getByText("Repository error")).toBeTruthy();
  });

  test("closing the main conversation asks first; cancelling keeps it open", async () => {
    ensuredSnapshot = withWorkspace({ conversations: [mainConversation, sideConversation] });
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
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
    renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
    await screen.findByTestId("native-agent");

    fireEvent.click(screen.getByRole("button", { name: "Close Side 1" }));
    await waitFor(() => expect(closeConversation).toHaveBeenCalledWith("project-1", "side-1"));
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
  });
});
