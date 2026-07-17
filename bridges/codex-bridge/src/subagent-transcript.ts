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
    subagentPrompt: base.prompt,
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

function parseWaitAgentOutcomeByAgentId(
  parentRecords: TranscriptRecord[],
): Map<string, SubagentOutcome> {
  const outcomeByAgentId = new Map<string, SubagentOutcome>();
  const waitAgentCallIds = new Set<string>();

  for (const record of parentRecords) {
    const payload = record.payload;
    if (!payload || record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call" && asString(payload.name) === "wait_agent") {
      const callId = asString(payload.call_id);
      if (callId) {
        waitAgentCallIds.add(callId);
      }
      continue;
    }

    if (payloadType !== "function_call_output" || typeof payload.output !== "string") {
      continue;
    }

    const callId = asString(payload.call_id);
    if (!callId || !waitAgentCallIds.has(callId)) {
      continue;
    }

    const output = parseJson<Record<string, unknown>>(payload.output);
    if (!isRecord(output?.status)) {
      continue;
    }

    for (const [agentId, status] of Object.entries(output.status)) {
      if (!isRecord(status)) {
        continue;
      }

      if (typeof status.completed === "string") {
        outcomeByAgentId.set(agentId, "success");
        continue;
      }

      if (
        typeof status.failed === "string"
        || typeof status.error === "string"
        || status.cancelled === true
        || status.aborted === true
      ) {
        outcomeByAgentId.set(agentId, "failure");
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
  const waitAgentOutcomeByAgentId = parseWaitAgentOutcomeByAgentId(parentRecords);

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
        agentId: resolvedAgentIdBySpawnCallId.get(callId),
        role: asString(args?.agent_type),
        prompt: asString(args?.message),
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
        ?? spawned.agentId;
      spawned.nickname = asString(output?.nickname) ?? spawned.nickname;
    }
  }

  return spawnedSubagents.map((spawned) => {
    const childRecords = spawned.agentId ? childRecordsByAgentId.get(spawned.agentId) ?? [] : [];
    const part = parseChildTranscript(childRecords, spawned);
    const parentOutcome = spawned.agentId
      ? waitAgentOutcomeByAgentId.get(spawned.agentId)
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
