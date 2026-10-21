import type { BackendId } from "@orkestrator/protocol/federation";
import { COORDINATOR_MAIL_ADDRESS } from "@orkestrator/protocol/coordinator";

/**
 * Mail between a command node's coordinators and agents on its leaves.
 *
 * The two never share a chat: they exchange ordinary agent mail.
 * - Coordinator → leaf agent: the command node calls the leaf's
 *   `deliver_node_mail`, which stores it as incoming mail for that agent
 *   (processed like any message) and remembers which command node and
 *   coordinator conversation the thread belongs to.
 * - Leaf agent → coordinator: mail to "coordinator", a reply on such a
 *   thread, or a report from an environment a command node launched goes to
 *   the command node that started that conversation or environment; with no
 *   origin, to the command node that contacted this leaf most recently. It
 *   waits in this leaf's outbox until that command node collects it; it is
 *   never dropped or sent to another command node.
 * With no command node attached, mail stays local exactly as before.
 */

export const NODE_OUTBOX_READY_EVENT = "node-outbox-ready";
export const MAX_OUTBOX_ITEMS = 500;
export const MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
const MAX_ORIGINS = 2_000;
const MAX_THREADS = 5_000;
const MAX_COLLECT = 50;

/** Where on the command node a reply goes: one coordinator conversation's mailbox. */
export interface CoordinatorMailbox {
  controllerId: BackendId;
  /** The coordinator conversation's runtime environment ID and tab, on the command node. */
  coordinatorEnvironmentId: string;
  coordinatorTabId: string;
  /** Display name of the command node, for the agent's context. */
  controllerName?: string;
}

export interface OutboxItem {
  seq: number;
  createdAt: string;
  requestId: string;
  fromEnvironmentId: string;
  fromTabId: string;
  fromEnvironmentName?: string;
  /** The leaf project's repository identity, to find the coordinator on the command node. */
  repositoryHint?: string;
  /** Present when the destination conversation is known (origin or thread). */
  toCoordinator?: { environmentId: string; tabId: string };
  subject?: string;
  body: string;
  bytes: number;
}

export interface NodeMailState {
  version: 1;
  /** Environments launched by a command node's coordinator. */
  origins: Record<string, CoordinatorMailbox>;
  /** Leaf message IDs of incoming coordinator mail → its coordinator mailbox. */
  threads: Record<string, CoordinatorMailbox>;
  outbox: Record<string, { nextSeq: number; items: OutboxItem[] }>;
}

export function emptyNodeMailState(): NodeMailState {
  return { version: 1, origins: {}, threads: {}, outbox: {} };
}

export interface NodeMailStore {
  load(): Promise<NodeMailState>;
  /** Serialized read-modify-write; `null` writes nothing. */
  mutate<T>(
    mutate: (state: NodeMailState) => { next: NodeMailState | null; result: T },
  ): Promise<T>;
}

export interface LeafMailContext {
  /** Attached command nodes, most recent contact first. */
  attachedControllers(): Array<{ controllerId: BackendId; displayName: string }>;
  mostRecentControllerId(): BackendId | undefined;
}

export class LeafNodeMail {
  constructor(
    private readonly store: NodeMailStore,
    private readonly context: LeafMailContext,
    private readonly emit: (event: string, payload: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A command node launched this environment for one of its coordinators. */
  async recordOrigin(environmentId: string, origin: CoordinatorMailbox): Promise<void> {
    await this.store.mutate((state) => {
      const origins = { ...state.origins, [environmentId]: origin };
      const keys = Object.keys(origins);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ORIGINS))) delete origins[key];
      return { next: { ...state, origins }, result: undefined };
    });
  }

  /** Remember which coordinator an incoming message (by its leaf message ID) came from. */
  async recordThread(messageId: string, origin: CoordinatorMailbox): Promise<void> {
    await this.store.mutate((state) => {
      const threads = { ...state.threads, [messageId]: origin };
      const keys = Object.keys(threads);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_THREADS))) delete threads[key];
      return { next: { ...state, threads }, result: undefined };
    });
  }

  /**
   * Where a leaf agent's message goes. `null` keeps it local: it is not for a
   * coordinator, or no command node is attached.
   */
  async route(input: {
    fromEnvironmentId: string;
    toEnvironmentId: string;
    replyToMessageId?: string;
  }): Promise<CoordinatorMailbox | { controllerId: BackendId; controllerName?: string } | null> {
    const attached = this.context.attachedControllers();
    if (attached.length === 0) return null;
    const isAttached = (id: string) => attached.some((entry) => entry.controllerId === id);
    const state = await this.store.load();
    if (input.replyToMessageId) {
      const thread = state.threads[input.replyToMessageId];
      if (thread && isAttached(thread.controllerId)) return thread;
      if (thread) return null;
    }
    if (input.toEnvironmentId !== COORDINATOR_MAIL_ADDRESS) return null;
    const origin = state.origins[input.fromEnvironmentId];
    if (origin && isAttached(origin.controllerId)) return origin;
    const recent = this.context.mostRecentControllerId();
    if (!recent || !isAttached(recent)) return null;
    const name = attached.find((entry) => entry.controllerId === recent)?.displayName;
    return { controllerId: recent, ...(name ? { controllerName: name } : {}) };
  }

  /** Queue a message for a command node. Bounded; refused (never dropped) when full. */
  async enqueue(
    controllerId: BackendId,
    item: Omit<OutboxItem, "seq" | "createdAt" | "bytes">,
  ): Promise<OutboxItem> {
    const bytes = Buffer.byteLength(item.body, "utf8");
    const queued = await this.store.mutate((state) => {
      const current = state.outbox[controllerId] ?? { nextSeq: 1, items: [] };
      const duplicate = current.items.find(
        (entry) =>
          entry.requestId === item.requestId &&
          entry.fromEnvironmentId === item.fromEnvironmentId &&
          entry.fromTabId === item.fromTabId,
      );
      if (duplicate) {
        if (
          duplicate.body !== item.body ||
          duplicate.subject !== item.subject ||
          JSON.stringify(duplicate.toCoordinator) !== JSON.stringify(item.toCoordinator) ||
          duplicate.repositoryHint !== item.repositoryHint
        )
          throw new Error("Conflicting mail request ID.");
        return { next: null, result: duplicate };
      }
      const total = current.items.reduce((sum, entry) => sum + entry.bytes, 0);
      if (current.items.length >= MAX_OUTBOX_ITEMS || total + bytes > MAX_OUTBOX_BYTES) {
        throw new Error(
          "The outbox for that command node is full; it will be delivered once the command node collects its mail.",
        );
      }
      const entry: OutboxItem = {
        ...item,
        seq: current.nextSeq,
        createdAt: new Date(this.now()).toISOString(),
        bytes,
      };
      return {
        next: {
          ...state,
          outbox: {
            ...state.outbox,
            [controllerId]: { nextSeq: current.nextSeq + 1, items: [...current.items, entry] },
          },
        },
        result: entry,
      };
    });
    this.emit(NODE_OUTBOX_READY_EVENT, { controllerId });
    return queued;
  }

  async collect(
    controllerId: BackendId,
    after: number,
  ): Promise<{ items: OutboxItem[]; more: boolean }> {
    const state = await this.store.load();
    const items = (state.outbox[controllerId]?.items ?? []).filter((entry) => entry.seq > after);
    return { items: items.slice(0, MAX_COLLECT), more: items.length > MAX_COLLECT };
  }

  /** The command node delivered everything up to `upTo`. */
  async ack(
    controllerId: BackendId,
    upTo: number,
    sequences?: number[],
  ): Promise<{ remaining: number }> {
    return this.store.mutate((state) => {
      const current = state.outbox[controllerId];
      if (!current) return { next: null, result: { remaining: 0 } };
      const items = current.items.filter((entry) =>
        sequences ? !sequences.includes(entry.seq) : entry.seq > upTo,
      );
      if (items.length === current.items.length) {
        return { next: null, result: { remaining: items.length } };
      }
      return {
        next: { ...state, outbox: { ...state.outbox, [controllerId]: { ...current, items } } },
        result: { remaining: items.length },
      };
    });
  }

  async pending(controllerId: BackendId): Promise<number> {
    const state = await this.store.load();
    return state.outbox[controllerId]?.items.length ?? 0;
  }
}

/** Text a coordinator reads for mail that came from a leaf. */
export function describeLeafMail(item: OutboxItem, node: { nodeId: string; name: string }): string {
  const from = item.fromEnvironmentName
    ? `${item.fromEnvironmentName} (environment ${item.fromEnvironmentId})`
    : `environment ${item.fromEnvironmentId}`;
  return (
    `From ${from}, tab ${item.fromTabId}, on node ${node.name} (nodeId ${node.nodeId}). ` +
    `Reply with send_message and nodeId "${node.nodeId}".\n\n${item.body}`
  );
}

/** Text a leaf agent reads for mail from a command node's coordinator. */
export function describeCoordinatorMail(body: string, controllerName: string): string {
  return (
    `From the coordinator on ${controllerName}, which controls this node. ` +
    `Reply to this message, or send_message to "coordinator", to answer it.\n\n${body}`
  );
}
