import { Data } from "effect";
import type { BackendHello } from "@orkestrator/protocol/backend-profile";
import { isBackendId } from "@orkestrator/protocol/federation";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import type { ConnectionManager } from "./connection-manager.js";
import {
  onNodeScopeRelease,
  type DesktopNodeScopes,
  type NodeScopeRecord,
  type NodeScopeWindow,
  type WorkspaceTarget,
} from "./node-scopes.js";

/**
 * What a window renderer reaches through a node scope
 * (`docs/reports/unified-federation.md` §6.3 B and C, §6.4).
 *
 * The renderer names a node on `orkestrator:invoke` and main routes the call
 * through that window's node scope, opening it on first use. Events from a
 * node scope's connection reach the window on {@link NODE_EVENT_CHANNEL},
 * tagged with their node; `orkestrator:event` stays the command node's.
 */

/** `(nodeId, event, payload)` from one of the window's node scopes. */
export const NODE_EVENT_CHANNEL = "orkestrator:node-event";

/**
 * Sent on {@link NODE_EVENT_CHANNEL} when main closed a node scope (explicit
 * release, window reload, command-node change, idle). Payload `{ nodeId }`.
 */
export const NODE_SCOPE_RELEASED_EVENT = "node-scope-released";

/**
 * Refusal codes, in the protocol's code form (`/^[a-z][a-z0-9-]{0,63}$/`).
 *
 * - `unknown-node`: the window's command node does not know this node.
 * - `node-admin-refused`: machine administration for a leaf; it is done from
 *   the command node.
 * - `node-scope-closed`: the window closed or the scope was released while it
 *   was opening.
 * - `node-unavailable`: the node is known but its workspace could not open.
 */
export type NodeRefusalCode =
  "unknown-node" | "node-admin-refused" | "node-scope-closed" | "node-unavailable";

/**
 * A typed refusal. Electron passes only `message` across IPC (and the context
 * bridge drops custom properties), so the code also leads the message as
 * `[code] `; the preload reads it back into `error.code`.
 */
export class NodeRefusal extends Data.TaggedError("NodeRefusal")<{
  readonly code: NodeRefusalCode;
  readonly message: string;
}> {}

export function nodeRefusal(code: NodeRefusalCode, text: string): NodeRefusal {
  return new NodeRefusal({ code, message: `[${code}] ${text}` });
}

/** A node identity from the renderer, or a validation error. */
export function parseNodeId(value: unknown): string {
  if (!isBackendId(value)) throw new Error("Expected nodeId to be a node identity");
  return value;
}

/** The part of `ConnectionManager` node IPC uses. */
export type NodeIpcManager = Pick<
  ConnectionManager,
  "invoke" | "getBackendIdentity" | "getConnectionId" | "getGatewayBaseUrl" | "isScopeOnThisDevice"
> &
  Partial<Pick<ConnectionManager, "scopeHello">>;

/** A window as node IPC uses it. */
export type NodeIpcWindow = NodeScopeWindow;

/**
 * Per-node snapshot for the renderer. Never a credential.
 *
 * `hello` (plan item 2011) is the node's hello for its current connection,
 * which the renderer's node client reads its negotiated `domains` and
 * `capabilities` from: `null` when the node answered none (pre-contract),
 * absent when main could not tell this time.
 */
export type NodeGatewaySnapshot = (
  | {
      nodeId: string;
      commandNode: true;
      baseUrl: string | null;
      backendOnThisDevice: boolean;
    }
  | {
      nodeId: string;
      commandNode: false;
      nodeName: string;
      path: WorkspaceTarget["path"];
      routeKind?: WorkspaceTarget["routeKind"];
      via?: string;
      baseUrl: string | null;
      backendId: string | null;
      backendOnThisDevice: boolean;
    }
) & { hello?: BackendHello | null };

export type NodeInvoker = {
  /** `options.envelope`: the renderer's invoke envelope (plan item 1003), forwarded. */
  invoke(
    command: string,
    args: Record<string, unknown>,
    options?: { envelope?: Record<string, unknown> },
  ): Promise<unknown>;
};

export interface DesktopNodeIpcOptions<W extends NodeIpcWindow> {
  nodeScopes: Pick<DesktopNodeScopes, "ensureNodeScope" | "releaseNodeScope">;
  manager(): NodeIpcManager | null;
  /**
   * Deliver `connectionId`'s events to `(context, nodeId)` until the returned
   * callback runs (`DesktopWindowContexts.mapNodeConnection`).
   */
  mapNodeConnection(context: W, nodeId: string, connectionId: string): () => void;
}

const CLOSED_MESSAGES = new Set([
  "Node scope was released",
  "The window is no longer available",
  "The requesting window is no longer available.",
]);

/** Node-addressed invoke, open, release and gateway for window renderers. */
export class DesktopNodeIpc<W extends NodeIpcWindow> {
  /** Records whose event delivery and release hook are in place. */
  private readonly wired = new WeakSet<NodeScopeRecord>();

  constructor(private readonly options: DesktopNodeIpcOptions<W>) {}

  /** The scope holding the window's command node connection: the window's own. */
  commandScope(context: W): string {
    return context.scope;
  }

  /** Whether `nodeId` is the window's command node (proved identity only). */
  isCommandNode(context: W, nodeId: string): boolean {
    try {
      return this.manager().getBackendIdentity(this.commandScope(context)).backendId === nodeId;
    } catch {
      return false;
    }
  }

  /**
   * The backend for a node-addressed invoke: the window's command scope for its
   * own command node, else the window's node scope, opened if needed.
   */
  async backendFor(context: W, nodeId: string): Promise<NodeInvoker> {
    if (this.isCommandNode(context, nodeId)) {
      const scope = this.commandScope(context);
      return {
        invoke: async (command, args, options) => this.invokeIn(scope, command, args, options),
      };
    }
    const record = await this.open(context, nodeId);
    return {
      invoke: async (command, args, options) => this.invokeIn(record.scope, command, args, options),
    };
  }

  /**
   * Open (or reuse) the window's scope for `nodeId`. A node the command node
   * does not know is refused before any grant is asked for.
   */
  async open(
    context: W,
    nodeId: string,
    options: { hold?: boolean } = {},
  ): Promise<NodeScopeRecord> {
    if (!context.nodes.has(nodeId)) await this.assertKnown(context, nodeId);
    let record: NodeScopeRecord;
    try {
      record = await this.options.nodeScopes.ensureNodeScope(context, nodeId, options);
    } catch (error) {
      throw this.refusalFor(error, context);
    }
    this.wire(context, record);
    return record;
  }

  /** `orkestrator:nodes:open`: open with a renderer hold, answer the snapshot. */
  async openForRenderer(context: W, nodeId: string): Promise<NodeGatewaySnapshot | null> {
    if (this.isCommandNode(context, nodeId)) return this.gateway(context, nodeId);
    await this.open(context, nodeId, { hold: true });
    return this.gateway(context, nodeId);
  }

  release(context: W, nodeId: string): void {
    this.options.nodeScopes.releaseNodeScope(context, nodeId);
  }

  /** The node's snapshot, or null while its scope is not open. */
  async gateway(context: W, nodeId: string): Promise<NodeGatewaySnapshot | null> {
    const manager = this.manager();
    if (this.isCommandNode(context, nodeId)) {
      const scope = this.commandScope(context);
      const snapshot: NodeGatewaySnapshot = {
        nodeId,
        commandNode: true,
        baseUrl: manager.getGatewayBaseUrl(scope),
        backendOnThisDevice: manager.isScopeOnThisDevice(scope),
      };
      return this.withHello(manager, scope, snapshot);
    }
    const record = context.nodes.get(nodeId);
    if (!record || record.opening || !record.target) return null;
    const { target } = record;
    let snapshot: NodeGatewaySnapshot;
    try {
      snapshot = {
        nodeId,
        commandNode: false,
        nodeName: target.nodeName,
        path: target.path,
        ...(target.routeKind ? { routeKind: target.routeKind } : {}),
        ...(target.via ? { via: target.via } : {}),
        baseUrl: manager.getGatewayBaseUrl(record.scope),
        backendId: manager.getBackendIdentity(record.scope).backendId,
        backendOnThisDevice: manager.isScopeOnThisDevice(record.scope),
      };
    } catch {
      // Released between the lookup and the read.
      return null;
    }
    return this.withHello(manager, record.scope, snapshot);
  }

  /** `snapshot` with the scope's hello, or as it is when it cannot be read now. */
  private async withHello(
    manager: NodeIpcManager,
    scope: string,
    snapshot: NodeGatewaySnapshot,
  ): Promise<NodeGatewaySnapshot> {
    if (!manager.scopeHello) return snapshot;
    try {
      return { ...snapshot, hello: await manager.scopeHello(scope) };
    } catch {
      // Unreachable or released meanwhile: the renderer asks again on reconnect.
      return snapshot;
    }
  }

  /**
   * The scope machine administration acts on. A workspace grant cannot
   * administer its node, so a named leaf is refused with where that is done
   * instead.
   */
  adminScope(context: W, nodeId?: string): string {
    if (nodeId !== undefined && !this.isCommandNode(context, nodeId)) {
      const name = context.nodes.get(nodeId)?.target?.nodeName ?? "That machine";
      throw nodeRefusal(
        "node-admin-refused",
        `${name}'s web access and gateway token are managed from Settings → Machines on the command node.`,
      );
    }
    return context.scope;
  }

  /** An envelope is passed on only when the renderer sent one, so older calls stay three-argument. */
  private invokeIn(
    scope: string,
    command: string,
    args: Record<string, unknown>,
    options: { envelope?: Record<string, unknown> } | undefined,
  ): Promise<unknown> {
    return options?.envelope
      ? this.manager().invoke(command, args, scope, { envelope: options.envelope })
      : this.manager().invoke(command, args, scope);
  }

  private manager(): NodeIpcManager {
    const manager = this.options.manager();
    if (!manager) throw new Error("Connections are not initialized");
    return manager;
  }

  /**
   * Refuse a node missing from the command node's list. A list that cannot be
   * read (an older or busy command node) decides nothing: the open says why.
   */
  private async assertKnown(context: W, nodeId: string): Promise<void> {
    let listed: unknown;
    try {
      listed = await this.manager().invoke("list_nodes", {}, this.commandScope(context));
    } catch {
      return;
    }
    const nodes = (listed as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(nodes)) return;
    if (nodes.some((node) => (node as { nodeId?: unknown } | null)?.nodeId === nodeId)) return;
    throw nodeRefusal("unknown-node", "This window's command node does not know that machine.");
  }

  private refusalFor(error: unknown, context: W): unknown {
    if (error instanceof NodeRefusal) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (CLOSED_MESSAGES.has(message) || context.window.isDestroyed())
      return nodeRefusal("node-scope-closed", "The machine's scope in this window was closed.");
    return nodeRefusal("node-unavailable", message);
  }

  /**
   * Once per scope: map its connection to `(window, nodeId)` and register the
   * unmapping as a release hook of the scope's lifetime (it runs before the
   * grant is revoked). Then tell the renderer the node's stream is up: events
   * that arrived before the mapping were not delivered, so it reconciles.
   */
  private wire(context: W, record: NodeScopeRecord): void {
    if (this.wired.has(record)) return;
    this.wired.add(record);
    let unmap: (() => void) | null = null;
    try {
      unmap = this.options.mapNodeConnection(
        context,
        record.nodeId,
        this.manager().getConnectionId(record.scope),
      );
    } catch {
      // Released after the open settled; the release hook below runs at once.
    }
    onNodeScopeRelease(record, () => {
      unmap?.();
      if (!context.contents.isDestroyed())
        context.contents.send(NODE_EVENT_CHANNEL, record.nodeId, NODE_SCOPE_RELEASED_EVENT, {
          nodeId: record.nodeId,
        });
    });
    if (unmap && !context.contents.isDestroyed())
      context.contents.send(
        NODE_EVENT_CHANNEL,
        record.nodeId,
        NATIVE_EVENT_STREAM_CONNECTED_EVENT,
        undefined,
      );
  }
}
