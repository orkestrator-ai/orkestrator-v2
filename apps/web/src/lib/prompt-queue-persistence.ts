import * as backend from "@/lib/backend";
import type { PersistedPromptQueue } from "@/types";

/**
 * Backend-owned agent prompt queues.
 *
 * Renderers keep a read-only projection in their agent store for rendering and
 * drain readiness. Every mutation is an atomic backend command; the returned
 * snapshot updates the calling renderer immediately and the resource event
 * rehydrates every other connected client.
 */

/** Anything with a stable id can be queued; bodies stay agent-specific. */
export interface QueuedItem {
  id: string;
}

export interface PromptQueueSource<TItem extends QueuedItem = QueuedItem> {
  agent: string;
  getQueues: () => ReadonlyMap<string, TItem[]>;
  setQueue: (sessionKey: string, messages: TItem[]) => void;
  /** Returns null when the key carries no recoverable environment. */
  environmentIdFor: (sessionKey: string) => string | null;
}

export type PromptQueueLoader = (
  queueKey: string,
) => Promise<PersistedPromptQueue<QueuedItem> | null>;
export type PromptQueueListLoader = (
  environmentId: string,
) => Promise<Array<PersistedPromptQueue<QueuedItem>>>;
export type PromptQueueRetrier = (
  queueKey: string,
) => Promise<PersistedPromptQueue<QueuedItem> | null>;
export type PromptQueueDispatchError =
  NonNullable<PersistedPromptQueue["dispatchError"]>;

/** Composite backend key. The separator cannot appear in an agent namespace. */
export function promptQueueKey(agent: string, sessionKey: string): string {
  return `${agent}\u0000${sessionKey}`;
}

export function parsePromptQueueKey(
  queueKey: string,
): { agent: string; sessionKey: string } | null {
  const separator = queueKey.indexOf("\u0000");
  if (separator <= 0) return null;
  return {
    agent: queueKey.slice(0, separator),
    sessionKey: queueKey.slice(separator + 1),
  };
}

/** Highest backend revision installed per queue. */
const queueRevisions = new Map<string, number>();

const dispatchErrors = new Map<string, PromptQueueDispatchError>();
const dispatchErrorListeners = new Set<() => void>();

export function subscribePromptQueueDispatchErrors(
  listener: () => void,
): () => void {
  dispatchErrorListeners.add(listener);
  return () => dispatchErrorListeners.delete(listener);
}

export function getPromptQueueDispatchError(
  queueKey: string,
): PromptQueueDispatchError | undefined {
  return dispatchErrors.get(queueKey);
}

function observeDispatchError(
  queueKey: string,
  error: PromptQueueDispatchError | undefined,
): void {
  const previous = dispatchErrors.get(queueKey);
  if (JSON.stringify(previous) === JSON.stringify(error)) return;
  if (error) dispatchErrors.set(queueKey, error);
  else dispatchErrors.delete(queueKey);
  for (const listener of dispatchErrorListeners) listener();
}

/** Drops cached revisions. Tests use this to avoid cross-file bleed. */
export function resetPromptQueueRevisions(): void {
  queueRevisions.clear();
  dispatchErrors.clear();
}

export function applyPromptQueueSnapshot<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  persisted: PersistedPromptQueue<TItem>,
): void {
  const parsed = parsePromptQueueKey(persisted.queueKey);
  if (!parsed || parsed.agent !== source.agent) return;

  const observedRevision = queueRevisions.get(persisted.queueKey);
  if (observedRevision !== undefined && persisted.revision < observedRevision) {
    return;
  }

  const messages = Array.isArray(persisted.messages)
    ? persisted.messages.filter((message): message is TItem =>
      typeof message === "object"
      && message !== null
      && typeof (message as QueuedItem).id === "string")
    : [];
  queueRevisions.set(persisted.queueKey, persisted.revision);
  observeDispatchError(persisted.queueKey, persisted.dispatchError);
  source.setQueue(parsed.sessionKey, messages);
}

export type PromptQueueClaimer<TItem extends QueuedItem = QueuedItem> = (
  queueKey: string,
  environmentId: string,
  expectedMessageId: string,
  /** Renderer projection for test doubles only; the backend wrapper ignores it. */
  projectedMessages?: TItem[],
) => Promise<{
  claimed: TItem | null;
  claimToken: string | null;
  queue: PersistedPromptQueue<TItem> | null;
}>;

export interface ClaimedPrompt<TItem extends QueuedItem> {
  entry: TItem;
  claimToken: string;
}

/**
 * How a send resolved, from the point of view of the durable claim.
 *
 * `unknown` is the important one: the request may already be running, so the
 * lease is retained rather than acknowledged (which could lose an unaccepted
 * prompt) or rejected (which could duplicate one the agent did accept).
 */
export type QueueDispatchOutcome = "accepted" | "rejected" | "unknown";

/** Atomically takes one queue head before its irreversible agent dispatch. */
export async function claimPromptQueueHead<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  sessionKey: string,
  claim: PromptQueueClaimer<TItem> =
    backend.claimPromptQueueHead as PromptQueueClaimer<TItem>,
): Promise<ClaimedPrompt<TItem> | null> {
  const environmentId = source.environmentIdFor(sessionKey);
  if (!environmentId) return null;

  const projectedMessages = [...(source.getQueues().get(sessionKey) ?? [])];
  const expected = projectedMessages[0];
  if (!expected) return null;

  const queueKey = promptQueueKey(source.agent, sessionKey);
  const result = await claim(
    queueKey,
    environmentId,
    expected.id,
    projectedMessages,
  );
  if (result.queue) {
    applyPromptQueueSnapshot(source, result.queue);
  } else {
    queueRevisions.delete(queueKey);
    source.setQueue(sessionKey, []);
  }

  const claimed = result.claimed;
  return (
    typeof claimed === "object"
    && claimed !== null
    && typeof claimed.id === "string"
    && claimed.id === expected.id
    && typeof result.claimToken === "string"
    && result.claimToken.trim().length > 0
  )
    ? { entry: claimed, claimToken: result.claimToken }
    : null;
}

/** Clears a terminal dispatch latch and lets the backend supervisor retry it. */
export async function retryPromptQueueDispatch<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  sessionKey: string,
  retry: PromptQueueRetrier = backend.retryPromptQueueDispatch,
): Promise<void> {
  const queueKey = promptQueueKey(source.agent, sessionKey);
  const persisted = await retry(queueKey);
  if (!persisted) {
    queueRevisions.delete(queueKey);
    observeDispatchError(queueKey, undefined);
    source.setQueue(sessionKey, []);
    return;
  }
  // A retry may clear the latch without changing a test-double's revision.
  // Forget the observed revision so the authoritative response always wins.
  queueRevisions.delete(queueKey);
  applyPromptQueueSnapshot(source, persisted as PersistedPromptQueue<TItem>);
}

export async function hydratePromptQueuesForEnvironment(
  environmentId: string,
  sources: ReadonlyArray<PromptQueueSource>,
  list: PromptQueueListLoader = backend.listPromptQueues,
): Promise<void> {
  const persisted = await list(environmentId);
  if (!Array.isArray(persisted)) return;

  const byAgent = new Map<string, PromptQueueSource>();
  for (const source of sources) byAgent.set(source.agent, source);

  for (const entry of persisted) {
    if (entry.environmentId !== environmentId) continue;
    const parsed = parsePromptQueueKey(entry.queueKey);
    if (!parsed) continue;
    const source = byAgent.get(parsed.agent);
    if (!source) continue;
    applyPromptQueueSnapshot(source, entry);
  }
}

export async function hydratePromptQueue(
  queueKey: string,
  sources: ReadonlyArray<PromptQueueSource>,
  load: PromptQueueLoader = backend.getPromptQueue,
): Promise<void> {
  const parsed = parsePromptQueueKey(queueKey);
  if (!parsed) return;
  const source = sources.find((candidate) => candidate.agent === parsed.agent);
  if (!source) return;

  const persisted = await load(queueKey);
  if (!persisted) {
    queueRevisions.delete(queueKey);
    observeDispatchError(queueKey, undefined);
    source.setQueue(parsed.sessionKey, []);
    return;
  }
  applyPromptQueueSnapshot(source, persisted);
}
