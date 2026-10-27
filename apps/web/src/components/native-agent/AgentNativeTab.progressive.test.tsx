/**
 * Controller behaviour on the progressive view.
 *
 * The main tab suite drives the legacy joined projection. This one advertises
 * `progressiveViewVersions: [1]` so the three domain reads land independently,
 * and pins the rules that depend on that split: a cached transcript is readable
 * and editable before session state arrives, actions are not, and a refresh
 * over an authoritative snapshot never withdraws either.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NativeAgentDiscoveryUpdate,
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentSessionStateView,
  NativeAgentTabData,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { AGENT_INTERACTION_CONTRACT_VERSION } from "@orkestrator/protocol/agent-interactions";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import type { AgentAccountLoginProgress } from "@orkestrator/protocol/agent-accounts";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeComposeStore, nativeComposeDraft } from "@/stores/nativeComposeStore";
import {
  createAgentHandoffSnapshot,
  resetAgentHandoffCache,
  type AgentHandoffSnapshot,
} from "@/lib/agent-handoff";
import { FakeClock } from "@/lib/testing/read-coordinator";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  parts: NativeMessage["parts"];
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
        <div key={props.computeItemKey(index, entry)} data-message-id={entry.id}>
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
let transcriptReads = 0;
let dispatched: string[] = [];
let backgroundTaskStops: string[] = [];
let discoveryRead: (() => Promise<NativeAgentDiscoveryUpdate>) | undefined;
let handoffRead: (() => Promise<AgentHandoffSnapshot | null>) | undefined;
let adoptionRead: (() => Promise<unknown>) | undefined;
let authStatusRead: (() => Promise<unknown>) | undefined;
let accountLogin: AgentAccountLoginProgress = { state: "idle" };
let replacementSessionId: string | undefined;
const resumeSessionMock = mock(async (input: { providerSessionId: string }) => ({
  ...seedProjection([]),
  sessionId: input.providerSessionId,
  revision: 10,
}));

const dispatchNativeAgentIntentMock = mock(async (input: { prompt?: string }) => {
  dispatched.push(input.prompt ?? "");
  return { outcome: "accepted" as const, requestId: "request-1" };
});
const stopNativeAgentBackgroundTaskMock = mock(async (input: { taskId: string }) => {
  backgroundTaskStops.push(input.taskId);
  return null;
});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  ensureNativeAgentSession: async () => ({
    providerSessionId: replacementSessionId ?? identity.providerSessionId,
    logicalSessionKey: identity.logicalSessionKey,
    environmentId: identity.environmentId,
    agent: identity.platform,
  }),
  adoptNativeAgentSession: async () => adoptionRead?.() ?? {},
  resumeNativeAgentSession: resumeSessionMock,
  getNativeAgentAuthStatus: async () => authStatusRead?.() ?? { authenticated: false },
  getAgentAccountLogin: async () => accountLogin,
  listAgentAccounts: async () => ({
    accounts: [],
    active: { claude: "default", codex: "default" },
  }),
  getNativeAgentProjection: async () => null,
  getNativeAgentProjectionUpdate: async () => {
    throw new Error("joined projection must not run on the progressive path");
  },
  getNativeAgentTranscriptUpdate: async () => {
    transcriptReads += 1;
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
    discoveryRead
      ? discoveryRead()
      : ({
          viewVersion: 1,
          status: "snapshot",
          token: "discovery-1",
          value: { identity, sections: {} },
        } satisfies NativeAgentDiscoveryUpdate),
  getAgentHandoff: async () => {
    const snapshot = await handoffRead?.();
    return snapshot
      ? { id: snapshot.id, environmentId: snapshot.environmentId, version: 1, snapshot }
      : null;
  },
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  stopNativeAgentBackgroundTask: stopNativeAgentBackgroundTaskMock,
  getNativeAgentModelCatalog: async () => [],
  listNativeAgentResumableSessions: async () => [
    { sessionId: "conversation-b", title: "Conversation B" },
  ],
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
    platform: identity.platform,
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
  extras: Partial<NativeAgentTranscriptView<TestMessage>> = {},
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
      ...extras,
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
    capabilities: nativeAgentCapabilities(identity.platform),
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
    platform: identity.platform,
    environmentId: "env-1",
    sessionId: identity.providerSessionId,
    connection: "connected",
    turn: { phase: "idle" },
    messages,
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities(identity.platform),
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
  identity.providerSessionId = "codex-session";
  identity.platform = "codex";
  identity.sourceGeneration = "generation-1";
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  stateUpdates = [];
  transcriptReads = 0;
  dispatched = [];
  backgroundTaskStops = [];
  discoveryRead = undefined;
  handoffRead = undefined;
  resetAgentHandoffCache();
  adoptionRead = undefined;
  authStatusRead = undefined;
  accountLogin = { state: "idle" };
  replacementSessionId = undefined;
  useNativeComposeStore.setState({ drafts: new Map() });
  resumeSessionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  stopNativeAgentBackgroundTaskMock.mockClear();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function currentDraft() {
  return nativeComposeDraft(useNativeComposeStore.getState(), identity.logicalSessionKey);
}

async function holdMessage(text: string) {
  const composer = await screen.findByRole("textbox");
  fireEvent.input(composer, { target: { textContent: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByText(/Connecting to .+… your message sends/)).toBeTruthy(),
  );
  expect(dispatched).toEqual([]);
}

async function expectUnsent(feedback: RegExp) {
  await waitFor(() => expect(screen.getByText(feedback)).toBeTruthy());
  expect(currentDraft().heldSubmit).toBeUndefined();
  expect(screen.queryByText(/your message sends as soon as the session is ready/) === null).toBe(
    true,
  );
  expect(dispatched).toEqual([]);
}

function installHeldSubmitClock() {
  const clock = new FakeClock();
  const startedAt = Date.now();
  const now = spyOn(Date, "now").mockImplementation(() => startedAt + clock.time);
  const realTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const handles = new Set<number>();
  const originalTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== undefined && delay > 14_000 && delay <= 15_000 && typeof handler === "function") {
      const handle = -clock.setTimeout(() => handler(...args), delay);
      handles.add(handle);
      return handle;
    }
    return realTimeout(handler, delay, ...args);
  }) as typeof window.setTimeout;
  window.clearTimeout = ((handle?: number) => {
    if (handle !== undefined && handles.delete(handle)) clock.clearTimeout(-handle);
    else realClearTimeout(handle);
  }) as typeof window.clearTimeout;
  return {
    clock,
    restore: () => {
      window.setTimeout = originalTimeout;
      window.clearTimeout = originalClearTimeout;
      now.mockRestore();
    },
  };
}

describe("AgentNativeTab progressive controller", () => {
  test("orders cleanup notices with rowless tasks and pinned settled cards using transcript anchors", async () => {
    identity.platform = "claude";
    const launch: TestMessage = {
      ...message("launch", "Launch context"),
      createdAt: "2026-10-25T09:59:00.000Z",
      parts: [
        { type: "text", content: "Launch context" },
        {
          type: "tool-invocation",
          content: "Investigate rendering",
          toolName: "Agent",
          toolUseId: "launch-1",
          toolState: "success",
          toolArgs: { description: "Investigate rendering", run_in_background: true },
        },
      ],
    };
    transcriptUpdates = [
      async () =>
        transcriptSnapshot("transcript-1", [
          launch,
          { ...message("anchor-a", "Before cleanup"), createdAt: "2026-10-25T10:00:00.000Z" },
          { ...message("anchor-b", "After cleanup"), createdAt: "2026-10-25T10:01:00.000Z" },
        ]),
    ];
    stateUpdates = [
      async () =>
        stateSnapshot("state-1", {
          backgroundTasks: [
            {
              id: "agent-1",
              toolUseId: "launch-1",
              description: "Investigate rendering",
              status: "completed",
              settledAt: "2026-10-25T10:00:20.000Z",
            },
            {
              id: "rowless-settled",
              description: "Build the image",
              status: "completed",
              settledAt: "2026-10-25T10:00:40.000Z",
            },
            {
              id: "rowless-live",
              description: "Watch the build",
              status: "running",
              startedAt: "2026-10-25T09:00:00.000Z",
            },
            ...["orphan-1", "orphan-2"].map((id) => ({
              id,
              status: "killed" as const,
              endReason: "resume-cleanup" as const,
              settledAt: "2026-10-25T10:00:30.000Z",
            })),
          ],
        }),
    ];

    renderTab();
    await screen.findByText("2 earlier background tasks were cleaned up");
    const rows = [...screen.getByTestId("progressive-transcript-list").children].filter((row) =>
      row.hasAttribute("data-message-id"),
    );
    expect(rows.map((row) => row.getAttribute("data-message-id"))).toEqual([
      "launch",
      "anchor-a",
      "anchor-a:settled-agents",
      "resume-cleanup:anchor-a",
      "anchor-b",
      "active-agents",
    ]);
    // Both terminal cards share the real transcript anchor even though the
    // rowless task settled after the notice's own timestamp.
    expect(rows[2]?.textContent).toContain("Investigate rendering");
    expect(rows[2]?.textContent).toContain("Build the image");
    expect(rows[3]?.textContent).toContain("2 earlier background tasks were cleaned up");
    expect(rows[5]?.textContent).toContain("Watch the build");
    expect(screen.getAllByRole("button", { name: /Task Build the image/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop Watch the build" })).toBeTruthy();
  });

  test("keeps a Claude agent pinned when returning before task status has refreshed", async () => {
    identity.platform = "claude";
    const launch: TestMessage = {
      ...message("launch", ""),
      parts: [
        {
          type: "tool-invocation",
          content: "Investigate rendering",
          toolName: "Agent",
          toolUseId: "launch-1",
          toolState: "success",
          toolArgs: { description: "Investigate rendering", run_in_background: true },
        },
      ],
    };
    const backgroundTasks = [
      {
        id: "agent-1",
        toolUseId: "launch-1",
        description: "Investigate rendering",
        status: "running" as const,
      },
    ];
    transcriptUpdates = [async () => transcriptSnapshot("transcript-1", [launch])];
    stateUpdates = [async () => stateSnapshot("state-1", { backgroundTasks })];
    const first = renderTab();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Agent Investigate rendering Running/ }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Stop Investigate rendering" })).toBeTruthy();
    first.unmount();

    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () => resolve(stateSnapshot("state-2", { backgroundTasks }));
    });
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-2", [launch, message("newer", "Newer work")]),
    ];
    stateUpdates = [() => heldState];
    renderTab();
    try {
      await waitFor(() => expect(screen.getByText("Newer work")).toBeTruthy());
      const agent = screen.getByRole("button", { name: /Agent Investigate rendering Running/ });
      // The launch result is already successful; losing its task snapshot
      // falsely finishes the agent and moves it above the newer work.
      expect(screen.getByText("Newer work").compareDocumentPosition(agent) & 4).toBe(4);
      // Cached cards stay visible, but Stop is an action and waits for authority.
      expect(screen.queryByRole("button", { name: "Stop Investigate rendering" }) === null).toBe(
        true,
      );
      const composer = screen.getByRole("textbox");
      fireEvent.input(composer, { target: { textContent: "too early" } });
      fireEvent.keyDown(composer, { key: "Enter" });
      await waitFor(() => expect(screen.getByText(/Connecting to Claude…/)).toBeTruthy());
      expect(dispatched).toEqual([]);
      expect(backgroundTaskStops).toEqual([]);
    } finally {
      await act(async () => {
        releaseState();
        await heldState;
      });
    }
    expect(
      screen.getByRole("button", { name: /Agent Investigate rendering Running/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Investigate rendering" })).toBeTruthy();
  });

  test.each(["failed-read", "unavailable-state", "runtime-restart"] as const)(
    "keeps Claude agent-card position through %s until authority returns",
    async (transition) => {
      identity.platform = "claude";
      const launch: TestMessage = {
        ...message("launch", ""),
        parts: [
          {
            type: "tool-invocation",
            content: "Investigate rendering",
            toolName: "Agent",
            toolUseId: "launch-1",
            toolState: "success",
            toolArgs: { description: "Investigate rendering", run_in_background: true },
          },
        ],
      };
      const backgroundTasks = [
        {
          id: "agent-1",
          toolUseId: "launch-1",
          description: "Investigate rendering",
          status: "running" as const,
        },
      ];
      transcriptUpdates = [async () => transcriptSnapshot("transcript-1", [launch])];
      stateUpdates = [
        async () =>
          stateSnapshot("state-1", {
            backgroundTasks,
            turn: { phase: "running" },
          }),
      ];
      renderTab();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Agent Investigate rendering Running/ }),
        ).toBeTruthy(),
      );
      expect(screen.getByRole("button", { name: "Stop Investigate rendering" })).toBeTruthy();

      if (transition !== "runtime-restart") {
        transcriptUpdates = [];
        stateUpdates = [
          async () =>
            transition === "failed-read"
              ? Promise.reject(new Error("status endpoint timed out"))
              : {
                  viewVersion: 1,
                  status: "unavailable",
                  retryable: true,
                  error: "status endpoint timed out",
                },
        ];
        await waitFor(
          () =>
            expect(
              screen.queryByRole("button", { name: "Stop Investigate rendering" }) === null,
            ).toBe(true),
          { timeout: 5_000 },
        );
        expect(
          screen.getByRole("button", { name: /Agent Investigate rendering Running/ }),
        ).toBeTruthy();
      }

      const restarted =
        transition === "runtime-restart"
          ? { ...identity, sourceGeneration: "generation-2" }
          : identity;
      let releaseState!: () => void;
      const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
        releaseState = () =>
          resolve(
            stateSnapshot(
              "state-2",
              transition === "runtime-restart" ? { identity: restarted } : { backgroundTasks },
            ),
          );
      });
      transcriptUpdates = [
        async () =>
          transcriptSnapshot("transcript-2", [launch, message("newer", "Newer work")], {
            identity: restarted,
          }),
      ];
      stateUpdates = [() => heldState];
      try {
        await waitFor(() => expect(screen.getByText("Newer work")).toBeTruthy(), {
          timeout: 5_000,
        });
        expect(screen.queryByRole("button", { name: "Stop Investigate rendering" }) === null).toBe(
          true,
        );
        expect(backgroundTaskStops).toEqual([]);
        const running = screen.queryByRole("button", {
          name: /Agent Investigate rendering Running/,
        });
        if (transition === "runtime-restart") {
          // A new runtime must not inherit the previous generation's pin.
          expect(running === null).toBe(true);
        } else {
          expect(running).toBeTruthy();
          expect(screen.getByText("Newer work").compareDocumentPosition(running!) & 4).toBe(4);
        }
      } finally {
        await act(async () => {
          releaseState();
          await heldState;
        });
      }
      if (transition === "runtime-restart") {
        await waitFor(() =>
          expect(
            screen.queryByRole("button", { name: /Agent Investigate rendering Running/ }) === null,
          ).toBe(true),
        );
      } else {
        expect(
          screen.getByRole("button", { name: /Agent Investigate rendering Running/ }),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Stop Investigate rendering" })).toBeTruthy();
      }
    },
  );

  test("holds a send made before session state lands and sends it once it does", async () => {
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

    // The composer is editable so a draft survives the wait. A send attempted
    // now is held, visibly, rather than dispatched or dropped.
    const composer = screen.getByRole("textbox");
    expect(composer.hasAttribute("disabled")).toBe(false);
    expect(composer.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.input(composer, { target: { textContent: "too early" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/Connecting to Codex…/)).toBeTruthy());
    expect(dispatched).toEqual([]);

    await act(async () => {
      releaseState();
      await heldState;
    });
    await waitFor(() => expect(dispatched).toEqual(["too early"]));
    expect(screen.queryByText(/Connecting to Codex…/) === null).toBe(true);
  });

  test("editing the draft withdraws a held send", async () => {
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

    const composer = screen.getByRole("textbox");
    fireEvent.input(composer, { target: { textContent: "first thought" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/Connecting to Codex…/)).toBeTruthy());
    fireEvent.input(composer, { target: { textContent: "second thought" } });
    await waitFor(() => expect(screen.queryByText(/Connecting to Codex…/) === null).toBe(true));

    await act(async () => {
      releaseState();
      await heldState;
    });
    expect(dispatched).toEqual([]);
  });

  test("a failed session-state read releases a held send unsent", async () => {
    let failState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((_resolve, reject) => {
      failState = () => reject(new Error("status endpoint timed out"));
    });
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState];

    renderTab();
    await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());

    const composer = screen.getByRole("textbox");
    fireEvent.input(composer, { target: { textContent: "never sent" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/Connecting to Codex…/)).toBeTruthy());

    await act(async () => {
      failState();
      await heldState.catch(() => undefined);
    });
    await waitFor(() =>
      expect(screen.getByText(/Couldn't read the Codex session, so nothing was sent/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Connecting to Codex…/) === null).toBe(true);
    expect(dispatched).toEqual([]);
  });

  test("retains a held send across an environment switch and dispatches once on return", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    const view = renderTab();
    await holdMessage("survives switching");
    view.rerender(<div>Another environment is active</div>);
    await act(async () => {
      heldState.resolve(stateSnapshot("state-1"));
      await heldState.promise;
    });
    expect(currentDraft().heldSubmit?.text).toBe("survives switching");
    expect(dispatched).toEqual([]);
    stateUpdates = [async () => stateSnapshot("state-2")];
    view.rerender(<AgentNativeTab tabId="tab-progressive" data={tabData()} isActive />);
    await waitFor(() => expect(dispatched).toEqual(["survives switching"]));
    await waitFor(() => expect(currentDraft().text).toBe(""));
    expect(currentDraft().heldSubmit).toBeUndefined();
    view.rerender(<div>Another environment is active</div>);
    stateUpdates = [async () => stateSnapshot("state-3")];
    view.rerender(<AgentNativeTab tabId="tab-progressive" data={tabData()} isActive />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(dispatched).toEqual(["survives switching"]);
  });

  test("expires a held send after 15 seconds and ignores a late state response", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    renderTab();
    await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());
    const { clock, restore } = installHeldSubmitClock();
    try {
      await holdMessage("expired message");
      expect(clock.pending).toBe(1);
      await act(async () => {
        await clock.advance(14_999);
      });
      expect(currentDraft().heldSubmit).toBeTruthy();
      await act(async () => {
        await clock.advance(1);
      });
      await expectUnsent(/Codex did not respond in time, so nothing was sent/);
      await act(async () => {
        heldState.resolve(stateSnapshot("state-late"));
        await heldState.promise;
      });
      expect(dispatched).toEqual([]);
      expect(clock.pending).toBe(0);
    } finally {
      restore();
    }
  });

  test.each(["edit", "unmount", "dispatch"] as const)(
    "cleans up the held-submit timer on %s",
    async (action) => {
      const heldState = deferred<NativeAgentSessionStateUpdate>();
      transcriptUpdates = [
        async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
      ];
      stateUpdates = [() => heldState.promise];
      const view = renderTab();
      await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());
      const { clock, restore } = installHeldSubmitClock();
      try {
        await holdMessage("pending message");
        expect(clock.pending).toBe(1);
        if (action === "edit") {
          fireEvent.input(screen.getByRole("textbox"), {
            target: { textContent: "changed message" },
          });
        } else if (action === "unmount") {
          view.unmount();
        } else {
          await act(async () => {
            heldState.resolve(stateSnapshot("state-ready"));
            await heldState.promise;
          });
          await waitFor(() => expect(dispatched).toEqual(["pending message"]));
        }
        await waitFor(() => expect(clock.pending).toBe(0));
        await act(async () => {
          await clock.advance(15_000);
        });
        expect(currentDraft().submissionError).toBeUndefined();
        if (action !== "dispatch") expect(dispatched).toEqual([]);
        if (action === "unmount") expect(currentDraft().heldSubmit).toBeTruthy();
      } finally {
        restore();
      }
    },
  );

  test("expires while another environment is active and restores unsent feedback on return", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    const view = renderTab();
    await holdMessage("expired while hidden");
    const heldAt = currentDraft().heldSubmit!.heldAt;
    view.rerender(<div>Another environment is active</div>);
    const now = spyOn(Date, "now").mockReturnValue(heldAt + 15_001);
    try {
      stateUpdates = [async () => stateSnapshot("state-ready")];
      view.rerender(<AgentNativeTab tabId="tab-progressive" data={tabData()} isActive />);
      await expectUnsent(/Codex did not respond in time, so nothing was sent/);
      await act(async () => {
        heldState.resolve(stateSnapshot("state-late"));
        await heldState.promise;
      });
      expect(dispatched).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  test.each(["running", "cancelling", "recovering"] as const)(
    "keeps a held send through a non-queueable %s phase until idle",
    async (phase) => {
      const heldState = deferred<NativeAgentSessionStateUpdate>();
      transcriptUpdates = [
        async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
      ];
      stateUpdates = [() => heldState.promise];
      const view = renderTab();
      await holdMessage("wait for idle");
      await act(async () => {
        heldState.resolve(
          stateSnapshot("state-busy", {
            turn: { phase },
            capabilities: { ...nativeAgentCapabilities(identity.platform), queue: false },
          }),
        );
        await heldState.promise;
      });
      expect(currentDraft().heldSubmit).toBeTruthy();
      expect(dispatched).toEqual([]);
      // Remounting reads fresh authoritative state without resetting the hold's deadline.
      const heldAt = currentDraft().heldSubmit!.heldAt;
      view.unmount();
      stateUpdates = [async () => stateSnapshot("state-idle")];
      renderTab();
      expect(currentDraft().heldSubmit?.heldAt).toBe(heldAt);
      await waitFor(() => expect(dispatched).toEqual(["wait for idle"]));
      expect(currentDraft().heldSubmit).toBeUndefined();
    },
  );

  test.each(["authentication", "blocked"] as const)(
    "settles a held send with explicit feedback for %s",
    async (gate) => {
      const heldState = deferred<NativeAgentSessionStateUpdate>();
      transcriptUpdates = [
        async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
      ];
      stateUpdates = [() => heldState.promise];
      renderTab();
      await holdMessage("refused message");
      await act(async () => {
        heldState.resolve(
          stateSnapshot(
            "state-refused",
            gate === "blocked"
              ? { turn: { phase: "blocked" } }
              : { readiness: { state: "authentication-required", message: "sign in" } },
          ),
        );
        await heldState.promise;
      });
      await expectUnsent(/Nothing was sent\./);
    },
  );

  test("an authoritative but recovering session still expires at the original deadline", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    renderTab();
    await waitFor(() => expect(screen.getByText("Readable")).toBeTruthy());
    const { clock, restore } = installHeldSubmitClock();
    try {
      await holdMessage("waiting for recovery");
      const heldAt = currentDraft().heldSubmit!.heldAt;
      await act(async () => {
        heldState.resolve(stateSnapshot("state-recovering", { turn: { phase: "recovering" } }));
        await heldState.promise;
      });
      expect(currentDraft().heldSubmit?.heldAt).toBe(heldAt);
      expect(clock.pending).toBe(1);
      await act(async () => {
        await clock.advance(15_000);
      });
      await expectUnsent(/Codex did not respond in time, so nothing was sent/);
    } finally {
      restore();
    }
  });

  test("waits for handoff history after session state arrives", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    const heldHandoff = deferred<AgentHandoffSnapshot | null>();
    handoffRead = () => heldHandoff.promise;
    transcriptUpdates = [async () => transcriptSnapshot("transcript-1", [])];
    stateUpdates = [() => heldState.promise];
    render(
      <AgentNativeTab
        tabId="tab-progressive"
        data={tabData()}
        isActive
        agentHandoffId="handoff-1"
      />,
    );
    await holdMessage("after transfer");
    await act(async () => {
      heldState.resolve(stateSnapshot("state-1"));
      await heldState.promise;
    });
    expect(currentDraft().heldSubmit).toBeTruthy();
    expect(dispatched).toEqual([]);
    await act(async () => {
      heldHandoff.resolve(
        createAgentHandoffSnapshot({
          id: "handoff-1",
          environmentId: "env-1",
          sourceProvider: "claude",
          destinationProvider: "codex",
          sourceSessionId: "source-session",
          messages: [],
        }),
      );
      await heldHandoff.promise;
    });
    await waitFor(() => expect(dispatched.length).toBe(1));
    expect(dispatched[0]).toContain("after transfer");
    expect(currentDraft().heldSubmit).toBeUndefined();
  });

  test("resuming B cancels a held send intended for A before pending state resolves", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    renderTab();
    await holdMessage("only for A");
    fireEvent.click(screen.getByText("Resume Session").closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: /Conversation B/ }));
    await expectUnsent(/The conversation changed, so nothing was sent/);
    expect(resumeSessionMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      heldState.resolve(stateSnapshot("state-A"));
      await heldState.promise;
    });
    expect(dispatched).toEqual([]);
    expect(currentDraft().text).toBe("only for A");
  });

  test("a different provider session in the state response cannot receive the held text", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    render(
      <AgentNativeTab
        tabId="tab-progressive"
        data={{ ...tabData(), sessionId: undefined }}
        isActive
      />,
    );
    await holdMessage("only for original session");
    await act(async () => {
      heldState.resolve(
        stateSnapshot("state-other-session", {
          identity: { ...identity, providerSessionId: "other-session" },
        }),
      );
      await heldState.promise;
    });
    await expectUnsent(/The conversation changed, so nothing was sent/);
    expect(currentDraft().text).toBe("only for original session");
  });

  test("missing-session replacement cancels a held send before replacement state arrives", async () => {
    const adoption = deferred<unknown>();
    adoptionRead = () => adoption.promise;
    replacementSessionId = "replacement-session";
    // Cached A enables the split read alongside the adoption check.
    useNativeAgentProjectionStore
      .getState()
      .setProjection(identity.logicalSessionKey, seedProjection([message("m1", "Readable")]));
    seedTranscriptCache("cached");
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    renderTab();
    await holdMessage("only for missing A");
    await act(async () => {
      adoption.reject(new Error("provider session was not found"));
      await adoption.promise.catch(() => undefined);
    });
    await expectUnsent(/The conversation changed, so nothing was sent/);
    await act(async () => {
      heldState.resolve(
        stateSnapshot("replacement-state", {
          identity: { ...identity, providerSessionId: "replacement-session" },
        }),
      );
      await heldState.promise;
    });
    expect(dispatched).toEqual([]);
    expect(currentDraft().text).toBe("only for missing A");
  });

  test("rejects an image when discovery reveals a text-only model and releases the hold", async () => {
    const heldState = deferred<NativeAgentSessionStateUpdate>();
    const discovery = deferred<NativeAgentDiscoveryUpdate>();
    discoveryRead = () => discovery.promise;
    transcriptUpdates = [
      async () => transcriptSnapshot("transcript-1", [message("m1", "Readable")]),
    ];
    stateUpdates = [() => heldState.promise];
    useNativeComposeStore.getState().updateDraft(identity.logicalSessionKey, {
      attachments: [{ id: "image-1", type: "image", path: "/tmp/image.png", name: "image.png" }],
    });
    renderTab();
    await holdMessage("inspect this image");
    await act(async () => {
      discovery.resolve({
        viewVersion: 1,
        status: "snapshot",
        token: "models-1",
        value: {
          identity,
          sections: {
            models: {
              availability: "ready",
              revision: 1,
              value: [
                {
                  platform: "codex",
                  id: "text-only",
                  label: "Text only",
                  supportsImageInput: false,
                },
              ],
            },
          },
        },
      });
      await discovery.promise;
    });
    await act(async () => {
      heldState.resolve(
        stateSnapshot("state-1", {
          composer: {
            models: [
              { platform: "codex", id: "text-only", label: "Text only", supportsImageInput: false },
            ],
            selectedModelId: "text-only",
            modes: [],
            fastModeEnabled: null,
            fastModeAvailable: false,
          },
        }),
      );
      await heldState.promise;
    });
    await expectUnsent(/not supported by the selected agent and model: image.png/);
    expect(currentDraft().attachments.length).toBe(1);
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
    expect(screen.queryByText(/Connecting to Codex…/) === null).toBe(true);
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

  test("keeps the transcript header and scroll position stable while a non-pageable preview hydrates", async () => {
    transcriptUpdates = [
      async () =>
        transcriptSnapshot("transcript-1", [message("m2", "Preview answer")], {
          historyComplete: false,
          messageWindow: {
            limit: 1,
            truncated: true,
            truncationReason: "count",
            canLoadEarlier: false,
          },
        }),
      async () =>
        transcriptSnapshot("transcript-2", [
          message("m1", "Hydrated prompt"),
          message("m2", "Preview answer"),
        ]),
    ];
    stateUpdates = [async () => stateSnapshot("state-1"), async () => stateSnapshot("state-2")];

    renderTab();
    const list = await screen.findByTestId("progressive-transcript-list");
    await waitFor(() => expect(screen.getByText("Preview answer")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true);
    list.scrollTop = 137;

    await waitFor(() => expect(screen.getByText("Hydrated prompt")).toBeTruthy(), {
      timeout: 5_000,
    });

    expect(screen.queryByRole("button", { name: "Load earlier messages" }) === null).toBe(true);
    expect(screen.getByTestId("progressive-transcript-list").scrollTop).toBe(137);
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

  test.each(["1970-01-01T00:00:00.000Z", "2026-10-27T00:00:00.000Z"])(
    "offers Claude sign-in after a prior successful reauthentication (failureAt=%s)",
    async (createdAt) => {
      identity.platform = "claude";
      accountLogin = {
        state: "succeeded",
        platform: "claude",
        mode: "reauthenticate",
        accountId: "default",
        operationId: "previous-login",
        completedAt: "2026-01-01T00:00:00.000Z",
      };
      transcriptUpdates = [async () => transcriptSnapshot("transcript-auth", [])];
      stateUpdates = [
        async () =>
          stateSnapshot("state-auth", {
            turn: { phase: "error", error: "Authentication failed. API Error: 401" },
            terminalMessages: [
              {
                id: "native-terminal:error:claude",
                role: "system",
                content: "Authentication failed. API Error: 401",
                parts: [{ type: "text", content: "Authentication failed. API Error: 401" }],
                createdAt,
              },
            ],
            notices: [
              {
                kind: "auth",
                state: "needs-auth",
                message: "Sign in again",
                occurrenceId: "new-failure",
              },
            ],
          }),
      ];
      renderTab();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Sign in to Claude$/ })).toBeTruthy(),
      );
      await act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      expect(screen.queryByText("Signed in. Resend your message to continue.") === null).toBe(true);
      expect(screen.getAllByRole("button", { name: /^Sign in to Claude$/ })).toHaveLength(1);
    },
  );

  test("shows a refused Codex turn's error row and sign-in banner after a reload", async () => {
    const refused =
      "unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake***1234.";
    const prompt: TestMessage = {
      id: "user-1",
      role: "user",
      content: "hello",
      createdAt: "2026-10-27T00:00:00.000Z",
      parts: [{ type: "text", content: "hello" }],
    };
    // The transcript read holds only the provider's rows; the failure arrives
    // with session state, as the backend sends it.
    const failedState = () =>
      stateSnapshot("state-refused", {
        turn: { phase: "error", error: refused },
        terminalMessages: [
          {
            id: "native-terminal:error:0123456789abcdef",
            role: "system",
            content: refused,
            parts: [{ type: "text", content: refused }],
            createdAt: "1970-01-01T00:00:00.000Z",
          },
        ],
        notices: [
          {
            kind: "auth",
            state: "needs-auth",
            message: "Codex's login was refused. Sign in to Codex again to keep working.",
            occurrenceId: "refused-1",
          },
        ],
      });
    const pendingSignIn = {
      url: "https://auth.example.test/device",
      code: "REPLACEMENT-CODE",
      expiresAt: Date.now() + 60_000,
    };
    authStatusRead = async () => ({
      state: "signed-in",
      pendingSignIn,
      signIn: { kind: "browser-url" },
    });

    for (const visit of ["first load", "reload"]) {
      transcriptUpdates = [async () => transcriptSnapshot(`transcript-${visit}`, [prompt])];
      stateUpdates = [async () => failedState()];
      const view = renderTab();
      await waitFor(() =>
        expect(
          document.querySelector('[data-message-id="native-terminal:error:0123456789abcdef"]')
            ?.textContent,
        ).toContain("401 Unauthorized"),
      );
      expect(
        screen.getByText("Codex's login was refused. Sign in to Codex again to keep working."),
      ).toBeTruthy();
      expect(await screen.findByText("REPLACEMENT-CODE")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "Sign in to Codex before sending",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      view.unmount();
      // A reload starts from nothing but what the backend answers.
      useNativeAgentProjectionStore.getState().reset();
      resetNativeAgentSyncCapabilityForTests();
    }
  });

  test("does not announce refresh on every idle poll of an unavailable transcript", async () => {
    useNativeAgentProjectionStore
      .getState()
      .setProjection(identity.logicalSessionKey, seedProjection([]));
    seedTranscriptCache("unavailable");
    transcriptUpdates = [
      async () =>
        ({ viewVersion: 1, status: "missing" }) satisfies NativeAgentTranscriptUpdate<TestMessage>,
    ];
    stateUpdates = [async () => stateSnapshot("state-1")];

    // The read coordinator schedules the idle poll; a fake clock drives it.
    const { clock } = installFakeReadCoordinator();
    try {
      renderTab();
      await waitFor(() => expect(screen.getByTestId("progressive-transcript-list")).toBeTruthy());
      expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
      expect(screen.queryByRole("status") === null).toBe(true);

      const readsBeforePoll = transcriptReads;
      await act(() => clock.advance(1_500));
      await waitFor(() => expect(transcriptReads).toBeGreaterThan(readsBeforePoll));
      expect(screen.queryByText("Refreshing Codex session…") === null).toBe(true);
      expect(screen.queryByRole("status") === null).toBe(true);
    } finally {
      resetReadCoordinatorForTests();
    }
  });
});
