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
 * - Leaf agent → coordinator: a reply goes back to whoever sent the message
 *   it answers, a command node's coordinator through the outbox, a local
 *   coordinator locally. Mail to "coordinator" goes to the coordinator that
 *   last contacted the environment (launched it, delegated to it or mailed
 *   it), local or remote. An environment a local coordinator launched reports
 *   locally until a command node's coordinator contacts it, and back again
 *   once the local one does. With no coordinator contact at all, it goes to
 *   this project's local coordinator if there is one, otherwise to the
 *   command node that contacted this leaf most recently. Remote mail waits in
 *   this leaf's outbox until that command node collects it; it is never
 *   dropped or sent to another command node.
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

/** A command node's coordinator's latest contact with one environment. */
export type CoordinatorContact = CoordinatorMailbox & { at: string };

/** What this backend's own coordinators did with one environment. */
export interface LocalCoordinatorContact {
  /** Latest launch, delegation or mail from a local coordinator (ISO time). */
  at?: string;
  /** The environment's project has a coordinator on this backend. */
  hasCoordinator: boolean;
}

export interface NodeMailState {
  version: 1;
  /** Environments launched by a command node's coordinator. */
  origins: Record<string, CoordinatorMailbox>;
  /**
   * The latest contact by a command node's coordinator, per environment:
   * a launch, a prompt, or mail. Optional: written since contact-ordered
   * routing; an origin without one counts as the oldest contact.
   */
  contacts?: Record<string, CoordinatorContact>;
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
  /** This backend's coordinators' contact with an environment's tab. */
  localCoordinatorContact?(environmentId: string, tabId?: string): Promise<LocalCoordinatorContact>;
}

export class LeafNodeMail {
  constructor(
    private readonly store: NodeMailStore,
    private readonly context: LeafMailContext,
    private readonly emit: (event: string, payload: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A command node's coordinator launched or prompted this environment, or
   * mailed it. The first one is its origin; every one is its latest contact.
   */
  async recordOrigin(
    environmentId: string,
    origin: CoordinatorMailbox,
    options: { keepOrigin?: boolean } = {},
  ): Promise<void> {
    await this.store.mutate((state) => {
      const origins =
        options.keepOrigin && state.origins[environmentId]
          ? state.origins
          : { ...state.origins, [environmentId]: origin };
      const keys = Object.keys(origins);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ORIGINS))) delete origins[key];
      const contacts: Record<string, CoordinatorContact> = { ...state.contacts };
      delete contacts[environmentId];
      contacts[environmentId] = { ...origin, at: new Date(this.now()).toISOString() };
      const contactKeys = Object.keys(contacts);
      for (const key of contactKeys.slice(0, Math.max(0, contactKeys.length - MAX_ORIGINS)))
        delete contacts[key];
      return { next: { ...state, origins, contacts }, result: undefined };
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
    fromTabId?: string;
    toEnvironmentId: string;
    replyToMessageId?: string;
  }): Promise<CoordinatorMailbox | { controllerId: BackendId; controllerName?: string } | null> {
    const attached = this.context.attachedControllers();
    if (attached.length === 0) return null;
    const isAttached = (id: string) => attached.some((entry) => entry.controllerId === id);
    const state = await this.store.load();
    if (input.replyToMessageId) {
      // A reply goes back to whoever sent the message it answers: a command
      // node's coordinator through the outbox, anyone on this node locally.
      const thread = state.threads[input.replyToMessageId];
      return thread && isAttached(thread.controllerId) ? thread : null;
    }
    if (input.toEnvironmentId !== COORDINATOR_MAIL_ADDRESS) return null;
    // "coordinator" is whichever coordinator last contacted the environment.
    const origin = state.origins[input.fromEnvironmentId];
    const remote: CoordinatorContact | undefined =
      state.contacts?.[input.fromEnvironmentId] ?? (origin ? { ...origin, at: "" } : undefined);
    const local = await this.context.localCoordinatorContact?.(
      input.fromEnvironmentId,
      input.fromTabId,
    );
    if (remote && isAttached(remote.controllerId) && !(local?.at && local.at >= remote.at)) {
      const { at: _at, ...mailbox } = remote;
      return mailbox;
    }
    if (local?.at || local?.hasCoordinator) return null;
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
    `From the coordinator on ${controllerName}, which controls this node, not a coordinator on this machine. ` +
    `Answer it with reply_message on this message, which always goes back to ${controllerName}. ` +
    `Until another coordinator contacts this environment, send_message to "coordinator" also reaches it.\n\n${body}`
  );
}
