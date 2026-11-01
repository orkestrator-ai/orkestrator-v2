/**
 * Backend -> client "an environment needs attention" notifications.
 *
 * The backend raises one event each time it lights an environment's unread
 * badge on its own (an agent finished, failed, is waiting or asked a
 * question, or a terminal-hosted agent finished). A client marking an
 * environment unread is not attention and raises nothing. Clients use it for
 * presentation only (the "agent stopped" sound); the environment snapshot
 * stays authoritative for the badge itself.
 *
 * Each event has a unique `attentionId`, so a client that receives it twice
 * (a replayed stream, a reconnect) acts on it once. Events raised while a
 * client was disconnected are not replayed: a missed sound is not state.
 * Content-free: identifiers, a reason and a timestamp only.
 */

export const ENVIRONMENT_ATTENTION_EVENT = "environment-attention";

export const ENVIRONMENT_ATTENTION_REASONS = [
  "agent_finished",
  "agent_failed",
  "agent_waiting",
  "agent_question",
  "terminal_finished",
] as const;

export type EnvironmentAttentionReason = (typeof ENVIRONMENT_ATTENTION_REASONS)[number];

export interface EnvironmentAttentionEvent {
  attentionId: string;
  environmentId: string;
  projectId: string;
  reason: EnvironmentAttentionReason;
  occurredAt: string;
}

export function isEnvironmentAttentionReason(value: unknown): value is EnvironmentAttentionReason {
  return (ENVIRONMENT_ATTENTION_REASONS as readonly unknown[]).includes(value);
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function isEnvironmentAttentionEvent(value: unknown): value is EnvironmentAttentionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    isId(event.attentionId) &&
    isId(event.environmentId) &&
    isId(event.projectId) &&
    isEnvironmentAttentionReason(event.reason) &&
    typeof event.occurredAt === "string" &&
    event.occurredAt.length <= 64
  );
}
