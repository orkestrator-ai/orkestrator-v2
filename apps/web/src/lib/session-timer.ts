/** Parse a backend-owned turn timestamp without falling back to renderer time. */
export function parseBackendTurnStartedAt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

/**
 * Providers that expose a transcript but no turn clock can use the latest
 * backend-created user message as the authoritative beginning of a busy turn.
 */
export function findLatestBackendUserTurnStartedAt<T extends { role: string; createdAt?: string }>(
  messages: readonly T[],
  isBackendMessage: (message: T) => boolean = () => true,
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    // The latest user message is still optimistic, so the backend has not yet
    // supplied a clock for this turn. Never fall through to the previous turn.
    if (!isBackendMessage(message)) return undefined;
    // This is the current backend turn even when its clock is absent or
    // malformed. Falling through would silently attach the previous turn's
    // valid clock to the current one.
    return parseBackendTurnStartedAt(message.createdAt);
  }
  return undefined;
}

/**
 * How long the last completed backend turn took, from backend clocks only.
 *
 * Anchored on the same user message `findLatestBackendUserTurnStartedAt` uses
 * and closed at the newest assistant timestamp after it. Both ends come from
 * the transcript, so the duration survives an unmount, an environment switch,
 * or a reload — a renderer that never watched the turn end still reports it.
 * Returns `undefined` rather than a guess whenever either end is missing.
 */
export function findLatestBackendTurnElapsedSeconds<T extends { role: string; createdAt?: string }>(
  messages: readonly T[],
  isBackendMessage: (message: T) => boolean = () => true,
): number | undefined {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return undefined;
  const prompt = messages[promptIndex]!;
  if (!isBackendMessage(prompt)) return undefined;
  const startedAt = parseBackendTurnStartedAt(prompt.createdAt);
  if (startedAt === undefined) return undefined;

  let completedAt: number | undefined;
  for (let index = promptIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !isBackendMessage(message)) continue;
    const timestamp = parseBackendTurnStartedAt(message.createdAt);
    if (timestamp === undefined) continue;
    if (completedAt === undefined || timestamp > completedAt) {
      completedAt = timestamp;
    }
  }
  // A response the backend stamped before its own prompt is a clock disagreement,
  // not a negative turn. Report nothing rather than a fabricated duration.
  if (completedAt === undefined || completedAt < startedAt) return undefined;
  return Math.floor((completedAt - startedAt) / 1000);
}
