type ToolState = "success" | "failure" | "pending";

export interface TranscriptActionPart {
  type: "text" | "tool-invocation";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: ToolState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
}

export interface TranscriptSubagentPart {
  type: "subagent";
  content: string;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions: TranscriptActionPart[];
  subagentActionCount: number;
  toolState: ToolState;
}

export interface TranscriptRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface SubAgentActivityRecord {
  callId: string;
  agentThreadId: string;
  agentPath?: string;
}

interface MergeablePart {
  type: string;
}

interface SpawnedSubagent {
  callId: string;
  agentId?: string;
  nickname?: string;
  role?: string;
  prompt?: string;
}

type SubagentOutcome = ToolState;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Multi-agent v2 rollouts persist inter-agent prompts as opaque encrypted
// blobs (a single long base64url token). Suppress those so the child
// transcript's plaintext user message can be shown instead.
const OPAQUE_PROMPT_PATTERN = /^[A-Za-z0-9_-]{80,}={0,2}$/;

function asDisplayablePrompt(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }

  return OPAQUE_PROMPT_PATTERN.test(text.trim()) ? undefined : text;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeTranscriptToolArgs(
  toolName: string,
  rawArgs: unknown,
): Record<string, unknown> | undefined {
  const parsed = typeof rawArgs === "string" ? parseJson<Record<string, unknown>>(rawArgs) : rawArgs;

  if (!isRecord(parsed)) {
    return typeof rawArgs === "string" && rawArgs.trim().length > 0
      ? { input: rawArgs }
      : undefined;
  }

  if (toolName === "exec_command" && typeof parsed.cmd === "string") {
    return {
      ...parsed,
      command: parsed.cmd,
    };
  }

  return parsed;
}

function stringifyOutput(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createActionPart(
  toolName: string,
  rawArgs: unknown,
  state: ToolState,
): TranscriptActionPart {
  const toolArgs = normalizeTranscriptToolArgs(toolName, rawArgs);

  return {
    type: "tool-invocation",
    content: toolName,
    toolName,
    toolArgs,
    toolState: state,
    toolTitle: toolName,
  };
}

function updateActionPart(
  part: TranscriptActionPart,
  output: unknown,
  state: ToolState | null = null,
): TranscriptActionPart {
  const serializedOutput = stringifyOutput(output);
  const nextState = state === null ? undefined : state;

  return {
    ...part,
    toolState: nextState,
    toolOutput: nextState === "failure" ? undefined : serializedOutput,
    toolError: nextState === "failure" ? serializedOutput ?? "Tool failed" : undefined,
  };
}

function isExplicitSubagentFailureEvent(eventType: string | undefined): boolean {
  if (!eventType) {
    return false;
  }

  return (
    eventType === "task_failed"
    || eventType === "task_error"
    || eventType === "task_aborted"
    || eventType === "task_cancelled"
  );
}

function resolveSubagentOutcome(
  childOutcome: SubagentOutcome,
  parentOutcome?: SubagentOutcome,
): SubagentOutcome {
  if (parentOutcome === "success" || childOutcome === "success") {
    return "success";
  }

  if (parentOutcome === "failure" || childOutcome === "failure") {
    return "failure";
  }

  return "pending";
}

function parseChildTranscript(
  records: TranscriptRecord[],
  base: SpawnedSubagent,
): TranscriptSubagentPart {
  const actions: TranscriptActionPart[] = [];
  const actionIndexByCallId = new Map<string, number>();

  let name = base.nickname;
  let role = base.role;
  let prompt = base.prompt;
  let state: ToolState = "pending";

  for (const record of records) {
    const payload = record.payload;
    if (!payload) {
      continue;
    }

    if (record.type === "session_meta") {
      name = asString(payload.agent_nickname) ?? name;
      role = asString(payload.agent_role) ?? role;
      continue;
    }

    // Multi-agent v2 encrypts the spawn prompt in the parent rollout; the
    // child transcript's first user message carries the plaintext.
    if (record.type === "event_msg" && payload.type === "user_message") {
      prompt ??= asString(payload.message);
      continue;
    }

    if (record.type === "event_msg" && payload.type === "task_complete") {
      state = "success";
      continue;
    }

    if (record.type === "event_msg" && isExplicitSubagentFailureEvent(asString(payload.type))) {
      state = "failure";
      continue;
    }

    if (record.type === "event_msg" && payload.type === "agent_message") {
      const phase = asString(payload.phase);
      const message = asString(payload.message);
      if (phase === "commentary" && message) {
        actions.push({
          type: "text",
          content: message,
        });
      }
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const toolName = asString(payload.name) ?? "tool";
      const callId = asString(payload.call_id);
      const input = payloadType === "custom_tool_call" ? payload.input : payload.arguments;
      const status = asString(payload.status);
      const initialState: ToolState =
        status === "failed"
          ? "failure"
          : status === "completed"
            ? "success"
            : "pending";
      const part = createActionPart(toolName, input, initialState);

      if (payloadType === "custom_tool_call" && (initialState === "success" || initialState === "failure")) {
        const output = payload.output;
        actions.push(updateActionPart(part, output, initialState));
      } else {
        actions.push(part);
      }

      if (callId) {
        actionIndexByCallId.set(callId, actions.length - 1);
      }
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }

      const actionIndex = actionIndexByCallId.get(callId);
      if (actionIndex === undefined) {
        continue;
      }

      const existing = actions[actionIndex] as TranscriptActionPart;
      actions[actionIndex] = updateActionPart(
        existing,
        payload.output,
        payloadType === "custom_tool_call_output" ? (existing.toolState ?? null) : null,
      );
      continue;
    }

    if (payloadType === "message" && asString(payload.phase) === "final_answer") {
      state = "success";
    }
  }

  const actionCount = actions.filter((action) => action.type === "tool-invocation").length;
  const displayName = name ?? role ?? base.agentId ?? "subagent";

  return {
    type: "subagent",
    content: displayName,
    subagentId: base.agentId,
    subagentName: name,
    subagentRole: role,
    subagentPrompt: prompt,
    subagentActions: actions,
    subagentActionCount: actionCount,
    toolState: state,
  };
}

export function parseTranscriptRecords(lines: string[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        type?: unknown;
        payload?: unknown;
      };

      records.push({
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
        type: typeof parsed.type === "string" ? parsed.type : undefined,
        payload: isRecord(parsed.payload) ? parsed.payload : undefined,
      });
    } catch {
      continue;
    }
  }

  return records;
}

/**
 * Multi-agent v2 spawn outputs no longer expose the child thread ID; it is
 * published through sub_agent_activity event records whose event_id matches
 * the originating collaboration tool call_id.
 */
export function parseSubAgentActivityRecords(
  records: TranscriptRecord[],
): SubAgentActivityRecord[] {
  const activities: SubAgentActivityRecord[] = [];

  for (const record of records) {
    const payload = record.payload;
    if (!payload || record.type !== "event_msg" || payload.type !== "sub_agent_activity") {
      continue;
    }

    const callId = asString(payload.event_id);
    const agentThreadId = asString(payload.agent_thread_id);
    if (!callId || !agentThreadId) {
      continue;
    }

    activities.push({
      callId,
      agentThreadId,
      agentPath: asString(payload.agent_path),
    });
  }

  return activities;
}

function outcomeFromAgentStatus(status: unknown): SubagentOutcome | undefined {
  if (typeof status === "string") {
    if (status === "completed" || status === "shutdown") {
      return "success";
    }
    if (status === "errored" || status === "interrupted" || status === "not_found") {
      return "failure";
    }
    return undefined;
  }

  if (!isRecord(status)) {
    return undefined;
  }

  if (typeof status.completed === "string") {
    return "success";
  }

  if (
    typeof status.failed === "string"
    || typeof status.error === "string"
    || typeof status.errored === "string"
    || status.cancelled === true
    || status.aborted === true
  ) {
    return "failure";
  }

  return undefined;
}

function parseCollabOutcomeByAgentId(
  parentRecords: TranscriptRecord[],
  agentIdByPath: ReadonlyMap<string, string>,
): Map<string, SubagentOutcome> {
  const outcomeByAgentId = new Map<string, SubagentOutcome>();
  const waitAgentCallIds = new Set<string>();
  const listAgentsCallIds = new Set<string>();

  const recordOutcome = (agentKey: string, status: unknown): void => {
    const outcome = outcomeFromAgentStatus(status);
    if (!outcome) {
      return;
    }
    outcomeByAgentId.set(agentIdByPath.get(agentKey) ?? agentKey, outcome);
  };

  for (const record of parentRecords) {
    const payload = record.payload;
    if (!payload || record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }
      const name = asString(payload.name);
      if (name === "wait_agent") {
        waitAgentCallIds.add(callId);
      } else if (name === "list_agents") {
        listAgentsCallIds.add(callId);
      }
      continue;
    }

    if (payloadType !== "function_call_output" || typeof payload.output !== "string") {
      continue;
    }

    const callId = asString(payload.call_id);
    if (!callId) {
      continue;
    }

    if (waitAgentCallIds.has(callId)) {
      const output = parseJson<Record<string, unknown>>(payload.output);
      if (!isRecord(output?.status)) {
        continue;
      }

      for (const [agentKey, status] of Object.entries(output.status)) {
        recordOutcome(agentKey, status);
      }
      continue;
    }

    // Multi-agent v2 wait_agent outputs carry no per-agent status; the
    // authoritative terminal states appear in list_agents outputs keyed by
    // agent path.
    if (listAgentsCallIds.has(callId)) {
      const output = parseJson<Record<string, unknown>>(payload.output);
      if (!Array.isArray(output?.agents)) {
        continue;
      }

      for (const agent of output.agents) {
        if (!isRecord(agent)) {
          continue;
        }
        const agentName = asString(agent.agent_name);
        if (!agentName) {
          continue;
        }
        recordOutcome(agentName, agent.agent_status);
      }
    }
  }

  return outcomeByAgentId;
}

export function deriveSubagentPartsFromTranscriptRecords(
  parentRecords: TranscriptRecord[],
  childRecordsByAgentId: Map<string, TranscriptRecord[]>,
  resolvedAgentIdBySpawnCallId: ReadonlyMap<string, string> = new Map(),
): TranscriptSubagentPart[] {
  const spawnedSubagents: SpawnedSubagent[] = [];
  const spawnedSubagentByCallId = new Map<string, SpawnedSubagent>();

  const activityAgentIdByCallId = new Map<string, string>();
  const agentIdByPath = new Map<string, string>();
  for (const activity of parseSubAgentActivityRecords(parentRecords)) {
    if (!activityAgentIdByCallId.has(activity.callId)) {
      activityAgentIdByCallId.set(activity.callId, activity.agentThreadId);
    }
    if (activity.agentPath && !agentIdByPath.has(activity.agentPath)) {
      agentIdByPath.set(activity.agentPath, activity.agentThreadId);
    }
  }

  const collabOutcomeByAgentId = parseCollabOutcomeByAgentId(parentRecords, agentIdByPath);

  for (const record of parentRecords) {
    const payload = record.payload;
    if (!payload || record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call" && asString(payload.name) === "spawn_agent") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }

      const args = parseJson<Record<string, unknown>>(payload.arguments);
      const spawned: SpawnedSubagent = {
        callId,
        agentId: resolvedAgentIdBySpawnCallId.get(callId)
          ?? activityAgentIdByCallId.get(callId),
        role: asString(args?.agent_type) ?? asString(args?.task_name),
        prompt: asDisplayablePrompt(args?.message),
      };
      spawnedSubagents.push(spawned);
      spawnedSubagentByCallId.set(callId, spawned);
      continue;
    }

    if (payloadType === "function_call_output") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }

      const spawned = spawnedSubagentByCallId.get(callId);
      if (!spawned) {
        continue;
      }

      const output = parseJson<Record<string, unknown>>(payload.output);
      spawned.agentId = asString(output?.agent_id)
        ?? resolvedAgentIdBySpawnCallId.get(callId)
        ?? activityAgentIdByCallId.get(callId)
        ?? spawned.agentId;
      spawned.nickname = asString(output?.nickname) ?? spawned.nickname;
    }
  }

  return spawnedSubagents.map((spawned) => {
    const childRecords = spawned.agentId ? childRecordsByAgentId.get(spawned.agentId) ?? [] : [];
    const part = parseChildTranscript(childRecords, spawned);
    const parentOutcome = spawned.agentId
      ? collabOutcomeByAgentId.get(spawned.agentId)
      : undefined;

    return {
      ...part,
      toolState: resolveSubagentOutcome(part.toolState, parentOutcome),
    };
  });
}

export function mergeSubagentPartsIntoMessageParts<T extends MergeablePart>(
  parts: T[],
  subagentParts: T[],
): T[] {
  if (subagentParts.length === 0) {
    return parts;
  }

  let insertIndex = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type !== "text") {
      insertIndex = index + 1;
      break;
    }
  }

  return [
    ...parts.slice(0, insertIndex),
    ...subagentParts,
    ...parts.slice(insertIndex),
  ];
}
