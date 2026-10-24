import { useState } from "react";
import {
  nativeAgentCapabilities,
  type NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import type { MultiReviewReviewerTranscript } from "@orkestrator/protocol/multi-review";
import { AgentNativeTab } from "../../apps/web/src/components/native-agent/AgentNativeTab";
import { MultiReviewReviewerTab } from "../../apps/web/src/components/review/MultiReviewReviewerTab";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "paging-fixture",
  environmentId: "paging-environment",
  platform: "claude",
  logicalSessionKey: "env-paging-environment:paging-tab",
  providerSessionId: "paging-session",
  sourceGeneration: "generation-1",
};
const query = new URLSearchParams(window.location.search);
const mixed = query.has("mixed");
const short = query.has("short");
const tailStart = short ? 58 : 40;
const tools = Array.from({ length: 60 }, (_, index) => ({
  id: `row-${index}`,
  role: "assistant" as const,
  content: "",
  createdAt: "2026-10-18T01:33:20.000Z",
  parts: [
    ...(mixed ? [{ type: "text" as const, content: `Reached stop ${index}.` }] : []),
    {
      type: "tool-invocation" as const,
      content: "Read",
      toolName: "Read",
      toolUseId: `call-${index}`,
      toolArgs: { file_path: `trail/stop-${index}.txt` },
      toolState: "success" as const,
      toolOutput: `Body at stop ${index}`,
    },
    ...(mixed
      ? [
          {
            type: "tool-invocation" as const,
            content: "Read",
            toolName: "Read",
            toolUseId: `extra-${index}`,
            toolArgs: { file_path: `trail/extra-${index}.txt` },
            toolState: "success" as const,
            toolOutput: `Extra body at stop ${index}`,
          },
        ]
      : []),
  ],
}));
const tail = [
  ...tools.slice(tailStart),
  {
    id: "answer",
    role: "assistant" as const,
    content: "Trail complete",
    createdAt: "2026-10-18T01:34:00.000Z",
    parts: [{ type: "text" as const, content: "Trail complete" }],
  },
  ...(short
    ? Array.from({ length: 20 }, (_, index) => ({
        id: `after-${index}`,
        role: "assistant" as const,
        content: `Later message ${index}`,
        createdAt: "2026-10-18T01:35:00.000Z",
        parts: [{ type: "text" as const, content: `Later message ${index}` }],
      }))
    : []),
];
// Earlier prose leaves enough scroll range to hold the boundary group when
// the load-earlier header disappears; a row at scrollTop zero would clamp.
const earlier = [
  ...(short
    ? Array.from({ length: 4 }, (_, index) => ({
        id: `before-${index}`,
        role: "assistant" as const,
        content: `Earlier message ${index}`,
        createdAt: "2026-10-18T01:32:00.000Z",
        parts: [{ type: "text" as const, content: `Earlier message ${index}` }],
      }))
    : []),
  ...tools.slice(0, tailStart),
];
const reviewer: MultiReviewReviewerTranscript = {
  workflowId: "paging-review",
  reviewerId: "reviewer",
  workflowPhase: "ready",
  agent: "claude",
  model: "fixture",
  status: "completed",
  messages: tail,
  transcript: "snapshot",
  historyEpoch: "epoch-1",
  historyCursor: "before-40",
  truncated: true,
};
// `slow` holds the page long enough for the reader to move while it loads.
const pageDelayMs = new URLSearchParams(window.location.search).has("slow") ? 1_500 : 150;
const pause = () => new Promise((resolve) => setTimeout(resolve, pageDelayMs));
const loadTranscript = async () => reviewer;
const loadHistoryPage = async () => {
  await pause();
  return {
    status: "page" as const,
    messages: earlier,
    historyEpoch: "epoch-1",
    complete: true,
    truncated: false,
  };
};
function installBackend() {
  useEnvironmentStore.setState({
    environments: [
      {
        id: identity.environmentId,
        projectId: "paging-project",
        name: "Paging fixture",
        order: 0,
        setupPhase: "ready",
      } as never,
    ],
  });
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string) => {
      let result: unknown;
      switch (command) {
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
        case "get_native_agent_session_state_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "state-1",
            value: {
              identity,
              connection: "connected",
              turn: { phase: "idle" },
              interactions: [],
              composerControls: [],
              capabilities: nativeAgentCapabilities("claude"),
              notices: [],
            },
          };
          break;
        case "get_native_agent_transcript_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "transcript-1",
            value: {
              identity,
              freshness: "current",
              messages: tail,
              historyEpoch: "epoch-1",
              historyCursor: "before-40",
              historyPaging: "direct",
              historyComplete: false,
              messageWindow: { limit: 100, truncated: true, canLoadEarlier: true },
            },
          };
          break;
        case "get_native_agent_message_page":
          await pause();
          result = {
            syncVersion: 1,
            messages: earlier,
            historyEpoch: "epoch-1",
            complete: true,
            truncated: false,
          };
          break;
        case "get_native_agent_discovery_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "discovery-1",
            value: { identity, sections: {} },
          };
          break;
        case "get_compose_draft":
        case "delete_compose_draft":
          result = null;
          break;
        case "get_native_agent_model_catalog":
        case "get_file_tree":
        case "get_local_file_tree":
          result = [];
          break;
        // The agent information panel names the session's account.
        case "get_native_agent_session_account":
          result = null;
          break;
        case "list_agent_accounts":
          result = { accounts: [], active: { claude: "default", codex: "default" } };
          break;
        case "get_native_agent_auth_status":
          result = { state: "ready" };
          break;
        default:
          throw new Error(`Unexpected paging fixture command: ${command}`);
      }
      return result as T;
    },
  };
}
export function TranscriptPagingFixture() {
  const [installed] = useState(() => {
    installBackend();
    return true;
  });
  const [away, setAway] = useState(false);
  const review = new URLSearchParams(window.location.search).has("reviewer");
  return (
    <main
      className="flex h-screen flex-col bg-background text-foreground"
      data-installed={installed}
    >
      <button onClick={() => setAway(!away)}>
        {away ? "Return to transcript" : "Switch environment"}
      </button>
      <section className="min-h-0 flex-1" style={{ display: away ? "none" : undefined }}>
        {review ? (
          <MultiReviewReviewerTab
            data={{
              environmentId: identity.environmentId,
              workflowId: "paging-review",
              reviewerId: "reviewer",
              isLocal: true,
            }}
            isActive={!away}
            loadTranscript={loadTranscript}
            loadHistoryPage={loadHistoryPage}
          />
        ) : (
          <AgentNativeTab
            tabId="paging-tab"
            data={{
              platform: "claude",
              environmentId: identity.environmentId,
              sessionId: identity.providerSessionId,
              isLocal: true,
            }}
            isActive={!away}
          />
        )}
      </section>
      {away ? <p>Another environment</p> : null}
    </main>
  );
}
