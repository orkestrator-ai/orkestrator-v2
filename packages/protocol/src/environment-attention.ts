/**
 * Backend -> client "an environment needs attention" notifications.
 *
 * The backend raises one event each time it lights an environment's unread
 * badge on its own (an agent finished, failed, is waiting or asked a
 * question, or a terminal-hosted agent finished). A client marking an
 * environment unread is not attention and raises nothing. Clients use it for
 * presentation only (the "agent stopped" and "agent question" sounds, the
 * question desktop notification); the environment snapshot stays
 * authoritative for the badge itself.
 *
 * One exception to "one per badge edge": a badge already lit for a reason that
 * needs no input (the agent finished or failed) raises again when an agent
 * then asks a question or waits on the user, because that is the event the
 * user must not miss. A badge already showing a question does not raise again.
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

/**
 * Reasons that mean an agent is blocked on the user: it asked a question, or it
 * stopped on an approval, a plan or a prompt it cannot continue past alone.
 */
export const INPUT_NEEDED_ATTENTION_REASONS = [
  "agent_waiting",
  "agent_question",
] as const satisfies readonly EnvironmentAttentionReason[];

export function isInputNeededAttentionReason(
  value: unknown,
): value is (typeof INPUT_NEEDED_ATTENTION_REASONS)[number] {
  return (INPUT_NEEDED_ATTENTION_REASONS as readonly unknown[]).includes(value);
}

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

/**
 * Backend -> client "a coordinator was woken for a worker it was waiting on".
 *
 * Raised once per delegation, after the wake (the worker's report, or the notice
 * standing in for one) was delivered to the coordinator. Presentation only, on
 * the same terms as above: `attentionId` is stable for the wake so a client acts
 * on it once, a client that was away hears nothing later, and it is content-free.
 */
export const COORDINATOR_WAKE_ATTENTION_EVENT = "coordinator-wake-attention";

export interface CoordinatorWakeAttentionEvent {
  attentionId: string;
  projectId: string;
  coordinatorId: string;
  occurredAt: string;
}

export function isCoordinatorWakeAttentionEvent(
  value: unknown,
): value is CoordinatorWakeAttentionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    isId(event.attentionId) &&
    isId(event.projectId) &&
    isId(event.coordinatorId) &&
    typeof event.occurredAt === "string" &&
    event.occurredAt.length <= 64
  );
}
