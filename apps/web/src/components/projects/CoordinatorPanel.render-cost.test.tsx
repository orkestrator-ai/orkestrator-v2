/**
 * What an app-wide store write renders in the coordinator panel.
 *
 * The workers' prompts banner reads environments and nodes, which change for
 * every environment on the host. Those subscriptions live in
 * `CoordinatorWorkerPrompts`, a sibling of the conversations, so a write there
 * renders the banner and not the transcript in each group. The agent tab is
 * memoized, and the pane gives it props that keep their identity, so a panel
 * render that changes none of a conversation's inputs does not render it
 * either. Coordinator report 0390 measured both.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { memo } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  CoordinatorConversation,
  CoordinatorSnapshot,
  ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { Environment } from "@/types";
import * as realBackend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { environmentStore } from "@/stores/environmentStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { projectStore } from "@/stores/projectStore";
import { coordinatorPaneLayoutStore } from "@/stores/coordinatorPaneLayoutStore";
import {
  reconcileCoordinatorLayout,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { resetUpstreamCheckForTests } from "@/lib/coordinator-upstream-check";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

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

const snapshot: CoordinatorSnapshot = {
  workspace: {
    version: 1,
    id: "coordinator-1",
    projectId: "project-1",
    executionPolicy: "coordinator-read-only",
    lifecycleState: "ready",
    conversations: [mainConversation, sideConversation],
    selectedConversationId: "conversation-1",
    repositoryContextRevision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    repositoryStatus: gitStatus,
  },
  projectPath: "/checkout",
  providerAvailability: { codex: { tier: "enforced", available: true, delegation: true } },
  controlMcp: { enabled: true, running: true, error: null },
  workflows: [
    {
      id: "running",
      coordinatorId: "coordinator-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      kind: "environment",
      resourceId: "worker-env",
      requestId: "running",
      createdAt: new Date().toISOString(),
      delegation: {
        requestedAt: new Date().toISOString(),
        workerTabId: "worker-tab",
        state: "running",
        request: { summary: "Fix the parser", agent: "claude" },
      },
    },
  ],
};

let workerPrompts: HumanPromptEntry[] = [];
const ensure = mock(async () => snapshot);

mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  ensureProjectCoordinator: ensure,
  getProjectCoordinatorView: mock(async () => ({
    status: "snapshot",
    generation: "view-gen",
    revision: 1,
    snapshot,
  })),
  getProjectGitStatus: mock(async () => gitStatus),
  fetchProjectGit: mock(async () => gitStatus),
  checkCoordinatorUpstreamMerge: mock(async () => null),
  selectCoordinatorConversation: mock(async () => snapshot),
  listHumanPrompts: async () => ({ prompts: workerPrompts }),
}));

/** Renders of each conversation's agent tab, by tab id. */
const tabRenders = new Map<string, number>();
// Memoized, as the real tab is (checked below), so the count is the renders
// the real tab would do: only those whose props changed.
const CountingAgentTab = memo(function CountingAgentTab(
  props: Parameters<typeof realNativeAgent.AgentNativeTab>[0],
) {
  tabRenders.set(props.tabId, (tabRenders.get(props.tabId) ?? 0) + 1);
  return <div data-testid="native-agent" data-tab-id={props.tabId} />;
});

mock.module("@/components/native-agent", () => ({
  ...nativeAgentSnapshot,
  AgentNativeTab: CountingAgentTab,
}));

import { CoordinatorPanel } from "./CoordinatorPanel";
import { appCommandStore } from "@/test/app-command-store";

const worker = { id: "worker-env", projectId: "project-1", name: "api-fix" } as Environment;
const unrelated = {
  id: "unrelated-env",
  projectId: "other-project",
  name: "elsewhere",
  status: "running",
} as Environment;

function counts() {
  return Object.fromEntries(tabRenders);
}

async function renderPanel() {
  renderInAppCommandScope(<CoordinatorPanel projectId="project-1" />);
  await waitFor(() => expect(screen.getAllByTestId("native-agent")).toHaveLength(2));
  // Let the first reads (git, prompts, the checkout turn) settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return counts();
}

describe("CoordinatorPanel render cost", () => {
  const previousEnvironments = appCommandStore(environmentStore).getState().environments;
  const previousPipelines = appCommandStore(buildPipelineStore).getState().pipelines;
  const previousReviews = appCommandStore(multiReviewStore).getState().workflows;

  beforeEach(() => {
    tabRenders.clear();
    workerPrompts = [];
    resetUpstreamCheckForTests();
    resetClientStateCapabilitiesForTests();
    appCommandStore(coordinatorPaneLayoutStore).getState().reset();
    // Two groups, so both conversations' tabs are mounted.
    const single = reconcileCoordinatorLayout(null, ["conversation-1", "side-1"]);
    appCommandStore(coordinatorPaneLayoutStore)
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
    appCommandStore(environmentStore).setState({ environments: [worker, unrelated] });
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
    appCommandStore(environmentStore).setState({ environments: previousEnvironments });
    appCommandStore(buildPipelineStore).setState({ pipelines: previousPipelines });
    appCommandStore(multiReviewStore).setState({ workflows: previousReviews });
  });
  afterAll(() => {
    mock.module("@/lib/backend", () => backendSnapshot);
    mock.module("@/components/native-agent", () => nativeAgentSnapshot);
  });

  test("the real agent tab is memoized, as the counting stand-in is", () => {
    expect((nativeAgentSnapshot.AgentNativeTab as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  test("an unrelated environment, pipeline or Multi Review write renders no conversation", async () => {
    const settled = await renderPanel();
    expect(settled["coordinator-tab"]).toBeGreaterThan(0);
    expect(settled["coordinator-side-1"]).toBeGreaterThan(0);

    for (let index = 0; index < 5; index += 1) {
      act(() =>
        appCommandStore(environmentStore).setState((state) => ({
          environments: state.environments.map((item) =>
            item.id === unrelated.id
              ? ({ ...item, status: index % 2 ? "running" : "stopped" } as Environment)
              : item,
          ),
        })),
      );
      act(() =>
        appCommandStore(buildPipelineStore).setState((state) => ({
          pipelines: new Map(state.pipelines).set(`pipeline-${index}`, {
            id: `pipeline-${index}`,
            environmentId: unrelated.id,
          } as BuildPipeline),
        })),
      );
      act(() =>
        appCommandStore(multiReviewStore).setState((state) => ({
          workflows: new Map(state.workflows).set(`review-${index}`, {
            id: `review-${index}`,
            environmentId: unrelated.id,
          } as MultiReviewWorkflow),
        })),
      );
    }
    expect(counts()).toEqual(settled);
  });

  test("a panel render that changes no conversation's inputs renders none", async () => {
    const settled = await renderPanel();
    // A refreshed project list: the panel's own project, as a new object.
    act(() =>
      appCommandStore(projectStore).setState((state) => ({
        projects: state.projects.map((item) => ({ ...item })),
      })),
    );
    expect(counts()).toEqual(settled);
  });

  test("the prompts banner still shows a worker's prompt and follows its environment", async () => {
    workerPrompts = [
      {
        id: "tool-1",
        environmentId: "worker-env",
        tabId: "worker-tab",
        source: "agent-tool",
        since: new Date().toISOString(),
        prompt: { kind: "secret", wantsEnter: false, text: "Password:", key: "secret" },
      },
    ];
    await renderPanel();
    await screen.findByRole("button", { name: "Open api-fix" });
    const settled = counts();

    act(() =>
      appCommandStore(environmentStore).setState((state) => ({
        environments: state.environments.map((item) =>
          item.id === worker.id ? { ...item, name: "parser-fix" } : item,
        ),
      })),
    );
    expect(screen.getByRole("button", { name: "Open parser-fix" })).toBeTruthy();
    expect(counts()).toEqual(settled);
  });
});
