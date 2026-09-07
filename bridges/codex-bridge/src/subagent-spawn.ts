import type { TranscriptRecord } from "./subagent-transcript.js";

export interface SpawnResult {
  agentId?: string;
  agentPath?: string;
  failed?: true;
}

export function parseSpawnResult(output: unknown): SpawnResult {
  if (typeof output !== "string") return {};
  if (output.trim() === "collab spawn failed: agent thread limit reached") return { failed: true };
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      ...(typeof value.agent_id === "string" && value.agent_id.trim()
        ? { agentId: value.agent_id }
        : {}),
      ...(validAgentPath(value.task_name) ? { agentPath: value.task_name } : {}),
    };
  } catch {
    return {};
  }
}

export function validAgentPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/root")) return false;
  const segments = value.split("/");
  return (
    segments[0] === "" &&
    segments[1] === "root" &&
    segments.slice(2).every((segment) => {
      const trimmed = segment.trim();
      return (
        trimmed.length > 0 &&
        trimmed === segment &&
        trimmed !== "." &&
        trimmed !== ".." &&
        !/[\u0000-\u001F\u007F]/.test(trimmed)
      );
    })
  );
}

/** Retain conflicts as unknown; insertion order must never choose a child. */
export function indexAgentPaths(items: readonly unknown[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (
      item.type !== "subagent_activity" ||
      !validAgentPath(item.agent_path) ||
      typeof item.agent_thread_id !== "string" ||
      !item.agent_thread_id.trim()
    )
      continue;
    const previous = result.get(item.agent_path);
    result.set(
      item.agent_path,
      previous === undefined || previous === item.agent_thread_id ? item.agent_thread_id : null,
    );
  }
  return result;
}

/** Only a known parent path can qualify a requested short name before output. */
export function requestedSpawnPath(
  record: TranscriptRecord,
  parentPath?: string,
): string | undefined {
  if (!parentPath || typeof record.payload?.arguments !== "string") return undefined;
  try {
    const name = JSON.parse(record.payload.arguments)?.task_name;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 512 ||
      name.trim() !== name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      /[\u0000-\u001F\u007F]/.test(name)
    )
      return undefined;
    const path = `${parentPath}/${name}`;
    return validAgentPath(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function parentAgentPath(records: readonly TranscriptRecord[]): string | undefined {
  const source = records.find((record) => record.type === "session_meta")?.payload?.source;
  if (typeof source === "string") return "/root";
  if (!source || typeof source !== "object") return undefined;
  if (!("subagent" in source)) return "/root";
  const subagent = (source as { subagent?: unknown }).subagent;
  if (!subagent || typeof subagent !== "object") return undefined;
  const path = (subagent as { thread_spawn?: { agent_path?: unknown } }).thread_spawn?.agent_path;
  return validAgentPath(path) ? path : undefined;
}
