import {
  deriveSubagentPartsFromTranscriptRecords,
  parseSubAgentActivityRecords,
  type TranscriptRecord,
  type TranscriptSubagentPart,
} from "./subagent-transcript.js";

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
  fallbackAgentIdsInSpawnOrder?: readonly (string | undefined)[];
  loadSessionMeta: (threadId: string) => Promise<PersistedSessionMetaLike | null>;
  loadTranscript: (path: string) => Promise<TranscriptLike>;
}

interface SpawnOutputAgent {
  callId: string;
  agentId: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function parseSpawnOutputAgent(record: TranscriptRecord): SpawnOutputAgent | null {
  if (
    record.type !== "response_item"
    || record.payload?.type !== "function_call_output"
    || typeof record.payload.output !== "string"
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
  fallbackAgentIdsInSpawnOrder = [],
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
  const turnEndedAt = currentTurnEndedAt === undefined
    ? undefined
    : new Date(currentTurnEndedAt).getTime();
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

  if (parentRecords.length === 0) {
    return [];
  }

  const resolvedAgentIdBySpawnCallId = new Map<string, string>();
  const spawnCalls = parentRecords.flatMap((record) => {
    if (
      record.type !== "response_item"
      || record.payload?.type !== "function_call"
      || record.payload.name !== "spawn_agent"
    ) {
      return [];
    }
    if (turnEndedAt !== undefined) {
      const timestamp = record.timestamp ? new Date(record.timestamp).getTime() : Number.NaN;
      if (Number.isNaN(timestamp) || timestamp >= turnEndedAt) return [];
    }
    const callId = asNonEmptyString(record.payload.call_id);
    return callId ? [callId] : [];
  });
  const selectedSpawnCallIds = new Set(spawnCalls);
  const outputAgentIdByCallId = new Map<string, string>();

  for (const record of parentRecords) {
    const outputAgent = parseSpawnOutputAgent(record);
    if (outputAgent) outputAgentIdByCallId.set(outputAgent.callId, outputAgent.agentId);
  }

  // Multi-agent v2 spawn outputs only return a task path; the child thread ID
  // arrives through sub_agent_activity event records keyed by the spawn call.
  const activityAgentIdByCallId = new Map<string, string>();
  for (const activity of parseSubAgentActivityRecords(parentRecords)) {
    if (!activityAgentIdByCallId.has(activity.callId)) {
      activityAgentIdByCallId.set(activity.callId, activity.agentThreadId);
    }
  }

  const requestedAgentIds = new Set<string>();
  for (const [spawnIndex, spawnCallId] of spawnCalls.entries()) {
    const fallbackAgentId = asNonEmptyString(fallbackAgentIdsInSpawnOrder[spawnIndex]);
    const requestedAgentId = activityAgentIdByCallId.get(spawnCallId)
      ?? outputAgentIdByCallId.get(spawnCallId)
      ?? fallbackAgentId;
    if (!requestedAgentId) continue;

    resolvedAgentIdBySpawnCallId.set(spawnCallId, requestedAgentId);
    requestedAgentIds.add(requestedAgentId);
  }

  const childRecordsByAgentId = new Map(await Promise.all(
    [...requestedAgentIds].map(async (requestedAgentId) => {
      const childMeta = await loadSessionMeta(requestedAgentId);
      const childRecords = childMeta?.transcriptPath
        ? (await loadTranscript(childMeta.transcriptPath)).records
        : [];
      return [requestedAgentId, childRecords] as const;
    }),
  ));

  // Keep lifecycle/output records after the segment boundary so a subagent
  // spawned above a steer can still progress to completion there. Only later
  // spawn calls themselves are removed; otherwise they would be rediscovered
  // in every post-steer assistant row.
  const scopedParentRecords = turnEndedAt === undefined
    ? parentRecords
    : parentRecords.filter((record) => {
        if (
          record.type !== "response_item"
          || record.payload?.type !== "function_call"
          || record.payload.name !== "spawn_agent"
        ) {
          return true;
        }
        const callId = asNonEmptyString(record.payload.call_id);
        return !!callId && selectedSpawnCallIds.has(callId);
      });

  return deriveSubagentPartsFromTranscriptRecords(
    scopedParentRecords,
    childRecordsByAgentId,
    resolvedAgentIdBySpawnCallId,
  );
}
