import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import type { TabInfo } from "@/types/paneLayout";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  nativeAgentCapabilities,
  type NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { AgentInfoButton } from "./AgentInfoButton";

const ENVIRONMENT_ID = "env-1";
const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;
function nativeProjection(
  platform: "claude" | "opencode",
  sessionId: string,
  overrides: Partial<NativeAgentSessionProjection> = {},
): NativeAgentSessionProjection {
  return {
    platform,
    environmentId: ENVIRONMENT_ID,
    sessionId,
    connection: "connected",
    turn: { phase: "idle" },
    messages: [],
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities(platform),
    revision: 1,
    generation: "reviewer-generation",
    ...overrides,
  };
}
function composerState(overrides = {}) {
  return {
    models: [],
    fastModeEnabled: false,
    fastModeAvailable: false,
    modes: [],
    includeLocalSettings: false,
    promptSuggestionsEnabled: false,
    ...overrides,
  };
}
function usage() {
  return {
    usedTokens: 25000,
    totalTokens: 100000,
    percentUsed: 25,
    estimated: false,
    source: "claude" as const,
    updatedAt: "2026-07-26T12:00:00.000Z",
  };
}
function projectionUsage(snapshot: ReturnType<typeof usage>) {
  return { ...snapshot, maximumTokens: snapshot.totalTokens, percentage: snapshot.percentUsed };
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
}
const originalGlobalConfig = useConfigStore.getState().config.global;
beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
  useNativeAgentProjectionStore.getState().reset();
  useEnvironmentStore.setState({ environments: [] });
  nativeInvokeMock.mockClear();
  nativeInvokeMock.mockImplementation(async () => undefined);
});
afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  useMultiReviewStore.setState({ workflows: new Map() });
  useNativeAgentProjectionStore.getState().reset();
  useEnvironmentStore.setState({ environments: [] });
  useConfigStore.setState((state) => ({
    config: { ...state.config, global: originalGlobalConfig },
  }));
});

function reviewerTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: "reviewer-tab",
    type: "multi-review",
    multiReviewTabData: {
      environmentId: ENVIRONMENT_ID,
      workflowId: "workflow-1",
      reviewerId: "reviewer-1",
    },
    ...overrides,
  } as TabInfo;
}

function multiReviewWorkflow(overrides: Partial<MultiReviewWorkflow> = {}): MultiReviewWorkflow {
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: "workflow-1",
    environmentId: ENVIRONMENT_ID,
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "running",
        sessionKey: "reviewer-session-key",
        providerSessionId: "reviewer-provider-session",
      },
    ],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    phase: "reviewing",
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
    backendRevision: 1,
    ...overrides,
  } as MultiReviewWorkflow;
}

describe("AgentInfoButton Multi Review reviewer tabs", () => {
  test("reports a reviewer tab's provider session read-only", async () => {
    useMultiReviewStore.getState().replaceWorkflow(multiReviewWorkflow());
    nativeInvokeMock.mockImplementation((command: string) =>
      command === "get_multi_review_reviewer_projection"
        ? Promise.resolve(
            nativeProjection("claude", "reviewer-provider-session", {
              turn: { phase: "running" },
              contextUsage: projectionUsage(usage()),
              composer: composerState({ selectedModelId: "claude-opus-reviewer" }),
            }),
          )
        : command === "get_cursor_account_usage"
          ? new Promise(() => undefined)
          : Promise.resolve(),
    );

    render(<AgentInfoButton activeTab={reviewerTab()} />);
    open();

    expect(screen.getByText("Claude Native")).toBeTruthy();
    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith("get_multi_review_reviewer_projection", {
        workflowId: "workflow-1",
        reviewerId: "reviewer-1",
        refreshUsage: true,
      }),
    );
    await waitFor(() =>
      expect(
        useNativeAgentProjectionStore.getState().projections.get("reviewer-session-key")?.sessionId,
      ).toBe("reviewer-provider-session"),
    );
    expect(screen.getByText("claude-opus-reviewer")).toBeTruthy();
    for (const action of ["Messages…", "Fork session", "Compact", "Rewind files"]) {
      expect(screen.queryByRole("button", { name: action }) === null).toBe(true);
    }
    expect(screen.queryByText("Active turn") === null).toBe(true);
    expect(
      nativeInvokeMock.mock.calls.some(([command]) => command === "get_native_agent_projection"),
    ).toBe(false);
  });

  test("does not reinspect an unchanged reviewer on workflow revisions", async () => {
    const workflow = multiReviewWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    nativeInvokeMock.mockImplementation((command: string) =>
      command === "get_multi_review_reviewer_projection"
        ? Promise.resolve(nativeProjection("claude", "reviewer-provider-session"))
        : command === "get_cursor_account_usage"
          ? new Promise(() => undefined)
          : Promise.resolve(),
    );
    const reviewerReads = () =>
      nativeInvokeMock.mock.calls.filter(
        ([command]) => command === "get_multi_review_reviewer_projection",
      );

    render(<AgentInfoButton activeTab={reviewerTab()} />);
    open();
    await waitFor(() => expect(reviewerReads()).toHaveLength(1));

    act(() => {
      useMultiReviewStore.getState().replaceWorkflow({
        ...workflow,
        backendRevision: 2,
        reviewers: workflow.reviewers.map((entry) => ({
          ...entry,
          progressAt: "2026-09-08T10:05:00.000Z",
        })),
      });
    });
    await act(async () => Promise.resolve());

    expect(reviewerReads()).toHaveLength(1);
  });

  test("leaves the Multi Review overview without an agent session", () => {
    useMultiReviewStore.getState().replaceWorkflow(multiReviewWorkflow());
    render(
      <AgentInfoButton
        activeTab={reviewerTab({
          multiReviewTabData: { environmentId: ENVIRONMENT_ID, workflowId: "workflow-1" },
        })}
      />,
    );
    open();

    expect(screen.getByText("Select a native agent tab.")).toBeTruthy();
  });
});

describe("reviewer session boundaries", () => {
  for (const action of ["disable", "enable", "reconnect"] as const) {
    test(`retains ${action} for interactive OpenCode tabs`, async () => {
      const sessionKey = "env-env-1:interactive-tab";
      const projection = nativeProjection("opencode", "interactive-session", {
        runtime: {
          mcp: [
            {
              id: "docs",
              name: "docs",
              status: action === "enable" ? "disabled" : "connected",
              actions: [action],
            },
          ],
        },
      });
      useNativeAgentProjectionStore.getState().setProjection(sessionKey, projection);
      nativeInvokeMock.mockImplementation(async (command: string) =>
        command === "get_native_agent_projection" ? projection : {},
      );
      render(
        <AgentInfoButton
          activeTab={{
            id: "interactive-tab",
            type: "agent-native",
            nativeAgentData: {
              platform: "opencode",
              environmentId: ENVIRONMENT_ID,
              sessionId: "interactive-session",
            },
          }}
        />,
      );
      open();
      fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
      // Reconnect/enable own the row; disable is an explicit secondary action.
      fireEvent.click(
        screen.getByRole("button", { name: action === "disable" ? "disable docs" : /^docs/ }),
      );
      await waitFor(() =>
        expect(nativeInvokeMock).toHaveBeenCalledWith("perform_native_agent_mcp_action", {
          environmentId: ENVIRONMENT_ID,
          agent: "opencode",
          logicalSessionKey: sessionKey,
          serverId: "docs",
          action,
        }),
      );
    });
  }

  test("keeps actionable OpenCode MCP inventory read-only", async () => {
    const workflow = multiReviewWorkflow();
    workflow.reviewers[0]!.agent = "opencode";
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_multi_review_reviewer_projection"
        ? nativeProjection("opencode", "reviewer-provider-session", {
            runtime: {
              mcp: [
                {
                  id: "healthy",
                  name: "healthy",
                  status: "connected",
                  toolCount: 3,
                  actions: ["disable"],
                },
                { id: "disabled", name: "disabled", status: "disabled", actions: ["enable"] },
                {
                  id: "failed",
                  name: "failed",
                  status: "failed",
                  error: "Connection refused",
                  actions: ["reconnect"],
                },
              ],
            },
          })
        : undefined,
    );
    render(<AgentInfoButton activeTab={reviewerTab()} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Tools 3/ }));
    const inventory = within(screen.getByLabelText("MCP servers"));
    for (const name of ["healthy", "disabled", "failed"]) {
      expect(inventory.getAllByText(name).length).toBeGreaterThan(0);
      expect(inventory.queryByRole("button", { name: new RegExp(name) }) === null).toBe(true);
    }
    expect(inventory.getByText("Connection refused")).toBeTruthy();
    fireEvent.click(inventory.getByText("healthy"));
    expect(
      nativeInvokeMock.mock.calls.some(
        ([command]) => command === "perform_native_agent_mcp_action",
      ),
    ).toBe(false);
  });

  for (const shared of [false, true]) {
    test(`Claude container reviewer ${shared ? "offers shared-host sign-in" : "suppresses host sign-in for isolated credentials"}`, async () => {
      useMultiReviewStore.getState().replaceWorkflow(multiReviewWorkflow());
      useEnvironmentStore.setState({
        environments: [
          { id: ENVIRONMENT_ID, containerId: "review-container", environmentType: "container" },
        ] as never,
      });
      useConfigStore.setState((state) => ({
        config: {
          ...state.config,
          global: { ...state.config.global, useHostClaudeCredentials: shared },
        },
      }));
      const hint = shared
        ? "Sign in to the shared Claude account."
        : "Run claude auth login inside this container.";
      nativeInvokeMock.mockImplementation(async (command: string) => {
        if (command === "get_multi_review_reviewer_projection")
          return nativeProjection("claude", "reviewer-provider-session");
        if (command === "get_native_agent_auth_status")
          return { state: "signed-out", signIn: { kind: "terminal", hint } };
        return undefined;
      });
      render(<AgentInfoButton activeTab={reviewerTab()} />);
      open();
      expect(await screen.findByText(hint)).toBeTruthy();
      expect(Boolean(screen.queryByRole("button", { name: "Sign in to Claude" }))).toBe(shared);
      expect(screen.queryByRole("button", { name: "Sign in" }) === null).toBe(true);
    });
  }

  test("uses the backend fallback key when the reviewer has no session key", async () => {
    const workflow = multiReviewWorkflow();
    delete workflow.reviewers[0]!.sessionKey;
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "get_multi_review_reviewer_projection"
        ? nativeProjection("claude", "reviewer-provider-session")
        : undefined,
    );
    render(<AgentInfoButton activeTab={reviewerTab()} />);
    open();
    await waitFor(() =>
      expect(
        useNativeAgentProjectionStore
          .getState()
          .projections.get("multi-review:workflow-1:reviewer:reviewer-1")?.sessionId,
      ).toBe("reviewer-provider-session"),
    );
  });

  test("does not inspect a reviewer without a provider session, even with a cached projection", async () => {
    const workflow = multiReviewWorkflow();
    delete workflow.reviewers[0]!.providerSessionId;
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    useNativeAgentProjectionStore
      .getState()
      .setProjection("reviewer-session-key", nativeProjection("claude", "old-session"));
    render(<AgentInfoButton activeTab={reviewerTab()} />);
    open();
    await act(async () => Promise.resolve());
    expect(
      nativeInvokeMock.mock.calls.some(
        ([command]) => command === "get_multi_review_reviewer_projection",
      ),
    ).toBe(false);
  });

  test("leaves pipeline-pass reviewer tabs on the empty placeholder", async () => {
    useMultiReviewStore.getState().replaceWorkflow(multiReviewWorkflow());
    const tab = reviewerTab();
    tab.multiReviewTabData!.pipelinePass = "pass-1";
    render(<AgentInfoButton activeTab={tab} />);
    open();
    expect(screen.getByText("Select a native agent tab.")).toBeTruthy();
    await act(async () => Promise.resolve());
    expect(
      nativeInvokeMock.mock.calls.some(
        ([command]) => command === "get_multi_review_reviewer_projection",
      ),
    ).toBe(false);
  });

  for (const rotateKey of [false, true]) {
    test(`refreshes a restarted reviewer with ${rotateKey ? "a rotated key" : "the same key and a new provider session"}`, async () => {
      const workflow = multiReviewWorkflow();
      useMultiReviewStore.getState().replaceWorkflow(workflow);
      let providerSessionId = "reviewer-provider-session";
      nativeInvokeMock.mockImplementation(async (command: string) =>
        command === "get_multi_review_reviewer_projection"
          ? nativeProjection("claude", providerSessionId)
          : undefined,
      );
      render(<AgentInfoButton activeTab={reviewerTab()} />);
      open();
      await waitFor(() =>
        expect(
          useNativeAgentProjectionStore.getState().projections.get("reviewer-session-key")
            ?.sessionId,
        ).toBe(providerSessionId),
      );
      providerSessionId = "restarted-provider-session";
      const key = rotateKey ? "rotated-reviewer-key" : "reviewer-session-key";
      act(() =>
        useMultiReviewStore.getState().replaceWorkflow({
          ...workflow,
          backendRevision: 2,
          reviewers: workflow.reviewers.map((reviewer) => ({
            ...reviewer,
            sessionKey: key,
            providerSessionId,
          })),
        }),
      );
      // Changing ownership closes the old panel. Reopening must inspect the new identity.
      open();
      await waitFor(() =>
        expect(useNativeAgentProjectionStore.getState().projections.get(key)?.sessionId).toBe(
          providerSessionId,
        ),
      );
      expect(
        nativeInvokeMock.mock.calls.filter(
          ([command]) => command === "get_multi_review_reviewer_projection",
        ),
      ).toHaveLength(2);
    });
  }
});
