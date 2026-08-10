import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { createSessionKey as createOpenCodeSessionKey } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useConfigStore } from "@/stores/configStore";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realHooks from "@/hooks";
import * as realManualSessionRefresh from "@/hooks/useManualSessionRefresh";
import * as realStalledTurnWatchdog from "@/hooks/useStalledTurnWatchdog";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realOpenCodeClient from "@/lib/opencode-client";
import { mockToastError } from "../../../../../tests/mocks/sonner";

// Snapshot the real sibling modules before we install stubs so we can restore
// them when this file finishes. Without this, Bun's global mock.module cache
// would leak these stubs into other test files (notably OpenCodeComposeBar.test.tsx
// and slash-command-{directory,registry}.test.ts) and cause them to receive
// stub modules instead of the real ones.
import * as realOpenCodeComposeBar from "./OpenCodeComposeBar";
import * as realOpenCodePermissionCard from "./OpenCodePermissionCard";
import * as realOpenCodeQuestionCard from "./OpenCodeQuestionCard";
import * as realOpenCodeResumeSessionDialog from "./OpenCodeResumeSessionDialog";
import * as realSlashCommandDirectory from "./slash-command-directory";
import * as realSlashCommandRegistry from "./slash-command-registry";
const realOpenCodeComposeBarSnapshot = { ...realOpenCodeComposeBar };
const realOpenCodePermissionCardSnapshot = { ...realOpenCodePermissionCard };
const realOpenCodeQuestionCardSnapshot = { ...realOpenCodeQuestionCard };
const realOpenCodeResumeSessionDialogSnapshot = { ...realOpenCodeResumeSessionDialog };
const realSlashCommandDirectorySnapshot = { ...realSlashCommandDirectory };
const realSlashCommandRegistrySnapshot = { ...realSlashCommandRegistry };
const realHooksSnapshot = { ...realHooks };
const realManualSessionRefreshSnapshot = { ...realManualSessionRefresh };
const realStalledTurnWatchdogSnapshot = { ...realStalledTurnWatchdog };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;
let lastVirtualizedMessages: any[] = [];
let lastVirtualizedFind: any = null;
let capturedManualRefresh:
  | Parameters<typeof realManualSessionRefresh.useManualSessionRefresh>[0]["refresh"]
  | undefined;
let capturedBackgroundReconcile:
  | Parameters<typeof realStalledTurnWatchdog.useStalledTurnWatchdog>[0]["reconcile"]
  | undefined;

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock<
  (
    _client: unknown,
    _sessionId: string,
    _prompt: string,
    _options?: Record<string, unknown>,
  ) => Promise<{ success: boolean; requestId?: string; error?: string }>
>(async () => ({ success: true }));
const mockAbortSession = mock(async () => true);
const mockCreateSession = mock(async (_client?: unknown) => ({
  id: "session-1",
  createdAt: "2026-04-15T10:00:00.000Z",
}));
const mockGetSessionMessages = mock<
  (_client: unknown, _sessionId: string, _options?: unknown) => Promise<NativeMessage[]>
>(async () => []);
const mockGetSessionStatus = mock<
  (
    _client: unknown,
    _sessionId: string,
    _options?: { throwOnError?: boolean },
  ) => Promise<"idle" | "busy" | "retry" | null>
>(async () => null);
const mockGetStructuredOutput = mock<
  (_client: unknown, _sessionId: string, _requestId?: string) => Promise<any>
>(async () => null);
const mockGetPendingQuestions = mock(async (): Promise<QuestionRequest[]> => []);
const mockGetPendingPermissions = mock(async (): Promise<PermissionRequest[]> => []);
const mockListSessions = mock(async () => [
  { id: "session-1", createdAt: "2026-04-15T10:00:00.000Z" },
]);
const mockSubscribeToEvents = mock(
  async () => (async function* () {})() as AsyncGenerator<any>,
);
const mockGetAvailableSlashCommands = mock(async () => [] as any[]);
const mockCreateClient = mock(() => MOCK_CLIENT as any);
const mockCheckClientHealth = mock(async () => true);
function emptyRuntimeHealth(overrides: Record<string, unknown> = {}) {
  return {
    agents: [],
    skills: [],
    mcpServers: [],
    lspServers: [],
    formatters: [],
    todos: [],
    diffs: [],
    fetchedAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}
const mockGetOpenCodeRuntimeHealth = mock<
  (
    _client: unknown,
    _directory?: string,
    _sessionId?: string,
  ) => Promise<ReturnType<typeof emptyRuntimeHealth>>
>(async () => emptyRuntimeHealth());
const mockForkOpenCodeSession = mock<
  (
    _client: unknown,
    _sessionId: string,
    _messageId?: string,
  ) => Promise<{ id: string; title?: string }>
>(async () => ({ id: "fork-session", title: "OpenCode fork" }));
const mockGetOpenCodeServerLog = mock(async () => "");
const mockResolveSlashCommandDirectory = mock(() => undefined as string | undefined);
const mockShouldLoadSlashCommands = mock(() => false);
const mockGetNativeSlashCommands = mock((commands: any[]) => commands);
import type {
  OpenCodeModel,
  OpenCodeModelDefaults,
  OpenCodeModelsResponse,
  PermissionRequest,
  QuestionRequest,
} from "@/lib/opencode-client";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";
import {
  OPTIMISTIC_MESSAGE_PREFIX,
  TURN_STOPPED_BY_USER,
} from "@/lib/chat/client-only-messages";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import type {
  OpenCodeModelCatalogSnapshot,
  OpenCodeModelRef,
  OpenCodeModelPreferences,
} from "@/lib/backend";

const mockGetModelsWithDefaults = mock<() => Promise<OpenCodeModelsResponse>>(
  async () => ({ models: [] as OpenCodeModel[], defaults: {} as OpenCodeModelDefaults }),
);
const mockGetOpencodeModelPreferences = mock<
  () => Promise<OpenCodeModelPreferences>
>(async () => ({
  recent: [] as OpenCodeModelRef[],
  favorite: [] as OpenCodeModelRef[],
  variant: {} as Record<string, string>,
}));
const mockGetCachedOpenCodeModelCatalog = mock<
  (_projectId: string) => Promise<OpenCodeModelCatalogSnapshot | null>
>(async () => null);
const mockCacheOpenCodeModelCatalog = mock(async (
  projectId: string,
  models: OpenCodeModel[],
) => ({
  schemaVersion: 2 as const,
  projectId,
  catalogVersion: "test",
  updatedAt: "2026-01-01T00:00:00.000Z",
  models,
}));
const mockClaimPromptQueueHead = mock(async (
  queueKey: string,
  environmentId: string,
  _expectedMessageId: string,
  candidateMessages: Array<{ id: string }>,
) => {
  const claimed = candidateMessages[0] ?? null;
  const claimToken = claimed ? `claim-${claimed.id}` : null;
  if (claimed && claimToken) mockOutstandingQueueClaims.set(claimToken, claimed);
  return {
    claimed,
    claimToken,
    queue: queueSnapshot(queueKey, environmentId, candidateMessages.slice(1)),
  };
});
let mockQueueRevision = 1;
const mockOutstandingQueueClaims = new Map<string, { id: string }>();
const queueSessionKey = (queueKey: string) =>
  queueKey.slice(queueKey.indexOf("\u0000") + 1);
const queueSnapshot = (
  queueKey: string,
  environmentId: string,
  messages: Array<{ id: string }>,
) => ({
  queueKey,
  environmentId,
  messages,
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: mockQueueRevision++,
});
const mockRemovePromptQueueMessage = mock(
  async (queueKey: string, environmentId: string, messageId: string) => {
    const current = useOpenCodeStore.getState().getQueuedMessages(queueSessionKey(queueKey));
    return {
      removed: current.find((message) => message.id === messageId) ?? null,
      queue: queueSnapshot(
        queueKey,
        environmentId,
        current.filter((message) => message.id !== messageId),
      ),
    };
  },
);
const mockTransferPromptQueueMessageToComposeDraft = mock(
  async (
    queueKey: string,
    environmentId: string,
    messageId: string,
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
  ) => {
    const result = await mockRemovePromptQueueMessage(queueKey, environmentId, messageId);
    return {
      ...result,
      draft: result.removed
        ? {
            draftKey,
            ownerType,
            ownerId,
            value: { text: "", mentions: [], attachments: [] },
            updatedAt: "2026-01-01T00:00:00.000Z",
            revision: 1,
          }
        : null,
    };
  },
);
const mockGetAgentHandoff = mock(async (_handoffId: string): Promise<any> => null);
const mockAwaitBridgeReady = mock(async (): Promise<any> => null);
const mockAdoptNativeAgentSession = mock(async (input: {
  environmentId: string;
  agent: "opencode";
  logicalSessionKey: string;
  providerSessionId: string;
  expectedProviderSessionId?: string;
}) => ({
  id: "adopted-native-session",
  key: "adopted-key",
  ...input,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  dispatchedRequestIds: [],
}));
const mockEnsureNativeAgentSession = mock(async () => {
  const created = await mockCreateSession({ baseUrl: "http://127.0.0.1:9999" });
  if (!created) throw new Error("Failed to create OpenCode session");
  return {
    id: "native-session-record",
    environmentId: "env-1",
    agent: "opencode" as const,
    logicalSessionKey: "env-env-1:tab-1",
    providerSessionId: created.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dispatchedRequestIds: [],
  };
});

const openCodeClientModuleFactory = () => ({
  ...realOpenCodeClientSnapshot,
  checkClientHealth: mockCheckClientHealth,
  createClient: mockCreateClient,
  getModelsWithDefaults: mockGetModelsWithDefaults,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mockGetSessionStatus,
  getStructuredOutput: mockGetStructuredOutput,
  listSessions: mockListSessions,
  getPendingPermissions: mockGetPendingPermissions,
  getPendingQuestions: mockGetPendingQuestions,
  getAvailableSlashCommands: mockGetAvailableSlashCommands,
  sendPrompt: mockSendPrompt,
  formatOpenCodeError: mock((error) => String(error)),
  abortSession: mockAbortSession,
  subscribeToEvents: mockSubscribeToEvents,
  // Both hit the network. `getOpenCodeRuntimeHealth` ran for real against the
  // fake client in every test with its rejection swallowed, and a fork click
  // would have attempted a live SDK call.
  getOpenCodeRuntimeHealth: mockGetOpenCodeRuntimeHealth,
  forkOpenCodeSession: mockForkOpenCodeSession,
  ERROR_MESSAGE_PREFIX: "error-",
  SYSTEM_MESSAGE_PREFIX: "system-",
});

mock.module("@/lib/opencode-client", openCodeClientModuleFactory);

mock.module("@/lib/backend", () => ({
  awaitBridgeReady: mockAwaitBridgeReady,
  adoptNativeAgentSession: mockAdoptNativeAgentSession,
  ensureNativeAgentSession: mockEnsureNativeAgentSession,
  claimPromptQueueHead: mockClaimPromptQueueHead,
  acknowledgePromptQueueClaim: mock(async (queueKey, environmentId, claimToken) => {
    mockOutstandingQueueClaims.delete(claimToken);
    return queueSnapshot(
      queueKey,
      environmentId,
      useOpenCodeStore.getState().getQueuedMessages(queueSessionKey(queueKey)),
    );
  }),
  rejectPromptQueueClaim: mock(async (queueKey, environmentId, claimToken) => {
    const claimed = mockOutstandingQueueClaims.get(claimToken);
    mockOutstandingQueueClaims.delete(claimToken);
    const current = useOpenCodeStore.getState().getQueuedMessages(queueSessionKey(queueKey));
    return queueSnapshot(
      queueKey,
      environmentId,
      claimed ? [claimed, ...current] : current,
    );
  }),
  enqueuePromptQueueMessage: mock(async (queueKey, environmentId, message) =>
    queueSnapshot(queueKey, environmentId, [
      ...useOpenCodeStore.getState().getQueuedMessages(queueSessionKey(queueKey)),
      message,
    ])),
  requeuePromptQueueMessage: mock(async (queueKey, environmentId, message) =>
    {
      const current = useOpenCodeStore.getState()
        .getQueuedMessages(queueSessionKey(queueKey));
      return queueSnapshot(
        queueKey,
        environmentId,
        current.some((candidate) => candidate.id === message.id)
          ? current
          : [message, ...current],
      );
    }),
  removePromptQueueMessage: mockRemovePromptQueueMessage,
  transferPromptQueueMessageToComposeDraft: mockTransferPromptQueueMessageToComposeDraft,
  movePromptQueueMessage: mock(async (queueKey, environmentId) =>
    queueSnapshot(
      queueKey,
      environmentId,
      useOpenCodeStore.getState().getQueuedMessages(queueSessionKey(queueKey)),
    )),
  getAgentHandoff: mockGetAgentHandoff,
  getOpenCodeServerLog: mockGetOpenCodeServerLog,
  getOpencodeModelPreferences: mockGetOpencodeModelPreferences,
  getCachedOpenCodeModelCatalog: mockGetCachedOpenCodeModelCatalog,
  cacheOpenCodeModelCatalog: mockCacheOpenCodeModelCatalog,
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
}));

let composeText = "Rename the environment";
let composeAttachments: Array<{
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}> = [];
let lastComposeSendError: unknown;

mock.module("./OpenCodeComposeBar", () => ({
  OpenCodeComposeBar: ({
    onSend,
    onStop,
    onRefreshModels,
    onQueue,
    disabled,
    isLoading,
    showAddressAll,
    layout,
    favoriteModelIds,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    onStop?: () => Promise<void>;
    onRefreshModels?: () => void | Promise<void>;
    onQueue?: (text: string, attachments: typeof composeAttachments) => void;
    disabled?: boolean;
    isLoading?: boolean;
    showAddressAll?: boolean;
    layout?: "bottom" | "centered";
    favoriteModelIds?: string[];
  }) => (
    <>
      <div data-testid="opencode-compose-layout">{layout}</div>
      <div data-testid="opencode-address-all-state">
        {showAddressAll ? "shown" : "hidden"}
      </div>
      <div data-testid="opencode-favorite-models">
        {(favoriteModelIds ?? []).join(",")}
      </div>
      <button
        type="button"
        data-testid="opencode-send"
        disabled={disabled}
        onClick={() => {
          lastComposeSendError = undefined;
          void onSend(composeText, composeAttachments).catch((error) => {
            lastComposeSendError = error;
          });
        }}
      >
        Send
      </button>
      <button type="button" data-testid="opencode-queue" onClick={() => onQueue?.(composeText, composeAttachments)}>
        Queue
      </button>
      {isLoading ? (
        <button
          type="button"
          data-testid="opencode-stop"
          disabled={disabled}
          onClick={() => {
            void onStop?.();
          }}
        >
          Stop
        </button>
      ) : null}
      {onRefreshModels ? (
        <button
          type="button"
          data-testid="opencode-refresh-models"
          onClick={() => {
            void onRefreshModels();
          }}
        >
          Refresh
        </button>
      ) : null}
    </>
  ),
}));

mock.module("./OpenCodePermissionCard", () => ({
  OpenCodePermissionCard: ({
    permission,
    client,
  }: {
    permission: PermissionRequest;
    client: typeof MOCK_CLIENT;
  }) => (
    <div
      data-testid={`opencode-permission-card-${permission.id}`}
      data-session-id={permission.sessionId}
      data-client-url={client.baseUrl}
    >
      {permission.permission}
    </div>
  ),
}));

mock.module("./OpenCodeQuestionCard", () => ({
  OpenCodeQuestionCard: ({
    question,
    client,
  }: {
    question: QuestionRequest;
    client: typeof MOCK_CLIENT;
  }) => (
    <div
      data-testid={`opencode-question-card-${question.id}`}
      data-session-id={question.sessionId}
      data-client-url={client.baseUrl}
    >
      {question.questions[0]?.question}
    </div>
  ),
}));

mock.module("./OpenCodeResumeSessionDialog", () => ({
  OpenCodeResumeSessionDialog: ({
    open,
    onResume,
  }: {
    open: boolean;
    onResume: (sessionId: string) => void;
  }) => open ? (
    <button type="button" data-testid="opencode-resume-choice" onClick={() => onResume("resumed-opencode")}>
      Resume previous OpenCode session
    </button>
  ) : null,
}));

mock.module("./slash-command-directory", () => ({
  resolveSlashCommandDirectory: mockResolveSlashCommandDirectory,
  shouldLoadSlashCommands: mockShouldLoadSlashCommands,
}));

mock.module("./slash-command-registry", () => ({
  getNativeSlashCommands: mockGetNativeSlashCommands,
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: mock(() => ({
    isAtBottom: mockIsAtBottom,
    isAtBottomRef: { current: mockIsAtBottom },
    scrollToBottom: mockScrollToBottom,
    virtuosoRef: { current: null },
    scrollProps: {},
  })),
}));

mock.module("@/hooks/useManualSessionRefresh", () => ({
  ...realManualSessionRefreshSnapshot,
  useManualSessionRefresh: (
    options: Parameters<
      typeof realManualSessionRefresh.useManualSessionRefresh
    >[0],
  ) => {
    capturedManualRefresh = options.refresh;
    return realManualSessionRefreshSnapshot.useManualSessionRefresh(options);
  },
}));

mock.module("@/hooks/useStalledTurnWatchdog", () => ({
  ...realStalledTurnWatchdogSnapshot,
  useStalledTurnWatchdog: (
    options: Parameters<typeof realStalledTurnWatchdog.useStalledTurnWatchdog>[0],
  ) => {
    capturedBackgroundReconcile = options.reconcile;
    return realStalledTurnWatchdogSnapshot.useStalledTurnWatchdog(options);
  },
}));

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer, find }: any) => {
    lastVirtualizedMessages = messages;
    lastVirtualizedFind = find;
    return (
      <div>
        {messages.length > 0
          ? messages.map((message: any, index: number) => (
            <div key={message.id}>
              {renderMessage(index, message, index > 0 ? messages[index - 1] : null)}
            </div>
          ))
          : emptyState}
        {footer}
      </div>
    );
  },
}));

import {
  OpenCodeChatTab,
  __resetOpenCodeLocalStopsForTest,
} from "./OpenCodeChatTab";
import type { OpenCodeNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const SESSION_KEY = createOpenCodeSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
/** The user's persisted global OpenCode default, as the compose bar writes it. */
const DEFAULT_GLOBAL_MODEL = "openai/global-default";
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;
const ORIGINAL_WINDOW_SET_TIMEOUT = window.setTimeout;

let mockedNow = 0;
let intervalCallback: (() => void) | null = null;
let clearIntervalCalls = 0;

function createData(overrides: Partial<OpenCodeNativeData> = {}): OpenCodeNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
    ...overrides,
  };
}

function agentHandoffRecord(id: string, bootstrapPrompt: string) {
  const createdAt = "2026-07-27T12:00:00.000Z";
  return {
    version: 1,
    id,
    environmentId: ENVIRONMENT_ID,
    createdAt,
    snapshot: {
      version: 1,
      id,
      environmentId: ENVIRONMENT_ID,
      sourceProvider: "claude",
      destinationProvider: "opencode",
      sourceSessionId: "source-claude-session",
      createdAt,
      messages: [{
        id: "source-message",
        role: "user",
        content: "Continue the transferred task",
        parts: [{ type: "text", content: "Continue the transferred task" }],
        createdAt,
      }],
      bootstrapPrompt,
      stats: {
        messageCount: 1,
        toolCallCount: 0,
        includedMessageCount: 1,
        omittedMessageCount: 0,
        promptCharacters: bootstrapPrompt.length,
      },
    },
  };
}

function seedPaneLayout(
  sessionId?: string,
  launchOptions?: { initialAgentModel?: string; initialReasoningEffort?: string },
  agentHandoffId?: string,
) {
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
                openCodeNativeData: createData({ sessionId }),
                initialAgentModel: launchOptions?.initialAgentModel,
                initialReasoningEffort: launchOptions?.initialReasoningEffort,
                agentHandoffId,
              },
            ],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    hydration: new Map([[ENVIRONMENT_ID, "done"]]),
    activeEnvironmentId: ENVIRONMENT_ID,
  });
}

function PaneBackedOpenCodeChatTab() {
  const data = usePaneLayoutStore((state) => {
    const root = state.environments.get(ENVIRONMENT_ID)?.root;
    if (!root || root.kind !== "leaf") return undefined;
    return root.tabs.find((tab) => tab.id === TAB_ID)?.openCodeNativeData;
  });

  if (!data) return null;
  return <OpenCodeChatTab tabId={TAB_ID} data={data} isActive />;
}

function resetStores(name = "20260415-123456") {
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: "session-1",
          messages: [],
          isLoading: false,
        },
      ],
    ]),
    sessionLoadingRevisions: new Map(),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
    models: new Map(),
    modelSource: new Map(),
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
        projectId: "project-1",
        name,
        branch: "main",
        containerId: "container-1",
        status: "running",
        setupPhase: "ready",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T10:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      },
    ],
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
  });

  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      global: { ...state.config.global, opencodeModel: DEFAULT_GLOBAL_MODEL },
    },
  }));

  seedPaneLayout();
}

function eventChannel() {
  const queue: any[] = [];
  let wake = deferred<void>();
  let closed = false;
  const stream = (async function* () {
    while (!closed) {
      if (queue.length === 0) await wake.promise;
      while (queue.length > 0) yield queue.shift();
    }
  })();
  return {
    stream,
    push(event: any) {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function callOriginalWindowTimeout(
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
): number {
  return Reflect.apply(
    ORIGINAL_WINDOW_SET_TIMEOUT as (...timerArgs: unknown[]) => unknown,
    window,
    [handler, timeout, ...args],
  ) as number;
}

async function flushReactMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  });
}

function nativeMessage(id: string, content = id): NativeMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-07-16T12:00:00.000Z",
  };
}

// Restore the real sibling modules once this file's tests finish so later
// test files see the real modules.
afterAll(() => {
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
  mock.module("./OpenCodeComposeBar", () => realOpenCodeComposeBarSnapshot);
  mock.module("./OpenCodePermissionCard", () => realOpenCodePermissionCardSnapshot);
  mock.module("./OpenCodeQuestionCard", () => realOpenCodeQuestionCardSnapshot);
  mock.module("./OpenCodeResumeSessionDialog", () => realOpenCodeResumeSessionDialogSnapshot);
  mock.module("./slash-command-directory", () => realSlashCommandDirectorySnapshot);
  mock.module("./slash-command-registry", () => realSlashCommandRegistrySnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module(
    "@/hooks/useManualSessionRefresh",
    () => realManualSessionRefreshSnapshot,
  );
  mock.module(
    "@/hooks/useStalledTurnWatchdog",
    () => realStalledTurnWatchdogSnapshot,
  );
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

describe("OpenCodeChatTab", () => {
  beforeEach(() => {
    cleanup();
    // Claimed stops live at module scope so the shared, environment-wide SSE
    // subscription can see them; they outlive `cleanup()` and would otherwise
    // let one test's stop suppress the next test's marker.
    __resetOpenCodeLocalStopsForTest();
    mockOutstandingQueueClaims.clear();
    // Other OpenCode component suites restore this broadly mocked module in
    // afterAll. Re-register it per test so parallel files cannot leave this
    // long-running suite bound to the real network client.
    mock.module("@/lib/opencode-client", openCodeClientModuleFactory);
    mockClaimPromptQueueHead.mockReset();
    mockClaimPromptQueueHead.mockImplementation(async (
      queueKey,
      environmentId,
      _expectedMessageId,
      candidateMessages,
    ) => {
      const claimed = candidateMessages[0] ?? null;
      const claimToken = claimed ? `claim-${claimed.id}` : null;
      if (claimed && claimToken) mockOutstandingQueueClaims.set(claimToken, claimed);
      return {
        claimed,
        claimToken,
        queue: queueSnapshot(queueKey, environmentId, candidateMessages.slice(1)),
      };
    });
    composeText = "Rename the environment";
    composeAttachments = [];
    lastComposeSendError = undefined;
    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockGetAgentHandoff.mockReset();
    mockGetAgentHandoff.mockResolvedValue(null);
    mockAwaitBridgeReady.mockReset();
    mockAwaitBridgeReady.mockResolvedValue({
      status: "ready",
      port: 9999,
      authToken: "opencode-secret",
    });
    mockAdoptNativeAgentSession.mockClear();
    mockEnsureNativeAgentSession.mockClear();
    mockSendPrompt.mockClear();
    mockSendPrompt.mockImplementation(async () => ({
      success: true,
      requestId: "structured-request-default",
    }));
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockRemovePromptQueueMessage.mockReset();
    mockRemovePromptQueueMessage.mockImplementation(
      async (queueKey, environmentId, messageId) => {
        const current = useOpenCodeStore.getState().getQueuedMessages(queueSessionKey(queueKey));
        return {
          removed: current.find((message) => message.id === messageId) ?? null,
          queue: queueSnapshot(
            queueKey,
            environmentId,
            current.filter((message) => message.id !== messageId),
          ),
        };
      },
    );
    mockTransferPromptQueueMessageToComposeDraft.mockReset();
    mockTransferPromptQueueMessageToComposeDraft.mockImplementation(
      async (queueKey, environmentId, messageId, draftKey, ownerType, ownerId) => {
        const result = await mockRemovePromptQueueMessage(queueKey, environmentId, messageId);
        return {
          ...result,
          draft: result.removed
            ? {
                draftKey,
                ownerType,
                ownerId,
                value: { text: "", mentions: [], attachments: [] },
                updatedAt: "2026-01-01T00:00:00.000Z",
                revision: 1,
              }
            : null,
        };
      },
    );
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(async () => ({
      id: "session-1",
      createdAt: "2026-04-15T10:00:00.000Z",
    }));
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(async () => []);
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue(null);
    mockGetStructuredOutput.mockReset();
    mockGetStructuredOutput.mockResolvedValue(null);
    mockGetPendingQuestions.mockReset();
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPermissions.mockReset();
    mockGetPendingPermissions.mockResolvedValue([]);
    mockListSessions.mockClear();
    mockListSessions.mockImplementation(async () => [
      { id: "session-1", createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockSubscribeToEvents.mockReset();
    mockSubscribeToEvents.mockImplementation(
      async () => (async function* () {})() as AsyncGenerator<any>,
    );
    mockGetAvailableSlashCommands.mockReset();
    mockGetAvailableSlashCommands.mockResolvedValue([]);
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => MOCK_CLIENT as any);
    mockCheckClientHealth.mockReset();
    mockCheckClientHealth.mockResolvedValue(true);
    mockGetOpenCodeRuntimeHealth.mockClear();
    mockGetOpenCodeRuntimeHealth.mockImplementation(async () => emptyRuntimeHealth());
    mockForkOpenCodeSession.mockClear();
    mockForkOpenCodeSession.mockImplementation(async () => ({
      id: "fork-session",
      title: "OpenCode fork",
    }));
    mockGetOpenCodeServerLog.mockReset();
    mockGetOpenCodeServerLog.mockResolvedValue("");
    mockResolveSlashCommandDirectory.mockReset();
    mockResolveSlashCommandDirectory.mockReturnValue(undefined);
    mockShouldLoadSlashCommands.mockReset();
    mockShouldLoadSlashCommands.mockReturnValue(false);
    mockGetNativeSlashCommands.mockReset();
    mockGetNativeSlashCommands.mockImplementation((commands) => commands);
    mockGetModelsWithDefaults.mockClear();
    mockGetModelsWithDefaults.mockImplementation(async () => ({
      models: [],
      defaults: {},
    }));
    mockGetOpencodeModelPreferences.mockClear();
    mockGetOpencodeModelPreferences.mockImplementation(async () => ({
      recent: [],
      favorite: [],
      variant: {},
    }));
    mockGetCachedOpenCodeModelCatalog.mockReset();
    mockGetCachedOpenCodeModelCatalog.mockResolvedValue(null);
    mockCacheOpenCodeModelCatalog.mockReset();
    mockCacheOpenCodeModelCatalog.mockImplementation(async (projectId, models) => ({
      schemaVersion: 2,
      projectId,
      catalogVersion: "test",
      updatedAt: "2026-01-01T00:00:00.000Z",
      models,
    }));
    mockScrollToBottom.mockClear();
    mockToastError.mockClear();
    mockIsAtBottom = true;
    lastVirtualizedMessages = [];
    lastVirtualizedFind = null;
    capturedManualRefresh = undefined;
    capturedBackgroundReconcile = undefined;
    resetStores();
  });

  afterEach(() => {
    useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
    cleanup();
    Date.now = ORIGINAL_DATE_NOW;
    globalThis.setInterval = ORIGINAL_SET_INTERVAL;
    globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
    window.setTimeout = ORIGINAL_WINDOW_SET_TIMEOUT;
    mock.restore();
  });

  test("resolves the OpenCode bridge port from backend readiness", async () => {
    useOpenCodeStore.setState({ clients: new Map(), sessions: new Map() });
    mockAwaitBridgeReady.mockResolvedValue({
      status: "ready",
      port: 7778,
      authToken: "ready-token",
    });

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => expect(mockEnsureNativeAgentSession).toHaveBeenCalled());
    expect(mockAwaitBridgeReady).toHaveBeenCalledWith(ENVIRONMENT_ID, "opencode");
    await waitFor(() =>
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:7778",
        undefined,
        "ready-token",
      ));
  });

  test.each([
    ["failed", "OpenCode readiness failed"],
    ["timed-out", "OpenCode readiness timed out"],
  ])("surfaces a %s backend readiness result", async (status, message) => {
    useOpenCodeStore.setState({ clients: new Map(), sessions: new Map() });
    mockAwaitBridgeReady.mockResolvedValue({
      status,
      error: { message, retryable: true },
    });

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByText(`Error: ${message}`)).toBeTruthy();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test("does not install the bridge client when readiness resolves after unmount", async () => {
    // `awaitBridgeReady` can block for the full readiness timeout. A tab that
    // is gone by the time it resolves must not write the client or the server
    // status into the environment-scoped store.
    useOpenCodeStore.setState({
      clients: new Map(),
      sessions: new Map(),
      serverStatus: new Map(),
    });
    const readiness = deferred<{
      status: "ready";
      port: number;
      authToken: string;
    }>();
    mockAwaitBridgeReady.mockImplementationOnce(() => readiness.promise);

    const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await waitFor(() => expect(mockAwaitBridgeReady).toHaveBeenCalled());

    view.unmount();

    await act(async () => {
      readiness.resolve({ status: "ready", port: 7781, authToken: "late-token" });
      await readiness.promise;
    });

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(useOpenCodeStore.getState().clients.get(ENVIRONMENT_ID)).toBeUndefined();
    expect(useOpenCodeStore.getState().serverStatus.get(ENVIRONMENT_ID)).toBeUndefined();
  });

  test("handles a subscription that returns no event stream", async () => {
    mockSubscribeToEvents.mockResolvedValue(null as never);

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(
      () => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await flushReactMicrotasks();
    expect(useOpenCodeStore.getState().hasActiveEventSubscription(ENVIRONMENT_ID))
      .toBe(false);
  });

  test("renders a friendly catalog label for the backend-confirmed assistant model", async () => {
    const catalogModel: OpenCodeModel = {
      id: "openai/gpt-5-review",
      name: "GPT-5 Review",
      provider: "openai",
    };
    const assistantMessage: NativeMessage = {
      ...nativeMessage("assistant-with-model", "Catalog-attributed response"),
      modelId: catalogModel.id,
    };
    mockGetModelsWithDefaults.mockResolvedValue({
      models: [catalogModel],
      defaults: { modelId: catalogModel.id },
    });
    mockGetSessionMessages.mockResolvedValue([assistantMessage]);
    useOpenCodeStore.setState((state) => ({
      sessions: new Map(state.sessions).set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [assistantMessage],
        isLoading: false,
      }),
      models: new Map(state.models).set(ENVIRONMENT_ID, [catalogModel]),
    }));

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByTitle("GPT-5 Review")).toBeTruthy();
    expect(screen.queryByText("openai/gpt-5-review")).toBeNull();
  });

  test("blocks sending until a restored agent handoff finishes loading", async () => {
    const handoffId = "opencode-delayed-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    expect((await screen.findByTestId("opencode-send")).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("opencode-send"));
    expect(mockSendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(agentHandoffRecord(handoffId, bootstrapPrompt));
      await pending.promise;
    });

    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    expect(mockSendPrompt).not.toHaveBeenCalled();

    composeText = "Verify every finding before continuing";
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() =>
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        expect.stringMatching(
          new RegExp(`"id": "${handoffId}"[\\s\\S]*${composeText}`),
        ),
        expect.any(Object),
      ),
    );
  });

  test("reconciles the first handoff prompt without duplicating or exposing its carrier", async () => {
    const handoffId = "opencode-authoritative-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    composeText = "Verify the transferred work";
    composeAttachments = [{
      id: "handoff-attachment",
      type: "image",
      path: "/workspace/handoff.png",
      previewUrl: "data:image/png;base64,handoff",
      name: "handoff.png",
    }];

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));

    let transported = "";
    await waitFor(() => {
      transported = String(mockSendPrompt.mock.calls[0]?.[2] ?? "");
      expect(transported).toContain(`"id": "${handoffId}"`);
      expect(transported).toContain(composeText);
      const optimistic = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages[0];
      expect(optimistic?.content).toBe(transported);
      expect(optimistic?.parts).toEqual([
        { type: "text", content: transported },
        {
          type: "file",
          content: "handoff.png",
          fileUrl: "data:image/png;base64,handoff",
        },
      ]);
    });

    const authoritativeUser: NativeMessage = {
      id: "provider-user-handoff",
      role: "user",
      content: transported,
      parts: [
        { type: "text", content: transported },
        {
          type: "file",
          content: "handoff.png",
          fileUrl: "data:image/png;base64,handoff",
        },
      ],
      createdAt: "2026-07-27T12:01:00.000Z",
    };
    act(() => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [authoritativeUser]);
    });

    await waitFor(() => {
      const stored = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(stored.map((message) => message.id)).toEqual(["provider-user-handoff"]);
      expect(lastVirtualizedMessages.filter(
        (message) => message.role === "user" && message.content === composeText,
      )).toHaveLength(1);
      expect(lastVirtualizedMessages.some(
        (message) => message.content.includes("<orkestrator-handoff"),
      )).toBe(false);
    });

    const authoritativeAssistant = nativeMessage(
      "provider-assistant-handoff",
      "Transferred work verified",
    );
    act(() => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        authoritativeUser,
        authoritativeAssistant,
      ]);
    });
    await waitFor(() => {
      expect(lastVirtualizedMessages.filter(
        (message) => message.role === "user" && message.content === composeText,
      )).toHaveLength(1);
      expect(lastVirtualizedMessages.some(
        (message) => message.content.includes("<orkestrator-handoff"),
      )).toBe(false);
      expect(lastVirtualizedMessages.at(-1)?.content).toBe("Transferred work verified");
    });

    act(() => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, false);
    });
    composeAttachments = [];
    composeText = "This is a later prompt";
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));
    expect(mockSendPrompt.mock.calls[1]?.[2]).toBe(composeText);
  });

  test("includes handoff history with an attachment-only first send", async () => {
    const handoffId = "opencode-attachment-only-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    composeText = "";
    composeAttachments = [{
      id: "attachment-only",
      type: "image",
      path: "/workspace/only.png",
      previewUrl: "data:image/png;base64,only",
      name: "only.png",
    }];

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
    expect(mockSendPrompt.mock.calls[0]?.[2]).toContain(`"id": "${handoffId}"`);
    expect(mockSendPrompt.mock.calls[0]?.[3]?.attachments).toHaveLength(1);
  });

  test("keeps handoff history pending after a rejected send and retries with it", async () => {
    const handoffId = "opencode-rejected-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    mockSendPrompt
      .mockResolvedValueOnce({ success: false, error: "Prompt rejected" })
      .mockResolvedValueOnce({ success: true, requestId: "retry-request" });
    composeText = "Retry with the imported context";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );

    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => {
      expect(lastComposeSendError).toEqual(new Error("Prompt rejected"));
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.id.startsWith("optimistic-"))).toBe(false);
      expect(messages.some((message) => message.id.startsWith("error-"))).toBe(true);
    });

    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));
    expect(mockSendPrompt.mock.calls[1]?.[2]).toContain(`"id": "${handoffId}"`);
    expect(mockSendPrompt.mock.calls[1]?.[2]).toContain(composeText);
  });

  test("keeps handoff history pending after an unexpected send rejection", async () => {
    const handoffId = "opencode-thrown-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    mockSendPrompt
      .mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce({ success: true, requestId: "retry-after-throw" });
    composeText = "Retry after transport failure";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => {
      expect(lastComposeSendError).toEqual(new Error("transport unavailable"));
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.isLoading).toBe(false);
      expect(session?.messages.some(
        (message) => message.id.startsWith("optimistic-") || message.id.startsWith("error-"),
      )).toBe(false);
    });

    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));
    expect(mockSendPrompt.mock.calls[1]?.[2]).toContain(`"id": "${handoffId}"`);
  });

  test("ignores client-only error and system rows when deciding whether handoff history is pending", async () => {
    const handoffId = "opencode-client-only-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    useOpenCodeStore.getState().addMessage(SESSION_KEY, {
      id: "error-local",
      role: "assistant",
      content: "Previous local error",
      parts: [{ type: "text", content: "Previous local error" }],
      createdAt: "2026-07-27T12:00:01.000Z",
    });
    useOpenCodeStore.getState().addMessage(SESSION_KEY, {
      id: "system-local",
      role: "system",
      content: "Previous local state",
      parts: [{ type: "text", content: "Previous local state" }],
      createdAt: "2026-07-27T12:00:02.000Z",
    });
    composeText = "Continue despite local rows";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalled());
    expect(mockSendPrompt.mock.calls[0]?.[2]).toContain(`"id": "${handoffId}"`);
  });

  test("refuses a native slash command before consuming pending handoff history", async () => {
    const handoffId = "opencode-native-command-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    useOpenCodeStore.getState().setSlashCommands(ENVIRONMENT_ID, [{
      name: "/review",
      description: "Review the branch",
    }]);
    composeText = "/review";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => {
      expect(lastComposeSendError).toEqual(new Error(
        "Send a normal message to import the transferred history before running /review.",
      ));
    });
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(mockRenameEnvironmentFromPrompt).not.toHaveBeenCalled();
    expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages).toEqual([]);

    composeText = "Import the context first";
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
    expect(mockSendPrompt.mock.calls[0]?.[2]).toContain(`"id": "${handoffId}"`);
    expect(mockSendPrompt.mock.calls[0]?.[3]?.command).toBeUndefined();
  });

  test("treats an unknown slash token as a normal first handoff message", async () => {
    const handoffId = "opencode-unknown-command-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    useOpenCodeStore.getState().setSlashCommands(ENVIRONMENT_ID, [{
      name: "/review",
      description: "Review the branch",
    }]);
    composeText = "/workspace/file.ts needs a fix";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
    expect(mockSendPrompt.mock.calls[0]?.[2]).toContain(`"id": "${handoffId}"`);
    expect(mockSendPrompt.mock.calls[0]?.[2]).toEndWith(composeText);
    expect(mockSendPrompt.mock.calls[0]?.[3]?.command).toBeUndefined();
  });

  test("forwards the directly selected agent with the first handoff prompt", async () => {
    const handoffId = "opencode-selected-agent-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    useOpenCodeStore.getState().setSelectedAgent(SESSION_KEY, "security-reviewer");
    composeText = "Continue with the selected specialist";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        expect.stringContaining(`"id": "${handoffId}"`),
        expect.objectContaining({ agent: "security-reviewer" }),
      );
    });
  });

  test("initializes once when a handoff resolves during a cold start", async () => {
    /*
     * `launchPrompt` flips undefined → string a few milliseconds after mount.
     * Listing it as an initialization dependency tore the effect down and re-ran
     * it mid-connect. Gate on readiness and read the prompt from a ref instead.
     */
    const handoffId = "opencode-single-init";
    // Force the cold path: with a cached client and session the effect short
    // circuits and never reaches the work a restart would duplicate.
    useOpenCodeStore.setState({ clients: new Map(), sessions: new Map() });
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    expect(mockAwaitBridgeReady).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(agentHandoffRecord(
        handoffId,
        `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`,
      ));
      await pending.promise;
    });
    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockAwaitBridgeReady).toHaveBeenCalledTimes(1);
  });

  test("lets the backend own a startup-agent prompt while clearing only the stale pane text", async () => {
    const startupTabId = "startup-agent";
    const startupSessionKey = createOpenCodeSessionKey(
      ENVIRONMENT_ID,
      startupTabId,
    );
    useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
      pendingAgentLaunch: true,
    });
    useOpenCodeStore.setState((state) => ({
      sessions: new Map(state.sessions).set(startupSessionKey, {
        sessionId: "startup-session",
        messages: [],
        isLoading: false,
      }),
    }));
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
                  id: startupTabId,
                  type: "opencode-native",
                  openCodeNativeData: createData({
                    sessionId: "startup-session",
                  }),
                  initialPrompt: "Renderer copy that the backend already owns",
                  initialAgentModel: "openai/gpt-5.6-sol",
                  initialReasoningEffort: "high",
                },
              ],
              activeTabId: startupTabId,
            },
            activePaneId: "default",
            containerId: "container-1",
          },
        ],
      ]),
      hydration: new Map([[ENVIRONMENT_ID, "done"]]),
      activeEnvironmentId: ENVIRONMENT_ID,
    });

    render(
      <OpenCodeChatTab
        tabId={startupTabId}
        data={createData({ sessionId: "startup-session" })}
        isActive={false}
        initialPrompt="Renderer copy that the backend already owns"
        initialAgentModel="openai/gpt-5.6-sol"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0];
      expect(tab?.initialPrompt).toBeUndefined();
    });
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0];
    expect(tab?.initialAgentModel).toBe("openai/gpt-5.6-sol");
    expect(tab?.initialReasoningEffort).toBe("high");
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  test("centers the compose bar with the ready title until message history exists", async () => {
    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByText("Ready to build!")).toBeTruthy();
    expect(screen.getByTestId("opencode-compose-layout").textContent).toBe("centered");

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      expect(screen.getByTestId("opencode-compose-layout").textContent).toBe("bottom");
    });
  });

  test("forwards transcript search ownership and OpenCode message content", async () => {
    const searchableMessage = nativeMessage(
      "searchable-opencode",
      "Search the complete OpenCode transcript",
    );
    useOpenCodeStore.getState().setMessages(SESSION_KEY, [searchableMessage]);

    const view = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        ownsGlobalShortcuts={false}
      />,
    );

    await waitFor(() => expect(lastVirtualizedFind?.isActive).toBe(false));
    expect(lastVirtualizedFind.getSearchText(searchableMessage)).toBe(
      "Search the complete OpenCode transcript",
    );

    view.rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        ownsGlobalShortcuts
      />,
    );

    await waitFor(() => expect(lastVirtualizedFind?.isActive).toBe(true));
  });

  test("replaces a cached client whose per-process credential is stale", async () => {
    mockCheckClientHealth.mockResolvedValue(false);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCheckClientHealth).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:9999",
        undefined,
        "opencode-secret",
      );
    });
    expect(useOpenCodeStore.getState().clients.get(ENVIRONMENT_ID)).toBe(MOCK_CLIENT as any);
  });

  test("refresh requests pull the latest transcript, status, and pending prompts", async () => {
    const { rerender } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    const serverMessage: NativeMessage = {
      id: "server-message",
      role: "assistant",
      content: "Updated by another client",
      parts: [{ type: "text", content: "Updated by another client" }],
      createdAt: "2026-07-16T12:00:00.000Z",
    };
    mockGetSessionMessages.mockResolvedValue([serverMessage]);
    mockGetSessionStatus.mockResolvedValue("busy");
    mockGetPendingQuestions.mockResolvedValue([
      { id: "question-1", sessionId: "session-1", questions: [] },
    ]);
    mockGetPendingPermissions.mockResolvedValue([
      {
        id: "permission-1",
        sessionId: "session-1",
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      },
    ]);
    useOpenCodeStore.setState((state) => ({
      ...state,
      pendingQuestions: new Map([
        ["stale-question", { id: "stale-question", sessionId: "session-1", questions: [] }],
      ]),
      pendingPermissions: new Map([
        [
          "stale-permission",
          {
            id: "stale-permission",
            sessionId: "session-1",
            permission: "edit",
            patterns: [],
            metadata: {},
            always: [],
          },
        ],
      ]),
    }));

    rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [serverMessage],
        isLoading: true,
      });
      expect(useOpenCodeStore.getState().pendingQuestions.has("question-1")).toBe(true);
      expect(useOpenCodeStore.getState().pendingPermissions.has("permission-1")).toBe(true);
      expect(useOpenCodeStore.getState().pendingQuestions.has("stale-question")).toBe(false);
      expect(useOpenCodeStore.getState().pendingPermissions.has("stale-permission")).toBe(false);
    });
  });

  test("failed refreshes preserve the current session snapshot", async () => {
    const currentMessage: NativeMessage = {
      id: "current-message",
      role: "assistant",
      content: "Keep this message",
      parts: [{ type: "text", content: "Keep this message" }],
      createdAt: "2026-07-16T12:00:00.000Z",
    };
    useOpenCodeStore.getState().setMessages(SESSION_KEY, [currentMessage]);

    const { rerender } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    mockGetSessionMessages.mockRejectedValue(new Error("server unavailable"));
    rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      currentMessage,
    ]);
  });

  test("rejects a manual refresh when pending requests change during hydration", async () => {
    const questions = deferred<QuestionRequest[]>();
    mockGetPendingQuestions.mockImplementation(() => questions.promise);

    const view = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    // Let the cached-client reconnect establish the tab's ready state. A
    // refresh watermark raised before that state commits is intentionally held
    // by the hook until the tab becomes refreshable.
    await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

    view.rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => {
      // Fast reconnect performs its own authoritative pending-request sync.
      // Wait for the manual refresh's second read so the update below lands
      // inside the hydration window this test is exercising.
      expect(mockGetPendingQuestions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    act(() => {
      useOpenCodeStore.getState().addPendingQuestion({
        id: "live-question",
        sessionId: "session-1",
        questions: [],
      });
    });
    await act(async () => {
      questions.resolve([]);
      await questions.promise;
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to refresh OpenCode tab",
        expect.objectContaining({
          description:
            "OpenCode pending requests changed while refreshing; try again",
        }),
      );
    });
    expect(useOpenCodeStore.getState().pendingQuestions.has("live-question")).toBe(
      true,
    );
  });

  test("applies pending requests when only another session changes during hydration", async () => {
    const questions = deferred<QuestionRequest[]>();
    mockGetPendingQuestions.mockImplementation(() => questions.promise);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
      />,
    );
    await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

    const unrelatedQuestion: QuestionRequest = {
      id: "other-session-question",
      sessionId: "session-2",
      questions: [],
    };
    act(() => {
      useOpenCodeStore.getState().addPendingQuestion(unrelatedQuestion);
    });

    const targetQuestion: QuestionRequest = {
      id: "rehydrated-question",
      sessionId: "session-1",
      questions: [],
    };
    await act(async () => {
      questions.resolve([targetQuestion]);
      await questions.promise;
    });

    await waitFor(() => {
      expect(
        useOpenCodeStore.getState().pendingQuestions.get(targetQuestion.id),
      ).toEqual(targetQuestion);
    });
    expect(
      useOpenCodeStore.getState().pendingQuestions.get(unrelatedQuestion.id),
    ).toEqual(unrelatedQuestion);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("discards pending-request hydration after the environment client is replaced", async () => {
    const questions = deferred<QuestionRequest[]>();
    mockGetPendingQuestions.mockImplementation(() => questions.promise);
    const liveQuestion: QuestionRequest = {
      id: "live-before-client-replacement",
      sessionId: "session-1",
      questions: [],
    };
    useOpenCodeStore.getState().addPendingQuestion(liveQuestion);

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

    act(() => {
      useOpenCodeStore.setState((state) => ({
        clients: new Map(state.clients).set(
          ENVIRONMENT_ID,
          { baseUrl: "http://127.0.0.1:replacement" } as any,
        ),
      }));
    });
    const staleQuestion: QuestionRequest = {
      id: "stale-from-replaced-client",
      sessionId: "session-1",
      questions: [],
    };
    await act(async () => {
      questions.resolve([staleQuestion]);
      await questions.promise;
    });

    expect(
      useOpenCodeStore.getState().pendingQuestions.get(liveQuestion.id),
    ).toEqual(liveQuestion);
    expect(
      useOpenCodeStore.getState().pendingQuestions.has(staleQuestion.id),
    ).toBe(false);
  });

  test("does not overwrite a live event with an older refresh snapshot", async () => {
    let resolveMessages!: (messages: NativeMessage[]) => void;
    const messagesPromise = new Promise<NativeMessage[]>((resolve) => {
      resolveMessages = resolve;
    });
    const liveMessage: NativeMessage = {
      id: "live-message",
      role: "assistant",
      content: "Arrived while refreshing",
      parts: [{ type: "text", content: "Arrived while refreshing" }],
      createdAt: "2026-07-16T12:00:01.000Z",
    };

    const { rerender } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );
    mockGetSessionMessages.mockImplementation(() => messagesPromise);
    mockGetSessionStatus.mockResolvedValue("idle");

    rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    act(() => {
      useOpenCodeStore.getState().addMessage(SESSION_KEY, liveMessage);
    });
    await act(async () => {
      resolveMessages([]);
      await messagesPromise;
    });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
        liveMessage,
      ]);
    });
  });

  test("returns before a refresh fetch when the client was replaced", async () => {
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockClear();
    mockGetSessionStatus.mockClear();
    const originalGetState = useOpenCodeStore.getState;
    let getStateCalls = 0;
    useOpenCodeStore.getState = (() => {
      getStateCalls += 1;
      const state = originalGetState();
      return getStateCalls === 2
        ? {
            ...state,
            clients: new Map(state.clients).set(
              ENVIRONMENT_ID,
              { baseUrl: "http://127.0.0.1:replacement-before-fetch" } as any,
            ),
          }
        : state;
    }) as typeof useOpenCodeStore.getState;

    try {
      await capturedManualRefresh?.({ manual: true });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();
      expect(mockGetSessionStatus).not.toHaveBeenCalled();
    } finally {
      useOpenCodeStore.getState = originalGetState;
    }
  });

  test("returns before a refresh fetch when the session was replaced", async () => {
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockClear();
    mockGetSessionStatus.mockClear();
    const originalGetState = useOpenCodeStore.getState;
    let getStateCalls = 0;
    useOpenCodeStore.getState = (() => {
      getStateCalls += 1;
      const state = originalGetState();
      return getStateCalls === 2
        ? {
            ...state,
            sessions: new Map(state.sessions).set(SESSION_KEY, {
              sessionId: "replacement-before-fetch",
              messages: [],
              isLoading: false,
            }),
          }
        : state;
    }) as typeof useOpenCodeStore.getState;

    try {
      await capturedManualRefresh?.({ manual: true });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();
      expect(mockGetSessionStatus).not.toHaveBeenCalled();
    } finally {
      useOpenCodeStore.getState = originalGetState;
    }
  });

  test("discards a refresh response after the client is replaced", async () => {
    const messages = deferred<NativeMessage[]>();
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(() => messages.promise);
    mockGetSessionStatus.mockResolvedValue("busy");
    const refresh = capturedManualRefresh?.({ manual: true });
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    act(() => {
      useOpenCodeStore.setState((state) => ({
        clients: new Map(state.clients).set(
          ENVIRONMENT_ID,
          { baseUrl: "http://127.0.0.1:replacement-after-fetch" } as any,
        ),
      }));
    });
    await act(async () => {
      messages.resolve([nativeMessage("stale-client-response")]);
      await messages.promise;
      await refresh;
    });

    expect(
      useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages,
    ).toEqual([]);
  });

  test("discards a refresh response after the session id is replaced", async () => {
    const messages = deferred<NativeMessage[]>();
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(() => messages.promise);
    mockGetSessionStatus.mockResolvedValue("busy");
    const refresh = capturedManualRefresh?.({ manual: true });
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    act(() => {
      useOpenCodeStore.getState().setSession(SESSION_KEY, {
        sessionId: "replacement-after-fetch",
        messages: [],
        isLoading: false,
      });
    });
    await act(async () => {
      messages.resolve([nativeMessage("stale-session-response")]);
      await messages.promise;
      await refresh;
    });

    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      sessionId: "replacement-after-fetch",
      messages: [],
    });
  });

  test("reports a same-session live mutation during a manual refresh", async () => {
    const messages = deferred<NativeMessage[]>();
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(() => messages.promise);
    mockGetSessionStatus.mockResolvedValue("busy");
    const refresh = capturedManualRefresh?.({ manual: true });
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    act(() => {
      useOpenCodeStore.getState().addMessage(
        SESSION_KEY,
        nativeMessage("live-during-direct-manual-refresh"),
      );
    });
    messages.resolve([nativeMessage("stale-manual-response")]);

    await expect(refresh).rejects.toThrow(
      "OpenCode session changed while refreshing; try again",
    );
  });

  test("silently discards a same-session live mutation during a background refresh", async () => {
    const messages = deferred<NativeMessage[]>();
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(() => messages.promise);
    mockGetSessionStatus.mockResolvedValue("busy");
    const refresh = capturedBackgroundReconcile?.();
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    const liveMessage = nativeMessage("live-during-background-refresh");

    act(() => {
      useOpenCodeStore.getState().addMessage(SESSION_KEY, liveMessage);
    });
    await act(async () => {
      messages.resolve([nativeMessage("stale-background-response")]);
      await messages.promise;
      await refresh;
    });

    expect(
      useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages,
    ).toEqual([liveMessage]);
  });

  test("does not let a repeated busy edge slip an older idle background reconcile through", async () => {
    const messages = deferred<NativeMessage[]>();
    const channel = eventChannel();
    mockSubscribeToEvents.mockResolvedValue(channel.stream);
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    // Already busy with a start time, so the next `busy` edge leaves the
    // session object untouched.
    act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(() => messages.promise);
    mockGetSessionStatus.mockResolvedValue("idle");

    const refresh = capturedBackgroundReconcile?.();
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    const sessionBeforeLiveEdge =
      useOpenCodeStore.getState().sessions.get(SESSION_KEY);
    const revisionBeforeLiveEdge =
      useOpenCodeStore.getState().sessionLoadingRevisions.get(SESSION_KEY) ?? 0;
    channel.push({
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "busy" },
      },
    });
    await waitFor(() =>
      expect(
        useOpenCodeStore.getState().sessionLoadingRevisions.get(SESSION_KEY),
      ).toBe(revisionBeforeLiveEdge + 1),
    );
    // The session reference guard alone cannot see this edge, so without the
    // revision the stale `idle` below would unlock a turn that is still busy.
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toBe(
      sessionBeforeLiveEdge,
    );

    await act(async () => {
      messages.resolve([]);
      await messages.promise;
      await refresh;
    });

    // Background reconcile: discarded silently, no user-facing error.
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(
      true,
    );

    useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
    channel.close();
  });

  test("preserves loading when a refresh returns no status", async () => {
    const refreshedMessage = nativeMessage("refresh-without-status");
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
    mockGetSessionMessages.mockResolvedValue([refreshedMessage]);
    mockGetSessionStatus.mockResolvedValue(null);

    await act(async () => {
      await capturedManualRefresh?.({ manual: true });
    });

    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      messages: [refreshedMessage],
      isLoading: true,
    });
  });

  test("applies a busy status returned by a refresh", async () => {
    const turnStartedAt = "2026-07-16T11:58:00.000Z";
    const refreshedMessage: NativeMessage = {
      ...nativeMessage("refresh-with-busy-status"),
      role: "user",
      createdAt: turnStartedAt,
    };
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockResolvedValue([refreshedMessage]);
    mockGetSessionStatus.mockResolvedValue("busy");

    await act(async () => {
      await capturedManualRefresh?.({ manual: true });
    });

    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      messages: [refreshedMessage],
      isLoading: true,
      loadingStartedAt: Date.parse(turnStartedAt),
    });
  });

  test("silently preserves live pending requests changed during a background sync", async () => {
    const questions = deferred<QuestionRequest[]>();
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushReactMicrotasks();
    mockGetSessionMessages.mockResolvedValue([]);
    mockGetSessionStatus.mockResolvedValue(null);
    mockGetPendingQuestions.mockClear();
    mockGetPendingQuestions.mockImplementation(() => questions.promise);
    mockGetPendingPermissions.mockResolvedValue([]);
    const refresh = capturedBackgroundReconcile?.();
    await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());
    const liveQuestion: QuestionRequest = {
      id: "live-during-background-pending-sync",
      sessionId: "session-1",
      questions: [],
    };
    act(() => useOpenCodeStore.getState().addPendingQuestion(liveQuestion));

    await act(async () => {
      questions.resolve([]);
      await questions.promise;
      await refresh;
    });

    expect(
      useOpenCodeStore.getState().pendingQuestions.get(liveQuestion.id),
    ).toEqual(liveQuestion);
  });

  describe("fast reconnect hydration", () => {
    test("hydrates a non-empty transcript and busy status", async () => {
      const turnStartedAt = "2026-07-16T11:59:00.000Z";
      const userMessage: NativeMessage = {
        id: "server-user-reconnect",
        role: "user",
        content: "keep going",
        parts: [{ type: "text", content: "keep going" }],
        createdAt: turnStartedAt,
      };
      const serverMessage = nativeMessage("server-reconnect");
      mockGetSessionMessages.mockResolvedValue([userMessage, serverMessage]);
      mockGetSessionStatus.mockResolvedValue("busy");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
          messages: [userMessage, serverMessage],
          isLoading: true,
          loadingStartedAt: Date.parse(turnStartedAt),
        });
      });
    });

    test("preserves existing messages when the server returns an empty snapshot", async () => {
      const existingMessage = nativeMessage("existing-reconnect");
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [existingMessage]);
      mockGetSessionMessages.mockResolvedValue([]);
      mockGetSessionStatus.mockResolvedValue("idle");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => expect(mockGetSessionStatus).toHaveBeenCalled());
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [existingMessage],
        isLoading: false,
      });
    });

    test("does not replace a live mutation with an older non-empty snapshot", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      mockGetSessionStatus.mockResolvedValue("busy");
      const liveMessage = nativeMessage("live-during-reconnect");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
      act(() => useOpenCodeStore.getState().addMessage(SESSION_KEY, liveMessage));

      await act(async () => {
        snapshot.resolve([nativeMessage("stale-reconnect")]);
        await snapshot.promise;
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
          messages: [liveMessage],
          isLoading: true,
        });
      });
    });

    test("rehydrates the transcript after a frame lands during the health check", async () => {
      const health = deferred<boolean>();
      mockCheckClientHealth.mockImplementation(() => health.promise);
      const snapshotMessage = nativeMessage("snapshot-after-health-check");
      mockGetSessionMessages.mockResolvedValue([snapshotMessage]);
      mockGetSessionStatus.mockResolvedValue("idle");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockCheckClientHealth).toHaveBeenCalled());

      /*
       * A frame lands while the health check is still in flight — before the
       * reconnect reads have even been issued. The session captured at the top
       * of `initialize` is now stale, but the snapshot that follows is strictly
       * newer than this frame, so it must still be applied. Comparing against
       * that pre-await capture would silently skip the catch-up.
       */
      act(() => {
        useOpenCodeStore.getState().addMessage(
          SESSION_KEY,
          nativeMessage("live-during-health-check"),
        );
      });

      await act(async () => {
        health.resolve(true);
        await health.promise;
      });
      await flushReactMicrotasks();

      await waitFor(() =>
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages,
        ).toEqual([snapshotMessage]),
      );
    });

    test("keeps a repeated live busy edge over an older idle snapshot", async () => {
      const messages = deferred<NativeMessage[]>();
      const status = deferred<"idle" | "busy" | "retry" | null>();
      act(() => {
        useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      });
      const revisionBeforeLiveEdge =
        useOpenCodeStore.getState().sessionLoadingRevisions.get(SESSION_KEY);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(() => messages.promise);
      mockGetSessionStatus.mockImplementation(() => status.promise);

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalled();
        expect(mockGetSessionStatus).toHaveBeenCalled();
        expect(mockSubscribeToEvents).toHaveBeenCalled();
      });

      channel.push({
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "busy" },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessionLoadingRevisions.get(SESSION_KEY),
        ).toBe((revisionBeforeLiveEdge ?? 0) + 1);
      });

      await act(async () => {
        messages.resolve([]);
        status.resolve("idle");
        await Promise.all([messages.promise, status.promise]);
      });
      await flushReactMicrotasks();
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.isLoading).toBe(
        true,
      );

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("keeps a live idle edge over an older busy snapshot", async () => {
      const reconnectMessages = deferred<NativeMessage[]>();
      const reconnectStatus = deferred<"idle" | "busy" | "retry" | null>();
      act(() => {
        useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      });
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      let messageRead = 0;
      mockGetSessionMessages.mockImplementation(async () => {
        messageRead += 1;
        return messageRead === 1 ? reconnectMessages.promise : [];
      });
      mockGetSessionStatus.mockImplementation(() => reconnectStatus.promise);

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalled();
        expect(mockGetSessionStatus).toHaveBeenCalled();
        expect(mockSubscribeToEvents).toHaveBeenCalled();
      });

      channel.push({
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "idle" },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.isLoading).toBe(
          false,
        );
      });

      await act(async () => {
        reconnectMessages.resolve([]);
        reconnectStatus.resolve("busy");
        await Promise.all([
          reconnectMessages.promise,
          reconnectStatus.promise,
        ]);
      });
      await flushReactMicrotasks();
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.isLoading).toBe(
        false,
      );

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("ignores a reconnect response after unmount", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      mockGetSessionStatus.mockResolvedValue("busy");
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      view.unmount();
      await act(async () => {
        snapshot.resolve([nativeMessage("after-unmount")]);
        await snapshot.promise;
      });

      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [],
        isLoading: false,
      });
    });

    test("ignores a response after the client is replaced", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      act(() => {
        useOpenCodeStore.setState((state) => ({
          clients: new Map(state.clients).set(ENVIRONMENT_ID, { baseUrl: "replacement" } as any),
        }));
      });
      await act(async () => {
        snapshot.resolve([nativeMessage("wrong-client")]);
        await snapshot.promise;
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([]);
    });

    test("ignores a response after the session is replaced", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      act(() => {
        useOpenCodeStore.getState().setSession(SESSION_KEY, {
          sessionId: "replacement-session",
          messages: [],
          isLoading: false,
        });
      });
      await act(async () => {
        snapshot.resolve([nativeMessage("wrong-session")]);
        await snapshot.promise;
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "replacement-session",
        messages: [],
      });
    });

    test("logs a rejected reconnect without changing the snapshot", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      mockGetSessionMessages.mockRejectedValue(new Error("reconnect unavailable"));

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Fast reconnect rehydration failed:",
            expect.any(Error),
          );
        });
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([]);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  test("rehydrates the session id saved in a restored pane tab", async () => {
    const restoredSessionId = "restored-opencode-session";
    const turnStartedAt = "2026-04-15T09:59:00.000Z";
    const restoredUserMessage: NativeMessage = {
      ...nativeMessage("restored-user", "Continue restored work"),
      role: "user",
      createdAt: turnStartedAt,
    };
    useOpenCodeStore.setState({ sessions: new Map() });
    seedPaneLayout(restoredSessionId);
    mockListSessions.mockResolvedValue([
      { id: restoredSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionMessages.mockResolvedValue([restoredUserMessage]);
    mockGetSessionStatus.mockResolvedValue("busy");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockAdoptNativeAgentSession).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        agent: "opencode",
        logicalSessionKey: SESSION_KEY,
        providerSessionId: restoredSessionId,
      });
      expect(mockGetSessionMessages).toHaveBeenCalledWith(
        MOCK_CLIENT,
        restoredSessionId,
        { throwOnError: true },
      );
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: restoredSessionId,
        messages: [restoredUserMessage],
        isLoading: true,
        loadingStartedAt: Date.parse(turnStartedAt),
      });
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    const restoredRoot = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)?.root;
    expect(restoredRoot?.kind).toBe("leaf");
    if (!restoredRoot || restoredRoot.kind !== "leaf") throw new Error("Expected pane leaf");
    const restoredTab = restoredRoot.tabs.find((tab) => tab.id === TAB_ID);
    expect(restoredTab?.openCodeNativeData?.sessionId).toBe(restoredSessionId);
  });

  test("adopts a late projected session with its busy status and pending requests", async () => {
    const projectedSessionId = "backend-startup-opencode";
    const projectedMessage = nativeMessage(
      "backend-startup-message",
      "Prompt dispatched by the backend",
    );
    const permission: PermissionRequest = {
      id: "backend-startup-permission",
      sessionId: projectedSessionId,
      permission: "edit",
      patterns: ["src/**"],
      metadata: {},
      always: [],
    };
    const question: QuestionRequest = {
      id: "backend-startup-question",
      sessionId: projectedSessionId,
      questions: [{
        question: "Continue the startup task?",
        header: "Continue",
        options: [],
      }],
    };

    render(<PaneBackedOpenCodeChatTab />);
    await waitFor(() => expect(mockGetSessionStatus).toHaveBeenCalled());
    await flushReactMicrotasks();

    mockListSessions.mockResolvedValue([
      { id: projectedSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionStatus.mockResolvedValue("idle");
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
      sessionId === projectedSessionId ? [projectedMessage] : []
    );
    mockGetSessionStatus.mockImplementation(async (_client, sessionId) =>
      sessionId === projectedSessionId ? "busy" : "idle"
    );
    mockGetPendingPermissions.mockResolvedValue([permission]);
    mockGetPendingQuestions.mockResolvedValue([question]);

    act(() => {
      usePaneLayoutStore.getState().updateTabNativeSessionId(
        TAB_ID,
        projectedSessionId,
        ENVIRONMENT_ID,
      );
    });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: projectedSessionId,
        messages: [projectedMessage],
        isLoading: true,
      });
    });
    expect(
      await screen.findByTestId(`opencode-permission-card-${permission.id}`),
    ).toBeTruthy();
    expect(
      screen.getByTestId(`opencode-question-card-${question.id}`),
    ).toBeTruthy();
    expect(mockAdoptNativeAgentSession).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      agent: "opencode",
      logicalSessionKey: SESSION_KEY,
      providerSessionId: projectedSessionId,
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("does not let an obsolete health probe overwrite a newer projection", async () => {
    const projectedSessionId = "projected-during-health";
    const firstHealth = deferred<boolean>();
    mockCheckClientHealth
      .mockImplementationOnce(() => firstHealth.promise)
      .mockResolvedValue(true);
    mockListSessions.mockResolvedValue([
      { id: projectedSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionStatus.mockResolvedValue("idle");

    render(<PaneBackedOpenCodeChatTab />);
    await waitFor(() => expect(mockCheckClientHealth).toHaveBeenCalledTimes(1));

    act(() => {
      usePaneLayoutStore.getState().updateTabNativeSessionId(
        TAB_ID,
        projectedSessionId,
        ENVIRONMENT_ID,
      );
    });

    await waitFor(() => expect(mockCheckClientHealth).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
        projectedSessionId,
      );
    });

    await act(async () => {
      firstHealth.resolve(true);
      await firstHealth.promise;
    });
    await flushReactMicrotasks();

    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
      projectedSessionId,
    );
    expect(
      usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]
        ?.openCodeNativeData?.sessionId,
    ).toBe(projectedSessionId);
    expect(mockAdoptNativeAgentSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("cold-restores a persisted session with its transcript", async () => {
    const restoredSessionId = "cold-restored-opencode";
    const turnStartedAt = "2026-04-15T09:58:00.000Z";
    const restoredMessage: NativeMessage = {
      id: "restored-message",
      role: "user",
      content: "Persisted OpenCode transcript",
      parts: [{ type: "text", content: "Persisted OpenCode transcript" }],
      createdAt: turnStartedAt,
    };
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(restoredSessionId);
    mockListSessions.mockResolvedValue([
      { id: restoredSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionMessages.mockResolvedValue([restoredMessage]);
    mockGetSessionStatus.mockResolvedValue("retry");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: restoredSessionId,
        messages: [restoredMessage],
        isLoading: true,
        loadingStartedAt: Date.parse(turnStartedAt),
      });
    });
    expect(mockAdoptNativeAgentSession).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      agent: "opencode",
      logicalSessionKey: SESSION_KEY,
      providerSessionId: restoredSessionId,
    });
    expect(mockGetSessionMessages).toHaveBeenCalledWith(
      expect.anything(),
      restoredSessionId,
      { throwOnError: true },
    );
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("cold-restores pending requests only after installing the projected identity", async () => {
    const restoredSessionId = "cold-restored-with-pending";
    const permission: PermissionRequest = {
      id: "cold-restored-permission",
      sessionId: restoredSessionId,
      permission: "write",
      patterns: ["docs/**"],
      metadata: {},
      always: [],
    };
    const question: QuestionRequest = {
      id: "cold-restored-question",
      sessionId: restoredSessionId,
      questions: [{
        question: "Apply the pending change?",
        header: "Apply",
        options: [],
      }],
    };
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(restoredSessionId);
    mockListSessions.mockResolvedValue([
      { id: restoredSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionStatus.mockResolvedValue("busy");
    mockGetPendingPermissions.mockResolvedValue([permission]);
    mockGetPendingQuestions.mockResolvedValue([question]);

    render(<PaneBackedOpenCodeChatTab />);

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: restoredSessionId,
        isLoading: true,
      });
      expect(useOpenCodeStore.getState().pendingPermissions.get(permission.id))
        .toEqual(permission);
      expect(useOpenCodeStore.getState().pendingQuestions.get(question.id))
        .toEqual(question);
    });
    expect(
      screen.getByTestId(`opencode-permission-card-${permission.id}`),
    ).toBeTruthy();
    expect(
      screen.getByTestId(`opencode-question-card-${question.id}`),
    ).toBeTruthy();
  });

  test("replaces a missing restored session and persists the replacement id", async () => {
    const missingSessionId = "missing-opencode";
    useOpenCodeStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout(missingSessionId);
    mockListSessions.mockResolvedValue([]);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: missingSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId)
        .toBe("session-1");
    });
  });

  test("atomically replaces a missing projected session after creation finishes", async () => {
    const missingSessionId = "missing-while-replacing";
    const replacement = deferred<{
      id: string;
      createdAt: string;
    }>();
    useOpenCodeStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout(missingSessionId);
    mockListSessions.mockResolvedValue([]);
    mockCreateSession.mockImplementation(() => replacement.promise);

    render(<PaneBackedOpenCodeChatTab />);

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]
          ?.openCodeNativeData?.sessionId,
      ).toBe(missingSessionId);
    });
    expect(useOpenCodeStore.getState().sessions.has(SESSION_KEY)).toBe(false);

    await act(async () => {
      replacement.resolve({
        id: "replacement-after-cleanup",
        createdAt: "2026-04-15T10:00:00.000Z",
      });
      await replacement.promise;
    });
    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.sessionId).toBe(
        "replacement-after-cleanup",
      );
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]
          ?.openCodeNativeData?.sessionId,
      ).toBe("replacement-after-cleanup");
    });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  test("keeps a projected id unchanged when backend adoption rejects", async () => {
    const projectedSessionId = "projected-adoption-rejected";
    seedPaneLayout(projectedSessionId);
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map([[SESSION_KEY, {
        sessionId: projectedSessionId,
        messages: [nativeMessage("stored-before-adoption-rejection")],
        isLoading: false,
      }]]),
    }));
    mockListSessions.mockResolvedValue([
      { id: projectedSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionStatus.mockResolvedValue("idle");
    mockAdoptNativeAgentSession.mockRejectedValueOnce(
      new Error("projected adoption rejected"),
    );

    render(<PaneBackedOpenCodeChatTab />);

    expect(
      await screen.findByText("Error: projected adoption rejected"),
    ).toBeTruthy();
    expect(
      usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]
        ?.openCodeNativeData?.sessionId,
    ).toBe(projectedSessionId);
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
      projectedSessionId,
    );
    expect(mockEnsureNativeAgentSession).not.toHaveBeenCalled();
  });

  test("preserves a stored transcript when cold reconnect hydration rejects", async () => {
    const existingMessage = nativeMessage(
      "stored-before-cold-reconnect",
      "Keep this stored transcript",
    );
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map([
        [
          SESSION_KEY,
          {
            sessionId: "session-1",
            messages: [existingMessage],
            isLoading: false,
          },
        ],
      ]),
    }));
    seedPaneLayout("session-1");
    mockGetSessionMessages.mockRejectedValue(
      new Error("cold reconnect transcript unavailable"),
    );
    const originalWarn = console.warn;
    const consoleWarn = mock(() => {});
    console.warn = consoleWarn as unknown as typeof console.warn;

    try {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData({ sessionId: "session-1" })}
          isActive
        />,
      );

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to refresh messages on reconnect:",
          expect.any(Error),
        );
      });
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)).toMatchObject({
        sessionId: "session-1",
        messages: [existingMessage],
      });
      expect(screen.queryByText(/cold reconnect transcript unavailable/)).toBeNull();
      expect(mockCreateSession).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("surfaces a null session returned by the warm client", async () => {
    useOpenCodeStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout();
    mockCreateSession.mockResolvedValue(null as never);

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(
      await screen.findByText("Error: Failed to create OpenCode session"),
    ).toBeTruthy();
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(useOpenCodeStore.getState().sessions.has(SESSION_KEY)).toBe(false);
  });

  test("surfaces a restored-session transcript failure when no session is stored", async () => {
    const restoredSessionId = "restored-without-store";
    useOpenCodeStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout(restoredSessionId);
    mockListSessions.mockResolvedValue([
      { id: restoredSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionMessages.mockRejectedValue(new Error("transcript unavailable"));

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    expect(await screen.findByText("Error: transcript unavailable")).toBeTruthy();
    expect(useOpenCodeStore.getState().sessions.has(SESSION_KEY)).toBe(false);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("retries a failed cold initialization and writes the created session id", async () => {
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout();
    mockGetModelsWithDefaults.mockRejectedValueOnce(new Error("model load failed"));

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await screen.findByText("Error: model load failed");
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId)
        .toBe("session-1");
    });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  test("writes a manually resumed session id and transcript to both stores", async () => {
    const handoffId = "handoff-cleared-by-resume";
    seedPaneLayout(undefined, undefined, handoffId);
    mockGetAgentHandoff.mockResolvedValue(agentHandoffRecord(
      handoffId,
      `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`,
    ));
    const turnStartedAt = "2026-04-15T09:57:00.000Z";
    const resumedMessage: NativeMessage = {
      id: "resumed-message",
      role: "user",
      content: "Resumed OpenCode transcript",
      parts: [{ type: "text", content: "Resumed OpenCode transcript" }],
      createdAt: turnStartedAt,
    };
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-opencode" ? [resumedMessage] : []
    );
    mockGetSessionStatus.mockResolvedValue("busy");
    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(await screen.findByTestId("opencode-resume-choice"));

    await waitFor(() => {
      expect(mockAdoptNativeAgentSession).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        agent: "opencode",
        logicalSessionKey: SESSION_KEY,
        providerSessionId: "resumed-opencode",
        expectedProviderSessionId: "session-1",
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "resumed-opencode",
        messages: [resumedMessage],
        isLoading: true,
        loadingStartedAt: Date.parse(turnStartedAt),
      });
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId)
        .toBe("resumed-opencode");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]).toMatchObject({
        agentHandoffId: undefined,
        consumedAgentHandoffId: handoffId,
      });
    });
  });

  test("atomically replaces stale metadata when resuming another session", async () => {
    /*
     * The tab key survives a resume, and the usage effect only ever writes a
     * *truthy* summary — so a resumed session whose transcript reports no usage
     * yet kept displaying the previous session's context meter, and the
     * session-keyed runtime health kept the previous session's todos and diffs
     * if the health refetch failed. Claude and Codex both replace this metadata
     * in the same update that publishes the new session.
     */
    useOpenCodeStore.getState().setContextUsage(SESSION_KEY, {
      usedTokens: 9_000,
      totalTokens: 10_000,
      percentUsed: 90,
      estimated: false,
      source: "opencode",
      updatedAt: "2026-04-15T09:00:00.000Z",
    });
    useOpenCodeStore.getState().setRuntimeHealth(
      SESSION_KEY,
      emptyRuntimeHealth({
        todos: [{ content: "From the old session", status: "pending", priority: "high" }],
      }) as never,
    );
    mockGetOpenCodeRuntimeHealth.mockRejectedValue(new Error("health unavailable"));
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-opencode" ? [] : []
    );

    const originalWarn = console.warn;
    console.warn = mock(() => {}) as unknown as typeof console.warn;
    try {
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
      fireEvent.click(await screen.findByTestId("opencode-resume-choice"));

      await waitFor(() =>
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
          .toBe("resumed-opencode"),
      );
      const state = useOpenCodeStore.getState();
      expect(state.contextUsage.has(SESSION_KEY)).toBe(false);
      expect(state.runtimeHealth.has(SESSION_KEY)).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("keeps the current session and resume dialog open when manual resume fails", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) => {
      if (sessionId === "resumed-opencode") {
        throw new Error("resume unavailable");
      }
      return [];
    });

    try {
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
      fireEvent.click(await screen.findByTestId("opencode-resume-choice"));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to resume session:",
          expect.any(Error),
        );
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "session-1",
        messages: [],
      });
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId,
      ).toBe("session-1");
      expect(screen.getByTestId("opencode-resume-choice")).toBeTruthy();
    } finally {
      console.error = originalError;
    }
  });

  test("does not switch sessions when backend adoption rejects a manual resume", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockAdoptNativeAgentSession.mockRejectedValueOnce(
      new Error("logical session belongs to another provider session"),
    );

    try {
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
      fireEvent.click(await screen.findByTestId("opencode-resume-choice"));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to resume session:",
          expect.any(Error),
        );
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
        .toBe("session-1");
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]
          ?.openCodeNativeData?.sessionId,
      ).toBe("session-1");
      expect(screen.getByTestId("opencode-resume-choice")).toBeTruthy();
    } finally {
      console.error = originalError;
    }
  });

  test("renders pending permission and question cards for the active session", async () => {
    const permission: PermissionRequest = {
      id: "permission-visible",
      sessionId: "session-1",
      permission: "edit",
      patterns: ["src/**"],
      metadata: {},
      always: [],
    };
    const question: QuestionRequest = {
      id: "question-visible",
      sessionId: "session-1",
      questions: [{ question: "Continue with the edit?", header: "Confirm", options: [] }],
    };
    mockGetPendingPermissions.mockResolvedValue([permission]);
    mockGetPendingQuestions.mockResolvedValue([question]);
    useOpenCodeStore.setState((state) => ({
      ...state,
      pendingPermissions: new Map([
        [permission.id, permission],
        [
          "permission-other-session",
          { ...permission, id: "permission-other-session", sessionId: "session-other" },
        ],
      ]),
      pendingQuestions: new Map([
        [question.id, question],
        [
          "question-other-session",
          { ...question, id: "question-other-session", sessionId: "session-other" },
        ],
      ]),
    }));

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    const permissionCard = await screen.findByTestId(
      "opencode-permission-card-permission-visible",
    );
    expect(permissionCard.getAttribute("data-session-id")).toBe("session-1");
    expect(permissionCard.getAttribute("data-client-url")).toBe(MOCK_CLIENT.baseUrl);
    expect(permissionCard.textContent).toBe("edit");

    const questionCard = screen.getByTestId("opencode-question-card-question-visible");
    expect(questionCard.getAttribute("data-session-id")).toBe("session-1");
    expect(questionCard.getAttribute("data-client-url")).toBe(MOCK_CLIENT.baseUrl);
    expect(questionCard.textContent).toBe("Continue with the edit?");

    expect(
      screen.queryByTestId("opencode-permission-card-permission-other-session"),
    ).toBeNull();
    expect(
      screen.queryByTestId("opencode-question-card-question-other-session"),
    ).toBeNull();
  });

  test("keeps live pending cards when authoritative rehydration fails", async () => {
    const permission: PermissionRequest = {
      id: "permission-survives-blip",
      sessionId: "session-1",
      permission: "edit",
      patterns: ["src/**"],
      metadata: {},
      always: [],
    };
    const question: QuestionRequest = {
      id: "question-survives-blip",
      sessionId: "session-1",
      questions: [{ question: "Continue?", header: "Confirm", options: [] }],
    };
    useOpenCodeStore.setState((state) => ({
      ...state,
      pendingPermissions: new Map([[permission.id, permission]]),
      pendingQuestions: new Map([[question.id, question]]),
    }));
    mockGetPendingPermissions.mockRejectedValueOnce(
      new Error("permission endpoint unavailable"),
    );
    const originalError = console.error;
    console.error = mock(() => {});

    try {
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => expect(mockGetPendingPermissions).toHaveBeenCalled());
      expect(
        useOpenCodeStore.getState().pendingPermissions.get(permission.id),
      ).toEqual(permission);
      expect(
        useOpenCodeStore.getState().pendingQuestions.get(question.id),
      ).toEqual(question);
    } finally {
      console.error = originalError;
    }
  });

  test("shows the scroll down accessory and scrolls to the bottom when clicked", () => {
    mockIsAtBottom = false;
    useOpenCodeStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: "Existing response",
            parts: [{ type: "text", content: "Existing response" }],
            createdAt: "2026-04-15T10:00:00.000Z",
          } as any,
        ],
        isLoading: false,
      });
      return { sessions };
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    const scrollButton = screen.getByRole("button", { name: "Scroll to bottom of conversation" });
    expect(scrollButton.closest('[data-testid="compose-dock"]')).not.toBeNull();

    fireEvent.click(scrollButton);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  test("pins active subagents to the rendered bottom and releases them on success", async () => {
    const activeMessage: NativeMessage = {
      id: "assistant-agent",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "Parent started" },
        {
          type: "subagent",
          content: "Worker agent",
          subagentId: "agent-1",
          subagentName: "Worker agent",
          toolState: "pending",
          subagentActions: [],
        },
        { type: "text", content: "Parent continued" },
      ],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const laterMessage: NativeMessage = {
      id: "assistant-later",
      role: "assistant",
      content: "Later response",
      parts: [{ type: "text", content: "Later response" }],
      createdAt: "2026-04-15T10:00:30.000Z",
    };

    useOpenCodeStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [activeMessage, laterMessage],
        isLoading: false,
      });
      return { sessions };
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
      "assistant-agent",
      "assistant-later",
      "assistant-agent:active-agents",
    ]);

    const completedMessage: NativeMessage = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "subagent"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      useOpenCodeStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(SESSION_KEY, {
          sessionId: "session-1",
          messages: [completedMessage, laterMessage],
          isLoading: false,
        });
        return { sessions };
      });
    });

    await waitFor(() => {
      expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
        "assistant-agent",
        "assistant-later",
      ]);
      expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
        "text",
        "subagent",
        "text",
      ]);
    });
  });

  test("shows the first prompt and naming feedback before the rename completes", async () => {
    composeText = "Audit the flaky reconnect flow";

    let resolveRename: (() => void) | undefined;
    mockRenameEnvironmentFromPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === composeText)).toBe(true);
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(true);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });
    const messagesDuringRename = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
    expect(messagesDuringRename.find((message) => message.content === composeText)?.id).toMatch(
      /^optimistic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(messagesDuringRename.find((message) => message.content === "Naming environment...")?.id).toMatch(
      /^system-naming-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    resolveRename?.();

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(false);
    });
  });

  test("continues sending and removes naming feedback when environment rename rejects", async () => {
    composeText = "Continue despite rename failure";
    mockRenameEnvironmentFromPrompt.mockRejectedValue(
      new Error("rename unavailable"),
    );
    const originalWarn = console.warn;
    const consoleWarn = mock(() => {});
    console.warn = consoleWarn as unknown as typeof console.warn;

    try {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );
      fireEvent.click(screen.getByTestId("opencode-send"));

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to rename environment from prompt:",
          expect.any(Error),
        );
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          composeText,
          expect.any(Object),
        );
      });
      const messages =
        useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(
        messages.some((message) => message.content === "Naming environment..."),
      ).toBe(false);
      expect(
        messages.some((message) => message.content === composeText),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("queues prompts with a generated UUID", async () => {
    composeText = "Queue this OpenCode prompt";
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("opencode-queue"));
    await waitFor(() => {
      const queued = useOpenCodeStore.getState().messageQueue.get(SESSION_KEY)?.[0];
      expect(queued?.text).toBe(composeText);
      expect(queued?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  test("renames compact Electron timestamp environments on the first prompt", async () => {
    resetStores("202604151234567");
    composeText = "Audit the flaky reconnect flow";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalled();
    });
  });

  test("enables the review follow-up action after a review session has messages", () => {
    useOpenCodeStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: "Review complete",
            parts: [{ type: "text", content: "Review complete" }],
            createdAt: "2026-04-15T10:00:00.000Z",
          } as any,
        ],
        isLoading: false,
      });
      return { sessions };
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
      />,
    );

    expect(screen.getByTestId("opencode-address-all-state").textContent).toBe("shown");
  });

  test("sends a normal review as Markdown without a structured output schema", async () => {
    const reviewPrompt = "## Review Scope\n\nReturn the review in Markdown.";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
        initialPrompt={reviewPrompt}
      />,
    );

    await waitFor(() => {
      const call = mockSendPrompt.mock.calls.find(
        (candidate) => candidate[2] === reviewPrompt,
      );
      expect(call).toBeDefined();
      expect(call?.[3]).not.toHaveProperty("outputSchema");
    });
    expect(mockGetStructuredOutput).not.toHaveBeenCalled();
  });

  test("removes the optimistic message and shows an error when sendPrompt fails", async () => {
    composeText = "This should not stick around";
    mockSendPrompt.mockImplementation(async () => ({
      success: false,
      error: "Prompt rejected",
    }));
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.messages.some((message) => message.content === composeText)).toBe(false);
      expect(session?.messages.some((message) => message.content === "Prompt rejected")).toBe(true);
      expect(session?.isLoading).toBe(false);
    });
  });

  test("uses the fallback error when sendPrompt rejects without detail", async () => {
    composeText = "This failed without provider detail";
    mockSendPrompt.mockImplementation(async () => ({ success: false }));
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );
    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.messages.some(
        (message) => message.content === "Failed to send prompt",
      )).toBe(true);
      expect(lastComposeSendError).toEqual(new Error("Failed to send prompt"));
    });
  });

  test("translates the opencode no-image-input rejection into an actionable message", async () => {
    composeText = "Review this screenshot";
    mockSendPrompt.mockImplementation(async () => ({
      success: false,
      error: 'ERROR: Cannot read "clipboard-2026-08-03T11-09-35-qualuq.png" (this model does not support image input). Inform the user.',
    }));
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );
    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.messages.some(
        (message) => message.content
          === "The selected model does not support image input. Switch to a vision-capable model or remove the image from the prompt.",
      )).toBe(true);
      expect(session?.isLoading).toBe(false);
    });
  });

  test("passes unrelated send failures through verbatim", async () => {
    // The image rewrite matches on a phrase, so an unrelated failure must not
    // be relabelled as an image problem the user cannot act on.
    const providerError = "ERROR: provider returned 503 (upstream overloaded)";
    composeText = "Summarise the diff";
    mockSendPrompt.mockImplementation(async () => ({
      success: false,
      error: providerError,
    }));
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );
    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.messages.some((message) => message.content === providerError)).toBe(true);
      expect(session?.isLoading).toBe(false);
    });
  });

  test("stores optimistic attachment parts and forwards attachments to sendPrompt", async () => {
    composeText = "Please inspect the screenshot";
    composeAttachments = [
      {
        id: "attachment-1",
        type: "image",
        path: "/workspace/screenshot.png",
        previewUrl: "data:image/png;base64,abc123",
        name: "screenshot.png",
      },
    ];
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      const userMessage = messages.find((message) => message.role === "user");
      expect(userMessage?.parts).toEqual([
        { type: "text", content: composeText },
        {
          type: "file",
          content: "screenshot.png",
          fileUrl: "data:image/png;base64,abc123",
        },
      ]);
    });

    expect(mockSendPrompt).toHaveBeenCalledWith(
      MOCK_CLIENT,
      "session-1",
      composeText,
      {
        model: "openai/gpt-5",
        variant: undefined,
        mode: "build",
        attachments: [
          {
            type: "image",
            path: "/workspace/screenshot.png",
            dataUrl: "data:image/png;base64,abc123",
            filename: "screenshot.png",
          },
        ],
      },
    );
  });

  test("renders timer states from the real elapsed timer hook", async () => {
    installTimerHarness(1_000_000);
    act(() => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    });

    const { container } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    const thinkingStatus = screen.getByRole("status");
    expect(thinkingStatus.textContent).toBe("OpenCode is thinking...");
    expect(screen.getByText("OpenCode is thinking...")).toBeTruthy();
    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();

    // Both status states share a fixed-height row so the end-of-turn swap
    // does not shift the transcript above it.
    const thinkingRow = container.querySelector(".chat-status-row");
    expect(thinkingRow?.textContent).toContain("OpenCode is thinking...");
    expect(thinkingRow?.parentElement?.className).not.toContain("py-");

    mockedNow = 1_001_500;
    act(() => {
      intervalCallback?.();
    });

    await waitFor(() => {
      expect(screen.queryByText("1s")).not.toBeNull();
    });

    act(() => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, false);
    });

    await waitFor(() => {
      expect(screen.queryByText("OpenCode is thinking...")).toBeNull();
      expect(screen.queryByText("Completed in 1s")).not.toBeNull();
    });

    const completedRows = container.querySelectorAll(".chat-status-row");
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0]?.textContent).toContain("Completed in 1s");
    expect(completedRows[0]?.parentElement?.className).not.toContain("py-");

    expect(clearIntervalCalls).toBeGreaterThan(0);
  });









  test("does not drain queued prompts while a draft exists", async () => {
    resetStores("review-table");
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Keep this OpenCode draft");
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind OpenCode draft",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useOpenCodeStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.draftText.get(SESSION_KEY)).toBe("Keep this OpenCode draft");
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind OpenCode draft",
    ]);
  });

  test("does not drain queued prompts while an attachment is staged", async () => {
    resetStores("review-table");
    useOpenCodeStore.getState().addAttachment(SESSION_KEY, {
      id: "staged-attachment",
      type: "image" as const,
      path: "/workspace/staged.png",
      previewUrl: "data:image/png;base64,staged",
      name: "staged.png",
    });
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind OpenCode attachment",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useOpenCodeStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.attachments.get(SESSION_KEY)?.map((attachment) => attachment.name)).toEqual([
      "staged.png",
    ]);
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind OpenCode attachment",
    ]);
  });

  test("stop aborts before promoting the queue and stays locked until the turn settles", async () => {
    const queuedAttachment = {
      id: "queued-attachment",
      type: "image" as const,
      path: "/workspace/queued.png",
      previewUrl: "data:image/png;base64,queued",
      name: "queued.png",
    };

    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: "queue-1",
      text: "Queued OpenCode prompt",
      attachments: [queuedAttachment],
      model: "openai/gpt-5",
      variant: "fast",
      mode: "build",
    });
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: "queue-2",
      text: "Second queued OpenCode prompt",
      attachments: [],
      model: "anthropic/claude-sonnet-4.5",
      mode: "plan",
    });

    let resolveAbort: ((value: boolean) => void) | undefined;
    mockAbortSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAbort = resolve;
        }),
    );

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-stop"));

    await waitFor(() => {
      const state = useOpenCodeStore.getState();
      expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
      expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      expect(state.draftText.get(SESSION_KEY) ?? "").toBe("");
      expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
        "Queued OpenCode prompt",
        "Second queued OpenCode prompt",
      ]);
    });

    resolveAbort?.(true);

    await waitFor(() => {
      const state = useOpenCodeStore.getState();
      expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      expect(state.draftText.get(SESSION_KEY)).toBe("Queued OpenCode prompt");
      expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
        "Second queued OpenCode prompt",
      ]);
      expect(state.attachments.get(SESSION_KEY)).toEqual([queuedAttachment]);
      expect(state.selectedModel.get(SESSION_KEY)).toBe("openai/gpt-5");
      expect(state.selectedVariant.get(SESSION_KEY)).toBe("fast");
      expect(state.selectedMode.get(SESSION_KEY)).toBe("build");
    });
    act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, false));
  });

  test("unlocks sending when idle arrives before abort completion", async () => {
    const pendingAbort = deferred<boolean>();
    mockAbortSession.mockImplementation(() => pendingAbort.promise);
    const channel = eventChannel();
    mockSubscribeToEvents.mockResolvedValue(channel.stream);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
      />,
    );
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
    act(() => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    });
    fireEvent.click(screen.getByTestId("opencode-stop"));
    await waitFor(() => expect(mockAbortSession).toHaveBeenCalled());

    channel.push({
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: "idle" },
      },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("opencode-stop")).toBeNull();
      expect(screen.getByTestId("opencode-send").hasAttribute("disabled")).toBe(
        false,
      );
    });

    await act(async () => {
      pendingAbort.resolve(true);
      await pendingAbort.promise;
    });
    await waitFor(() => {
      expect(
        useOpenCodeStore
          .getState()
          .sessions.get(SESSION_KEY)
          ?.messages.some((message) => message.content === TURN_STOPPED_BY_USER),
      ).toBe(true);
    });
    fireEvent.click(screen.getByTestId("opencode-send"));
    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        composeText,
        expect.any(Object),
      );
    });
    useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
    channel.close();
  });

  test("interrupts the turn before draining the queue to the draft", async () => {
    const pendingAbort = deferred<boolean>();
    mockAbortSession.mockImplementation(() => pendingAbort.promise);
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: "queue-1",
      text: "Promote me only after the abort lands",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("opencode-stop"));
    await waitFor(() => expect(mockAbortSession).toHaveBeenCalled());

    /*
     * Promoting the queue head is durable I/O and may stall, so the live turn
     * has to be interrupted first. Nothing gates this ordering except the
     * `await` in `handleStop` — pin it so a future refactor cannot reorder the
     * two and leave a turn running while the queue drains.
     */
    expect(mockTransferPromptQueueMessageToComposeDraft).not.toHaveBeenCalled();

    await act(async () => {
      pendingAbort.resolve(true);
      await pendingAbort.promise;
    });

    await waitFor(() =>
      expect(mockTransferPromptQueueMessageToComposeDraft).toHaveBeenCalled(),
    );
    expect(
      useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
        (message) => message.content === TURN_STOPPED_BY_USER,
      ),
    ).toBe(true);
  });

  test("keeps the queue intact when post-abort promotion fails", async () => {
    const consoleError = mock(() => {});
    const originalError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    mockTransferPromptQueueMessageToComposeDraft.mockRejectedValue(
      new Error("queue unavailable"),
    );
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: "queue-1",
      text: "Keep this OpenCode prompt",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    try {
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      fireEvent.click(screen.getByTestId("opencode-stop"));

      await waitFor(() => {
        expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
        expect(consoleError).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to promote queued prompt:",
          expect.any(Error),
        );
      });
      expect(useOpenCodeStore.getState().getQueuedMessages(SESSION_KEY)).toEqual([
        expect.objectContaining({ id: "queue-1" }),
      ]);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("dispatches the initialPrompt while the OpenCode tab is inactive", async () => {
    const initialPrompt = "Run the background OpenCode dispatch";
    composeText = initialPrompt;
    useOpenCodeStore.setState((state) => ({ ...state, clients: new Map() }));
    mockGetModelsWithDefaults.mockResolvedValue({
      models: [{
        id: "openai/gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        provider: "OpenAI",
        variants: ["medium", "xhigh"],
      }],
      defaults: {},
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
        initialAgentModel="openai/gpt-5.6-sol"
        initialReasoningEffort="xhigh"
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({
          model: "openai/gpt-5.6-sol",
          variant: "xhigh",
          mode: "build",
          requestId: "initial-prompt:env-1:tab-1",
        }),
      );
    });
  });

  test("clears the durably queued launch prompt once the tab's own dispatch is accepted", async () => {
    const initialPrompt = "Review the change after the launch race";
    const launchRequestId = `initial-prompt:${ENVIRONMENT_ID}:${TAB_ID}`;
    seedPaneLayout();
    // The durable queue already holds the launch prompt while this tab mounts
    // and wins the dispatch race.
    seedQueuedPrompt(useOpenCodeStore.getState(), SESSION_KEY, {
      id: launchRequestId,
      text: initialPrompt,
      attachments: [],
      model: undefined,
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() =>
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({ requestId: launchRequestId }),
      )
    );

    await waitFor(() =>
      expect(mockRemovePromptQueueMessage).toHaveBeenCalledWith(
        `opencode\u0000${SESSION_KEY}`,
        ENVIRONMENT_ID,
        launchRequestId,
      )
    );
    expect(useOpenCodeStore.getState().messageQueue.get(SESSION_KEY)).toEqual([]);
  });

  test("honours launch options against a warm client's live catalog without refetching", async () => {
    const initialPrompt = "Review with the requested model";
    seedPaneLayout(undefined, {
      initialAgentModel: "openai/gpt-5",
      initialReasoningEffort: "fast",
    });
    // A live catalogue is authoritative, so the warm path validates against it
    // directly rather than paying for another catalogue fetch.
    useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, [{
      id: "openai/gpt-5",
      name: "GPT 5",
      provider: "OpenAI",
      variants: ["fast"],
    } as any], "server");
    mockGetModelsWithDefaults.mockClear();

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
        initialAgentModel="openai/gpt-5"
        initialReasoningEffort="fast"
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({
          model: "openai/gpt-5",
          variant: "fast",
        }),
      );
    });
    expect(mockGetModelsWithDefaults).not.toHaveBeenCalled();
    // The one-shot options are consumed, so a later remount cannot replay them.
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(tab?.initialAgentModel).toBeUndefined();
    expect(tab?.initialReasoningEffort).toBeUndefined();
  });

  test("fetches a live catalog to validate launch options a warm cached catalog cannot", async () => {
    const initialPrompt = "Review with the requested model";
    seedPaneLayout(undefined, {
      initialAgentModel: "openai/gpt-5",
      initialReasoningEffort: "fast",
    });
    // Rehydrated from the durable project cache: same shape, but it cannot
    // prove the running server advertises these ids. Nothing else on the warm
    // path ever refreshes, so deferring would mean dropping the user's choice.
    useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, [{
      id: "openai/gpt-5",
      name: "Cached GPT 5",
      provider: "OpenAI",
      variants: ["fast"],
    } as any], "cache");
    mockGetModelsWithDefaults.mockClear();
    mockGetModelsWithDefaults.mockResolvedValue({
      models: [{
        id: "openai/gpt-5",
        name: "GPT 5",
        provider: "OpenAI",
        variants: ["fast"],
      }],
      defaults: {},
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
        initialAgentModel="openai/gpt-5"
        initialReasoningEffort="fast"
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({
          model: "openai/gpt-5",
          variant: "fast",
        }),
      );
    });
    expect(mockGetModelsWithDefaults).toHaveBeenCalled();
    expect(useOpenCodeStore.getState().hasLiveModels(ENVIRONMENT_ID)).toBe(true);
    expect(mockCacheOpenCodeModelCatalog).toHaveBeenCalledWith("project-1", [
      expect.objectContaining({ id: "openai/gpt-5", name: "GPT 5" }),
    ]);
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(tab?.initialAgentModel).toBeUndefined();
  });

  test("still reconnects when the launch-option catalog fetch rejects", async () => {
    const originalWarn = console.warn;
    const consoleWarn = mock(() => {});
    console.warn = consoleWarn as unknown as typeof console.warn;
    seedPaneLayout(undefined, { initialAgentModel: "openai/gpt-5" });
    mockGetModelsWithDefaults.mockClear();
    mockGetModelsWithDefaults.mockRejectedValue(new Error("catalog unavailable"));

    try {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
          initialPrompt="Review despite a broken catalog"
          initialAgentModel="openai/gpt-5"
        />,
      );

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to load models for launch options:",
          expect.any(Error),
        );
      });
      // The tab still connects and the prompt still goes out, on the default.
      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          "Review despite a broken catalog",
          expect.objectContaining({ model: undefined, variant: undefined }),
        );
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("uses the server default when a warm client's live catalog is empty", async () => {
    const initialPrompt = "Review with a safe default";
    seedPaneLayout(undefined, {
      initialAgentModel: "openai/gpt-5",
      initialReasoningEffort: "fast",
    });
    useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, [{
      id: "openai/gpt-5",
      name: "Cached GPT 5",
      provider: "OpenAI",
      variants: ["fast"],
    } as any], "cache");
    // The server reports nothing, so the choice still cannot be validated.
    mockGetModelsWithDefaults.mockClear();
    mockGetModelsWithDefaults.mockResolvedValue({ models: [], defaults: {} });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
        initialAgentModel="openai/gpt-5"
        initialReasoningEffort="fast"
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({
          model: undefined,
          variant: undefined,
        }),
      );
    });
    // Unvalidated options stay pending: the tab holds the only durable copy.
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(tab?.initialAgentModel).toBe("openai/gpt-5");
    expect(tab?.initialReasoningEffort).toBe("fast");
  });

  test("passes the synthetic default model to the SDK as no explicit override", async () => {
    const initialPrompt = "Review with the server default";
    useOpenCodeStore.setState((state) => ({
      ...state,
      models: new Map(),
      selectedModel: new Map([[SESSION_KEY, "default"]]),
    }));

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
        initialAgentModel="default"
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({ model: undefined, variant: undefined }),
      );
    });
  });

  test("retains one-shot launch options when the catalog comes back empty", async () => {
    // An empty catalog means the choice could not be validated, let alone
    // applied. Clearing here would destroy the tab's copy — the only durable
    // one left once `TerminalContainer` has handed ownership over — so a later
    // mount could never honour it.
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      models: new Map([
        [
          ENVIRONMENT_ID,
          [
            {
              id: "openai/gpt-5",
              name: "Cached GPT-5",
              provider: "openai",
              variants: ["high"],
            },
          ],
        ],
      ]),
    }));
    seedPaneLayout(undefined, {
      initialAgentModel: "openai/gpt-5",
      initialReasoningEffort: "high",
    });
    mockGetModelsWithDefaults.mockImplementationOnce(async () => ({
      models: [],
      defaults: {},
    } as never));

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialPrompt="Review with a temporarily unavailable catalog"
        initialAgentModel="openai/gpt-5"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => {
      expect(mockGetModelsWithDefaults).toHaveBeenCalled();
    });
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(tab?.initialAgentModel).toBe("openai/gpt-5");
    expect(tab?.initialReasoningEffort).toBe("high");
    expect(mockSendPrompt).toHaveBeenCalledWith(
      MOCK_CLIENT,
      "session-1",
      "Review with a temporarily unavailable catalog",
      expect.objectContaining({ model: undefined, variant: undefined }),
    );
  });

  test("clears one-shot launch options once the cold path resolves them", async () => {
    useOpenCodeStore.setState((state) => ({ ...state, clients: new Map(), models: new Map() }));
    seedPaneLayout(undefined, {
      initialAgentModel: "openai/gpt-5",
      initialReasoningEffort: "high",
    });
    mockGetModelsWithDefaults.mockImplementationOnce(async () => ({
      models: [
        { id: "openai/gpt-5", name: "GPT-5", provider: "OpenAI", variants: ["high"] },
      ],
      defaults: {},
    } as never));

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="openai/gpt-5"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
        .find((candidate) => candidate.id === TAB_ID);
      expect(tab?.initialAgentModel).toBeUndefined();
      expect(tab?.initialReasoningEffort).toBeUndefined();
    });
    expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe("openai/gpt-5");
  });

  test("seeds a model for a second tab that reuses a warm client", async () => {
    // Only the cold path fetches the model catalogue. A second tab in an
    // environment that already has a client takes the warm path, so without
    // explicit seeding its sessionKey would stay unset and every prompt would
    // silently fall back to the server default.
    const secondTabId = "tab-2";
    const secondSessionKey = createOpenCodeSessionKey(ENVIRONMENT_ID, secondTabId);
    useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, [
      { id: "openai/other-model", name: "Other Model", provider: "OpenAI", variants: [] },
      { id: DEFAULT_GLOBAL_MODEL, name: "Global Default", provider: "OpenAI", variants: [] },
    ] as any);
    mockCreateSession.mockImplementation(async () => ({
      id: "session-2",
      createdAt: "2026-04-15T10:05:00.000Z",
    }));
    expect(useOpenCodeStore.getState().getSelectedModel(secondSessionKey)).toBeUndefined();

    render(
      <OpenCodeChatTab
        tabId={secondTabId}
        data={createData()}
        isActive
        initialPrompt="Prompt from the second tab"
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedModel(secondSessionKey)).toBe(
        DEFAULT_GLOBAL_MODEL,
      );
    });
    // The first tab's own selection is untouched.
    expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe("openai/gpt-5");

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-2",
        "Prompt from the second tab",
        expect.objectContaining({ model: DEFAULT_GLOBAL_MODEL }),
      );
    });
  });

  test("queues the variant selected now, not the one implied by the launch model", async () => {
    composeText = "Queue after switching models";
    useOpenCodeStore.setState((state) => ({
      ...state,
      // Empty catalogue keeps the synthetic launch model "default" in place.
      models: new Map(),
      selectedModel: new Map([[SESSION_KEY, "default"]]),
    }));
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="default"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("opencode-queue")).toBeTruthy();
    });

    // The user switches off "default" onto a variant-capable model.
    act(() => {
      useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "openai/gpt-5");
      useOpenCodeStore.getState().setSelectedVariant(SESSION_KEY, "deep");
    });

    fireEvent.click(screen.getByTestId("opencode-queue"));

    await waitFor(() => {
      const queued = useOpenCodeStore.getState().messageQueue.get(SESSION_KEY)?.[0];
      expect(queued?.model).toBe("openai/gpt-5");
      expect(queued?.variant).toBe("deep");
    });
  });

  test("retains later model choices after a one-shot review tab remounts", async () => {
    const liveModels = [
      {
        id: "openai/review-model",
        name: "Review Model",
        provider: "OpenAI",
        variants: ["deep"],
      },
      {
        id: "openai/user-model",
        name: "User Model",
        provider: "OpenAI",
        variants: ["fast"],
      },
    ] as any;
    useOpenCodeStore.setState((state) => ({ ...state, clients: new Map() }));
    mockGetModelsWithDefaults.mockResolvedValue({
      models: liveModels,
      defaults: {},
    });
    const firstMount = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="openai/review-model"
        initialReasoningEffort="deep"
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe("openai/review-model");
      expect(useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY)).toBe("deep");
    });
    useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "openai/user-model");
    useOpenCodeStore.getState().setSelectedVariant(SESSION_KEY, "fast");
    firstMount.unmount();

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe("openai/user-model");
      expect(useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY)).toBe("fast");
    });
  });





  test("stop logs a failed abort without unlocking the running session", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockAbortSession.mockImplementation(async () => false);
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("opencode-stop"));

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
        expect(consoleError).toHaveBeenCalledWith("[OpenCodeChatTab] Failed to abort session");
      });
      // The turn is still running, so claiming it was stopped would be a lie.
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
          (message) => message.content === TURN_STOPPED_BY_USER,
        ),
      ).toBe(false);
      expect(mockTransferPromptQueueMessageToComposeDraft).not.toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });

  describe("native session actions", () => {
    function seedForkableMessage() {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        id: "user-message-1",
        role: "user",
        content: "Start here",
        parts: [{ type: "text", content: "Start here" }],
        createdAt: "2026-07-16T12:00:00.000Z",
      }]);
    }

    test("forks from a user message and opens the returned session in a new tab", async () => {
      seedForkableMessage();
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByRole("button", {
        name: "Fork OpenCode session from this prompt",
      }));

      await waitFor(() => {
        expect(mockForkOpenCodeSession).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          "user-message-1",
        );
        const tabs = usePaneLayoutStore.getState().getPane(
          "default",
          ENVIRONMENT_ID,
        )?.tabs ?? [];
        expect(tabs).toHaveLength(2);
        expect(tabs[1]).toMatchObject({
          type: "opencode-native",
          displayTitle: "OpenCode fork",
          openCodeNativeData: {
            environmentId: ENVIRONMENT_ID,
            sessionId: "fork-session",
          },
        });
        expect(mockAdoptNativeAgentSession).toHaveBeenCalledWith({
          environmentId: ENVIRONMENT_ID,
          agent: "opencode",
          logicalSessionKey: createOpenCodeSessionKey(
            ENVIRONMENT_ID,
            tabs[1]!.id,
          ),
          providerSessionId: "fork-session",
        });
        expect(
          useOpenCodeStore.getState().getDraftText(
            createOpenCodeSessionKey(ENVIRONMENT_ID, tabs[1]!.id),
          ),
        ).toBe("Start here");
      });
    });

    test("forks through a response and opens an empty composer", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        {
          id: "user-message-1",
          role: "user",
          content: "Start here",
          parts: [{ type: "text", content: "Start here" }],
          createdAt: "2026-07-16T12:00:00.000Z",
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "Done",
          parts: [{ type: "text", content: "Done" }],
          createdAt: "2026-07-16T12:01:00.000Z",
        },
      ]);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByRole("button", {
        name: "Fork OpenCode session from this response",
      }));

      await waitFor(() => {
        expect(mockForkOpenCodeSession).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          undefined,
        );
        const tabs = usePaneLayoutStore.getState().getPane(
          "default",
          ENVIRONMENT_ID,
        )?.tabs ?? [];
        expect(tabs).toHaveLength(2);
        // `getDraftText` returns "" for any unseen key, so asserting on it would
        // pass whether or not a draft was written. Assert on the backing map.
        expect(
          useOpenCodeStore.getState().draftText.has(
            createOpenCodeSessionKey(ENVIRONMENT_ID, tabs[1]!.id),
          ),
        ).toBe(false);
      });
    });

    test("reports a fork failure without adding a tab", async () => {
      seedForkableMessage();
      mockForkOpenCodeSession.mockRejectedValue(new Error("fork endpoint unavailable"));
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByRole("button", {
        name: "Fork OpenCode session from this prompt",
      }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("fork endpoint unavailable");
        expect(
          usePaneLayoutStore.getState().getPane("default", ENVIRONMENT_ID)?.tabs,
        ).toHaveLength(1);
      });
    });

    test("rejects a stale fork action after its message leaves the session", async () => {
      seedForkableMessage();
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      const button = screen.getByRole("button", {
        name: "Fork OpenCode session from this prompt",
      });
      const reactPropsKey = Object.keys(button).find((key) =>
        key.startsWith("__reactProps$")
      );
      if (!reactPropsKey) throw new Error("Expected React button props");
      const staleClick = (button as any)[reactPropsKey].onClick as () => void;

      act(() => useOpenCodeStore.getState().setMessages(SESSION_KEY, []));
      await waitFor(() => {
        expect(screen.queryByRole("button", {
          name: "Fork OpenCode session from this prompt",
        })).toBeNull();
      });
      act(() => staleClick());

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          "The selected message is no longer in this session",
        );
      });
      expect(mockForkOpenCodeSession).not.toHaveBeenCalled();
      expect(
        usePaneLayoutStore.getState().getPane("default", ENVIRONMENT_ID)?.tabs,
      ).toHaveLength(1);
    });

    test("coalesces double-clicks while a fork is in flight", async () => {
      seedForkableMessage();
      const pendingFork = deferred<{ id: string; title?: string }>();
      mockForkOpenCodeSession.mockImplementation(() => pendingFork.promise);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      const button = screen.getByRole("button", {
        name: "Fork OpenCode session from this prompt",
      });

      fireEvent.click(button);
      fireEvent.click(button);
      expect(mockForkOpenCodeSession).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingFork.resolve({ id: "fork-once", title: "One fork" });
        await pendingFork.promise;
      });
      expect(
        usePaneLayoutStore.getState().getPane("default", ENVIRONMENT_ID)?.tabs,
      ).toHaveLength(2);
    });

    test("shapes a discovered slash command for native dispatch", async () => {
      resetStores("named-environment");
      composeText = "/review main --verbose";
      useOpenCodeStore.getState().setSlashCommands(ENVIRONMENT_ID, [{
        name: "/review",
        description: "Review the branch",
      }]);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByTestId("opencode-send"));

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          "/review main --verbose",
          expect.objectContaining({
            command: {
              name: "/review",
              arguments: "main --verbose",
            },
          }),
        );
      });
    });

    test("keeps multi-line slash-command arguments intact", async () => {
      /*
       * The arguments used to be rebuilt from `split(/\s+/).join(" ")`, which
       * flattened every newline and indent — so a command invoked with a pasted
       * diff or a multi-line spec reached the server as one unreadable line.
       */
      resetStores("named-environment");
      const argument = "first line\n  indented second\n\nfinal line";
      composeText = `/review ${argument}`;
      useOpenCodeStore.getState().setSlashCommands(ENVIRONMENT_ID, [{
        name: "/review",
        description: "Review the branch",
      }]);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByTestId("opencode-send"));

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          composeText,
          expect.objectContaining({
            command: { name: "/review", arguments: argument },
          }),
        );
      });
    });

    test("keeps the existing runtime snapshot when a health refresh fails", async () => {
      const previousHealth = emptyRuntimeHealth({
        todos: [{ content: "Keep me", status: "pending", priority: "high" }],
      });
      useOpenCodeStore.getState().setRuntimeHealth(SESSION_KEY, previousHealth);
      mockGetOpenCodeRuntimeHealth.mockRejectedValue(new Error("health unavailable"));
      const originalWarn = console.warn;
      const warning = mock(() => {});
      console.warn = warning as unknown as typeof console.warn;

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
        await waitFor(() => {
          expect(warning).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to load runtime health:",
            expect.any(Error),
          );
        });
        expect(useOpenCodeStore.getState().runtimeHealth.get(SESSION_KEY))
          .toEqual(previousHealth);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("shared SSE event handling", () => {
    function seedSubagent(state: "pending" | "success" | "failure" = "pending") {
      const parent: NativeMessage = {
        ...nativeMessage("parent-agent", ""),
        parts: [
          {
            type: "subagent",
            content: "Worker",
            subagentId: "child-session",
            subagentName: "Worker",
            toolState: state,
            subagentActions: [],
          },
        ],
      };
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [parent]);
    }

    function childMessage(content: string): NativeMessage {
      return {
        ...nativeMessage(`child-${content}`, content),
        parts: [{ type: "text", content }],
      };
    }

    test("keeps message error and provider usage while streamed parts update", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      const providerUsage = {
        cost: 0.01,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        modelId: "openai/gpt-5",
      };
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("stream-message", "old"),
        hasError: true,
        providerUsage,
        parts: [{
          type: "text",
          content: "old",
          sourcePartId: "part-1",
          sourceMessageId: "stream-message",
        }],
      }]);

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            messageID: "stream-message",
            sessionID: "session-1",
            type: "text",
            text: "updated",
          },
        },
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0])
          .toMatchObject({
            content: "updated",
            hasError: true,
            providerUsage,
          });
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("marks a backend-dispatched session busy and removes stale completion state", async () => {
      useOpenCodeStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          sessionId: "session-1",
          messages: [],
          isLoading: false,
          lastCompletedElapsedSeconds: 1,
        }),
      }));
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      expect(screen.getByText("Completed in 1s")).toBeTruthy();
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
      channel.push({
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "busy" },
        },
      });

      await waitFor(() =>
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true),
      );
      expect(screen.queryByText(/Completed in/)).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("OpenCode is thinking...");

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("waits for an authoritative clock on new busy and retry edges", async () => {
      const previousTurnStartedAt = "2026-07-16T10:00:00.000Z";
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        {
          ...nativeMessage("previous-user", "Previous turn"),
          role: "user",
          createdAt: previousTurnStartedAt,
        },
        nativeMessage("previous-assistant", "Previous answer"),
      ]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)).toMatchObject({
          isLoading: true,
        });
      });
      expect(
        useOpenCodeStore.getState().getSession(SESSION_KEY)?.loadingStartedAt,
      ).toBeUndefined();

      channel.push({
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "retry" } },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSession(SESSION_KEY)?.loadingStartedAt,
        ).toBeUndefined();
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    /*
     * A backend-dispatched prompt records a pending clock while the tab is idle,
     * to be adopted by the busy edge that follows. A session.error ends that
     * turn, so the clock is stale — a later busy edge belongs to a different
     * turn and must not inherit it, or the footer would time from the wrong
     * prompt.
     */
    test("discards the pending backend turn clock when the turn errors", async () => {
      const backendStartedAt = Date.parse("2026-07-16T12:04:57.000Z");
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      // Idle tab: the backend user message only parks a clock, it does not load.
      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-queued-user",
            sessionID: "session-1",
            role: "user",
            time: { created: backendStartedAt },
          },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages.some(
            (message) => message.id === "server-queued-user",
          ),
        ).toBe(true);
      });

      channel.push({
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "ProviderError", data: { message: "boom" } },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages.some(
            (message) => message.id.startsWith(ERROR_MESSAGE_PREFIX),
          ),
        ).toBe(true);
      });

      channel.push({
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)).toMatchObject({
          isLoading: true,
        });
      });
      expect(
        useOpenCodeStore.getState().getSession(SESSION_KEY)?.loadingStartedAt,
      ).toBeUndefined();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("starts the clock when the authoritative backend user message arrives", async () => {
      const optimisticStartedAt = Date.parse("2026-07-16T12:05:00.000Z");
      const backendStartedAt = Date.parse("2026-07-16T12:04:57.000Z");
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("optimistic-current", "Queued work"),
        id: `${OPTIMISTIC_MESSAGE_PREFIX}current`,
        role: "user",
        createdAt: new Date(optimisticStartedAt).toISOString(),
      }]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSession(SESSION_KEY)?.loadingStartedAt,
        ).toBeUndefined();
      });

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-current-user",
            sessionID: "session-1",
            role: "user",
            time: { created: backendStartedAt },
          },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSession(SESSION_KEY)?.loadingStartedAt,
        ).toBe(backendStartedAt);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("replaces an optimistic prompt with its streamed backend echo", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("optimistic-current", "Please address all the issues"),
        id: `${OPTIMISTIC_MESSAGE_PREFIX}current`,
        role: "user",
      }]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      // OpenCode announces the user message before streaming its text part.
      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-current-user",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-current-user-text",
            messageID: "server-current-user",
            sessionID: "session-1",
            type: "text",
            text: "Please address all the issues",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: "server-current-user",
          role: "user",
          content: "Please address all the issues",
        });
      });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("retires an optimistic attachment prompt once its echo streams the file part", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("optimistic-attach", "Please inspect the screenshot"),
        id: `${OPTIMISTIC_MESSAGE_PREFIX}attach`,
        role: "user",
        parts: [
          { type: "text", content: "Please inspect the screenshot" },
          { type: "file", content: "a.png", fileUrl: "data:image/png;base64,abc123" },
        ],
      }]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-attach-user",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-attach-text",
            messageID: "server-attach-user",
            sessionID: "session-1",
            type: "text",
            text: "Please inspect the screenshot",
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-attach-file",
            messageID: "server-attach-user",
            sessionID: "session-1",
            type: "file",
            filename: "a.png",
            url: "file:///workspace/a.png",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: "server-attach-user",
          role: "user",
          content: "Please inspect the screenshot",
          parts: [
            { type: "text", content: "Please inspect the screenshot" },
            { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
          ],
        });
      });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("retires both optimistic prompts of two identical sends from their live echoes", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        {
          ...nativeMessage("optimistic-dup-a", "run the tests"),
          id: `${OPTIMISTIC_MESSAGE_PREFIX}dup-a`,
          role: "user",
          createdAt: "2026-07-16T12:00:00.000Z",
        },
        {
          ...nativeMessage("optimistic-dup-b", "run the tests"),
          id: `${OPTIMISTIC_MESSAGE_PREFIX}dup-b`,
          role: "user",
          createdAt: "2026-07-16T12:00:01.000Z",
        },
      ]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      for (const serverId of ["server-dup-1", "server-dup-2"]) {
        channel.push({
          type: "message.updated",
          properties: {
            info: {
              id: serverId,
              sessionID: "session-1",
              role: "user",
              time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
            },
          },
        });
        channel.push({
          type: "message.part.updated",
          properties: {
            part: {
              id: `${serverId}-text`,
              messageID: serverId,
              sessionID: "session-1",
              type: "text",
              text: "run the tests",
            },
          },
        });
      }

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages).toHaveLength(2);
        // Asserted in transcript order, not sorted: the echoes must land in
        // the order they streamed, and neither optimistic bubble may survive.
        expect(messages.map((message) => message.id)).toEqual([
          "server-dup-1",
          "server-dup-2",
        ]);
        expect(messages.map((message) => message.content)).toEqual([
          "run the tests",
          "run the tests",
        ]);
        expect(messages.every((message) => message.role === "user")).toBe(true);
      });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("keeps an unechoed optimistic prompt while retiring a later echoed one", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        {
          ...nativeMessage("optimistic-first", "First prompt"),
          id: `${OPTIMISTIC_MESSAGE_PREFIX}first`,
          role: "user",
          createdAt: "2026-07-16T12:00:00.000Z",
        },
        {
          ...nativeMessage("optimistic-second", "Second prompt"),
          id: `${OPTIMISTIC_MESSAGE_PREFIX}second`,
          role: "user",
          createdAt: "2026-07-16T12:00:01.000Z",
        },
      ]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-second",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-second-text",
            messageID: "server-second",
            sessionID: "session-1",
            type: "text",
            text: "Second prompt",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        // The still-unechoed first prompt keeps its own send time, so it must
        // stay ahead of the echo rather than being re-sorted to the tail.
        expect(messages.map((message) => message.id)).toEqual([
          `${OPTIMISTIC_MESSAGE_PREFIX}first`,
          "server-second",
        ]);
        expect(messages[0]).toMatchObject({
          role: "user",
          content: "First prompt",
        });
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("builds a user-role echo from the optimistic hint when a part arrives before its info", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("optimistic-early", "Hello from the part"),
        id: `${OPTIMISTIC_MESSAGE_PREFIX}early`,
        role: "user",
      }]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "early-text",
            messageID: "server-early",
            sessionID: "session-1",
            type: "text",
            text: "Hello from the part",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: "server-early",
          role: "user",
          content: "Hello from the part",
        });
      });

      // A subsequent info frame merges metadata without re-introducing the
      // optimistic bubble or a second server message.
      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-early",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: "server-early",
          role: "user",
          content: "Hello from the part",
        });
        // The info frame does not overwrite createdAt, so the turn clock keeps
        // the client send time seeded from the optimistic bubble.
        expect(messages[0]?.createdAt).toBe("2026-07-16T12:00:00.000Z");
      });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("builds a user-role echo when the attachment part arrives before any text", async () => {
      // The mirror of the test above. Without file-part matching the message
      // would be stamped `assistant`, and every later part of the same message
      // inherits that role from the store — the prompt renders as a reply and
      // the optimistic bubble never retires.
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("optimistic-file-first", "Please inspect the screenshot"),
        id: `${OPTIMISTIC_MESSAGE_PREFIX}file-first`,
        role: "user",
        parts: [
          { type: "text", content: "Please inspect the screenshot" },
          { type: "file", content: "a.png", fileUrl: "data:image/png;base64,abc123" },
        ],
      }]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-file-first-file",
            messageID: "server-file-first",
            sessionID: "session-1",
            type: "file",
            filename: "a.png",
            url: "file:///workspace/a.png",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        const echo = messages.find((message) => message.id === "server-file-first");
        expect(echo).toMatchObject({ role: "user", content: "" });
      });

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-file-first-text",
            messageID: "server-file-first",
            sessionID: "session-1",
            type: "text",
            text: "Please inspect the screenshot",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: "server-file-first",
          role: "user",
          content: "Please inspect the screenshot",
        });
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("keeps error and system messages when a live user echo rewrites the transcript", async () => {
      // upsertLiveMessage strips every client-only row before handing the
      // authoritative list to setMessages, so this pins that the merge puts
      // them back — and puts them back in the right place.
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        {
          ...nativeMessage("server-old", "Earlier reply"),
          id: "server-old",
          createdAt: "2026-07-16T11:00:00.000Z",
        },
        {
          ...nativeMessage("system-naming", "Naming environment..."),
          id: `${SYSTEM_MESSAGE_PREFIX}naming-1`,
          createdAt: "2026-07-16T11:30:00.000Z",
        },
        {
          ...nativeMessage("error-send", "Failed to send prompt"),
          id: `${ERROR_MESSAGE_PREFIX}send-1`,
          createdAt: "2026-07-16T11:45:00.000Z",
        },
        {
          ...nativeMessage("optimistic-with-siblings", "Try again"),
          id: `${OPTIMISTIC_MESSAGE_PREFIX}with-siblings`,
          role: "user",
          createdAt: "2026-07-16T12:00:00.000Z",
        },
      ]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-retry",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-retry-text",
            messageID: "server-retry",
            sessionID: "session-1",
            type: "text",
            text: "Try again",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages.map((message) => message.id)).toEqual([
          "server-old",
          `${SYSTEM_MESSAGE_PREFIX}naming-1`,
          `${ERROR_MESSAGE_PREFIX}send-1`,
          "server-retry",
        ]);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("updates a live user echo in place when a second part streams for it", async () => {
      useOpenCodeStore.getState().setMessages(SESSION_KEY, []);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-inplace",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-inplace-text",
            messageID: "server-inplace",
            sessionID: "session-1",
            type: "text",
            text: "Look at this",
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-inplace-file",
            messageID: "server-inplace",
            sessionID: "session-1",
            type: "file",
            filename: "a.png",
            url: "file:///workspace/a.png",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        // One message with both parts, not two rows for the same id.
        expect(messages).toHaveLength(1);
        expect(messages[0]?.id).toBe("server-inplace");
        expect(messages[0]?.parts.map((part) => part.type)).toEqual(["text", "file"]);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("does not let a transcript fetch that predates a live echo erase it", async () => {
      // The regression this guards: the optimistic bubble used to survive a
      // stale snapshot and keep the prompt on screen. Now that a live echo
      // retires its bubble, an older in-flight transcript response would take
      // both away and leave the user's prompt invisible for the whole turn.
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [{
        ...nativeMessage("server-prior", "Earlier reply"),
        id: "server-prior",
        createdAt: "2026-07-16T11:00:00.000Z",
      }]);
      const staleFetch = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => staleFetch.promise);

      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      // The end of the previous turn kicks off the authoritative refetch.
      channel.push({ type: "session.idle", properties: { sessionID: "session-1" } });
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      // The user sends again; the echo arrives while that fetch is still out.
      useOpenCodeStore.getState().addMessage(SESSION_KEY, {
        ...nativeMessage("optimistic-race", "Race the fetch"),
        id: `${OPTIMISTIC_MESSAGE_PREFIX}race`,
        role: "user",
        createdAt: "2026-07-16T12:00:00.000Z",
      });
      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-race",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.parse("2026-07-16T12:04:57.000Z") },
          },
        },
      });
      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "server-race-text",
            messageID: "server-race",
            sessionID: "session-1",
            type: "text",
            text: "Race the fetch",
          },
        },
      });

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages.map((message) => message.id)).toEqual([
          "server-prior",
          "server-race",
        ]);
      });

      // The response was computed before the new prompt existed. It also
      // carries a message the store has never seen, so the assertion below can
      // wait for proof that this snapshot really was applied rather than
      // passing before it lands.
      staleFetch.resolve([
        {
          ...nativeMessage("server-prior", "Earlier reply"),
          id: "server-prior",
          createdAt: "2026-07-16T11:00:00.000Z",
        },
        {
          ...nativeMessage("server-prior-hydrated", "Earlier reply, hydrated"),
          id: "server-prior-hydrated",
          createdAt: "2026-07-16T11:10:00.000Z",
        },
      ]);

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages.map((message) => message.id)).toContain("server-prior-hydrated");
      });
      const messagesAfterStaleFetch = useOpenCodeStore
        .getState()
        .getSession(SESSION_KEY)?.messages ?? [];
      expect(messagesAfterStaleFetch.map((message) => message.id)).toEqual([
        "server-prior",
        "server-prior-hydrated",
        "server-race",
      ]);

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
      mockGetSessionMessages.mockImplementation(async () => []);
    });

    test("still drops a message the server removed while a fetch was in flight", async () => {
      // The carry-over must not resurrect deletions: a message present before
      // the request and absent from its response was genuinely removed.
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [
        {
          ...nativeMessage("server-kept", "Kept"),
          id: "server-kept",
          createdAt: "2026-07-16T11:00:00.000Z",
        },
        {
          ...nativeMessage("server-deleted", "Deleted"),
          id: "server-deleted",
          createdAt: "2026-07-16T11:10:00.000Z",
        },
      ]);
      const pendingFetch = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => pendingFetch.promise);

      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({ type: "session.idle", properties: { sessionID: "session-1" } });
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      pendingFetch.resolve([{
        ...nativeMessage("server-kept", "Kept"),
        id: "server-kept",
        createdAt: "2026-07-16T11:00:00.000Z",
      }]);

      await waitFor(() => {
        const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
        expect(messages.map((message) => message.id)).toEqual(["server-kept"]);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
      mockGetSessionMessages.mockImplementation(async () => []);
    });

    test("uses a newly observed backend user clock when it precedes the busy edge", async () => {
      const observedBusyAt = Date.parse("2026-07-16T12:05:00.000Z");
      const backendStartedAt = Date.parse("2026-07-16T12:04:58.000Z");
      Date.now = () => observedBusyAt;
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "server-before-busy",
            sessionID: "session-1",
            role: "user",
            time: { created: backendStartedAt },
          },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages.at(-1)?.id,
        ).toBe("server-before-busy");
      });
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.isLoading).toBe(false);

      channel.push({
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)).toMatchObject({
          isLoading: true,
          loadingStartedAt: backendStartedAt,
        });
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("corrects a running turn clock from an authoritative transcript reconcile", async () => {
      const rendererStartedAt = Date.parse("2026-07-16T12:05:00.000Z");
      const backendStartedAt = "2026-07-16T12:04:55.000Z";
      Date.now = () => rendererStartedAt;
      const backendUser: NativeMessage = {
        ...nativeMessage("reconciled-server-user", "Continue in background"),
        role: "user",
        createdAt: backendStartedAt,
      };
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      mockGetSessionMessages.mockClear();
      mockGetSessionMessages.mockResolvedValue([backendUser]);

      channel.push({
        type: "session.updated",
        properties: { info: { id: "session-1" } },
      });
      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          { throwOnError: true, includeSubagents: false },
        );
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)).toMatchObject({
          messages: [backendUser],
          isLoading: true,
          loadingStartedAt: Date.parse(backendStartedAt),
        });
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("routes busy, idle-status, and retry lifecycle edges to a non-rendered sibling", async () => {
      const siblingKey = createOpenCodeSessionKey(ENVIRONMENT_ID, "background-tab");
      useOpenCodeStore.getState().setSession(siblingKey, {
        sessionId: "background-session",
        messages: [],
        isLoading: false,
      });
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "session.status",
        properties: {
          sessionID: "background-session",
          status: { type: "busy" },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(siblingKey)?.isLoading).toBe(true);
      });
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.isLoading).toBe(false);

      channel.push({
        type: "session.status",
        properties: {
          sessionID: "background-session",
          status: { type: "idle" },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(siblingKey)?.isLoading).toBe(false);
      });

      channel.push({
        type: "session.status",
        properties: {
          sessionID: "background-session",
          status: { type: "retry" },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(siblingKey)?.isLoading).toBe(true);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("falls back to a cheap transcript refresh for a malformed streamed part", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockResolvedValue([
        nativeMessage("authoritative-after-malformed", "Recovered transcript"),
      ]);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-without-message",
            sessionID: "session-1",
            type: "text",
            text: "Cannot be routed without a message id",
          },
        },
      });

      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          { throwOnError: true, includeSubagents: false },
        );
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages).toEqual([
          nativeMessage("authoritative-after-malformed", "Recovered transcript"),
        ]);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("merges message metadata in place without refetching streamed parts", async () => {
      const existing = nativeMessage("metadata-message", "Keep streamed content");
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [existing]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.updated",
        properties: {
          info: {
            id: "metadata-message",
            sessionID: "session-1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-5.6-sol",
            error: { name: "ProviderError" },
            tokens: { input: 4, output: 6 },
          },
        },
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages[0])
          .toMatchObject({
            id: "metadata-message",
            content: "Keep streamed content",
            parts: existing.parts,
            modelId: "openai/gpt-5.6-sol",
            hasError: true,
          });
      });
      expect(mockGetSessionMessages).not.toHaveBeenCalled();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("hydrates a streamed Task part from its child session immediately", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "streamed-child"
          ? [childMessage("streamed child action")]
          : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "streamed-task-part",
            messageID: "streamed-parent",
            sessionID: "session-1",
            type: "tool",
            tool: "task",
            state: {
              status: "running",
              input: {
                description: "Streaming worker",
                prompt: "Inspect the child transcript",
              },
              metadata: { sessionId: "streamed-child" },
            },
          },
        },
      });

      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "streamed-child",
          { throwOnError: true },
        );
        expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages[0]?.parts[0])
          .toMatchObject({
            type: "subagent",
            subagentId: "streamed-child",
            toolState: "pending",
            subagentActions: [
              { type: "text", content: "streamed child action" },
            ],
          });
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("applies streaming parts, parent refreshes, idle state, errors, and context usage", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            messageID: "stream-message",
            sessionID: "session-1",
            type: "text",
            text: "Streaming response",
          },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]).toMatchObject({
          id: "stream-message",
          content: "Streaming response",
        });
      });

      const refreshed = nativeMessage("authoritative-parent");
      mockGetSessionMessages.mockResolvedValue([refreshed]);
      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "session-1" } },
      });
      await waitFor(() => {
        // An info payload without a message id cannot be applied in place, so
        // the tab falls back to a refetch — the cheap streaming variant that
        // skips recursive subagent hydration.
        expect(mockGetSessionMessages).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          { throwOnError: true, includeSubagents: false },
        );
      });

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      channel.push({
        type: "session.idle",
        properties: {
          sessionID: "session-1",
          usage: { inputTokens: 30, outputTokens: 20 },
          maxContextTokens: 1_000,
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useOpenCodeStore.getState().contextUsage.get(SESSION_KEY)).toEqual({
          usedTokens: 50,
          totalTokens: 1_000,
          percentUsed: 5,
          modelId: "openai/gpt-5",
          estimated: true,
          source: "heuristic",
          updatedAt: expect.any(String),
        });
      });

      channel.push({
        type: "session.error",
        properties: { sessionID: "session-1", error: new Error("event failed") },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) => message.id.startsWith("error-") && message.content === "Error: event failed",
          ),
        ).toBe(true);
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("shows only the stopped marker when OpenCode reports MessageAbortedError", async () => {
      const originalError = console.error;
      const consoleError = mock((..._args: unknown[]) => {});
      console.error = consoleError as unknown as typeof console.error;
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

        act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
        fireEvent.click(await screen.findByTestId("opencode-stop"));
        await waitFor(() => {
          expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
          expect(
            useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
              (message) => message.content === TURN_STOPPED_BY_USER,
            ),
          ).toBe(true);
        });

        channel.push({
          type: "session.error",
          properties: {
            sessionID: "session-1",
            error: {
              name: "MessageAbortedError",
              data: { message: "Aborted" },
            },
          },
        });

        await waitFor(() => {
          const state = useOpenCodeStore.getState().sessions.get(SESSION_KEY);
          expect(state?.isLoading).toBe(false);
        });
        const messages =
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
        expect(
          messages.some((message) => message.id.startsWith(ERROR_MESSAGE_PREFIX)),
        ).toBe(false);
        // Exactly one marker: the event must defer to the stop path rather than
        // adding a second one of its own.
        expect(
          messages.filter((message) => message.content === TURN_STOPPED_BY_USER),
        ).toHaveLength(1);
        // The other half of the fix — an expected interrupt is not console noise.
        expect(consoleError.mock.calls.some(
          (call) => call[0] === "[OpenCodeChatTab] Session error:",
        )).toBe(false);
      } finally {
        console.error = originalError;
      }

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    /*
     * The stop marker is written by this renderer's stop path, so an abort that
     * originated anywhere else (another client on the same server, a
     * backend-issued abort) has no marker to defer to. Suppressing the card
     * unconditionally would end the turn with nothing in the transcript at all.
     */
    test("writes a stopped marker for an abort this renderer did not initiate", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      channel.push({
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) => message.content === TURN_STOPPED_BY_USER,
          ),
        ).toBe(true);
      });
      expect(mockAbortSession).not.toHaveBeenCalled();
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading,
      ).toBe(false);
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
          (message) => message.id.startsWith(ERROR_MESSAGE_PREFIX),
        ),
      ).toBe(false);

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("claims only one abort per stop, so a later external abort is still marked", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      fireEvent.click(await screen.findByTestId("opencode-stop"));
      await waitFor(() => expect(mockAbortSession).toHaveBeenCalled());

      const abortEvent = {
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      };
      channel.push(abortEvent);
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading,
        ).toBe(false);
      });

      // The claim is spent. A second abort is a new, unattributed interrupt.
      channel.push(abortEvent);
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.filter(
            (message) => message.content === TURN_STOPPED_BY_USER,
          ),
        ).toHaveLength(2);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("keeps the stop claim across a remount while the abort is in flight", async () => {
      let releaseAbort: (() => void) | undefined;
      mockAbortSession.mockImplementation(async () => {
        await new Promise<void>((resolve) => { releaseAbort = resolve; });
        return true;
      });
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      const first = render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />,
      );
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      fireEvent.click(await screen.findByTestId("opencode-stop"));
      await waitFor(() => expect(mockAbortSession).toHaveBeenCalled());

      // Switching away and back must not release a stop that is still settling.
      first.unmount();
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await act(async () => {
        releaseAbort?.();
        await Promise.resolve();
      });

      channel.push({
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading,
        ).toBe(false);
      });
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.filter(
          (message) => message.content === TURN_STOPPED_BY_USER,
        ),
      ).toHaveLength(1);

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("releases the stop claim when the abort request fails", async () => {
      mockAbortSession.mockImplementation(async () => false);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      fireEvent.click(await screen.findByTestId("opencode-stop"));
      await waitFor(() => expect(mockAbortSession).toHaveBeenCalled());

      // A failed abort leaves the turn running and writes no marker...
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
          (message) => message.content === TURN_STOPPED_BY_USER,
        ),
      ).toBe(false);
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading,
      ).toBe(true);

      // ...so it must not swallow the marker for an abort that does land.
      channel.push({
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.filter(
            (message) => message.content === TURN_STOPPED_BY_USER,
          ),
        ).toHaveLength(1);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("still renders an error card and clears loading for a non-abort session error", async () => {
      const originalError = console.error;
      const consoleError = mock((..._args: unknown[]) => {});
      console.error = consoleError as unknown as typeof console.error;
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

        act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
        channel.push({
          type: "session.error",
          properties: {
            sessionID: "session-1",
            error: { name: "ProviderError", data: { message: "provider exploded" } },
          },
        });

        await waitFor(() => {
          expect(
            useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
              (message) => message.id.startsWith(ERROR_MESSAGE_PREFIX),
            ),
          ).toBe(true);
        });
        // A real failure clears the busy state too, and is worth logging.
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading,
        ).toBe(false);
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) => message.content === TURN_STOPPED_BY_USER,
          ),
        ).toBe(false);
        expect(consoleError.mock.calls.some(
          (call) => call[0] === "[OpenCodeChatTab] Session error:",
        )).toBe(true);
      } finally {
        console.error = originalError;
      }

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("renders a string session error payload as an error card", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      channel.push({
        type: "session.error",
        properties: { sessionID: "session-1", error: "upstream refused the connection" },
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) =>
              message.id.startsWith(ERROR_MESSAGE_PREFIX)
              && message.content.includes("upstream refused the connection"),
          ),
        ).toBe(true);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("treats an Error-shaped abort as an interrupt rather than a failure", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      // The SDK's interceptor wraps some failures into real Errors, so the
      // discriminator arrives on the prototype rather than as an own property.
      const abortError = new Error("Aborted");
      abortError.name = "MessageAbortedError";

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      channel.push({
        type: "session.error",
        properties: { sessionID: "session-1", error: abortError },
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) => message.content === TURN_STOPPED_BY_USER,
          ),
        ).toBe(true);
      });
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
          (message) => message.id.startsWith(ERROR_MESSAGE_PREFIX),
        ),
      ).toBe(false);

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("routes session titles and usage to the matching sibling tab in the same environment", async () => {
      const siblingKey = createOpenCodeSessionKey(ENVIRONMENT_ID, "tab-2");
      useOpenCodeStore.getState().setSession(siblingKey, {
        sessionId: "session-2",
        messages: [],
        isLoading: true,
      });
      useOpenCodeStore.getState().setSelectedModel(
        siblingKey,
        "anthropic/claude-sonnet",
      );
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "session.updated",
        properties: {
          info: {
            id: "session-2",
            title: "Sibling tab title",
          },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSession(siblingKey)?.title).toBe(
          "Sibling tab title",
        );
      });
      expect(useOpenCodeStore.getState().getSession(SESSION_KEY)?.title).toBeUndefined();

      channel.push({
        type: "session.idle",
        properties: {
          sessionID: "session-2",
          usage: { inputTokens: 150, outputTokens: 50 },
          maxContextTokens: 2_000,
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().getContextUsage(siblingKey)).toEqual({
          usedTokens: 200,
          totalTokens: 2_000,
          percentUsed: 10,
          modelId: "anthropic/claude-sonnet",
          estimated: true,
          source: "heuristic",
          updatedAt: expect.any(String),
        });
        expect(
          useOpenCodeStore.getState().getSession(siblingKey)?.isLoading,
        ).toBe(false);
      });
      expect(useOpenCodeStore.getState().getContextUsage(SESSION_KEY)).toBeUndefined();

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("adds and removes permission and question requests", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "permission.asked",
        properties: {
          id: "permission-sse",
          sessionID: "session-1",
          permission: "edit",
          patterns: ["src/**"],
          metadata: { source: "tool" },
          always: ["src/generated/**"],
          tool: { messageID: "message-1", callID: "call-1" },
        },
      });
      channel.push({
        type: "question.asked",
        properties: {
          id: "question-sse",
          sessionID: "session-1",
          questions: [{ question: "Continue?", header: "Confirm", options: [] }],
        },
      });
      await waitFor(() => {
        // The wire payload carries `sessionID`; the store normalizes it to
        // `sessionId` so all three agents agree on the spelling.
        expect(useOpenCodeStore.getState().pendingPermissions.get("permission-sse")).toMatchObject({
          sessionId: "session-1",
          permission: "edit",
          patterns: ["src/**"],
        });
        expect(useOpenCodeStore.getState().pendingQuestions.has("question-sse")).toBe(true);
      });

      channel.push({ type: "permission.replied", properties: { requestID: "permission-sse" } });
      channel.push({ type: "question.replied", properties: { requestID: "question-sse" } });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().pendingPermissions.has("permission-sse")).toBe(false);
        expect(useOpenCodeStore.getState().pendingQuestions.has("question-sse")).toBe(false);
      });

      useOpenCodeStore.getState().addPendingQuestion({
        id: "question-rejected",
        sessionId: "session-1",
        questions: [],
      });
      channel.push({ type: "question.rejected", properties: { requestID: "question-rejected" } });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().pendingQuestions.has("question-rejected")).toBe(false);
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("uses one environment stream and routes todo and diff events to sibling sessions", async () => {
      const secondTabId = "tab-2";
      const secondSessionKey = createOpenCodeSessionKey(
        ENVIRONMENT_ID,
        secondTabId,
      );
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      useOpenCodeStore.getState().setSession(secondSessionKey, {
        sessionId: "session-2",
        messages: [],
        isLoading: false,
      });
      usePaneLayoutStore.getState().addTab(
        "default",
        {
          id: secondTabId,
          type: "opencode-native",
          openCodeNativeData: createData({ sessionId: "session-2" }),
        },
        ENVIRONMENT_ID,
      );

      render(
        <>
          <OpenCodeChatTab
            tabId={TAB_ID}
            data={createData({ sessionId: "session-1" })}
            isActive
          />
          <OpenCodeChatTab
            tabId={secondTabId}
            data={createData({ sessionId: "session-2" })}
            isActive
          />
        </>,
      );

      await waitFor(() => {
        expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
        expect(useOpenCodeStore.getState().runtimeHealth.has(SESSION_KEY)).toBe(true);
        expect(useOpenCodeStore.getState().runtimeHealth.has(secondSessionKey)).toBe(true);
      });
      // Older persisted state may have only the environment-scoped inventory.
      // The first live session event should seed the missing session snapshot
      // from that fallback rather than dropping the update.
      useOpenCodeStore.getState().setRuntimeHealth(secondSessionKey, null);

      channel.push({
        type: "todo.updated",
        properties: {
          sessionID: "session-2",
          todos: [{ content: "Sibling task", status: "pending", priority: "high" }],
        },
      });
      channel.push({
        type: "session.diff",
        properties: {
          sessionID: "session-2",
          diff: [{
            file: "sibling.ts",
            patch: "@@ -1 +1 @@",
            additions: 1,
            deletions: 1,
            status: "modified",
          }],
        },
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().runtimeHealth.get(secondSessionKey),
        ).toMatchObject({
          todos: [{ content: "Sibling task", status: "pending", priority: "high" }],
          diffs: [{
            file: "sibling.ts",
            additions: 1,
            deletions: 1,
          }],
        });
      });
      expect(useOpenCodeStore.getState().runtimeHealth.get(SESSION_KEY))
        .toMatchObject({ todos: [], diffs: [] });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("refreshes a Task child and records success and failure terminal states", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "child-session" ? [childMessage("child action")] : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "child-session" } },
      });
      await waitFor(() => {
        const part = useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0];
        expect(part).toMatchObject({
          type: "subagent",
          toolState: "pending",
          subagentActions: [{ type: "text", content: "child action" }],
        });
      });

      channel.push({ type: "session.idle", properties: { sessionID: "child-session" } });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0]).toMatchObject({
          toolState: "success",
        });
      });

      channel.push({
        type: "session.error",
        properties: { sessionID: "child-session", error: new Error("child failed") },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0]).toMatchObject({
          toolState: "failure",
        });
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    /*
     * Stopping a turn aborts its subagents, and each reports that through
     * session.error. Recording it as a failure would paint the Agent row red
     * for a deliberate cancellation — and `mergeOpenCodeSubagentTranscript`
     * latches "failure", so nothing later could clear it.
     */
    test("does not fail a Task child that was intentionally aborted", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "child-session" ? [childMessage("child action")] : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "child-session" } },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0],
        ).toMatchObject({ type: "subagent", toolState: "pending" });
      });

      channel.push({
        type: "session.error",
        properties: {
          sessionID: "child-session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });

      // The child transcript still reconciles — an abort is terminal — but the
      // row must not latch to "failure".
      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "child-session",
          expect.anything(),
        );
      });
      expect(
        useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0],
      ).not.toMatchObject({ toolState: "failure" });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("refreshes child transcripts after message and part removals", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "child-session" ? [childMessage("after removal")] : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      for (const type of ["message.part.removed", "message.removed"]) {
        channel.push({ type, properties: { sessionID: "child-session" } });
        await waitFor(() => {
          expect(mockGetSessionMessages.mock.calls.filter((call) => call[1] === "child-session").length)
            .toBe(type === "message.part.removed" ? 1 : 2);
        });
      }
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("replaces a pending debounced child refresh and runs only the latest timeout", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "child-session" ? [childMessage("debounced child")] : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "child-session" } },
      });
      await waitFor(() => {
        expect(
          mockGetSessionMessages.mock.calls.filter(
            (call) => call[1] === "child-session",
          ),
        ).toHaveLength(1);
      });

      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "child-session" } },
      });
      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "child-session" } },
      });
      await waitFor(() => {
        expect(
          mockGetSessionMessages.mock.calls.filter(
            (call) => call[1] === "child-session",
          ),
        ).toHaveLength(2);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("replaces a pending debounced parent refresh and runs only the latest timeout", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockResolvedValue([
        nativeMessage("debounced-parent"),
      ]);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      const parentEvent = {
        type: "message.updated",
        properties: { info: { sessionID: "session-1" } },
      };
      channel.push(parentEvent);
      await waitFor(() => {
        expect(
          mockGetSessionMessages.mock.calls.filter(
            (call) => call[1] === "session-1",
          ),
        ).toHaveLength(1);
      });

      channel.push(parentEvent);
      channel.push(parentEvent);
      await waitFor(() => {
        expect(
          mockGetSessionMessages.mock.calls.filter(
            (call) => call[1] === "session-1",
          ),
        ).toHaveLength(2);
      });

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("discards an older overlapping child refresh that resolves last", async () => {
      seedSubagent();
      const channel = eventChannel();
      const first = deferred<NativeMessage[]>();
      const second = deferred<NativeMessage[]>();
      let childCall = 0;
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) => {
        if (sessionId !== "child-session") return [];
        childCall += 1;
        return childCall === 1 ? first.promise : second.promise;
      });
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({ type: "message.updated", properties: { info: { sessionID: "child-session" } } });
      await waitFor(() => expect(childCall).toBe(1));
      channel.push({ type: "session.idle", properties: { sessionID: "child-session" } });
      await waitFor(() => expect(childCall).toBe(2));

      await act(async () => {
        second.resolve([childMessage("newest child")]);
        await second.promise;
      });
      await act(async () => {
        first.resolve([childMessage("stale child")]);
        await first.promise;
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0]).toMatchObject({
          toolState: "success",
          subagentActions: [{ type: "text", content: "newest child" }],
        });
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("keeps the current child transcript when an event refresh fails", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) => {
        if (sessionId === "child-session") {
          throw new Error("child transcript unavailable");
        }
        return [];
      });
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

        channel.push({
          type: "message.updated",
          properties: { info: { sessionID: "child-session" } },
        });

        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to refresh subagent transcript:",
            expect.any(Error),
          );
        });
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0],
        ).toMatchObject({
          type: "subagent",
          toolState: "pending",
          subagentActions: [],
        });
      } finally {
        console.warn = originalWarn;
        useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("keeps the current parent transcript when an event refresh fails", async () => {
      const existing = nativeMessage("existing-parent", "Keep the live transcript");
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [existing]);
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
        mockGetSessionMessages.mockClear();
        mockGetSessionMessages.mockRejectedValue(
          new Error("parent transcript unavailable"),
        );

        channel.push({
          type: "message.updated",
          properties: { info: { sessionID: "session-1" } },
        });

        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to refresh session transcript:",
            expect.any(Error),
          );
        });
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages,
        ).toEqual([existing]);
      } finally {
        console.warn = originalWarn;
        useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("continues low-frequency recovery after the SSE retry budget is exhausted", async () => {
      /*
       * The whole ladder is driven here rather than seeded: the budget is what
       * keeps a flapping bridge from being hammered, so a test that starts at
       * the ceiling proves nothing about the ten attempts that precede it.
       */
      const reconnectTimers: Array<{ delay: number; run: () => void }> = [];
      // Only the backoff ladder's own delays — the tab schedules other long
      // timers (health polls) that would otherwise land in this capture.
      const reconnectDelays = new Set([3_000, 6_000, 12_000, 24_000, 48_000, 60_000]);
      const originalGlobalTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (typeof handler === "function" && reconnectDelays.has(timeout ?? 0)) {
          reconnectTimers.push({
            delay: timeout ?? 0,
            run: () => (handler as (...timerArgs: unknown[]) => void)(...args),
          });
          return reconnectTimers.length as unknown as ReturnType<typeof setTimeout>;
        }
        return originalGlobalTimeout(handler, timeout, ...args);
      }) as typeof globalThis.setTimeout;
      mockSubscribeToEvents.mockImplementation(async () =>
        (async function* () {
          throw new Error("event stream dropped");
        })()
      );
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalDebug = console.debug;
      const consoleWarn = mock(() => {});
      console.error = mock(() => {}) as unknown as typeof console.error;
      console.warn = consoleWarn as unknown as typeof console.warn;
      console.debug = mock(() => {}) as unknown as typeof console.debug;

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(reconnectTimers).toHaveLength(1));

        for (let attempt = 0; attempt < 10; attempt += 1) {
          await act(async () => {
            reconnectTimers[attempt]!.run();
            await Promise.resolve();
          });
          await waitFor(() =>
            expect(reconnectTimers).toHaveLength(attempt + 2),
          );
        }

        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] SSE reconnect limit reached; continuing desynced probes for",
            ENVIRONMENT_ID,
          );
        }, { timeout: 15_000 });
        expect(reconnectTimers.map((timer) => timer.delay)).toEqual([
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
        expect(mockSubscribeToEvents.mock.calls.length).toBe(11);
        expect(useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced)
          .toBe(true);

        // A probe that still cannot reach the bridge stays desynced and queues
        // the next one at the cap rather than stranding the tab.
        mockSubscribeToEvents.mockRejectedValueOnce(
          new Error("bridge still unreachable"),
        );
        await act(async () => {
          reconnectTimers[10]!.run();
          await Promise.resolve();
        });
        await waitFor(() => expect(reconnectTimers).toHaveLength(12));
        expect(reconnectTimers[11]!.delay).toBe(60_000);
        expect(useOpenCodeStore.getState().eventSubscriptions.get(ENVIRONMENT_ID)?.desynced)
          .toBe(true);
      } finally {
        globalThis.setTimeout = originalGlobalTimeout;
        console.error = originalError;
        console.warn = originalWarn;
        console.debug = originalDebug;
      }
    });

    test("does not let a stale reconnect timer replace an explicitly closed subscription", async () => {
      let reconnectCallback: (() => void) | undefined;
      window.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (timeout === 3_000 && typeof handler === "function") {
          const callback = handler as (...callbackArgs: unknown[]) => void;
          reconnectCallback = () => callback(...args);
          return 1;
        }
        return callOriginalWindowTimeout(handler, timeout, ...args);
      }) as unknown as typeof window.setTimeout;
      mockSubscribeToEvents.mockResolvedValue(
        (async function* () {})() as AsyncGenerator<any>,
      );

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(reconnectCallback).toBeDefined());
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);

      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      await act(async () => {
        reconnectCallback?.();
        await Promise.resolve();
      });

      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
      expect(
        useOpenCodeStore.getState().eventSubscriptions.has(ENVIRONMENT_ID),
      ).toBe(false);
    });

    test("stops applying events after the shared subscription is aborted", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      // Wait for the subscription to be *registered*, not merely requested.
      // `subscribeToEvents` having been called only means the await started; a
      // close issued before the registration lands is a no-op the registration
      // then undoes, and the assertions below fail.
      await waitFor(() =>
        expect(
          useOpenCodeStore.getState().hasActiveEventSubscription(ENVIRONMENT_ID),
        ).toBe(true),
      );
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.push({ type: "session.error", properties: { sessionID: "session-1", error: "late" } });
      channel.close();

      await act(async () => await Promise.resolve());
      expect(useOpenCodeStore.getState().eventSubscriptions.has(ENVIRONMENT_ID)).toBe(false);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([]);
    });
  });

  describe("slash command loading", () => {
    beforeEach(() => {
      mockResolveSlashCommandDirectory.mockReturnValue("/workspace");
      mockShouldLoadSlashCommands.mockReturnValue(true);
      mockGetNativeSlashCommands.mockImplementation((commands) => [
        { name: "/native", description: "Built in" },
        ...commands,
      ]);
    });

    test("stores discovered and native slash commands", async () => {
      mockGetAvailableSlashCommands.mockResolvedValue([
        { name: "/project", description: "Project command" },
      ]);

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(useOpenCodeStore.getState().slashCommands.get(ENVIRONMENT_ID)).toEqual([
          { name: "/native", description: "Built in" },
          { name: "/project", description: "Project command" },
        ]);
      });
      expect(mockGetAvailableSlashCommands).toHaveBeenCalledWith(MOCK_CLIENT, "/workspace");
    });

    test("falls back to native commands when discovery rejects", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      mockGetAvailableSlashCommands.mockRejectedValue(new Error("command endpoint unavailable"));

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => {
          expect(useOpenCodeStore.getState().slashCommands.get(ENVIRONMENT_ID)).toEqual([
            { name: "/native", description: "Built in" },
          ]);
        });
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to load slash commands:",
          expect.any(Error),
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    test("does not store commands after the loading effect is cancelled", async () => {
      const commands = deferred<any[]>();
      mockGetAvailableSlashCommands.mockImplementation(() => commands.promise);
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetAvailableSlashCommands).toHaveBeenCalled());

      view.unmount();
      await act(async () => {
        commands.resolve([{ name: "/late", description: "Late" }]);
        await commands.promise;
      });

      expect(useOpenCodeStore.getState().slashCommands.has(ENVIRONMENT_ID)).toBe(false);
    });

    test("skips discovery when the environment has no usable directory", async () => {
      mockShouldLoadSlashCommands.mockReturnValue(false);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await act(async () => await Promise.resolve());
      expect(mockGetAvailableSlashCommands).not.toHaveBeenCalled();
    });
  });

  describe("Escape stop shortcut", () => {
    test("stops an active loading session and prevents the browser action", async () => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

      act(() => window.dispatchEvent(event));

      await waitFor(() => expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1"));
      expect(event.defaultPrevented).toBe(true);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    });

    test("ignores Escape when inactive, modified, repeated, composing, or already prevented", async () => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      view.rerender(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      const ignored = [
        new KeyboardEvent("keydown", { key: "Enter" }),
        new KeyboardEvent("keydown", { key: "Escape", repeat: true }),
        new KeyboardEvent("keydown", { key: "Escape", metaKey: true }),
        new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true }),
        new KeyboardEvent("keydown", { key: "Escape", altKey: true }),
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true }),
      ];
      const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      prevented.preventDefault();
      ignored.push(prevented);
      act(() => ignored.forEach((event) => window.dispatchEvent(event)));

      await act(async () => await Promise.resolve());
      expect(mockAbortSession).not.toHaveBeenCalled();
    });

    test("removes the key listener after loading ends and after unmount", async () => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, false));
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      view.unmount();
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await act(async () => await Promise.resolve());
      expect(mockAbortSession).not.toHaveBeenCalled();
    });
  });

  describe("refreshModels", () => {
    test("writes the latest models into the store", async () => {
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai", variants: ["low", "high"] },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
          refreshedModels,
        );
        expect(mockCacheOpenCodeModelCatalog).toHaveBeenCalledWith(
          "project-1",
          refreshedModels,
        );
      });
    });

    test("keeps a cold initialization usable when caching the live catalog rejects", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      useOpenCodeStore.setState((state) => ({ ...state, clients: new Map() }));
      mockGetModelsWithDefaults.mockResolvedValue({
        models: [
          { id: "openai/live", name: "Live", provider: "openai" },
        ],
        defaults: {},
      });
      mockCacheOpenCodeModelCatalog.mockRejectedValueOnce(
        new Error("cache write failed"),
      );

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />,
        );
        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to cache models:",
            expect.any(Error),
          );
        });
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)?.[0]?.id).toBe(
          "openai/live",
        );
        expect(useOpenCodeStore.getState().clients.get(ENVIRONMENT_ID)).toBe(
          MOCK_CLIENT as any,
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    test("keeps refreshed models when caching them rejects", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      const refreshedModels = [
        { id: "openai/refreshed", name: "Refreshed", provider: "openai" },
      ];
      mockGetModelsWithDefaults.mockResolvedValue({
        models: refreshedModels,
        defaults: {},
      });
      mockCacheOpenCodeModelCatalog.mockRejectedValueOnce(
        new Error("cache write failed"),
      );

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
        );
        await act(async () => {
          fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
        });
        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to cache refreshed models:",
            expect.any(Error),
          );
        });
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
          refreshedModels,
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    test("rehydrates cached models before an inactive tab starts its server", async () => {
      const cachedModels = [
        {
          id: "openrouter/openai/gpt-5",
          name: "GPT-5",
          provider: "openrouter",
        },
      ];
      mockGetCachedOpenCodeModelCatalog.mockResolvedValueOnce({
        schemaVersion: 2,
        projectId: "project-1",
        catalogVersion: "cached",
        updatedAt: "2026-07-27T12:00:00.000Z",
        models: cachedModels,
      });

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await waitFor(() => {
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
          cachedModels,
        );
      });
      expect(mockGetCachedOpenCodeModelCatalog).toHaveBeenCalledWith("project-1");
      expect(mockAwaitBridgeReady).not.toHaveBeenCalled();
    });

    test("keeps the cached catalog when the live refresh is empty", async () => {
      const cachedModels = [
        {
          id: "openrouter/openai/gpt-5",
          name: "GPT-5",
          provider: "openrouter",
        },
      ];
      useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, cachedModels);
      mockGetModelsWithDefaults.mockResolvedValueOnce({
        models: [],
        defaults: {},
      });

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
          cachedModels,
        );
      });
      expect(mockCacheOpenCodeModelCatalog).not.toHaveBeenCalled();
    });

    test("marks a rehydrated catalog as cached rather than live", async () => {
      mockGetCachedOpenCodeModelCatalog.mockResolvedValueOnce({
        schemaVersion: 2,
        projectId: "project-1",
        catalogVersion: "cached",
        updatedAt: "2026-07-27T12:00:00.000Z",
        models: [{ id: "openai/cached", name: "Cached", provider: "openai" }],
      });

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await waitFor(() => {
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toHaveLength(1);
      });
      expect(useOpenCodeStore.getState().hasLiveModels(ENVIRONMENT_ID)).toBe(false);
    });

    test("never pins a session model that only the durable cache advertised", async () => {
      // The cached catalog is fine to display, but the running server never
      // confirmed these ids — pinning one would send a model it may reject.
      useOpenCodeStore.setState((state) => ({
        ...state,
        clients: new Map(),
        selectedModel: new Map(),
      }));
      useOpenCodeStore.getState().setModels(
        ENVIRONMENT_ID,
        [{ id: "openai/cached", name: "Cached", provider: "openai" }] as any,
        "cache",
      );
      mockGetModelsWithDefaults.mockResolvedValue({ models: [], defaults: {} });
      mockGetOpencodeModelPreferences.mockImplementation(async () => ({
        recent: ["openai/cached"],
        favorite: [],
        variant: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />,
      );

      await waitFor(() => {
        expect(mockGetModelsWithDefaults).toHaveBeenCalled();
      });
      expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBeUndefined();
      // Still shown in the picker, just not committed to the session.
      expect(useOpenCodeStore.getState().getModels(ENVIRONMENT_ID)).toHaveLength(1);
    });

    test("a manual refresh that finds no live models leaves the selection alone", async () => {
      useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "openai/gpt-5");
      useOpenCodeStore.getState().setModels(
        ENVIRONMENT_ID,
        [{ id: "openai/cached", name: "Cached", provider: "openai" }] as any,
        "cache",
      );
      mockGetModelsWithDefaults.mockResolvedValue({ models: [], defaults: {} });

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe(
        "openai/gpt-5",
      );
    });

    test("does not overwrite models that arrived before the cached read completes", async () => {
      const cachedRead = deferred<OpenCodeModelCatalogSnapshot | null>();
      const liveModels = [
        { id: "openai/live", name: "Live", provider: "openai" },
      ];
      const cachedModels = [
        { id: "openai/cached", name: "Cached", provider: "openai" },
      ];
      mockGetCachedOpenCodeModelCatalog.mockImplementationOnce(
        () => cachedRead.promise,
      );

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );
      act(() => {
        useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, liveModels);
      });
      await act(async () => {
        cachedRead.resolve({
          schemaVersion: 2,
          projectId: "project-1",
          catalogVersion: "cached",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: cachedModels,
        });
        await cachedRead.promise;
      });

      expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
        liveModels,
      );
    });

    test("ignores a cached read that resolves after unmount", async () => {
      const cachedRead = deferred<OpenCodeModelCatalogSnapshot | null>();
      mockGetCachedOpenCodeModelCatalog.mockImplementationOnce(
        () => cachedRead.promise,
      );
      const view = render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );
      view.unmount();

      await act(async () => {
        cachedRead.resolve({
          schemaVersion: 2,
          projectId: "project-1",
          catalogVersion: "cached",
          updatedAt: "2026-07-27T12:00:00.000Z",
          models: [{ id: "openai/late", name: "Late", provider: "openai" }],
        });
        await cachedRead.promise;
      });

      expect(useOpenCodeStore.getState().models.has(ENVIRONMENT_ID)).toBe(false);
    });

    test("treats cached read rejection as non-fatal", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      mockGetCachedOpenCodeModelCatalog.mockRejectedValueOnce(
        new Error("cache unavailable"),
      );

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
        );
        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to load cached models:",
            expect.any(Error),
          );
        });
        expect(screen.getByText("Ready to build!")).toBeTruthy();
      } finally {
        console.warn = originalWarn;
      }
    });

    test("skips cache IO when the environment has no project", async () => {
      useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
        projectId: "",
        setupPhase: "ready",
      });
      mockGetModelsWithDefaults.mockResolvedValue({
        models: [{ id: "openai/live", name: "Live", provider: "openai" }],
        defaults: {},
      });
      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });
      expect(mockGetCachedOpenCodeModelCatalog).not.toHaveBeenCalled();
      expect(mockCacheOpenCodeModelCatalog).not.toHaveBeenCalled();
    });

    test("falls back to the first available model when the selected one is gone", async () => {
      useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "openai/gpt-5");
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSelectedModel(SESSION_KEY),
        ).toBe("anthropic/claude-sonnet");
      });
    });

    test("prefers the recent model from preferences when current is invalid", async () => {
      useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "openai/gpt-5");
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
        { id: "openai/gpt-4", name: "GPT-4", provider: "openai" },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: { modelId: "openai/gpt-4" },
      }));
      mockGetOpencodeModelPreferences.mockImplementation(async () => ({
        recent: [{ providerID: "anthropic", modelID: "claude-sonnet" }],
        favorite: [],
        variant: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSelectedModel(SESSION_KEY),
        ).toBe("anthropic/claude-sonnet");
      });
    });

    test("falls back to the server default model and its default variant", async () => {
      useOpenCodeStore.getState().setSelectedModel(
        SESSION_KEY,
        "removed/model",
      );
      useOpenCodeStore.getState().setSelectedVariant(
        SESSION_KEY,
        "removed-variant",
      );
      mockGetModelsWithDefaults.mockResolvedValue({
        models: [
          {
            id: "anthropic/claude-sonnet",
            name: "Claude Sonnet",
            provider: "anthropic",
            variants: ["fast"],
          },
          {
            id: "openai/server-default",
            name: "Server Default",
            provider: "openai",
            variants: ["medium", "high"],
          },
        ],
        defaults: {
          modelId: "openai/server-default",
          variant: "high",
        },
      });
      mockGetOpencodeModelPreferences.mockResolvedValue({
        recent: ["unavailable/recent"],
        favorite: [],
        variant: {},
      });

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );
      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe(
          "openai/server-default",
        );
        expect(useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY)).toBe(
          "high",
        );
      });
    });

    test("normalizes and deduplicates string and object model preferences", async () => {
      useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "removed/model");
      const refreshedModels = [
        {
          id: "anthropic/claude-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
          variants: ["high"],
        },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
      ];
      mockGetModelsWithDefaults.mockResolvedValue({
        models: refreshedModels,
        defaults: {},
      });
      mockGetOpencodeModelPreferences.mockResolvedValue({
        recent: [
          " anthropic/claude-sonnet ",
          { providerID: "anthropic", modelID: "claude-sonnet" },
          "invalid",
        ],
        favorite: [
          { providerID: "openai", modelID: "gpt-5" },
          "openai/gpt-5",
          "anthropic/claude-sonnet",
        ],
        variant: {
          " anthropic/claude-sonnet ": " high ",
          "openai/gpt-5": "",
        },
      });

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );
      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe(
          "anthropic/claude-sonnet",
        );
        expect(useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY)).toBe(
          "high",
        );
        expect(screen.getByTestId("opencode-favorite-models").textContent).toBe(
          "openai/gpt-5,anthropic/claude-sonnet",
        );
      });
    });

    test("validates and clears preserved launch options after a successful live refresh", async () => {
      seedPaneLayout(undefined, {
        initialAgentModel: "openai/review",
        initialReasoningEffort: "high",
      });
      useOpenCodeStore.getState().setModels(ENVIRONMENT_ID, [
        { id: "openai/cached", name: "Cached", provider: "openai" },
      ]);
      mockGetModelsWithDefaults.mockResolvedValue({
        models: [
          {
            id: "openai/review",
            name: "Review",
            provider: "openai",
            variants: ["high"],
          },
        ],
        defaults: {},
      });

      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
          initialAgentModel="openai/review"
          initialReasoningEffort="high"
        />,
      );
      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe(
          "openai/review",
        );
        expect(useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY)).toBe(
          "high",
        );
        const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
          .find((candidate) => candidate.id === TAB_ID);
        expect(tab?.initialAgentModel).toBeUndefined();
        expect(tab?.initialReasoningEffort).toBeUndefined();
      });
    });

    test("clears the variant when it is no longer available on the selected model", async () => {
      useOpenCodeStore.getState().setSelectedModel(SESSION_KEY, "openai/gpt-5");
      useOpenCodeStore.getState().setSelectedVariant(SESSION_KEY, "high");
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: [
          { id: "openai/gpt-5", name: "GPT-5", provider: "openai", variants: ["low"] },
        ],
        defaults: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY),
        ).toBeUndefined();
      });
    });

    test("logs and recovers when the SDK fetch fails", async () => {
      mockGetModelsWithDefaults.mockImplementation(async () => {
        throw new Error("network down");
      });
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
        );

        await act(async () => {
          fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
        });

        await waitFor(() => {
          expect(consoleError).toHaveBeenCalled();
        });
      } finally {
        console.error = originalError;
      }
    });

    test("falls back to empty preferences when preference loading rejects", async () => {
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
        {
          id: "openai/server-fallback",
          name: "Server Fallback",
          provider: "openai",
          variants: ["medium"],
        },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: {
          modelId: "openai/server-fallback",
          variant: "medium",
        },
      }));
      useOpenCodeStore.getState().setSelectedModel(
        SESSION_KEY,
        "removed/model",
      );
      mockGetOpencodeModelPreferences.mockImplementation(async () => {
        throw new Error("disk read failed");
      });
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
        );

        await act(async () => {
          fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
        });

        await waitFor(() => {
          expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
            refreshedModels,
          );
          expect(useOpenCodeStore.getState().getSelectedModel(SESSION_KEY)).toBe(
            "openai/server-fallback",
          );
          expect(useOpenCodeStore.getState().getSelectedVariant(SESSION_KEY)).toBe(
            "medium",
          );
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to load model preferences:",
            expect.any(Error),
          );
        });
      } finally {
        console.warn = originalWarn;
      }
    });
  });

});

function installTimerHarness(startTime: number) {
  mockedNow = startTime;
  clearIntervalCalls = 0;
  Date.now = () => mockedNow;

  // The tab registers more than one interval (the elapsed timer and the
  // stalled-turn watchdog), so keep them all and tick them together rather
  // than letting the last registration win.
  const callbacks: Array<() => void> = [];
  intervalCallback = () => {
    for (const callback of [...callbacks]) callback();
  };

  globalThis.setInterval = (((callback: TimerHandler) => {
    callbacks.push(callback as () => void);
    return callbacks.length as unknown as ReturnType<typeof setInterval>;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearIntervalCalls += 1;
  }) as typeof clearInterval;
}
