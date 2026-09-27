/**
 * Steer refusals and steer-history saturation in the agent-information panel.
 *
 * Kept apart from `AgentInfoButton.test.tsx`, which is far past the file-size
 * guideline. A definitive refusal means the bridge proved the instruction was
 * not sent, so the panel reports actionable text and keeps the draft; a full
 * steer history is shown as a content-free runtime card with no control.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  nativeAgentCapabilities,
  nativeAgentSteerRejectionMessage,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import type { TabInfo } from "@/types/paneLayout";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { createSessionKey } from "@/lib/utils";
import { useCodexStore } from "@/stores/codexStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import * as realCodexClient from "@/lib/codex-client";
import { AgentRuntimePanel } from "./AgentInfoButton.panels";

// Only the network-facing Codex reads are replaced; the rest stays real.
const realCodexClientSnapshot = { ...realCodexClient };
mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  getSessionStatus: async () => ({ status: "running" }),
  getSessionMessages: async () => [],
  getCodexRuntimeHealth: async () => null,
}));
const { AgentInfoButton } = await import("./AgentInfoButton");
afterAll(() => {
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
});

const ENVIRONMENT_ID = "env-steer";
const TAB_ID = "tab-steer";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

const codexTab = {
  id: TAB_ID,
  type: "agent-native",
  nativeAgentData: {
    platform: "codex",
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
  },
} as TabInfo;

function seedRunningCodex() {
  useCodexStore.setState({
    clients: new Map([[ENVIRONMENT_ID, { baseUrl: "http://127.0.0.1:2222" }]]),
    sessions: new Map([[SESSION_KEY, { sessionId: "codex-steer", messages: [], isLoading: true }]]),
  } as never);
  useNativeAgentProjectionStore.getState().setProjection(SESSION_KEY, {
    platform: "codex",
    environmentId: ENVIRONMENT_ID,
    sessionId: "codex-steer",
    connection: "connected",
    turn: { phase: "running" },
    messages: [],
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("codex"),
    revision: 1,
    generation: "codex-generation",
  });
}

function steerOutcome(outcome: NativeAgentSessionActionOutcome) {
  nativeInvokeMock.mockImplementation((command: string) =>
    command === "perform_native_agent_session_action"
      ? Promise.resolve(outcome)
      : Promise.resolve(),
  );
}

async function sendSteer(text: string): Promise<HTMLInputElement> {
  render(<AgentInfoButton activeTab={codexTab} />);
  fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
  const input = screen.getByPlaceholderText("Correct or redirect Codex") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send now" }));
  return input;
}

beforeEach(() => {
  useNativeAgentProjectionStore.getState().reset();
  nativeInvokeMock.mockClear();
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});

afterEach(() => {
  cleanup();
  useNativeAgentProjectionStore.getState().reset();
  useCodexStore.setState({ clients: new Map(), sessions: new Map() } as never);
  nativeInvokeMock.mockImplementation(() => Promise.resolve());
});

describe("AgentInfoButton definitive steer refusal", () => {
  test("reports the bridge's bounded message and keeps the text", async () => {
    seedRunningCodex();
    steerOutcome({
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "steer-refused",
      message: "Wait for this turn to finish, then send again.",
    });
    const input = await sendSteer("wait");

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Wait for this turn to finish, then send again."),
    );
    expect(input.value).toBe("wait");
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("falls back to the reason's text when the bridge sent none", async () => {
    seedRunningCodex();
    steerOutcome({ outcome: "rejected", reason: "steer-not-recorded", requestId: "steer-lost" });
    const input = await sendSteer("retry me");

    const expected = nativeAgentSteerRejectionMessage({ reason: "steer-not-recorded" });
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(expected));
    expect(input.value).toBe("retry me");
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe("AgentRuntimePanel steer history", () => {
  const steer = {
    entries: 256,
    limitEntries: 256,
    bytes: 300 * 1024,
    limitBytes: 512 * 1024,
    fencedRuns: 1,
    saturated: true,
  };

  test("shows a saturated history as counts and limits, with no control", () => {
    render(<AgentRuntimePanel runtime={{ steer }} providerLabel="Cursor" />);

    const card = screen.getByTestId("agent-runtime-steer-saturated");
    expect(card.textContent).toContain("Steering is full for this turn");
    expect(card.textContent).toContain("the turn keeps running");
    expect(card.textContent).toContain("256 of 256 records, 300 KiB of 512 KiB.");
    expect(card.querySelector("button") === null).toBe(true);
    expect(screen.queryByText("Cursor does not report runtime details.") === null).toBe(true);
  });

  test("an unsaturated history stays out of the panel", () => {
    render(
      <AgentRuntimePanel
        runtime={{ steer: { ...steer, entries: 3, saturated: false } }}
        providerLabel="Cursor"
      />,
    );

    expect(screen.queryByTestId("agent-runtime-steer-saturated") === null).toBe(true);
    expect(screen.getByText("Cursor does not report runtime details.")).toBeTruthy();
  });
});
