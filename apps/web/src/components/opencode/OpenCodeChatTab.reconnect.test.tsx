import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createSessionKey } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { OpenCodeEvent } from "@/lib/opencode-client";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realOpenCodeClient from "@/lib/opencode-client";
import * as realOpenCodeComposeBar from "./OpenCodeComposeBar";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };
const realOpenCodeComposeBarSnapshot = { ...realOpenCodeComposeBar };

const mockSubscribeToEvents = mock<
  (_client: unknown) => Promise<AsyncIterable<OpenCodeEvent>>
>(async () => emptyEventStream());
const mockGetSessionMessages = mock(async () => []);
const mockGetSessionStatus = mock(async () => null);
const mockGetPendingQuestions = mock(async () => []);
const mockGetPendingPermissions = mock(async () => []);
const mockGetAvailableSlashCommands = mock(async () => []);
const mockCheckClientHealth = mock(async () => true);
const mockGetOpenCodeRuntimeHealth = mock(async () => ({
  agents: [],
  skills: [],
  mcpServers: [],
  lspServers: [],
  formatters: [],
  todos: [],
  diffs: [],
  fetchedAt: "2026-07-27T00:00:00.000Z",
}));

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  subscribeToEvents: mockSubscribeToEvents,
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mockGetSessionStatus,
  getPendingQuestions: mockGetPendingQuestions,
  getPendingPermissions: mockGetPendingPermissions,
  getAvailableSlashCommands: mockGetAvailableSlashCommands,
  checkClientHealth: mockCheckClientHealth,
  getOpenCodeRuntimeHealth: mockGetOpenCodeRuntimeHealth,
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: mock(() => ({
    isAtBottom: true,
    isAtBottomRef: { current: true },
    scrollToBottom: mock(() => {}),
    virtuosoRef: { current: null },
    scrollProps: {},
  })),
}));

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: () => <div data-testid="messages" />,
}));

mock.module("./OpenCodeComposeBar", () => ({
  OpenCodeComposeBar: () => <div data-testid="compose" />,
}));

import { OpenCodeChatTab } from "./OpenCodeChatTab";

const ENVIRONMENT_ID = "env-reconnect";
const TAB_ID = "tab-reconnect";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" };
const REPLACEMENT_CLIENT = { baseUrl: "http://127.0.0.1:10000" };
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_CONSOLE_DEBUG = console.debug;
const ORIGINAL_CONSOLE_LOG = console.log;

interface CapturedTimer {
  delay: number;
  run: () => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyEventStream(): AsyncIterable<OpenCodeEvent> {
  return (async function* () {})();
}

function eventChannel() {
  let closed = false;
  let wake = deferred<void>();
  const queue: OpenCodeEvent[] = [];
  const stream = (async function* () {
    while (!closed) {
      if (queue.length === 0) await wake.promise;
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
  })() as AsyncGenerator<OpenCodeEvent>;
  return {
    stream,
    push(event: OpenCodeEvent) {
      queue.push(event);
      wake.resolve();
      wake = deferred<void>();
    },
    close() {
      closed = true;
      wake.resolve();
    },
  };
}

function captureReconnectTimers(): CapturedTimer[] {
  const timers: CapturedTimer[] = [];
  globalThis.setTimeout = ((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === "function" && (delay ?? 0) >= 3_000) {
      timers.push({
        delay: delay ?? 0,
        run: () => handler(...args),
      });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }
    return ORIGINAL_SET_TIMEOUT(
      handler,
      delay,
      ...args,
    );
  }) as unknown as typeof setTimeout;
  return timers;
}

function seedStores() {
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: "session-reconnect",
          messages: [],
          isLoading: false,
        },
      ],
    ]),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as never]]),
    models: new Map(),
    slashCommands: new Map(),
    selectedModel: new Map([[SESSION_KEY, "openai/gpt-5"]]),
    selectedVariant: new Map(),
    selectedMode: new Map([[SESSION_KEY, "build"]]),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    eventSubscriptions: new Map(),
    contextUsage: new Map(),
    runtimeHealth: new Map(),
    selectedAgent: new Map(),
  });

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-reconnect",
        name: "Reconnect environment",
        branch: "main",
        containerId: "container-reconnect",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-07-27T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
        setupPhase: "ready",
      },
    ],
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
  });

  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: TAB_ID,
                type: "opencode-native",
                openCodeNativeData: {
                  environmentId: ENVIRONMENT_ID,
                  containerId: "container-reconnect",
                },
              },
            ],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: "container-reconnect",
        },
      ],
    ]),
    hydration: new Map([[ENVIRONMENT_ID, "done"]]),
    activeEnvironmentId: ENVIRONMENT_ID,
  });
}

function renderChat() {
  return render(
    <OpenCodeChatTab
      tabId={TAB_ID}
      data={{
        environmentId: ENVIRONMENT_ID,
        containerId: "container-reconnect",
      }}
      isActive
    />,
  );
}

async function runTimer(timer: CapturedTimer) {
  await act(async () => {
    timer.run();
    await Promise.resolve();
  });
}

afterAll(() => {
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module(
    "@/components/chat/VirtualizedMessageList",
    () => realVirtualizedMessageListSnapshot,
  );
  mock.module("./OpenCodeComposeBar", () => realOpenCodeComposeBarSnapshot);
});

describe("OpenCodeChatTab SSE reconnect", () => {
  beforeEach(() => {
    cleanup();
    console.debug = mock(() => {}) as typeof console.debug;
    console.log = mock(() => {}) as typeof console.log;
    mockSubscribeToEvents.mockReset();
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockResolvedValue([]);
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue(null);
    mockGetPendingQuestions.mockReset();
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPermissions.mockReset();
    mockGetPendingPermissions.mockResolvedValue([]);
    mockGetAvailableSlashCommands.mockReset();
    mockGetAvailableSlashCommands.mockResolvedValue([]);
    mockCheckClientHealth.mockReset();
    mockCheckClientHealth.mockResolvedValue(true);
    mockGetOpenCodeRuntimeHealth.mockReset();
    mockGetOpenCodeRuntimeHealth.mockResolvedValue({
      agents: [],
      skills: [],
      mcpServers: [],
      lspServers: [],
      formatters: [],
      todos: [],
      diffs: [],
      fetchedAt: "2026-07-27T00:00:00.000Z",
    });
    seedStores();
  });

  afterEach(async () => {
    await act(async () => {
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      await Promise.resolve();
    });
    globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
    Date.now = ORIGINAL_DATE_NOW;
    console.debug = ORIGINAL_CONSOLE_DEBUG;
    console.log = ORIGINAL_CONSOLE_LOG;
    cleanup();
    mock.restore();
  });

  test("logs a rejected subscription and reconnects after the base delay", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const replacement = eventChannel();
    const consoleError = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleError as typeof console.error;
    mockSubscribeToEvents
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockResolvedValueOnce(replacement.stream);

    try {
      renderChat();
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
      const timers = captureReconnectTimers();

      await act(async () => {
        firstSubscription.reject(new Error("SSE unavailable"));
        await firstSubscription.promise.catch(() => {});
      });

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Event subscription error:",
          expect.objectContaining({ message: "SSE unavailable" }),
        );
        expect(timers.map((timer) => timer.delay)).toEqual([3_000]);
      });

      await runTimer(timers[0]!);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2));
    } finally {
      console.error = originalConsoleError;
      await act(async () => {
        useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        replacement.close();
        await Promise.resolve();
      });
    }
  });

  test("uses capped exponential delays then keeps probing while desynced", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const consoleWarn = mock(() => {});
    const consoleError = mock(() => {});
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    console.warn = consoleWarn as typeof console.warn;
    console.error = consoleError as typeof console.error;
    mockSubscribeToEvents
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockImplementation(async () => emptyEventStream());

    try {
      renderChat();
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
      const timers = captureReconnectTimers();

      await act(async () => {
        firstSubscription.resolve(emptyEventStream());
        await firstSubscription.promise;
      });
      await waitFor(() => expect(timers).toHaveLength(1));

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await runTimer(timers[attempt]!);
        await waitFor(() => {
          expect(mockSubscribeToEvents).toHaveBeenCalledTimes(attempt + 2);
          if (attempt < 9) {
            expect(timers).toHaveLength(attempt + 2);
          }
        });
      }

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] SSE reconnect limit reached; continuing desynced probes for",
          ENVIRONMENT_ID,
        );
      });
      expect(timers.map((timer) => timer.delay)).toEqual([
        3_000,
        6_000,
        12_000,
        24_000,
        48_000,
        60_000,
        60_000,
        60_000,
        60_000,
        60_000,
        60_000,
      ]);
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(11);

      // A probe that still cannot reach the bridge leaves the tab desynced and
      // queues the next one at the cap, rather than stranding it forever.
      mockSubscribeToEvents.mockImplementationOnce(async () => {
        throw new Error("bridge still unreachable");
      });
      await runTimer(timers[10]!);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(12));
      await waitFor(() => expect(timers).toHaveLength(12));
      expect(timers[11]!.delay).toBe(60_000);
      expect(
        useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced,
      ).toBe(true);
    } finally {
      console.warn = originalConsoleWarn;
      console.error = originalConsoleError;
    }
  });

  test("a successful probe restores the backoff ladder even with no events", async () => {
    /*
     * `markEventSubscriptionHealthy` only fires on an inbound frame, and
     * `getOrCreateEventSubscription` carries the attempt count forward, so a
     * quiet session that resynced stayed pinned at the ceiling and skipped the
     * whole ladder on its next transient drop.
     */
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const probe = eventChannel();
    const consoleWarn = mock(() => {});
    const originalConsoleWarn = console.warn;
    console.warn = consoleWarn as typeof console.warn;
    mockSubscribeToEvents
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockImplementation(async () => emptyEventStream());

    try {
      renderChat();
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
      const timers = captureReconnectTimers();

      await act(async () => {
        firstSubscription.resolve(emptyEventStream());
        await firstSubscription.promise;
      });
      await waitFor(() => expect(timers).toHaveLength(1));

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await runTimer(timers[attempt]!);
        await waitFor(() =>
          expect(mockSubscribeToEvents).toHaveBeenCalledTimes(attempt + 2),
        );
      }
      await waitFor(() =>
        expect(
          useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
        ).toMatchObject({ desynced: true, reconnectAttempts: 10 }),
      );

      // The probe reconnects and rehydrates, but the session is idle so not a
      // single event arrives over it.
      mockSubscribeToEvents.mockImplementationOnce(async () => probe.stream);
      await runTimer(timers[10]!);
      await waitFor(() =>
        expect(
          useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
        ).toMatchObject({ desynced: false, reconnectAttempts: 0 }),
      );

      await act(async () => {
        probe.close();
        await Promise.resolve();
      });

      await waitFor(() => expect(timers).toHaveLength(12));
      expect(timers[11]!.delay).toBe(3_000);
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  test("stops probing once the environment has been deleted", async () => {
    /*
     * The probe self-reschedules: every failure re-enters the exhausted branch
     * and queues another 60s timer. A deleted environment has no bridge left to
     * reach, so without this gate the chain probes a dead port for the life of
     * the process and pins the whole component closure in memory.
     */
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const consoleWarn = mock(() => {});
    const originalConsoleWarn = console.warn;
    console.warn = consoleWarn as typeof console.warn;
    act(() => {
      useOpenCodeStore.setState({
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: new AbortController(),
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: false,
        }]]),
      });
    });
    mockSubscribeToEvents.mockImplementationOnce(() => firstSubscription.promise);

    try {
      renderChat();
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
      const timers = captureReconnectTimers();

      act(() => {
        useEnvironmentStore.setState({ environments: [] });
      });
      await act(async () => {
        firstSubscription.resolve(emptyEventStream());
        await firstSubscription.promise;
      });

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] SSE reconnect limit reached; environment is gone, stopping probes for",
          ENVIRONMENT_ID,
        );
      });
      expect(timers).toHaveLength(0);
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
      expect(
        useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID),
      ).toMatchObject({ desynced: true, reconnectTimer: null });
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  test("does not reconnect when the timer finds no current client or an active subscription", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    mockSubscribeToEvents.mockImplementationOnce(() => firstSubscription.promise);
    renderChat();
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
    const timers = captureReconnectTimers();

    await act(async () => {
      firstSubscription.resolve(emptyEventStream());
      await firstSubscription.promise;
    });
    await waitFor(() => expect(timers).toHaveLength(1));

    act(() => {
      useOpenCodeStore.getState().setClient(ENVIRONMENT_ID, null);
    });
    await runTimer(timers[0]!);
    expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);

    act(() => {
      useOpenCodeStore.getState().setClient(ENVIRONMENT_ID, MOCK_CLIENT as never);
      useOpenCodeStore.getState().getOrCreateEventSubscription(ENVIRONMENT_ID);
    });
    await runTimer(timers[0]!);
    expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
  });

  test("reconnects with the current replacement client instead of the dropped stream client", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const replacement = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockResolvedValueOnce(replacement.stream);
    renderChat();
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
    const timers = captureReconnectTimers();

    await act(async () => {
      firstSubscription.resolve(emptyEventStream());
      await firstSubscription.promise;
    });
    await waitFor(() => expect(timers).toHaveLength(1));

    act(() => {
      useOpenCodeStore
        .getState()
        .setClient(ENVIRONMENT_ID, REPLACEMENT_CLIENT as never);
    });
    await runTimer(timers[0]!);
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2));
    expect(mockSubscribeToEvents.mock.calls[1]?.[0]).toBe(REPLACEMENT_CLIENT);
    await act(async () => {
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      replacement.close();
      await Promise.resolve();
    });
  });

  test("an explicit abort resets the accumulated reconnect delay", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const heldSubscription = eventChannel();
    mockSubscribeToEvents
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockImplementationOnce(async () => emptyEventStream())
      .mockResolvedValueOnce(heldSubscription.stream)
      .mockImplementationOnce(async () => emptyEventStream());
    const view = renderChat();
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
    const timers = captureReconnectTimers();

    await act(async () => {
      firstSubscription.resolve(emptyEventStream());
      await firstSubscription.promise;
    });
    await waitFor(() => expect(timers.map((timer) => timer.delay)).toEqual([3_000]));

    await runTimer(timers[0]!);
    await waitFor(() => expect(timers.map((timer) => timer.delay)).toEqual([3_000, 6_000]));
    await runTimer(timers[1]!);
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(3));

    act(() => {
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      heldSubscription.close();
    });
    await waitFor(() => {
      expect(useOpenCodeStore.getState().eventSubscriptions.has(ENVIRONMENT_ID)).toBe(false);
    });

    Date.now = () => ORIGINAL_DATE_NOW() + 2_000;
    view.rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={{
          environmentId: ENVIRONMENT_ID,
          containerId: "container-reconnect",
        }}
        isActive={false}
      />,
    );
    view.rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={{
          environmentId: ENVIRONMENT_ID,
          containerId: "container-reconnect",
        }}
        isActive
      />,
    );

    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(4));
    await waitFor(() => {
      expect(timers.map((timer) => timer.delay)).toEqual([3_000, 6_000, 3_000]);
    });
  });

  test("a received event resets the reconnect backoff before the next drop", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
    const replacement = eventChannel();
    const originalConsoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockSubscribeToEvents
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockResolvedValueOnce(replacement.stream);

    try {
      renderChat();
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
      const timers = captureReconnectTimers();

      await act(async () => {
        firstSubscription.resolve(emptyEventStream());
        await firstSubscription.promise;
      });
      await waitFor(() => expect(timers.map((timer) => timer.delay)).toEqual([3_000]));

      await runTimer(timers[0]!);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2));

      await act(async () => {
        replacement.push({
          type: "session.error",
          properties: {
            sessionID: "session-reconnect",
            error: "event confirms connection",
          },
        } as OpenCodeEvent);
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore
            .getState()
            .sessions.get(SESSION_KEY)
            ?.messages.some((message) =>
              message.content.includes("event confirms connection"),
            ),
        ).toBe(true);
      });

      await act(async () => {
        replacement.close();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(timers.map((timer) => timer.delay)).toEqual([3_000, 3_000]);
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("a desynced reconnect rehydrates every projected session and pending request", async () => {
    const channel = eventChannel();
    const secondKey = createSessionKey(ENVIRONMENT_ID, "tab-opencode-second");
    const previous = new AbortController();
    act(() => {
      useOpenCodeStore.setState((state) => ({
        sessions: new Map(state.sessions).set(secondKey, {
          sessionId: "session-opencode-second",
          messages: [],
          isLoading: false,
        }),
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: previous,
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: true,
        }]]),
      }));
    });
    mockSubscribeToEvents.mockResolvedValueOnce(channel.stream);

    renderChat();

    await waitFor(() => {
      expect((mockGetSessionMessages.mock.calls as unknown[][])
        .some((call) => call[1] === "session-opencode-second"))
        .toBe(true);
      expect(mockGetPendingQuestions.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockGetPendingPermissions.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(
        useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced,
      ).toBe(false);
    });

    await act(async () => {
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
      await Promise.resolve();
    });
  });

  test("one unreachable session does not abandon the rest of the resync", async () => {
    /*
     * `getSessionMessages` throws unconditionally on a 404, so a single stale
     * projection used to skip every remaining session *and* the event loop
     * underneath it — leaving the tab consuming no live events at all and
     * repeating the identical failure on the sixty-second probe.
     */
    const channel = eventChannel();
    const staleKey = createSessionKey(ENVIRONMENT_ID, "tab-opencode-stale");
    const laterKey = createSessionKey(ENVIRONMENT_ID, "tab-opencode-later");
    const consoleWarn = mock(() => {});
    const originalConsoleWarn = console.warn;
    console.warn = consoleWarn as typeof console.warn;
    const previous = new AbortController();
    act(() => {
      useOpenCodeStore.setState((state) => ({
        sessions: new Map(state.sessions)
          .set(staleKey, {
            sessionId: "session-opencode-stale",
            messages: [],
            isLoading: false,
          })
          .set(laterKey, {
            sessionId: "session-opencode-later",
            messages: [],
            isLoading: false,
          }),
        eventSubscriptions: new Map([[ENVIRONMENT_ID, {
          abortController: previous,
          stream: null,
          isActive: false,
          reconnectAttempts: 10,
          reconnectTimer: null,
          desynced: true,
        }]]),
      }));
    });
    mockGetSessionMessages.mockImplementation(
      async (..._args: unknown[]) => {
        if (_args[1] === "session-opencode-stale") {
          throw new Error("Session not found: session-opencode-stale");
        }
        return [];
      },
    );
    mockSubscribeToEvents.mockResolvedValueOnce(channel.stream);

    try {
      renderChat();

      await waitFor(() => {
        // The session ordered after the failing one still rehydrated.
        expect((mockGetSessionMessages.mock.calls as unknown[][])
          .some((call) => call[1] === "session-opencode-later"))
          .toBe(true);
        expect(
          useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced,
        ).toBe(false);
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        "[OpenCodeChatTab] Failed to rehydrate session during resync:",
        "session-opencode-stale",
        expect.objectContaining({
          message: "Session not found: session-opencode-stale",
        }),
      );

      // Live events are being consumed, which the abandoned loop never reached.
      const callsBefore = mockGetSessionMessages.mock.calls.length;
      await act(async () => {
        channel.push({
          type: "message.updated",
          properties: { info: { sessionID: "session-reconnect" } },
        } as unknown as OpenCodeEvent);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          (mockGetSessionMessages.mock.calls as unknown[][])
            .slice(callsBefore)
            .some((call) => call[1] === "session-reconnect"),
        ).toBe(true),
      );
    } finally {
      console.warn = originalConsoleWarn;
      await act(async () => {
        useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
        await Promise.resolve();
      });
    }
  });
});
