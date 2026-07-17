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
  status?: CodexCollabAgentStatus | string;
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
  status?: "in_progress" | "completed" | "failed" | string;
}

interface LatestCollabAgentState {
  state?: CodexCollabAgentState;
  prompt?: string;
}

export const CODEX_TIMELINE_ITEM_PREFIX = "item:";
export const CODEX_TIMELINE_SUBAGENT_PREFIX = "subagent:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function isCodexCollabToolCallItem(
  value: unknown,
): value is CodexCollabToolCallItem {
  if (!isRecord(value)) return false;
  return (
    value.type === "collab_tool_call"
    && typeof value.id === "string"
    && typeof value.tool === "string"
  );
}

function isSpawnTool(tool: string): boolean {
  return tool === "spawn_agent" || tool === "spawn";
}

function getReceiverThreadIds(item: CodexCollabToolCallItem): string[] {
  const ids = new Set(asStringArray(item.receiver_thread_ids));
  if (isRecord(item.agents_states)) {
    for (const id of Object.keys(item.agents_states)) {
      if (id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

function toToolState(
  status: string | undefined,
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
  const content = message?.trim();
  if (!content) return actions;
  if (actions.some((action) => action.type === "text" && action.content === content)) {
    return actions;
  }
  return [...actions, { type: "text", content }];
}

/**
 * Codex currently emits collaboration items at runtime even though the
 * TypeScript SDK's ThreadItem declaration does not include them. Merge their
 * authoritative thread IDs and agent states into the richer transcript view.
 */
export function applyCodexCollabStateToSubagentParts(
  transcriptParts: TranscriptSubagentPart[],
  items: unknown[],
): TranscriptSubagentPart[] {
  const collabItems = items.filter(isCodexCollabToolCallItem);
  if (collabItems.length === 0) return transcriptParts;

  const latestByAgentId = new Map<string, LatestCollabAgentState>();
  const spawnItems = collabItems.filter((item) => isSpawnTool(item.tool));

  for (const item of collabItems) {
    const prompt = typeof item.prompt === "string" && item.prompt.trim().length > 0
      ? item.prompt.trim()
      : undefined;
    for (const agentId of getReceiverThreadIds(item)) {
      const previous = latestByAgentId.get(agentId);
      latestByAgentId.set(agentId, {
        state: item.agents_states?.[agentId] ?? previous?.state,
        prompt: prompt ?? previous?.prompt,
      });
    }
  }

  const parts = transcriptParts.map((part) => ({
    ...part,
    subagentActions: [...part.subagentActions],
  }));

  // Spawn events and transcript spawn calls are both stable in invocation
  // order. Pairing by index lets an early pending card acquire its thread ID as
  // soon as item.completed arrives, before the transcript output is flushed.
  spawnItems.forEach((item, index) => {
    const receiverId = getReceiverThreadIds(item)[0];
    const existing = parts[index];
    if (!existing) {
      if (!receiverId) return;
      const latest = latestByAgentId.get(receiverId);
      const toolState = toToolState(latest?.state?.status) ?? "pending";
      parts.push({
        type: "subagent",
        content: "subagent",
        subagentId: receiverId,
        subagentPrompt: latest?.prompt,
        subagentActions: appendFinalCollabMessage([], latest?.state?.message),
        subagentActionCount: 0,
        toolState,
      });
      return;
    }

    if (receiverId && !existing.subagentId) {
      existing.subagentId = receiverId;
    }
    if (!existing.subagentPrompt && typeof item.prompt === "string") {
      existing.subagentPrompt = item.prompt;
    }
  });

  const seenAgentIds = new Set<string>();
  for (const part of parts) {
    const agentId = part.subagentId;
    if (!agentId) continue;
    seenAgentIds.add(agentId);
    const latest = latestByAgentId.get(agentId);
    if (!latest) continue;
    part.subagentPrompt ??= latest.prompt;
    part.toolState = toToolState(latest.state?.status) ?? part.toolState;
    part.subagentActions = appendFinalCollabMessage(
      part.subagentActions,
      latest.state?.message,
    );
  }

  // send/wait/close can refer to an agent spawned in an earlier turn. Keep an
  // inline status row even when this turn has no matching spawn transcript.
  for (const [agentId, latest] of latestByAgentId) {
    if (seenAgentIds.has(agentId)) continue;
    parts.push({
      type: "subagent",
      content: "subagent",
      subagentId: agentId,
      subagentPrompt: latest.prompt,
      subagentActions: appendFinalCollabMessage([], latest.state?.message),
      subagentActionCount: 0,
      toolState: toToolState(latest.state?.status) ?? "pending",
    });
  }

  return parts;
}

/**
 * Keep one row per agent and move it to the end of the unified turn timeline
 * only when its visible snapshot changes. Parent items recorded afterward will
 * naturally appear below it until that agent reports more activity.
 */
export function reconcileCodexSubagentTimeline<T>(
  parts: T[],
  timelineOrder: string[],
  currentParts: Map<string, T>,
  fingerprints: Map<string, string>,
): void {
  const activeKeys = new Set<string>();

  parts.forEach((part, index) => {
    const key = `${CODEX_TIMELINE_SUBAGENT_PREFIX}${index}`;
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
