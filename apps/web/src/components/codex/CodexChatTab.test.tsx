import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {useCodexStore} from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type {
  CodexAbortOutcome,
  CodexApproval,
  CodexInteraction,
  CodexPromptAcceptedResponse,
  CodexPromptSendOutcome,
  CodexSessionConfigUpdateOutcome,
  CodexSessionPhase,
  CodexSessionStatusLookupResult,
} from "@/lib/codex-client";
import { mockToastError, mockToastWarning } from "../../../../../tests/mocks/sonner";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

// The SSE approval path runs its payload through the real `parseApproval`, so the
// module mock below has to hand back the genuine validator: a permissive stub
// would let the suite accept an approval the app would refuse to render.
import * as realCodexClient from "@/lib/codex-client";
const realCodexClientSnapshot = { ...realCodexClient };

// Snapshot the real sibling modules before we install stubs so we can restore
// them when this file finishes. Without this, Bun's global mock.module cache
// would leak these stubs into other test files (notably CodexComposeBar.test.tsx)
// and cause them to receive the stub component instead of the real one.
import * as realCodexComposeBar from "./CodexComposeBar";
import * as realCodexPlanModeCard from "./CodexPlanModeCard";
import * as realCodexResumeSessionDialog from "./CodexResumeSessionDialog";
const realCodexComposeBarSnapshot = { ...realCodexComposeBar };
const realCodexPlanModeCardSnapshot = { ...realCodexPlanModeCard };
const realCodexResumeSessionDialogSnapshot = { ...realCodexResumeSessionDialog };
const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;
let lastVirtualizedMessages: any[] = [];

const MOCK_MODELS = [
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-codex",
    name: "gpt-5.4-codex",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  },
];

type TestCodexMessage = NativeMessage & {
  role: "assistant";
  planReview?: boolean;
};

const mockRenameEnvironmentFromPrompt = mock(async () => {});
// Typed like the real client: the difference between `null`, `processing` and an
// `already-processed` duplicate is exactly what the send path branches on.
const mockSendPrompt = mock<
  (
    _client: unknown,
    _sessionId: string,
    _prompt: string,
    _options?: { attachments?: unknown; requestId?: string },
  ) => Promise<CodexPromptSendOutcome | CodexPromptAcceptedResponse | null>
>(async () => ({ status: "processing" }));
const mockGetSessionMessages = mock(async (): Promise<TestCodexMessage[]> => []);
const mockGetStructuredOutput = mock<
  (
    _client: unknown,
    _sessionId: string,
    _requestId?: string,
  ) => Promise<any>
>(async () => null);
const mockSubscribeToEvents = mock<
  (
    _client: unknown,
    _signal?: AbortSignal,
    _since?: number,
    _sessionId?: string,
  ) => AsyncIterable<any>
>(() => (async function* () {})());
const mockUpdateSessionConfig = mock<
  (
    _client: unknown,
    _sessionId: string,
    _config: unknown,
  ) => Promise<CodexSessionConfigUpdateOutcome | boolean>
>(async () => true);
const mockAbortSession = mock<
  (_client: unknown, _sessionId: string) => Promise<CodexAbortOutcome>
>(async () => ({ status: "accepted" }));
const mockFetchPendingApprovals = mock<
  (_client: unknown, _sessionId: string) => Promise<CodexApproval[]>
>(async () => []);
const mockFetchPendingInteractions = mock<
  (_client: unknown, _sessionId: string) => Promise<CodexInteraction[]>
>(async () => []);
const mockRespondToInteraction = mock(async () => "applied" as const);
// `forkCodexSession` no longer collapses refusals to null: it throws a
// `CodexForkError` carrying the bridge's own status and message.
const mockForkCodexSession = mock<
  (
    _client: unknown,
    _sessionId: string,
    _messageId?: string,
  ) => Promise<{ sessionId: string; title?: string }>
>(async () => ({ sessionId: "fork-session", title: "Codex fork" }));
const mockCreateSession = mock(async () => ({ sessionId: "session-1", title: "Test session" }));
const mockGetSessionStatus = mock<
  (
    _client: unknown,
    _sessionId: string,
    _options?: { throwOnError?: boolean },
  ) => Promise<{
    status: string;
    phase?: CodexSessionPhase;
    title?: string;
    error?: string;
  } | null>
>(async () => ({ status: "idle" }));
const mockLookupSessionStatus = mock<
  (_client: unknown, _sessionId: string) => Promise<CodexSessionStatusLookupResult>
>(async (client, sessionId) => {
  const status = await mockGetSessionStatus(client, sessionId);
  return status
    ? { kind: "found", session: status as any }
    : { kind: "unavailable", error: new Error("status unavailable") };
});
const mockResumeSession = mock(async () => null as null | {
  session: { sessionId: string; title?: string };
  messages: TestCodexMessage[];
});
const mockCheckHealth = mock(async () => true);
const mockGetCodexServerLog = mock(async () => "");
const mockGetCodexServerStatus = mock(async () => ({
  running: true,
  hostPort: 9999,
  authToken: "container-test-token",
}));
const mockGetLocalCodexServerStatus = mock(async () => ({
  running: true,
  port: 9999,
  pid: 1234,
  authToken: "local-test-token",
}));
const mockStartCodexServer = mock(async () => ({
  hostPort: 9999,
  authToken: "container-start-token",
}));
const mockStartLocalCodexServer = mock(async () => ({
  port: 9999,
  pid: 1234,
  authToken: "local-start-token",
}));
const mockCreateClient = mock(
  (_baseUrl: string, _authToken?: string) => ({
    baseUrl: "http://127.0.0.1:9999",
  }),
);
const mockUpdateGlobalConfig = mock(async (config: any) => ({
  ...useConfigStore.getState().config,
  global: config,
}));
const mockGetAgentHandoff = mock(async (_handoffId: string): Promise<any> => null);
const claimedPromptHeads = new Set<string>();
const mockClaimPromptQueueHead = mock(async (
  queueKey: string,
  environmentId: string,
  expectedMessageId: string,
  candidateMessages: Array<{ id: string }>,
) => {
  const claimKey = `${queueKey}\u0000${expectedMessageId}`;
  const alreadyClaimed = claimedPromptHeads.has(claimKey);
  if (!alreadyClaimed) claimedPromptHeads.add(claimKey);
  return {
    claimed: alreadyClaimed ? null : (candidateMessages[0] ?? null),
    queue: {
      queueKey,
      environmentId,
      messages: candidateMessages.slice(1),
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    },
  };
});

// NOTE: Do NOT mock @/hooks/useScrollLock here — it pollutes the global
// module cache and breaks useScrollLock.test.ts. The real hook returns
// safe defaults (isAtBottom: true) when no viewport is found in happy-dom.

mock.module("@/lib/backend", () => ({
  claimPromptQueueHead: mockClaimPromptQueueHead,
  getAgentHandoff: mockGetAgentHandoff,
  getCodexServerLog: mockGetCodexServerLog,
  getCodexServerStatus: mockGetCodexServerStatus,
  getLocalCodexServerStatus: mockGetLocalCodexServerStatus,
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
  startCodexServer: mockStartCodexServer,
  startLocalCodexServer: mockStartLocalCodexServer,
  updateGlobalConfig: mockUpdateGlobalConfig,
}));

mock.module("@/lib/codex-client", () => ({
  CODEX_MODELS: MOCK_MODELS,
  DEFAULT_CODEX_MODEL: MOCK_MODELS[0]!.id,
  // The real class: the fork handler branches on `instanceof`, so a stub would
  // send every refusal down the unexpected-error path.
  CodexForkError: realCodexClientSnapshot.CodexForkError,
  abortSession: mockAbortSession,
  checkHealth: mockCheckHealth,
  createClient: mockCreateClient,
  createSession: mockCreateSession,
  // Called on every reconcile. Stubbed so the suite does not attempt a real fetch
  // to the fake bridge port on each state refresh.
  fetchPendingApprovals: mockFetchPendingApprovals,
  fetchPendingInteractions: mockFetchPendingInteractions,
  getModels: mock(async () => ({ models: MOCK_MODELS, source: "fallback" })),
  getSlashCommands: mock(async () => []),
  getSessionMessages: mockGetSessionMessages,
  getStructuredOutput: mockGetStructuredOutput,
  getSessionStatus: mockGetSessionStatus,
  isCodexSessionPhase: (value: unknown) =>
    typeof value === "string"
    && ["starting", "running", "cancelling", "recovering", "idle", "failed"].includes(value),
  lookupSessionStatus: mockLookupSessionStatus,
  parseApproval: realCodexClientSnapshot.parseApproval,
  // The interaction and usage paths run their SSE payloads through the real
  // validators for the same reason `parseApproval` does: a permissive stub
  // would let the suite accept a frame the app itself would refuse.
  parseInteraction: realCodexClientSnapshot.parseInteraction,
  parseContextUsage: realCodexClientSnapshot.parseContextUsage,
  forkCodexSession: mockForkCodexSession,
  respondToInteraction: mockRespondToInteraction,
  resumeSession: mockResumeSession,
  sendPrompt: mockSendPrompt,
  subscribeToEvents: mockSubscribeToEvents,
  updateSessionConfig: mockUpdateSessionConfig,
}));

let composeText = "Rename the environment";
let composeAttachments: Array<{
  id: string;
  type: "image";
  path: string;
  previewUrl?: string;
  name: string;
}> = [];

mock.module("./CodexComposeBar", () => ({
  CodexComposeBar: ({
    onSend,
    onStop,
    onModeChange,
    onFastModeChange,
    onModelChange,
    onReasoningEffortChange,
    onQueue,
    disabled,
    isLoading,
    showAddressAll,
    layout,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    onStop?: () => Promise<void>;
    onModeChange?: (mode: "build" | "plan") => Promise<void>;
    onFastModeChange?: (enabled: boolean) => void;
    onModelChange?: (model: string) => Promise<void>;
    onReasoningEffortChange?: (effort: "low" | "medium" | "high") => Promise<void>;
    onQueue?: (text: string, attachments: typeof composeAttachments) => void;
    disabled?: boolean;
    isLoading?: boolean;
    showAddressAll?: boolean;
    layout?: "bottom" | "centered";
  }) => (
    <>
      <div data-testid="codex-address-all-state">
        {showAddressAll ? "shown" : "hidden"}
      </div>
      <div data-testid="codex-compose-layout">{layout ?? "bottom"}</div>
      <button
        type="button"
        data-testid="codex-send"
        disabled={disabled}
        onClick={() => {
          void onSend(composeText, composeAttachments);
        }}
      >
        Send
      </button>
      <button
        type="button"
        data-testid="codex-model-change"
        onClick={() => {
          void onModelChange?.("gpt-5.4-codex");
        }}
      >
        Change model
      </button>
      <button
        type="button"
        data-testid="codex-effort-change"
        onClick={() => {
          void onReasoningEffortChange?.("low");
        }}
      >
        Change effort
      </button>
      <button type="button" data-testid="codex-queue" onClick={() => onQueue?.(composeText, composeAttachments)}>
        Queue
      </button>
      {isLoading ? (
        <button
          type="button"
          data-testid="codex-stop"
          disabled={disabled}
          onClick={() => {
            void onStop?.();
          }}
        >
          Stop
        </button>
      ) : null}
      <button
        type="button"
        data-testid="codex-fast-mode-on"
        onClick={() => onFastModeChange?.(true)}
      >
        Fast on
      </button>
      <button
        type="button"
        data-testid="codex-fast-mode-off"
        onClick={() => onFastModeChange?.(false)}
      >
        Fast off
      </button>
      <button
        type="button"
        data-testid="codex-mode-build"
        onClick={() => {
          void onModeChange?.("build");
        }}
      >
        Build mode
      </button>
      <button
        type="button"
        data-testid="codex-mode-plan"
        onClick={() => {
          void onModeChange?.("plan");
        }}
      >
        Plan mode
      </button>
    </>
  ),
}));

mock.module("./CodexPlanModeCard", () => ({
  CodexPlanModeCard: ({
    onDismiss,
    onSwitchToBuild,
    onApproveAndBuild,
  }: {
    onDismiss?: () => void;
    onSwitchToBuild?: () => Promise<void>;
    onApproveAndBuild?: () => Promise<void>;
  }) => (
    <div data-testid="codex-plan-mode-card">
      <button
        type="button"
        data-testid="codex-plan-dismiss"
        onClick={() => onDismiss?.()}
      >
        Dismiss
      </button>
      <button
        type="button"
        data-testid="codex-plan-switch-build"
        onClick={() => {
          void onSwitchToBuild?.();
        }}
      >
        Switch to build
      </button>
      <button
        type="button"
        data-testid="codex-plan-approve"
        onClick={() => {
          void onApproveAndBuild?.();
        }}
      >
        Approve
      </button>
    </div>
  ),
}));

mock.module("./CodexResumeSessionDialog", () => ({
  CodexResumeSessionDialog: ({
    open,
    onResume,
  }: {
    open: boolean;
    onResume: (threadId: string) => void;
  }) => open ? (
    <button type="button" data-testid="codex-resume-choice" onClick={() => onResume("resumed-thread")}>
      Resume previous Codex session
    </button>
  ) : null,
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

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer }: any) => {
    lastVirtualizedMessages = messages;
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

import { CodexChatTab } from "./CodexChatTab";
import type { CodexNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const CONTAINER_ID = "container-1";
const TAB_ID = "tab-1";
const SESSION_ID = "session-1";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);

/** True once the client-only "stopped by user" marker is in the transcript. */
function hasStopMarker() {
  return (
    useCodexStore
      .getState()
      .sessions.get(SESSION_KEY)
      ?.messages.some((message) => message.content === "Query stopped by user.") ?? false
  );
}
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;

let mockedNow = 0;
let intervalCallbacks: Array<() => void> = [];
let intervalCallback: (() => void) | null = null;
let clearIntervalCalls = 0;

function createMessage(
  id: string,
  content: string,
  options: Pick<TestCodexMessage, "planReview"> = {},
): TestCodexMessage {
  return {
    id,
    role: "assistant" as const,
    content,
    parts: [{ type: "text" as const, content }],
    createdAt: "2026-04-15T00:00:00.000Z",
    ...options,
  };
}

function createApproval(approvalId = "approval-1"): CodexApproval {
  return {
    approvalId,
    kind: "command",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    command: "bun test",
    actionable: true,
    supportsApproveForSession: false,
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

function createData(overrides: Partial<CodexNativeData> = {}): CodexNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: CONTAINER_ID,
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
      destinationProvider: "codex",
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

function seedConfigStore() {
  useConfigStore.setState({
    config: {
      version: "1.0",
      global: {
        containerResources: { cpuCores: 2, memoryGb: 4 },
        envFilePatterns: [],
        allowedDomains: [],
        defaultAgent: "codex",
        opencodeModel: "gpt-4",
        codexModel: MOCK_MODELS[0]!.id,
        codexReasoningEffort: "medium",
        opencodeMode: "terminal",
        claudeMode: "terminal",
        claudeNativeBackend: "sdk",
        claudeNativeFastModeDefault: false,
        codexMode: "native",
        codexNativeFastModeDefault: false,
        terminalAppearance: {
          fontFamily: "Fira Code",
          fontSize: 14,
          backgroundColor: "#000000",
        },
        terminalScrollback: 5000,
      },
      repositories: {},
    } as any,
    isLoading: false,
    error: null,
  });
}

function seedEnvironment(name = "20260415-123456") {
  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name,
        branch: "main",
        containerId: CONTAINER_ID,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
}

function seedPaneLayout(
  initialPrompt?: string,
  launchOptions?: { initialAgentModel?: string; initialReasoningEffort?: string },
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
                type: "codex-native" as any,
                codexNativeData: createData(),
                initialPrompt,
                initialAgentModel: launchOptions?.initialAgentModel,
                initialReasoningEffort: launchOptions?.initialReasoningEffort,
              },
            ],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: CONTAINER_ID,
        },
      ],
    ]),
    activeEnvironmentId: ENVIRONMENT_ID,
  });
}

function seedCodexStore(messages: ReturnType<typeof createMessage>[] = []) {
  useCodexStore.setState({
    models: MOCK_MODELS as any,
    serverStatus: new Map(),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: SESSION_ID,
          messages,
          isLoading: false,
          title: "Test session",
        },
      ],
    ]),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map([[SESSION_KEY, MOCK_MODELS[0]!.id]]),
    selectedMode: new Map([[SESSION_KEY, "build"]]),
    selectedReasoningEffort: new Map([[SESSION_KEY, "medium"]]),
    fastMode: new Map(),
    sessionPhase: new Map(),
    pendingApprovals: new Map(),
    pendingInteractions: new Map(),
    contextUsage: new Map(),
  });
}

function createInteraction(
  interactionId = "interaction-1",
  overrides: Partial<CodexInteraction> = {},
): CodexInteraction {
  return {
    interactionId,
    kind: "question",
    method: "item/question/request",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    questions: [
      {
        id: "q1",
        header: "Deployment",
        question: "Which environment should I target?",
        isOther: false,
        isSecret: false,
        options: [{ label: "staging" }, { label: "production" }],
      },
    ],
    ...overrides,
  };
}

function resetStores() {
  seedConfigStore();
  seedEnvironment();
  seedPaneLayout();
  seedCodexStore();
}

// Restore the real sibling modules once this file's tests finish so later
// test files (e.g. CodexComposeBar.test.tsx) see the real components.
afterAll(() => {
  mock.module("./CodexComposeBar", () => realCodexComposeBarSnapshot);
  mock.module("./CodexPlanModeCard", () => realCodexPlanModeCardSnapshot);
  mock.module("./CodexResumeSessionDialog", () => realCodexResumeSessionDialogSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

describe("CodexChatTab", () => {
  beforeEach(() => {
    cleanup();
    claimedPromptHeads.clear();
    mockClaimPromptQueueHead.mockClear();
    composeText = "Rename the environment";
    composeAttachments = [];

    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockGetAgentHandoff.mockReset();
    mockGetAgentHandoff.mockResolvedValue(null);
    mockSendPrompt.mockClear();
    mockSendPrompt.mockImplementation(async () => ({ status: "processing" }));
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(async () => []);
    mockGetStructuredOutput.mockReset();
    mockGetStructuredOutput.mockResolvedValue(null);
    mockSubscribeToEvents.mockClear();
    mockSubscribeToEvents.mockImplementation(() => (async function* () {})());
    mockScrollToBottom.mockClear();
    mockUpdateSessionConfig.mockClear();
    mockUpdateSessionConfig.mockImplementation(async () => true);
    mockToastWarning.mockClear();
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => ({ status: "accepted" as const }));
    mockFetchPendingApprovals.mockClear();
    mockFetchPendingApprovals.mockImplementation(async () => []);
    mockFetchPendingInteractions.mockClear();
    mockFetchPendingInteractions.mockImplementation(async () => []);
    mockForkCodexSession.mockClear();
    mockForkCodexSession.mockImplementation(async () => ({
      sessionId: "fork-session",
      title: "Codex fork",
    }));
    mockRespondToInteraction.mockClear();
    mockRespondToInteraction.mockImplementation(async () => "applied" as const);
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(async () => ({ sessionId: "session-1", title: "Test session" }));
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockImplementation(async () => ({ status: "idle" }));
    mockLookupSessionStatus.mockReset();
    mockLookupSessionStatus.mockImplementation(async (client, sessionId) => {
      const status = await mockGetSessionStatus(client, sessionId);
      return status
        ? { kind: "found", session: status as any }
        : { kind: "unavailable", error: new Error("status unavailable") };
    });
    mockResumeSession.mockReset();
    mockResumeSession.mockResolvedValue(null);
    mockCheckHealth.mockReset();
    mockCheckHealth.mockResolvedValue(true);
    mockGetCodexServerLog.mockReset();
    mockGetCodexServerLog.mockResolvedValue("");
    mockGetCodexServerStatus.mockReset();
    mockGetCodexServerStatus.mockResolvedValue({
      running: true,
      hostPort: 9999,
      authToken: "container-test-token",
    });
    mockGetLocalCodexServerStatus.mockReset();
    mockGetLocalCodexServerStatus.mockResolvedValue({
      running: true,
      port: 9999,
      pid: 1234,
      authToken: "local-test-token",
    });
    mockStartCodexServer.mockReset();
    mockStartCodexServer.mockResolvedValue({
      hostPort: 9999,
      authToken: "container-start-token",
    });
    mockStartLocalCodexServer.mockReset();
    mockStartLocalCodexServer.mockResolvedValue({
      port: 9999,
      pid: 1234,
      authToken: "local-start-token",
    });
    mockCreateClient.mockClear();
    mockUpdateGlobalConfig.mockReset();
    mockUpdateGlobalConfig.mockImplementation(async (global) => ({
      ...useConfigStore.getState().config,
      global,
    }));
    mockIsAtBottom = true;
    lastVirtualizedMessages = [];
    restoreTimerHarness();

    resetStores();
  });

  afterEach(() => {
    cleanup();
    restoreTimerHarness();
    mock.restore();
  });

  test("blocks sending until a restored agent handoff finishes loading", async () => {
    const handoffId = "codex-delayed-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    expect((await screen.findByTestId("codex-send")).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("codex-send"));
    expect(mockSendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(agentHandoffRecord(handoffId, bootstrapPrompt));
      await pending.promise;
    });

    await waitFor(() =>
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        expect.stringContaining(`"id": "${handoffId}"`),
        expect.any(Object),
      ),
    );
  });

  test("initializes once when a handoff resolves during a cold start", async () => {
    /*
     * `launchPrompt` flips undefined → string a few milliseconds after mount.
     * Listing it as an initialization dependency tore the effect down and
     * re-ran it mid-connect, re-issuing server status/start and risking an
     * orphaned session. Gate on readiness and read the prompt from a ref.
     */
    const handoffId = "codex-single-init";
    // Force the cold path: with a cached client and session the effect short
    // circuits and never reaches the work a restart would duplicate.
    useCodexStore.setState({ clients: new Map(), sessions: new Map() });
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    expect(mockGetCodexServerStatus).not.toHaveBeenCalled();
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
    expect(mockGetCodexServerStatus).toHaveBeenCalledTimes(1);
  });

  test("does not append a handoff bootstrap to a restored destination transcript", async () => {
    const handoffId = "codex-restored-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    mockGetAgentHandoff.mockResolvedValue(
      agentHandoffRecord(handoffId, bootstrapPrompt),
    );
    const existingMessage = createMessage(
      "existing-answer",
      "Destination work already started",
    );
    seedCodexStore([existingMessage]);
    mockGetSessionMessages.mockResolvedValue([existingMessage]);

    const first = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: SESSION_ID })}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    await waitFor(() => expect(mockGetAgentHandoff).toHaveBeenCalledWith(handoffId));
    expect(screen.getByTestId("codex-send").hasAttribute("disabled")).toBe(false);
    expect(mockSendPrompt).not.toHaveBeenCalled();

    first.unmount();
    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: SESSION_ID })}
        isActive={false}
        agentHandoffId={handoffId}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  test("renames timestamp environments before sending the first prompt", async () => {
    composeText = "Build a dashboard for pull request triage";

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });
    const optimistic = useCodexStore.getState().getSession(SESSION_KEY)?.messages.find(
      (message) => message.role === "user" && message.content === composeText,
    );
    expect(optimistic?.id).toMatch(/^optimistic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("refresh requests pull the latest transcript and session status", async () => {
    const { rerender } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalled();
    });
    mockGetSessionStatus.mockReset();
    mockGetSessionMessages.mockReset();

    const serverMessage = createMessage(
      "server-message",
      "Updated by another client",
    );
    mockGetSessionStatus.mockResolvedValue({
      status: "running",
      title: "Server title",
    });
    mockGetSessionMessages.mockResolvedValue([serverMessage]);

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [serverMessage],
        isLoading: true,
        title: "Server title",
      });
    });
    expect(mockLookupSessionStatus).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);
  });

  test("failed manual refreshes preserve the current transcript", async () => {
    const currentMessage = createMessage("current-message", "Keep the current transcript");
    const { rerender } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalled();
    });
    act(() => {
      useCodexStore.getState().setMessages(SESSION_KEY, [currentMessage]);
    });
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue({ status: "idle" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockRejectedValue(new Error("message fetch failed"));

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      currentMessage,
    ]);
  });

  test("an older overlapping refresh cannot overwrite the newer request", async () => {
    const currentMessage = createMessage("current-message", "Current transcript");
    const staleMessage = createMessage("stale-message", "Stale server snapshot");
    const newerMessage = createMessage("newer-message", "Newer server snapshot");
    let resolveFirstMessages!: (messages: TestCodexMessage[]) => void;
    const firstMessagesPromise = new Promise<TestCodexMessage[]>((resolve) => {
      resolveFirstMessages = resolve;
    });
    const { rerender } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalled();
    });
    act(() => {
      useCodexStore.getState().setMessages(SESSION_KEY, [currentMessage]);
    });
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue({ status: "idle" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages
      .mockImplementationOnce(() => firstMessagesPromise)
      .mockResolvedValue([newerMessage]);

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalledTimes(1));

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={2}
      />,
    );
    await waitFor(() => {
      expect(mockGetSessionStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
        newerMessage,
      ]);
    });
    await act(async () => {
      resolveFirstMessages([staleMessage]);
      await firstMessagesPromise;
    });

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      newerMessage,
    ]);
  });

  test("rehydrates the session id saved in a restored pane tab", async () => {
    const restoredSessionId = "restored-codex-session";
    useCodexStore.setState({ sessions: new Map() });
    usePaneLayoutStore
      .getState()
      .updateTabNativeSessionId(TAB_ID, restoredSessionId, ENVIRONMENT_ID);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, restoredSessionId);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
        restoredSessionId,
      );
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    const restoredRoot = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)?.root;
    expect(restoredRoot?.kind).toBe("leaf");
    if (!restoredRoot || restoredRoot.kind !== "leaf") throw new Error("Expected pane leaf");
    const restoredTab = restoredRoot.tabs.find((tab) => tab.id === TAB_ID);
    expect(restoredTab?.codexNativeData?.sessionId).toBe(restoredSessionId);
  });

  test("cold-restores a persisted session with its transcript", async () => {
    const restoredSessionId = "cold-restored-codex";
    const restoredMessage = createMessage("restored-message", "Persisted Codex transcript");
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout();
    usePaneLayoutStore.getState().updateTabNativeSessionId(TAB_ID, restoredSessionId, ENVIRONMENT_ID);
    mockGetSessionMessages.mockResolvedValue([restoredMessage]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalledWith(
        expect.anything(),
        restoredSessionId,
        { throwOnError: true },
      );
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([restoredMessage]);
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("keeps a restored session on transient status failure and succeeds on retry", async () => {
    const restoredSessionId = "transient-codex";
    useCodexStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout();
    usePaneLayoutStore.getState().updateTabNativeSessionId(TAB_ID, restoredSessionId, ENVIRONMENT_ID);
    mockGetSessionStatus.mockRejectedValueOnce(new Error("status transport failed"));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await screen.findByText("status transport failed");
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.codexNativeData?.sessionId)
      .toBe(restoredSessionId);

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(restoredSessionId);
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("replaces a confirmed-missing restored session and writes the new id to the pane", async () => {
    const missingSessionId = "missing-codex";
    useCodexStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout();
    usePaneLayoutStore.getState().updateTabNativeSessionId(TAB_ID, missingSessionId, ENVIRONMENT_ID);
    mockGetSessionStatus.mockResolvedValueOnce(null);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: missingSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.codexNativeData?.sessionId)
        .toBe("session-1");
    });
  });

  test("writes a manually resumed session id and transcript to both stores", async () => {
    const resumedMessage = createMessage("resumed-message", "Resumed Codex transcript");
    mockResumeSession.mockResolvedValue({
      session: { sessionId: "resumed-codex", title: "Resumed" },
      messages: [resumedMessage],
    });
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(await screen.findByTestId("codex-resume-choice"));

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledWith(MOCK_CLIENT, expect.objectContaining({ threadId: "resumed-thread" }));
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "resumed-codex",
        messages: [resumedMessage],
      });
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.codexNativeData?.sessionId)
        .toBe("resumed-codex");
    });
  });

  test("clears old requests and ignores delayed rehydration after resume", async () => {
    const staleApprovals = deferred<CodexApproval[]>();
    const staleInteractions = deferred<CodexInteraction[]>();
    mockFetchPendingApprovals.mockImplementationOnce(() => staleApprovals.promise);
    mockFetchPendingInteractions.mockImplementationOnce(() => staleInteractions.promise);
    mockResumeSession.mockResolvedValue({
      session: { sessionId: "resumed-codex", title: "Resumed" },
      messages: [],
    });

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
    await waitFor(() => {
      expect(mockFetchPendingApprovals).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);
      expect(mockFetchPendingInteractions).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);
    });
    act(() => {
      useCodexStore.getState().setPendingApprovals(
        SESSION_KEY,
        [createApproval("old-approval")],
      );
      useCodexStore.getState().setPendingInteractions(
        SESSION_KEY,
        [createInteraction("old-interaction")],
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(await screen.findByTestId("codex-resume-choice"));
    await waitFor(() =>
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId)
        .toBe("resumed-codex"),
    );
    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);

    await act(async () => {
      staleApprovals.resolve([createApproval("late-old-approval")]);
      staleInteractions.resolve([createInteraction("late-old-interaction")]);
      await Promise.all([staleApprovals.promise, staleInteractions.promise]);
    });
    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
  });

  test("keeps the resume dialog open and logs when a manual resume fails", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockResumeSession.mockResolvedValue(null);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
      fireEvent.click(await screen.findByTestId("codex-resume-choice"));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith("[CodexChatTab] Failed to resume session");
      });
      expect(screen.getByTestId("codex-resume-choice")).toBeTruthy();
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(SESSION_ID);
    } finally {
      console.error = originalError;
    }
  });

  test("retains one-shot launch options through an init failure so the retry can apply them", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(undefined, {
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    });
    mockGetCodexServerStatus.mockRejectedValueOnce(new Error("container bridge unavailable"));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="gpt-5.6-sol"
        initialReasoningEffort="high"
      />,
    );

    expect(await screen.findByText("container bridge unavailable")).toBeTruthy();
    // The error screen is a retryable state, not a completed launch, so the
    // durable options must survive it.
    const erroredTab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(erroredTab?.initialAgentModel).toBe("gpt-5.6-sol");
    expect(erroredTab?.initialReasoningEffort).toBe("high");

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
        .find((candidate) => candidate.id === TAB_ID);
      expect(tab?.initialAgentModel).toBeUndefined();
      expect(tab?.initialReasoningEffort).toBeUndefined();
    });
  });

  test("does not consume one-shot launch options for a background tab with nothing to dispatch", async () => {
    // An inactive tab with no prompt never initializes, so it has not applied
    // anything. `TerminalContainer` no longer waits on this acknowledgement, so
    // holding the options here is free — and it is what lets the tab honour them
    // when the user finally activates it.
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(undefined, {
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialAgentModel="gpt-5.6-sol"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => {
      expect(mockGetCodexServerStatus).not.toHaveBeenCalled();
    });
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(tab?.initialAgentModel).toBe("gpt-5.6-sol");
  });

  test("surfaces cold initialization errors with the container bridge log and retries", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    mockGetCodexServerStatus.mockRejectedValueOnce(new Error("container bridge unavailable"));
    mockGetCodexServerLog.mockResolvedValueOnce("sanitized bridge diagnostics");

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByText("container bridge unavailable")).toBeTruthy();
    expect(mockGetCodexServerLog).toHaveBeenCalledWith(CONTAINER_ID);

    // The log sits behind a toggle, as it does for Claude and OpenCode, rather
    // than being dumped into the error screen unconditionally.
    fireEvent.click(screen.getByRole("button", { name: "Show Log" }));
    expect(screen.getByText("sanitized bridge diagnostics")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(SESSION_ID);
  });

  test("reports local initialization errors without requesting a container log", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    useEnvironmentStore.setState({
      setupCommandsResolved: new Set([ENVIRONMENT_ID]),
    });
    mockGetLocalCodexServerStatus.mockRejectedValueOnce("local bridge offline");

    render(<CodexChatTab tabId={TAB_ID} data={createData({ isLocal: true })} isActive />);

    expect(await screen.findByText("local bridge offline")).toBeTruthy();
    expect(mockGetCodexServerLog).not.toHaveBeenCalled();
  });

  test("constructs a cold container client with the bridge status token", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:9999",
        "container-test-token",
      );
    });
    expect(mockStartCodexServer).not.toHaveBeenCalled();
  });

  test("restarts a legacy running bridge whose status has no auth token", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    mockGetCodexServerStatus.mockResolvedValueOnce({
      running: true,
      hostPort: 9999,
      authToken: undefined as any,
    });

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      expect(mockStartCodexServer).toHaveBeenCalledWith(CONTAINER_ID);
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:9999",
        "container-start-token",
      );
    });
  });

  test("turns a failed cached-client health check into a reconnectable error", async () => {
    mockCheckHealth.mockResolvedValue(false);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByText("Codex bridge server disconnected. Click retry to reconnect.")).toBeTruthy();
    expect(useCodexStore.getState().clients.has(ENVIRONMENT_ID)).toBe(false);
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  test("turns a rejected cached-client health check into a reconnectable error", async () => {
    mockCheckHealth.mockRejectedValue(new Error("health request reset"));

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(
      await screen.findByText("Codex bridge server disconnected. Click retry to reconnect."),
    ).toBeTruthy();
    expect(useCodexStore.getState().clients.has(ENVIRONMENT_ID)).toBe(false);
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  test("keeps the live thread when retrying after a transient health check failure", async () => {
    /**
     * One failed background ping flips a healthy tab to "error". Clearing the
     * session there would strand a running thread behind the resume dialog and
     * drop the user into an empty one, so retry reattaches instead.
     */
    mockCheckHealth.mockResolvedValue(false);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(
      await screen.findByText("Codex bridge server disconnected. Click retry to reconnect."),
    ).toBeTruthy();
    // The stale client is dropped, but the session survives for the reattach.
    expect(useCodexStore.getState().clients.has(ENVIRONMENT_ID)).toBe(false);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(SESSION_ID);

    mockCheckHealth.mockResolvedValue(true);
    mockCreateSession.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(useCodexStore.getState().clients.has(ENVIRONMENT_ID)).toBe(true);
    });
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(SESSION_ID);
    // Reattached rather than started over.
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("starts a fresh session when retrying after a failed connect", async () => {
    // A cold-init failure is not transient: nothing was ever connected, so the
    // full reset stays in place.
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    mockGetCodexServerStatus.mockRejectedValueOnce(new Error("container bridge unavailable"));

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByText("container bridge unavailable")).toBeTruthy();

    mockCreateSession.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
  });

  test("queues prompts with a generated UUID", async () => {
    composeText = "Queue this prompt";
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("codex-queue"));
    await waitFor(() => {
      const queued = useCodexStore.getState().messageQueue.get(SESSION_KEY)?.[0];
      expect(queued?.text).toBe(composeText);
      expect(queued?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(queued?.requestId).toBe(queued?.id);
    });
  });

  test("centers the compose bar with the ready title until message history exists", async () => {
    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByText("Ready to build!")).toBeTruthy();
    expect(screen.getByTestId("codex-compose-layout").textContent).toBe("centered");

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(screen.getByTestId("codex-compose-layout").textContent).toBe("bottom");
    });
  });

  test("shows the scroll down accessory and scrolls to the bottom when clicked", () => {
    mockIsAtBottom = false;
    seedCodexStore([createMessage("message-1", "Existing response")]);

    render(
      <CodexChatTab
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

  test("keeps active subagents inline at their transcript position", async () => {
    const activeMessage: TestCodexMessage = {
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
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    const laterMessage = createMessage("assistant-later", "Later response");

    seedCodexStore([activeMessage, laterMessage]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
      "assistant-agent",
      "assistant-later",
    ]);
    expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
      "text",
      "subagent",
      "text",
    ]);

    const completedMessage: TestCodexMessage = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "subagent"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      seedCodexStore([completedMessage, laterMessage]);
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

  test("groups adjacent streaming subagents without moving them out of the message", () => {
    const activeMessage: TestCodexMessage = {
      id: "assistant-agent-group",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "Delegating" },
        {
          type: "subagent",
          content: "First worker",
          subagentId: "agent-1",
          subagentName: "First worker",
          toolState: "pending",
          subagentActions: [],
        },
        {
          type: "subagent",
          content: "Second worker",
          subagentId: "agent-2",
          subagentName: "Second worker",
          toolState: "pending",
          subagentActions: [],
        },
        { type: "text", content: "Parent continues" },
      ],
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    seedCodexStore([activeMessage]);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    expect(lastVirtualizedMessages).toHaveLength(1);
    expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
      "text",
      "agent-group",
      "text",
    ]);
    expect(lastVirtualizedMessages[0]?.parts[1].parts.map((part: any) => part.subagentId)).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  test("applies direct SSE message updates only to the current session", async () => {
    const currentMessage = createMessage("current-event", "Current session event");
    const foreignMessage = createMessage("foreign-event", "Foreign session event");
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield { type: "message.updated", sessionId: "other-session", data: { message: foreignMessage } };
      yield { type: "message.updated", sessionId: SESSION_ID, data: { message: currentMessage } };
      yield { type: "session.error", sessionId: SESSION_ID, data: { error: "turn failed" } };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      const state = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(state?.messages.map((message) => message.id)).toEqual(["current-event"]);
      expect(state?.error).toBe("turn failed");
      expect(state?.isLoading).toBe(false);
    });
  });

  test("skips malformed SSE events and refreshes fallback updates, titles, and generic errors", async () => {
    const refreshedMessage = createMessage("fallback-event", "Fetched after sparse event");
    const originalWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn as unknown as typeof console.warn;
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockGetSessionMessages.mockResolvedValue([refreshedMessage]);
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield null;
      yield { type: "message.updated", sessionId: SESSION_ID, data: {} };
      yield { type: "session.updated", sessionId: SESSION_ID, data: {} };
      yield { type: "session.title-updated", sessionId: SESSION_ID, data: { title: "  Event title  " } };
      yield { type: "session.error", sessionId: SESSION_ID, data: {} };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        const state = useCodexStore.getState().sessions.get(SESSION_KEY);
        expect(state?.messages).toEqual([refreshedMessage]);
        expect(state?.title).toBe("  Event title  ");
        expect(state?.error).toBe("Codex session failed");
      });
      expect(warn).toHaveBeenCalledWith("[CodexChatTab] Received malformed event, skipping");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("session idle SSE refreshes the transcript and adopts a non-empty title", async () => {
    const finalMessage = createMessage("idle-message", "Turn completed");
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockGetSessionMessages.mockResolvedValue([finalMessage]);
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield { type: "session.idle", sessionId: SESSION_ID, data: { title: "Completed turn" } };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    useCodexStore.getState().setSessionError(SESSION_KEY, "old error");

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [finalMessage],
        title: "Completed turn",
        isLoading: false,
      });
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error).toBeUndefined();
      expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
    });
  });

  test("subscribes to events for the current session and follows a session switch", async () => {
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    mockSubscribeToEvents.mockImplementation(
      (_client: unknown, signal?: AbortSignal) => (async function* () {
        if (!signal) return;
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })(),
    );
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
    expect(mockSubscribeToEvents.mock.calls[0]?.[3]).toBe(SESSION_ID);

    const switchedSessionId = "session-2";
    act(() => {
      useCodexStore.getState().setSession(SESSION_KEY, {
        sessionId: switchedSessionId,
        messages: [],
        isLoading: true,
        title: "Switched session",
      });
    });

    await waitFor(() => {
      expect(
        mockSubscribeToEvents.mock.calls.some((call) => call[3] === switchedSessionId),
      ).toBe(true);
    });
  });

  test("uses a cursor-only frame as the reconnect revision without changing session state", async () => {
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    mockSubscribeToEvents
      .mockImplementationOnce(() => (async function* () {
        yield { type: "bridge.cursor", data: {}, revision: 41 };
      })() as any)
      .mockImplementation(
        (_client: unknown, signal?: AbortSignal) => (async function* () {
          if (!signal) return;
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      );
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(
      () => expect(mockSubscribeToEvents.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 3_000 },
    );
    expect(mockSubscribeToEvents.mock.calls[1]?.[2]).toBe(41);
    expect(mockSubscribeToEvents.mock.calls[1]?.[3]).toBe(SESSION_ID);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      sessionId: SESSION_ID,
      messages: [],
      isLoading: true,
    });
  });

  test("reconciles an authoritative error and refreshes its final transcript", async () => {
    const finalMessage = createMessage("failed-turn-message", "Partial response before failure");
    mockGetSessionStatus.mockResolvedValue({
      status: "error",
      phase: "failed",
      title: "Failed turn",
      error: "Tool execution failed",
    });
    mockGetSessionMessages.mockResolvedValue([finalMessage]);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [finalMessage],
        title: "Failed turn",
        isLoading: false,
        error: "Tool execution failed",
      });
    });
    expect(mockGetSessionMessages).toHaveBeenCalledWith(
      MOCK_CLIENT,
      SESSION_ID,
      expect.objectContaining({ throwOnError: undefined }),
    );
    expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
  });

  test("a deferred running reconcile cannot overwrite a newer idle SSE event", async () => {
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let resolveLookup!: (result: CodexSessionStatusLookupResult) => void;
    const deferredLookup = new Promise<CodexSessionStatusLookupResult>((resolve) => {
      resolveLookup = resolve;
    });
    mockLookupSessionStatus.mockImplementationOnce(() => {
      markLookupStarted();
      return deferredLookup;
    });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      await lookupStarted;
      yield {
        type: "session.idle",
        sessionId: SESSION_ID,
        data: { title: "Authoritative idle title" },
      };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    useCodexStore.getState().setSessionPhase(SESSION_KEY, "recovering");

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      const state = useCodexStore.getState();
      expect(state.sessions.get(SESSION_KEY)).toMatchObject({
        isLoading: false,
        title: "Authoritative idle title",
      });
      expect(state.sessionPhase.has(SESSION_KEY)).toBe(false);
    });

    await act(async () => {
      resolveLookup({
        kind: "found",
        session: {
          status: "running",
          phase: "recovering",
          title: "Stale running title",
        },
      });
      await deferredLookup;
    });

    const state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)).toMatchObject({
      isLoading: false,
      title: "Authoritative idle title",
    });
    expect(state.sessionPhase.has(SESSION_KEY)).toBe(false);
  });

  test("a bridge-wide connected frame does not invalidate a pending reconcile", async () => {
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let markConnectedSent!: () => void;
    const connectedSent = new Promise<void>((resolve) => {
      markConnectedSent = resolve;
    });
    let resolveLookup!: (result: CodexSessionStatusLookupResult) => void;
    const deferredLookup = new Promise<CodexSessionStatusLookupResult>((resolve) => {
      resolveLookup = resolve;
    });
    mockLookupSessionStatus.mockImplementationOnce(() => {
      markLookupStarted();
      return deferredLookup;
    });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      await lookupStarted;
      yield { type: "connected", data: {}, revision: 41 };
      markConnectedSent();
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
    await connectedSent;

    await act(async () => {
      resolveLookup({
        kind: "found",
        session: {
          status: "idle",
          phase: "idle",
          title: "Reconciled after connected",
        },
      });
      await deferredLookup;
    });

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        isLoading: false,
        title: "Reconciled after connected",
      });
    });
  });

  test("applies running SSE phases and clears them on terminal events", async () => {
    let finishTurn!: () => void;
    const finishTurnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield {
        type: "session.updated",
        sessionId: SESSION_ID,
        data: { status: "running", phase: "cancelling" },
      };
      await finishTurnPromise;
      yield { type: "session.idle", sessionId: SESSION_ID, data: {} };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("cancelling");
      expect(screen.getByText("Stopping…")).toBeTruthy();
    });

    finishTurn();
    await waitFor(() => {
      expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
      expect(screen.queryByText("Stopping…")).toBeNull();
    });
  });

  test("keeps existing approvals when snapshot rehydration fails", async () => {
    const existing = createApproval("existing-approval");
    useCodexStore.getState().addPendingApproval(SESSION_KEY, existing);
    mockFetchPendingApprovals.mockRejectedValue(new Error("approval endpoint offline"));

    const originalError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockFetchPendingApprovals).toHaveBeenCalled());
      expect(
        useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((item) => item.approvalId),
      ).toEqual(["existing-approval"]);
    } finally {
      console.error = originalError;
    }
  });

  test("does not let a stale approval snapshot overwrite a newer SSE approval", async () => {
    let resolveSnapshot!: (approvals: CodexApproval[]) => void;
    const snapshot = new Promise<CodexApproval[]>((resolve) => {
      resolveSnapshot = resolve;
    });
    const liveApproval = createApproval("live-approval");
    mockFetchPendingApprovals.mockImplementationOnce(() => snapshot);
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield {
        type: "session.approval-requested",
        sessionId: SESSION_ID,
        data: { approval: liveApproval },
      };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
    await waitFor(() => {
      expect(
        useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((item) => item.approvalId),
      ).toEqual(["live-approval"]);
    });

    resolveSnapshot([]);
    await act(async () => {
      await snapshot;
    });
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((item) => item.approvalId),
    ).toEqual(["live-approval"]);
  });

  test("reconciles the session after an SSE subscription failure", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockGetSessionStatus.mockResolvedValue({ status: "idle", title: "Recovered title" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      throw new Error("event stream closed");
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[CodexChatTab] Event subscription error:",
          expect.any(Error),
        );
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.title).toBe("Recovered title");
      });
    } finally {
      console.error = originalError;
    }
  });

  test("force-refreshes authoritative state when SSE replay is unavailable", async () => {
    const reconciledMessage = createMessage("reconciled-message", "Recovered from replay gap");
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "recovering" });
    mockGetSessionMessages.mockResolvedValue([reconciledMessage]);
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield {
        type: "session.reconcile-required",
        data: {},
        revision: 42,
      };
      yield { type: "session.error", sessionId: SESSION_ID, data: { error: "done" } };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
        reconciledMessage,
      ]);
      expect(mockGetSessionMessages).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        expect.objectContaining({ throwOnError: undefined }),
      );
    });
  });

  test("watchdog refreshes a loading turn after activity becomes stale", async () => {
    installTimerHarness(10_000);
    let finishEvents!: () => void;
    const finishPromise = new Promise<void>((resolve) => {
      finishEvents = resolve;
    });
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      await finishPromise;
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
    await waitFor(() => expect(mockGetSessionStatus).toHaveBeenCalled());
    mockGetSessionStatus.mockClear();
    mockLookupSessionStatus.mockClear();
    mockGetSessionMessages.mockClear();

    mockedNow = 11_600;
    act(() => intervalCallback?.());

    await waitFor(() => {
      expect(mockLookupSessionStatus).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);
    });
    finishEvents();
  });

  test("Escape aborts only an active foreground turn without modifiers", async () => {
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    fireEvent.keyDown(window, { key: "Escape", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Escape", altKey: true });
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    const preventedEvent = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    preventedEvent.preventDefault();
    window.dispatchEvent(preventedEvent);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(mockAbortSession).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID));
  });

  test("enables the review follow-up action after a review session has messages", () => {
    seedCodexStore([createMessage("message-1", "Review complete")]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
      />,
    );

    expect(screen.getByTestId("codex-address-all-state").textContent).toBe("shown");
  });

  test("sends a normal review as Markdown without a structured output schema", async () => {
    const reviewPrompt = "## Review Scope\n\nReturn the review in Markdown.";
    seedPaneLayout(reviewPrompt);

    render(
      <CodexChatTab
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

  test("does not show plan approval for a non-plan assistant message after entering plan mode", () => {
    seedCodexStore([createMessage("build-message", "Implementation finished")]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("shows plan approval after a completed plan-review assistant message", () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Inspect the current flow", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    const planCard = screen.getByTestId("codex-plan-mode-card");
    const composeDock = screen.getByTestId("codex-compose-layout").closest('[data-testid="compose-dock"]');
    expect(composeDock?.contains(planCard)).toBe(true);
  });

  test("approves a reviewed plan by switching mode and sending the implementation prompt", async () => {
    seedEnvironment("review-table");
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Implement the requested change", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("codex-plan-approve"));

    await waitFor(() => {
      expect(mockUpdateSessionConfig).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        expect.objectContaining({ mode: "build" }),
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "The plan is approved. Exit plan mode and implement it.",
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });
    expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("build");
    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("does not send an approval when switching the reviewed plan to build fails", async () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Implement the requested change", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));
    mockUpdateSessionConfig.mockResolvedValue(false);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("codex-plan-approve"));

    await waitFor(() => expect(mockUpdateSessionConfig).toHaveBeenCalled());
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("plan");
  });

  test("does not show plan approval for an empty plan-review assistant message", () => {
    seedCodexStore([
      createMessage("empty-plan-message", "", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("does not show plan approval while the session has an error", () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Inspect the current flow", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => {
      const session = state.sessions.get(SESSION_KEY)!;
      return {
        selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...session,
          error: "Codex session failed",
        }),
      };
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("keeps a plan review dismissed after manually switching to build and back to plan", async () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Inspect the current flow", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByTestId("codex-plan-mode-card")).toBeTruthy();

    fireEvent.click(screen.getByTestId("codex-mode-build"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("build");
    });

    fireEvent.click(screen.getByTestId("codex-mode-plan"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("plan");
    });
    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("skips renaming when the environment already has a non-timestamp name", async () => {
    composeText = "Add pagination to the review table";
    seedEnvironment("review-table");

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    expect(mockRenameEnvironmentFromPrompt).not.toHaveBeenCalled();
  });

  test("renames compact Electron timestamp environments on the first prompt", async () => {
    composeText = "Add pagination to the review table";
    seedEnvironment("202604151234567");

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalled();
    });
  });

  test("continues sending the prompt when renaming fails", async () => {
    composeText = "Investigate the failing setup flow";
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {
      throw new Error("rename failed");
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
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
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const messages =
        useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(
        messages.some((message) => message.content === composeText),
      ).toBe(true);
      expect(
        messages.some((message) => message.content === "Naming environment..."),
      ).toBe(true);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    resolveRename?.();

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });

    await waitFor(() => {
      const messages =
        useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(
        messages.some((message) => message.content === "Naming environment..."),
      ).toBe(false);
    });
  });

  test("auto-sends initialPrompt through the same rename path and clears it from pane state", async () => {
    const initialPrompt = "Set up the environment for release automation";
    seedPaneLayout(initialPrompt);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        initialPrompt,
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        initialPrompt,
        expect.objectContaining({
          attachments: undefined,
          requestId: `initial-prompt:${ENVIRONMENT_ID}:${TAB_ID}`,
        }),
      );
    });

    await waitFor(() => {
      const pane = usePaneLayoutStore.getState().findPaneWithTab(TAB_ID, ENVIRONMENT_ID);
      const tab = pane?.tabs.find((candidate) => candidate.id === TAB_ID);
      expect(tab?.initialPrompt).toBeUndefined();
    });
  });

  test("keeps the durable initial prompt until dispatch is accepted and retries it with the same id after remount", async () => {
    const initialPrompt = "Recover this launch after a renderer crash";
    seedPaneLayout(initialPrompt);
    let resolveFirstDispatch: ((value: { status: "processing" }) => void) | undefined;
    mockSendPrompt
      .mockImplementationOnce(
        async () => new Promise<{ status: "processing" }>((resolve) => {
          resolveFirstDispatch = resolve;
        }),
      )
      .mockResolvedValueOnce({ status: "processing" });

    const first = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
    let pane = usePaneLayoutStore.getState().findPaneWithTab(TAB_ID, ENVIRONMENT_ID);
    expect(pane?.tabs.find((tab) => tab.id === TAB_ID)?.initialPrompt).toBe(initialPrompt);

    first.unmount();
    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));
    const firstRequestId = (mockSendPrompt.mock.calls[0]?.[3] as { requestId?: string }).requestId;
    const secondRequestId = (mockSendPrompt.mock.calls[1]?.[3] as { requestId?: string }).requestId;
    expect(firstRequestId).toBe(`initial-prompt:${ENVIRONMENT_ID}:${TAB_ID}`);
    expect(secondRequestId).toBe(firstRequestId);

    await waitFor(() => {
      pane = usePaneLayoutStore.getState().findPaneWithTab(TAB_ID, ENVIRONMENT_ID);
      expect(pane?.tabs.find((tab) => tab.id === TAB_ID)?.initialPrompt).toBeUndefined();
    });

    resolveFirstDispatch?.({ status: "processing" });
  });

  test("retains a rejected initial prompt and caps its automatic retry", async () => {
    const initialPrompt = "Do not lose this rejected launch";
    seedPaneLayout(initialPrompt);
    mockSendPrompt.mockResolvedValue({ outcome: "rejected", httpStatus: 503 });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(mockSendPrompt).toHaveBeenCalledTimes(2);
    const pane = usePaneLayoutStore.getState().findPaneWithTab(TAB_ID, ENVIRONMENT_ID);
    expect(pane?.tabs.find((tab) => tab.id === TAB_ID)?.initialPrompt).toBe(initialPrompt);
  });

  test("clears a matching unconfirmed dispatch after the durable initial prompt is accepted", async () => {
    const initialPrompt = "Reconcile this launch";
    const requestId = `initial-prompt:${ENVIRONMENT_ID}:${TAB_ID}`;
    seedPaneLayout(initialPrompt);
    useCodexStore.setState((state) => ({
      ...state,
      unconfirmedDispatches: new Map([
        [SESSION_KEY, {
          userMessageId: "optimistic-before-remount",
          fingerprint: "initial-prompt",
          requestId,
        }],
      ]),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        initialPrompt,
        expect.objectContaining({ requestId }),
      );
      expect(useCodexStore.getState().unconfirmedDispatches.has(SESSION_KEY)).toBe(false);
    });
  });

  test("initializes and sends initialPrompt while the Codex tab is inactive", async () => {
    const initialPrompt = "Run the background setup audit";
    seedPaneLayout(initialPrompt);
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        initialPrompt,
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });
  });

  test("uses one-shot review model and effort when creating a native session", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
      selectedReasoningEffort: new Map(),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="gpt-5.4-codex"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
    expect(lastCall?.[1]).toMatchObject({
      model: "gpt-5.4-codex",
      modelReasoningEffort: "high",
    });
  });

  test("does not reapply one-shot review options after the tab remounts", async () => {
    const firstMount = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="gpt-5.4-codex"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe("gpt-5.4-codex");
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("high");
    });
    useCodexStore.getState().setSelectedModel(SESSION_KEY, "gpt-5.3-codex");
    useCodexStore.getState().setSelectedReasoningEffort(SESSION_KEY, "medium");
    firstMount.unmount();

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe("gpt-5.3-codex");
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("medium");
    });
  });

  test("falls back from stale one-shot Codex preferences during session creation", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
      selectedReasoningEffort: new Map(),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="removed-codex-model"
        initialReasoningEffort="ultra"
      />,
    );

    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
    expect(lastCall?.[1]).toMatchObject({
      model: MOCK_MODELS[0]!.id,
      modelReasoningEffort: "medium",
    });
  });

  test("initializes and drains a queued prompt while the Codex tab is inactive", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run the hidden queued Codex prompt",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "Run the hidden queued Codex prompt",
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });
  });

  test("waits for setup readiness before draining a queued prompt while inactive", async () => {
    useEnvironmentStore.setState({
      workspaceReadyEnvironments: new Set(),
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run after Codex setup",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockSendPrompt).not.toHaveBeenCalled();

    act(() => {
      useEnvironmentStore.setState({
        workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
      });
    });

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "Run after Codex setup",
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });
  });

  test("starts the SSE event subscription while the Codex tab is inactive but loading", async () => {
    seedCodexStore();
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });
  });

  test("only renames on the first prompt once the session has messages", async () => {
    mockGetSessionMessages.mockImplementation(async () => [createMessage("assistant-1", "Ready")]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    composeText = "First prompt";
    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledTimes(1);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages?.some((message) => message.content === "First prompt")).toBe(true);
    });

    composeText = "Second prompt";
    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledTimes(2);
    });

    expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledTimes(1);
  });

  test("keeps the optimistic first prompt visible until Codex returns messages", async () => {
    composeText = "Investigate why the first message disappears";
    mockGetSessionMessages.mockImplementation(async () => []);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
      );
    });

    await waitFor(() => {
      const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.role === "user" && message.content === composeText)).toBe(true);
    });
  });

  test("removes the optimistic prompt when Codex fails to send it", async () => {
    composeText = "This should not stick around";
    mockSendPrompt.mockImplementation(async () => null);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.messages.some((message) => message.content === composeText)).toBe(false);
      expect(session?.error).toBe("Failed to send prompt");
    });
  });

  test("keeps the turn locked when prompt acceptance is ambiguous and status is unavailable", async () => {
    composeText = "Do not overlap this turn";
    mockSendPrompt.mockResolvedValue({
      outcome: "unknown",
      requestId: "ambiguous-request",
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());
    mockLookupSessionStatus.mockResolvedValue({
      kind: "unavailable",
      error: new Error("offline"),
    });

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(true);
      expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("recovering");
    });
    expect(screen.getByTestId("codex-stop")).toBeTruthy();
    expect(screen.getByText("Reconnecting to Codex…")).toBeTruthy();
  });

  test("withdraws the prompt when an ambiguous send is proven not to have landed", async () => {
    composeText = "This prompt never reached Codex";
    mockSendPrompt.mockResolvedValue({
      outcome: "unknown",
      requestId: "ambiguous-request",
    });
    // Authoritative idle with a transcript that does not contain the prompt.
    mockLookupSessionStatus.mockResolvedValue({
      kind: "found",
      session: { status: "idle", title: "Idle" },
    });
    mockGetSessionMessages.mockResolvedValue([]);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.error).toBe(
        "Could not confirm whether Codex received the prompt. You can send it again safely.",
      );
      expect(session?.isLoading).toBe(false);
      // The local-only user message must not survive as something Codex saw.
      expect(session?.messages.some((message) => message.role === "user")).toBe(false);
    });
    expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBeUndefined();
  });

  test("keeps an ambiguous prompt locked when its reconcile is superseded", async () => {
    /**
     * A concurrent reconcile can win the sequence race, leaving the send path
     * with a "stale" result it cannot act on. The turn must stay locked — the
     * bridge may be running it — and the unconfirmed prompt is settled later by
     * whichever path next sees an authoritative idle session.
     */
    composeText = "Superseded reconcile";
    mockSendPrompt.mockResolvedValue({
      outcome: "unknown",
      requestId: "ambiguous-request",
    });
    mockLookupSessionStatus.mockResolvedValue({
      kind: "found",
      session: { status: "running", title: "Still running" },
    });

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      // Never unlocked on an unproven dispatch.
      expect(session?.isLoading).toBe(true);
    });
    expect(screen.getByTestId("codex-stop")).toBeTruthy();
  });

  test("settles an unresolved ambiguous prompt when recovery reports idle later", async () => {
    /**
     * Regression: when the send path's own reconcile could not conclude, nothing
     * resolved the optimistic message. A later watchdog reconcile unlocked the
     * session and cleared the error, leaving a user message in the transcript
     * that Codex had never received.
     */
    composeText = "Lost during a bridge restart";
    mockSendPrompt.mockResolvedValue({
      outcome: "unknown",
      requestId: "ambiguous-request",
    });

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());
    mockLookupSessionStatus.mockResolvedValue({
      kind: "unavailable",
      error: new Error("offline"),
    });

    fireEvent.click(screen.getByTestId("codex-send"));
    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    });

    // The bridge comes back and is authoritatively idle without the prompt.
    mockGetSessionMessages.mockResolvedValue([]);
    mockLookupSessionStatus.mockResolvedValue({
      kind: "found",
      session: { status: "idle", title: "Recovered" },
    });

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(false);
      expect(session?.error).toBe(
        "Could not confirm whether Codex received the prompt. You can send it again safely.",
      );
      expect(session?.messages.some((message) => message.role === "user")).toBe(false);
    }, { timeout: 5_000 });
  });

  test("surfaces the HTTP status when the bridge definitively rejects a prompt", async () => {
    composeText = "Rejected outright";
    mockSendPrompt.mockResolvedValue({ outcome: "rejected", httpStatus: 409 });

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.error).toBe("Failed to send prompt (HTTP 409)");
      // A definite rejection proves no turn started, so the composer unlocks.
      expect(session?.isLoading).toBe(false);
    });
  });

  test("reuses the idempotency key when the same failed prompt is retried", async () => {
    composeText = "Retry this exact prompt";
    mockSendPrompt
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ status: "processing" }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("codex-send"));
    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));

    const firstOptions = (mockSendPrompt.mock.calls[0] as unknown as unknown[])[3] as {
      requestId: string;
    };
    const secondOptions = (mockSendPrompt.mock.calls[1] as unknown as unknown[])[3] as {
      requestId: string;
    };
    expect(firstOptions.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondOptions.requestId).toBe(firstOptions.requestId);
  });

  test("includes attachment parts in the optimistic prompt", async () => {
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
    mockGetSessionMessages.mockImplementation(async () => []);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
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
  });

  test("renders timer states from the real elapsed timer hook", async () => {
    installTimerHarness(1_000_000);
    act(() => {
      useCodexStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...state.sessions.get(SESSION_KEY)!,
          isLoading: true,
        }),
      }));
    });

    const { container } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();

    mockedNow = 1_000_999;
    act(() => {
      intervalCallback?.();
    });

    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText("Codex is thinking...")).not.toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();

    // Both status states share a fixed-height row so the end-of-turn swap
    // does not shift the transcript above it.
    const thinkingRow = container.querySelector(".chat-status-row");
    expect(thinkingRow?.textContent).toContain("Codex is thinking...");
    expect(thinkingRow?.parentElement?.className).not.toContain("py-");

    mockedNow = 1_001_500;
    act(() => {
      intervalCallback?.();
    });

    await waitFor(() => {
      expect(screen.queryByText("1s")).not.toBeNull();
    });

    act(() => {
      useCodexStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...state.sessions.get(SESSION_KEY)!,
          isLoading: false,
        }),
      }));
    });

    await waitFor(() => {
      expect(screen.queryByText("Codex is thinking...")).toBeNull();
      expect(screen.queryByText("Completed in 1s")).not.toBeNull();
    });

    const completedRows = container.querySelectorAll(".chat-status-row");
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0]?.textContent).toContain("Completed in 1s");
    expect(completedRows[0]?.parentElement?.className).not.toContain("py-");

    expect(clearIntervalCalls).toBeGreaterThan(0);

    mockedNow = 1_002_000;
    act(() => {
      useCodexStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...state.sessions.get(SESSION_KEY)!,
          isLoading: true,
        }),
      }));
    });

    await waitFor(() => {
      expect(screen.queryByText(/Completed in/)).toBeNull();
      expect(screen.queryByText("Codex is thinking...")).not.toBeNull();
    });
  });

  test("drains queued prompts when the session is idle", async () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Handle the queued codex prompt",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "Handle the queued codex prompt",
        expect.objectContaining({ attachments: undefined, requestId: "queue-1" }),
      );
    });
  });

  test("removes a queued prompt and logs an error when queued send throws", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    seedEnvironment("review-table");
    mockSendPrompt.mockImplementation(async () => {
      throw new Error("bridge offline");
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued Codex failure",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    try {
      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          SESSION_ID,
          "Queued Codex failure",
          expect.objectContaining({ attachments: undefined, requestId: expect.any(String) }),
        );
      });

      await waitFor(() => {
        const state = useCodexStore.getState();
        expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(state.messageQueue.get(SESSION_KEY)).toEqual([]);
        expect(consoleError).toHaveBeenCalledWith(
          "[CodexChatTab] Failed to send queued prompt:",
          expect.any(Error),
        );
      });
    } finally {
      console.error = originalError;
    }
  });

  test("does not drain queued prompts while a draft exists", async () => {
    seedEnvironment("review-table");
    useCodexStore.getState().setDraftText(SESSION_KEY, "Keep this Codex draft");
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind Codex draft",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useCodexStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.draftText.get(SESSION_KEY)).toBe("Keep this Codex draft");
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind Codex draft",
    ]);
  });

  test("does not drain queued prompts while an attachment is staged", async () => {
    seedEnvironment("review-table");
    useCodexStore.getState().addAttachment(SESSION_KEY, {
      id: "staged-attachment",
      type: "image" as const,
      path: "/workspace/staged.png",
      previewUrl: "data:image/png;base64,staged",
      name: "staged.png",
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind Codex attachment",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useCodexStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.attachments.get(SESSION_KEY)?.map((attachment) => attachment.name)).toEqual([
      "staged.png",
    ]);
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind Codex attachment",
    ]);
  });

  test("stop stays loading while accepted cancellation completes and promotes the queue", async () => {
    const queuedAttachment = {
      id: "queued-attachment",
      type: "image" as const,
      path: "/workspace/queued.png",
      previewUrl: "data:image/png;base64,queued",
      name: "queued.png",
    };

    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued prompt",
      attachments: [queuedAttachment],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued prompt",
      attachments: [],
      model: MOCK_MODELS[1]?.id ?? MOCK_MODELS[0]!.id,
      mode: "plan",
      reasoningEffort: "high",
      fastMode: true,
    });

    let resolveAbort: ((value: CodexAbortOutcome) => void) | undefined;
    mockAbortSession.mockImplementation(
      () =>
        new Promise<CodexAbortOutcome>((resolve) => {
          resolveAbort = resolve;
        }),
    );

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-stop"));

    await waitFor(() => {
      const state = useCodexStore.getState();
      expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      expect(state.sessionPhase.get(SESSION_KEY)).toBe("cancelling");
      expect(state.draftText.get(SESSION_KEY)).toBe("Queued prompt");
      expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
        "Second queued prompt",
      ]);
      expect(state.attachments.get(SESSION_KEY)).toEqual([queuedAttachment]);
      expect(state.selectedModel.get(SESSION_KEY)).toBe(MOCK_MODELS[0]!.id);
      expect(state.selectedMode.get(SESSION_KEY)).toBe("build");
      expect(state.selectedReasoningEffort.get(SESSION_KEY)).toBe("medium");
      expect(state.fastMode.get(SESSION_KEY)).toBe(false);
    });
    expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);

    resolveAbort?.({ status: "accepted" });
  });

  test("writes the stop marker once the interrupted turn settles", async () => {
    // Authoritative status stays running so only the explicit flip below can
    // settle the turn — `turn/interrupt` is asynchronous, so the marker is
    // written when the turn actually ends, not when the request is accepted.
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    mockAbortSession.mockImplementation(async () => ({ status: "accepted" as const }));
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    fireEvent.click(screen.getByTestId("codex-stop"));
    await waitFor(() => expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID));
    expect(hasStopMarker()).toBe(false);

    act(() => {
      useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
    });

    expect(hasStopMarker()).toBe(true);
  });

  test("drops a pending stop marker when the session identity changes first", async () => {
    // Stopping a turn and then resuming a different thread before the interrupt
    // settles must not append the marker to the thread the user never stopped.
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
    mockAbortSession.mockImplementation(async () => ({ status: "accepted" as const }));
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    fireEvent.click(screen.getByTestId("codex-stop"));
    await waitFor(() => expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID));
    expect(hasStopMarker()).toBe(false);

    act(() => {
      useCodexStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-2",
        messages: [],
        isLoading: true,
        title: "Resumed elsewhere",
      });
    });

    act(() => {
      useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
    });

    expect(hasStopMarker()).toBe(false);
  });

  test("a rejected abort remains locked when status cannot be reconciled", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockAbortSession.mockImplementation(async () => ({
      status: "rejected",
      httpStatus: 409,
    }));
    mockGetSessionStatus
      .mockResolvedValueOnce({ status: "running", phase: "running" })
      .mockResolvedValue(null);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    useCodexStore.getState().setSessionError(SESSION_KEY, "Previous error");

    try {
      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("codex-stop"));

      await waitFor(() => {
        const session = useCodexStore.getState().sessions.get(SESSION_KEY);
        expect(session?.isLoading).toBe(true);
        expect(session?.error).toBeUndefined();
        expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("cancelling");
        expect(consoleError).toHaveBeenCalledWith(
          "[CodexChatTab] Abort request was rejected with HTTP 409",
        );
      });
    } finally {
      console.error = originalError;
    }
  });

  test("a rejected abort does not unlock while authoritative status is still running", async () => {
    const originalError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
    mockAbortSession.mockResolvedValue({ status: "rejected", httpStatus: 409 });
    mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "recovering" });
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      fireEvent.click(screen.getByTestId("codex-stop"));

      await waitFor(() => {
        expect(mockAbortSession).toHaveBeenCalled();
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
        expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("recovering");
      });
    } finally {
      console.error = originalError;
    }
  });

  test("an ambiguous abort keeps the composer locked when status cannot be reconciled", async () => {
    const originalError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
    mockAbortSession.mockResolvedValue({ status: "unknown" });
    mockGetSessionStatus.mockResolvedValue(null);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      fireEvent.click(screen.getByTestId("codex-stop"));

      await waitFor(() => expect(mockAbortSession).toHaveBeenCalled());
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("cancelling");
    } finally {
      console.error = originalError;
    }
  });

  test("an ambiguous abort unlocks when status authoritatively reports the session missing", async () => {
    const originalError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
    mockAbortSession.mockResolvedValue({ status: "unknown" });
    mockLookupSessionStatus.mockResolvedValue({ kind: "missing" });
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      fireEvent.click(screen.getByTestId("codex-stop"));

      await waitFor(() => {
        expect(mockAbortSession).toHaveBeenCalled();
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
      });
    } finally {
      console.error = originalError;
    }
  });

  test("an ambiguous abort unlocks after authoritative idle reconciliation", async () => {
    const originalError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
    mockAbortSession.mockResolvedValue({ status: "unknown" });
    mockGetSessionStatus.mockResolvedValue({ status: "idle", phase: "idle" });
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      fireEvent.click(screen.getByTestId("codex-stop"));

      await waitFor(() => {
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
      });
    } finally {
      console.error = originalError;
    }
  });

  test("persists accepted model and reasoning changes as global Codex defaults", async () => {
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    fireEvent.click(screen.getByTestId("codex-model-change"));
    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe("gpt-5.4-codex");
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("high");
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(expect.objectContaining({
        codexModel: "gpt-5.4-codex",
        codexReasoningEffort: "high",
      }));
    });

    fireEvent.click(screen.getByTestId("codex-effort-change"));
    await waitFor(() => {
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("low");
      expect(mockUpdateGlobalConfig).toHaveBeenLastCalledWith(expect.objectContaining({
        codexModel: "gpt-5.4-codex",
        codexReasoningEffort: "low",
      }));
    });
  });

  test("keeps an applied model change and warns when it was not persisted durably", async () => {
    mockUpdateSessionConfig.mockResolvedValue({
      outcome: "applied",
      durable: false,
    });
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    fireEvent.click(screen.getByTestId("codex-model-change"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe("gpt-5.4-codex");
      expect(mockToastWarning).toHaveBeenCalledWith(
        "Codex settings were applied but not saved",
        { description: "They may revert if the Codex bridge restarts." },
      );
    });
  });

  test("rolls back rejected model changes and keeps the previous persisted defaults", async () => {
    mockUpdateSessionConfig.mockResolvedValue(false);
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("codex-model-change"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe(MOCK_MODELS[0]!.id);
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("medium");
    });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error).toBe(
      "Failed to update Codex session settings",
    );
  });

  test("rolls back a rejected reasoning-effort change", async () => {
    mockUpdateSessionConfig.mockResolvedValue({
      outcome: "rejected",
      httpStatus: 409,
    });
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("codex-effort-change"));

    await waitFor(() => {
      expect(mockUpdateSessionConfig).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        expect.objectContaining({ modelReasoningEffort: "low" }),
      );
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe(
        "medium",
      );
    });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error).toBe(
      "Failed to update Codex session settings (HTTP 409)",
    );
  });

  describe("prompt idempotency keys", () => {
    /** The options bag the send path passed on a given call. */
    function sentOptions(callIndex: number): { requestId?: string } {
      return (mockSendPrompt.mock.calls[callIndex]?.[3] ?? {}) as { requestId?: string };
    }

    test("rotates the key when the retried prompt is a different one", async () => {
      // The stored key only makes a retry safe for the *same* logical prompt.
      // Reusing it for different text would make the bridge answer
      // `already-processed` for a prompt it has never seen.
      seedEnvironment("review-table");
      composeText = "Prompt A";
      mockSendPrompt
        .mockImplementationOnce(async () => null)
        .mockImplementation(async () => ({ status: "processing" }));

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));

      composeText = "Prompt B";
      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));

      expect(sentOptions(1).requestId).not.toBe(sentOptions(0).requestId);
      expect(sentOptions(1).requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("stops reusing a failed prompt's key once any send has succeeded", async () => {
      /**
       * The key used to be cleared only when the same request id came back, so a
       * key from one failed send outlived every later prompt. The bridge keeps a
       * terminal dispatch record for 24 hours, so re-sending that text would be
       * answered `already-processed` and silently dropped.
       */
      seedEnvironment("review-table");
      composeText = "yes";
      mockSendPrompt
        .mockImplementationOnce(async () => null)
        .mockImplementation(async () => ({ status: "processing" }));

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));

      composeText = "run the tests";
      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));

      composeText = "yes";
      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(3));

      expect(sentOptions(2).requestId).not.toBe(sentOptions(0).requestId);
    });

    test("clears the stored key when the turn reaches idle", async () => {
      seedEnvironment("review-table");
      composeText = "yes";
      mockSendPrompt
        .mockImplementationOnce(async () => null)
        .mockImplementation(async () => ({ status: "processing" }));
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield { type: "session.idle", sessionId: SESSION_ID, data: {} };
        await new Promise(() => {});
      })() as any);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
      // The failed send stored the key; the completed turn spends it.
      await waitFor(() =>
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false),
      );

      fireEvent.click(screen.getByTestId("codex-send"));
      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));
      expect(sentOptions(1).requestId).not.toBe(sentOptions(0).requestId);
    });

    test("does not leave a phantom turn when the bridge already ran the prompt", async () => {
      // `already-processed` is truthy, so it used to read as success: the
      // optimistic message stayed and the spinner waited for a turn that was
      // never going to start.
      seedEnvironment("review-table");
      composeText = "yes";
      mockSendPrompt.mockImplementation(async () => ({
        status: "already-processed",
        duplicate: true,
        requestId: "request-1",
      }));

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      fireEvent.click(screen.getByTestId("codex-send"));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("Codex had already run this prompt", {
          description: "It was not sent again. The transcript below is up to date.",
        });
      });
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(false);
      expect(session?.messages.some((message) => message.content === "yes")).toBe(false);
    });
  });

  describe("queue draining", () => {
    function queueEntry(overrides: { id: string; requestId?: string; text: string }) {
      return {
        attachments: [],
        model: MOCK_MODELS[0]!.id,
        mode: "build" as const,
        reasoningEffort: "medium" as const,
        fastMode: false,
        ...overrides,
      };
    }

    test("prefers a queued entry's persisted key over its row id", async () => {
      // The row id and the idempotency key are not the same thing: a queue entry
      // rewritten by a store migration must keep the key the bridge already knows.
      seedEnvironment("review-table");
      useCodexStore.getState().addToQueue(
        SESSION_KEY,
        queueEntry({ id: "row-1", requestId: "request-77", text: "Persisted key wins" }),
      );

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      await waitFor(() =>
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          SESSION_ID,
          "Persisted key wins",
          expect.objectContaining({ requestId: "request-77" }),
        ),
      );
    });

    test("drains two queued prompts in order, each with its own key", async () => {
      seedEnvironment("review-table");
      const store = useCodexStore.getState();
      store.addToQueue(SESSION_KEY, queueEntry({ id: "row-1", requestId: "request-1", text: "First queued" }));
      store.addToQueue(SESSION_KEY, queueEntry({ id: "row-2", requestId: "request-2", text: "Second queued" }));

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(2));
      expect(mockSendPrompt.mock.calls.map((call) => call[2])).toEqual([
        "First queued",
        "Second queued",
      ]);
      expect(mockSendPrompt.mock.calls.map((call) => call[3]?.requestId)).toEqual([
        "request-1",
        "request-2",
      ]);
      expect(useCodexStore.getState().messageQueue.get(SESSION_KEY) ?? []).toEqual([]);
    });

    test("does not drain while the bridge is still connecting", async () => {
      // No client means no session to send to; draining here would throw the
      // queued prompt away.
      seedEnvironment("review-table");
      useCodexStore.setState((state) => ({ ...state, clients: new Map(), sessions: new Map() }));
      mockGetCodexServerStatus.mockImplementation(() => new Promise(() => {}));
      useCodexStore.getState().addToQueue(
        SESSION_KEY,
        queueEntry({ id: "row-1", text: "Queued before connect" }),
      );

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(screen.getByText("Connecting to Codex...")).toBeTruthy();
      expect(mockSendPrompt).not.toHaveBeenCalled();
      expect(useCodexStore.getState().messageQueue.get(SESSION_KEY)).toHaveLength(1);
    });

    test("waits for the running turn to finish before draining", async () => {
      seedEnvironment("review-table");
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
      useCodexStore.getState().addToQueue(
        SESSION_KEY,
        queueEntry({ id: "row-1", requestId: "request-1", text: "Queued behind a turn" }),
      );

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();

      act(() => {
        useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
      });

      await waitFor(() =>
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          SESSION_ID,
          "Queued behind a turn",
          expect.objectContaining({ requestId: "request-1" }),
        ),
      );
    });

    test("a second mount cannot re-send the entry the first one is already sending", async () => {
      /**
       * Two mounts of the same tab (a background mount plus the visible one) both
       * see the queue. The re-entrancy guard and the atomic dequeue are what stop
       * one queued prompt from becoming two turns.
       */
      seedEnvironment("review-table");
      let releaseSend!: (value: CodexPromptAcceptedResponse) => void;
      mockSendPrompt.mockImplementation(
        () => new Promise<CodexPromptAcceptedResponse>((resolve) => {
          releaseSend = resolve;
        }),
      );
      useCodexStore.getState().addToQueue(
        SESSION_KEY,
        queueEntry({ id: "row-1", requestId: "request-1", text: "Only once" }),
      );

      render(
        <>
          <CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />
          <CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />
        </>,
      );

      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
      expect(useCodexStore.getState().messageQueue.get(SESSION_KEY) ?? []).toEqual([]);
      releaseSend({ status: "processing" });
    });

    test("a failed backend claim does not spin or dispatch the unclaimed prompt", async () => {
      mockClaimPromptQueueHead.mockRejectedValueOnce(new Error("claim unavailable"));
      useCodexStore.getState().addToQueue(
        SESSION_KEY,
        queueEntry({ id: "row-1", requestId: "request-1", text: "Keep queued" }),
      );

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

      await waitFor(() => expect(mockClaimPromptQueueHead).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(mockClaimPromptQueueHead).toHaveBeenCalledTimes(1);
      expect(mockSendPrompt).not.toHaveBeenCalled();
      expect(useCodexStore.getState().messageQueue.get(SESSION_KEY))
        .toEqual([expect.objectContaining({ id: "row-1" })]);
    });
  });

  describe("manual refresh", () => {
    test("refreshes messages without overwriting a newer live idle state", async () => {
      /**
       * Regression: the manual refresh shared one sequence counter with every
       * background reconcile, so an overlapping SSE frame made it return "stale"
       * — no refetch, and no error either. We still honour the transcript refresh,
       * but the live state must win over the older HTTP snapshot.
       */
      const refreshed = createMessage("manual-refresh", "Manual refresh landed");
      let markManualStarted!: () => void;
      const manualStarted = new Promise<void>((resolve) => {
        markManualStarted = resolve;
      });
      let markFrameSent!: () => void;
      const frameSent = new Promise<void>((resolve) => {
        markFrameSent = resolve;
      });
      let releaseManual!: (result: CodexSessionStatusLookupResult) => void;
      const manualLookup = new Promise<CodexSessionStatusLookupResult>((resolve) => {
        releaseManual = resolve;
      });

      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        await manualStarted;
        yield {
          type: "session.idle",
          sessionId: SESSION_ID,
          data: { title: "Live completion" },
        };
        markFrameSent();
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      const { rerender } = render(
        <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
      );
      await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

      mockLookupSessionStatus.mockImplementationOnce(() => {
        markManualStarted();
        return manualLookup;
      });
      mockGetSessionMessages.mockResolvedValue([refreshed]);

      rerender(
        <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
      );
      await frameSent;

      await act(async () => {
        releaseManual({
          kind: "found",
          session: { status: "running", title: "Stale manual snapshot" },
        });
        await manualLookup;
      });

      await waitFor(() => {
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
          title: "Live completion",
          isLoading: false,
          messages: [refreshed],
        });
      });
    });

    test("an older manual refresh cannot overwrite the newer one", async () => {
      let releaseFirst!: (result: CodexSessionStatusLookupResult) => void;
      const firstLookup = new Promise<CodexSessionStatusLookupResult>((resolve) => {
        releaseFirst = resolve;
      });

      const { rerender } = render(
        <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
      );
      await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

      mockLookupSessionStatus.mockImplementationOnce(() => firstLookup);
      rerender(
        <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
      );
      await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalledTimes(2));

      mockLookupSessionStatus.mockResolvedValue({
        kind: "found",
        session: { status: "idle", title: "Newest manual refresh" },
      });
      rerender(
        <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={2} />,
      );
      await waitFor(() =>
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.title).toBe(
          "Newest manual refresh",
        ),
      );

      await act(async () => {
        releaseFirst({
          kind: "found",
          session: { status: "running", title: "Superseded manual refresh" },
        });
        await firstLookup;
      });

      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.title).toBe("Newest manual refresh");
      expect(session?.isLoading).toBe(false);
    });

    test("reports a session the bridge no longer has", async () => {
      const originalError = console.error;
      console.error = mock(() => {}) as unknown as typeof console.error;
      try {
        const { rerender } = render(
          <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
        );
        await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

        mockLookupSessionStatus.mockResolvedValue({ kind: "missing" });
        rerender(
          <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
        );

        await waitFor(() =>
          expect(mockToastError).toHaveBeenCalledWith("Failed to refresh Codex tab", {
            description: "The Codex session is no longer available on the server",
          }),
        );
      } finally {
        console.error = originalError;
      }
    });

    test("reports a bridge that cannot answer", async () => {
      const originalError = console.error;
      console.error = mock(() => {}) as unknown as typeof console.error;
      try {
        const { rerender } = render(
          <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
        );
        await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

        mockLookupSessionStatus.mockResolvedValue({
          kind: "unavailable",
          error: new Error("status transport failed"),
        });
        rerender(
          <CodexChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
        );

        await waitFor(() =>
          expect(mockToastError).toHaveBeenCalledWith("Failed to refresh Codex tab", {
            description: "status transport failed",
          }),
        );
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("approval rehydration", () => {
    test("adopts approvals raised while the tab was unmounted", async () => {
      // The whole point of the route: a tab that was not mounted saw no SSE frame,
      // and its fresh subscription has no cursor for the bridge to replay from.
      mockFetchPendingApprovals.mockResolvedValue([createApproval("apr-rehydrated")]);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(
          useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((item) => item.approvalId),
        ).toEqual(["apr-rehydrated"]),
      );
    });

    test("drops an approval the bridge no longer reports", async () => {
      useCodexStore.getState().addPendingApproval(SESSION_KEY, createApproval("apr-answered"));
      mockFetchPendingApprovals.mockResolvedValue([]);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false),
      );
    });

    test("an unrelated SSE frame does not discard the approvals snapshot", async () => {
      /**
       * Regression: the snapshot was gated on the broad reconcile counter, which
       * any current-session frame bumps. A single `message.updated` arriving while
       * the snapshot was in flight threw away the only rehydration path, leaving
       * the turn blocked on a card nobody could see.
       */
      let markFrameApplied!: () => void;
      const frameApplied = new Promise<void>((resolve) => {
        markFrameApplied = resolve;
      });
      let releaseSnapshot!: (approvals: CodexApproval[]) => void;
      const snapshot = new Promise<CodexApproval[]>((resolve) => {
        releaseSnapshot = resolve;
      });

      mockFetchPendingApprovals.mockImplementationOnce(() => snapshot);
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "message.updated",
          sessionId: SESSION_ID,
          data: { message: createMessage("streamed", "Streamed mid-snapshot") },
        };
        markFrameApplied();
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await frameApplied;

      await act(async () => {
        releaseSnapshot([createApproval("apr-blocked")]);
        await snapshot;
      });

      await waitFor(() =>
        expect(
          useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((item) => item.approvalId),
        ).toEqual(["apr-blocked"]),
      );
    });

    test("a stale snapshot cannot resurrect a just-resolved approval", async () => {
      let markResolved!: () => void;
      const resolvedFrameSent = new Promise<void>((resolve) => {
        markResolved = resolve;
      });
      let releaseSnapshot!: (approvals: CodexApproval[]) => void;
      const snapshot = new Promise<CodexApproval[]>((resolve) => {
        releaseSnapshot = resolve;
      });
      const answered = createApproval("apr-answered");

      useCodexStore.getState().addPendingApproval(SESSION_KEY, answered);
      mockFetchPendingApprovals.mockImplementationOnce(() => snapshot);
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.approval-resolved",
          sessionId: SESSION_ID,
          data: { approvalId: "apr-answered" },
        };
        markResolved();
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await resolvedFrameSent;
      await waitFor(() =>
        expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false),
      );

      // The snapshot was taken before the decision landed; re-showing the card
      // would invite the user to answer a request that is already gone.
      await act(async () => {
        releaseSnapshot([answered]);
        await snapshot;
      });

      expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    });

    test.each([
      ["an unknown kind", { kind: "network" }],
      ["an empty approval id", { approvalId: "" }],
      ["a missing deadline", { expiresAt: undefined }],
    ])("rejects an SSE approval with %s", async (_label, overrides) => {
      // The SSE frame is validated exactly like the HTTP snapshot: an approval the
      // card cannot render is one the user can never answer.
      const originalWarn = console.warn;
      console.warn = mock(() => {}) as unknown as typeof console.warn;
      try {
        mockGetSessionStatus.mockResolvedValue({ status: "running" });
        mockSubscribeToEvents.mockImplementation(() => (async function* () {
          yield {
            type: "session.approval-requested",
            sessionId: SESSION_ID,
            data: { approval: { ...createApproval("apr-malformed"), ...overrides } },
          };
          yield { type: "session.idle", sessionId: SESSION_ID, data: {} };
        })() as any);
        useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

        render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

        await waitFor(() =>
          expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false),
        );
        expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("event cursor", () => {
    test("resumes from the last revision it saw, including other sessions' frames and keepalives", async () => {
      /**
       * The cursor tracks the bridge-wide stream, so every frame advances it —
       * skipping another session's revision would make the next reconnect ask for
       * frames we already have.
       */
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      let attempt = 0;
      mockSubscribeToEvents.mockImplementation(() => {
        attempt += 1;
        if (attempt === 1) {
          return (async function* () {
            yield { type: "message.updated", sessionId: "other-session", data: {}, revision: 7 };
          })() as any;
        }
        if (attempt === 2) {
          return (async function* () {
            yield { type: "keepalive", data: {}, revision: 9 };
          })() as any;
        }
        return (async function* () {
          await new Promise(() => {});
        })() as any;
      });
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(
        () => expect(mockSubscribeToEvents.mock.calls.length).toBeGreaterThanOrEqual(3),
        { timeout: 5_000 },
      );
      const cursors = mockSubscribeToEvents.mock.calls
        .slice(0, 3)
        .map((call) => (call as unknown as unknown[])[2]);
      expect(cursors).toEqual([undefined, 7, 9]);
    });
  });

  describe("session.updated phases", () => {
    test("a terminal phase clears the phase and re-enables the composer", async () => {
      mockGetSessionStatus.mockResolvedValue({ status: "running", phase: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield { type: "session.updated", sessionId: SESSION_ID, data: { phase: "cancelling" } };
        yield { type: "session.updated", sessionId: SESSION_ID, data: { phase: "idle" } };
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
      });
    });

    test("an idle phase does not detach a turn whose prompt is still in flight", async () => {
      /**
       * Regression: the bridge emits `session.updated {phase:"idle"}` from its
       * post-restart recovery for any thread with no active turn — including while
       * our own prompt POST is in flight. Clearing the loading flag there tore down
       * both the SSE subscription and the watchdog, and neither re-armed, so the
       * transcript froze until the tab remounted.
       */
      seedEnvironment("review-table");
      composeText = "Start the turn";
      let markSendStarted!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        markSendStarted = resolve;
      });
      let releaseSend!: (value: CodexPromptAcceptedResponse) => void;
      mockSendPrompt.mockImplementation(() => {
        markSendStarted();
        return new Promise<CodexPromptAcceptedResponse>((resolve) => {
          releaseSend = resolve;
        });
      });
      let markFrameSent!: () => void;
      const frameSent = new Promise<void>((resolve) => {
        markFrameSent = resolve;
      });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        await sendStarted;
        yield { type: "session.updated", sessionId: SESSION_ID, data: { phase: "idle" } };
        markFrameSent();
        await new Promise(() => {});
      })() as any);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockLookupSessionStatus).toHaveBeenCalled());

      fireEvent.click(screen.getByTestId("codex-send"));
      await frameSent;

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      expect(screen.queryByText("Codex is thinking...")).not.toBeNull();
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);

      releaseSend({ status: "processing" });
    });
  });

  describe("fast mode toggle", () => {
    test("uses configured fast mode default when warm path creates a new session", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexNativeFastModeDefault: true,
          },
        },
      }));
      useCodexStore.setState((state) => ({
        ...state,
        sessions: new Map(),
        fastMode: new Map(),
      }));

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={true}
        />,
      );

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[1]).toMatchObject({ fastMode: true });
      expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
    });

    test("uses configured fast mode default when cold path creates a new session", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexNativeFastModeDefault: true,
          },
        },
      }));
      useCodexStore.setState((state) => ({
        ...state,
        clients: new Map(),
        sessions: new Map(),
        fastMode: new Map(),
      }));

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={true}
        />,
      );

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[1]).toMatchObject({ fastMode: true });
      expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
    });

    test("preserves an existing per-session fast mode value over the global default", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexNativeFastModeDefault: true,
          },
        },
      }));
      useCodexStore.setState((state) => ({
        ...state,
        sessions: new Map(),
        fastMode: new Map([[SESSION_KEY, false]]),
      }));

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={true}
        />,
      );

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[1]).toMatchObject({ fastMode: false });
      expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
    });

    test("persists fast mode in the store when the bridge accepts the config change", async () => {
      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("codex-fast-mode-on"));

      await waitFor(() => {
        expect(mockUpdateSessionConfig).toHaveBeenCalled();
      });
      const lastCall = mockUpdateSessionConfig.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[2]).toMatchObject({ fastMode: true });

      await waitFor(() => {
        expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
      });
    });

    test("rolls back fast mode when the bridge rejects the config change", async () => {
      mockUpdateSessionConfig.mockImplementation(async () => false);

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("codex-fast-mode-on"));

      await waitFor(() => {
        expect(mockUpdateSessionConfig).toHaveBeenCalled();
      });

      // The optimistic update should be reverted to the previous value (false).
      await waitFor(() => {
        expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
    });
  });

  describe("interaction rehydration and SSE", () => {
    test("adopts interactions raised while the tab was unmounted", async () => {
      // Same reason as approvals: an unmounted tab saw no frame and its fresh
      // subscription has no cursor for the bridge to replay from.
      mockFetchPendingInteractions.mockResolvedValue([createInteraction("int-rehydrated")]);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(
          useCodexStore
            .getState()
            .pendingInteractions.get(SESSION_KEY)
            ?.map((item) => item.interactionId),
        ).toEqual(["int-rehydrated"]),
      );
      expect(mockFetchPendingInteractions).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);
    });

    test("drops an interaction the bridge no longer reports", async () => {
      useCodexStore.getState().addPendingInteraction(SESSION_KEY, createInteraction("int-answered"));
      mockFetchPendingInteractions.mockResolvedValue([]);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false),
      );
    });

    test("renders the card for a pending interaction and hides it once resolved", async () => {
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      let markRequested!: () => void;
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      let releaseResolve!: () => void;
      const resolveGate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.interaction-requested",
          sessionId: SESSION_ID,
          data: { interaction: createInteraction("int-live") },
        };
        markRequested();
        await resolveGate;
        yield {
          type: "session.interaction-resolved",
          sessionId: SESSION_ID,
          data: { interactionId: "int-live" },
        };
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await requested;

      // `showInteractions` gates on a pending list, a client and a session id.
      await waitFor(() => expect(screen.getByText("Codex has a question")).toBeTruthy());
      expect(screen.getByRole("button", { name: /staging/ })).toBeTruthy();

      await act(async () => {
        releaseResolve();
        await resolveGate;
      });
      await waitFor(() =>
        expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false),
      );
      expect(screen.queryByText("Codex has a question")).toBeNull();
    });

    test("does not render the card while there is nothing pending", async () => {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockFetchPendingInteractions).toHaveBeenCalled());
      expect(screen.queryByText("Codex has a question")).toBeNull();
      expect(screen.queryByText("MCP input requested")).toBeNull();
    });

    test.each([
      ["an unknown kind", { kind: "diagnostic" }],
      ["an empty interaction id", { interactionId: "" }],
      ["a question payload with no questions", { questions: [] }],
    ])("rejects an SSE interaction with %s", async (_label, overrides) => {
      // The frame is validated exactly like the HTTP snapshot: an interaction
      // the card cannot render is one the user can never answer.
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.interaction-requested",
          sessionId: SESSION_ID,
          data: { interaction: { ...createInteraction("int-malformed"), ...overrides } },
        };
        yield { type: "session.idle", sessionId: SESSION_ID, data: {} };
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false),
      );
      expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
    });

    test("an unrelated SSE frame does not discard the interactions snapshot", async () => {
      /*
       * Mirrors the approval guard: gating the snapshot on the broad reconcile
       * counter would let any current-session frame throw away the only
       * rehydration path, leaving the turn blocked on a card nobody can see.
       */
      let markFrameApplied!: () => void;
      const frameApplied = new Promise<void>((resolve) => {
        markFrameApplied = resolve;
      });
      let releaseSnapshot!: (interactions: CodexInteraction[]) => void;
      const snapshot = new Promise<CodexInteraction[]>((resolve) => {
        releaseSnapshot = resolve;
      });

      mockFetchPendingInteractions.mockImplementationOnce(() => snapshot);
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "message.updated",
          sessionId: SESSION_ID,
          data: { message: createMessage("streamed", "Streamed mid-snapshot") },
        };
        markFrameApplied();
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await frameApplied;

      await act(async () => {
        releaseSnapshot([createInteraction("int-blocked")]);
        await snapshot;
      });

      await waitFor(() =>
        expect(
          useCodexStore
            .getState()
            .pendingInteractions.get(SESSION_KEY)
            ?.map((item) => item.interactionId),
        ).toEqual(["int-blocked"]),
      );
    });

    test("a stale snapshot cannot resurrect a just-resolved interaction", async () => {
      let markResolved!: () => void;
      const resolvedFrameSent = new Promise<void>((resolve) => {
        markResolved = resolve;
      });
      let releaseSnapshot!: (interactions: CodexInteraction[]) => void;
      const snapshot = new Promise<CodexInteraction[]>((resolve) => {
        releaseSnapshot = resolve;
      });
      const answered = createInteraction("int-answered");

      useCodexStore.getState().addPendingInteraction(SESSION_KEY, answered);
      mockFetchPendingInteractions.mockImplementationOnce(() => snapshot);
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.interaction-resolved",
          sessionId: SESSION_ID,
          data: { interactionId: "int-answered" },
        };
        markResolved();
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await resolvedFrameSent;
      await waitFor(() =>
        expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false),
      );

      await act(async () => {
        releaseSnapshot([answered]);
        await snapshot;
      });

      expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
    });

    test("the live SSE frame and the reconcile poll cannot double-add one card", async () => {
      // Both paths are now live. `addPendingInteraction` dedupes on id, and the
      // snapshot replaces rather than appends.
      const shared = createInteraction("int-shared");
      mockFetchPendingInteractions.mockResolvedValue([shared]);
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.interaction-requested",
          sessionId: SESSION_ID,
          data: { interaction: shared },
        };
        await new Promise(() => {});
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY)?.length).toBe(1),
      );
      expect(screen.getAllByText("Codex has a question")).toHaveLength(1);
    });

    test("a failed interactions snapshot leaves the existing cards alone", async () => {
      const originalError = console.error;
      console.error = mock(() => {}) as unknown as typeof console.error;
      try {
        useCodexStore
          .getState()
          .addPendingInteraction(SESSION_KEY, createInteraction("int-existing"));
        mockFetchPendingInteractions.mockImplementation(async () => {
          throw new Error("interactions endpoint unavailable");
        });

        render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

        await waitFor(() => expect(mockFetchPendingInteractions).toHaveBeenCalled());
        expect(
          useCodexStore
            .getState()
            .pendingInteractions.get(SESSION_KEY)
            ?.map((item) => item.interactionId),
        ).toEqual(["int-existing"]);
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("context usage", () => {
    test("stores the usage the status lookup reports", async () => {
      mockGetSessionStatus.mockResolvedValue({
        status: "idle",
        contextUsage: {
          usedTokens: 1_000,
          totalTokens: 10_000,
          percentUsed: 10,
          source: "provider",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      } as any);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().contextUsage.get(SESSION_KEY)?.percentUsed).toBe(10),
      );
    });

    test("stores a well-formed session.updated usage frame", async () => {
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.updated",
          sessionId: SESSION_ID,
          data: {
            contextUsage: {
              usedTokens: 4_000,
              totalTokens: 20_000,
              percentUsed: 20,
              source: "provider",
              updatedAt: "2026-04-15T00:01:00.000Z",
            },
          },
        };
        yield { type: "session.idle", sessionId: SESSION_ID, data: {} };
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().contextUsage.get(SESSION_KEY)?.usedTokens).toBe(4_000),
      );
    });

    test.each([
      ["a non-numeric percentage", { percentUsed: "lots" }],
      ["a missing token total", { totalTokens: undefined }],
      ["a null payload", null],
      ["an array payload", []],
    ])("ignores a session.updated frame with %s", async (_label, contextUsage) => {
      /*
       * The SSE branch used to store the frame behind a bare cast, bypassing
       * the validation the HTTP path performs. The agent-info popover then
       * called `percentUsed.toFixed(...)` on it and threw inside render.
       */
      const previous = {
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
        source: "provider" as const,
        updatedAt: "2026-04-15T00:00:00.000Z",
      };
      useCodexStore.getState().setContextUsage(SESSION_KEY, previous);
      mockGetSessionStatus.mockResolvedValue({ status: "running" });
      mockSubscribeToEvents.mockImplementation(() => (async function* () {
        yield {
          type: "session.updated",
          sessionId: SESSION_ID,
          data: contextUsage === undefined ? {} : { contextUsage },
        };
        yield { type: "session.idle", sessionId: SESSION_ID, data: {} };
      })() as any);
      useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false),
      );
      // The last good reading survives rather than being replaced by junk.
      const stored = useCodexStore.getState().contextUsage.get(SESSION_KEY);
      expect(stored?.percentUsed).toBe(50);
      expect(typeof stored?.percentUsed).toBe("number");
    });
  });

  describe("forking from a message", () => {
    function forkButtons() {
      return screen.getAllByRole("button", { name: "Fork Codex session from this prompt" });
    }

    async function renderWithUserTurn() {
      mockGetSessionMessages.mockResolvedValue([
        {
          id: "assistant-0",
          role: "assistant",
          content: "Existing answer",
          parts: [{ type: "text", content: "Existing answer" }],
          createdAt: "2026-04-15T00:00:00.000Z",
          turnId: "turn-0",
        } as any,
        {
          id: "user-1",
          role: "user",
          content: "Add pagination",
          parts: [{ type: "text", content: "Add pagination" }],
          createdAt: "2026-04-15T00:01:00.000Z",
          turnId: "turn-1",
        } as any,
      ]);
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    }

    test("forks before a prompt and restores that prompt as the new draft", async () => {
      await renderWithUserTurn();
      fireEvent.click(forkButtons()[0]!);

      await waitFor(() =>
        expect(mockForkCodexSession).toHaveBeenCalledWith(
          MOCK_CLIENT,
          SESSION_ID,
          "assistant-0",
        ),
      );
      await waitFor(() => {
        const tabs = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID);
        expect(tabs).toHaveLength(2);
      });
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      expect(forked.type).toBe("codex-native");
      expect(forked.displayTitle).toBe("Codex fork");
      expect(forked.codexNativeData?.sessionId).toBe("fork-session");
      expect(forked.initialPrompt).toBeUndefined();
      expect(
        useCodexStore.getState().getDraftText(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe("Add pagination");
    });

    test("creates an empty fork when the selected prompt is the first turn", async () => {
      mockCreateSession.mockResolvedValue({
        sessionId: "empty-fork",
        title: "Empty fork",
      });
      mockGetSessionMessages.mockResolvedValue([
        {
          id: "user-1",
          role: "user",
          content: "First prompt",
          parts: [{ type: "text", content: "First prompt" }],
          createdAt: "2026-04-15T00:00:00.000Z",
          turnId: "turn-1",
        } as any,
      ]);
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      fireEvent.click((await screen.findAllByRole("button", {
        name: "Fork Codex session from this prompt",
      }))[0]!);

      await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
      expect(mockForkCodexSession).not.toHaveBeenCalled();
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      expect(forked.codexNativeData?.sessionId).toBe("empty-fork");
      expect(
        useCodexStore.getState().getDraftText(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe("First prompt");
    });

    test("forks a response inclusively and leaves the new composer empty", async () => {
      mockGetSessionMessages.mockResolvedValue([
        {
          id: "user-1",
          role: "user",
          content: "Add pagination",
          parts: [{ type: "text", content: "Add pagination" }],
          createdAt: "2026-04-15T00:00:00.000Z",
          turnId: "turn-1",
        } as any,
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
          parts: [{ type: "text", content: "Done" }],
          createdAt: "2026-04-15T00:01:00.000Z",
          turnId: "turn-1",
        } as any,
      ]);
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      const responseFork = await screen.findByRole("button", {
        name: "Fork Codex session from this response",
      });
      fireEvent.click(responseFork);

      await waitFor(() =>
        expect(mockForkCodexSession).toHaveBeenCalledWith(
          MOCK_CLIENT,
          SESSION_ID,
          "assistant-1",
        ),
      );
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      // `getDraftText` returns "" for any unseen key, so asserting on it would
      // pass whether or not a draft was written. Assert on the backing map.
      expect(
        useCodexStore.getState().draftText.has(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe(false);
    });

    test("offers no prompt action when the history has no turn boundary", async () => {
      /*
       * A rollout old enough to predate turn boundaries has nothing
       * `thread/fork` could honour — the bridge answers `no-fork-point`. The
       * button used to render anyway and could only ever raise a toast, so the
       * gate and the handler now read the same plan and it is never offered.
       */
      mockGetSessionMessages.mockResolvedValue([
        {
          id: "user-1",
          role: "user",
          content: "First prompt",
          parts: [{ type: "text", content: "First prompt" }],
          createdAt: "2026-04-15T00:00:00.000Z",
        } as any,
        {
          id: "assistant-1",
          role: "assistant",
          content: "Answer",
          parts: [{ type: "text", content: "Answer" }],
          createdAt: "2026-04-15T00:01:00.000Z",
        } as any,
        {
          id: "user-2",
          role: "user",
          content: "Second prompt",
          parts: [{ type: "text", content: "Second prompt" }],
          createdAt: "2026-04-15T00:02:00.000Z",
        } as any,
      ]);
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      // The opening prompt still forks: it needs no boundary, it starts a
      // sibling session.
      await waitFor(() => expect(forkButtons()).toHaveLength(1));
      // No response action either — an inclusive fork needs a turn to name.
      expect(
        screen.queryByRole("button", {
          name: "Fork Codex session from this response",
        }),
      ).toBeNull();
      expect(mockForkCodexSession).not.toHaveBeenCalled();
    });

    test.each([
      [409, "Codex session cannot be forked while it is running"],
      [422, "That message is not a usable fork point"],
      [404, "Codex session or fork point was not found"],
      [503, "Codex did not return a forked thread"],
      [0, "fetch failed"],
    ])(
      "surfaces the bridge's own %s refusal instead of one generic line",
      async (status, message) => {
        /*
         * The four refusals mean different things to the user — wait for the
         * turn, pick another message, the session is gone, the engine is down —
         * and only the bridge knows which happened.
         */
        mockForkCodexSession.mockImplementation(async () => {
          throw new realCodexClientSnapshot.CodexForkError(status, message);
        });
        await renderWithUserTurn();
        fireEvent.click(forkButtons()[0]!);

        await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(message));
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
        // The latch releases so the user can retry once the cause is cleared.
        await waitFor(() => expect(forkButtons()[0]!.hasAttribute("disabled")).toBe(false));
      },
    );

    test("falls back to generic copy for an error that is not a fork refusal", async () => {
      // A programming error must not be presented as if Codex had answered.
      mockForkCodexSession.mockImplementation(async () => {
        throw new TypeError("client.fetch is not a function");
      });
      await renderWithUserTurn();
      fireEvent.click(forkButtons()[0]!);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Failed to fork Codex session"),
      );
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1);
    });

    test("a double click forks once", async () => {
      /*
       * Every call POSTs a fork and then adds a tab with a freshly generated
       * id, so the pane store cannot dedupe: two clicks produced two
       * server-side forks and two tabs.
       */
      let release!: (value: { sessionId: string; title?: string }) => void;
      mockForkCodexSession.mockImplementation(
        () => new Promise((resolve) => {
          release = resolve;
        }),
      );
      await renderWithUserTurn();

      fireEvent.click(forkButtons()[0]!);
      await waitFor(() => expect(forkButtons()[0]!.hasAttribute("disabled")).toBe(true));
      fireEvent.click(forkButtons()[0]!);

      await act(async () => {
        release({ sessionId: "fork-session", title: "Codex fork" });
      });

      expect(mockForkCodexSession).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
      );
      // The latch releases so a second, deliberate fork is still possible.
      await waitFor(() => expect(forkButtons()[0]!.hasAttribute("disabled")).toBe(false));
    });
  });


});

function installTimerHarness(startTime: number) {
  mockedNow = startTime;
  intervalCallbacks = [];
  // Fires every interval registered with the harness. The component creates
  // multiple intervals (elapsed timer, watchdog poll); ticking all of them
  // keeps the elapsed timer test stable as new intervals are added.
  intervalCallback = () => {
    for (const callback of [...intervalCallbacks]) {
      callback();
    }
  };
  clearIntervalCalls = 0;
  Date.now = () => mockedNow;
  let nextHandle = 1;
  globalThis.setInterval = (((callback: TimerHandler) => {
    intervalCallbacks.push(callback as () => void);
    return nextHandle++ as unknown as ReturnType<typeof setInterval>;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearIntervalCalls += 1;
  }) as typeof clearInterval;
}

function restoreTimerHarness() {
  Date.now = ORIGINAL_DATE_NOW;
  globalThis.setInterval = ORIGINAL_SET_INTERVAL;
  globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
  intervalCallbacks = [];
  intervalCallback = null;
  clearIntervalCalls = 0;
}
