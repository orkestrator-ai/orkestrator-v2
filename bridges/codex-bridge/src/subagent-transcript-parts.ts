import {
  deriveSubagentPartFromChildRecords,
  deriveSubagentPartsFromTranscriptRecords,
  parseSubAgentActivityRecords,
  type TranscriptRecord,
  type TranscriptSubagentPart,
} from "./subagent-transcript.js";
import {
  parseSpawnResult,
  parentAgentPath,
  requestedSpawnPath,
  type SpawnResult,
} from "./subagent-spawn.js";

export interface PersistedSessionMetaLike {
  transcriptPath?: string | null;
}

export interface TranscriptLike {
  records: TranscriptRecord[];
}

interface DeriveTranscriptSubagentPartsOptions {
  threadId?: string | null;
  currentTurnStartedAt?: string;
  /** Optional exclusive boundary for spawn calls owned by this assistant row. */
  currentTurnEndedAt?: string;
  /**
   * Agent ids this assistant row's own items claim.
   *
   * Preferred over `currentTurnEndedAt` when present: the item split comes from
   * app-server's authoritative ordering, so scoping by the ids those items name
   * puts a sub-agent card in the same row as the item that spawned it. The
   * timestamp window cannot do that — it is sampled from the bridge clock, so a
   * spawn emitted while the steer RPC was in flight lands on the wrong side.
   */
  ownedSubagentIds?: readonly string[];
  fallbackAgentIdsInSpawnOrder?: readonly (string | undefined)[];
  activityAgentIdsByPath?: ReadonlyMap<string, string | null>;
  resolveChildPaths?: (
    parentId: string,
    paths: readonly string[],
  ) => Promise<ReadonlyMap<string, string | null>>;
  loadSessionMeta: (threadId: string) => Promise<PersistedSessionMetaLike | null>;
  loadTranscript: (path: string) => Promise<TranscriptLike>;
}

interface SpawnOutputAgent {
  callId: string;
  agentId: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseSpawnOutputAgent(record: TranscriptRecord): SpawnOutputAgent | null {
  if (
    record.type !== "response_item" ||
    record.payload?.type !== "function_call_output" ||
    typeof record.payload.output !== "string"
  ) {
    return null;
  }

  try {
    const parsedOutput = JSON.parse(record.payload.output) as { agent_id?: unknown };
    const callId = asNonEmptyString(record.payload.call_id);
    const agentId = asNonEmptyString(parsedOutput.agent_id);
    return callId && agentId ? { callId, agentId } : null;
  } catch {
    return null;
  }
}

export async function deriveTranscriptSubagentPartsForTurn({
  threadId,
  currentTurnStartedAt,
  currentTurnEndedAt,
  ownedSubagentIds,
  fallbackAgentIdsInSpawnOrder = [],
  activityAgentIdsByPath = new Map(),
  resolveChildPaths,
  loadSessionMeta,
  loadTranscript,
}: DeriveTranscriptSubagentPartsOptions): Promise<TranscriptSubagentPart[]> {
  if (!threadId || !currentTurnStartedAt) {
    return [];
  }

  const parentMeta = await loadSessionMeta(threadId);
  if (!parentMeta?.transcriptPath) {
    return [];
  }

  const turnStartedAt = new Date(currentTurnStartedAt).getTime();
  if (Number.isNaN(turnStartedAt)) {
    return [];
  }
  const turnEndedAt =
    currentTurnEndedAt === undefined ? undefined : new Date(currentTurnEndedAt).getTime();
  if (turnEndedAt !== undefined && Number.isNaN(turnEndedAt)) {
    return [];
  }

  const parentTranscript = await loadTranscript(parentMeta.transcriptPath);
  const parentRecords = parentTranscript.records.filter((record) => {
    if (!record.timestamp) {
      return false;
    }

    const timestamp = new Date(record.timestamp).getTime();
    return !Number.isNaN(timestamp) && timestamp >= turnStartedAt;
  });

  // Scoping by the ids this row's items claim is exact, so the timestamp window
  // is used only when they cannot supply one.
  const owned =
    ownedSubagentIds && ownedSubagentIds.length > 0 ? new Set(ownedSubagentIds) : undefined;
  if (parentRecords.length === 0 && !owned) {
    return [];
  }
  const resolvedAgentIdBySpawnCallId = new Map<string, string>();
  const spawnCalls = parentRecords.flatMap((record) => {
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "function_call" ||
      record.payload.name !== "spawn_agent"
    ) {
      return [];
    }
    if (!owned && turnEndedAt !== undefined) {
      const timestamp = record.timestamp ? new Date(record.timestamp).getTime() : Number.NaN;
      if (Number.isNaN(timestamp) || timestamp >= turnEndedAt) return [];
    }
    const callId = asNonEmptyString(record.payload.call_id);
    return callId ? [callId] : [];
  });
  const outputAgentIdByCallId = new Map<string, string>();
  const resultsByCallId = new Map<string, SpawnResult>();
  const pathsByCallId = new Map<string, string>();
  const parentPath = parentAgentPath(parentTranscript.records);

  for (const record of parentRecords) {
    const outputAgent = parseSpawnOutputAgent(record);
    if (outputAgent) outputAgentIdByCallId.set(outputAgent.callId, outputAgent.agentId);
    const callId = asNonEmptyString(record.payload?.call_id);
    if (!callId || record.type !== "response_item") continue;
    if (record.payload?.type === "function_call" && record.payload.name === "spawn_agent") {
      const path = requestedSpawnPath(record, parentPath);
      if (path) pathsByCallId.set(callId, path);
    }
    if (record.payload?.type === "function_call_output") {
      const result = parseSpawnResult(record.payload.output);
      resultsByCallId.set(callId, result);
      if (result.agentPath) pathsByCallId.set(callId, result.agentPath);
    }
  }

  // Multi-agent v2 spawn outputs only return a task path; the child thread ID
  // arrives through sub_agent_activity event records keyed by the spawn call.
  const activityAgentIdByCallId = new Map<string, string>();
  for (const activity of parseSubAgentActivityRecords(parentRecords)) {
    if (!activityAgentIdByCallId.has(activity.callId)) {
      activityAgentIdByCallId.set(activity.callId, activity.agentThreadId);
    }
  }

  // Only unresolved successful path results need a disk discovery fallback.
  // Live evidence identifies the child before hydration and never changes row ownership.
  const unresolvedPaths = new Set<string>();
  for (const callId of spawnCalls) {
    const result = resultsByCallId.get(callId);
    const path = pathsByCallId.get(callId);
    if (
      path &&
      result?.agentPath &&
      !result.failed &&
      !activityAgentIdByCallId.has(callId) &&
      !outputAgentIdByCallId.has(callId) &&
      !activityAgentIdsByPath.has(path)
    )
      unresolvedPaths.add(path);
  }
  const persistedPaths =
    resolveChildPaths && unresolvedPaths.size > 0
      ? await resolveChildPaths(threadId, [...unresolvedPaths])
      : new Map<string, string | null>();

  const requestedAgentIds = new Set<string>();
  // In multi-agent v2 the rollout output may contain only `task_name`, while
  // the native collab item already knows the child thread id. Positional
  // pairing is safe when this row owns every spawn in the window one-for-one;
  // for steered rows spanning other spawns, keep requiring an exact activity
  // or rollout id so a child cannot be attached to the wrong assistant row.
  const successfulSpawnCalls = spawnCalls.filter((callId) => !resultsByCallId.get(callId)?.failed);
  const fallbackAgentIdByCallId = new Map<string, string>();
  if (fallbackAgentIdsInSpawnOrder.length === spawnCalls.length) {
    for (const [spawnIndex, callId] of spawnCalls.entries()) {
      const agentId = asNonEmptyString(fallbackAgentIdsInSpawnOrder[spawnIndex]);
      if (agentId) fallbackAgentIdByCallId.set(callId, agentId);
    }
  } else if (fallbackAgentIdsInSpawnOrder.length === successfulSpawnCalls.length) {
    for (const [spawnIndex, callId] of successfulSpawnCalls.entries()) {
      const agentId = asNonEmptyString(fallbackAgentIdsInSpawnOrder[spawnIndex]);
      if (agentId) fallbackAgentIdByCallId.set(callId, agentId);
    }
  }
  const ownedFallbacksAlign =
    owned !== undefined &&
    successfulSpawnCalls.every((callId) => {
      const agentId = fallbackAgentIdByCallId.get(callId);
      return agentId !== undefined && owned.has(agentId);
    });
  for (const spawnCallId of spawnCalls) {
    if (resultsByCallId.get(spawnCallId)?.failed) continue;
    const path = pathsByCallId.get(spawnCallId);
    const pathEvidence = path
      ? activityAgentIdsByPath.has(path)
        ? activityAgentIdsByPath.get(path)
        : persistedPaths.get(path)
      : undefined;
    const fallbackAgentId =
      !owned || ownedFallbacksAlign ? fallbackAgentIdByCallId.get(spawnCallId) : undefined;
    const requestedAgentId =
      activityAgentIdByCallId.get(spawnCallId) ??
      outputAgentIdByCallId.get(spawnCallId) ??
      (pathEvidence === null ? undefined : (pathEvidence ?? fallbackAgentId));
    if (!requestedAgentId) continue;
    if (owned && !owned.has(requestedAgentId)) continue;

    resolvedAgentIdBySpawnCallId.set(spawnCallId, requestedAgentId);
    requestedAgentIds.add(requestedAgentId);
  }
  // Native app-server collaboration may be invoked through Codex's custom
  // tool wrapper. In that form the parent rollout contains no direct
  // `spawn_agent` record, but the assistant segment still owns the receiver
  // thread ids. Load those child transcripts so their nicknames and updates do
  // not disappear behind a generic fallback row.
  for (const ownedAgentId of owned ?? []) requestedAgentIds.add(ownedAgentId);
  const selectedSpawnCallIds = owned
    ? new Set(resolvedAgentIdBySpawnCallId.keys())
    : new Set(spawnCalls);
  // Rejected launches have no child ID to own. Keep them in their time window.
  if (owned) {
    for (const record of parentRecords) {
      const callId = asNonEmptyString(record.payload?.call_id);
      if (
        record.type !== "response_item" ||
        record.payload?.type !== "function_call" ||
        record.payload.name !== "spawn_agent" ||
        !callId ||
        !resultsByCallId.get(callId)?.failed
      )
        continue;
      if (turnEndedAt === undefined || Date.parse(record.timestamp!) < turnEndedAt)
        selectedSpawnCallIds.add(callId);
    }
  }

  const childRecordsByAgentId = new Map(
    await Promise.all(
      [...requestedAgentIds].map(async (requestedAgentId) => {
        const childMeta = await loadSessionMeta(requestedAgentId);
        const childRecords = childMeta?.transcriptPath
          ? (await loadTranscript(childMeta.transcriptPath)).records
          : [];
        return [requestedAgentId, childRecords] as const;
      }),
    ),
  );

  // Keep lifecycle/output records outside this row's own spawns so a subagent
  // spawned above a steer can still progress to completion there. Only the
  // spawn calls belonging to another row are removed; otherwise they would be
  // rediscovered in every assistant row of the turn.
  const scopedParentRecords =
    !owned && turnEndedAt === undefined
      ? parentRecords
      : parentRecords.filter((record) => {
          if (
            record.type !== "response_item" ||
            record.payload?.type !== "function_call" ||
            record.payload.name !== "spawn_agent"
          ) {
            return true;
          }
          const callId = asNonEmptyString(record.payload.call_id);
          return !!callId && selectedSpawnCallIds.has(callId);
        });

  const derivedParts = deriveSubagentPartsFromTranscriptRecords(
    scopedParentRecords,
    childRecordsByAgentId,
    resolvedAgentIdBySpawnCallId,
  );
  const derivedAgentIds = new Set(
    derivedParts.flatMap((part) => (part.subagentId ? [part.subagentId] : [])),
  );
  for (const ownedAgentId of owned ?? []) {
    if (derivedAgentIds.has(ownedAgentId)) continue;
    derivedParts.push(
      deriveSubagentPartFromChildRecords(
        ownedAgentId,
        childRecordsByAgentId.get(ownedAgentId) ?? [],
      ),
    );
  }
  return derivedParts;
}
