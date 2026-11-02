import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useConfigStore } from "@/stores/configStore";
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

const originalGlobalConfig = useConfigStore.getState().config.global;
beforeEach(() => {
  useNativeAgentProjectionStore.getState().reset();
  nativeInvokeMock.mockClear();
  nativeInvokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_native_agent_projection") {
      return (
        useNativeAgentProjectionStore.getState().projections.get(String(args?.logicalSessionKey)) ??
        null
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
    if (command === "get_cursor_account_usage") return new Promise(() => undefined);
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  useNativeAgentProjectionStore.getState().reset();
  useConfigStore.setState((state) => ({
    config: { ...state.config, global: originalGlobalConfig },
  }));
});

describe("AgentInfoButton coordinator conversations", () => {
  test("reports a coordinator conversation's usage, quota and account like an agent tab", async () => {
    useNativeAgentProjectionStore.getState().setProjection(SESSION_KEY, coordinatorProjection());

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

  test("keeps tab-creating, file-changing and policy controls for environment tabs", async () => {
    useNativeAgentProjectionStore.getState().setProjection(SESSION_KEY, coordinatorProjection());

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
