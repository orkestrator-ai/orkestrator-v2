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

  test("uses capped exponential delays and stops after ten reconnect attempts", async () => {
    const firstSubscription = deferred<AsyncIterable<OpenCodeEvent>>();
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
        await waitFor(() => {
          expect(mockSubscribeToEvents).toHaveBeenCalledTimes(attempt + 2);
          if (attempt < 9) {
            expect(timers).toHaveLength(attempt + 2);
          }
        });
      }

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] SSE reconnect limit reached for",
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
      ]);
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(11);
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
});
