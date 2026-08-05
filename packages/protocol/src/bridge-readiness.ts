export const AGENT_BRIDGE_KINDS = ["claude", "codex", "opencode"] as const;

export type AgentBridgeKind = (typeof AGENT_BRIDGE_KINDS)[number];

export interface StructuredCommandError {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export type AwaitBridgeReadyResult =
  | {
      status: "ready";
      port: number;
      authToken: string;
    }
  | {
      status: "failed" | "timed-out";
      error: StructuredCommandError;
    };

export function isAgentBridgeKind(value: unknown): value is AgentBridgeKind {
  return AGENT_BRIDGE_KINDS.includes(value as AgentBridgeKind);
}

export function isStructuredCommandError(
  value: unknown,
): value is StructuredCommandError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.message === "string"
    && typeof record.retryable === "boolean"
    && (
      record.retryAfterMs === undefined
      || (Number.isSafeInteger(record.retryAfterMs) && (record.retryAfterMs as number) >= 0)
    );
}

export function isAwaitBridgeReadyResult(
  value: unknown,
): value is AwaitBridgeReadyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status === "ready") {
    return Number.isSafeInteger(record.port)
      && (record.port as number) > 0
      && typeof record.authToken === "string"
      && record.authToken.length > 0;
  }
  if (record.status !== "failed" && record.status !== "timed-out") return false;
  return isStructuredCommandError(record.error);
}
