import type { BridgeConnection } from "../agent-provider-contract.js";
import {
  ProviderUnavailableError,
  type ProviderRuntimeHealth,
  type ProviderSessionStateSnapshot,
  type ProviderStatus,
  type ProviderTranscriptSnapshot,
} from "../agent-provider-contract.js";
import type {
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  asRecord,
  INTERACTIVE_RUNTIME_METADATA_RETRY_MS,
  INTERACTIVE_RUNTIME_METADATA_TTL_MS,
  MAX_TRACKED_INTERACTION_SESSIONS,
  normalizeProviderRateLimits,
  normalizeProviderRuntimeSummary,
  setBoundedMapEntry,
} from "../agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./catalog.js";
import { contextUsageWithPlanUsage, type PlanUsageState } from "../plan-usage/cache.js";
import { claudeTurnActivityFromPayload, normalizeClaudeBackgroundTasks } from "./claude-runtime.js";
import type { HttpBridgeRuntimeMetadata } from "./runtime-metadata.js";
import {
  readHttpBridgeSummaryTranscript,
  type HttpBridgeTranscriptCapabilities,
} from "./transcript-v2.js";
import { snapshotNotices } from "./runtime-health.js";
import {
  assertOk,
  boundedJson,
  sessionSnapshotBudget,
  bridgeFetch,
  bridgeSnapshotTurnRunId,
  bridgeSessionErrorFields,
  normalizeProviderAuthNotice,
  normalizeProviderReadiness,
} from "./transport.js";

export interface LegacyTranscriptSnapshot {
  messages: unknown[];
  truncated: boolean;
  /** Content is missing because of the bridge's byte bound, not a requested tail. */
  omittedByTransport: boolean;
  /** The bridge answered 404: it has no such session. */
  missing?: true;
  revision?: number;
  status?: "idle" | "running" | "error";
  error?: string;
}

export async function readHttpBridgeLegacyTranscript(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
  /**
   * Newest messages wanted. A bridge that predates `?limit=` ignores it and
   * answers the whole window, so the caller keeps its own slice.
   */
  limit?: number;
}): Promise<LegacyTranscriptSnapshot> {
  const query = input.limit === undefined ? "" : `?limit=${input.limit}`;
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/messages${query}`,
    {},
    input.fetchImpl,
  );
  if (response.status === 404) {
    return { messages: [], truncated: false, omittedByTransport: false, missing: true };
  }
  assertOk(response, `${input.agent} transcript read`);
  const body = asRecord(
    await boundedJson(response, `${input.agent} transcript read`, { remaining: 16 * 1024 * 1024 }),
  );
  const messageWindow = asRecord(body?.messageWindow);
  const transcriptStatus = body?.status;
  const messages: unknown[] = Array.isArray(body?.messages) ? body.messages : [];
  const truncated = messageWindow?.truncated === true;
  // A bridge that predates `?limit=` sends the whole window; the slice kept
  // here then cuts rows the bridge did not report cutting.
  const cut = input.limit !== undefined && messages.length > input.limit;
  return {
    messages: cut ? messages.slice(-input.limit!) : messages,
    truncated: truncated || cut,
    // A tail read reports its own cut as truncation too. Exactly `limit` whole
    // rows is that cut; fewer, more (a bridge that ignored it) or shed parts are
    // the bridge's transport bound speaking.
    omittedByTransport:
      truncated &&
      (input.limit === undefined ||
        messages.length !== input.limit ||
        (Number.isSafeInteger(messageWindow?.omittedParts) &&
          (messageWindow!.omittedParts as number) > 0)),
    ...(Number.isSafeInteger(body?.revision) ? { revision: body!.revision as number } : {}),
    ...(transcriptStatus === "idle" ||
    transcriptStatus === "running" ||
    transcriptStatus === "error"
      ? { status: transcriptStatus }
      : {}),
    ...(typeof body?.error === "string" ? { error: body.error } : {}),
  };
}

export async function readHttpBridgeTranscriptSnapshot(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
  options: {
    limit: number;
    targetBytes: number;
    knownSourceToken?: string;
    representation?: "summary";
  };
  /** Present when summaries may be requested; records what the bridge answered. */
  capabilities?: HttpBridgeTranscriptCapabilities;
}): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
  if (
    input.options.representation === "summary" &&
    input.capabilities?.supports("summaries") === true
  ) {
    const summary = await readHttpBridgeSummaryTranscript(input);
    if (summary.kind === "summary") {
      input.capabilities.markSupported("summaries");
      return summary.result;
    }
    if (summary.response.status === 404 || summary.response.status === 405) {
      return transcriptRouteAbsent(input.agent, summary.response.status);
    }
    // An older bridge ignored `version=2` and answered v1: that body is still
    // a valid answer to this read, so use it rather than asking again.
    input.capabilities.markUnsupported("summaries");
    return mapV1TranscriptBody(input.agent, summary.body);
  }
  const query = new URLSearchParams({
    version: "1",
    limit: String(input.options.limit),
    targetBytes: String(input.options.targetBytes),
  });
  if (input.options.knownSourceToken) query.set("knownToken", input.options.knownSourceToken);
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/transcript?${query.toString()}`,
    {},
    input.fetchImpl,
  );
  if (response.status === 404 || response.status === 405) {
    return transcriptRouteAbsent(input.agent, response.status);
  }
  assertOk(response, `${input.agent} progressive transcript read`);
  const body = asRecord(
    await boundedJson(response, `${input.agent} progressive transcript read`, {
      remaining: 16 * 1024 * 1024,
    }),
  );
  return mapV1TranscriptBody(input.agent, body);
}

/**
 * `/transcript` answered 404 or 405. Every bridge serves the route, and the
 * Claude bridge loads a persisted session that is not resident before it
 * answers, so a 404 means the bridge holds no such session: an empty,
 * complete window, as OpenCode answers for a session it does not hold.
 *
 * The whole-body `/messages` fallback that older bridges needed here retired
 * on 2026-11-15 under the user's legacy-retirement decision (#2285);
 * every bridge and container image is updated together. A 405 can only come
 * from a bridge that predates the route, which this backend no longer reads
 * around: the read fails, and a bridge restart picks up the current bridge.
 */
function transcriptRouteAbsent(agent: HttpBridgeAgent, status: number): ProviderTranscriptSnapshot {
  if (status === 405) {
    throw new ProviderUnavailableError(
      `${agent} bridge predates the transcript route; restart the bridge to update it`,
    );
  }
  return { messages: [], complete: true, freshness: "current" };
}

function mapV1TranscriptBody(
  agent: HttpBridgeAgent,
  body: Record<string, unknown> | null | undefined,
): ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string } {
  if (body?.status === "unchanged" && typeof body.token === "string") {
    return { unchanged: true, sourceToken: body.token };
  }
  if (body?.status !== "snapshot" || typeof body.token !== "string") {
    throw new ProviderUnavailableError(`${agent} returned a malformed transcript update`);
  }
  const value = asRecord(body.value);
  if (!value || !Array.isArray(value.messages)) {
    throw new ProviderUnavailableError(`${agent} returned a malformed transcript snapshot`);
  }
  const generation =
    typeof value.generation === "string" || Number.isSafeInteger(value.generation)
      ? String(value.generation)
      : "unknown";
  const contentEpoch =
    typeof value.contentEpoch === "string" || Number.isSafeInteger(value.contentEpoch)
      ? String(value.contentEpoch)
      : "legacy";
  const messageWindow = asRecord(value.messageWindow);
  const omittedParts = messageWindow?.omittedParts;
  const omittedMessages = messageWindow?.omittedMessages;
  return {
    messages: value.messages,
    ...(Number.isSafeInteger(omittedParts) && (omittedParts as number) > 0
      ? { omittedParts: omittedParts as number }
      : {}),
    ...(messageWindow?.truncationReason === "bytes" &&
    Number.isSafeInteger(omittedMessages) &&
    (omittedMessages as number) > 0
      ? { byteOmittedMessages: omittedMessages as number }
      : {}),
    ...(Number.isSafeInteger(value.startIndex) && (value.startIndex as number) >= 0
      ? { historyStartIndex: value.startIndex as number }
      : {}),
    sourceToken: body.token,
    complete: value.complete === true,
    ...(typeof value.title === "string" && value.title.trim() ? { title: value.title.trim() } : {}),
    ...(Number.isSafeInteger(value.revision) ? { revision: value.revision as number } : {}),
    ...(typeof value.generation === "string" || Number.isSafeInteger(value.generation)
      ? { generation: value.generation as string | number }
      : {}),
    historyEpoch: `${generation.slice(0, 63)}:${contentEpoch.slice(0, 63)}`,
    freshness: value.freshness === "cached" ? "cached" : "current",
  };
}

/**
 * What one state read returned: the state body and, for Codex, `/config` and,
 * for Pi, `/queue`. Read in full here, or through the state revision cache
 * (`HttpBridgeStateReads`), which reuses the last one when the bridge answers
 * `unchanged`.
 */
export interface HttpBridgeSessionStateSource {
  payload: Record<string, unknown>;
  /** Codex `/config`. */
  config?: Record<string, unknown> | null;
  /** Pi `/queue`; absent when that read failed. */
  queue?: Record<string, unknown> | null;
}

export interface HttpBridgeSessionStateReadInput {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
  planUsage?: PlanUsageState;
  /** The conditional reader (to-do 8102 task 2); without it every read is full. */
  stateReads?: { read(sessionId: string): Promise<HttpBridgeSessionStateSource | "missing"> };
}

export function httpBridgeSessionStatePath(agent: HttpBridgeAgent, sessionId: string): string {
  const encodedSessionId = encodeURIComponent(sessionId);
  return agent === "claude"
    ? `/session/${encodedSessionId}`
    : `/session/${encodedSessionId}/status`;
}

/** The state body's read: shared by the full and the conditional reader. */
export async function readHttpBridgeStateBody(
  input: Pick<HttpBridgeSessionStateReadInput, "agent" | "connection" | "fetchImpl">,
  response: Response,
): Promise<Record<string, unknown>> {
  assertOk(response, `${input.agent} session state read`);
  return (
    asRecord(
      await boundedJson(
        response,
        `${input.agent} session state read`,
        sessionSnapshotBudget(input.agent, 512 * 1024),
      ),
    ) ?? {}
  );
}

export async function readHttpBridgeStateConfig(
  response: Response,
): Promise<Record<string, unknown> | null> {
  assertOk(response, "Codex session state config read");
  return (
    asRecord(
      await boundedJson(response, "Codex session state config read", {
        remaining: 128 * 1024,
      }),
    ) ?? null
  );
}

export async function readHttpBridgeStateQueue(
  response: Response | undefined,
): Promise<Record<string, unknown> | null> {
  if (!response?.ok) return null;
  return asRecord(await boundedJson(response, "Pi queue state", { remaining: 256 * 1024 })) ?? null;
}

/** One full state read, as every read was before the state revision. */
export async function fetchHttpBridgeSessionStateSource(
  input: Pick<HttpBridgeSessionStateReadInput, "agent" | "connection" | "fetchImpl" | "sessionId">,
): Promise<HttpBridgeSessionStateSource | "missing"> {
  const encodedSessionId = encodeURIComponent(input.sessionId);
  const [sessionResponse, configResponse, queueResponse] = await Promise.all([
    bridgeFetch(
      input.connection,
      httpBridgeSessionStatePath(input.agent, input.sessionId),
      {},
      input.fetchImpl,
    ),
    input.agent === "codex"
      ? bridgeFetch(input.connection, `/session/${encodedSessionId}/config`, {}, input.fetchImpl)
      : Promise.resolve(undefined),
    input.agent === "pi"
      ? bridgeFetch(
          input.connection,
          `/session/${encodedSessionId}/queue`,
          {},
          input.fetchImpl,
        ).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  if (sessionResponse.status === 404) return "missing";
  const payload = await readHttpBridgeStateBody(input, sessionResponse);
  const config = configResponse ? await readHttpBridgeStateConfig(configResponse) : undefined;
  const queue = input.agent === "pi" ? await readHttpBridgeStateQueue(queueResponse) : undefined;
  return {
    payload,
    ...(config === undefined ? {} : { config }),
    ...(queue === undefined ? {} : { queue }),
  };
}

export async function readHttpBridgeSessionState(
  input: HttpBridgeSessionStateReadInput,
): Promise<ProviderSessionStateSnapshot> {
  const source = input.stateReads
    ? await input.stateReads.read(input.sessionId)
    : await fetchHttpBridgeSessionStateSource(input);
  if (source === "missing") return { status: "missing" };
  return mapHttpBridgeSessionState(input, source);
}

/** The provider snapshot of one state read. Pure: a reused source maps the same. */
export function mapHttpBridgeSessionState(
  input: Pick<HttpBridgeSessionStateReadInput, "agent" | "connection" | "planUsage">,
  source: HttpBridgeSessionStateSource,
): ProviderSessionStateSnapshot {
  const payload = source.payload;
  const rawStatus = payload.status;
  const status: ProviderStatus =
    rawStatus === "idle" ||
    rawStatus === "running" ||
    rawStatus === "blocked" ||
    rawStatus === "error"
      ? rawStatus
      : "error";
  let controls: NativeAgentControlUpdate | undefined;
  let policy = isNativeAgentExecutionPolicy(payload.policy) ? payload.policy : undefined;
  if (source.config !== undefined) {
    const config = source.config;
    // Config is also authoritative on bridges predating policy in /status.
    if (isNativeAgentExecutionPolicy(config?.policy)) policy = config.policy;
    controls = {
      ...(typeof config?.model === "string" ? { modelId: config.model } : {}),
      ...(typeof config?.modelReasoningEffort === "string"
        ? { reasoningId: config.modelReasoningEffort }
        : {}),
      ...(config?.mode === "build" || config?.mode === "plan" ? { mode: config.mode } : {}),
      ...(typeof config?.fastMode === "boolean" ? { fastMode: config.fastMode } : {}),
    };
  }
  const composer = asRecord(payload.composer);
  const rawPhase = payload.phase;
  const phase: NativeAgentTurnPhase =
    rawPhase === "blocked"
      ? "blocked"
      : rawPhase === "cancelling"
        ? "cancelling"
        : rawPhase === "recovering" || rawPhase === "starting"
          ? "recovering"
          : rawPhase === "failed" || status === "error"
            ? "error"
            : rawPhase === "running" || status === "running"
              ? "running"
              : "idle";
  const bridgeQueue = source.queue ?? undefined;
  const readiness = normalizeProviderReadiness(payload.readiness);
  const authNotice = normalizeProviderAuthNotice(payload.authNotice);
  const contextUsage = contextUsageWithPlanUsage(
    input.planUsage,
    input.agent,
    payload.contextUsage,
    input.connection.accountId ?? "unknown",
  );
  const runtime = normalizeProviderRuntimeSummary(payload.runtime);
  const reportedKinds = asRecord(asRecord(payload.capabilities)?.interactions)?.kinds;
  const backgroundTasks = normalizeClaudeBackgroundTasks(payload.backgroundTasks);
  // Pi reports `activity: "compacting"` in the same shape while it compacts.
  const turnActivity =
    input.agent === "claude" || input.agent === "pi"
      ? claudeTurnActivityFromPayload(payload)
      : undefined;
  const rateLimits = normalizeProviderRateLimits(payload.rateLimits);
  const turnRunId = status === "running" ? bridgeSnapshotTurnRunId(payload) : undefined;
  return {
    status,
    phase,
    ...(turnActivity ? { turnActivity } : {}),
    ...(turnRunId ? { turnRunId } : {}),
    ...(typeof payload.resumableSessionId === "string" && payload.resumableSessionId.trim()
      ? { resumableSessionId: payload.resumableSessionId.trim() }
      : input.agent === "codex" && typeof payload.threadId === "string" && payload.threadId.trim()
        ? { resumableSessionId: payload.threadId.trim() }
        : {}),
    ...(typeof payload.title === "string" && payload.title.trim()
      ? { title: payload.title.trim() }
      : {}),
    ...(controls && Object.keys(controls).length > 0 ? { controls } : {}),
    ...(composer && Array.isArray(composer.models) && Array.isArray(composer.modes)
      ? { composer: composer as unknown as NativeAgentComposerState }
      : {}),
    ...(readiness ? { readiness } : {}),
    ...(authNotice ? { notices: [authNotice] } : {}),
    ...(typeof payload.turnStartedAt === "string" &&
    Number.isFinite(Date.parse(payload.turnStartedAt))
      ? { turnStartedAt: Date.parse(payload.turnStartedAt) }
      : typeof payload.turnStartedAt === "number" && Number.isFinite(payload.turnStartedAt)
        ? { turnStartedAt: payload.turnStartedAt }
        : {}),
    ...(Number.isSafeInteger(payload.messageRevision)
      ? { providerRevision: payload.messageRevision as number }
      : Number.isSafeInteger(payload.revision)
        ? { providerRevision: payload.revision as number }
        : {}),
    ...(Number.isSafeInteger(payload.engineGeneration)
      ? { providerGeneration: payload.engineGeneration as number }
      : {}),
    ...(Number.isSafeInteger(payload.commandRevision)
      ? { commandCatalogueRevision: payload.commandRevision as number }
      : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(runtime ? { runtime } : {}),
    ...(typeof payload.runtimeHealthAuthoritative === "boolean"
      ? { runtimeHealthAuthoritative: payload.runtimeHealthAuthoritative }
      : {}),
    ...(policy ? { policy } : {}),
    ...(Array.isArray(bridgeQueue?.items)
      ? { providerQueue: { items: bridgeQueue.items.slice(0, 512) } }
      : {}),
    ...(Array.isArray(reportedKinds)
      ? {
          interactionKinds: reportedKinds.filter(
            (kind): kind is string => typeof kind === "string",
          ),
        }
      : {}),
    ...(backgroundTasks ? { backgroundTasks } : {}),
    ...(typeof payload.promptSuggestion === "string"
      ? { suggestedPrompt: payload.promptSuggestion.slice(0, 4_000) }
      : {}),
    ...(typeof payload.completionBlockedByBackgroundTasks === "boolean"
      ? { completionBlockedByBackgroundTasks: payload.completionBlockedByBackgroundTasks }
      : {}),
    ...(rateLimits.length > 0 ? { rateLimits } : {}),
    ...bridgeSessionErrorFields(payload),
  };
}

export async function readHttpBridgeAuthoritativeSessionState(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
  planUsage?: PlanUsageState;
  stateReads?: HttpBridgeSessionStateReadInput["stateReads"];
  metadata: Map<string, HttpBridgeRuntimeMetadata>;
  refreshRuntimeMetadata: () => Promise<void>;
  readRuntimeHealth: () => Promise<ProviderRuntimeHealth>;
}): Promise<ProviderSessionStateSnapshot> {
  const cachedMetadata = input.metadata.get(input.sessionId);
  const refreshMetadata = !cachedMetadata || cachedMetadata.expiresAt <= Date.now();
  if (cachedMetadata && refreshMetadata) {
    // Keep serving the last authoritative runtime conditions while the
    // no-touch health route refreshes them in the background.
    void input.refreshRuntimeMetadata().catch(() => undefined);
  }
  const [snapshot, health] = await Promise.all([
    readHttpBridgeSessionState(input),
    refreshMetadata && !cachedMetadata ? input.readRuntimeHealth() : Promise.resolve(undefined),
  ]);
  if (snapshot.status === "missing") return snapshot;

  const healthRuntime =
    health && Object.keys(health.summary).length > 0 ? health.summary : undefined;
  const runtime =
    healthRuntime || snapshot.runtime || cachedMetadata?.runtime
      ? { ...cachedMetadata?.runtime, ...snapshot.runtime, ...healthRuntime }
      : undefined;
  if (refreshMetadata && !cachedMetadata && health) {
    setBoundedMapEntry(
      input.metadata,
      input.sessionId,
      {
        expiresAt:
          Date.now() +
          (health.authoritative === false
            ? INTERACTIVE_RUNTIME_METADATA_RETRY_MS
            : INTERACTIVE_RUNTIME_METADATA_TTL_MS),
        ...(runtime ? { runtime } : {}),
        runtimeHealthAuthoritative: health.authoritative !== false,
      },
      MAX_TRACKED_INTERACTION_SESSIONS,
    );
  }
  return {
    ...snapshot,
    ...(runtime ? { runtime } : {}),
    ...(health
      ? { runtimeHealthAuthoritative: health.authoritative !== false }
      : cachedMetadata?.runtimeHealthAuthoritative !== undefined
        ? { runtimeHealthAuthoritative: cachedMetadata.runtimeHealthAuthoritative }
        : {}),
    notices: snapshotNotices({
      transcriptTruncated: false,
      ...(runtime ? { runtime } : {}),
      ...(snapshot.notices?.[0]?.kind === "auth" ? { auth: snapshot.notices[0] } : {}),
    }),
  };
}
