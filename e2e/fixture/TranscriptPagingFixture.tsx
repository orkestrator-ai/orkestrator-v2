import { useEffect, useState } from "react";
import {
  nativeAgentCapabilities,
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
  type NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import type { MultiReviewReviewerTranscript } from "@orkestrator/protocol/multi-review";
import { AgentNativeTab } from "../../apps/web/src/components/native-agent/AgentNativeTab";
import { MultiReviewReviewerTab } from "../../apps/web/src/components/review/MultiReviewReviewerTab";
import { useNativeAgentProjectionStore } from "../../apps/web/src/stores/nativeAgentProjectionStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { disableAutoLoadEarlier } from "../../apps/web/src/components/native-agent/useAutoLoadEarlier";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

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
const restore = query.has("restore");
// `bounded` reports the tail the way a view whose own byte bound dropped rows
// does: a direct cursor at the first kept row of a bytes-truncated window
// (0232).
const bounded = query.has("bounded");
// `churn` moves the reconciliation token on every read, as a held row too large
// to travel as a revision does while its subagents run.
let churn = query.has("churn");
let transcriptReads = 0;
// `stream` keeps the turn running, so the tab polls at the active cadence.
// Once a test calls `startPagingFixtureStream`, every transcript read streams
// one row into the live tail, up to `STREAM_MAX_ROWS`. The live window keeps
// its length, so the rows it drops age out into the tab's held history, and
// each view names the provider's cursor before its own first row.
const stream = query.has("stream");
let streaming = false;
const STREAM_MAX_ROWS = 40;
const streamed: Array<{
  id: string;
  role: "assistant";
  content: string;
  createdAt: string;
  parts: Array<{ type: "text"; content: string }>;
}> = [];
// The native tab pages history in by itself as the reader nears the top.
// Without `auto` that is off, so a test can drive the button.
if (!query.has("auto")) disableAutoLoadEarlier();
// `paged=N` serves history N source rows at a time behind a cursor, as the live
// bridges do, so the first click leaves more to load. `stops=N` lengthens the
// trail and starts the tail 100 rows from its end, like the live window.
const pageSize = Number(query.get("paged") ?? 0) || undefined;
const stopCount = Number(query.get("stops") ?? 0) || (restore ? 8 : 60);
const tailStart = query.has("stops") ? Math.max(0, stopCount - 100) : restore ? 4 : short ? 58 : 40;
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
// `slow` holds the page long enough for the reader to move while it loads;
// `delay=N` holds it N ms (the streaming case holds it for 3 s).
const pageDelayMs = Number(query.get("delay") ?? 0) || (query.has("slow") ? 1_500 : 150);
const pause = () => new Promise((resolve) => setTimeout(resolve, pageDelayMs));
let reviewerHistoryLoaded = false;
const loadTranscript = async () => {
  if (!restore) return reviewer;
  if (!reviewerHistoryLoaded) return structuredClone(reviewer);
  // Reopening the transcript gets a fresh backend snapshot of the grown
  // group, without the previous view's cached objects or display aliases.
  return structuredClone({
    ...reviewer,
    messages: [...earlier, ...tail],
    historyCursor: undefined,
    truncated: false,
  });
};
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
  const result = pageBefore(page.before);
  if (restore && result.complete) reviewerHistoryLoaded = true;
  return { status: "page" as const, ...result };
};
/** The cursors the native tab paged from, in order, for tests to read. */
const pageRequests: string[] = [];
(window as unknown as { pagingFixtureRequests: string[] }).pagingFixtureRequests = pageRequests;
let pageResponses = 0;
(window as unknown as { pagingFixtureResponses: () => number }).pagingFixtureResponses = () =>
  pageResponses;
/** How many rows the tab holds right now, for tests sampling every frame. */
(window as unknown as { pagingFixtureRowCount: () => number }).pagingFixtureRowCount = () =>
  appCommandStore(useNativeAgentProjectionStore.def)
    .getState()
    .projections.get(identity.logicalSessionKey)?.messages.length ?? 0;
/** The ids of the rows the tab holds, in order, to check for duplicates. */
(window as unknown as { pagingFixtureRowIds: () => string[] }).pagingFixtureRowIds = () =>
  (
    appCommandStore(useNativeAgentProjectionStore.def)
      .getState()
      .projections.get(identity.logicalSessionKey)?.messages ?? []
  ).map((message) => String((message as { id?: unknown }).id));
/** The live tail a transcript read answers with, streaming a row in `stream` mode. */
function liveTail() {
  if (!streaming) return { messages: tail, cursor: `before-${tailStart}`, token: undefined };
  if (streamed.length < STREAM_MAX_ROWS) {
    const index = streamed.length;
    streamed.push({
      id: `streamed-${index}`,
      role: "assistant",
      content: `Streamed message ${index}`,
      createdAt: `2026-10-18T01:36:${String(index).padStart(2, "0")}.000Z`,
      parts: [{ type: "text", content: `Streamed message ${index}` }],
    });
  }
  const messages = [...tail, ...streamed].slice(streamed.length);
  return {
    messages,
    cursor: `before-${tailStart + streamed.length}`,
    token: `transcript-stream-${streamed.length}`,
  };
}
/** Starts streaming rows into the live tail (`stream` mode). */
(window as unknown as { startPagingFixtureStream: () => void }).startPagingFixtureStream = () => {
  if (stream) streaming = true;
};
/** Starts revision overflow after the test has installed its frame probe. */
(window as unknown as { startPagingFixtureChurn: () => void }).startPagingFixtureChurn = () => {
  churn = true;
};
/** Appends live rows without focusing a control or changing the reader's intent. */
(window as unknown as { appendPagingFixtureRows: () => void }).appendPagingFixtureRows = () => {
  const store = appCommandStore(useNativeAgentProjectionStore.def).getState();
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
  appCommandStore(useEnvironmentStore.def).setState({
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
  const stateUpdate = (knownToken: unknown) => {
    const token = "state-1";
    if (knownToken === token) return { viewVersion: 1, status: "unchanged", token, identity };
    return {
      viewVersion: 1,
      status: "snapshot",
      token,
      value: {
        identity,
        connection: "connected",
        turn: { phase: stream ? "running" : "idle" },
        interactions: [],
        composerControls: [],
        capabilities: nativeAgentCapabilities("claude"),
        notices: [],
      },
    };
  };
  const transcriptUpdate = (knownToken: unknown) => {
    transcriptReads += 1;
    const live = liveTail();
    const token = churn ? `transcript-churn-${transcriptReads}` : (live.token ?? "transcript-1");
    if (knownToken === token) return { viewVersion: 1, status: "unchanged", token, identity };
    return {
      viewVersion: 1,
      status: "snapshot",
      token,
      value: {
        identity,
        freshness: "current",
        messages: live.messages,
        ...(churn ? { historyReconciliationToken: `row-digest-${transcriptReads}` } : {}),
        historyEpoch: "epoch-1",
        historyCursor: live.cursor,
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
  };
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      let result: unknown;
      switch (command) {
        case "adopt_native_agent_session":
          result = {};
          break;
        case "get_native_agent_session_state_update":
          result = stateUpdate(args?.knownToken);
          break;
        case "get_native_agent_transcript_update":
          result = transcriptUpdate(args?.knownToken);
          break;
        case "get_native_agent_live_update":
          result = {
            viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
            transcript: transcriptUpdate(args?.transcriptToken),
            state: stateUpdate(args?.stateToken),
          };
          break;
        case "get_native_agent_message_page":
          pageRequests.push(String(args?.before));
          await pause();
          result = { syncVersion: 1, ...pageBefore(args?.before as string | undefined) };
          pageResponses += 1;
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
          result = [];
          break;
        case "get_file_tree":
        case "get_local_file_tree":
          // A conditional read (knownDigest) answers the envelope, as every backend does.
          result =
            args?.knownDigest === undefined ? [] : { unchanged: false, digest: "", value: [] };
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
  const [disposed, setDisposed] = useState(false);
  useEffect(() => {
    const target = window as unknown as { disposePagingTranscript?: () => void };
    const dispose = () => setDisposed(true);
    target.disposePagingTranscript = dispose;
    return () => {
      if (target.disposePagingTranscript === dispose) delete target.disposePagingTranscript;
    };
  }, []);
  const review = new URLSearchParams(window.location.search).has("reviewer");
  return (
    <main
      className="flex h-screen flex-col bg-background text-foreground"
      data-installed={installed}
      data-paging-transcript={disposed ? "disposed" : "mounted"}
    >
      <button onClick={() => setAway(!away)}>
        {away ? "Return to transcript" : "Switch environment"}
      </button>
      <section className="min-h-0 flex-1" style={{ display: away ? "none" : undefined }}>
        {!disposed &&
          (!restore || !away) &&
          (review ? (
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
          ))}
      </section>
      {away ? <p>Another environment</p> : null}
    </main>
  );
}
