export type RetentionMessage = { id: string; role: string; content?: unknown };

/** A restored or still-streaming reply cannot prove that the new turn remembered. */
export function hasNewCompletedReply(
  projection: { turn: { phase: string }; messages: RetentionMessage[] } | null,
  previousMessageIds: ReadonlySet<string>,
  matches: (reply: string) => boolean,
): boolean {
  return (
    projection?.turn.phase === "idle" &&
    projection.messages.some(
      (message) =>
        message.role === "assistant" &&
        !previousMessageIds.has(message.id) &&
        typeof message.content === "string" &&
        matches(message.content),
    )
  );
}
