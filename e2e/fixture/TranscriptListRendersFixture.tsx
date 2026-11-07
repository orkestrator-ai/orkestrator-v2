/**
 * Native transcript list render fixture (`/transcript-list-renders`).
 *
 * Real `AgentNativeTab`s over a 100-row synthetic transcript and a fake
 * `invoke`, each inside a React `Profiler` that counts the commits of its tab.
 * `react-virtuoso` republishes its props on every render of `<Virtuoso>`, which
 * shows up here as a `nested-update` commit, so the count tells a render that
 * reached the list from one that did not. Rows change the way they do in the
 * app: the fake backend moves a token and the tab's next read picks it up.
 *
 * `?tabs=2` renders a second tab beside the first, `?earlier=1` leaves ten rows
 * behind a "Load earlier messages" header, and `?platform=cursor` is a platform
 * with no fork action, whose rows have no per-message callback to change.
 * `?platform=claude` joins a background task onto its launch row; `?subork=1`
 * profiles the real Subork transcript dialog instead of a native tab.
 */
import { Profiler, useState } from "react";
import { AGENT_INTERACTION_CONTRACT_VERSION } from "@orkestrator/protocol/agent-interactions";
import {
  nativeAgentCapabilities,
  type NativeAgentViewIdentity,
  type NativeAgentBackgroundTaskSummary,
} from "@orkestrator/protocol/native-agent";
import { SuborkTranscriptDialog } from "../../apps/web/src/components/chat/SuborkTranscriptDialog";
import { AgentNativeTab } from "../../apps/web/src/components/native-agent/AgentNativeTab";
import { disableAutoLoadEarlier } from "../../apps/web/src/components/native-agent/useAutoLoadEarlier";
import type { NativeMessage } from "../../apps/web/src/lib/chat/native-message-types";
import { useConversationScrollTargetStore } from "../../apps/web/src/stores/conversationScrollTargetStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { getWindowScope } from "../../apps/web/src/lib/node-scope/app-window-scope";
import { useNativeAgentProjectionStore } from "../../apps/web/src/stores/nativeAgentProjectionStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

const ENVIRONMENT_ID = "transcript-list-environment";
const ROW_COUNT = 100;
const TOOL_EVERY = 8;
const USER_EVERY = 4;
const query = new URLSearchParams(window.location.search);
const tabCount = query.get("tabs") === "2" ? 2 : 1;
const platform =
  query.get("platform") === "claude"
    ? "claude"
    : query.get("platform") === "cursor"
      ? "cursor"
      : "codex";
const earlierRows = query.has("earlier") ? 10 : 0;
const EARLIER_PAGE_DELAY_MS = 400;
// A test drives the header's button, so paging must not start on its own.
if (earlierRows > 0) disableAutoLoadEarlier();

function rowAt(index: number): NativeMessage {
  const createdAt = new Date(Date.UTC(2026, 10, 5, 0, index)).toISOString();
  const content = `Fixture row ${index}`;
  // The fork action needs turns to place its boundary.
  const turnId = `turn-${Math.floor(index / USER_EVERY)}`;
  if (platform === "claude" && index === ROW_COUNT - 1) {
    return {
      id: `row-${index}`,
      role: "assistant",
      content: "",
      createdAt,
      turnId,
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolUseId: "background-launch",
          toolState: "success",
          toolArgs: { description: "Fixture background task", run_in_background: true },
        },
      ],
    };
  }
  if (index % TOOL_EVERY === 6) {
    return {
      id: `row-${index}`,
      role: "assistant",
      content: "",
      createdAt,
      turnId,
      parts: [
        { type: "text", content },
        {
          type: "tool-invocation",
          content: "Read",
          toolName: "Read",
          toolUseId: `call-${index}`,
          toolArgs: { file_path: `fixture/file-${index}.txt` },
          toolState: "success",
          toolOutput: `Fixture output ${index}`,
        },
      ],
    };
  }
  return {
    id: `row-${index}`,
    role: index % USER_EVERY === 0 ? "user" : "assistant",
    content,
    createdAt,
    turnId,
    parts: [{ type: "text", content }],
  };
}

type Turn = {
  phase: string;
  startedAt?: number;
  activity?: { compacting?: boolean; thinkingTokens?: number };
};

interface TabState {
  tabId: string;
  identity: NativeAgentViewIdentity;
  messages: NativeMessage[];
  turn: Turn;
  interactions: unknown[];
  backgroundTasks: NativeAgentBackgroundTaskSummary[];
  historyLoaded: boolean;
  stateRevision: number;
  transcriptRevision: number;
  /** The revisions the tab has last been told about. */
  stateSeen: number;
  transcriptSeen: number;
}

const tabs: TabState[] = Array.from({ length: tabCount }, (_, index) => {
  const tabId = `transcript-list-tab-${index}`;
  return {
    tabId,
    identity: {
      backendInstanceId: "transcript-list-fixture",
      environmentId: ENVIRONMENT_ID,
      platform,
      logicalSessionKey: `env-${ENVIRONMENT_ID}:${tabId}`,
      providerSessionId: `transcript-list-session-${index}`,
      sourceGeneration: "generation-1",
    },
    messages: Array.from({ length: ROW_COUNT - earlierRows }, (_, row) => rowAt(row + earlierRows)),
    historyLoaded: earlierRows === 0,
    turn: { phase: "idle" },
    interactions: [],
    backgroundTasks:
      platform === "claude"
        ? [
            {
              id: "fixture-background",
              toolUseId: "background-launch",
              status: "running",
              description: "Fixture background task",
              progressSummary: "Reading fixture files",
            },
          ]
        : [],
    stateRevision: 1,
    transcriptRevision: 1,
    stateSeen: 0,
    transcriptSeen: 0,
  };
});

function tabForSession(args: Record<string, unknown> | undefined): TabState {
  const key = args?.logicalSessionKey ?? args?.sessionKey ?? args?.tabId;
  return (
    tabs.find((tab) => tab.identity.logicalSessionKey === key || tab.tabId === key) ?? tabs[0]!
  );
}

interface CommitCounts {
  mount: number;
  update: number;
  nested: number;
  updateMs: number;
  nestedMs: number;
}

const noCommits = (): CommitCounts => ({
  mount: 0,
  update: 0,
  nested: 0,
  updateMs: 0,
  nestedMs: 0,
});
const commits: CommitCounts[] = tabs.map(noCommits);

/** The tab has read its transcript and the store holds it. */
function isReady(): boolean {
  const { projections } = appCommandStore(useNativeAgentProjectionStore.def).getState();
  return tabs.every(
    (tab) => (projections.get(tab.identity.logicalSessionKey)?.messages.length ?? 0) > 0,
  );
}

let unrelatedWrites = 0;

const fixture = {
  ready: isReady,
  /** The tab has read everything the fake backend has to tell it. */
  caughtUp: () =>
    tabs.every(
      (tab) => tab.stateSeen === tab.stateRevision && tab.transcriptSeen === tab.transcriptRevision,
    ),
  commits: () => commits.map((counts) => ({ ...counts })),
  resetCommits: () => {
    for (const counts of commits) Object.assign(counts, noCommits());
  },
  /** Writes a field the tab selects, which renders it without changing anything it shows. */
  writeUnrelated: async (writes: number, intervalMs = 40) => {
    for (let write = 0; write < writes; write += 1) {
      unrelatedWrites += 1;
      appCommandStore(useEnvironmentStore.def).setState((state) => ({
        environments: state.environments.map((environment) => ({
          ...environment,
          initialPrompt: `unrelated write ${unrelatedWrites}`,
        })),
      }));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
  /** One streamed frame: the last row grows, or a new one arrives. */
  stream: (text: string, options: { tab?: number; newRow?: boolean } = {}) => {
    const tab = tabs[options.tab ?? 0]!;
    if (options.newRow) {
      tab.messages = [
        ...tab.messages,
        {
          id: `live-${tab.messages.length}`,
          role: "assistant",
          content: text,
          createdAt: new Date(Date.UTC(2026, 10, 5, 3, tab.messages.length)).toISOString(),
          parts: [{ type: "text", content: text }],
        },
      ];
    } else {
      const last = tab.messages.at(-1)!;
      const content = `${last.content} ${text}`.trim();
      tab.messages = [
        ...tab.messages.slice(0, -1),
        { ...last, content, parts: [{ type: "text", content }] },
      ];
    }
    tab.transcriptRevision += 1;
  },
  /** Moves a row's clock, which only the row after it shows, as its response time. */
  moveRowTime: (messageId: string, createdAt: string, tabIndex = 0) => {
    const tab = tabs[tabIndex]!;
    tab.messages = tab.messages.map((message) =>
      message.id === messageId ? { ...message, createdAt } : message,
    );
    tab.transcriptRevision += 1;
  },
  setBackgroundTask: (update: Partial<NativeAgentBackgroundTaskSummary>) => {
    const tab = tabs[0]!;
    tab.backgroundTasks = tab.backgroundTasks.map((task) => ({ ...task, ...update }));
    tab.stateRevision += 1;
  },
  setTurn: (turn: Turn, tabIndex = 0) => {
    const tab = tabs[tabIndex]!;
    tab.turn = turn;
    tab.stateRevision += 1;
  },
  /** A question the agent is waiting on, which renders in the transcript footer. */
  setQuestion: (question: string | null, tabIndex = 0) => {
    const tab = tabs[tabIndex]!;
    tab.interactions = question
      ? [
          {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            id: "fixture-question",
            provider: platform,
            kind: "question",
            origin: "interactive-native",
            sessionId: tab.identity.providerSessionId,
            state: "pending",
            revision: tab.stateRevision,
            createdAt: 1,
            updatedAt: 1,
            presentation: {
              title: "A fixture question",
              questions: [
                {
                  id: "answer",
                  prompt: question,
                  required: true,
                  multiple: false,
                  secret: false,
                  allowFreeText: false,
                  options: [{ id: "yes", label: "Yes", providerValue: "yes" }],
                },
              ],
            },
          },
        ]
      : [];
    tab.stateRevision += 1;
  },
  highlight: (messageId: string, tabIndex = 0) => {
    useConversationScrollTargetStore.getState().request(
      // No node scope is rendered: the transcript reads the command node's requests.
      {
        nodeId: getWindowScope().commandScope().nodeId,
        environmentId: ENVIRONMENT_ID,
        tabId: tabs[tabIndex]!.tabId,
      },
      { messageId },
    );
  },
};

declare global {
  interface Window {
    transcriptListFixture?: typeof fixture;
  }
}

function installBackend(): void {
  appCommandStore(useEnvironmentStore.def).setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "transcript-list-project",
        name: "Transcript list fixture",
        order: 0,
        setupPhase: "ready",
      } as never,
    ],
  });
  window.transcriptListFixture = fixture;
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      let result: unknown;
      switch (command) {
        case "native_agent_subork_transcript":
          result = {
            status: "found",
            startIndex: 0,
            messageCount: tabs[0]!.messages.length,
            messages: tabs[0]!.messages,
          };
          break;
        case "get_native_agent_sync_capabilities":
          result = {
            projectionSyncVersions: [1],
            historyPagingVersions: [1],
            progressiveViewVersions: [1],
          };
          break;
        case "adopt_native_agent_session":
          result = {};
          break;
        case "get_native_agent_session_state_update": {
          const tab = tabForSession(args);
          const token = `state-${tab.stateRevision}`;
          tab.stateSeen = tab.stateRevision;
          if (args?.knownToken === token) {
            result = { viewVersion: 1, status: "unchanged", token, identity: tab.identity };
            break;
          }
          result = {
            viewVersion: 1,
            status: "snapshot",
            token,
            value: {
              identity: tab.identity,
              connection: "connected",
              turn: tab.turn,
              interactions: tab.interactions,
              backgroundTasks: tab.backgroundTasks,
              composerControls: [],
              capabilities: nativeAgentCapabilities(platform),
              notices: [],
            },
          };
          break;
        }
        case "get_native_agent_transcript_update": {
          const tab = tabForSession(args);
          const token = `transcript-${tab.transcriptRevision}`;
          tab.transcriptSeen = tab.transcriptRevision;
          if (args?.knownToken === token) {
            result = { viewVersion: 1, status: "unchanged", token, identity: tab.identity };
            break;
          }
          result = {
            viewVersion: 1,
            status: "snapshot",
            token,
            value: {
              identity: tab.identity,
              freshness: "current",
              messages: tab.messages,
              historyEpoch: "epoch-1",
              ...(tab.historyLoaded
                ? { historyComplete: true }
                : {
                    historyCursor: "before-earlier",
                    historyPaging: "direct",
                    historyComplete: false,
                    messageWindow: { limit: 100, truncated: true, canLoadEarlier: true },
                  }),
            },
          };
          break;
        }
        case "get_native_agent_message_page": {
          await new Promise((resolve) => setTimeout(resolve, EARLIER_PAGE_DELAY_MS));
          const tab = tabForSession(args);
          const earlier = Array.from({ length: earlierRows }, (_, row) => rowAt(row));
          tab.historyLoaded = true;
          tab.messages = [...earlier, ...tab.messages];
          tab.transcriptRevision += 1;
          result = {
            syncVersion: 1,
            messages: earlier,
            historyEpoch: "epoch-1",
            complete: true,
            truncated: false,
          };
          break;
        }
        case "get_native_agent_discovery_update":
          result =
            args?.knownToken === "discovery-1"
              ? {
                  viewVersion: 1,
                  status: "unchanged",
                  token: "discovery-1",
                  identity: tabForSession(args).identity,
                }
              : {
                  viewVersion: 1,
                  status: "snapshot",
                  token: "discovery-1",
                  value: { identity: tabForSession(args).identity, sections: {} },
                };
          break;
        case "get_compose_draft":
        case "save_compose_draft":
        case "delete_compose_draft":
        case "get_native_agent_session_account":
          result = null;
          break;
        case "get_native_agent_model_catalog":
        case "get_file_tree":
        case "get_local_file_tree":
          result = [];
          break;
        case "list_agent_accounts":
          result = { accounts: [], active: { claude: "default", codex: "default" } };
          break;
        case "get_native_agent_auth_status":
          result = { state: "ready" };
          break;
        default:
          throw new Error(`Unexpected transcript list fixture command: ${command}`);
      }
      return result as T;
    },
  };
}

/** Only the dialog's parent subscribes: native-tab props keep the original harness identity. */
function SuborkRenderFixture() {
  const unrelated = useEnvironmentStore((state) => state.environments[0]?.initialPrompt);
  return (
    <SuborkTranscriptDialog
      environmentId={ENVIRONMENT_ID}
      containerId={undefined}
      batchId="fixture-batch"
      subork={{
        id: "fixture-subork",
        name: "Fixture subork",
        agent: "codex",
        status: "finished",
        tokens: unrelatedWrites,
        modelLabel: unrelated ?? "Fixture model",
        startedAt: "2026-11-05T00:00:00.000Z",
        transcriptRevision: tabs[0]!.transcriptRevision,
      }}
      onClose={() => {}}
    />
  );
}

export function TranscriptListRendersFixture() {
  const [installed] = useState(() => {
    installBackend();
    return true;
  });
  const [away, setAway] = useState(false);
  return (
    <main
      className="flex h-screen flex-col bg-background text-foreground"
      data-installed={installed}
    >
      <button onClick={() => setAway(!away)}>
        {away ? "Return to transcript" : "Switch environment"}
      </button>
      <div
        className="grid min-h-0 flex-1 gap-2"
        style={{
          display: away ? "none" : undefined,
          gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
        }}
      >
        {tabs.map((tab, index) => (
          <section key={tab.tabId} data-testid={`list-tab-${index}`} className="min-h-0 min-w-0">
            <Profiler
              id={tab.tabId}
              onRender={(_id, phase, actualDuration) => {
                const counts = commits[index]!;
                if (phase === "mount") {
                  counts.mount += 1;
                } else if (phase === "update") {
                  counts.update += 1;
                  counts.updateMs += actualDuration;
                } else {
                  counts.nested += 1;
                  counts.nestedMs += actualDuration;
                }
              }}
            >
              {query.has("subork") ? (
                <SuborkRenderFixture />
              ) : (
                <AgentNativeTab
                  tabId={tab.tabId}
                  data={{
                    platform,
                    environmentId: ENVIRONMENT_ID,
                    sessionId: tab.identity.providerSessionId,
                    isLocal: true,
                  }}
                  isActive={!away}
                />
              )}
            </Profiler>
          </section>
        ))}
      </div>
      {away ? <p>Another environment</p> : null}
    </main>
  );
}
