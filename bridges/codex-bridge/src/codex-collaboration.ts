import type {
  TranscriptActionPart,
  TranscriptSubagentPart,
} from "./subagent-transcript.js";

export type CodexCollabAgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "not_found";

export interface CodexCollabAgentState {
  status?: CodexCollabAgentStatus;
  message?: string | null;
}

export interface CodexCollabToolCallItem {
  id: string;
  type: "collab_tool_call";
  tool: string;
  sender_thread_id?: string;
  receiver_thread_ids?: string[];
  prompt?: string | null;
  agents_states?: Record<string, CodexCollabAgentState>;
  status?: "in_progress" | "completed" | "failed";
}

interface LatestCollabAgentState {
  state?: CodexCollabAgentState;
  spawnPrompt?: string;
}

export const CODEX_TIMELINE_ITEM_PREFIX = "item:";
export const CODEX_TIMELINE_SUBAGENT_PREFIX = "subagent:";

const AGENT_STATUSES = new Set<CodexCollabAgentStatus>([
  "pending_init",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "not_found",
]);
const ITEM_STATUSES = new Set<CodexCollabToolCallItem["status"]>([
  "in_progress",
  "completed",
  "failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map(normalizeNonEmptyString)
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(normalized)];
}

function normalizeAgentState(value: unknown): CodexCollabAgentState | undefined {
  if (!isRecord(value)) return undefined;
  const status = AGENT_STATUSES.has(value.status as CodexCollabAgentStatus)
    ? value.status as CodexCollabAgentStatus
    : undefined;
  const message = value.message === null
    ? null
    : normalizeNonEmptyString(value.message);
  return {
    ...(status ? { status } : {}),
    ...(message !== undefined || value.message === null ? { message } : {}),
  };
}

/**
 * Collaboration events are not yet declared by the SDK, so every field is an
 * untrusted runtime value. Return a detached, normalized representation and
 * silently discard malformed optional fields.
 */
export function normalizeCodexCollabToolCallItem(
  value: unknown,
): CodexCollabToolCallItem | null {
  if (!isRecord(value) || value.type !== "collab_tool_call") return null;
  const id = normalizeNonEmptyString(value.id);
  const tool = normalizeNonEmptyString(value.tool);
  if (!id || !tool) return null;

  const senderThreadId = normalizeNonEmptyString(value.sender_thread_id);
  const receiverThreadIds = normalizeStringArray(value.receiver_thread_ids);
  const prompt = value.prompt === null ? null : normalizeNonEmptyString(value.prompt);
  const status = ITEM_STATUSES.has(value.status as CodexCollabToolCallItem["status"])
    ? value.status as CodexCollabToolCallItem["status"]
    : undefined;
  const agentsStates: Record<string, CodexCollabAgentState> = {};
  if (isRecord(value.agents_states)) {
    for (const [rawAgentId, rawState] of Object.entries(value.agents_states)) {
      const agentId = normalizeNonEmptyString(rawAgentId);
      const agentState = normalizeAgentState(rawState);
      if (agentId && agentState) agentsStates[agentId] = agentState;
    }
  }

  return {
    id,
    type: "collab_tool_call",
    tool,
    ...(senderThreadId ? { sender_thread_id: senderThreadId } : {}),
    ...(receiverThreadIds ? { receiver_thread_ids: receiverThreadIds } : {}),
    ...(prompt !== undefined || value.prompt === null ? { prompt } : {}),
    ...(Object.keys(agentsStates).length > 0 ? { agents_states: agentsStates } : {}),
    ...(status ? { status } : {}),
  };
}

export function isCodexCollabToolCallItem(
  value: unknown,
): value is CodexCollabToolCallItem {
  if (!isRecord(value)) return false;
  const normalized = normalizeCodexCollabToolCallItem(value);
  if (!normalized) return false;
  if (
    value.sender_thread_id !== undefined
    && typeof value.sender_thread_id !== "string"
  ) return false;
  if (
    value.receiver_thread_ids !== undefined
    && (!Array.isArray(value.receiver_thread_ids)
      || value.receiver_thread_ids.some((entry) => typeof entry !== "string"))
  ) return false;
  if (
    value.prompt !== undefined
    && value.prompt !== null
    && typeof value.prompt !== "string"
  ) return false;
  if (value.agents_states !== undefined) {
    if (!isRecord(value.agents_states)) return false;
    for (const state of Object.values(value.agents_states)) {
      if (!isRecord(state)) return false;
      if (state.status !== undefined && !AGENT_STATUSES.has(state.status as CodexCollabAgentStatus)) {
        return false;
      }
      if (state.message !== undefined && state.message !== null && typeof state.message !== "string") {
        return false;
      }
    }
  }
  return value.status === undefined
    || ITEM_STATUSES.has(value.status as CodexCollabToolCallItem["status"]);
}

function isSpawnTool(tool: string): boolean {
  return tool === "spawn_agent" || tool === "spawn";
}

function getReceiverThreadIds(item: CodexCollabToolCallItem): string[] {
  const ids = new Set(item.receiver_thread_ids ?? []);
  for (const id of Object.keys(item.agents_states ?? {})) ids.add(id);
  return [...ids];
}

/**
 * Transcript spawn outputs may expose only a task path while streamed
 * collaboration items carry the actual child thread IDs. Both sources are
 * emitted in invocation order, so retain that order for transcript hydration.
 */
export function getCodexSpawnedAgentIdsInOrder(items: unknown[]): string[] {
  return items
    .map(normalizeCodexCollabToolCallItem)
    .filter((item): item is CodexCollabToolCallItem => item !== null && isSpawnTool(item.tool))
    .flatMap(getReceiverThreadIds);
}

function toToolState(
  status: CodexCollabAgentStatus | undefined,
): TranscriptSubagentPart["toolState"] | undefined {
  switch (status) {
    case "completed":
    case "shutdown":
      return "success";
    case "interrupted":
    case "errored":
    case "not_found":
      return "failure";
    case "pending_init":
    case "running":
      return "pending";
    default:
      return undefined;
  }
}

function appendFinalCollabMessage(
  actions: TranscriptActionPart[],
  message: string | null | undefined,
): TranscriptActionPart[] {
  const content = typeof message === "string" ? message.trim() : "";
  if (!content) return actions;
  if (actions.some((action) => action.type === "text" && action.content === content)) {
    return actions;
  }
  return [...actions, { type: "text", content }];
}

function makeSubagentPart(
  agentId: string,
  latest: LatestCollabAgentState | undefined,
): TranscriptSubagentPart {
  return {
    type: "subagent",
    content: "subagent",
    subagentId: agentId,
    subagentPrompt: latest?.spawnPrompt,
    subagentActions: appendFinalCollabMessage([], latest?.state?.message),
    subagentActionCount: 0,
    toolState: toToolState(latest?.state?.status) ?? "pending",
  };
}

/**
 * Merge authoritative collaboration state into the richer transcript view.
 * Input events may be partially malformed because the SDK has not published
 * this runtime event type yet; invalid fields are ignored at this boundary.
 */
export function applyCodexCollabStateToSubagentParts(
  transcriptParts: TranscriptSubagentPart[],
  items: unknown[],
): TranscriptSubagentPart[] {
  const collabItems = items
    .map(normalizeCodexCollabToolCallItem)
    .filter((item): item is CodexCollabToolCallItem => item !== null);
  if (collabItems.length === 0) return transcriptParts;

  const latestByAgentId = new Map<string, LatestCollabAgentState>();
  const spawnItems = collabItems.filter((item) => isSpawnTool(item.tool));
  const failedSpawnAgentIds = new Set<string>();

  for (const item of collabItems) {
    const spawnPrompt = isSpawnTool(item.tool) && typeof item.prompt === "string"
      ? item.prompt
      : undefined;
    for (const agentId of getReceiverThreadIds(item)) {
      const previous = latestByAgentId.get(agentId);
      latestByAgentId.set(agentId, {
        state: item.agents_states?.[agentId] ?? previous?.state,
        spawnPrompt: previous?.spawnPrompt ?? spawnPrompt,
      });
    }
  }

  const parts = transcriptParts.map((part) => ({
    ...part,
    subagentActions: [...part.subagentActions],
  }));
  const claimedIndexes = new Set<number>();

  // Spawn events and transcript spawn calls are stable in invocation order.
  // Prefer an exact thread ID and otherwise pair an unidentified transcript row
  // by invocation order so failed spawns can also resolve their terminal state.
  spawnItems.forEach((item, spawnIndex) => {
    const receiverIds = getReceiverThreadIds(item);
    if (item.status === "failed") {
      for (const receiverId of receiverIds) failedSpawnAgentIds.add(receiverId);
    }
    const spawnPrompt = typeof item.prompt === "string" ? item.prompt : undefined;

    if (receiverIds.length === 0) {
      const existingIndex = parts.findIndex(
        (part, index) => !claimedIndexes.has(index) && !part.subagentId,
      );
      if (existingIndex < 0) return;
      const existing = parts[existingIndex]!;
      claimedIndexes.add(existingIndex);
      existing.subagentPrompt ??= spawnPrompt;
      if (item.status === "failed") existing.toolState = "failure";
      return;
    }

    receiverIds.forEach((receiverId, receiverIndex) => {
      let existingIndex = parts.findIndex((part) => part.subagentId === receiverId);
      if (existingIndex < 0) {
        const preferredIndex = spawnIndex + receiverIndex;
        if (
          !claimedIndexes.has(preferredIndex)
          && parts[preferredIndex]
          && !parts[preferredIndex]?.subagentId
        ) {
          existingIndex = preferredIndex;
        } else {
          existingIndex = parts.findIndex(
            (part, index) => !claimedIndexes.has(index) && !part.subagentId,
          );
        }
      }

      if (existingIndex < 0) {
        parts.push(makeSubagentPart(receiverId, latestByAgentId.get(receiverId)));
        claimedIndexes.add(parts.length - 1);
        return;
      }

      claimedIndexes.add(existingIndex);
      const existing = parts[existingIndex]!;
      existing.subagentId ??= receiverId;
      existing.subagentPrompt ??= spawnPrompt;
      if (item.status === "failed") existing.toolState = "failure";
    });
  });

  const seenAgentIds = new Set<string>();
  for (const part of parts) {
    const agentId = part.subagentId;
    if (!agentId) continue;
    if (seenAgentIds.has(agentId)) continue;
    seenAgentIds.add(agentId);
    const latest = latestByAgentId.get(agentId);
    if (!latest) continue;
    part.subagentPrompt ??= latest.spawnPrompt;
    part.toolState = toToolState(latest.state?.status) ?? part.toolState;
    if (failedSpawnAgentIds.has(agentId)) part.toolState = "failure";
    part.subagentActions = appendFinalCollabMessage(
      part.subagentActions,
      latest.state?.message,
    );
  }

  // send/wait/close can refer to an agent spawned in an earlier turn. Keep an
  // inline status row even when this turn has no matching spawn transcript.
  for (const [agentId, latest] of latestByAgentId) {
    if (seenAgentIds.has(agentId)) continue;
    parts.push(makeSubagentPart(agentId, latest));
  }

  return parts;
}

function timelineKeyForSubagent(
  part: { subagentId?: string },
  index: number,
  occurrences: Map<string, number>,
): string {
  const escapedAgentId = part.subagentId
    ?.replaceAll("%", "%25")
    .replaceAll(":", "%3A");
  const identity = part.subagentId
    ? `id:${escapedAgentId}`
    : `anonymous:${index}`;
  const occurrence = occurrences.get(identity) ?? 0;
  occurrences.set(identity, occurrence + 1);
  return `${CODEX_TIMELINE_SUBAGENT_PREFIX}${identity}${occurrence > 0 ? `:${occurrence}` : ""}`;
}

/**
 * Keep one row per agent and move it to the end of the unified turn timeline
 * only when its visible snapshot changes. Stable agent identities prevent
 * removal or transcript reordering from swapping the meaning of timeline keys.
 */
export function reconcileCodexSubagentTimeline<T extends { subagentId?: string }>(
  parts: T[],
  timelineOrder: string[],
  currentParts: Map<string, T>,
  fingerprints: Map<string, string>,
): void {
  const activeKeys = new Set<string>();
  const occurrences = new Map<string, number>();

  parts.forEach((part, index) => {
    const key = timelineKeyForSubagent(part, index, occurrences);
    activeKeys.add(key);
    const fingerprint = JSON.stringify(part);
    currentParts.set(key, part);

    if (fingerprints.get(key) === fingerprint) return;
    fingerprints.set(key, fingerprint);
    const previousIndex = timelineOrder.indexOf(key);
    if (previousIndex >= 0) timelineOrder.splice(previousIndex, 1);
    timelineOrder.push(key);
  });

  for (const key of [...currentParts.keys()]) {
    if (activeKeys.has(key)) continue;
    currentParts.delete(key);
    fingerprints.delete(key);
    const timelineIndex = timelineOrder.indexOf(key);
    if (timelineIndex >= 0) timelineOrder.splice(timelineIndex, 1);
  }
}
