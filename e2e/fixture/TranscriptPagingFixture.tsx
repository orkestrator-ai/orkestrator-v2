import { useState } from "react";
import {
  nativeAgentCapabilities,
  type NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import type { MultiReviewReviewerTranscript } from "@orkestrator/protocol/multi-review";
import { AgentNativeTab } from "../../apps/web/src/components/native-agent/AgentNativeTab";
import { MultiReviewReviewerTab } from "../../apps/web/src/components/review/MultiReviewReviewerTab";
import { useNativeAgentProjectionStore } from "../../apps/web/src/stores/nativeAgentProjectionStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { disableAutoLoadEarlier } from "../../apps/web/src/components/native-agent/useAutoLoadEarlier";

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
// `bounded` reports the tail the way a view whose own byte bound dropped rows
// does: a direct cursor at the first kept row of a bytes-truncated window
// (0232). Any joined sync-v1 call fails the fixture.
const bounded = query.has("bounded");
// `churn` moves the reconciliation token on every read, as a held row too large
// to travel as a revision does while its subagents run.
const churn = query.has("churn");
let transcriptReads = 0;
// The native tab pages history in by itself as the reader nears the top.
// Without `auto` that is off, so a test can drive the button.
if (!query.has("auto")) disableAutoLoadEarlier();
// `paged=N` serves history N source rows at a time behind a cursor, as the live
// bridges do, so the first click leaves more to load. `stops=N` lengthens the
// trail and starts the tail 100 rows from its end, like the live window.
const pageSize = Number(query.get("paged") ?? 0) || undefined;
const stopCount = Number(query.get("stops") ?? 0) || 60;
const tailStart = query.has("stops") ? Math.max(0, stopCount - 100) : short ? 58 : 40;
const tools = Array.from({ length: stopCount }, (_, index) => ({
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
// `prompt` starts the conversation with the reader's prompt, as a live one
// does: the trail's calls coalesce into the boundary group, so the page adds
// only that one display row above it.
const prompt = query.has("prompt")
  ? [
      {
        id: "prompt",
        role: "user" as const,
        content: "Follow the trail.",
        createdAt: "2026-10-18T00:59:00.000Z",
        parts: [{ type: "text" as const, content: "Follow the trail.\n\n".repeat(4).trim() }],
      },
    ]
  : [];
// Earlier prose leaves enough scroll range to hold the boundary group when
// the load-earlier header disappears; a row at scrollTop zero would clamp.
const earlier = [
  ...prompt,
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
  historyCursor: `before-${tailStart}`,
  truncated: true,
};
// `slow` holds the page long enough for the reader to move while it loads.
const pageDelayMs = new URLSearchParams(window.location.search).has("slow") ? 1_500 : 150;
const pause = () => new Promise((resolve) => setTimeout(resolve, pageDelayMs));
const loadTranscript = async () => reviewer;
/** One page of `earlier` ending before `cursor` (`before-N`, N a source row). */
function pageBefore(cursor: string | undefined) {
  const end = Math.min(Number(cursor?.replace("before-", "") ?? tailStart), tailStart);
  const start = pageSize ? Math.max(0, end - pageSize) : 0;
  // `earlier` holds the short fixture's prose rows ahead of the trail rows.
  const offset = earlier.length - tailStart;
  const complete = start === 0;
  return {
    messages: earlier.slice(complete ? 0 : start + offset, end + offset),
    historyEpoch: "epoch-1",
    ...(complete ? {} : { nextCursor: `before-${start}` }),
    complete,
    truncated: false,
  };
}
const loadHistoryPage = async (_workflow: string, _reviewer: string, page: { before: string }) => {
  await pause();
  return { status: "page" as const, ...pageBefore(page.before) };
};
/** The cursors the native tab paged from, in order, for tests to read. */
const pageRequests: string[] = [];
(window as unknown as { pagingFixtureRequests: string[] }).pagingFixtureRequests = pageRequests;
/** How many rows the tab holds right now, for tests sampling every frame. */
(window as unknown as { pagingFixtureRowCount: () => number }).pagingFixtureRowCount = () =>
  useNativeAgentProjectionStore.getState().projections.get(identity.logicalSessionKey)?.messages
    .length ?? 0;
/** Appends live rows without focusing a control or changing the reader's intent. */
(window as unknown as { appendPagingFixtureRows: () => void }).appendPagingFixtureRows = () => {
  const store = useNativeAgentProjectionStore.getState();
  const projection = store.projections.get(identity.logicalSessionKey);
  if (!projection) throw new Error("Paging transcript not ready");
  store.setProjection(identity.logicalSessionKey, {
    ...projection,
    messages: [
      ...projection.messages,
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `live-${index}`,
        role: "assistant" as const,
        content: `Live message ${index}`,
        createdAt: `2026-10-31T10:00:${String(index).padStart(2, "0")}.000Z`,
        parts: [{ type: "text" as const, content: `Live message ${index}` }],
      })),
    ],
  });
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
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
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
          transcriptReads += 1;
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: churn ? `transcript-${transcriptReads}` : "transcript-1",
            value: {
              identity,
              freshness: "current",
              messages: tail,
              ...(churn ? { historyReconciliationToken: `row-digest-${transcriptReads}` } : {}),
              historyEpoch: "epoch-1",
              historyCursor: `before-${tailStart}`,
              historyPaging: "direct",
              historyComplete: false,
              messageWindow: bounded
                ? {
                    limit: 100,
                    truncated: true,
                    truncationReason: "bytes",
                    omittedMessages: tailStart,
                    canLoadEarlier: true,
                  }
                : { limit: 100, truncated: true, canLoadEarlier: true },
            },
          };
          break;
        case "get_native_agent_message_page":
          pageRequests.push(String(args?.before));
          await pause();
          result = { syncVersion: 1, ...pageBefore(args?.before as string | undefined) };
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
