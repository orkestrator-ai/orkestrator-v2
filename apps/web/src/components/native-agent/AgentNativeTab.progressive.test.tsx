/**
 * Controller behaviour on the progressive view.
 *
 * The main tab suite drives the legacy joined projection. This one advertises
 * `progressiveViewVersions: [1]` so the three domain reads land independently,
 * and pins the rules that depend on that split: a cached transcript is readable
 * and editable before session state arrives, actions are not, and a refresh
 * over an authoritative snapshot never withdraws either.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NativeAgentDiscoveryUpdate,
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentSessionStateView,
  NativeAgentTabData,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { AGENT_INTERACTION_CONTRACT_VERSION } from "@orkestrator/protocol/agent-interactions";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  parts: { type: "text"; content: string }[];
}

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

// The virtualizer renders nothing in jsdom, so every transcript assertion here
// would pass or fail for the wrong reason. Render the rows directly instead.
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  VirtualizedMessageList: (props: {
    messages: NativeMessage[];
    header?: unknown;
    footer?: unknown;
    emptyState?: unknown;
    computeItemKey: (index: number, message: NativeMessage) => string;
    renderMessage: (
      index: number,
      message: NativeMessage,
      previous: NativeMessage | null,
    ) => unknown;
  }) => (
    <div data-testid="progressive-transcript-list">
      {props.header as never}
      {props.messages.length === 0 ? (props.emptyState as never) : null}
      {props.messages.map((entry, index) => (
        <div key={props.computeItemKey(index, entry)}>
          {
            props.renderMessage(
              index,
              entry,
              index > 0 ? (props.messages[index - 1] ?? null) : null,
            ) as never
          }
        </div>
      ))}
      {props.footer as never}
    </div>
  ),
}));

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "codex",
  logicalSessionKey: "env-env-1:tab-progressive",
  providerSessionId: "codex-session",
  sourceGeneration: "generation-1",
};

let transcriptUpdates: Array<() => Promise<NativeAgentTranscriptUpdate<TestMessage>>> = [];
let stateUpdates: Array<() => Promise<NativeAgentSessionStateUpdate>> = [];
let dispatched: string[] = [];

const dispatchNativeAgentIntentMock = mock(async (input: { prompt?: string }) => {
  dispatched.push(input.prompt ?? "");
  return { outcome: "accepted" as const, requestId: "request-1" };
});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  ensureNativeAgentSession: async () => ({
    providerSessionId: identity.providerSessionId,
    logicalSessionKey: identity.logicalSessionKey,
    environmentId: identity.environmentId,
    agent: "codex",
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
  getNativeAgentProjectionUpdate: async () => {
    throw new Error("joined projection must not run on the progressive path");
  },
  getNativeAgentTranscriptUpdate: async () => {
    const next = transcriptUpdates.shift();
    if (next) return next();
    return {
      viewVersion: 1,
      status: "unchanged",
      token: "transcript-unscripted",
      identity,
    } satisfies NativeAgentTranscriptUpdate<TestMessage>;
  },
  getNativeAgentSessionStateUpdate: async () => {
    const next = stateUpdates.shift();
    if (next) return next();
    return {
      viewVersion: 1,
      status: "unchanged",
      token: "state-unscripted",
      identity,
    } satisfies NativeAgentSessionStateUpdate;
  },
  getNativeAgentDiscoveryUpdate: async () =>
    ({
      viewVersion: 1,
      status: "snapshot",
      token: "discovery-1",
      value: { identity, sections: {} },
    }) satisfies NativeAgentDiscoveryUpdate,
  getAgentHandoff: async () => null,
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  getNativeAgentModelCatalog: async () => [],
  listNativeAgentResumableSessions: async () => [],
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

const { AgentNativeTab } = await import("./AgentNativeTab");
const { resetNativeAgentSyncCapabilityForTests } = await import("@/hooks/useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

function tabData(): NativeAgentTabData {
  return {
    platform: "codex",
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: identity.providerSessionId,
    isLocal: false,
  };
}

function message(id: string, content: string): TestMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-09-09T00:00:00.000Z",
    parts: [{ type: "text", content }],
  };
}

function transcriptSnapshot(
  token: string,
  messages: TestMessage[],
): NativeAgentTranscriptUpdate<TestMessage> {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      freshness: messages.length === 0 ? "empty" : "current",
      messages,
      historyEpoch: "epoch-1",
      historyComplete: true,
    },
  };
}

function stateView(extras: Partial<NativeAgentSessionStateView> = {}): NativeAgentSessionStateView {
  return {
    identity,
    connection: "connected",
    turn: { phase: "idle" },
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("codex"),
    notices: [],
    ...extras,
  };
}

function stateSnapshot(
  token: string,
  extras: Partial<NativeAgentSessionStateView> = {},
): NativeAgentSessionStateUpdate {
  return { viewVersion: 1, status: "snapshot", token, value: stateView(extras) };
}

function seedProjection(messages: TestMessage[]): NativeAgentSessionProjection<TestMessage> {
  return {
    platform: "codex",
    environmentId: "env-1",
    sessionId: identity.providerSessionId,
    connection: "connected",
    turn: { phase: "idle" },
    messages,
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("codex"),
    revision: 1,
    generation: "generation-1",
  };
}

function seedTranscriptCache(
  transcriptAvailability: "unavailable" | "cached" | "current" | "empty",
) {
  useNativeAgentProjectionStore.getState().setProgressiveCache(identity.logicalSessionKey, {
    identity,
    transcriptAvailability,
    transcriptRefreshing: true,
    stateAvailability: "refreshing",
  });
}

function neverSettlingTranscript(): () => Promise<NativeAgentTranscriptUpdate<TestMessage>> {
  return () => new Promise<NativeAgentTranscriptUpdate<TestMessage>>(() => {});
}

function neverSettlingState(): () => Promise<NativeAgentSessionStateUpdate> {
  return () => new Promise<NativeAgentSessionStateUpdate>(() => {});
}

const pendingApproval: NativeAgentSessionStateView["interactions"] = [
  {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: "approval-1",
    provider: "codex",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: identity.providerSessionId,
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: "Approve command",
      body: "Command: rm -rf build",
      questions: [],
      confirmLabel: "Approve",
      declineLabel: "Deny",
    },
  },
];

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  stateUpdates = [];
  dispatched = [];
  dispatchNativeAgentIntentMock.mockClear();
  useEnvironmentStore.setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "Progressive test",
        order: 0,
        setupPhase: "ready",
      } as never,
    ],
  });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeAgentProjectionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useNativeAgentProjectionStore.getState().reset();
});

function renderTab() {
  return render(<AgentNativeTab tabId="tab-progressive" data={tabData()} isActive />);
}

describe("AgentNativeTab progressive controller", () => {
  test("shows the transcript but withholds actions until session state lands", async () => {
    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () => resolve(stateSnapshot("state-1"));
    });
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState];

    renderTab();
    await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());

    // The composer is editable so a draft survives the wait, but a send
    // attempted now must say so rather than vanish.
    const composer = screen.getByRole("textbox");
    expect(composer.hasAttribute("disabled")).toBe(false);
    expect(composer.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.input(composer, { target: { textContent: "too early" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/Still reading the .* session/)).toBeTruthy());
    expect(dispatched).toEqual([]);

    releaseState();
    await waitFor(() => expect(screen.getByTestId("progressive-transcript-list")).toBeTruthy());
  });

  test("dispatches once session state is authoritative", async () => {
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [async () => stateSnapshot("state-1")];

    renderTab();
    await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());

    const composer = screen.getByRole("textbox");
    fireEvent.input(composer, { target: { textContent: "now it can go" } });
    await waitFor(
      async () => {
        fireEvent.keyDown(composer, { key: "Enter" });
        await Promise.resolve();
        expect(dispatched).toContain("now it can go");
      },
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Still reading the .* session/) === null).toBe(true);
  });

  test("hides a pending approval that is not authoritative yet", async () => {
    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () => resolve(stateSnapshot("state-1", { interactions: pendingApproval }));
    });
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState];

    renderTab();
    await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());
    expect(screen.queryByText("Approve command") === null).toBe(true);

    releaseState();
    await waitFor(() => expect(screen.getByText("Approve command")).toBeTruthy());
  });

  test("keeps a pending approval on screen across a later refresh", async () => {
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [async () => stateSnapshot("state-1", { interactions: pendingApproval })];

    renderTab();
    await waitFor(() => expect(screen.getByText("Approve command")).toBeTruthy());

    /*
     * A poll whose transcript changes while the state read is still in flight.
     * Withdrawing authority here would unmount the approval card every poll —
     * every 500 ms while a turn is active — and the user could not click it.
     */
    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () =>
        resolve({ viewVersion: 1, status: "unchanged", token: "state-1", identity });
    });
    transcriptUpdates = [
      async () =>
        transcriptSnapshot("transcript-2", [message("m1", "Readable"), message("m2", "Newer")]),
    ];
    stateUpdates = [() => heldState];

    // The idle poll drives the second refresh; no test-only refresh hook exists
    // on the rendered tab, and using the real cadence is the point.
    await waitFor(() => expect(screen.getByText("Newer")).toBeTruthy(), { timeout: 5_000 });
    expect(screen.getByText("Approve command")).toBeTruthy();

    releaseState();
    await waitFor(() => expect(screen.getByText("Approve command")).toBeTruthy());
  });

  test("does not shimmer while session state connects over an authoritative empty transcript", async () => {
    useNativeAgentProjectionStore
      .getState()
      .setProjection(identity.logicalSessionKey, seedProjection([]));
    seedTranscriptCache("empty");
    transcriptUpdates = [neverSettlingTranscript()];
    stateUpdates = [neverSettlingState()];

    renderTab();
    await waitFor(() => expect(screen.getByTestId("progressive-transcript-list")).toBeTruthy());

    // The transcript read already answered "empty", so `connecting` describes
    // session state alone and must not raise a transcript-history shimmer.
    expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
    expect(screen.queryByTestId("session-refresh-shimmer-pinned") === null).toBe(true);
  });

  test("shimmers while a state-only empty projection's transcript is unproven", async () => {
    useNativeAgentProjectionStore
      .getState()
      .setProjection(identity.logicalSessionKey, seedProjection([]));
    seedTranscriptCache("unavailable");
    transcriptUpdates = [neverSettlingTranscript()];
    stateUpdates = [neverSettlingState()];

    renderTab();
    await waitFor(() => expect(screen.getByText("Refreshing Codex session…")).toBeTruthy());
    expect(screen.getByTestId("session-refresh-shimmer-pinned")).toBeTruthy();
    expect(
      screen.getByTestId("session-refresh-shimmer-transcript").getAttribute("data-active"),
    ).toBe("false");
  });

  test("keeps the visible shimmer on remount of a cached transcript until it is proved", async () => {
    useNativeAgentProjectionStore
      .getState()
      .setProjection(identity.logicalSessionKey, seedProjection([message("m1", "Cached")]));
    seedTranscriptCache("current");
    transcriptUpdates = [neverSettlingTranscript()];
    stateUpdates = [neverSettlingState()];

    renderTab();
    await waitFor(() => expect(screen.getByText("Cached")).toBeTruthy());
    expect(screen.getByText("Refreshing Codex session…")).toBeTruthy();
    expect(
      screen.getByTestId("session-refresh-shimmer-transcript").getAttribute("data-active"),
    ).toBe("true");
    expect(screen.queryByTestId("session-refresh-shimmer-pinned") === null).toBe(true);
  });

  test("does not announce refresh on every idle poll of an unavailable transcript", async () => {
    useNativeAgentProjectionStore
      .getState()
      .setProjection(identity.logicalSessionKey, seedProjection([]));
    seedTranscriptCache("unavailable");
    transcriptUpdates = [
      async () => ({ viewVersion: 1, status: "missing" }) satisfies NativeAgentTranscriptUpdate<TestMessage>,
    ];
    stateUpdates = [async () => stateSnapshot("state-1")];

    renderTab();
    await waitFor(() => expect(screen.getByTestId("progressive-transcript-list")).toBeTruthy());
    expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
    expect(screen.queryByRole("status") === null).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
    expect(screen.queryByRole("status") === null).toBe(true);
  });
});
