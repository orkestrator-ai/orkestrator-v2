/**
 * The agent-information header holds the live projection, which changes on
 * every transcript update. Normalising the whole transcript is needed only by
 * the rewind and undo handlers, so it must happen when one of them runs, never
 * on a render.
 *
 * Kept apart from `AgentInfoButton.test.tsx`, which is far past the file-size
 * guideline.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { TabInfo } from "@/types/paneLayout";
import * as adapters from "@/lib/chat/native-message-adapters";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { createSessionKey } from "@/lib/utils";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { AgentInfoButton } from "./AgentInfoButton";
import { appCommandStore } from "@/test/app-command-store";

const ENVIRONMENT_ID = "env-transcript-reads";
const TAB_ID = "tab-transcript-reads";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

const openCodeTab = {
  id: TAB_ID,
  type: "agent-native",
  nativeAgentData: {
    platform: "opencode",
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
  },
} as TabInfo;

function message(id: string, role: "user" | "assistant"): NativeMessage {
  return {
    id,
    role,
    content: id,
    parts: [{ type: "text", content: id }],
    createdAt: "2026-11-02T10:00:00.000Z",
  } as NativeMessage;
}

function seed(
  messages: NativeMessage[],
  revision: number,
  platform: "opencode" | "claude" = "opencode",
) {
  appCommandStore(nativeAgentProjectionStore)
    .getState()
    .setProjection(SESSION_KEY, {
      platform,
      environmentId: ENVIRONMENT_ID,
      sessionId: "opencode-transcript-reads",
      connection: "connected",
      turn: { phase: "running" },
      messages,
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities(platform),
      revision,
      generation: "opencode-generation",
    });
}

function nativeActions(): Array<{ kind: string; messageId?: string; dryRun?: boolean }> {
  return nativeInvokeMock.mock.calls
    .filter(([command]) => command === "perform_native_agent_session_action")
    .map(
      ([, args]) =>
        (args as { action: { kind: string; messageId?: string; dryRun?: boolean } }).action,
    );
}

beforeEach(() => {
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  nativeInvokeMock.mockClear();
  nativeInvokeMock.mockImplementation(() => Promise.resolve());
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});

afterEach(() => {
  cleanup();
  mock.restore();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("AgentInfoButton transcript reads", () => {
  test("rewind reads the latest prompt once for preview and confirmed execution", async () => {
    const normalize = spyOn(adapters, "normalizeNativeMessages");
    spyOn(window, "confirm").mockReturnValue(true);
    nativeInvokeMock.mockImplementation(async (command: string) =>
      command === "perform_native_agent_session_action" ? { preview: {} } : undefined,
    );
    seed([message("u1", "user")], 1, "claude");
    const tab = {
      ...openCodeTab,
      nativeAgentData: { ...openCodeTab.nativeAgentData!, platform: "claude" },
    } as TabInfo;
    renderInAppCommandScope(<AgentInfoButton activeTab={tab} />);
    fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
    act(() =>
      seed(
        [message("u1", "user"), message("latest", "user"), message("a2", "assistant")],
        2,
        "claude",
      ),
    );
    expect(normalize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Claude files rewound"));
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(nativeActions()).toEqual([
      { kind: "rewind-files", messageId: "latest", dryRun: true },
      { kind: "rewind-files", messageId: "latest" },
    ]);
  });

  test("streaming updates never normalise the transcript; undo does, once", async () => {
    const normalize = spyOn(adapters, "normalizeNativeMessages");
    const transcript = [message("u1", "user"), message("a1", "assistant")];
    seed(transcript, 1);
    renderInAppCommandScope(<AgentInfoButton activeTab={openCodeTab} />);
    fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));

    for (let revision = 2; revision <= 6; revision += 1) {
      transcript.push(message(`u${revision}`, "user"), message(`a${revision}`, "assistant"));
      act(() => seed([...transcript], revision));
    }
    expect(normalize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Undo turn/ }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Session reverted"));
    expect(normalize).toHaveBeenCalledTimes(1);
    // The click reads the transcript that was on screen, latest prompt first.
    expect(nativeActions()).toEqual([{ kind: "undo", messageId: "u6" }]);
  });
});
