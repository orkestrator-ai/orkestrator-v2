/**
 * Shared setup for the AgentNativeTab suites: the backend fakes, module stubs, hooks
 * and harness components every one of them drives the tab through. The suite was
 * split by topic so that `bun test --parallel` can spread it across workers; the
 * tests themselves are unchanged.
 */
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { afterAll, afterEach, beforeEach, expect, mock } from "bun:test";
import { isValidElement, memo, useEffect, type ReactNode } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { createNativeAgentSessionBackend } from "@/test/native-agent-session-backend";
import { NativeMessage as NativeMessageCard } from "@/components/chat/NativeMessage";
import type { NativeMessageProps } from "@/components/chat/NativeMessage.shared";
import { type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import type {
  AgentAccountLoginProgress,
  AgentAccountsSnapshot,
} from "@orkestrator/protocol/agent-accounts";
import type {
  NativeAgentAuthStatus,
  NativeAgentDispatchOutcome,
  NativeAgentSessionProjection,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import { configStore, type ConfigState } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { paneLayoutStore, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeNoticeDismissalStore } from "@/stores/nativeNoticeDismissalStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { getNativeAgentData, type TabInfo } from "@/types/paneLayout";
import { createAgentHandoffSnapshot, resetAgentHandoffCache } from "@/lib/agent-handoff";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { getReadCoordinator, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { useTerminalContext } from "@/contexts";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { appCommandStore } from "@/test/app-command-store";

/**
 * State that test bodies assign and the fakes below read. An imported binding
 * cannot be assigned from another module, so it lives on an object.
 */
export const fixtureState: {
  renderVirtualizedMessages: boolean;
  accountLoginProgress: AgentAccountLoginProgress;
  agentAccounts: AgentAccountsSnapshot;
} = {
  renderVirtualizedMessages: false,
  accountLoginProgress: { state: "idle" },
  // Assigned after EMPTY_AGENT_ACCOUNTS is declared.
  agentAccounts: undefined as unknown as AgentAccountsSnapshot,
};

// Loaded by `installAgentNativeTabFixture`, after the stubs they depend on.
export let AgentNativeTab: typeof import("./AgentNativeTab").AgentNativeTab;
export let enqueueNativeAsyncQuestionResponse: typeof import("./AgentNativeTab.controller").enqueueNativeAsyncQuestionResponse;
export let SharedNativeAgentController: typeof import("./AgentNativeTab.controller").SharedNativeAgentController;
export let useNativeAgentSession: typeof import("@/hooks/useNativeAgentSession").useNativeAgentSession;

// Snapshot before installing the stubs so the real modules are restored for
// any suite that runs after this file in the same module registry.
const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };
export let virtualizedMessageListRenderCount = 0;
export let latestRenderedMessageActions = new Map<string, ReactNode>();
export let nativeMessageRenderCounts = new Map<string, number>();
const InstrumentedNativeMessage = memo(function InstrumentedNativeMessage(
  props: NativeMessageProps,
) {
  nativeMessageRenderCounts.set(
    props.message.id,
    (nativeMessageRenderCounts.get(props.message.id) ?? 0) + 1,
  );
  return <NativeMessageCard {...props} />;
});
export let latestTranscriptAnnotationProps:
  | {
      enabled: boolean;
      onAdd: (text: string) => unknown;
      onUpdateComment: (id: string, comment: string) => void;
    }
  | undefined;
export const flushPaneLayoutNowMock = mock(async (_environmentId: string, _layout: unknown) => {});
export const getNativeAgentModelCatalogMock = mock(
  async (
    _environmentId: string,
    _ensureAgent?: "cursor" | "grok" | "pi",
  ): ReturnType<typeof realBackend.getNativeAgentModelCatalog> => [],
);
export const getAgentModelCatalogCacheMock = mock(
  async (): ReturnType<typeof realBackend.getAgentModelCatalogCache> => ({ schemaVersion: 1 }),
);
export const awaitBridgeReadyMock = mock(async () => ({
  status: "ready" as const,
  port: 4099,
  authToken: "token",
}));
export const defaultAdoptNativeAgentSession = async (input: {
  agent: string;
  providerSessionId: string;
  logicalSessionKey: string;
  environmentId: string;
}) => ({
  providerSessionId: input.providerSessionId,
  logicalSessionKey: input.logicalSessionKey,
  environmentId: input.environmentId,
  agent: input.agent,
});
export const adoptNativeAgentSessionMock = mock(defaultAdoptNativeAgentSession);
export const forkNativeAgentSessionMock = mock<typeof realBackend.forkNativeAgentSession>(
  async () => ({
    sessionId: "fork-session",
  }),
);
export const beginNativeAgentSignInMock = mock(
  async (_input: { environmentId: string; agent: string; logicalSessionKey: string }) => ({
    url: "https://auth.example.test/login" as string | undefined,
  }),
);
export const cancelNativeAgentSignInMock = mock(
  async (_input: { environmentId: string; agent: string; logicalSessionKey: string }) => ({
    cancelled: true,
  }),
);
export const openInBrowserMock = mock(async (_url: string) => undefined);
export const getNativeAgentAuthStatusMock = mock(
  async (_input: {
    environmentId: string;
    agent: string;
    logicalSessionKey: string;
  }): Promise<NativeAgentAuthStatus | null> => null,
);
export const defaultEnsureNativeAgentSession = async (input: {
  agent: string;
  logicalSessionKey: string;
  environmentId: string;
}) => ({
  providerSessionId: `${input.agent}-session`,
  logicalSessionKey: input.logicalSessionKey,
  environmentId: input.environmentId,
  agent: input.agent,
});
export const ensureNativeAgentSessionMock = mock(defaultEnsureNativeAgentSession);
export const recoverMultiReviewAddressFindingsSessionMock = mock(
  async () =>
    ({
      id: "multi-1",
      backendRevision: 2,
    }) as never,
);
export const listNativeAgentResumableSessionsMock = mock(
  async (_input: Parameters<typeof realBackend.listNativeAgentResumableSessions>[0]) => [],
);
export const setNativeAgentResumableSessionArchivedMock = mock(
  async (_input: Parameters<typeof realBackend.setNativeAgentResumableSessionArchived>[0]) => ({
    archived: true,
  }),
);
export const getAgentHandoffMock = mock(async (_handoffId: string): Promise<unknown> => null);
export const getAgentHandoffCapabilitiesMock = mock(async () => ({
  create: false,
  delivery: false,
  pruning: false,
}));
export const getNativeAgentSignInResendMock = mock(async () => ({ pending: false }));
export const performNativeAgentSessionActionMock = mock(
  async (_input: {
    agent: string;
    action: { kind: string; text?: string };
  }): Promise<{ outcome: "applied"; deliveredAs?: "new-turn" | "queued"; requestId?: string }> => ({
    outcome: "applied" as const,
  }),
);
export const steerNativeAgentQueuedPromptMock = mock(
  async (_input: {
    agent: string;
    messageId: string;
  }): Promise<
    import("@orkestrator/protocol/native-agent").NativeAgentSessionActionOutcome | null
  > => ({ outcome: "applied" }),
);
export const enqueuePromptQueueMessageMock = mock(async () => {});
export const removePromptQueueMessageMock = mock(async () => {});
const movePromptQueueMessageMock = mock(async () => {});
export const dismissNativeAgentSuggestedPromptMock = mock(async () =>
  sessionProjectionMock({ agent: "claude", environmentId: "env-1" }),
);
export const updateNativeAgentControlsMock = mock(
  async (_input: { update: Record<string, unknown> }) =>
    sessionProjectionMock({ agent: "codex", environmentId: "env-1" }),
);
export const dispatchNativeAgentIntentMock = mock(
  async (
    input: Parameters<typeof realBackend.dispatchNativeAgentIntent>[0],
  ): Promise<NativeAgentDispatchOutcome> => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }),
);
export const retryNativeAgentDispatchMock = mock(async (): Promise<NativeAgentDispatchOutcome> => ({
  outcome: "accepted",
  requestId: "recoverable-1",
}));
export const discardNativeAgentDispatchMock = mock(async () => ({ discarded: true }));
export const renameEnvironmentFromPromptMock = mock(async () => {});
export const resumeNativeAgentSessionMock = mock(
  async (input: {
    agent: NativeAgentTabData["platform"];
    environmentId: string;
    providerSessionId: string;
  }) => ({
    ...(await defaultProjection({
      agent: input.agent!,
      environmentId: input.environmentId,
    })),
    sessionId: input.providerSessionId,
    generation: `resumed:${input.providerSessionId}`,
  }),
);
export const stopNativeAgentSessionMock = mock(async () =>
  sessionProjectionMock({
    agent: "claude",
    environmentId: "env-1",
  }),
);
export const defaultProjection = async (input: {
  agent: AgentPlatform;
  environmentId: string;
}): Promise<NativeAgentSessionProjection<NativeMessage>> => ({
  platform: input.agent,
  environmentId: input.environmentId,
  sessionId: `${input.agent}-session`,
  connection: "connected" as const,
  turn: { phase: "idle" as const },
  messages: [] as NativeMessage[],
  interactions: [],
  composerControls: [],
  composer: {
    models: [],
    fastModeEnabled: false,
    fastModeAvailable: false,
    selectedModeId: "build" as const,
    modes: [{ id: "build" as const, label: "Build" }],
  },
  capabilities: {
    // As a real projection does: the platform's table, narrowed per session.
    attachments: nativeAgentCapabilities(input.agent).attachments,
    queue: false,
    resume: false,
    fork: false,
    slashCommands: false,
    backgroundTasks: false,
    composer: {
      provider: true,
      model: true,
      reasoning: true,
      speed: true,
      mode: true,
    },
  },
  revision: 1,
  generation: "test-generation",
});
/**
 * The session as the fake backend holds it. Every progressive read the tab
 * issues (transcript, session state, discovery) is answered from this one
 * projection; see `@/test/native-agent-session-backend`.
 */
export const sessionProjectionMock = mock(defaultProjection);
/** Rows before the live tail, which "Load earlier messages" pages in. */
export const sessionHistoryMock = mock(
  async (_input: { logicalSessionKey: string }): Promise<NativeMessage[]> => [],
);
export const sessionBackend = createNativeAgentSessionBackend({
  readProjection: (input) => sessionProjectionMock(input),
  readHistory: (input) => sessionHistoryMock(input),
});
export const startAgentAccountLoginMock = mock(
  async (_platform: string, _options?: { reauthenticate?: boolean }) => {
    fixtureState.accountLoginProgress = {
      state: "pending",
      platform: "claude",
      mode: "reauthenticate",
      url: "https://claude.com/cai/oauth/authorize?state=test",
      needsCode: true,
    };
    return fixtureState.accountLoginProgress;
  },
);
export const getAgentAccountLoginMock = mock(async () => fixtureState.accountLoginProgress);
// The machine's accounts, which the Claude sign-in card names the active one of.
export const EMPTY_AGENT_ACCOUNTS: AgentAccountsSnapshot = {
  accounts: [],
  active: { claude: "default", codex: "default" } as AgentAccountsSnapshot["active"],
};
fixtureState.agentAccounts = EMPTY_AGENT_ACCOUNTS;
export const listAgentAccountsMock = mock(async () => fixtureState.agentAccounts);
const cancelAgentAccountLoginMock = mock(async () => {
  fixtureState.accountLoginProgress = { state: "idle" };
  return fixtureState.accountLoginProgress;
});
export const stopNativeAgentBackgroundTaskMock = mock(async () =>
  sessionProjectionMock({ agent: "claude", environmentId: "env-1" }),
);
export const getLocalFileTreeMock = mock(async (_worktreePath: string) => []);
export const writeCoordinatorAttachmentMock = mock(
  async (environmentId: string, filename: string, _base64Data: string) =>
    `/data/coordinator-attachments/${environmentId}/${filename}`,
);
export const writeBugReportAttachmentMock = mock(
  async (reportId: string, filename: string, _base64Data: string) =>
    `/tmp/orkestrator-bug-report-${reportId}/screenshots/${filename}`,
);
type StoredComposeDraft = {
  draftKey: string;
  ownerType: "environment" | "project";
  ownerId: string;
  value: unknown;
  updatedAt: string;
  revision: number;
};
export const composeDraftRecords = new Map<string, StoredComposeDraft>();
const getComposeDraftMock = mock(
  async (draftKey: string) => composeDraftRecords.get(draftKey) ?? null,
);
const saveComposeDraftMock = mock(
  async (
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ) => {
    const existing = composeDraftRecords.get(draftKey);
    if (expectedRevision !== undefined && existing && existing.revision !== expectedRevision) {
      throw new Error("Compose draft revision conflict");
    }
    const saved = {
      draftKey,
      ownerType,
      ownerId,
      value,
      updatedAt: "2026-09-15T00:00:00.000Z",
      revision: (existing?.revision ?? 0) + 1,
    };
    composeDraftRecords.set(draftKey, saved);
    return saved;
  },
);
const deleteComposeDraftMock = mock(async (draftKey: string, expectedRevision?: number) => {
  const existing = composeDraftRecords.get(draftKey);
  if (expectedRevision !== undefined && existing && existing.revision !== expectedRevision) {
    throw new Error("Compose draft revision conflict");
  }
  composeDraftRecords.delete(draftKey);
});
// The paste handler itself needs a canvas the test environment does not have.
// What broke for coordinators was the wiring into it, so that is what this
// captures: which staging route a composer hands the hook.
export let latestPasteOptions: {
  worktreePath?: string | null;
  canAttachImage?: () => boolean;
  onAttach?: (attachment: {
    id: string;
    type: "image";
    path: string;
    previewUrl: string;
    name: string;
  }) => void;
  writeImage?: (filename: string, base64Data: string) => Promise<string>;
} | null = null;
// Favorites and enabled platforms live in the shared config store, which no
// other hook resets between files. Snapshot it so a test that seeds either one
// cannot change what a later test's model picker renders.
let configSnapshot: ConfigState["config"];
/**
 * `resource-sync` holds every announcement for its 50 ms coalescing window
 * (`COALESCE_MS`) before delivering it to subscribers.
 */
const RESOURCE_CHANGE_COALESCE_MS = 50;
/** Macrotask turns a coordinated read may take to settle once delivered. */
const MAX_READ_SETTLE_TURNS = 100;
/**
 * Delivers one resource change through the production coalescing timer instead
 * of sleeping past it, then waits until the shared read coordinator has no read
 * in flight. Delivery and the coordinator's decision to read are synchronous,
 * so once nothing is in flight every read the change caused has settled (or was
 * never started), and an assertion that follows sees its outcome.
 *
 * The clock is installed around the dispatch rather than before rendering: the
 * timer it captures is the one this call schedules, and the narrower window
 * keeps unrelated 50 ms timers (scroll retries, read-resume coalescing) out of
 * it. A collision still fails loudly through the pending and dropped counts.
 */
export async function deliverResourceChange(change: ResourceChange): Promise<void> {
  const coalesce = installControlledTimeout(RESOURCE_CHANGE_COALESCE_MS, {
    label: "resource-sync coalescing",
  });
  let armed = 0;
  let dropped = 0;
  try {
    act(() => {
      dispatchResourceChange(change);
      armed = coalesce.pendingCount();
      coalesce.advance();
    });
  } finally {
    dropped = coalesce.restore();
  }
  expect(armed).toBe(1);
  expect(dropped).toBe(0);
  await settleCoordinatedReads();
}
/**
 * Yields whole macrotask turns until the shared read coordinator has no read in
 * flight. A coordinator read starts synchronously and re-reads synchronously
 * when it settles dirty, so an idle coordinator means none is still coming.
 */
export async function settleCoordinatedReads(): Promise<void> {
  const coordinator = getReadCoordinator();
  const readInFlight = () => coordinator.getDiagnostics().entries.some((entry) => entry.inFlight);
  let settled = false;
  await act(async () => {
    for (let turn = 0; turn < MAX_READ_SETTLE_TURNS && !settled; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      settled = !readInFlight();
    }
  });
  expect(settled).toBe(true);
}
let readCoordinatorFaked = false;
/** A fake-clock shared read coordinator; afterEach restores the default after unmount. */
export function fakeReadCoordinator() {
  readCoordinatorFaked = true;
  return installFakeReadCoordinator();
}
/**
 * The backend now holds `projection`: the next read answers with it, and it is
 * installed at once, as the read that announced it would. A store write alone
 * is not enough, because every progressive read installs what the backend
 * holds and would put the old session back.
 */
export function publishProjection(
  sessionKey: string,
  projection: NativeAgentSessionProjection,
): void {
  sessionProjectionMock.mockImplementation(
    async () => projection as NativeAgentSessionProjection<NativeMessage>,
  );
  act(() => {
    appCommandStore(nativeAgentProjectionStore).getState().setProjection(sessionKey, projection);
  });
}
/**
 * The stored first row's first part's `agentState`. Read as a field: Bun 1.4's
 * `toMatchObject` writes asymmetric matchers into the received object, which
 * for the projection store is the state the tab is rendering.
 */
export function firstPartAgentState(sessionKey: string): string | undefined {
  const row = appCommandStore(nativeAgentProjectionStore).getState().projections.get(sessionKey)
    ?.messages[0] as NativeMessage | undefined;
  return (row?.parts[0] as { agentState?: string } | undefined)?.agentState;
}
export function identity(platform: NativeAgentTabData["platform"]): NativeAgentTabData {
  return {
    platform,
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: `${platform}-session`,
    isLocal: false,
  };
}
export function seedUnassignedDefaultCatalog() {
  getNativeAgentModelCatalogMock.mockImplementation(
    async () =>
      [
        {
          platform: "claude",
          id: "claude-sonnet-5",
          label: "Claude Sonnet",
          supportsSpeed: true,
        },
        {
          platform: "codex",
          id: "gpt-5.4",
          label: "GPT-5.4",
          reasoning: [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          defaultReasoningId: "medium",
          supportsSpeed: true,
        },
      ] as never,
  );
}
export async function expectUnassignedPicker(platform: "claude" | "codex", modelLabel: string) {
  // Claude and Codex are asked for by name so a fresh install downloads them.
  await waitFor(() =>
    expect(getNativeAgentModelCatalogMock.mock.calls.some(([env]) => env === "env-1")).toBe(true),
  );
  expect(await screen.findByTitle(/Choose model/)).toBeTruthy();
  await waitFor(() => {
    expect(document.querySelector(`[data-native-model-platform='${platform}']`)).toBeTruthy();
    expect(screen.getByText(modelLabel)).toBeTruthy();
  });
}
export function pendingInteraction(
  kind: AgentInteractionRequest["kind"],
  id: string,
): AgentInteractionRequest {
  const question = kind === "question";
  const planApproval = kind === "plan-approval";
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id,
    provider: "claude",
    kind,
    origin: "interactive-native",
    sessionId: "claude-session",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: question
      ? {
          title: "Claude needs input",
          questions: [
            {
              id: "q0",
              prompt: "Which approach?",
              required: true,
              multiple: false,
              secret: false,
              allowFreeText: true,
              options: [],
            },
          ],
        }
      : planApproval
        ? {
            title: "Approve Claude's plan",
            body: "# Implementation plan\n\n1. Show the plan in the transcript.",
            planAvailable: true,
            questions: [],
            confirmLabel: "Approve",
            declineLabel: "Deny",
          }
        : {
            title: "Approve command",
            body: "Command: bun test",
            questions: [],
            confirmLabel: "Approve",
            declineLabel: "Deny",
          },
  };
}
/**
 * A tab the user has just created.
 *
 * The absence of `sessionId` is the whole point: there is no durable provider
 * session to adopt, so the tab has to create one before anything can read it.
 */
export function freshTab(platform: NativeAgentTabData["platform"]): NativeAgentTabData {
  return {
    platform,
    environmentId: "env-1",
    containerId: "container-1",
    isLocal: false,
  };
}
export function TerminalTabHarness({
  createTab,
  children,
}: {
  createTab: NonNullable<ReturnType<typeof useTerminalContext>["createTab"]>;
  children: ReactNode;
}) {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab(createTab);
    return () => setCreateTab(null);
  }, [createTab, setCreateTab]);
  return children;
}
export function seedEnvTab(tab: TabInfo) {
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [tab],
            activeTabId: tab.id,
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    hydration: new Map([["env-1", "done"]]),
    activeEnvironmentId: "env-1",
  });
}
export function grokToCursorHandoff(id = "handoff-grok-to-cursor") {
  return createAgentHandoffSnapshot({
    id,
    environmentId: "env-1",
    sourceProvider: "grok",
    destinationProvider: "cursor",
    sourceSessionId: "grok-session",
    messages: [
      {
        id: "grok-user-1",
        role: "user",
        content: "Investigate the layout",
        parts: [{ type: "text", content: "Investigate the layout" }],
        createdAt: "2026-09-14T22:00:00.000Z",
      },
      {
        id: "grok-assistant-1",
        role: "assistant",
        content: "I found three concrete gaps",
        parts: [{ type: "text", content: "I found three concrete gaps" }],
        createdAt: "2026-09-14T22:01:00.000Z",
      },
    ],
    now: "2026-09-14T22:02:00.000Z",
  });
}
export function PaneBackedAgentNativeTab({ tabId = "tab-resume" }: { tabId?: string }) {
  const tab = usePaneLayoutStore((state) => {
    const root = state.environments.get("env-1")?.root;
    if (!root || root.kind !== "leaf") return undefined;
    return root.tabs.find((candidate) => candidate.id === tabId);
  });
  const data = tab ? getNativeAgentData(tab) : undefined;
  if (!data) return null;
  return (
    <AgentNativeTab
      tabId={tabId}
      data={data}
      isActive
      initialPrompt={tab?.initialPrompt}
      initialAgentPlatform={tab?.initialAgentPlatform}
      initialAgentModel={tab?.initialAgentModel}
      initialReasoningEffort={tab?.initialReasoningEffort}
      initialConversationMode={tab?.initialConversationMode}
      initialFastMode={tab?.initialFastMode}
      initialExecutionProfileId={tab?.initialExecutionProfileId}
      agentHandoffId={tab?.agentHandoffId}
      consumedAgentHandoffId={tab?.consumedAgentHandoffId}
    />
  );
}
export function NativeSessionHarness({ isActive = true }: { isActive?: boolean } = {}) {
  const session = useNativeAgentSession<NativeMessage>({
    platform: "claude",
    environmentId: "env-1",
    tabId: "tab-hook-race",
    initialProviderSessionId: "session-a",
    isActive,
  });
  return (
    <div>
      <output data-testid="hook-session-id">{session.projection?.sessionId}</output>
      <output data-testid="hook-message">
        {(session.projection?.messages[0] as NativeMessage | undefined)?.content}
      </output>
      <button
        type="button"
        onClick={() => {
          void session.refresh();
        }}
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={() => {
          void session.resume("session-b");
        }}
      >
        Resume B
      </button>
    </div>
  );
}
export function NativeSessionIdentityHarness({
  platform,
  enabled = true,
}: {
  platform: NonNullable<NativeAgentTabData["platform"]>;
  enabled?: boolean;
}) {
  const session = useNativeAgentSession<NativeMessage>({
    platform,
    environmentId: "env-1",
    tabId: "tab-identity",
    isActive: true,
    enabled,
  });
  return (
    <>
      <output data-testid="has-completed-read">{String(session.hasCompletedRead)}</output>
      <output data-testid="runtime-error">{session.runtimeError ?? ""}</output>
    </>
  );
}
export function seedUnassignedPane(tabId: string) {
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: { environmentId: "env-1" },
              },
            ],
            activeTabId: tabId,
          },
          activePaneId: "default",
          containerId: null,
        },
      ],
    ]),
    hydration: new Map([["env-1", "done"]]),
    activeEnvironmentId: "env-1",
  });
}
export function seedAssignedPane(
  tabId: string,
  initial: Pick<
    TabInfo,
    "initialConversationMode" | "initialFastMode" | "initialExecutionProfileId" | "initialPrompt"
  >,
) {
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: identity("claude"),
                ...initial,
              },
            ],
            activeTabId: tabId,
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    hydration: new Map([["env-1", "done"]]),
    activeEnvironmentId: "env-1",
  });
}
/**
 * Registers this suite's module stubs and hooks, then loads the component under
 * test. It runs from each test file after that file's own imports, as the
 * stubs and the dynamic imports it performs must follow them, and so that the
 * hooks attach to the file that called it.
 */
export async function installAgentNativeTabFixture() {
  mock.module("@/components/chat/VirtualizedMessageList", () => ({
    ...realVirtualizedMessageListSnapshot,
    VirtualizedMessageList: (props: any) => {
      virtualizedMessageListRenderCount += 1;
      latestTranscriptAnnotationProps = props.annotation;
      if (!fixtureState.renderVirtualizedMessages) {
        const RealVirtualizedMessageList =
          realVirtualizedMessageListSnapshot.VirtualizedMessageList;
        return <RealVirtualizedMessageList {...props} />;
      }
      latestRenderedMessageActions = new Map();
      const renderedMessages = props.messages.map((message: NativeMessage, index: number) => {
        const rendered = props.renderMessage(
          index,
          message,
          props.resolvePreviousMessage
            ? props.resolvePreviousMessage(props.messages, index)
            : index > 0
              ? props.messages[index - 1]
              : null,
        );
        latestRenderedMessageActions.set(
          message.id,
          isValidElement<{ actions?: ReactNode }>(rendered) ? rendered.props.actions : undefined,
        );
        const counted = isValidElement(rendered) ? (
          <InstrumentedNativeMessage {...(rendered.props as NativeMessageProps)} />
        ) : (
          rendered
        );
        return <div key={props.computeItemKey(index, message)}>{counted}</div>;
      });
      return (
        <div data-testid="native-agent-transcript-test-list">
          {props.header}
          {props.messages.length === 0 ? props.emptyState : null}
          {renderedMessages}
          {props.footer}
        </div>
      );
    },
  }));
  mock.module("@/hooks/useNativeComposeBarPaste", () => ({
    useNativeComposeBarPaste: (options: typeof latestPasteOptions) => {
      latestPasteOptions = options;
    },
  }));
  mock.module("@/lib/backend", () => ({
    ...realBackendSnapshot,
    getNativeAgentModelCatalog: getNativeAgentModelCatalogMock,
    getAgentModelCatalogCache: getAgentModelCatalogCacheMock,
    awaitBridgeReady: awaitBridgeReadyMock,
    adoptNativeAgentSession: adoptNativeAgentSessionMock,
    forkNativeAgentSession: forkNativeAgentSessionMock,
    beginNativeAgentSignIn: beginNativeAgentSignInMock,
    cancelNativeAgentSignIn: cancelNativeAgentSignInMock,
    getNativeAgentAuthStatus: getNativeAgentAuthStatusMock,
    startAgentAccountLogin: startAgentAccountLoginMock,
    getAgentAccountLogin: getAgentAccountLoginMock,
    listAgentAccounts: listAgentAccountsMock,
    cancelAgentAccountLogin: cancelAgentAccountLoginMock,
    openInBrowser: openInBrowserMock,
    ensureNativeAgentSession: ensureNativeAgentSessionMock,
    recoverMultiReviewAddressFindingsSession: recoverMultiReviewAddressFindingsSessionMock,
    listNativeAgentResumableSessions: listNativeAgentResumableSessionsMock,
    setNativeAgentResumableSessionArchived: setNativeAgentResumableSessionArchivedMock,
    getAgentHandoff: getAgentHandoffMock,
    getAgentHandoffCapabilities: getAgentHandoffCapabilitiesMock,
    getNativeAgentSignInResend: getNativeAgentSignInResendMock,
    dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
    retryNativeAgentDispatch: retryNativeAgentDispatchMock,
    discardNativeAgentDispatch: discardNativeAgentDispatchMock,
    renameEnvironmentFromPrompt: renameEnvironmentFromPromptMock,
    resumeNativeAgentSession: resumeNativeAgentSessionMock,
    stopNativeAgentSession: stopNativeAgentSessionMock,
    stopNativeAgentBackgroundTask: stopNativeAgentBackgroundTaskMock,
    getFileTree: async () => [],
    getLocalFileTree: getLocalFileTreeMock,
    writeCoordinatorAttachment: writeCoordinatorAttachmentMock,
    writeBugReportAttachment: writeBugReportAttachmentMock,
    ...sessionBackend.api,
    getComposeDraft: getComposeDraftMock,
    saveComposeDraft: saveComposeDraftMock,
    deleteComposeDraft: deleteComposeDraftMock,
    performNativeAgentSessionAction: performNativeAgentSessionActionMock,
    steerNativeAgentQueuedPrompt: steerNativeAgentQueuedPromptMock,
    enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
    removePromptQueueMessage: removePromptQueueMessageMock,
    movePromptQueueMessage: movePromptQueueMessageMock,
    dismissNativeAgentSuggestedPrompt: dismissNativeAgentSuggestedPromptMock,
    updateNativeAgentControls: updateNativeAgentControlsMock,
  }));
  mock.module("@/lib/pane-layout-persistence", () => ({
    ...realPaneLayoutPersistenceSnapshot,
    flushPaneLayoutNow: flushPaneLayoutNowMock,
  }));
  beforeEach(() => {
    configSnapshot = appCommandStore(configStore).getState().config;
    useNativeNoticeDismissalStore.getState().clear();
    appCommandStore(agentModelCatalogStore).setState({
      cursorModels: [],
      grokModels: [],
      piModels: [],
    });
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Native agent test",
          order: 0,
          setupPhase: "ready",
        } as never,
      ],
    });
  });
  afterEach(() => {
    cleanup();
    if (readCoordinatorFaked) {
      resetReadCoordinatorForTests();
      readCoordinatorFaked = false;
    }
    fixtureState.renderVirtualizedMessages = false;
    fixtureState.agentAccounts = EMPTY_AGENT_ACCOUNTS;
    latestTranscriptAnnotationProps = undefined;
    appCommandStore(configStore).getState().setConfig(configSnapshot);
    flushPaneLayoutNowMock.mockClear();
    getNativeAgentModelCatalogMock.mockReset();
    getNativeAgentModelCatalogMock.mockImplementation(async () => []);
    getAgentModelCatalogCacheMock.mockReset();
    getAgentModelCatalogCacheMock.mockImplementation(async () => ({ schemaVersion: 1 }));
    awaitBridgeReadyMock.mockReset();
    awaitBridgeReadyMock.mockImplementation(async () => ({
      status: "ready" as const,
      port: 4099,
      authToken: "token",
    }));
    adoptNativeAgentSessionMock.mockClear();
    forkNativeAgentSessionMock.mockReset();
    forkNativeAgentSessionMock.mockImplementation(async () => ({ sessionId: "fork-session" }));
    beginNativeAgentSignInMock.mockClear();
    cancelNativeAgentSignInMock.mockClear();
    getNativeAgentAuthStatusMock.mockClear();
    getNativeAgentAuthStatusMock.mockImplementation(async () => null);
    openInBrowserMock.mockClear();
    openInBrowserMock.mockImplementation(async () => undefined);
    beginNativeAgentSignInMock.mockImplementation(async () => ({
      url: "https://auth.example.test/login",
    }));
    // Restored, not just cleared: a test that installs a failing adoption would
    // otherwise leave every later file-order-dependent test connecting to a
    // provider that refuses.
    adoptNativeAgentSessionMock.mockImplementation(defaultAdoptNativeAgentSession);
    ensureNativeAgentSessionMock.mockClear();
    // Restored for the same reason as the adoption above: a test that parks or
    // fails session creation must not leave later tests unable to connect.
    ensureNativeAgentSessionMock.mockImplementation(defaultEnsureNativeAgentSession);
    recoverMultiReviewAddressFindingsSessionMock.mockClear();
    recoverMultiReviewAddressFindingsSessionMock.mockImplementation(
      async () => ({ id: "multi-1", backendRevision: 2 }) as never,
    );
    listNativeAgentResumableSessionsMock.mockClear();
    setNativeAgentResumableSessionArchivedMock.mockClear();
    getAgentHandoffMock.mockReset();
    getAgentHandoffMock.mockResolvedValue(null);
    getAgentHandoffCapabilitiesMock.mockReset();
    getAgentHandoffCapabilitiesMock.mockResolvedValue({
      create: false,
      delivery: false,
      pruning: false,
    });
    getNativeAgentSignInResendMock.mockReset();
    getNativeAgentSignInResendMock.mockResolvedValue({ pending: false });
    resetAgentHandoffCache();
    dispatchNativeAgentIntentMock.mockClear();
    retryNativeAgentDispatchMock.mockClear();
    discardNativeAgentDispatchMock.mockClear();
    renameEnvironmentFromPromptMock.mockReset();
    renameEnvironmentFromPromptMock.mockImplementation(async () => {});
    resumeNativeAgentSessionMock.mockClear();
    stopNativeAgentSessionMock.mockClear();
    stopNativeAgentBackgroundTaskMock.mockClear();
    performNativeAgentSessionActionMock.mockClear();
    steerNativeAgentQueuedPromptMock.mockReset();
    steerNativeAgentQueuedPromptMock.mockResolvedValue({ outcome: "applied" });
    enqueuePromptQueueMessageMock.mockClear();
    removePromptQueueMessageMock.mockClear();
    movePromptQueueMessageMock.mockClear();
    dismissNativeAgentSuggestedPromptMock.mockClear();
    updateNativeAgentControlsMock.mockClear();
    // Reset, not cleared: a failed test can leave queued once-implementations.
    sessionProjectionMock.mockReset();
    sessionProjectionMock.mockImplementation(defaultProjection);
    sessionHistoryMock.mockReset();
    sessionHistoryMock.mockImplementation(async () => []);
    sessionBackend.reset();
    getLocalFileTreeMock.mockClear();
    writeCoordinatorAttachmentMock.mockClear();
    writeBugReportAttachmentMock.mockClear();
    getComposeDraftMock.mockClear();
    saveComposeDraftMock.mockClear();
    deleteComposeDraftMock.mockClear();
    composeDraftRecords.clear();
    virtualizedMessageListRenderCount = 0;
    latestRenderedMessageActions = new Map();
    nativeMessageRenderCounts = new Map();
    latestPasteOptions = null;
    appCommandStore(environmentStore).setState({ environments: [] });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        agentSettings: { platforms: { claude: { model: "claude-sonnet-5" } } },
      });
    appCommandStore(paneLayoutStore).setState({
      environments: new Map(),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
    appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    useNativeNoticeDismissalStore.getState().clear();
    appCommandStore(multiReviewStore).setState({ workflows: new Map() });
  });
  afterAll(() => {
    mock.module("@/lib/backend", () => realBackendSnapshot);
    mock.module("@/lib/pane-layout-persistence", () => realPaneLayoutPersistenceSnapshot);
    mock.module(
      "@/components/chat/VirtualizedMessageList",
      () => realVirtualizedMessageListSnapshot,
    );
    mock.module("@/hooks/useNativeComposeBarPaste", () => realNativeComposeBarPasteSnapshot);
  });
  ({ AgentNativeTab } = await import("./AgentNativeTab"));
  ({ enqueueNativeAsyncQuestionResponse, SharedNativeAgentController } =
    await import("./AgentNativeTab.controller"));
  ({ useNativeAgentSession } = await import("@/hooks/useNativeAgentSession"));
}
