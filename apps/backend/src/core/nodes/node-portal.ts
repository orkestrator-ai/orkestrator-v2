import { randomUUID } from "node:crypto";

import { parseBackendProfile } from "@orkestrator/protocol/backend-profile";
import type { NodeView } from "@orkestrator/protocol/command-nodes";
import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";

import { ClientGrantService, MAX_GRANT_TTL_MS, type ClientGrant } from "./client-grants.js";
import { NodeUnavailableError } from "./node-link.js";
import {
  NodeReadModel,
  type ReadModelLocal,
  type ReadModelPersistence,
} from "./node-read-model.js";
import { NODE_RELAY_PREFIX, type RelayTarget } from "./node-relay.js";
import {
  isReadCommand,
  NodeOutcomeLedger,
  routeToNode,
  type RoutedResult,
} from "./node-routing.js";
import type { NodeService } from "./node-service.js";

/**
 * The portal side of a command node, and the grant side of a leaf.
 *
 * Command node: the aggregated read model, node-qualified routing with the
 * outcome-unknown ledger, the relay target for each connected node, and
 * leaf workspaces (a client grant per open workspace, renewed while open).
 * Leaf: the client grants it issues to its attached controllers.
 */

export interface NodeWorkspace {
  workspaceId: string;
  nodeId: BackendId;
  /** The leaf's grant ID; the token itself is handed to the client once. */
  grantId: string;
  expiresAt: number;
}

export interface OpenedNodeWorkspace {
  workspaceId: string;
  nodeId: BackendId;
  nodeName: string;
  grant: { token: string; expiresAt: number };
  /** HTTPS origins of the node a client may try directly, in route order. */
  directOrigins: string[];
  /** Path on this command node that relays to the node. */
  relayBase: string;
  /** How the command node itself reaches the node (for the connection path). */
  commandRouteKind?: "https" | "ssh";
  /**
   * The command node's own loopback route to the node (an SSH forward), for
   * a client on the same computer as the command node: the desktop app.
   */
  loopbackOrigin?: string;
}

const MAX_WORKSPACES = 128;

export class NodePortal {
  readonly readModel: NodeReadModel;
  readonly outcomes: NodeOutcomeLedger;
  readonly grants: ClientGrantService;
  private readonly workspaces = new Map<string, NodeWorkspace>();
  /** Runs after a routed command succeeded (environment seed files after create_environment). */
  afterRouted:
    | ((
        nodeId: BackendId,
        command: string,
        args: Record<string, unknown>,
        result: unknown,
      ) => Promise<void>)
    | null = null;

  constructor(
    private readonly options: {
      nodes: NodeService;
      emit: (event: string, payload: unknown) => void;
      summaries?: ReadModelPersistence;
      /** This node's own commands, for its self summary. */
      local?: ReadModelLocal;
      outcomes?: { load(): Promise<unknown>; save(value: unknown): Promise<void> };
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.readModel = new NodeReadModel({
      nodes: options.nodes,
      emit: options.emit,
      ...(options.summaries ? { persistence: options.summaries } : {}),
      ...(options.local ? { local: options.local } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.outcomes = new NodeOutcomeLedger(options.outcomes);
    this.grants = new ClientGrantService(options.now);
    options.nodes.onControllerDetached((controllerId) => {
      this.grants.revokeController(controllerId);
    });
  }

  async start(): Promise<void> {
    await this.outcomes.restore();
    await this.readModel.start();
  }

  stop(): void {
    this.readModel.stop();
    this.grants.revokeAll();
    this.workspaces.clear();
  }

  /*
   * Command node: portal reads and routing
   */

  summaries(nodeIds?: unknown, includeSelf?: unknown): Promise<NodeSummariesResult> {
    if (nodeIds !== undefined && (!Array.isArray(nodeIds) || !nodeIds.every(isBackendId))) {
      throw new Error("Expected nodeIds to be node identities.");
    }
    if (includeSelf !== undefined && typeof includeSelf !== "boolean") {
      throw new Error("Expected includeSelf to be a boolean.");
    }
    return this.readModel.summaries(nodeIds as BackendId[] | undefined, {
      includeSelf: includeSelf === true,
    });
  }

  async invokeOnNode(args: Record<string, unknown>): Promise<RoutedResult<unknown>> {
    const nodeId = args.nodeId;
    if (!isBackendId(nodeId)) throw new Error("Expected nodeId to be a node identity.");
    if (typeof args.command !== "string" || !args.command) throw new Error("Expected command.");
    const commandArgs =
      args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};
    const result = await routeToNode({
      nodeId,
      link: this.options.nodes.isLeaf() ? null : this.options.nodes.link(nodeId),
      command: args.command,
      args: commandArgs,
      ...(typeof args.requestKey === "string" ? { requestKey: args.requestKey.slice(0, 128) } : {}),
      outcomes: this.outcomes,
    });
    if (result.outcome === "ok") {
      // An environment on a leaf gets its seed files before it starts.
      await this.afterRouted?.(nodeId, args.command, commandArgs, result.result).catch(
        (error: unknown) => {
          console.warn(
            "[nodes] Post-command step on a node failed:",
            error instanceof Error ? error.name : "unknown",
          );
        },
      );
      if (args.command === "update_backend_profile") {
        // The new name and colour show without waiting for the node's event.
        try {
          await this.options.nodes.recordProfile(nodeId, parseBackendProfile(result.result));
        } catch {
          // The node's profile event or next hello reconciles.
        }
      }
      // Writes refresh that node's summaries sooner than its next event.
      if (!isReadCommand(args.command)) void this.readModel.requestHydrate(nodeId);
    }
    return result;
  }

  /** Where the relay forwards one node's traffic; `null` while not connected. */
  relayTarget(nodeId: BackendId): RelayTarget | null {
    if (this.options.nodes.isLeaf()) return null;
    return this.options.nodes.link(nodeId)?.transport() ?? null;
  }

  /*
   * Command node: leaf workspaces opened directly by a client
   */

  async openWorkspace(nodeId: unknown): Promise<OpenedNodeWorkspace> {
    if (!isBackendId(nodeId)) throw new Error("Expected nodeId to be a node identity.");
    const link = this.options.nodes.isLeaf() ? null : this.options.nodes.link(nodeId);
    if (!link?.connected) {
      throw new NodeUnavailableError("That node is not connected, so its workspace cannot open.");
    }
    if (this.workspaces.size >= MAX_WORKSPACES) this.pruneWorkspaces();
    const view: NodeView = await this.options.nodes.getNode(nodeId);
    const issued = await link.invoke<{ grant: ClientGrant; token: string }>("create_client_grant", {
      controllerId: await this.options.nodes.selfIdentity(),
      ttlSeconds: MAX_GRANT_TTL_MS / 1000,
      label: "workspace",
    });
    const workspace: NodeWorkspace = {
      workspaceId: randomUUID(),
      nodeId,
      grantId: issued.grant.grantId,
      expiresAt: issued.grant.expiresAt,
    };
    this.workspaces.set(workspace.workspaceId, workspace);
    const ordered = view.routeOrder
      .map((id) => view.routes.find((route) => route.id === id))
      .filter((route) => route?.enabled);
    const opened: OpenedNodeWorkspace = {
      workspaceId: workspace.workspaceId,
      nodeId,
      nodeName: view.displayName,
      grant: { token: issued.token, expiresAt: issued.grant.expiresAt },
      directOrigins: ordered.flatMap((route) => (route?.kind === "https" ? [route.origin] : [])),
      relayBase: `${NODE_RELAY_PREFIX}${encodeURIComponent(nodeId)}`,
    };
    if (view.connection.activeRouteKind) opened.commandRouteKind = view.connection.activeRouteKind;
    const transport = link.transport();
    if (transport) {
      const origin = new URL(transport.baseUrl);
      if (origin.hostname === "127.0.0.1" || origin.hostname === "localhost") {
        opened.loopbackOrigin = origin.origin;
      }
    }
    return opened;
  }

  async renewWorkspace(workspaceId: unknown): Promise<{ expiresAt: number }> {
    const workspace =
      typeof workspaceId === "string" ? this.workspaces.get(workspaceId) : undefined;
    if (!workspace) throw new Error("That workspace is closed. Open it again.");
    const link = this.options.nodes.link(workspace.nodeId);
    if (!link?.connected) throw new NodeUnavailableError("That node is not connected.");
    const renewed = await link.invoke<ClientGrant | null>("renew_client_grant", {
      controllerId: await this.options.nodes.selfIdentity(),
      grantId: workspace.grantId,
      ttlSeconds: MAX_GRANT_TTL_MS / 1000,
    });
    if (!renewed) {
      this.workspaces.delete(workspace.workspaceId);
      throw new Error("The node no longer accepts this workspace's grant. Open it again.");
    }
    workspace.expiresAt = renewed.expiresAt;
    return { expiresAt: renewed.expiresAt };
  }

  /** Closing a workspace revokes its grant. Nothing on the node stops. */
  async closeWorkspace(workspaceId: unknown): Promise<{ closed: boolean }> {
    const workspace =
      typeof workspaceId === "string" ? this.workspaces.get(workspaceId) : undefined;
    if (!workspace) return { closed: false };
    this.workspaces.delete(workspace.workspaceId);
    const link = this.options.nodes.link(workspace.nodeId);
    if (link?.connected) {
      await link
        .invoke("revoke_client_grant", {
          controllerId: await this.options.nodes.selfIdentity(),
          grantId: workspace.grantId,
        })
        .catch(() => undefined);
    }
    return { closed: true };
  }

  private pruneWorkspaces(): void {
    const now = (this.options.now ?? Date.now)();
    for (const [id, workspace] of this.workspaces) {
      if (workspace.expiresAt <= now) this.workspaces.delete(id);
    }
  }

  /*
   * Leaf: grants for attached controllers
   */

  createClientGrant(args: Record<string, unknown>): { grant: ClientGrant; token: string } {
    const controllerId = this.attachedController(args.controllerId);
    const ttlSeconds = typeof args.ttlSeconds === "number" ? args.ttlSeconds : 900;
    return this.grants.issue({
      controllerId,
      label: typeof args.label === "string" ? args.label : "workspace",
      ttlMs: ttlSeconds * 1000,
    });
  }

  renewClientGrant(args: Record<string, unknown>): ClientGrant | null {
    const controllerId = this.attachedController(args.controllerId);
    if (typeof args.grantId !== "string") throw new Error("Expected grantId.");
    const ttlSeconds = typeof args.ttlSeconds === "number" ? args.ttlSeconds : 900;
    return this.grants.renew({ grantId: args.grantId, controllerId, ttlMs: ttlSeconds * 1000 });
  }

  revokeClientGrant(args: Record<string, unknown>): { revoked: boolean } {
    const controllerId = this.attachedController(args.controllerId);
    if (typeof args.grantId !== "string") throw new Error("Expected grantId.");
    return { revoked: this.grants.revoke(args.grantId, controllerId) };
  }

  private attachedController(value: unknown): BackendId {
    if (
      !isBackendId(value) ||
      !this.options.nodes.listControllers().some((entry) => entry.controllerId === value)
    ) {
      throw new Error("Only an attached command node can manage client grants on this node.");
    }
    return value;
  }
}
