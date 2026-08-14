import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef as useReactRef } from "react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
  type TmuxQueuedMessage,
} from "@/stores/claudeTmuxStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useUIStore } from "@/stores/uiStore";
import {
  tmuxElicitationDraftKey,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";
import { clearPersistedVirtuosoState } from "@/hooks/useVirtuosoScrollState";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realBackend from "@/lib/backend";
import type {
  ClaudeMessage as ClaudeMessageType,
  ClaudeModel,
} from "@/lib/claude-client";
import * as realInteractiveTerminal from "@/components/claude/ClaudeTmuxInteractiveTerminal";
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import * as realReactVirtuoso from "react-virtuoso";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { mockReadImage } from "../../mocks/clipboard";
import { restoreMatchMedia, setMobileViewport } from "../../mocks/match-media";
import type { Environment, FileCandidate } from "@/types";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";
import {
  applyPromptQueueSnapshot,
  promptQueueKey,
  resetPromptQueueRevisions,
} from "@/lib/prompt-queue-persistence";

const realTmuxClientSnapshot = { ...realTmuxClient };
const realBackendSnapshot = { ...realBackend };
const realInteractiveTerminalSnapshot = { ...realInteractiveTerminal };
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const realReactVirtuosoSnapshot = { ...realReactVirtuoso };
const VIRTUOSO_WINDOW_SIZE = 25;
let lastVirtuosoProps: Record<string, any> | null = null;
let dateNowSpy: ReturnType<typeof spyOn> | undefined;
const virtuosoScrollToIndexMock = mock(() => {});
const virtuosoScrollToMock = mock(() => {});
const virtuosoGetStateMock = mock((callback: (snapshot: any) => void) => {
  callback({ ranges: [], scrollTop: 0 });
});
const getFileTreeMock = mock(async () => []);
const getLocalFileTreeMock = mock(async () => []);
const writeContainerFileMock = mock(async () => {});
const writeLocalFileMock = mock(async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png");
const renameEnvironmentFromPromptMock = mock(async () => {});
const openInBrowserMock = mock(async () => {});
const updateGlobalConfigMock = mock(async (global: any) => ({
  version: "1.0",
  global,
  repositories: {},
}));
const getClaudeModelCatalogMock = mock(async (environmentId: string) => ({
  environmentId,
  models: useClaudeStore.getState().models,
  source: "fallback" as const,
  fetchedAt: "2026-07-25T12:00:00.000Z",
  stale: false,
}));
const getComposeDraftMock = mock(async () => null);
const saveComposeDraftMock = mock(async (
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: unknown,
) => ({
  draftKey,
  ownerType,
  ownerId,
  value,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
}));
const deleteComposeDraftMock = mock(async () => undefined);
const enqueuePromptQueueMessageMock = mock(
  async (queueKey: string, environmentId: string, message: { id: string }) =>
    promptQueueSnapshot(queueKey, environmentId, [
      ...useClaudeTmuxStore.getState().getQueuedMessages(promptQueueSessionKey(queueKey)),
      message,
    ]),
);
const requeuePromptQueueMessageMock = mock(
  async (queueKey: string, environmentId: string, message: { id: string }) => {
    const current = useClaudeTmuxStore.getState()
      .getQueuedMessages(promptQueueSessionKey(queueKey));
    return promptQueueSnapshot(
      queueKey,
      environmentId,
      current.some((candidate) => candidate.id === message.id)
        ? current
        : [message, ...current],
    );
  },
);
const claimedPromptMessages = new Map<string, { id: string; text?: string; attachments?: unknown[] }>();
const acknowledgePromptQueueClaimMock = mock(
  async (queueKey: string, environmentId: string, claimToken: string) => {
    claimedPromptMessages.delete(claimToken);
    return promptQueueSnapshot(
      queueKey,
      environmentId,
      useClaudeTmuxStore
        .getState()
        .getQueuedMessages(promptQueueSessionKey(queueKey)),
    );
  },
);
const rejectPromptQueueClaimMock = mock(
  async (queueKey: string, environmentId: string, claimToken: string) => {
    const claimed = claimedPromptMessages.get(claimToken);
    claimedPromptMessages.delete(claimToken);
    const current = useClaudeTmuxStore
      .getState()
      .getQueuedMessages(promptQueueSessionKey(queueKey));
    return promptQueueSnapshot(
      queueKey,
      environmentId,
      claimed ? [claimed, ...current] : current,
    );
  },
);
const claimPromptQueueHeadMock = mock(async (
  queueKey: string,
  environmentId: string,
  _expectedMessageId: string,
  candidateMessages: Array<{ id: string; text?: string; attachments?: unknown[] }>,
) => {
  const claimed = candidateMessages[0] ?? null;
  const claimToken = claimed ? `claim-${claimed.id}` : null;
  if (claimed && claimToken) claimedPromptMessages.set(claimToken, claimed);
  return {
    claimed,
    claimToken,
    queue: promptQueueSnapshot(queueKey, environmentId, candidateMessages.slice(1)),
  };
});
const removePromptQueueMessageMock = mock(
  async (queueKey: string, environmentId: string, messageId: string) => {
    const current = useClaudeTmuxStore
      .getState()
      .getQueuedMessages(promptQueueSessionKey(queueKey));
    return {
      removed: current.find((message) => message.id === messageId) ?? null,
      queue: promptQueueSnapshot(
        queueKey,
        environmentId,
        current.filter((message) => message.id !== messageId),
      ),
    };
  },
);
const movePromptQueueMessageMock = mock(
  async (
    queueKey: string,
    environmentId: string,
    messageId: string,
    direction: "up" | "down",
  ) => {
    const messages = [
      ...useClaudeTmuxStore
        .getState()
        .getQueuedMessages(promptQueueSessionKey(queueKey)),
    ];
    const index = messages.findIndex((message) => message.id === messageId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index >= 0 && target >= 0 && target < messages.length) {
      [messages[index], messages[target]] = [messages[target]!, messages[index]!];
    }
    return promptQueueSnapshot(queueKey, environmentId, messages);
  },
);
let promptQueueRevision = 1;
const promptQueueSessionKey = (queueKey: string) =>
  queueKey.slice(queueKey.indexOf("\u0000") + 1);
const promptQueueSnapshot = (
  queueKey: string,
  environmentId: string,
  messages: Array<{ id: string }>,
) => ({
  queueKey,
  environmentId,
  messages,
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: promptQueueRevision++,
});
const retryPromptQueueDispatchMock = mock(async (queueKey: string) => {
  const sessionKey = promptQueueSessionKey(queueKey);
  return promptQueueSnapshot(
    queueKey,
    "env-1",
    useClaudeTmuxStore.getState().getQueuedMessages(sessionKey),
  );
});

function publishTmuxQueueSnapshot(
  sessionKey: string,
  dispatchError?: {
    requestId: string;
    messageId: string;
    messageFingerprint: string;
    message: string;
    failedAt: string;
  },
): void {
  const store = useClaudeTmuxStore.getState();
  const messages = store.getQueuedMessages(sessionKey);
  applyPromptQueueSnapshot<TmuxQueuedMessage>(
    {
      agent: "claude-tmux",
      getQueues: () => useClaudeTmuxStore.getState().messageQueue,
      setQueue: (key, nextMessages) => {
        const next = new Map(useClaudeTmuxStore.getState().messageQueue);
        next.set(key, nextMessages);
        useClaudeTmuxStore.setState({ messageQueue: next });
      },
      environmentIdFor: () => "env-1",
    },
    {
      queueKey: promptQueueKey("claude-tmux", sessionKey),
      environmentId: "env-1",
      messages,
      ...(dispatchError ? { dispatchError } : {}),
      updatedAt: "2026-08-04T10:00:00.000Z",
      revision: promptQueueRevision++,
    },
  );
}

const startSessionMock = mock(async () => ({
  tab_id: "tab-1",
  environment_id: "env-1",
  session_id: "session-1",
  tmux_session: "orkestrator-env1-tab1",
  running: true,
  transcript_path: null,
  resumed: false,
  busy: false,
  permission_mode: "bypassPermissions",
  fast_mode: false,
}));
const getStatusMock = mock(async () => null);
const getTranscriptMock = mock(async () => []);
const getPendingHooksMock = mock(async () => []);
let subscribedHandler: ((event: realTmuxClient.TmuxEvent) => void) | null = null;
const subscribeMock = mock(async (handler: (event: realTmuxClient.TmuxEvent) => void) => {
  subscribedHandler = handler;
  return () => {
    subscribedHandler = null;
  };
});
const stopSessionMock = mock(async () => {});
const interruptSessionMock = mock(async () => {});
const capturePaneMock = mock(async () => "");
const sendKeysMock = mock(async () => {});
const answerSelectionPromptMock = mock(async () => {});
const replyHookMock = mock(async () => {});
const submitMock = mock(async () => {});
const switchModelMock = mock(async () => {});
const switchEffortMock = mock(async () => {});
const switchFastModeMock = mock(async () => {});
const switchPlanModeMock = mock(async (_tabId: string, planMode: boolean, _environmentId?: string) =>
  planMode ? "plan" : "bypassPermissions",
);
const answerPreToolUseMock = mock(async () => {});
const listPreviousSessionsMock = mock(async () => [
  {
    session_id: "resume-1",
    title: "Previous audit",
    last_activity_unix: Math.floor(Date.now() / 1000),
    message_count: 7,
  },
]);
const interactiveTerminalRenderMock = mock(
  ({
    tabId,
    isActive,
    className,
    containerId,
    worktreePath,
  }: {
    tabId: string;
    isActive: boolean;
    className?: string;
    containerId?: string | null;
    worktreePath?: string | null;
  }) => (
    <div
      data-testid="tmux-interactive-terminal"
      data-tab-id={tabId}
      data-active={String(isActive)}
      data-container-id={containerId ?? ""}
      data-worktree-path={worktreePath ?? ""}
      className={className}
    />
  ),
);

mock.module("@/lib/claude-tmux-client", () => ({
  ...realTmuxClientSnapshot,
  startSession: startSessionMock,
  getStatus: getStatusMock,
  getTranscript: getTranscriptMock,
  getPendingHooks: getPendingHooksMock,
  subscribe: subscribeMock,
  stopSession: stopSessionMock,
  interruptSession: (tabId: string, environmentId?: string) =>
    interruptSessionMock(tabId, environmentId),
  capturePane: (tabId: string, environmentId?: string) =>
    capturePaneMock(tabId, environmentId),
  sendKeys: (tabId: string, keys: string[], environmentId?: string) =>
    sendKeysMock(tabId, keys, environmentId),
  answerSelectionPrompt: (tabId: string, environmentId: string, input: unknown) =>
    answerSelectionPromptMock(tabId, environmentId, input),
  switchModel: (tabId: string, model: string, environmentId?: string) =>
    switchModelMock(tabId, model, environmentId),
  switchEffort: (tabId: string, effort: string, environmentId?: string) =>
    switchEffortMock(tabId, effort, environmentId),
  switchFastMode: (tabId: string, fastMode: boolean, environmentId?: string) =>
    switchFastModeMock(tabId, fastMode, environmentId),
  switchPlanMode: (tabId: string, planMode: boolean, environmentId?: string) =>
    switchPlanModeMock(tabId, planMode, environmentId),
  replyHook: (
    tabId: string,
    eventKind: realTmuxClient.HookEventKind,
    eventId: string,
    response: unknown,
    environmentId?: string,
  ) => replyHookMock(tabId, eventKind, eventId, response, environmentId),
  submit: (tabId: string, text: string, environmentId?: string) =>
    submitMock(tabId, text, environmentId),
  answerPreToolUse: (
    tabId: string,
    eventId: string,
    decision: "approve" | "block",
    reason?: string,
    environmentId?: string,
  ) => answerPreToolUseMock(tabId, eventId, decision, reason, environmentId),
  listPreviousSessions: listPreviousSessionsMock,
}));

mock.module("@/components/claude/ClaudeTmuxInteractiveTerminal", () => ({
  ClaudeTmuxInteractiveTerminal: interactiveTerminalRenderMock,
}));

mock.module("@/lib/backend", () => ({
  claimPromptQueueHead: claimPromptQueueHeadMock,
  acknowledgePromptQueueClaim: acknowledgePromptQueueClaimMock,
  rejectPromptQueueClaim: rejectPromptQueueClaimMock,
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
  requeuePromptQueueMessage: requeuePromptQueueMessageMock,
  removePromptQueueMessage: removePromptQueueMessageMock,
  movePromptQueueMessage: movePromptQueueMessageMock,
  retryPromptQueueDispatch: retryPromptQueueDispatchMock,
  getFileTree: getFileTreeMock,
  getLocalFileTree: getLocalFileTreeMock,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
  renameEnvironmentFromPrompt: renameEnvironmentFromPromptMock,
  openInBrowser: openInBrowserMock,
  updateGlobalConfig: updateGlobalConfigMock,
  getClaudeModelCatalog: getClaudeModelCatalogMock,
  getComposeDraft: getComposeDraftMock,
  saveComposeDraft: saveComposeDraftMock,
  deleteComposeDraft: deleteComposeDraftMock,
}));

mock.module("@/components/chat/FileMentionMenu", () => ({
  FileMentionMenu: ({ files }: { files: FileCandidate[] }) => (
    <div>
      {files.map((file) => (
        <div key={file.relativePath}>{file.filename}</div>
      ))}
    </div>
  ),
}));

mock.module("react-virtuoso", () => ({
  ...realReactVirtuosoSnapshot,
  Virtuoso: forwardRef<any, any>((props, ref) => {
    lastVirtuosoProps = props;
    const scrollerRef = useReactRef<HTMLDivElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        scrollToIndex: virtuosoScrollToIndexMock,
        scrollTo: virtuosoScrollToMock,
        getState: virtuosoGetStateMock,
      }),
      [],
    );

    useEffect(() => {
      props.scrollerRef?.(scrollerRef.current);
      props.atBottomStateChange?.(true);
      return () => props.scrollerRef?.(null);
    }, [props.scrollerRef, props.atBottomStateChange]);

    const data = props.data ?? [];
    const offset = Math.max(0, data.length - VIRTUOSO_WINDOW_SIZE);
    const visibleData = data.slice(offset);
    const Footer = props.components?.Footer;
    const EmptyPlaceholder = props.components?.EmptyPlaceholder;

    return (
      <div data-testid="virtuoso-mock" ref={scrollerRef}>
        {data.length === 0 && EmptyPlaceholder ? (
          <EmptyPlaceholder context={props.context} />
        ) : (
          visibleData.map((item: any, localIndex: number) => {
            const index = offset + localIndex;
            return (
              <div key={props.computeItemKey?.(index, item) ?? index}>
                {props.itemContent(index, item)}
              </div>
            );
          })
        )}
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    );
  }),
}));

const { ClaudeTmuxChatTab } = await import(
  "@/components/claude/ClaudeTmuxChatTab"
);
const {
  parseTmuxAgentObservation,
  parseTmuxSelectionPrompt,
} = await import(
  "@orkestrator/protocol/tmux-observation"
);

if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "activeElement",
);
const putImageDataMock = mock(() => {});

function setActiveElement(element: Element) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => element,
  });
}

function mockRunningTmuxStatus(pane = "") {
  getStatusMock.mockImplementation(async () => ({
    tab_id: "tab-1",
    environment_id: "env-1",
    session_id: "session-existing",
    tmux_session: "orkestrator-env1-tab1",
    running: true,
    transcript_path: "/tmp/session-existing.jsonl",
    resumed: false,
    busy: false,
    permission_mode: "bypassPermissions",
    fast_mode: false,
    observation_generation: "generation-1",
    observation: generatedObservation(
      pane,
      1,
    ),
  }));
}

function generatedObservation(pane: string, revision: number) {
  return {
    ...parseTmuxAgentObservation(pane, revision, "2026-08-04T12:00:00.000Z"),
    generation: "generation-1",
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

async function adoptMockedPaneObservation(revision = 1) {
  const pane = await capturePaneMock();
  useClaudeTmuxStore.getState().setObservation(
    "tab-1",
    generatedObservation(pane, revision),
  );
}

function expectSelectionAnswer(optionIndex: number) {
  expect(answerSelectionPromptMock).toHaveBeenCalledWith("tab-1", "env-1", {
    expectedGeneration: "generation-1",
    expectedRevision: 1,
    expectedPromptFingerprint: expect.any(String),
    optionIndex,
  });
}

function seedPane(
  initialPrompt?: string,
  initialAgentModel?: string,
  initialReasoningEffort?: string,
) {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            activeTabId: "tab-1",
            tabs: [
              {
                id: "tab-1",
                type: "claude-tmux",
                initialPrompt,
                initialAgentModel,
                initialReasoningEffort,
                claudeTmuxData: { environmentId: "env-1" },
              },
            ],
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    activeEnvironmentId: "env-1",
  });
}

function seedEnvironment(overrides: Partial<Environment> = {}) {
  useEnvironmentStore.setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "20260528-123456",
        branch: "20260528-123456",
        containerId: "container-1",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-05-28T12:34:56.000Z",
        networkAccessMode: "full",
        order: 0,
        environmentType: "containerized",
        ...overrides,
      },
    ],
  });
}

describe("ClaudeTmuxChatTab", () => {
  afterEach(() => {
    dateNowSpy?.mockRestore();
    dateNowSpy = undefined;
    resetPromptQueueRevisions();
  });

  afterAll(() => {
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
    mock.module("@/lib/backend", () => realBackendSnapshot);
    mock.module("@/components/claude/ClaudeTmuxInteractiveTerminal", () => realInteractiveTerminalSnapshot);
    mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
    mock.module("react-virtuoso", () => realReactVirtuosoSnapshot);
    restoreMatchMedia();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    delete (document as { activeElement?: Element }).activeElement;
    if (originalActiveElementDescriptor) {
      Object.defineProperty(
        Document.prototype,
        "activeElement",
        originalActiveElementDescriptor,
      );
    }
  });

  beforeEach(() => {
    setMobileViewport(false);
    cleanup();
    resetPromptQueueRevisions();
    getFileTreeMock.mockReset();
    getFileTreeMock.mockResolvedValue([]);
    getLocalFileTreeMock.mockReset();
    getLocalFileTreeMock.mockResolvedValue([]);
    delete (document as { activeElement?: Element }).activeElement;
    if (originalActiveElementDescriptor) {
      Object.defineProperty(
        Document.prototype,
        "activeElement",
        originalActiveElementDescriptor,
      );
    }
    writeContainerFileMock.mockReset();
    writeContainerFileMock.mockImplementation(async () => {});
    writeLocalFileMock.mockReset();
    writeLocalFileMock.mockImplementation(
      async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png",
    );
    mockReadImage.mockReset();
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    putImageDataMock.mockReset();
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: putImageDataMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;
    renameEnvironmentFromPromptMock.mockReset();
    renameEnvironmentFromPromptMock.mockImplementation(async () => {});
    openInBrowserMock.mockReset();
    openInBrowserMock.mockImplementation(async () => {});
    updateGlobalConfigMock.mockReset();
    updateGlobalConfigMock.mockImplementation(async (global: any) => ({
      version: "1.0",
      global,
      repositories: {},
    }));
    getClaudeModelCatalogMock.mockReset();
    getClaudeModelCatalogMock.mockImplementation(async (environmentId: string) => ({
      environmentId,
      models: useClaudeStore.getState().models,
      source: "fallback" as const,
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    }));
    getComposeDraftMock.mockReset();
    getComposeDraftMock.mockImplementation(async () => null);
    saveComposeDraftMock.mockReset();
    saveComposeDraftMock.mockImplementation(async (
      draftKey: string,
      ownerType: "environment" | "project",
      ownerId: string,
      value: unknown,
    ) => ({
      draftKey,
      ownerType,
      ownerId,
      value,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    }));
    deleteComposeDraftMock.mockReset();
    deleteComposeDraftMock.mockImplementation(async () => undefined);
    enqueuePromptQueueMessageMock.mockReset();
    enqueuePromptQueueMessageMock.mockImplementation(
      async (queueKey: string, environmentId: string, message: { id: string }) =>
        promptQueueSnapshot(queueKey, environmentId, [
          ...useClaudeTmuxStore
            .getState()
            .getQueuedMessages(promptQueueSessionKey(queueKey)),
          message,
        ]),
    );
    requeuePromptQueueMessageMock.mockReset();
    requeuePromptQueueMessageMock.mockImplementation(
      async (queueKey: string, environmentId: string, message: { id: string }) => {
        const current = useClaudeTmuxStore
          .getState()
          .getQueuedMessages(promptQueueSessionKey(queueKey));
        return promptQueueSnapshot(
          queueKey,
          environmentId,
          current.some((candidate) => candidate.id === message.id)
            ? current
            : [message, ...current],
        );
      },
    );
    removePromptQueueMessageMock.mockReset();
    removePromptQueueMessageMock.mockImplementation(
      async (queueKey: string, environmentId: string, messageId: string) => {
        const current = useClaudeTmuxStore
          .getState()
          .getQueuedMessages(promptQueueSessionKey(queueKey));
        return {
          removed: current.find((message) => message.id === messageId) ?? null,
          queue: promptQueueSnapshot(
            queueKey,
            environmentId,
            current.filter((message) => message.id !== messageId),
          ),
        };
      },
    );
    movePromptQueueMessageMock.mockReset();
    movePromptQueueMessageMock.mockImplementation(
      async (
        queueKey: string,
        environmentId: string,
        messageId: string,
        direction: "up" | "down",
      ) => {
        const messages = [
          ...useClaudeTmuxStore
            .getState()
            .getQueuedMessages(promptQueueSessionKey(queueKey)),
        ];
        const index = messages.findIndex((message) => message.id === messageId);
        const target = direction === "up" ? index - 1 : index + 1;
        if (index >= 0 && target >= 0 && target < messages.length) {
          [messages[index], messages[target]] = [
            messages[target]!,
            messages[index]!,
          ];
        }
        return promptQueueSnapshot(queueKey, environmentId, messages);
      },
    );
    retryPromptQueueDispatchMock.mockReset();
    retryPromptQueueDispatchMock.mockImplementation(async (queueKey: string) => {
      const sessionKey = promptQueueSessionKey(queueKey);
      return promptQueueSnapshot(
        queueKey,
        "env-1",
        useClaudeTmuxStore.getState().getQueuedMessages(sessionKey),
      );
    });
    claimedPromptMessages.clear();
    acknowledgePromptQueueClaimMock.mockReset();
    acknowledgePromptQueueClaimMock.mockImplementation(
      async (queueKey: string, environmentId: string, claimToken: string) => {
        claimedPromptMessages.delete(claimToken);
        return promptQueueSnapshot(
          queueKey,
          environmentId,
          useClaudeTmuxStore
            .getState()
            .getQueuedMessages(promptQueueSessionKey(queueKey)),
        );
      },
    );
    rejectPromptQueueClaimMock.mockReset();
    rejectPromptQueueClaimMock.mockImplementation(
      async (queueKey: string, environmentId: string, claimToken: string) => {
        const claimed = claimedPromptMessages.get(claimToken);
        claimedPromptMessages.delete(claimToken);
        const current = useClaudeTmuxStore
          .getState()
          .getQueuedMessages(promptQueueSessionKey(queueKey));
        return promptQueueSnapshot(
          queueKey,
          environmentId,
          claimed ? [claimed, ...current] : current,
        );
      },
    );
    claimPromptQueueHeadMock.mockReset();
    claimPromptQueueHeadMock.mockImplementation(async (
      queueKey: string,
      environmentId: string,
      _expectedMessageId: string,
      candidateMessages: Array<{ id: string }>,
    ) => {
      const claimed = candidateMessages[0] ?? null;
      const claimToken = claimed ? `claim-${claimed.id}` : null;
      if (claimed && claimToken) claimedPromptMessages.set(claimToken, claimed);
      return {
        claimed,
        claimToken,
        queue: promptQueueSnapshot(
          queueKey,
          environmentId,
          candidateMessages.slice(1),
        ),
      };
    });
    startSessionMock.mockClear();
    getStatusMock.mockClear();
    getStatusMock.mockImplementation(async () => null);
    getTranscriptMock.mockClear();
    getTranscriptMock.mockImplementation(async () => []);
    getPendingHooksMock.mockClear();
    getPendingHooksMock.mockImplementation(async () => []);
    subscribedHandler = null;
    lastVirtuosoProps = null;
    virtuosoScrollToIndexMock.mockClear();
    virtuosoScrollToMock.mockClear();
    virtuosoGetStateMock.mockClear();
    virtuosoGetStateMock.mockImplementation((callback: (snapshot: any) => void) => {
      callback({ ranges: [], scrollTop: 0 });
    });
    subscribeMock.mockClear();
    stopSessionMock.mockClear();
    interruptSessionMock.mockClear();
    capturePaneMock.mockClear();
    sendKeysMock.mockClear();
    answerSelectionPromptMock.mockClear();
    replyHookMock.mockClear();
    submitMock.mockClear();
    switchModelMock.mockClear();
    switchEffortMock.mockClear();
    switchFastModeMock.mockClear();
    switchPlanModeMock.mockClear();
    answerPreToolUseMock.mockClear();
    listPreviousSessionsMock.mockClear();
    interactiveTerminalRenderMock.mockClear();
    capturePaneMock.mockImplementation(async () => "");
    submitMock.mockImplementation(async () => {});
    switchModelMock.mockImplementation(async () => {});
    switchEffortMock.mockImplementation(async () => {});
    switchFastModeMock.mockImplementation(async () => {});
    switchPlanModeMock.mockImplementation(async (_tabId: string, planMode: boolean, _environmentId?: string) =>
      planMode ? "plan" : "bypassPermissions",
    );
    listPreviousSessionsMock.mockImplementation(async () => [
      {
        session_id: "resume-1",
        title: "Previous audit",
        last_activity_unix: Math.floor(Date.now() / 1000),
        message_count: 7,
      },
    ]);
    useClaudeTmuxStore.setState({
      tabs: new Map(),
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
      effortLevels: new Map(),
    });
    usePromptDraftStore.getState().reset();
    // The tmux tab prefers the live SDK model list shared via the claude
    // store; keep it empty by default so tests exercise the fallback list.
    useClaudeStore.setState({ models: [], modelCatalogs: new Map() });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "claude-sonnet-4-6",
        },
        repositories: {},
      },
    }));
    clearPersistedVirtuosoState("claude-tmux-tab-1");
    clearPersistedVirtuosoState("claude-tmux-env:env-1:tab:tab-1");
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      sessionActivated: new Set(),
    });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });
    seedPane("Run the audit");
  });

  test("renders a friendly catalog label for the transcript-confirmed assistant model", async () => {
    const catalogModel: ClaudeModel = {
      id: "sonnet",
      resolvedModel: "claude-sonnet-5",
      name: "Claude Sonnet",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    };
    useClaudeStore.setState({ models: [catalogModel], modelCatalogs: new Map() });
    seedPane();
    mockRunningTmuxStatus();
    getTranscriptMock.mockResolvedValue([
      {
        type: "assistant",
        uuid: "assistant-with-model",
        timestamp: "2026-07-28T12:00:00.000Z",
        message: {
          role: "assistant",
          content: "Catalog-attributed tmux response",
          model: "claude-sonnet-5",
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByTitle("Claude Sonnet")).toBeTruthy();
    expect(screen.queryByText("claude-sonnet-5")).toBeNull();
  });

  test("jumps to the bottom when reactivated after an environment switch", async () => {
    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const scroller = await screen.findByTestId("virtuoso-mock");
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    });

    const callsBeforeSwitch = virtuosoScrollToIndexMock.mock.calls.length;
    act(() => {
      useUIStore.setState({ selectedEnvironmentId: "env-2" });
    });
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive={false}
      />,
    );
    act(() => {
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
    });
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(virtuosoScrollToIndexMock.mock.calls.length).toBeGreaterThan(
        callsBeforeSwitch,
      );
    });
    expect(virtuosoScrollToMock.mock.calls.at(-1)).toEqual([
      { top: 10_000_000, behavior: "auto" },
    ]);
  });

  test("starts once with tabId+envId and clears the tab initialPrompt after the backend sends it", async () => {
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));
    expect(startSessionMock.mock.calls[0]).toEqual([
      "tab-1",
      "env-1",
      {
        initialPrompt: "Run the audit",
        model: "sonnet",
        effort: "high",
        fastMode: false,
        resumeSessionId: undefined,
        replaceExisting: false,
      },
    ]);

    expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]?.initialPrompt).toBe(
      "Run the audit",
    );

    act(() => {
      subscribedHandler?.({
        kind: "initial-prompt-sent",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
      });
    });

    await waitFor(() => {
      expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);
      const tab = usePaneLayoutStore.getState().getAllTabs("env-1")[0];
      expect(tab?.initialPrompt).toBeUndefined();
    });
  });

  test("passes the Default model through initial-prompt auto-start", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "default",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: "Run the audit",
        model: "default",
        effort: "high",
        fastMode: false,
        resumeSessionId: undefined,
        replaceExisting: false,
      });
    });
  });

  test("does not set busy when the backend emits a warning instead of initial-prompt-sent", async () => {
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));

    act(() => {
      subscribedHandler?.({
        kind: "warning",
        tab_id: "tab-1",
        environment_id: "env-1",
        message: "Failed to send initial prompt: tmux session stopped",
      });
    });

    // Busy must remain false — the warning path must not flip the spinner on.
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(false);
  });

  test("does not auto-relaunch when a session stops before its initial prompt is sent", async () => {
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));
    act(() => {
      subscribedHandler?.({
        kind: "started",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        resumed: false,
        fast_mode: false,
      });
      subscribedHandler?.({
        kind: "stopped",
        tab_id: "tab-1",
        environment_id: "env-1",
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start fresh" })).toBeTruthy();
  });

  test("surfaces session start failures and allows a fresh retry", async () => {
    seedPane();
    startSessionMock.mockImplementationOnce(async () => {
      throw new Error("failed to launch tmux");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Start fresh" }));
    expect(await screen.findByText("Error: failed to launch tmux")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(2));
  });

  test("surfaces event subscription failures", async () => {
    seedPane();
    subscribeMock.mockImplementationOnce(async () => {
      throw new Error("event stream unavailable");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Error: event stream unavailable")).toBeTruthy();
  });

  test("cleans up an event subscription that resolves after unmount", async () => {
    let resolveSubscribe!: (unlisten: () => void) => void;
    const unlisten = mock(() => {
      subscribedHandler = null;
    });
    subscribeMock.mockImplementationOnce(async (handler) => {
      subscribedHandler = handler;
      return await new Promise<() => void>((resolve) => {
        resolveSubscribe = resolve;
      });
    });

    const { unmount } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      resolveSubscribe(unlisten);
      await Promise.resolve();
    });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test("does not poll or expose raw pane text in native chat mode", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    expect(capturePaneMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Show TUI" })).toBeNull();
  });

  test("applies lifecycle events and preserves fast mode for a fresh restart", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());
    act(() => {
      subscribedHandler?.({
        kind: "started",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-from-event",
        resumed: true,
        fast_mode: true,
      });
    });

    expect(useClaudeTmuxStore.getState().getTab(stateKey)).toMatchObject({
      running: true,
      sessionId: "session-from-event",
      resumed: true,
    });
    expect(screen.getByRole("button", { name: /speed unknown|⚡/ })).toBeTruthy();

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, true);
      subscribedHandler?.({
        kind: "stopped",
        tab_id: "tab-1",
        environment_id: "env-1",
      });
    });

    expect(useClaudeTmuxStore.getState().getTab(stateKey)).toMatchObject({
      running: false,
      sessionId: null,
      busy: false,
    });
    expect(screen.getByRole("button", { name: /⚡/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ fastMode: true, replaceExisting: true }),
      );
    });
  });

  test("shows elapsed thinking status only while the session is busy and running", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const busyStartedAt = 1_000_000;
    dateNowSpy = spyOn(Date, "now").mockReturnValue(busyStartedAt);
    useClaudeTmuxStore.getState().setBusy(stateKey, true, busyStartedAt);
    dateNowSpy.mockReturnValue(busyStartedAt + 65_000);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      useClaudeTmuxStore.getState().setRunning(stateKey, true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    });

    const indicator = await screen.findByRole("status");
    expect(indicator.textContent).toBe("Claude is thinking...");
    expect(screen.getByText("1m 5s")).toBeTruthy();

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  test("hides the thinking status when the backend reports the session stopped", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    useClaudeTmuxStore.getState().setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().setBusy(stateKey, true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "Claude is thinking...",
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "stopped",
        tab_id: "tab-1",
        environment_id: "env-1",
      });
    });

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(useClaudeTmuxStore.getState().getTab(stateKey)).toMatchObject({
      running: false,
      busy: false,
    });
  });

  test("toggles between native transcript and interactive terminal mode while running", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const terminalButton = await waitFor(() => {
      const button = screen.getByRole("button", { name: /terminal/i });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button;
    });

    fireEvent.click(terminalButton);

    const terminal = screen.getByTestId("tmux-interactive-terminal");
    expect(terminal.getAttribute("data-tab-id")).toBe("tab-1");
    expect(terminal.getAttribute("data-active")).toBe("true");
    // Container/worktree props must be forwarded so clipboard paste targets
    // the right environment.
    expect(terminal.getAttribute("data-container-id")).toBe("container-1");
    // Pinned: useScrollLock's isActive/mountTrigger flip on the interactive
    // toggle causes one extra render on top of the initial mount.
    expect(interactiveTerminalRenderMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /native/i }));

    expect(screen.queryByTestId("tmux-interactive-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: /terminal/i })).toBeTruthy();
  });

  test("captures transcript search only for the focused native chat", async () => {
    mockRunningTmuxStatus();
    const view = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        ownsGlobalShortcuts
      />,
    );

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /terminal/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    fireEvent.keyDown(document, {
      key: "f",
      code: "KeyF",
      metaKey: true,
    });
    expect(screen.getByRole("search", { name: "Find in agent chat" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Find in agent chat" })).toBeNull();

    view.rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        ownsGlobalShortcuts={false}
      />,
    );
    fireEvent.keyDown(document, {
      key: "f",
      code: "KeyF",
      metaKey: true,
    });
    expect(screen.queryByRole("search", { name: "Find in agent chat" })).toBeNull();

    view.rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive={false}
      />,
    );
    fireEvent.keyDown(document, {
      key: "f",
      code: "KeyF",
      metaKey: true,
    });
    expect(screen.queryByRole("search", { name: "Find in agent chat" })).toBeNull();

    view.rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        ownsGlobalShortcuts
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /terminal/i }));
    expect(screen.getByTestId("tmux-interactive-terminal")).toBeTruthy();
    fireEvent.keyDown(document, {
      key: "f",
      code: "KeyF",
      metaKey: true,
    });
    expect(screen.queryByRole("search", { name: "Find in agent chat" })).toBeNull();
  });

  test("surfaces Claude tmux agent tokens in native rows", async () => {
    getTranscriptMock.mockImplementation(async () => [
      {
        type: "assistant",
        uuid: "assistant-agent-1",
        timestamp: "2026-06-25T18:20:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent-1",
              name: "Agent",
              input: {
                description: "Review API-client source modules group 1",
                subagent_type: "Explore",
                prompt: "Read the API client modules and report issues.",
              },
            },
          ],
        },
      },
    ]);
    const pane = `
Running 1 Explore agent...
└ Review API-client source modules group 1 · 8 tool uses · 20.4k tokens
`;
    mockRunningTmuxStatus(pane);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("20.4k tokens")).toBeTruthy();
    expect(screen.queryByText("8 tool uses")).toBeNull();
    expect(screen.queryByText("0 updates")).toBeNull();
  });

  test("keeps successful background launches active while they remain in the tmux roster", async () => {
    getTranscriptMock.mockImplementation(async () => [
      {
        type: "assistant",
        uuid: "assistant-agent-1",
        timestamp: "2026-06-25T18:20:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent-1",
              name: "Agent",
              input: {
                description: "Review db-api test correctness",
                subagent_type: "Explore",
                prompt: "Read the db-api tests and report issues.",
              },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "agent-result-1",
        timestamp: "2026-06-25T18:21:06.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-1",
              content: "done",
            },
          ],
        },
      },
    ]);
    const pane = `
● main
○ Explore  Review db-api test correctness                 1m 6s · ↓ 45.7k tokens
`;
    mockRunningTmuxStatus(pane);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("45.7k tokens")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("0 tools")).toBeNull();
    expect(screen.queryByText("0 updates")).toBeNull();
  });

  test("forwards the worktree path to the interactive terminal for local environments", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Local env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date().toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local-repo",
        },
      ],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", isLocal: true }}
        isActive
      />,
    );

    const terminalButton = await waitFor(() => {
      const button = screen.getByRole("button", { name: /terminal/i });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button;
    });

    fireEvent.click(terminalButton);

    const terminal = screen.getByTestId("tmux-interactive-terminal");
    expect(terminal.getAttribute("data-worktree-path")).toBe("/tmp/local-repo");
    expect(terminal.getAttribute("data-container-id")).toBe("");
  });

  test("attaches pasted clipboard images in the tmux compose bar and submits their paths", async () => {
    mockRunningTmuxStatus();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(writeContainerFileMock).toHaveBeenCalledTimes(1);
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.change(input, { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    expect(submitMock.mock.calls[0]).toEqual([
      "tab-1",
      expect.stringMatching(
        /^what is this\?\n\nAttached images have been saved in the workspace\. Use these image paths as task context:\n- clipboard-.*\.png: \/workspace\/\.orkestrator\/clipboard\/clipboard-.*\.png$/,
      ),
      "env-1",
    ]);
    expect(screen.queryByAltText(/clipboard-/)).toBeNull();
  });

  test("persists tmux composer input under the backend queue interlock key", async () => {
    mockRunningTmuxStatus();
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    fireEvent.change(input, { target: { value: "draft blocks queued work" } });

    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalled());
    const call = saveComposeDraftMock.mock.calls.at(-1);
    expect(call?.[0]).toBe(
      "claude-tmux:env-1:env%3Aenv-1%3Atab%3Atab-1",
    );
    expect(call?.[1]).toBe("environment");
    expect(call?.[2]).toBe("env-1");
    expect(call?.[3]).toMatchObject({
      text: "draft blocks queued work",
      mentions: [],
      attachments: [],
    });
  });

  test("submits a pasted tmux image without text as a single prompt", async () => {
    mockRunningTmuxStatus();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    expect(submitMock.mock.calls[0]).toEqual([
      "tab-1",
      expect.stringMatching(
        /^Attached images have been saved in the workspace\. Use these image paths as task context:\n- clipboard-.*\.png: \/workspace\/\.orkestrator\/clipboard\/clipboard-.*\.png$/,
      ),
      "env-1",
    ]);
  });

  test("submits pasted local worktree images with escaped paths", async () => {
    mockRunningTmuxStatus();
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Local env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date().toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local repo",
        },
      ],
    });
    writeLocalFileMock.mockImplementationOnce(
      async () => "/tmp/local repo/.orkestrator/clipboard/test image.png",
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", isLocal: true }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(writeLocalFileMock).toHaveBeenCalledWith(
        "/tmp/local repo",
        expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
        "QUJD",
      );
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    expect(submitMock.mock.calls[0]).toEqual([
      "tab-1",
      expect.stringContaining(
        "/tmp/local\\ repo/.orkestrator/clipboard/test\\ image.png",
      ),
      "env-1",
    ]);
  });

  test("keeps pasted tmux attachments and draft text when submission fails", async () => {
    mockRunningTmuxStatus();
    submitMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.change(input, { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("what is this?");
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  test("shows a scroll down button when Virtuoso reports the transcript is off-bottom", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(lastVirtuosoProps).toBeTruthy();
    });

    act(() => {
      lastVirtuosoProps?.atBottomStateChange(false);
    });

    const scrollButton = await screen.findByRole("button", {
      name: /scroll to bottom of conversation/i,
    });
    expect(scrollButton).toBeTruthy();

    fireEvent.click(scrollButton);

    await waitFor(() => {
      expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
    });
  });

  test("hides the scroll down button while interactive terminal mode is active", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(lastVirtuosoProps).toBeTruthy();
    });

    act(() => {
      lastVirtuosoProps?.atBottomStateChange(false);
    });
    await screen.findByRole("button", { name: /scroll to bottom of conversation/i });

    // Switch into interactive terminal mode — the Virtuoso transcript unmounts and the
    // scroll-down affordance must disappear with it.
    fireEvent.click(await screen.findByRole("button", { name: /terminal/i }));

    await waitFor(() => {
      expect(screen.getByTestId("tmux-interactive-terminal")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /scroll to bottom of conversation/i }),
      ).toBeNull();
    });
  });

  test("passes transcript updates through the virtualized message window", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "transcript-line",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        line: {
          type: "assistant",
          uuid: "a-new",
          timestamp: "2026-05-15T12:02:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Streaming chunk" }],
          },
        },
      });
    });

    await waitFor(() => {
      expect(lastVirtuosoProps?.data.map((message: any) => message.content)).toContain(
        "Streaming chunk",
      );
    });
    expect(lastVirtuosoProps?.followOutput(true)).toBe("auto");
  });

  test("windows large tmux transcripts through Virtuoso instead of rendering every message", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    getTranscriptMock.mockImplementation(async () =>
      Array.from({ length: 100 }, (_, index) => ({
        type: index % 2 === 0 ? "user" : "assistant",
        uuid: `msg-${index}`,
        timestamp: `2026-05-15T12:${String(index).padStart(2, "0")}:00.000Z`,
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}`,
        },
      })),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(lastVirtuosoProps?.data).toHaveLength(100);
    });
    expect(screen.getAllByText(/^Message \d+$/)).toHaveLength(VIRTUOSO_WINDOW_SIZE);
    expect(screen.queryByText("Message 0")).toBeNull();
    expect(screen.getByText("Message 99")).toBeTruthy();
  });

  test("keeps interactive terminal mode disabled until a tmux session is running", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const terminalButton = screen.getByRole("button", { name: /terminal/i });
    expect((terminalButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(terminalButton);

    expect(screen.queryByTestId("tmux-interactive-terminal")).toBeNull();
  });

  test("retries stale hydration three times before allowing auto-start", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    let attempt = 0;
    getStatusMock.mockImplementation(async () => {
      attempt += 1;
      useClaudeTmuxStore.getState().setBusy(stateKey, attempt % 2 === 1);
      return null;
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Failed to refresh Claude tmux tab/)).toBeNull();
  });

  test("clears stale transcript and hooks for a matching status without a session id", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "stale-session",
    });
    store.applyTranscriptLine(stateKey, {
      type: "assistant",
      uuid: "stale-message",
      message: { role: "assistant", content: "Stale transcript" },
    });
    store.addPendingApproval(stateKey, {
      eventId: "stale-approval",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: null,
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: null,
      resumed: false,
      busy: true,
      permission_mode: "plan",
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab(stateKey);
      expect(tab.running).toBe(true);
      expect(tab.sessionId).toBeNull();
      expect(tab.busy).toBe(true);
      expect(tab.messages).toEqual([]);
      expect(tab.pendingApprovals).toEqual([]);
    });
    expect(getTranscriptMock).not.toHaveBeenCalled();
    expect(getPendingHooksMock).not.toHaveBeenCalled();
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
  });

  test("hydrates a running backend session and replays missed transcript before auto-starting", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
      permission_mode: "plan",
      fast_mode: false,
    }));
    getTranscriptMock.mockImplementation(async () => [
      {
        type: "user",
        uuid: "u-1",
        timestamp: "2026-05-15T12:00:00.000Z",
        message: { role: "user", content: "Run the audit" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-05-15T12:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final result: tests pass." }],
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.sessionId).toBe("session-existing");
      expect(tab.messages.map((m) => m.content)).toEqual([
        "Run the audit",
        "Final result: tests pass.",
      ]);
      expect(tab.busy).toBe(false);
      expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    });

    expect(startSessionMock).not.toHaveBeenCalled();
    act(() => {
      subscribedHandler?.({
        kind: "stopped",
        tab_id: "tab-1",
        environment_id: "env-1",
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  test("rehydrates missed informational events from the authoritative tmux status", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
      permission_mode: "bypassPermissions",
      fast_mode: false,
      info_events: [
        {
          id: "missed-notification",
          kind: "Notification",
          message: "Finished a background check",
          receivedAt: "2026-05-15T12:02:00.000Z",
        },
        {
          id: "missed-stop",
          kind: "Stop",
          message: "Claude finished responding",
          receivedAt: "2026-05-15T12:03:00.000Z",
        },
      ],
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useClaudeTmuxStore.getState().getTab("tab-1").infoEvents).toEqual([
        {
          id: "missed-notification",
          kind: "Notification",
          message: "Finished a background check",
          receivedAt: "2026-05-15T12:02:00.000Z",
        },
        {
          id: "missed-stop",
          kind: "Stop",
          message: "Claude finished responding",
          receivedAt: "2026-05-15T12:03:00.000Z",
        },
      ]);
    });
    expect(screen.queryByText("Finished a background check")).toBeNull();
  });

  test("does not let a stale hydration response overwrite a live fast-mode event", async () => {
    const firstStatus = deferred<any>();
    let statusReads = 0;
    getStatusMock.mockImplementation(async () => {
      statusReads += 1;
      if (statusReads === 1) return await firstStatus.promise;
      return {
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        tmux_session: "orkestrator-env1-tab1",
        running: true,
        transcript_path: "/tmp/session-existing.jsonl",
        resumed: false,
        busy: false,
        permission_mode: "bypassPermissions",
        fast_mode: true,
      };
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());
    act(() => {
      subscribedHandler?.({
        kind: "fast-mode-changed",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        fast_mode: true,
      });
      firstStatus.resolve({
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        tmux_session: "orkestrator-env1-tab1",
        running: true,
        transcript_path: "/tmp/session-existing.jsonl",
        resumed: false,
        busy: false,
        permission_mode: "bypassPermissions",
        fast_mode: false,
      });
    });

    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /Default.*⚡/ })).toBeTruthy();
  });

  test("does not restore stale Fast mode after a live event turns it off", async () => {
    const firstStatus = deferred<any>();
    let statusReads = 0;
    getStatusMock.mockImplementation(async () => {
      statusReads += 1;
      if (statusReads === 1) return await firstStatus.promise;
      return {
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        tmux_session: "orkestrator-env1-tab1",
        running: true,
        transcript_path: "/tmp/session-existing.jsonl",
        resumed: false,
        busy: false,
        permission_mode: "bypassPermissions",
        fast_mode: false,
      };
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());
    act(() => {
      subscribedHandler?.({
        kind: "fast-mode-changed",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        fast_mode: false,
      });
      firstStatus.resolve({
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        tmux_session: "orkestrator-env1-tab1",
        running: true,
        transcript_path: "/tmp/session-existing.jsonl",
        resumed: false,
        busy: false,
        permission_mode: "bypassPermissions",
        fast_mode: true,
      });
    });

    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Default.*\(High\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /⚡/ })).toBeNull();
  });

  test("refresh requests replace the transcript with the latest backend snapshot", async () => {
    seedPane();
    mockRunningTmuxStatus();
    let transcript = [
      {
        type: "assistant",
        uuid: "stale-message",
        message: { role: "assistant", content: "Stale client copy" },
      },
    ];
    getTranscriptMock.mockImplementation(async () => transcript);

    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={0}
      />,
    );

    await screen.findByText("Stale client copy");
    transcript = [
      {
        type: "assistant",
        uuid: "server-message",
        message: { role: "assistant", content: "Updated by another client" },
      },
    ];

    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={1}
      />,
    );

    await screen.findByText("Updated by another client");
    expect(screen.queryByText("Stale client copy")).toBeNull();
    expect(getStatusMock).toHaveBeenCalledTimes(2);
  });

  test("reports manual refresh failures without clearing the current transcript", async () => {
    seedPane();
    mockRunningTmuxStatus();
    getTranscriptMock.mockResolvedValue([
      {
        type: "assistant",
        uuid: "current-message",
        message: { role: "assistant", content: "Keep the current transcript" },
      },
    ]);

    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={0}
      />,
    );
    await screen.findByText("Keep the current transcript");
    getTranscriptMock.mockRejectedValue(new Error("transcript unavailable"));

    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={1}
      />,
    );

    expect(
      await screen.findByText(
        "Failed to refresh Claude tmux tab: transcript unavailable",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Keep the current transcript")).toBeTruthy();
  });

  test("clears tmux state when a manual refresh confirms the session is missing", async () => {
    seedPane();
    mockRunningTmuxStatus();
    getTranscriptMock.mockResolvedValue([
      {
        type: "assistant",
        uuid: "current-message",
        message: { role: "assistant", content: "Session transcript" },
      },
    ]);

    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={0}
      />,
    );
    await screen.findByText("Session transcript");
    getStatusMock.mockResolvedValue(null);

    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.running).toBe(false);
      expect(tab.messages).toEqual([]);
    });
    expect(screen.queryByText("Session transcript")).toBeNull();
  });

  test("does not overwrite a live tmux event with an older refresh snapshot", async () => {
    seedPane();
    mockRunningTmuxStatus();
    getTranscriptMock.mockResolvedValue([
      {
        type: "assistant",
        uuid: "current-message",
        message: { role: "assistant", content: "Current transcript" },
      },
    ]);
    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={0}
      />,
    );
    await screen.findByText("Current transcript");
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    let resolveTranscript!: (lines: realTmuxClient.TranscriptLine[]) => void;
    const transcriptPromise = new Promise<realTmuxClient.TranscriptLine[]>((resolve) => {
      resolveTranscript = resolve;
    });
    getTranscriptMock.mockImplementation(() => transcriptPromise);
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(getTranscriptMock).toHaveBeenCalledTimes(2));

    act(() => {
      subscribedHandler?.({
        kind: "transcript-line",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        line: {
          type: "assistant",
          uuid: "live-message",
          message: { role: "assistant", content: "Live event wins" },
        },
      });
    });
    await screen.findByText("Live event wins");

    await act(async () => {
      resolveTranscript([]);
      await transcriptPromise;
    });

    expect(
      await screen.findByText(
        "Failed to refresh Claude tmux tab: Claude tmux session changed while refreshing; try again",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Live event wins")).toBeTruthy();
  });

  test("hydrates backend busy state and pending hook prompts", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: true,
    }));
    getPendingHooksMock.mockImplementation(async () => [
      {
        id: "q-hook",
        kind: "PreToolUse",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
        },
      },
      {
        id: "perm-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "bun test" },
          permission_suggestions: [],
        },
      },
      {
        id: "question-permission-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(true);
      expect(tab.pendingQuestions).toHaveLength(1);
      expect(tab.pendingQuestions[0]!.eventId).toBe("q-hook");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("perm-hook");
    });
    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "question-permission-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
            }),
          }),
        }),
        "env-1",
      );
    });
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  test("auto-allows AskUserQuestion PermissionRequest hooks without rendering the legacy permission card", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "question-permission-hook",
        event_kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      });
    });

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "question-permission-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
            }),
          }),
        }),
        "env-1",
      );
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingPermissions).toEqual([]);
    expect(screen.queryByText("Claude needs permission")).toBeNull();
  });

  test("hydrates ExitPlanMode with its authoritative deadline", async () => {
    const requestedAt = 1_900_000_000_000;
    dateNowSpy = spyOn(Date, "now").mockReturnValue(requestedAt);
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: true,
    }));
    getPendingHooksMock.mockImplementation(async () => [{
      id: "plan-hydrated",
      kind: "PreToolUse",
      requestedAt,
      expiresAt: requestedAt + 90_000,
      payload: {
        tool_name: "ExitPlanMode",
        tool_input: { plan: "Ship it" },
      },
    }]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await within(
      await screen.findByRole("group", { name: "Claude plan ready for review" }),
    ).findByLabelText("Time remaining 1:30")).toBeTruthy();
    expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingPlans[0])
      .toMatchObject({ requestedAt, expiresAt: requestedAt + 90_000 });
  });

  test("keeps a recoverable permission card when hydrated AskUserQuestion PermissionRequest auto-allow fails", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    getPendingHooksMock.mockImplementation(async () => [
      {
        id: "question-permission-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      },
    ]);
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge unavailable");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("question-permission-hook");
    });
    expect(await screen.findByText("Claude needs permission")).toBeTruthy();
  });

  test("keeps a recoverable permission card when live AskUserQuestion PermissionRequest auto-allow fails", async () => {
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "question-permission-hook",
        event_kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      });
    });

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("question-permission-hook");
    });
    expect(await screen.findByText("Claude needs permission")).toBeTruthy();
  });

  test("hydrates pending hook snapshot as authoritative and clears stale prompts", async () => {
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "stale",
      toolName: "Bash",
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingApprovals).toEqual([]);
    });
  });

  test("routes live lifecycle and actionable hook events into authoritative state", async () => {
    const requestedAt = 1_900_000_000_000;
    const expiresAt = requestedAt + 90_000;
    dateNowSpy = spyOn(Date, "now").mockReturnValue(requestedAt);
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "prompt-submit",
        event_kind: "UserPromptSubmit",
        payload: {},
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "question-live",
        event_kind: "PreToolUse",
        requested_at: requestedAt,
        expires_at: expiresAt,
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
        },
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "plan-live",
        event_kind: "PreToolUse",
        requested_at: requestedAt,
        expires_at: expiresAt,
        payload: {
          tool_name: "ExitPlanMode",
          tool_input: { plan: "Ship the implementation" },
        },
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "approval-live",
        event_kind: "PreToolUse",
        requested_at: requestedAt,
        expires_at: expiresAt,
        payload: {
          tool_name: "Bash",
          tool_input: { command: "bun test" },
        },
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "permission-live",
        event_kind: "PermissionRequest",
        requested_at: requestedAt,
        expires_at: expiresAt,
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/tmp/result.txt" },
          permission_suggestions: [],
        },
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "elicitation-live",
        event_kind: "Elicitation",
        requested_at: requestedAt,
        expires_at: expiresAt,
        payload: {
          mcp_server_name: "docs-mcp",
          message: "Choose a format",
          mode: "form",
          requested_schema: {
            type: "object",
            properties: { format: { type: "string", title: "Format" } },
          },
        },
      });
    });

    const tab = useClaudeTmuxStore.getState().getTab("tab-1");
    expect(tab.busy).toBe(true);
    expect(tab.pendingQuestions.map((item) => item.eventId)).toEqual([
      "question-live",
    ]);
    expect(tab.pendingPlans.map((item) => item.eventId)).toEqual(["plan-live"]);
    expect(tab.pendingApprovals.map((item) => item.eventId)).toEqual([
      "approval-live",
    ]);
    expect(tab.pendingPermissions.map((item) => item.eventId)).toEqual([
      "permission-live",
    ]);
    expect(tab.pendingElicitations.map((item) => item.eventId)).toEqual([
      "elicitation-live",
    ]);
    expect(tab.pendingElicitations[0]).toMatchObject({
      mcpServerName: "docs-mcp",
      message: "Choose a format",
    });
    expect(screen.getByText("Claude wants to use a tool")).toBeTruthy();
    expect(screen.getByText("Claude needs permission")).toBeTruthy();
    expect(screen.getByText("MCP server requested input")).toBeTruthy();
    for (const name of [
      "Claude needs your input",
      "Claude plan ready for review",
      "Claude wants to use Bash",
      "Claude needs permission",
      "Claude MCP input request",
    ]) {
      expect(
        within(screen.getByRole("group", { name })).getByLabelText("Time remaining 1:30"),
      ).toBeTruthy();
    }
  });

  test("keeps busy during SubagentStop and clears it on top-level Stop", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setBusy("tab-1", true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "subagent-stop",
        event_kind: "SubagentStop",
        payload: {},
      });
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "stop",
        event_kind: "Stop",
        payload: {},
      });
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(false);
  });

  test("does not render non-actionable hook notifications above the transcript", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "session-start",
        event_kind: "SessionStart",
        payload: {},
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "notification",
        event_kind: "Notification",
        payload: { message: "Background note" },
      });
    });

    expect(useClaudeTmuxStore.getState().getTab("tab-1").infoEvents).toEqual([
      expect.objectContaining({
        id: "notification",
        kind: "Notification",
        message: "Background note",
      }),
    ]);
    expect(screen.queryByText("SessionStart")).toBeNull();
    expect(screen.queryByText("Background note")).toBeNull();
  });

  test("normalizes default informational hook messages and timestamps", async () => {
    dateNowSpy = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "default-notification",
        event_kind: "Notification",
        payload: {},
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "default-stop",
        event_kind: "Stop",
        payload: {},
        requested_at: 1_700_000_000_000,
      });
    });

    expect(useClaudeTmuxStore.getState().getTab("tab-1").infoEvents).toEqual([
      {
        id: "default-notification",
        kind: "Notification",
        message: "Claude sent a notification",
        receivedAt: new Date(1_800_000_000_000).toISOString(),
      },
      {
        id: "default-stop",
        kind: "Stop",
        message: "Claude finished responding",
        receivedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  test("collapses re-delivered informational hooks and keeps a dismissal sticky", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    const deliver = (message: string) => {
      act(() => {
        subscribedHandler?.({
          kind: "hook",
          tab_id: "tab-1",
          environment_id: "env-1",
          session_id: "session-1",
          event_id: "notification",
          event_kind: "Notification",
          payload: { message },
          requested_at: 1_700_000_000_000,
        });
      });
    };
    const infoEvents = () => useClaudeTmuxStore.getState().getTab("tab-1").infoEvents;

    // The backend de-duplicates its retained snapshot but still emits a frame
    // per delivery, so a re-delivery must replace rather than stack.
    deliver("Background note");
    deliver("Background note");
    expect(infoEvents()).toEqual([
      expect.objectContaining({ id: "notification", message: "Background note" }),
    ]);

    act(() => {
      useClaudeTmuxStore.getState().dismissInfoEvent("tab-1", "notification");
    });
    expect(infoEvents()).toEqual([]);

    // Dismissal means "I have seen this". Neither another live delivery nor an
    // authoritative rehydration may bring the card back.
    deliver("Background note");
    expect(infoEvents()).toEqual([]);
    act(() => {
      useClaudeTmuxStore.getState().replacePendingHooks("tab-1", {
        approvals: [],
        questions: [],
        plans: [],
        permissions: [],
        elicitations: [],
        infoEvents: [{
          id: "notification",
          kind: "Notification",
          message: "Background note",
          receivedAt: new Date(1_700_000_000_000).toISOString(),
        }, {
          id: "other",
          kind: "Notification",
          message: "Still new",
          receivedAt: new Date(1_700_000_000_000).toISOString(),
        }],
      });
    });
    expect(infoEvents()).toEqual([
      expect.objectContaining({ id: "other", message: "Still new" }),
    ]);
  });

  test("removes each pending hook card when the backend reports a timeout", async () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.addPendingApproval("tab-1", {
      eventId: "pre-timeout",
      toolName: "Bash",
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    store.addPendingQuestion("tab-1", {
      eventId: "pre-timeout",
      questions: [],
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    store.addPendingPlan("tab-1", {
      eventId: "pre-timeout",
      plan: "Pending plan",
      planFilePath: null,
      allowedPrompts: [],
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    store.addPendingPermission("tab-1", {
      eventId: "permission-timeout",
      toolName: "Bash",
      toolInput: {},
      permissionSuggestions: [],
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    store.addPendingElicitation("tab-1", {
      eventId: "elicitation-timeout",
      mcpServerName: "docs-mcp",
      message: "Input needed",
      mode: "form",
      url: null,
      requestedSchema: null,
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook-timed-out",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "pre-timeout",
        event_kind: "PreToolUse",
      });
      subscribedHandler?.({
        kind: "hook-timed-out",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "permission-timeout",
        event_kind: "PermissionRequest",
      });
      subscribedHandler?.({
        kind: "hook-timed-out",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "elicitation-timeout",
        event_kind: "Elicitation",
      });
    });

    const tab = useClaudeTmuxStore.getState().getTab("tab-1");
    expect(tab.pendingApprovals).toEqual([]);
    expect(tab.pendingQuestions).toEqual([]);
    expect(tab.pendingPlans).toEqual([]);
    expect(tab.pendingPermissions).toEqual([]);
    expect(tab.pendingElicitations).toEqual([]);
  });

  test("autofocuses the compose input on desktop but not on mobile", () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    const desktop = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(/Ask Claude anything/),
    );

    desktop.unmount();
    setMobileViewport(true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(document.activeElement).not.toBe(
      screen.getByPlaceholderText(/Ask Claude anything/),
    );
  });

  test("typing / opens the built-in slash command menu and selecting one fills the input", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Menu opens with the builtin list visible.
    const slashHeader = await screen.findByText("Slash Commands");
    expect(slashHeader).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/model")).toBeTruthy();

    // Filtering narrows the list.
    fireEvent.change(textarea, { target: { value: "/com" } });
    await waitFor(() => {
      expect(screen.queryByText("/clear")).toBeNull();
      expect(screen.getByText("/compact")).toBeTruthy();
    });

    // Clicking inserts the command and a trailing space.
    fireEvent.click(screen.getByText("/compact"));
    expect(textarea.value).toBe("/compact ");
  });

  test("supports slash command keyboard navigation, Tab selection, and Escape dismissal", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });
    await screen.findByText("Slash Commands");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/bug ");

    fireEvent.change(textarea, { target: { value: "/" } });
    await screen.findByText("Slash Commands");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await waitFor(() => {
      expect(screen.getByText("/clear").closest("button")?.className).toContain(
        "bg-zinc-800/80",
      );
    });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await waitFor(() => {
      expect(screen.getByText("/bug").closest("button")?.className).toContain(
        "bg-zinc-800/80",
      );
    });
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(textarea.value).toBe("/bug ");

    fireEvent.change(textarea, { target: { value: "/" } });
    await screen.findByText("Slash Commands");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByText("Slash Commands")).toBeNull();
  });

  test("inserts a selected @ file mention into the tmux compose input", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    getFileTreeMock.mockResolvedValue([
      {
        name: "src",
        path: "src",
        isDirectory: true,
        children: [
          {
            name: "Button.tsx",
            path: "src/components/Button.tsx",
            isDirectory: false,
            extension: ".tsx",
          },
        ],
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;

    const cursorPosition = "Review @".length;
    fireEvent.change(textarea, {
      target: {
        value: "Review @",
        selectionStart: cursorPosition,
        selectionEnd: cursorPosition,
      },
    });
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    fireEvent.click(textarea);

    await screen.findByText("Button.tsx");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("Review @src/components/Button.tsx ");
    });
    expect(useClaudeTmuxStore.getState().getDraftMentions("tab-1")[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(screen.queryByText("Button.tsx")).toBeNull();
  });

  test("serializes tmux @ file references to full environment paths before submit", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    getFileTreeMock.mockResolvedValue([
      {
        name: "src",
        path: "src",
        isDirectory: true,
        children: [
          {
            name: "Button.tsx",
            path: "src/components/Button.tsx",
            isDirectory: false,
            extension: ".tsx",
          },
        ],
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    const cursorPosition = "Review @".length;
    fireEvent.change(textarea, {
      target: {
        value: "Review @",
        selectionStart: cursorPosition,
        selectionEnd: cursorPosition,
      },
    });
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    fireEvent.click(textarea);

    await screen.findByText("Button.tsx");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(textarea.value).toBe("Review @src/components/Button.tsx ");
    });

    submitMock.mockClear();
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Review /workspace/src/components/Button.tsx",
        "env-1",
      );
    });
  });

  test("preserves and escapes absolute tmux @ file references before submit", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setDraftText(stateKey, "Review @/tmp/My File.ts");
    store.setDraftMentions(stateKey, [
      {
        id: "absolute-file",
        filename: "My File.ts",
        relativePath: "/tmp/My File.ts",
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Review /tmp/My\\ File.ts",
        "env-1",
      );
    });
  });

  test("deduplicates selected file mentions and removes metadata when mention text is deleted", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setDraftText(
      stateKey,
      "Review @src/components/Button.tsx and @",
    );
    store.setDraftMentions(stateKey, [
      {
        id: "existing-file",
        filename: "Button.tsx",
        relativePath: "src/components/Button.tsx",
      },
    ]);
    getFileTreeMock.mockResolvedValue([
      {
        name: "Button.tsx",
        path: "src/components/Button.tsx",
        isDirectory: false,
        extension: ".tsx",
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    const cursorPosition = textarea.value.length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    fireEvent.click(textarea);
    await screen.findByText("Button.tsx");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(useClaudeTmuxStore.getState().getDraftMentions(stateKey)).toEqual([
        {
          id: "existing-file",
          filename: "Button.tsx",
          relativePath: "src/components/Button.tsx",
        },
      ]);
      expect(textarea.value).toBe(
        "Review @src/components/Button.tsx and @src/components/Button.tsx ",
      );
    });

    fireEvent.change(textarea, {
      target: {
        value: "Review the component",
        selectionStart: "Review the component".length,
        selectionEnd: "Review the component".length,
      },
    });

    expect(useClaudeTmuxStore.getState().getDraftMentions(stateKey)).toEqual([]);
  });

  test("removes a staged tmux attachment from the compose bar", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.addAttachment(stateKey, {
      id: "attachment-1",
      type: "image",
      path: "/workspace/diagram.png",
      previewUrl: "data:image/png;base64,QUJD",
      name: "diagram.png",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByAltText("diagram.png")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Remove attachment"));

    expect(screen.queryByAltText("diagram.png")).toBeNull();
    expect(useClaudeTmuxStore.getState().getAttachments(stateKey)).toEqual([]);
  });

  test("reopens file mention detection when cursor navigation enters an @ token", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    getFileTreeMock.mockResolvedValue([
      {
        name: "Button.tsx",
        path: "src/Button.tsx",
        isDirectory: false,
        extension: ".tsx",
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    const value = "Review @src before shipping";
    fireEvent.change(textarea, {
      target: {
        value,
        selectionStart: value.length,
        selectionEnd: value.length,
      },
    });
    expect(screen.queryByText("Button.tsx")).toBeNull();

    const cursorPosition = "Review @src".length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    fireEvent.keyUp(textarea, { key: "ArrowLeft" });

    expect(await screen.findByText("Button.tsx")).toBeTruthy();
  });

  test("does not rewrite non-file @ references in tmux prompts", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "Install @opencode-ai/sdk and contact @example.com",
        selectionStart: "Install @opencode-ai/sdk and contact @example.com".length,
        selectionEnd: "Install @opencode-ai/sdk and contact @example.com".length,
      },
    });

    submitMock.mockClear();
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Install @opencode-ai/sdk and contact @example.com",
        "env-1",
      );
    });
  });

  test("loads @ file suggestions from a local worktree when no container is present", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Local env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date().toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local-repo",
        },
      ],
    });
    getLocalFileTreeMock.mockResolvedValue([
      {
        name: "local.ts",
        path: "src/local.ts",
        isDirectory: false,
        extension: ".ts",
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", isLocal: true }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "@",
        selectionStart: 1,
        selectionEnd: 1,
      },
    });

    await waitFor(() => {
      expect(getLocalFileTreeMock).toHaveBeenCalledWith("/tmp/local-repo");
    });
    expect(await screen.findByText("local.ts")).toBeTruthy();
    expect(getFileTreeMock).not.toHaveBeenCalled();
  });

  test("keeps Enter from submitting while an empty @ file mention menu is open", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "@missing",
        selectionStart: "@missing".length,
        selectionEnd: "@missing".length,
      },
    });

    submitMock.mockClear();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(submitMock).not.toHaveBeenCalled();
    expect(textarea.value).toBe("@missing");
  });

  test("switches the running tmux model through Claude's slash command", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const modelButton = screen.getByRole("button", {
      name: /Sonnet/,
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.pointerDown(modelButton);
    const fableOption = await screen.findByText("Fable");
    await act(async () => {
      fireEvent.click(fableOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "claude-fable-5[1m]",
        "env-1",
      );
    });
    expect(screen.getByRole("button", { name: /Fable/ })).toBeTruthy();
  });

  test("switches a running tmux session to the Default model", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const defaultOption = (await screen.findByText("Default (recommended)")).closest(
      "[role='menuitemradio']",
    );

    expect(defaultOption).toBeTruthy();
    expect(
      defaultOption?.getAttribute("aria-disabled") === "true" ||
        defaultOption?.hasAttribute("data-disabled"),
    ).toBe(false);

    await act(async () => {
      fireEvent.click(defaultOption!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "default",
        "env-1",
      );
    });
    await waitFor(() => {
      expect(updateGlobalConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "default" }),
      );
      expect(useConfigStore.getState().config.global.claudeModel).toBe("default");
    });
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();
  });

  test("uses the pre-launch model selection when starting fresh", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    const modelButton = screen.getByRole("button", {
      name: /Sonnet/,
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.pointerDown(modelButton);
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
    });
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "haiku",
        effort: undefined,
        fastMode: false,
        resumeSessionId: undefined,
        replaceExisting: true,
      });
    });
  });

  test("seeds fresh tmux sessions from the persisted Claude model default", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "haiku",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Haiku/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "haiku",
        effort: undefined,
        fastMode: false,
        resumeSessionId: undefined,
        replaceExisting: true,
      });
    });
  });

  test("maps a legacy persisted opus model id onto the Default sentinel", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "claude-opus-4-7",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ model: "default" }),
      );
    });
  });

  test("passes the persisted Default model explicitly when starting Claude Code", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "default",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "default",
        effort: "high",
        fastMode: false,
        resumeSessionId: undefined,
        replaceExisting: true,
      });
    });
  });

  test("persists selected tmux model as the default for later sessions", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(updateGlobalConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "haiku" }),
      );
      expect(useConfigStore.getState().config.global.claudeModel).toBe(
        "haiku",
      );
    });

    cleanup();
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-2"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: /Haiku/ })).toBeTruthy();
  });

  test("rolls back the persisted tmux model preference when saving fails", async () => {
    seedPane();
    updateGlobalConfigMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useConfigStore.getState().config.global.claudeModel).toBe(
        "claude-sonnet-4-6",
      );
    });
    expect(await screen.findByText("Failed to save Claude model default")).toBeTruthy();
  });

  test("locks compose and model controls while a model switch is in flight", async () => {
    let resolveSubmit!: () => void;
    switchModelMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello after switch" } });

    const modelButton = screen.getByRole("button", {
      name: /Sonnet/,
    }) as HTMLButtonElement;
    fireEvent.pointerDown(modelButton);
    const fableOption = await screen.findByText("Fable");
    await act(async () => {
      fireEvent.click(fableOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "claude-fable-5[1m]",
        "env-1",
      );
      expect(textarea.disabled).toBe(true);
      expect(
        screen.getByRole("button", { name: /Sonnet/ }),
      ).toHaveProperty("disabled", true);
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));
    expect(switchModelMock).toHaveBeenCalledTimes(1);
    expect(submitMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveSubmit();
    });

    await waitFor(() => {
      expect(textarea.disabled).toBe(false);
      expect(screen.getByRole("button", { name: /Fable/ })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });

  test("shows an error and keeps the previous model when model switching fails", async () => {
    switchModelMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const modelButton = screen.getByRole("button", {
      name: /Sonnet/,
    }) as HTMLButtonElement;
    fireEvent.pointerDown(modelButton);
    const fableOption = await screen.findByText("Fable");
    await act(async () => {
      fireEvent.click(fableOption);
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Sonnet/ })).toHaveProperty(
        "disabled",
        false,
      );
    });
    expect(screen.queryByRole("button", { name: /Fable/ })).toBeNull();
  });

  test("passes the selected reasoning effort to the tmux launch", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /\(High\)/ }));
    const maxOption = await screen.findByText("Max");
    await act(async () => {
      fireEvent.click(maxOption);
    });

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "sonnet",
        effort: "max",
        fastMode: false,
        resumeSessionId: undefined,
        replaceExisting: true,
      });
    });
  });

  test("consumes one-shot model and effort without replaying them after remount", async () => {
    seedPane(undefined, "claude-fable-5[1m]", "max");
    const firstMount = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialAgentModel="claude-fable-5[1m]"
        initialReasoningEffort="max"
      />,
    );

    expect(await screen.findByRole("button", { name: /Fable/ })).toBeTruthy();
    await waitFor(() => {
      expect(useClaudeTmuxStore.getState().effortLevels.get("env:env-1:tab:tab-1")).toBe("max");
      expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]).toMatchObject({
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
      });
    });

    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "sonnet" },
      },
    }));
    useClaudeTmuxStore.getState().setEffortLevel("env:env-1:tab:tab-1", "low");
    firstMount.unmount();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: /Sonnet/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /\(Low\)/ })).toBeTruthy();
  });

  test("holds a one-shot model that only the live SDK catalog knows, then applies it", async () => {
    // `tmuxModelList` substitutes the bundled fallback list when the SDK catalog
    // has not arrived, so "not loaded yet" and "loaded" are indistinguishable by
    // length. Resolving the one-shot model against the fallback list would
    // collapse it to the Default sentinel and consume it — after which the live
    // catalog arriving would prefer the persisted global model instead.
    useClaudeStore.setState({ models: [], modelCatalogs: new Map() });
    seedPane(undefined, "claude-newer-opus", "high");

    const view = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialAgentModel="claude-newer-opus"
        initialReasoningEffort="high"
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    // Still unconsumed: the tab keeps the option so a remount can retry.
    expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]).toMatchObject({
      initialAgentModel: "claude-newer-opus",
    });

    // Publish through the env-scoped catalog: the tab reads
    // `modelCatalogs.get(env)?.models ?? models`, and the backend catalog fetch
    // has already written an empty entry for this environment.
    await waitFor(() => {
      expect(getClaudeModelCatalogMock).toHaveBeenCalledWith("env-1", false);
      expect(useClaudeStore.getState().getModelCatalog("env-1")?.models).toEqual([]);
    });
    await act(async () => {
      useClaudeStore.getState().setModelCatalog({
        environmentId: "env-1",
        models: [
          {
            id: "claude-newer-opus",
            name: "Newer Opus",
            description: "from the SDK",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        ],
        source: "sdk",
        fetchedAt: "2026-07-25T12:00:00.000Z",
        stale: false,
      });
      await Promise.resolve();
    });

    expect(await screen.findByRole("button", { name: /Newer Opus/ })).toBeTruthy();
    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]).toMatchObject({
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
      });
    });
    view.unmount();
  });

  test("consumes a one-shot model the fallback catalog can already honour", async () => {
    // The mirror of the test above: no need to wait for the SDK when the
    // bundled list can honour the choice, otherwise every offline tmux launch
    // would hold its options forever.
    useClaudeStore.setState({ models: [], modelCatalogs: new Map() });
    seedPane(undefined, "claude-fable-5[1m]", "max");

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialAgentModel="claude-fable-5[1m]"
        initialReasoningEffort="max"
      />,
    );

    expect(await screen.findByRole("button", { name: /Fable/ })).toBeTruthy();
    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]).toMatchObject({
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
      });
    });
  });

  test("switches the running session effort through Claude's /effort command", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const effortButton = screen.getByRole("button", {
      name: /\(High\)/,
    }) as HTMLButtonElement;
    expect(effortButton.disabled).toBe(false);

    fireEvent.pointerDown(effortButton);
    const lowOption = await screen.findByText("Low");
    await act(async () => {
      fireEvent.click(lowOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchEffortMock).toHaveBeenCalledWith("tab-1", "low", "env-1");
    });
    expect(screen.getByRole("button", { name: /\(Low\)/ })).toBeTruthy();
  });

  test("keeps the previous effort and shows an error when effort switching fails", async () => {
    switchEffortMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /\(High\)/ }));
    const lowOption = await screen.findByText("Low");
    await act(async () => {
      fireEvent.click(lowOption);
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /\(High\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\(Low\)/ })).toBeNull();
  });

  test("switches fast mode through Claude's explicit /fast command", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    const fastItem = await screen.findByRole("menuitemradio", {
      name: /^Fast Lower latency/,
    });
    expect(fastItem.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(fastItem);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchFastModeMock).toHaveBeenCalledWith("tab-1", true, "env-1");
    });
    expect(screen.getByRole("button", { name: /Default.*\(High ⚡\)/ })).toBeTruthy();
  });

  test("switches a running tmux session back to Normal", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());
    act(() => {
      subscribedHandler?.({
        kind: "fast-mode-changed",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        fast_mode: true,
      });
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*⚡/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", {
      name: /^Normal Standard speed/,
    }));
    await waitFor(() => {
      expect(switchFastModeMock).toHaveBeenCalledWith("tab-1", false, "env-1");
    });
    expect(screen.getByRole("button", { name: /Default.*\(High\)/ })).toBeTruthy();
  });

  test("renders an unknown speed from the authoritative hydration snapshot", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
      permission_mode: "bypassPermissions",
      fast_mode: null,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: /speed unknown/ })).toBeTruthy();
  });

  test("passes a pre-launch fast-mode selection to the new tmux session", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemradio", {
        name: /^Fast Lower latency/,
      }));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ model: "default", fastMode: true }),
      );
    });
    expect(switchFastModeMock).not.toHaveBeenCalled();
  });

  test("clears a pre-launch fast selection before starting an unsupported model", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", {
      name: /^Fast Lower latency/,
    }));
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*⚡/ }));
    fireEvent.click(await screen.findByText("Haiku"));
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ model: "haiku", fastMode: false }),
      );
    });
    expect(switchFastModeMock).not.toHaveBeenCalled();
  });

  test("keeps model and speed controls locked while Claude is thinking", () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    useClaudeTmuxStore.getState().setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().setBusy(stateKey, true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const picker = screen.getByRole("button", { name: /Default.*\(High\)/ });
    expect(picker.hasAttribute("disabled")).toBe(true);
    fireEvent.pointerDown(picker);
    expect(switchFastModeMock).not.toHaveBeenCalled();
  });

  test("keeps the confirmed speed and exposes an error when a live fast switch fails", async () => {
    switchFastModeMock.mockImplementationOnce(async () => {
      throw new Error("fast mode unavailable");
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemradio", {
        name: /^Fast Lower latency/,
      }));
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: fast mode unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Default.*\(High\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /⚡/ })).toBeNull();
  });

  test("locks competing tmux controls while a fast-mode switch is pending", async () => {
    const pendingSwitch = deferred<void>();
    switchFastModeMock.mockImplementationOnce(async () => await pendingSwitch.promise);
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemradio", {
        name: /^Fast Lower latency/,
      }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask Claude anything/)).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Interrupt" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: /Default.*\(High\)/ })).toHaveProperty("disabled", true);
    });
    expect(submitMock).not.toHaveBeenCalled();

    await act(async () => pendingSwitch.resolve());
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask Claude anything/)).toHaveProperty("disabled", false);
      expect(screen.getByRole("button", { name: /⚡/ })).toBeTruthy();
    });
  });

  test("turns fast mode off before switching to a model that does not support it", async () => {
    const operations: string[] = [];
    switchFastModeMock.mockImplementation(async (_tabId, enabled) => {
      operations.push(`fast:${enabled}`);
    });
    switchModelMock.mockImplementation(async (_tabId, model) => {
      operations.push(`model:${model}`);
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemradio", {
        name: /^Fast Lower latency/,
      }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /⚡/ })).toBeTruthy());

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*⚡/ }));
    await act(async () => {
      fireEvent.click(await screen.findByText("Sonnet"));
      await Promise.resolve();
    });

    await waitFor(() => expect(switchModelMock).toHaveBeenCalled());
    expect(operations).toEqual(["fast:true", "fast:false", "model:sonnet"]);
    expect(screen.getByRole("button", { name: /Sonnet/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /⚡/ })).toBeNull();
  });

  test("does not switch models when disabling fast mode is rejected", async () => {
    switchFastModeMock.mockImplementation(async (_tabId, enabled) => {
      if (!enabled) throw new Error("could not disable fast mode");
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemradio", {
        name: /^Fast Lower latency/,
      }));
      await Promise.resolve();
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*⚡/ }));
    await act(async () => {
      fireEvent.click(await screen.findByText("Sonnet"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: could not disable fast mode")).toBeTruthy();
    expect(switchModelMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Default.*⚡/ })).toBeTruthy();
  });

  test("keeps the previous model in Normal mode when its switch fails after disabling Fast", async () => {
    switchModelMock.mockImplementationOnce(async () => {
      throw new Error("model switch failed");
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "default" },
      },
    }));
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*\(High\)/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemradio", {
        name: /^Fast Lower latency/,
      }));
      await Promise.resolve();
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default.*⚡/ }));
    await act(async () => {
      fireEvent.click(await screen.findByText("Sonnet"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: model switch failed")).toBeTruthy();
    expect(switchFastModeMock).toHaveBeenLastCalledWith("tab-1", false, "env-1");
    expect(screen.getByRole("button", { name: /Default.*\(High\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /⚡/ })).toBeNull();
  });

  test("hides the effort control for models without effort support", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /\(High\)/ })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
    });

    expect(screen.queryByRole("button", { name: /\(High\)/ })).toBeNull();
  });

  test("resets effort to the default when the new model doesn't support the chosen level", async () => {
    seedPane();
    useClaudeStore.setState({
      models: [
        {
          id: "default",
          name: "Default (recommended)",
          description: "Opus 5 with 1M context",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "sonnet",
          name: "Sonnet",
          description: "SDK model with a restricted effort ladder",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ] as ClaudeModel[],
    });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "default",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /\(High\)/ }));
    const xhighOption = await screen.findByText("Extra High");
    await act(async () => {
      fireEvent.click(xhighOption);
    });
    expect(screen.getByRole("button", { name: /\(Extra High\)/ })).toBeTruthy();

    // This SDK-provided Sonnet entry has no xhigh level, so the preference
    // snaps back to the default.
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));
    const sonnetOption = await screen.findByText("Sonnet");
    await act(async () => {
      fireEvent.click(sonnetOption);
    });

    expect(screen.getByRole("button", { name: /\(High\)/ })).toBeTruthy();
  });

  test("offers Opus 5 in the tmux fallback catalog", async () => {
    seedPane();
    useClaudeStore.setState({ models: [] });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));

    expect(await screen.findByText("Opus (1M context)")).toBeTruthy();
    expect(screen.queryByText(/Opus 4\.8/)).toBeNull();
  });

  test("rehydrates the environment-scoped authoritative model catalog", async () => {
    seedPane();
    getClaudeModelCatalogMock.mockResolvedValueOnce({
      environmentId: "env-1",
      models: [
        {
          id: "claude-opus-5",
          resolvedModel: "claude-opus-5-20260701",
          name: "Authoritative Opus 5",
          description: "Discovered from the managed Claude runtime",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
      ],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
      stale: false,
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(getClaudeModelCatalogMock).toHaveBeenCalledWith("env-1", false);
      expect(useClaudeStore.getState().getModels("env-1")[0]?.id).toBe(
        "claude-opus-5",
      );
      expect(useClaudeStore.getState().models[0]?.id).toBe("claude-opus-5");
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));
    expect(await screen.findByText("Authoritative Opus 5")).toBeTruthy();
    expect(screen.queryByText("Opus (1M context)")).toBeNull();
  });

  test("keeps the host last-known-good when catalog rehydration returns fallback models", async () => {
    seedPane();
    const hostModel = { id: "host-last-known-good", name: "Host LKG" };
    const fallbackModel = { id: "claude-fallback", name: "Bundled fallback" };
    useClaudeStore.setState({ models: [hostModel], modelCatalogs: new Map() });
    getClaudeModelCatalogMock.mockResolvedValueOnce({
      environmentId: "env-1",
      models: [fallbackModel],
      source: "fallback",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
      error: "SDK discovery unavailable",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().getModels("env-1")).toEqual([
        fallbackModel,
      ]);
    });
    expect(useClaudeStore.getState().models).toEqual([hostModel]);
  });

  test("projects a successful catalog refresh after the initiating tab unmounts", async () => {
    seedPane();
    const pendingCatalog = deferred<{
      environmentId: string;
      models: ClaudeModel[];
      source: "sdk";
      fetchedAt: string;
      stale: false;
    }>();
    const discoveredModel = { id: "claude-opus-5", name: "Claude Opus 5" };
    getClaudeModelCatalogMock.mockImplementationOnce(
      async () => pendingCatalog.promise,
    );

    const view = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(getClaudeModelCatalogMock).toHaveBeenCalledWith("env-1", false);
    });
    view.unmount();
    pendingCatalog.resolve({
      environmentId: "env-1",
      models: [discoveredModel],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    });

    await waitFor(() => {
      expect(useClaudeStore.getState().models).toEqual([discoveredModel]);
      expect(useClaudeStore.getState().getModels("env-1")).toEqual([
        discoveredModel,
      ]);
    });
  });

  test("ignores an older catalog response after a newer refresh completes", async () => {
    seedPane();
    const olderCatalog = deferred<any>();
    const newerModel = { id: "claude-newest", name: "Newest Claude" };
    getClaudeModelCatalogMock
      .mockImplementationOnce(async () => olderCatalog.promise)
      .mockResolvedValueOnce({
        environmentId: "env-1",
        models: [newerModel],
        source: "sdk",
        fetchedAt: "2026-07-25T12:01:00.000Z",
        stale: false,
      });

    const view = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={0}
      />,
    );
    await waitFor(() => {
      expect(getClaudeModelCatalogMock).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => {
      expect(useClaudeStore.getState().models).toEqual([newerModel]);
    });

    olderCatalog.resolve({
      environmentId: "env-1",
      models: [{ id: "claude-stale", name: "Stale Claude" }],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    });
    await act(async () => {
      await olderCatalog.promise;
      await Promise.resolve();
    });

    expect(useClaudeStore.getState().models).toEqual([newerModel]);
  });

  test("keeps the bundled model catalog when authoritative rehydration fails", async () => {
    seedPane();
    getClaudeModelCatalogMock.mockRejectedValueOnce(
      new Error("model catalog unavailable"),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    await waitFor(() => {
      expect(getClaudeModelCatalogMock).toHaveBeenCalledWith("env-1", false);
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    expect(await screen.findByText("Opus (1M context)")).toBeTruthy();
    expect(screen.getByText("Fable")).toBeTruthy();
    expect(screen.queryByText(/model catalog unavailable/i)).toBeNull();
    expect(useClaudeStore.getState().getModelCatalog("env-1")).toBeUndefined();
  });

  test("prefers the live SDK model list and prepends the Default sentinel when missing", async () => {
    seedPane();
    const sdkModels: ClaudeModel[] = [
      {
        id: "claude-newer-opus",
        name: "Newer Opus",
        description: "from the SDK",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
      { id: "claude-newer-haiku", name: "Newer Haiku", description: "from the SDK" },
    ];
    useClaudeStore.setState({ models: sdkModels });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    // The persisted "claude-sonnet-4-6" preference resolves to "sonnet",
    // which the SDK list doesn't know, so the selection snaps to the
    // prepended Default sentinel.
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));

    expect(await screen.findByText("Newer Opus")).toBeTruthy();
    expect(screen.getByText("Newer Haiku")).toBeTruthy();
    // Fallback-only entries are replaced by the live list.
    expect(screen.queryByText("Opus (1M context)")).toBeNull();
    expect(screen.queryByText("Fable")).toBeNull();
  });

  test("uses the SDK list as-is when it already includes the Default sentinel", async () => {
    seedPane();
    useClaudeStore.setState({
      models: [
        {
          id: "default",
          name: "Default (SDK)",
          description: "from the SDK",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        { id: "claude-newer-haiku", name: "Newer Haiku" },
      ] as ClaudeModel[],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    // The SDK's own default entry wins over the fallback sentinel.
    expect(screen.getByRole("button", { name: /Default \(SDK\)/ })).toBeTruthy();
  });

  test("uses the standard effort ladder when a model supports effort without listing levels", async () => {
    seedPane();
    useClaudeStore.setState({
      models: [
        {
          id: "default",
          name: "Default (SDK)",
          supportsEffort: true,
        },
      ] as ClaudeModel[],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: /\(High\)/ }));

    expect(await screen.findByText("Low")).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(screen.queryByText("Extra High")).toBeNull();
    expect(screen.queryByText("Max")).toBeNull();
  });

  test("falls back to the first supported level when a model's levels exclude the default", async () => {
    seedPane();
    useClaudeStore.setState({
      models: [
        {
          id: "default",
          name: "Default (recommended)",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "claude-mini",
          name: "Mini",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium"],
        },
      ] as ClaudeModel[],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));
    const miniOption = await screen.findByText("Mini");
    await act(async () => {
      fireEvent.click(miniOption);
    });

    // "high" isn't in Mini's level list, so the stored preference snaps to
    // the first supported level instead of an unsupported default.
    expect(screen.getByRole("button", { name: /\(Low\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\(High\)/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ model: "claude-mini", effort: "low" }),
      );
    });
  });

  test("switches the running tmux TUI between plan and build mode", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const planButton = screen.getByRole("button", {
      name: /Build/,
    }) as HTMLButtonElement;

    expect(planButton.disabled).toBe(false);
    fireEvent.pointerDown(planButton);
    const planOption = await screen.findByRole("menuitem", { name: "Plan" });
    await act(async () => {
      fireEvent.click(planOption);
    });

    await waitFor(() => {
      expect(switchPlanModeMock).toHaveBeenCalledWith("tab-1", true, "env-1");
      expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Plan" }));
    const buildOption = await screen.findByRole("menuitem", { name: "Build" });
    await act(async () => {
      fireEvent.click(buildOption);
    });

    await waitFor(() => {
      expect(switchPlanModeMock).toHaveBeenLastCalledWith("tab-1", false, "env-1");
      expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();
    });
  });

  test("keeps build mode and restores controls when a mode switch fails", async () => {
    switchPlanModeMock.mockImplementationOnce(async () => {
      throw new Error("mode switch failed");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Build" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Plan" }));

    expect(await screen.findByText("Error: mode switch failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Interrupt" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  test("disables compose and all competing input controls while mode switching", async () => {
    let resolveSwitch!: (mode: string) => void;
    switchPlanModeMock.mockImplementationOnce(
      async () => await new Promise<string>((resolve) => {
        resolveSwitch = resolve;
      }),
    );
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Build" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Plan" }));
    await waitFor(() => expect(switchPlanModeMock).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("button", { name: "Build" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /Sonnet/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /\(High\)/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Interrupt" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByPlaceholderText(/Ask Claude anything/)).toHaveProperty(
      "disabled",
      true,
    );

    await act(async () => {
      resolveSwitch("plan");
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Plan" })).toHaveProperty(
        "disabled",
        false,
      );
      expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty(
        "disabled",
        false,
      );
      expect(screen.getByRole("button", { name: "Interrupt" })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });

  test("uses the backend's returned permission mode instead of the requested toggle", async () => {
    switchPlanModeMock.mockImplementationOnce(async () => "acceptEdits");
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Build" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Plan" }));

    await waitFor(() => {
      expect(switchPlanModeMock).toHaveBeenCalledWith("tab-1", true, "env-1");
      expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();
    });
  });

  test("tracks permission events, transcript updates, and stopped sessions", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "permission-mode-changed",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        permission_mode: "plan",
      });
    });
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();

    act(() => {
      subscribedHandler?.({
        kind: "transcript-line",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        line: { type: "permission-mode", permissionMode: "acceptEdits" },
      });
    });
    expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();

    act(() => {
      subscribedHandler?.({
        kind: "permission-mode-changed",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        permission_mode: "plan",
      });
      subscribedHandler?.({
        kind: "stopped",
        tab_id: "tab-1",
        environment_id: "env-1",
      });
    });
    expect(screen.getByRole("button", { name: "Build" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Interrupt" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  test("does not let stale hydration overwrite a live permission event", async () => {
    let resolveTranscript!: (lines: realTmuxClient.TranscriptLine[]) => void;
    getStatusMock.mockImplementationOnce(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-1",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-1.jsonl",
      resumed: false,
      busy: false,
      permission_mode: "bypassPermissions",
    }));
    getTranscriptMock.mockImplementationOnce(
      async () => await new Promise<realTmuxClient.TranscriptLine[]>((resolve) => {
        resolveTranscript = resolve;
      }),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    await waitFor(() => {
      expect(getTranscriptMock).toHaveBeenCalledTimes(1);
      expect(subscribedHandler).not.toBeNull();
    });

    act(() => {
      subscribedHandler?.({
        kind: "permission-mode-changed",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        permission_mode: "plan",
      });
    });
    await act(async () => {
      resolveTranscript([
        { type: "permission-mode", permissionMode: "bypassPermissions" },
      ]);
      await Promise.resolve();
    });

    await waitFor(() => expect(getPendingHooksMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
  });

  test("starts a previous session from the resume picker", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Resume previous session/ }));
    expect(await screen.findByText("Previous audit")).toBeTruthy();
    fireEvent.click(screen.getByText("Previous audit"));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "sonnet",
        effort: "high",
        fastMode: false,
        resumeSessionId: "resume-1",
        replaceExisting: true,
      });
    });
  });

  test("passes the persisted Default model through the resume picker", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "default",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Resume previous session/ }));
    fireEvent.click(await screen.findByText("Previous audit"));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "default",
        effort: "high",
        fastMode: false,
        resumeSessionId: "resume-1",
        replaceExisting: true,
      });
    });
  });

  test("interrupts the running tmux session from the header", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));

    expect(interruptSessionMock).toHaveBeenCalledWith("tab-1", "env-1");
    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  test("reorders and removes queued tmux prompts from the queue dialog", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    seedQueuedPrompt(store, stateKey, { id: "queue-1", text: "first queued", attachments: [] });
    seedQueuedPrompt(store, stateKey, { id: "queue-2", text: "second queued", attachments: [] });
    seedQueuedPrompt(store, stateKey, { id: "queue-3", text: "third queued", attachments: [] });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByText("+3 queued"));
    await screen.findByText("first queued");

    fireEvent.click(screen.getAllByTitle("Move down")[0]!);
    await waitFor(() => {
      expect(
        useClaudeTmuxStore
          .getState()
          .getQueuedMessages(stateKey)
          .map((message) => message.text),
      ).toEqual(["second queued", "first queued", "third queued"]);
    });

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[1]!);
    await waitFor(() => {
      expect(
        useClaudeTmuxStore
          .getState()
          .getQueuedMessages(stateKey)
          .map((message) => message.text),
      ).toEqual(["second queued", "third queued"]);
    });
    expect(screen.queryByText("first queued")).toBeNull();
  });

  test("surfaces a parked tmux dispatch error and retries it explicitly", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    seedQueuedPrompt(store, stateKey, {
      id: "queue-1",
      text: "review the ambiguous submit",
      attachments: [],
    });
    publishTmuxQueueSnapshot(stateKey, {
      requestId: "request-1",
      messageId: "queue-1",
      messageFingerprint: "a".repeat(64),
      message: "Submission may have partially completed. Review the pane before retrying.",
      failedAt: "2026-08-04T10:00:00.000Z",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const blockedIndicator = await screen.findByRole("button", {
      name: /1 queued prompts blocked: Submission may have partially completed/,
    });
    fireEvent.click(blockedIndicator);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Review the pane before retrying.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(retryPromptQueueDispatchMock).toHaveBeenCalledWith(
        promptQueueKey("claude-tmux", stateKey),
      );
      expect(screen.getByText("+1 queued").closest("button")?.getAttribute("aria-label"))
        .toBeNull();
    });
  });

  test("reports queue dialog mutation failures and keeps the projected queue intact", async () => {
    movePromptQueueMessageMock.mockRejectedValue(
      new Error("move storage unavailable"),
    );
    removePromptQueueMessageMock.mockRejectedValue(
      new Error("remove storage unavailable"),
    );
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    seedQueuedPrompt(store, stateKey, {
      id: "queue-1",
      text: "first queued",
      attachments: [],
    });
    seedQueuedPrompt(store, stateKey, {
      id: "queue-2",
      text: "second queued",
      attachments: [],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByText("+2 queued"));
    fireEvent.click((await screen.findAllByTitle("Move down"))[0]!);
    expect(
      await screen.findByText("Failed to move queued prompt: move storage unavailable"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("first queued"));
    expect(
      await screen.findByText("Failed to edit queued prompt: remove storage unavailable"),
    ).toBeTruthy();

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[0]!);
    expect(
      await screen.findByText("Failed to remove queued prompt: remove storage unavailable"),
    ).toBeTruthy();
    expect(
      useClaudeTmuxStore
        .getState()
        .getQueuedMessages(stateKey)
        .map((message) => message.id),
    ).toEqual(["queue-1", "queue-2"]);
  });

  test("clicking a queued tmux prompt restores its text and attachments for editing", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    seedQueuedPrompt(store, stateKey, {
      id: "queue-image",
      text: "edit queued with image",
      attachments: [
        {
          id: "att-1",
          type: "image",
          path: "/workspace/diagram.png",
          previewUrl: "data:image/png;base64,diagram",
          name: "diagram.png",
        },
      ],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByText("+1 queued"));
    fireEvent.click(await screen.findByText("edit queued with image"));

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText(/Ask Claude anything/) as HTMLTextAreaElement).value,
      ).toBe("edit queued with image");
      expect(screen.getByAltText("diagram.png")).toBeTruthy();
      expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey)).toEqual([]);
    });
  });

  test("interrupt promotes the next queued tmux prompt to the draft", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    seedQueuedPrompt(store, stateKey, {
      id: "queue-first",
      text: "edit after interrupt",
      attachments: [],
    });
    seedQueuedPrompt(store, stateKey, {
      id: "queue-second",
      text: "stay queued",
      attachments: [],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByTitle("Interrupt current response"));

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText(/Ask Claude anything/) as HTMLTextAreaElement).value,
      ).toBe("edit after interrupt");
      expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey).map((m) => m.text)).toEqual([
        "stay queued",
      ]);
      expect(useClaudeTmuxStore.getState().getTab(stateKey).busy).toBe(false);
    });
    expect(interruptSessionMock).toHaveBeenCalledWith("tab-1", "env-1");
    expect(submitMock).not.toHaveBeenCalled();
  });

  test("interrupt promotes a queued prompt migrated from a legacy tab key", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy("tab-1", true);
    seedQueuedPrompt(store, "tab-1", {
      id: "legacy-interrupt",
      text: "migrated interrupt draft",
      attachments: [],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByTitle("Interrupt current response"));

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText(/Ask Claude anything/) as HTMLTextAreaElement).value,
      ).toBe("migrated interrupt draft");
      expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey)).toEqual([]);
      expect(useClaudeTmuxStore.getState().tabs.has("tab-1")).toBe(false);
    });
    expect(interruptSessionMock).toHaveBeenCalledWith("tab-1", "env-1");
  });

  test("shows interrupt errors without clearing busy state", async () => {
    interruptSessionMock.mockImplementationOnce(async () => {
      throw new Error("interrupt failed");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setBusy("tab-1", true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByTitle("Interrupt current response"));

    expect(await screen.findByText("Error: interrupt failed")).toBeTruthy();
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);
  });

  test("shows submit errors and re-enables compose after a failed prompt", async () => {
    submitMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => expect(textarea.disabled).toBe(false));
  });

  test("renders no dangling model label for an empty assistant placeholder", async () => {
    // End-to-end over the real VirtualizedMessageList and real NativeMessage.
    // `compactConsecutiveAssistantMessages` already merges a placeholder into
    // the content that follows it, so the case that survives to the renderer is
    // a placeholder with nothing after it — which must render no row at all
    // rather than a model label floating above blank space.
    const messages: ClaudeMessageType[] = [
      {
        id: "msg-user",
        role: "user" as const,
        content: "Question",
        parts: [{ type: "text" as const, content: "Question" }],
        createdAt: "2026-03-07T12:00:00.000Z",
      },
      {
        id: "msg-empty",
        role: "assistant" as const,
        content: "",
        parts: [],
        createdAt: "2026-03-07T12:00:20.000Z",
        modelId: "claude-test-model",
      },
    ];
    const current = useClaudeTmuxStore.getState().getTab("tab-1");
    useClaudeTmuxStore.setState({
      tabs: new Map([
        [
          "tab-1",
          {
            ...current,
            environmentId: "env-1",
            sessionId: "session-1",
            running: true,
            busy: false,
            messages,
          },
        ],
      ]),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Question")).toBeTruthy();
    expect(screen.queryByText("claude-test-model")).toBeNull();
  });

  test("attributes a compacted reply once and dates it from the block's first message", async () => {
    // The tab compacts consecutive assistant messages, keeping the earliest
    // timestamp, so a `user → placeholder → content` turn reaches the renderer
    // as one row whose duration is measured from the placeholder's arrival.
    const messages: ClaudeMessageType[] = [
      {
        id: "msg-user",
        role: "user" as const,
        content: "Question",
        parts: [{ type: "text" as const, content: "Question" }],
        createdAt: "2026-03-07T12:00:00.000Z",
      },
      {
        id: "msg-empty",
        role: "assistant" as const,
        content: "",
        parts: [],
        createdAt: "2026-03-07T12:00:20.000Z",
        modelId: "claude-test-model",
      },
      {
        id: "msg-content",
        role: "assistant" as const,
        content: "Answer",
        parts: [{ type: "text" as const, content: "Answer" }],
        createdAt: "2026-03-07T12:00:45.000Z",
        modelId: "claude-test-model",
      },
    ];
    const current = useClaudeTmuxStore.getState().getTab("tab-1");
    useClaudeTmuxStore.setState({
      tabs: new Map([
        [
          "tab-1",
          {
            ...current,
            environmentId: "env-1",
            sessionId: "session-1",
            running: true,
            busy: false,
            messages,
          },
        ],
      ]),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Answer")).toBeTruthy();
    expect(screen.getAllByText("claude-test-model")).toHaveLength(1);
    expect(screen.getByText(/responded in 20s/)).toBeTruthy();
  });

  test("review tabs submit the shared Address all follow-up prompt", async () => {
    const message: ClaudeMessageType = {
      id: "msg-review-complete",
      role: "assistant" as const,
      content: "Review complete",
      parts: [{ type: "text" as const, content: "Review complete" }],
      timestamp: "2026-03-07T12:00:00.000Z",
    };
    const store = useClaudeTmuxStore.getState();
    const current = store.getTab("tab-1");
    useClaudeTmuxStore.setState({
      tabs: new Map([
        [
          "tab-1",
          {
            ...current,
            environmentId: "env-1",
            sessionId: "session-1",
            running: true,
            busy: false,
            messages: [message],
          },
        ],
      ]),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        isReviewTab
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        ADDRESS_ALL_REVIEW_PROMPT,
        "env-1",
      );
    });
  });

  test("renames a timestamp-named environment before submitting the first tmux prompt", async () => {
    const callOrder: string[] = [];
    renameEnvironmentFromPromptMock.mockImplementationOnce(async () => {
      callOrder.push("rename");
    });
    submitMock.mockImplementationOnce(async () => {
      callOrder.push("submit");
    });
    seedEnvironment();
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Implement the billing export" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(renameEnvironmentFromPromptMock).toHaveBeenCalledWith(
        "env-1",
        "Implement the billing export",
      );
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Implement the billing export",
        "env-1",
      );
    });
    expect(callOrder).toEqual(["rename", "submit"]);
  });

  test("renames a compact Electron timestamp environment before submitting the first tmux prompt", async () => {
    seedEnvironment({
      name: "202604151234567",
      branch: "202604151234567",
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Implement the billing export" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(renameEnvironmentFromPromptMock).toHaveBeenCalledWith(
        "env-1",
        "Implement the billing export",
      );
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Implement the billing export",
        "env-1",
      );
    });
  });

  test("does not rename a custom-named environment before submitting a tmux prompt", async () => {
    seedEnvironment({ name: "custom-env", branch: "custom-env" });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Keep this branch name" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Keep this branch name",
        "env-1",
      );
    });
    expect(renameEnvironmentFromPromptMock).not.toHaveBeenCalled();
  });

  test("renders compacted assistant messages and passes compacted previousMessage", async () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.applyTranscriptLine("tab-1", {
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "inspect" },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu2", name: "Grep", input: {} }],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "a3",
      timestamp: "2026-01-01T00:00:03Z",
      message: { role: "assistant", content: "done" },
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const renderedMessages = lastVirtuosoProps?.data ?? [];
    expect(renderedMessages).toHaveLength(2);
    expect(renderedMessages[1]!.id).toBe("a1");
    expect(renderedMessages[0]!.id).toBe("u1");
    expect(renderedMessages[1]!.parts.map((part: ClaudeMessageType["parts"][number]) => part.type)).toEqual([
      "tool-group",
      "text",
    ]);
    expect(renderedMessages[1]!.parts[0]?.type).toBe("tool-group");
    if (renderedMessages[1]!.parts[0]?.type === "tool-group") {
      expect(renderedMessages[1]!.parts[0].parts.map((part: ClaudeMessageType["parts"][number]) => part.toolName)).toEqual([
        "Read",
        "Grep",
      ]);
    }
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Grep").length).toBeGreaterThan(0);
    expect(screen.getByText("done")).toBeTruthy();
  });

  test("pins active task-group agents in tmux transcript data and releases them on success", async () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "assistant-agent",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Parent started" },
          {
            type: "tool_use",
            id: "agent-1",
            name: "Agent",
            input: { description: "Tmux worker" },
          },
          { type: "text", text: "Parent continued" },
        ],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "assistant-later",
      timestamp: "2026-01-01T00:00:30Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Later response" }],
      },
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect((lastVirtuosoProps?.data ?? []).map((message: any) => message.id)).toEqual([
      "assistant-agent",
      "assistant-agent:active-agents",
    ]);

    act(() => {
      store.applyTranscriptLine("tab-1", {
        type: "user",
        uuid: "agent-result",
        timestamp: "2026-01-01T00:00:31Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-1",
              content: "done",
              is_error: false,
            },
          ],
        },
      });
    });

    await waitFor(() => {
      const renderedMessages = lastVirtuosoProps?.data ?? [];
      expect(renderedMessages.map((message: any) => message.id)).toEqual([
        "assistant-agent",
      ]);
      expect(renderedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
        "text",
        "task-group",
        "text",
        "text",
      ]);
    });
  });

  test("renders each task tool call with the task list the backend derived", async () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    // tmux mode derives nothing: the backend that reads the transcript replays
    // the task tools and stamps the resulting list on each result line.
    const applyCall = (
      uuid: string,
      timestamp: string,
      toolUse: Record<string, unknown>,
      result: string,
      taskSnapshot: unknown,
    ) => {
      store.applyTranscriptLine("tab-1", {
        type: "assistant",
        uuid,
        timestamp,
        message: { role: "assistant", content: [toolUse] },
      });
      store.applyTranscriptLine("tab-1", {
        type: "user",
        uuid: `${uuid}-result`,
        timestamp,
        taskSnapshots: { [toolUse.id as string]: taskSnapshot },
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUse.id as string, content: result },
          ],
        },
      } as Parameters<typeof store.applyTranscriptLine>[1]);
    };

    applyCall(
      "task-create-1",
      "2026-01-01T00:00:01Z",
      {
        type: "tool_use",
        id: "task-create-1",
        name: "TaskCreate",
        input: { subject: "Inspect renderer" },
      },
      "Task #1 created successfully: Inspect renderer",
      {
        items: [{ id: "1", subject: "Inspect renderer", status: "pending" }],
        complete: true,
        changedTaskId: "1",
      },
    );
    applyCall(
      "task-update-1",
      "2026-01-01T00:00:02Z",
      {
        type: "tool_use",
        id: "task-update-1",
        name: "TaskUpdate",
        input: { taskId: "1", status: "completed" },
      },
      "Updated task #1 status",
      {
        items: [{ id: "1", subject: "Inspect renderer", status: "completed" }],
        complete: true,
        changedTaskId: "1",
      },
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const renderedMessages = lastVirtuosoProps?.data ?? [];
    expect(renderedMessages).toHaveLength(1);
    expect(renderedMessages[0]!.parts[0]?.type).toBe("tool-group");
    if (renderedMessages[0]!.parts[0]?.type === "tool-group") {
      const parts = renderedMessages[0]!.parts[0].parts as ClaudeMessageType["parts"];
      // Both calls survive — nothing is collapsed away — and each carries the
      // list as it stood at that point.
      expect(parts.map((part) => part.toolName)).toEqual(["TaskCreate", "TaskUpdate"]);
      expect(parts.at(-1)?.taskSnapshot?.items).toEqual([
        { id: "1", subject: "Inspect renderer", status: "completed" },
      ]);
    }
    expect(screen.getByText("Task Update")).toBeTruthy();
  });

  test("parses Claude Code in-TUI selection prompts from a tmux pane snapshot", () => {
    const prompt = parseTmuxSelectionPrompt(`
› 1. Kill stale tmux before launch (Recommended)
  2. Always kill before launch
  3. Randomize tmux session name

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);

    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Kill stale tmux before launch (Recommended)",
      "Always kill before launch",
      "Randomize tmux session name",
    ]);
  });

  test("parses only the active TUI option block and shows its question", () => {
    const prompt = parseTmuxSelectionPrompt(`
1. Run \`git diff origin/main...HEAD\` to see all changes that will be in the PR
2. Run \`git log main..HEAD --oneline\` to see all commits
3. Create the PR using: \`gh pr create --base main --fill\`

Two staged files look like they shouldn't be in the PR. How should I handle them?

› 1. Unstage & add to .gitignore (Recommended)
     .codex/hooks.json has session-specific /tmp paths and tsconfig.tsbuildinfo is generated.
  2. Commit them as-is
  3. Unstage only (no .gitignore change)
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);

    expect(prompt?.question).toBe(
      "Two staged files look like they shouldn't be in the PR. How should I handle them?",
    );
    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Unstage & add to .gitignore (Recommended) .codex/hooks.json has session-specific /tmp paths and tsconfig.tsbuildinfo is generated.",
      "Commit them as-is",
      "Unstage only (no .gitignore change)",
      "Type something.",
      "Chat about this",
    ]);
  });

  test("shows controls for Claude Code selection prompts and answers through tmux keys on submit", async () => {
    const pane = `
  1. Kill stale tmux before launch (Recommended)
› 2. Always kill before launch
  3. Randomize tmux session name

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setObservation(
      "tab-1",
      generatedObservation(pane, 1),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Randomize tmux session name/ }),
    );
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(2);
    });
  });

  test("does not render a parsed TUI selection prompt while a native hook question is pending", async () => {
    capturePaneMock.mockImplementation(async () => `
Which framework?

› 1. React
  2. Vue

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude needs your input")).toBeTruthy();
    expect(screen.queryByText("Claude is asking for a choice")).toBeNull();
  });

  test("answers confirmation prompts by sending only the selected option number", async () => {
    capturePaneMock.mockImplementation(async () => `
WARNING: Claude Code running in Bypass Permissions mode

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Yes, I accept/ }));
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(1);
    });
  });

  test("submits the highlighted confirmation option by sending its number", async () => {
    capturePaneMock.mockImplementation(async () => `
WARNING: Claude Code running in Bypass Permissions mode

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(0);
    });
  });

  test("renders the active TUI question without stale numbered transcript lines", async () => {
    capturePaneMock.mockImplementation(async () => `
1. Run \`git diff origin/main...HEAD\` to see all changes that will be in the PR
2. Run \`git log main..HEAD --oneline\` to see all commits

Two staged files look like they shouldn't be in the PR. How should I handle them?

› 1. Unstage & add to .gitignore (Recommended)
  2. Commit them as-is
  3. Unstage only (no .gitignore change)

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(
      await screen.findByText(
        "Two staged files look like they shouldn't be in the PR. How should I handle them?",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /git diff origin\/main/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /Unstage & add to \.gitignore \(Recommended\)/,
      }),
    ).toBeTruthy();
  });

  test("parses confirmation prompts with the full context instead of only the URL", () => {
    const prompt = parseTmuxSelectionPrompt(`
------------------------------------------------------------
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.

By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe(
      [
        "WARNING: Claude Code running in Bypass Permissions mode",
        "",
        "In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.",
        "This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.",
        "",
        "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.",
        "",
        "https://code.claude.com/docs/en/security",
      ].join("\n"),
    );
    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "No, exit",
      "Yes, I accept",
    ]);
  });

  test("submitting a different confirmation answer types its number before enter", async () => {
    capturePaneMock.mockImplementation(async () => `
WARNING: Claude Code running in Bypass Permissions mode

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Yes, I accept/ }));
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => {
      expectSelectionAnswer(1);
    });
  });

  test("duplicate labels still submit the clicked numbered option", async () => {
    capturePaneMock.mockImplementation(async () => `
Choose the retry scope

› 1. Retry
  2. Retry

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    const retryButtons = screen.getAllByRole("button", { name: "Retry" });
    fireEvent.click(retryButtons[1]!);
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(1);
    });
  });

  test("navigates upward when selecting an option above the highlighted TUI option", async () => {
    capturePaneMock.mockImplementation(async () => `
Choose an action

  1. Allow once
  2. Allow this session
› 3. Deny

Enter to confirm · ↑/↓ to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(0);
    });
  });

  test("selection prompts do not show a Dismiss button", async () => {
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  test("keeps selection prompt controls disabled while tmux keys are pending", async () => {
    let resolveSendKeys: (() => void) | null = null;
    answerSelectionPromptMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSendKeys = resolve;
        }),
    );
    const pane = `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`;
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setObservation(
      "tab-1",
      generatedObservation(pane, 1),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    const noButton = screen.getByRole("button", { name: /No, exit/ }) as HTMLButtonElement;
    const yesButton = screen.getByRole("button", { name: /Yes, I accept/ }) as HTMLButtonElement;
    fireEvent.click(yesButton);
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    const submitButton = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submitButton);
    // React has not committed the disabled state yet. The synchronous latch in
    // the handler must still reject a same-tick second submission.
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(answerSelectionPromptMock).toHaveBeenCalledTimes(1);
      expect(yesButton.disabled).toBe(true);
    });

    fireEvent.click(noButton);
    expect(answerSelectionPromptMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSendKeys?.();
    });
    await waitFor(() => {
      expect(screen.queryByText("Claude is asking for a choice")).toBeNull();
    });
  });

  test("uses absolute navigation when the pane does not expose its highlight", async () => {
    const pane = `
  1. Allow once
  2. Allow this session
  3. Deny

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().setObservation(
      "tab-1",
      generatedObservation(pane, 1),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(2);
    });
  });

  test("shows an error and re-enables selection controls when tmux key submission fails", async () => {
    answerSelectionPromptMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    const yesButton = screen.getByRole("button", {
      name: /Yes, I accept/,
    }) as HTMLButtonElement;
    fireEvent.click(yesButton);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => {
      expect(yesButton.disabled).toBe(false);
    });
  });

  test("restores a prompt when the backend re-observes it after key submission", async () => {
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Yes, I accept/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(1);
      expect(
        useClaudeTmuxStore.getState().getTab("tab-1").observation.prompt,
      ).toBeNull();
    });
    const repeatedObservation = generatedObservation(await capturePaneMock(), 2);
    act(() => {
      if (!subscribedHandler) throw new Error("tmux subscription was not established");
      subscribedHandler({
        kind: "observation",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        observation: repeatedObservation,
      });
    });
    expect(
      useClaudeTmuxStore.getState().getTab("tab-1").observation,
    ).toEqual(repeatedObservation);
    expect(screen.getByText("Claude is asking for a choice")).toBeTruthy();
  });

  test("sends each digit for multi-digit numbered confirmation options", async () => {
    let pane = "";
    for (let i = 1; i <= 10; i++) {
      pane += `${i === 1 ? "› " : "  "}${i}. Option ${i}\n`;
    }
    pane += "\nEnter to confirm · Esc to cancel\n";
    capturePaneMock.mockImplementation(async () => pane);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Option 10/ }));
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(9);
    });
  });

  test("defaults to navigate mode when no input-mode hint is present", async () => {
    capturePaneMock.mockImplementation(async () => `
  1. Kill stale tmux before launch (Recommended)
› 2. Always kill before launch

Enter to select · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    await adoptMockedPaneObservation();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    // Submitting the already-selected option should send only Enter (delta = 0).
    fireEvent.click(
      screen.getByRole("button", { name: /Always kill before launch/ }),
    );
    expect(answerSelectionPromptMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expectSelectionAnswer(1);
    });
  });

  test("does not absorb a prior numbered option list into a URL-only question", () => {
    const prompt = parseTmuxSelectionPrompt(`
1. Some earlier listed step
2. Another earlier step
3. A third earlier step

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("does not absorb a bracketed log prefix paragraph into a URL-only question", () => {
    const prompt = parseTmuxSelectionPrompt(`
[INFO] background task complete

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("does not absorb a bare shell prompt paragraph into a URL-only question", () => {
    const prompt = parseTmuxSelectionPrompt(`
node@host$

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("stops question expansion at a ------ boundary line", () => {
    const prompt = parseTmuxSelectionPrompt(`
This earlier paragraph is before the boundary and should not appear.

------------------------------------------------------------

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("strips a boundary immediately preceding the active question", () => {
    const prompt = parseTmuxSelectionPrompt(`
Earlier output that should not be part of the question.

------------------------------------------------------------
Choose the deployment strategy.

› 1. Blue-green
  2. Rolling

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("Choose the deployment strategy.");
  });

  test("preserves an AskUserQuestion option plus custom answer in updatedInput", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.change(screen.getByPlaceholderText(/Type your own answer/i), {
      target: { value: "React, with strict TypeScript 🦊" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: expect.objectContaining({
              answers: {
                "Which framework?": JSON.stringify([
                  "React",
                  "React, with strict TypeScript 🦊",
                ]),
              },
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("maps multi-question and multi-select AskUserQuestion answers", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which frameworks?",
          header: "Frameworks",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: true,
        },
        {
          question: "Any notes?",
          header: "Notes",
          options: [],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which frameworks?",
            header: "Frameworks",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: true,
          },
          {
            question: "Any notes?",
            header: "Notes",
            options: [],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.click(screen.getByRole("button", { name: /Vue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: "Prefer TypeScript-first tooling" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            updatedInput: expect.objectContaining({
              answers: {
                "Which frameworks?": JSON.stringify(["React", "Vue"]),
                "Any notes?": "Prefer TypeScript-first tooling",
              },
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("keeps AskUserQuestion pending when replyHook fails", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText("Error: bridge down")).toBeTruthy();
      expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingQuestions).toHaveLength(1);
    });
  });

  test("dismisses AskUserQuestion hooks with a PreToolUse denial", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
            permissionDecisionReason: "User declined to answer the question.",
          }),
        }),
        "env-1",
      );
      expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingQuestions).toEqual([]);
    });
  });

  test("keeps AskUserQuestion pending when dismissal delivery fails", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "question-retry",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("Error: bridge down")).toBeTruthy();
    expect(
      useClaudeTmuxStore.getState().getTab("tab-1").pendingQuestions,
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("answers plan approvals and change requests", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-hook",
      plan: "## Update the tests\n\n- **Add** edge-case coverage",
      planFilePath: "/tmp/plan.md",
      allowedPrompts: [],
      toolInput: { plan: "Update the tests" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-hook-2",
      plan: "Ship it",
      planFilePath: null,
      allowedPrompts: [],
      toolInput: { plan: "Ship it" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Update the tests" }),
    ).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toBe("Add edge-case coverage");
    expect(screen.getByText("Add").tagName).toBe("STRONG");

    fireEvent.click(screen.getAllByRole("button", { name: "Request changes" })[0]!);
    fireEvent.change(screen.getByPlaceholderText("What should Claude change?"), {
      target: { value: "Add edge cases" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Request changes" })[0]!);

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "plan-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
            permissionDecisionReason: "Add edge cases",
          }),
        }),
        "env-1",
      );
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Approve plan" })).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "plan-hook-2",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "allow",
            updatedInput: { plan: "Ship it" },
          }),
        }),
        "env-1",
      );
    });
  });

  test("restores unfinished plan feedback after the tmux tab remounts", () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-remount",
      plan: "Keep the pending plan",
      planFilePath: null,
      allowedPrompts: [],
      toolInput: { plan: "Keep the pending plan" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    const view = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.change(screen.getByPlaceholderText("What should Claude change?"), {
      target: { value: "Preserve this unfinished feedback" },
    });

    view.unmount();
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(
      (screen.getByPlaceholderText(
        "What should Claude change?",
      ) as HTMLTextAreaElement).value,
    ).toBe("Preserve this unfinished feedback");
  });

  test("opens plan markdown links externally and renders plan permission counts", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-link",
      plan: "Read [the docs](https://example.com/docs).",
      planFilePath: null,
      allowedPrompts: [{ tool: "Bash" }, { tool: "Read" }],
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(1));
    expect(fireEvent.click(screen.getByRole("link", { name: "the docs" }))).toBe(
      false,
    );

    expect(openInBrowserMock).toHaveBeenCalledWith("https://example.com/docs");
    expect(
      screen.getByText("Requests 2 plan-scoped permission prompt(s)."),
    ).toBeTruthy();
  });

  test("keeps a plan pending when its response cannot be delivered", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-retry",
      plan: "Retryable plan",
      planFilePath: null,
      allowedPrompts: [],
      toolInput: { plan: "Retryable plan" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    expect(await screen.findByText("Error: bridge down")).toBeTruthy();
    expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingPlans).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Approve plan" })).toBeTruthy();
  });

  test("answers legacy PreToolUse approval cards", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "approval-hook",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => {
      expect(answerPreToolUseMock).toHaveBeenCalledWith(
        "tab-1",
        "approval-hook",
        "approve",
        undefined,
        "env-1",
      );
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingApprovals).toEqual([]);
  });

  test("renders file-oriented approval paths and content previews", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "file-approval",
      toolName: "Edit",
      toolInput: {
        file_path: "/workspace/src/Button.tsx",
        new_string: "export function Button() {}",
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());
    expect(screen.getByText("/workspace/src/Button.tsx")).toBeTruthy();
    expect(screen.getByText("export function Button() {}")).toBeTruthy();
  });

  test("keeps a legacy PreToolUse approval pending when delivery fails", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "approval-retry",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    answerPreToolUseMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(await screen.findByText("Error: bridge down")).toBeTruthy();
    expect(
      useClaudeTmuxStore.getState().getTab("tab-1").pendingApprovals,
    ).toHaveLength(1);
    expect(screen.getByText("Claude wants to use a tool")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  test("answers PermissionRequest hooks with nested permission decision", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPermission("tab-1", {
      eventId: "perm-hook",
      toolName: "Bash",
      toolInput: { command: "bun test", description: "Run tests" },
      permissionSuggestions: [],
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "perm-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
              updatedInput: { command: "bun test", description: "Run tests" },
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("keeps a denied PermissionRequest pending when delivery fails", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingPermission("tab-1", {
      eventId: "permission-retry",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      permissionSuggestions: [],
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "permission-retry",
        {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "deny",
              message: "Permission denied by user.",
            },
          },
        },
        "env-1",
      );
    });
    expect(await screen.findByText("Error: bridge down")).toBeTruthy();
    expect(
      useClaudeTmuxStore.getState().getTab("tab-1").pendingPermissions,
    ).toHaveLength(1);
    expect(screen.getByText("Claude needs permission")).toBeTruthy();
  });

  test("answers PermissionRequest suggestions as persistent permission updates", async () => {
    const suggestion = { tool: "Bash", command: "bun test" };
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPermission("tab-1", {
      eventId: "perm-suggestion",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      permissionSuggestions: [suggestion],
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "perm-suggestion",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            decision: expect.objectContaining({
              behavior: "allow",
              updatedPermissions: [suggestion],
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("answers MCP Elicitation hooks with form content", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-hook",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: {
        type: "object",
        properties: {
          username: { type: "string", title: "Username" },
        },
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "Elicitation",
        "elicit-hook",
        {
          hookSpecificOutput: {
            hookEventName: "Elicitation",
            action: "accept",
            content: { username: "alice" },
          },
        },
        "env-1",
      );
    });
  });

  test("keeps sensitive MCP elicitation fields out of remountable drafts", async () => {
    const scopedKey = createClaudeTmuxStateKey("env-1", "tab-1");
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-secret",
      mcpServerName: "credentials-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: {
        type: "object",
        properties: {
          username: { type: "string", title: "Username" },
          apiKey: { type: "string", title: "API key" },
          opaque: { type: "string", title: "Opaque secret", writeOnly: true },
          titleOnly: { type: "string", title: "Access token" },
          passphrase: { type: "string", title: "Passphrase" },
        },
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    const draftKey = tmuxElicitationDraftKey(scopedKey, "elicit-secret");
    usePromptDraftStore.getState().setDraftValue(draftKey, "values", {
      username: "alice",
      opaque: "legacy-secret",
    });

    const rendered = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const apiKey = await screen.findByLabelText(/^API key/) as HTMLInputElement;
    const opaque = screen.getByLabelText(/^Opaque secret/) as HTMLInputElement;
    const titleOnly = screen.getByLabelText(/^Access token/) as HTMLInputElement;
    const passphrase = screen.getByLabelText(/^Passphrase/) as HTMLInputElement;
    expect(apiKey.type).toBe("password");
    expect(opaque.type).toBe("password");
    expect(titleOnly.type).toBe("password");
    expect(passphrase.type).toBe("password");
    await waitFor(() => {
      expect(usePromptDraftStore.getState().drafts.get(draftKey)).toEqual({
        values: { username: "alice" },
      });
    });

    fireEvent.change(apiKey, { target: { value: "live-api-secret" } });
    fireEvent.change(opaque, { target: { value: "live-opaque-secret" } });
    expect(usePromptDraftStore.getState().drafts.get(draftKey)).toEqual({
      values: { username: "alice" },
    });

    rendered.unmount();
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );
    expect((await screen.findByLabelText("Username") as HTMLInputElement).value)
      .toBe("alice");
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Opaque secret/) as HTMLInputElement).value).toBe("");
  });

  test("keeps an MCP Elicitation pending when delivery fails", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicitation-retry",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: null,
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(await screen.findByText("Error: bridge down")).toBeTruthy();
    expect(
      useClaudeTmuxStore.getState().getTab("tab-1").pendingElicitations,
    ).toHaveLength(1);
    expect(screen.getByText("MCP server requested input")).toBeTruthy();
  });

  test("declines and cancels MCP Elicitation hooks", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-decline",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: null,
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-cancel",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: null,
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Decline" })[0]!);

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith("tab-1", "Elicitation", "elicit-decline", {
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "decline",
        },
      }, "env-1");
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith("tab-1", "Elicitation", "elicit-cancel", {
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "cancel",
        },
      }, "env-1");
    });
  });
});
