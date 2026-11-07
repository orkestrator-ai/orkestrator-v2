import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { configStore } from "@/stores/configStore";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { createSessionKey } from "@/lib/utils";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import type { TabInfo } from "@/types/paneLayout";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  nativeAgentCapabilities,
  type NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import { AgentInfoButton } from "./AgentInfoButton";
import { appCommandStore } from "@/test/app-command-store";

const COORDINATOR_ENVIRONMENT_ID = coordinatorRuntimeId("workspace-1", "conversation-1");
const TAB_ID = "coordinator-tab-1";
const SESSION_KEY = createSessionKey(COORDINATOR_ENVIRONMENT_ID, TAB_ID);
const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

function coordinatorTab(): TabInfo {
  return {
    id: TAB_ID,
    type: "agent-native",
    nativeAgentData: {
      platform: "claude",
      environmentId: COORDINATOR_ENVIRONMENT_ID,
      isLocal: true,
      sessionId: "coordinator-session-1",
    },
  };
}

function usage(): ContextUsageSnapshot {
  return {
    usedTokens: 25_000,
    totalTokens: 100_000,
    percentUsed: 25,
    estimated: false,
    source: "claude",
    updatedAt: "2026-07-26T12:00:00.000Z",
    account: [{ window: "weekly", label: "Weekly quota", usedPercent: 40 }],
  };
}

function coordinatorProjection(): NativeAgentSessionProjection {
  const snapshot = usage();
  return {
    platform: "claude",
    environmentId: COORDINATOR_ENVIRONMENT_ID,
    sessionId: "coordinator-session-1",
    connection: "connected",
    turn: { phase: "idle" },
    messages: [
      {
        id: "m1",
        role: "user",
        content: "plan",
        parts: [{ type: "text", content: "plan" }],
        createdAt: "2026-07-27T10:00:00.000Z",
      },
    ],
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("claude"),
    contextUsage: {
      ...snapshot,
      maximumTokens: snapshot.totalTokens,
      percentage: snapshot.percentUsed,
    },
    composer: {
      models: [],
      fastModeEnabled: false,
      fastModeAvailable: false,
      modes: [],
      includeLocalSettings: false,
      promptSuggestionsEnabled: false,
      executionProfiles: [{ id: "fast", label: "Fast", modelId: "claude-haiku" }],
    },
    revision: 1,
    generation: "coordinator-generation",
  };
}

const account = {
  id: "work",
  platform: "claude",
  label: "Work",
  isDefault: false,
  isActive: true,
  signedIn: true,
  identity: { email: "me@example.com" },
};

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
}

const originalGlobalConfig = appCommandStore(configStore).getState().config.global;
beforeEach(() => {
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  nativeInvokeMock.mockClear();
  nativeInvokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_native_agent_projection") {
      return (
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .projections.get(String(args?.logicalSessionKey)) ?? null
      );
    }
    if (command === "get_native_agent_auth_status") {
      return { state: "signed-in", account: { email: "me@example.com" }, signOut: false };
    }
    if (command === "get_native_agent_session_account") {
      return { platform: "claude", source: "account", account, running: true };
    }
    if (command === "list_agent_accounts") {
      return { accounts: [account], active: { claude: "work" } };
    }
    if (command === "get_agent_account_usage") {
      return {
        platform: "claude",
        status: "ok",
        windows: [
          {
            window: "seven_day",
            label: "Weekly limit",
            usedPercent: 62,
            resetsAt: "2026-07-30T00:00:00.000Z",
            windowMinutes: 7 * 24 * 60,
          },
        ],
        fetchedAt: "2026-07-27T10:00:00.000Z",
      };
    }
    if (command === "get_cursor_account_usage") return new Promise(() => undefined);
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  appCommandStore(configStore).setState((state) => ({
    config: { ...state.config, global: originalGlobalConfig },
  }));
});

describe("AgentInfoButton coordinator conversations", () => {
  test("reports a coordinator conversation's usage, quota and account like an agent tab", async () => {
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(SESSION_KEY, coordinatorProjection());

    render(<AgentInfoButton activeTab={coordinatorTab()} />);
    open();

    expect(screen.getByText("Claude Native")).toBeTruthy();
    expect(screen.queryByText("Select a native agent tab.")).toBe(null);
    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith(
        "get_native_agent_projection",
        expect.objectContaining({
          environmentId: COORDINATOR_ENVIRONMENT_ID,
          agent: "claude",
          logicalSessionKey: SESSION_KEY,
          refreshUsage: true,
        }),
      ),
    );
    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith(
        "get_native_agent_auth_status",
        expect.objectContaining({
          environmentId: COORDINATOR_ENVIRONMENT_ID,
          logicalSessionKey: SESSION_KEY,
        }),
      ),
    );
    const quota = within(screen.getByRole("region", { name: "Account usage" }));
    expect(quota.getByText("Weekly quota")).toBeTruthy();
    expect(await quota.findByText("(Work) (me@example.com)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  });

  test("reads the account's plan limits when the coordinator's CLI reports none", async () => {
    const projection = coordinatorProjection();
    delete projection.contextUsage!.account;
    appCommandStore(nativeAgentProjectionStore).getState().setProjection(SESSION_KEY, projection);

    render(<AgentInfoButton activeTab={coordinatorTab()} />);
    open();

    const quota = within(await screen.findByRole("region", { name: "Account usage" }));
    expect(quota.getByText("Weekly limit")).toBeTruthy();
    expect(quota.getByText("(Work) (me@example.com)")).toBeTruthy();
    expect(nativeInvokeMock).toHaveBeenCalledWith("get_agent_account_usage", {
      platform: "claude",
      accountId: "work",
    });
  });

  test("daily buckets allow the fallback and projection turn/generation changes refresh it", async () => {
    const projection = coordinatorProjection();
    projection.contextUsage!.account = [
      { window: "daily:2026-11-02", label: "2026-11-02", tokens: 60_000_000 },
    ];
    projection.turn = { phase: "running" };
    appCommandStore(nativeAgentProjectionStore).getState().setProjection(SESSION_KEY, projection);
    render(<AgentInfoButton activeTab={coordinatorTab()} />);
    open();
    expect(await screen.findByText("Weekly limit")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Daily tokens" })).toBeTruthy();
    const reads = () =>
      nativeInvokeMock.mock.calls.filter(([command]) => command === "get_agent_account_usage")
        .length;
    const before = reads();
    await act(async () => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(SESSION_KEY, {
          ...projection,
          revision: 2,
          turn: { phase: "idle" },
        });
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    const afterTurn = reads();
    await act(async () => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(SESSION_KEY, {
          ...projection,
          revision: 3,
          generation: "next-generation",
          turn: { phase: "idle" },
        });
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(afterTurn));
    expect(screen.getByText("Weekly limit")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Daily tokens" })).toBeTruthy();
  });

  test("keeps the session's own plan limits when the coordinator reports them", async () => {
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(SESSION_KEY, coordinatorProjection());

    render(<AgentInfoButton activeTab={coordinatorTab()} />);
    open();

    const quota = within(screen.getByRole("region", { name: "Account usage" }));
    expect(await quota.findByText("(Work) (me@example.com)")).toBeTruthy();
    expect(quota.getByText("Weekly quota")).toBeTruthy();
    expect(quota.queryByText("Weekly limit")).toBe(null);
    expect(nativeInvokeMock).not.toHaveBeenCalledWith("get_agent_account_usage", expect.anything());
  });

  test("leaves an environment tab's plan limits to its own session", async () => {
    const projection = coordinatorProjection();
    delete projection.contextUsage!.account;
    projection.environmentId = "environment-1";
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(createSessionKey("environment-1", TAB_ID), projection);
    const tab = coordinatorTab();
    tab.nativeAgentData!.environmentId = "environment-1";

    render(<AgentInfoButton activeTab={tab} />);
    open();

    await waitFor(() =>
      expect(nativeInvokeMock).toHaveBeenCalledWith(
        "get_native_agent_session_account",
        expect.anything(),
      ),
    );
    expect(screen.queryByRole("region", { name: "Account usage" })).toBe(null);
    expect(nativeInvokeMock).not.toHaveBeenCalledWith("get_agent_account_usage", expect.anything());
  });

  test("hides Undo and Redo even when the coordinator provider supports both", () => {
    const projection = coordinatorProjection();
    projection.platform = "opencode";
    projection.capabilities = nativeAgentCapabilities("opencode");
    expect(projection.capabilities.actions?.undo).toBe(true);
    expect(projection.capabilities.actions?.redo).toBe(true);
    appCommandStore(nativeAgentProjectionStore).getState().setProjection(SESSION_KEY, projection);
    const tab = coordinatorTab();
    tab.nativeAgentData!.platform = "opencode";
    const view = render(<AgentInfoButton activeTab={tab} />);
    open();
    expect(screen.queryByRole("button", { name: "Undo turn" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Redo turn" })).toBe(null);
    // A normal tab with these same capabilities exposes both controls.
    view.rerender(
      <AgentInfoButton
        activeTab={{
          ...tab,
          nativeAgentData: { ...tab.nativeAgentData!, environmentId: "environment-1" },
        }}
      />,
    );
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(createSessionKey("environment-1", TAB_ID), {
        ...projection,
        environmentId: "environment-1",
      });
    open();
    expect(screen.getByRole("button", { name: "Undo turn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Redo turn" })).toBeTruthy();
  });

  test("keeps tab-creating, file-changing and policy controls for environment tabs", async () => {
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(SESSION_KEY, coordinatorProjection());

    render(<AgentInfoButton activeTab={coordinatorTab()} />);
    open();

    await waitFor(() => expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy());
    for (const action of ["Fork session", "Continue in…", "Rewind files"]) {
      expect(screen.queryByRole("button", { name: action })).toBe(null);
    }
    expect(screen.queryByText("Execution profile")).toBe(null);
    expect(screen.queryByText("Include .claude/settings.local.json")).toBe(null);
    expect(screen.getByText("Suggest a follow-up after each turn")).toBeTruthy();
  });
});
