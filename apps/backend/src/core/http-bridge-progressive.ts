import type { BridgeConnection } from "./agent-provider-contract.js";
import {
  ProviderUnavailableError,
  type ProviderSessionStateSnapshot,
  type ProviderStatus,
  type ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import type {
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { asRecord, normalizeProviderContextUsage } from "./agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import { normalizeClaudeBackgroundTasks } from "./http-bridge-claude-runtime.js";
import {
  assertOk,
  boundedJson,
  bridgeFetch,
  normalizeProviderReadiness,
} from "./http-bridge-transport.js";

export interface LegacyTranscriptSnapshot {
  messages: unknown[];
  truncated: boolean;
  revision?: number;
  status?: "idle" | "running" | "error";
  error?: string;
}

export async function readHttpBridgeLegacyTranscript(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
}): Promise<LegacyTranscriptSnapshot> {
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/messages`,
    {},
    input.fetchImpl,
  );
  if (response.status === 404) return { messages: [], truncated: false };
  assertOk(response, `${input.agent} transcript read`);
  const body = asRecord(
    await boundedJson(response, `${input.agent} transcript read`, { remaining: 16 * 1024 * 1024 }),
  );
  const messageWindow = asRecord(body?.messageWindow);
  const transcriptStatus = body?.status;
  return {
    messages: Array.isArray(body?.messages) ? body.messages : [],
    truncated: messageWindow?.truncated === true,
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
  options: { limit: number; targetBytes: number; knownSourceToken?: string };
  readLegacy: () => Promise<LegacyTranscriptSnapshot>;
}): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
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
    const legacy = await input.readLegacy();
    return {
      messages:
        legacy.messages.length > input.options.limit
          ? legacy.messages.slice(-input.options.limit)
          : legacy.messages,
      complete: !legacy.truncated && legacy.messages.length <= input.options.limit,
      ...(legacy.revision === undefined ? {} : { revision: legacy.revision }),
      freshness: "current",
    };
  }
  assertOk(response, `${input.agent} progressive transcript read`);
  const body = asRecord(
    await boundedJson(response, `${input.agent} progressive transcript read`, {
      remaining: 16 * 1024 * 1024,
    }),
  );
  if (body?.status === "unchanged" && typeof body.token === "string") {
    return { unchanged: true, sourceToken: body.token };
  }
  if (body?.status !== "snapshot" || typeof body.token !== "string") {
    throw new ProviderUnavailableError(`${input.agent} returned a malformed transcript update`);
  }
  const value = asRecord(body.value);
  if (!value || !Array.isArray(value.messages)) {
    throw new ProviderUnavailableError(`${input.agent} returned a malformed transcript snapshot`);
  }
  const generation =
    typeof value.generation === "string" || Number.isSafeInteger(value.generation)
      ? String(value.generation)
      : "unknown";
  const contentEpoch =
    typeof value.contentEpoch === "string" || Number.isSafeInteger(value.contentEpoch)
      ? String(value.contentEpoch)
      : "legacy";
  return {
    messages: value.messages,
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

export async function readHttpBridgeSessionState(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
}): Promise<ProviderSessionStateSnapshot> {
  const encodedSessionId = encodeURIComponent(input.sessionId);
  const sessionPath =
    input.agent === "claude"
      ? `/session/${encodedSessionId}`
      : `/session/${encodedSessionId}/status`;
  const [sessionResponse, configResponse, queueResponse] = await Promise.all([
    bridgeFetch(input.connection, sessionPath, {}, input.fetchImpl),
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
  if (sessionResponse.status === 404) return { status: "missing" };
  assertOk(sessionResponse, `${input.agent} session state read`);
  const payload =
    asRecord(
      await boundedJson(sessionResponse, `${input.agent} session state read`, {
        remaining: 512 * 1024,
      }),
    ) ?? {};
  const rawStatus = payload.status;
  const status: ProviderStatus =
    rawStatus === "idle" ||
    rawStatus === "running" ||
    rawStatus === "blocked" ||
    rawStatus === "error"
      ? rawStatus
      : "error";
  let controls: NativeAgentControlUpdate | undefined;
  if (configResponse) {
    assertOk(configResponse, "Codex session state config read");
    const config = asRecord(
      await boundedJson(configResponse, "Codex session state config read", {
        remaining: 128 * 1024,
      }),
    );
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
  const bridgeQueue = queueResponse?.ok
    ? asRecord(await boundedJson(queueResponse, "Pi queue state", { remaining: 256 * 1024 }))
    : undefined;
  const readiness = normalizeProviderReadiness(payload.readiness);
  const contextUsage = normalizeProviderContextUsage(payload.contextUsage);
  const policy = isNativeAgentExecutionPolicy(payload.policy) ? payload.policy : undefined;
  const reportedKinds = asRecord(asRecord(payload.capabilities)?.interactions)?.kinds;
  const backgroundTasks = normalizeClaudeBackgroundTasks(payload.backgroundTasks);
  return {
    status,
    phase,
    ...(typeof payload.title === "string" && payload.title.trim()
      ? { title: payload.title.trim() }
      : {}),
    ...(controls && Object.keys(controls).length > 0 ? { controls } : {}),
    ...(composer && Array.isArray(composer.models) && Array.isArray(composer.modes)
      ? { composer: composer as unknown as NativeAgentComposerState }
      : {}),
    ...(readiness ? { readiness } : {}),
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
    ...(contextUsage ? { contextUsage } : {}),
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
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
  };
}
