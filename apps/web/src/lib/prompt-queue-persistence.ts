import * as backend from "@/lib/backend";
import type { PersistedPromptQueue } from "@/types";

/**
 * Backend mirror for agent prompt queues.
 *
 * A queued prompt is a decision the user has already made — they pressed send
 * while the agent was busy. Keeping that in a renderer meant it vanished on
 * reload, was invisible to any other client, and only drained while the tab
 * that created it stayed mounted. This mirrors each tab's queue into the
 * backend so all three stop being true.
 *
 * The store remains the optimistic front: the UI updates immediately and this
 * module reconciles. Writes are whole-list compare-and-swap, which is what
 * stops two clients both claiming the same head message and sending it twice.
 */

/** Anything with a stable id can be queued; bodies stay agent-specific. */
export interface QueuedItem {
  id: string;
}

/**
 * One agent's queue map. Each agent keys its queues differently (Claude native
 * uses `env-{id}:{tab}`, tmux uses `env:{id}:tab:{tab}`), so the source is
 * responsible for translating its own key back to an environment.
 */
export interface PromptQueueSource<TItem extends QueuedItem = QueuedItem> {
  /**
   * Namespace for this agent's keys. Two agents can legitimately use the same
   * tab id, and their queues must not collide in shared backend storage.
   */
  agent: string;
  getQueues: () => ReadonlyMap<string, TItem[]>;
  setQueue: (sessionKey: string, messages: TItem[]) => void;
  subscribe: (listener: () => void) => () => void;
  /** Returns null when the key carries no recoverable environment. */
  environmentIdFor: (sessionKey: string) => string | null;
}

/**
 * Non-generic aliases of the backend wrappers. The wrappers are generic over
 * the message body, but every caller here works in terms of the opaque
 * {@link QueuedItem}, and a generic signature cannot be satisfied by a test
 * double that returns one concrete type.
 */
export type PromptQueueSaver = (
  queueKey: string,
  environmentId: string,
  messages: QueuedItem[],
  expectedRevision?: number,
) => Promise<PersistedPromptQueue<QueuedItem>>;
export type PromptQueueLoader = (
  queueKey: string,
) => Promise<PersistedPromptQueue<QueuedItem> | null>;
export type PromptQueueListLoader = (
  environmentId: string,
) => Promise<Array<PersistedPromptQueue<QueuedItem>>>;

export interface PromptQueuePersistenceOptions {
  debounceMs?: number;
  save?: PromptQueueSaver;
  load?: PromptQueueLoader;
}

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

/** Revisions observed per backend queue key, for compare-and-swap. */
const queueRevisions = new Map<string, number>();

/** Serialized form of what was last written, to suppress no-op writes. */
const lastWritten = new Map<string, string>();

/** Drops cached revisions. Tests use this to avoid cross-file bleed. */
export function resetPromptQueueRevisions(): void {
  queueRevisions.clear();
  lastWritten.clear();
}

/**
 * Whether the store holds a queue transition that has not reached the backend
 * yet. Compared against {@link lastWritten} rather than against the persisted
 * record so a queue this client has never written reads as clean.
 */
function hasUnflushedLocalEdit<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  sessionKey: string,
  queueKey: string,
): boolean {
  const written = lastWritten.get(queueKey);
  if (written === undefined) return false;
  return JSON.stringify(source.getQueues().get(sessionKey) ?? []) !== written;
}

function applyPersisted<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  persisted: PersistedPromptQueue<TItem>,
  options: { force?: boolean } = {},
): void {
  const parsed = parsePromptQueueKey(persisted.queueKey);
  if (!parsed || parsed.agent !== source.agent) return;

  // A record at a revision this client has already observed carries nothing it
  // does not know — most often it is this client's own write arriving back
  // through the change feed. Applying it would discard whatever the user queued
  // between issuing that write and the echo landing, which for a queue of
  // deliberate user decisions is the one thing that must never happen. Only a
  // strictly newer revision means another client genuinely advanced the queue,
  // and adopting that is what stops two clients both dispatching the same head.
  const observedRevision = queueRevisions.get(persisted.queueKey);
  if (
    !options.force
    && observedRevision !== undefined
    && persisted.revision <= observedRevision
    && hasUnflushedLocalEdit(source, parsed.sessionKey, persisted.queueKey)
  ) {
    return;
  }

  const messages = Array.isArray(persisted.messages)
    ? persisted.messages.filter((message): message is TItem =>
      typeof message === "object"
      && message !== null
      && typeof (message as QueuedItem).id === "string")
    : [];
  queueRevisions.set(persisted.queueKey, persisted.revision);
  lastWritten.set(persisted.queueKey, JSON.stringify(messages));
  source.setQueue(parsed.sessionKey, messages);
}

export type PromptQueueClaimer = <TItem extends QueuedItem>(
  queueKey: string,
  environmentId: string,
  expectedMessageId: string,
  candidateMessages: TItem[],
) => Promise<{
  claimed: TItem | null;
  queue: PersistedPromptQueue<TItem> | null;
}>;

/**
 * Atomically takes one queue head from the backend before its irreversible
 * agent dispatch.
 *
 * The candidate list closes the short window where a newly queued local item
 * has not reached the debounced mirror yet. The backend either seeds and claims
 * that list in one locked mutation, or claims the matching head from the record
 * another client already wrote. A competing client sees a different head and
 * receives no claim.
 */
export async function claimPromptQueueHead<TItem extends QueuedItem>(
  source: PromptQueueSource<TItem>,
  sessionKey: string,
  claim: PromptQueueClaimer = backend.claimPromptQueueHead,
): Promise<TItem | null> {
  const environmentId = source.environmentIdFor(sessionKey);
  if (!environmentId) return null;

  const messages = [...(source.getQueues().get(sessionKey) ?? [])];
  const expected = messages[0];
  if (!expected) return null;

  const queueKey = promptQueueKey(source.agent, sessionKey);
  const result = await claim(
    queueKey,
    environmentId,
    expected.id,
    messages,
  );
  if (result.queue) {
    applyPersisted(source, result.queue, { force: true });
  } else if (!result.claimed) {
    // The environment/queue disappeared while this client was preparing the
    // claim. Do not keep a locally dispatchable ghost queue.
    queueRevisions.delete(queueKey);
    lastWritten.delete(queueKey);
    source.setQueue(sessionKey, []);
  }

  const claimed = result.claimed;
  return (
    typeof claimed === "object"
    && claimed !== null
    && typeof claimed.id === "string"
    && claimed.id === expected.id
  )
    ? claimed
    : null;
}

/**
 * Restores every queue this environment owns, across all supplied agents.
 *
 * Call when an environment becomes known to this client. A queue restored here
 * drains exactly as if this client had typed it, which is what makes "queue
 * three prompts, close the laptop, reopen elsewhere" work.
 */
export async function hydratePromptQueuesForEnvironment(
  environmentId: string,
  sources: ReadonlyArray<PromptQueueSource>,
  list: PromptQueueListLoader = backend.listPromptQueues,
): Promise<void> {
  if (typeof list !== "function") return;
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
    applyPersisted(source, entry);
  }
}

/**
 * Refreshes one queue from the backend, used when the change feed reports that
 * another client altered it.
 */
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
    lastWritten.delete(queueKey);
    source.setQueue(parsed.sessionKey, []);
    return;
  }
  applyPersisted(source, persisted);
}

/**
 * Mirrors every queue transition of every supplied agent into the backend.
 *
 * Returns a detach function. Writes are debounced per queue and serialized per
 * key; a revision conflict adopts the backend state rather than retrying, since
 * the conflicting write is another client having already taken the message.
 */
export function startPromptQueuePersistence(
  sources: ReadonlyArray<PromptQueueSource>,
  options: PromptQueuePersistenceOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 200;
  const save = options.save ?? backend.savePromptQueue;
  const load = options.load ?? backend.getPromptQueue;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();
  const unsubscribes: Array<() => void> = [];
  let detached = false;
  interface PendingWrite {
    source: PromptQueueSource;
    sessionKey: string;
    environmentId: string;
    fingerprint: string;
  }
  const pending = new Map<string, PendingWrite>();

  const cancelTimer = (queueKey: string) => {
    const timer = timers.get(queueKey);
    if (timer) clearTimeout(timer);
    timers.delete(queueKey);
  };

  const schedule = (queueKey: string, delayMs: number) => {
    if (detached || !pending.has(queueKey)) return;
    cancelTimer(queueKey);
    timers.set(queueKey, setTimeout(() => {
      void flush(queueKey);
    }, delayMs));
  };

  const scheduleRetry = (queueKey: string) => {
    const attempt = (retryAttempts.get(queueKey) ?? 0) + 1;
    retryAttempts.set(queueKey, attempt);
    // Bound the retry cadence so an unavailable backend cannot create a hot
    // loop. Dirty state remains pending even after the automatic attempts are
    // exhausted, allowing a later mutation/pagehide/detach flush to retry it.
    if (attempt <= 5) {
      schedule(queueKey, Math.min(5_000, 100 * (2 ** (attempt - 1))));
    }
  };

  const write = (
    source: PromptQueueSource,
    sessionKey: string,
    queueKey: string,
    environmentId: string,
  ): Promise<void> => {
    const previous = chains.get(queueKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      const messages = source.getQueues().get(sessionKey) ?? [];
      const serialized = JSON.stringify(messages);
      if (lastWritten.get(queueKey) === serialized) {
        const queued = pending.get(queueKey);
        if (queued?.fingerprint === serialized) pending.delete(queueKey);
        retryAttempts.delete(queueKey);
        return;
      }
      try {
        const saved = await save(
          queueKey,
          environmentId,
          messages,
          queueRevisions.get(queueKey) ?? 0,
        );
        queueRevisions.set(queueKey, saved.revision);
        lastWritten.set(queueKey, serialized);
        const queued = pending.get(queueKey);
        if (queued?.fingerprint === serialized) pending.delete(queueKey);
        retryAttempts.delete(queueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("revision conflict")) {
          // Another client changed this queue — most likely it took the head to
          // send it. Adopting its state is the only outcome that cannot produce
          // a duplicate dispatch.
          const winner = await load(queueKey).catch(() => null);
          if (winner) {
            applyPersisted(source, winner, { force: true });
            pending.delete(queueKey);
            retryAttempts.delete(queueKey);
            return;
          }
        }
        console.warn(
          `[PromptQueue] Failed to persist queue ${sessionKey}:`,
          message,
        );
        scheduleRetry(queueKey);
      }
    });
    chains.set(queueKey, next);
    void next.finally(() => {
      if (chains.get(queueKey) === next) chains.delete(queueKey);
    });
    return next;
  };

  const flush = (queueKey: string): Promise<void> | undefined => {
    const entry = pending.get(queueKey);
    if (!entry) return undefined;
    cancelTimer(queueKey);
    return write(entry.source, entry.sessionKey, queueKey, entry.environmentId);
  };

  const flushAll = (): Promise<void> => Promise.all(
    [...pending.keys()].map((queueKey) => flush(queueKey) ?? Promise.resolve()),
  ).then(() => undefined);

  for (const source of sources) {
    let previousQueues = source.getQueues();

    unsubscribes.push(source.subscribe(() => {
      const queues = source.getQueues();
      if (queues === previousQueues) return;
      const keys = new Set([...queues.keys(), ...previousQueues.keys()]);
      const seen = previousQueues;
      previousQueues = queues;

      for (const sessionKey of keys) {
        const current = queues.get(sessionKey);
        if (current === seen.get(sessionKey)) continue;
        const environmentId = source.environmentIdFor(sessionKey);
        // A key with no recoverable environment cannot be scoped, and an
        // unscoped queue could never be cleaned up when its environment goes.
        if (!environmentId) continue;
        const queueKey = promptQueueKey(source.agent, sessionKey);
        const fingerprint = JSON.stringify(current ?? []);
        pending.set(queueKey, { source, sessionKey, environmentId, fingerprint });
        retryAttempts.delete(queueKey);
        schedule(queueKey, debounceMs);
      }
    }));
  }

  const onPageHide = () => {
    void flushAll();
  };
  window.addEventListener("pagehide", onPageHide);

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    window.removeEventListener("pagehide", onPageHide);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    detached = true;
    // Start the outstanding writes while the backend connection still exists.
    // A queue the user just added to must not be lost to teardown.
    void flushAll();
  };
}
