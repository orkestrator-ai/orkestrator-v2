import type { BackendHello, BackendProfile } from "@orkestrator/protocol/backend-profile";
import {
  deriveNodeMode,
  MAX_ATTACHED_CONTROLLERS,
  MAX_REGISTERED_NODES,
  NODE_REFUSAL_CODES,
  NODE_STATUS_CHANGED_EVENT,
  NODES_CHANGED_EVENT,
  NodeRefusalError,
  normalizeNodeDisplayName,
  normalizeRouteOrder,
  parseAttachControllerArgs,
  parseGatewayCredential,
  parseNodeRoutes,
  type AttachControllerResult,
  type CommandHandoverPreview,
  type CommandHandoverResult,
  type CommandHandoverReceipt,
  type PendingCommandHandover,
  type ControllerView,
  type HandoverCandidate,
  type NodeAttachments,
  type NodeImportEntry,
  type NodeListResult,
  type NodeMode,
  type NodeRecord,
  type NodeRegistry,
  type NodeRoute,
  type NodeStatus,
  type NodeView,
} from "@orkestrator/protocol/command-nodes";
import {
  isBackendId,
  isProvisionalBackendId,
  type BackendId,
  type RouteId,
} from "@orkestrator/protocol/federation";
import { checkBackendRoute } from "@orkestrator/protocol/node/node-link/backend-hello";
import {
  classifyRouteFailure,
  openRoute,
  type SshTunnelProvider,
} from "@orkestrator/protocol/node/node-link/routes";
import type { SshAskpassHandler } from "@orkestrator/protocol/node/ssh/askpass";
import {
  SYNC_CONTROLLER_SETTINGS_COMMAND,
  type InheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";

import type { NodeStoreMutation } from "../storage-nodes.js";
import {
  LeafControllerSettings,
  type ControllerSettingsStorage,
} from "./node-controller-settings.js";
import {
  NodeLink,
  NodeOutcomeUnknownError,
  NODE_HELLO_TIMEOUT_MS,
  type NodeLinkTimers,
} from "./node-link.js";
import { NodeSshPrompts } from "./node-ssh-prompts.js";

/**
 * Command-node and leaf behaviour of one backend.
 *
 * Leaf side: the command nodes attached to this node, the most recent
 * contact, and the portal origins they registered.
 * Command side: the registry of nodes this node controls and a link to each.
 *
 * Mode follows from those two: attached anywhere means leaf mode, in which
 * every link is stopped (the registry is kept) and registration is refused.
 * When the last controller detaches, command activity resumes.
 */

export interface NodeServiceStorage extends ControllerSettingsStorage {
  getNodeRegistry(): Promise<NodeRegistry>;
  mutateNodeRegistry<T>(
    mutate: (current: NodeRegistry) => NodeStoreMutation<NodeRegistry, T>,
    beforeApply?: () => void,
  ): Promise<T>;
  getNodeAttachments(): Promise<NodeAttachments>;
  mutateNodeAttachments<T>(
    mutate: (current: NodeAttachments) => NodeStoreMutation<NodeAttachments, T>,
  ): Promise<T>;
  getBackendProfile(): Promise<BackendProfile>;
  getPreviewBackendIdentity(): Promise<{ instanceId: string }>;
}

export interface NodeServiceOptions {
  storage: NodeServiceStorage;
  emit: (event: string, payload: unknown) => void;
  /** `--command-node`: registration is always enabled (the desktop's local backend). */
  forceRegistration?: boolean;
  /** Origins clients load this node's portal from; registered on each leaf. */
  portalOrigins?: () => string[];
  /** One SSH provider per node (tunnels and prompts are per node); `null` when SSH is unavailable. */
  createSsh?: (prompt: SshAskpassHandler) => SshTunnelProvider | null;
  fetchImpl?: typeof fetch;
  timers?: NodeLinkTimers;
  heartbeatMs?: number;
  now?: () => number;
  /** How long a controller's last contact may stay unpersisted. */
  contactPersistMs?: number;
  /** Command side: this node's settings that its leaves inherit. */
  inheritableSettings?: () => Promise<InheritedGlobalSettings>;
  /** Leaf side: the command node settings this node follows changed. */
  onInheritedSettingsChanged?: () => void;
  /**
   * How another node can reach and control this one: its gateway token and
   * the origins it is served on. Handed to the new command node on a handover.
   */
  selfAccess?: () => Promise<{ token: string | null; origins: string[] }>;
}

export type DesktopConnectionImport = NodeImportEntry;

const HANDOVER_TIMEOUT_MS = 30_000;

const CONTACT_PERSIST_MS = 30_000;
const DETACH_RETRY_MS = 5 * 60_000;

export class NodeService {
  private readonly storage: NodeServiceStorage;
  private readonly emit: (event: string, payload: unknown) => void;
  private readonly options: NodeServiceOptions;
  private readonly now: () => number;
  readonly prompts: NodeSshPrompts;
  private selfId: BackendId | null = null;
  private handoverRunning = false;
  private acceptingHandover = false;
  private attachments: NodeAttachments = { version: 1, controllers: [], detachedControllers: [] };
  private registry: NodeRegistry | null = null;
  private readonly links = new Map<BackendId, NodeLink>();
  private readonly sshProviders = new Map<BackendId, SshTunnelProvider | null>();
  private probeSsh: SshTunnelProvider | null | undefined;
  private readonly pendingContacts = new Map<BackendId, number>();
  private readonly lastPersistedContact = new Map<BackendId, number>();
  private contactTimer: ReturnType<typeof setTimeout> | null = null;
  private detachTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** Nodes being added by the user: their first connect may prompt for SSH. */
  private readonly interactiveStarts = new Map<BackendId, Promise<void> | null>();
  private lastMode: NodeMode | null = null;
  private readonly changeListeners = new Set<() => void>();
  private readonly detachListeners = new Set<(controllerId: BackendId) => void>();
  private changeQueued = false;
  /** Leaf side: settings handed down by attached command nodes. */
  readonly inheritedSettings: LeafControllerSettings;
  /** Command side: what each leaf was last sent, per link epoch. */
  private readonly sentSettings = new WeakMap<NodeLink, { epoch: number; settings: string }>();
  private readonly unsupportedSettings = new WeakMap<NodeLink, number>();
  private readonly settingsSends = new WeakMap<NodeLink, Promise<void>>();

  constructor(options: NodeServiceOptions) {
    this.options = options;
    this.storage = options.storage;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.prompts = new NodeSshPrompts(options.emit);
    this.inheritedSettings = new LeafControllerSettings({
      storage: options.storage,
      now: this.now,
      attachedName: (controllerId) =>
        this.attachments.controllers.find((entry) => entry.controllerId === controllerId)
          ?.displayName ?? null,
      onChange: () => {
        this.options.onInheritedSettingsChanged?.();
        this.emitStatus();
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.self();
    this.attachments = await this.storage.getNodeAttachments();
    this.registry = await this.storage.getNodeRegistry();
    await this.inheritedSettings.start();
    this.lastMode = this.mode();
    this.applyMode();
    void this.retryDetaches();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    this.prompts.cancelAll();
    if (this.contactTimer) clearTimeout(this.contactTimer);
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.contactTimer = null;
    this.detachTimer = null;
    await this.flushContacts();
    const providers = [...this.sshProviders.values(), this.probeSsh ?? null];
    this.sshProviders.clear();
    await Promise.all(providers.map((provider) => provider?.disposeAll?.().catch(() => undefined)));
  }

  /** Registry, connection or mode changed (coalesced). */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** A command node detached from this node (by itself or by the user here). */
  onControllerDetached(listener: (controllerId: BackendId) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  selfIdentity(): Promise<BackendId> {
    return this.self();
  }

  selfProfile(): Promise<BackendProfile> {
    return this.storage.getBackendProfile();
  }

  /*
   * Mode
   */

  async status(): Promise<NodeStatus> {
    const registry = await this.currentRegistry();
    const mode = this.mode();
    const controllers = this.controllerViews();
    const status: NodeStatus = {
      nodeId: await this.self(),
      mode,
      registrationEnabled: this.registrationEnabled(registry),
      controllers,
      detachedControllers: this.attachments.detachedControllers.map((entry) => ({ ...entry })),
      suspendedSubordinateCount:
        mode === "leaf" ? registry.nodes.filter((node) => node.enabled).length : 0,
    };
    const recent = this.mostRecentControllerId();
    if (recent) status.mostRecentControllerId = recent;
    const inherited = this.inheritedSettings.source();
    if (inherited) status.inheritedSettingsFrom = inherited;
    return status;
  }

  /** Synchronous view for the hello: valid once `start()` has run. */
  mode(): NodeMode {
    return deriveNodeMode({
      controllerCount: this.attachments.controllers.length,
      commandedNodeCount: (this.registry?.nodes ?? []).filter(
        (node) => node.enabled && node.attachment.status === "attached",
      ).length,
    });
  }

  isLeaf(): boolean {
    return this.attachments.controllers.length > 0;
  }

  private registrationEnabled(registry: NodeRegistry): boolean {
    return this.options.forceRegistration === true || registry.registrationEnabled;
  }

  private assertHandoverEditable(registry: NodeRegistry): void {
    if (
      this.handoverRunning ||
      this.acceptingHandover ||
      registry.pendingHandover ||
      registry.handoverReceipts?.some((entry) => !entry.completed)
    ) {
      throw new Error("Finish the pending command handover before editing machines.");
    }
  }

  async setRegistrationEnabled(enabled: boolean): Promise<NodeStatus> {
    if (!enabled && this.options.forceRegistration) {
      throw new Error("This node is the desktop's command node; registration stays enabled.");
    }
    await this.mutateRegistry((registry) => {
      this.assertHandoverEditable(registry);
      if (!enabled && registry.nodes.length > 0) {
        throw new Error(
          "Forget the registered nodes before turning command-node registration off.",
        );
      }
      if (registry.registrationEnabled === enabled) return { next: null, result: undefined };
      return { next: { ...registry, registrationEnabled: enabled }, result: undefined };
    });
    return this.status();
  }

  /** Start or suspend links after any change to attachments or the registry. */
  private applyMode(): void {
    if (!this.started) return;
    const leaf = this.isLeaf();
    const nodes = this.registry?.nodes ?? [];
    for (const [nodeId, link] of this.links) {
      if (!nodes.some((node) => node.nodeId === nodeId)) {
        link.stop();
        this.links.delete(nodeId);
      }
    }
    for (const node of nodes) {
      let link = this.links.get(node.nodeId);
      if (!link) {
        link = this.createLink(node);
        this.links.set(node.nodeId, link);
        if (leaf) link.stop("suspended");
        else if (this.interactiveStarts.has(node.nodeId)) {
          this.interactiveStarts.set(node.nodeId, link.start({ interactive: true }));
        } else void link.start();
        continue;
      }
      link.update(node);
      if (leaf && link.view.state !== "suspended") link.stop("suspended");
      else if (!leaf && link.view.state === "suspended") void link.start();
    }
    const mode = this.mode();
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      void this.status().then((status) => this.emit(NODE_STATUS_CHANGED_EVENT, status));
    }
  }

  /*
   * Leaf side
   */

  async attachController(args: Record<string, unknown>): Promise<AttachControllerResult> {
    const parsed = parseAttachControllerArgs(args);
    const selfId = await this.self();
    if (parsed.controllerId === selfId) {
      throw new NodeRefusalError(NODE_REFUSAL_CODES.selfAttach, "A node cannot command itself.");
    }
    const registry = await this.currentRegistry();
    if (registry.nodes.some((node) => node.nodeId === parsed.controllerId)) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.controllerIsSubordinate,
        "That command node is registered under this node. Forget it here first; only two levels are allowed.",
      );
    }
    // A fresh attachment must wait for any failed detach cleanup before it
    // becomes eligible to follow persisted settings again.
    if (!this.attachments.controllers.some((entry) => entry.controllerId === parsed.controllerId)) {
      await this.inheritedSettings.forget(parsed.controllerId);
    }
    const timestamp = new Date(this.now()).toISOString();
    const next = await this.storage.mutateNodeAttachments((current) => {
      if (current.detachedControllers.some((entry) => entry.controllerId === parsed.controllerId)) {
        throw new NodeRefusalError(
          NODE_REFUSAL_CODES.detachedOnNode,
          "This node's user detached that command node. Allow it again on this node first.",
        );
      }
      const existing = current.controllers.find(
        (controller) => controller.controllerId === parsed.controllerId,
      );
      if (!existing && current.controllers.length >= MAX_ATTACHED_CONTROLLERS) {
        throw new NodeRefusalError(
          NODE_REFUSAL_CODES.tooManyControllers,
          "Too many command nodes are attached to this node.",
        );
      }
      const controllers = existing
        ? current.controllers.map((controller) =>
            controller.controllerId === parsed.controllerId
              ? {
                  ...controller,
                  displayName: parsed.displayName,
                  portalOrigins: parsed.portalOrigins,
                  lastContactAt: timestamp,
                }
              : controller,
          )
        : [
            ...current.controllers,
            {
              controllerId: parsed.controllerId,
              displayName: parsed.displayName,
              portalOrigins: parsed.portalOrigins,
              attachedAt: timestamp,
              lastContactAt: timestamp,
            },
          ];
      const value: NodeAttachments = { ...current, controllers };
      return { next: value, result: value };
    });
    this.lastPersistedContact.set(parsed.controllerId, this.now());
    this.pendingContacts.delete(parsed.controllerId);
    const wasLeaf = this.isLeaf();
    this.attachments = next;
    if (!wasLeaf) this.applyMode();
    this.emitStatus();
    return { nodeId: selfId, mode: this.mode() };
  }

  /**
   * Detach a command node. `byUser` is the user detaching it on this node:
   * it is then remembered and may not re-attach until the user allows it.
   * A controller forgetting this node detaches itself without that record.
   */
  async detachController(
    controllerId: unknown,
    options: { byUser?: boolean } = {},
  ): Promise<{ detached: boolean }> {
    if (!isBackendId(controllerId)) throw new Error("Expected controllerId to be a node identity.");
    const detachedAt = new Date(this.now()).toISOString();
    const result = await this.storage.mutateNodeAttachments((current) => {
      const removed = current.controllers.find(
        (controller) => controller.controllerId === controllerId,
      );
      if (!removed) return { next: null, result: { detached: false, value: current } };
      const value: NodeAttachments = {
        version: 1,
        controllers: current.controllers.filter((controller) => controller !== removed),
        detachedControllers: options.byUser
          ? [
              ...current.detachedControllers.filter((entry) => entry.controllerId !== controllerId),
              { controllerId, displayName: removed.displayName, detachedAt },
            ].slice(-MAX_ATTACHED_CONTROLLERS * 4)
          : current.detachedControllers,
      };
      return { next: value, result: { detached: true, value } };
    });
    this.attachments = result.value;
    this.pendingContacts.delete(controllerId);
    this.lastPersistedContact.delete(controllerId);
    if (result.detached) {
      for (const listener of this.detachListeners) listener(controllerId);
      this.applyMode();
      this.emitStatus();
    }
    // Retry cleanup even if a previous detach removed the attachment but failed to persist.
    await this.inheritedSettings.forget(controllerId);
    return { detached: result.detached };
  }

  listControllers(): ControllerView[] {
    return this.controllerViews();
  }

  /** Let a command node the user detached here attach again. */
  async allowController(controllerId: unknown): Promise<{ allowed: boolean }> {
    const result = await this.storage.mutateNodeAttachments((current) => {
      const detachedControllers = current.detachedControllers.filter(
        (entry) => entry.controllerId !== controllerId,
      );
      if (detachedControllers.length === current.detachedControllers.length) {
        return { next: null, result: { allowed: false, value: current } };
      }
      const value: NodeAttachments = { ...current, detachedControllers };
      return { next: value, result: { allowed: true, value } };
    });
    this.attachments = result.value;
    if (result.allowed) this.emitStatus();
    return { allowed: result.allowed };
  }

  /** From the controller header on an authenticated request. Cheap and synchronous. */
  noteControllerContact(controllerId: string): void {
    if (!isBackendId(controllerId)) return;
    const controller = this.attachments.controllers.find(
      (entry) => entry.controllerId === controllerId,
    );
    if (!controller) return;
    const now = this.now();
    controller.lastContactAt = new Date(now).toISOString();
    const persisted = this.lastPersistedContact.get(controllerId) ?? 0;
    if (now - persisted < (this.options.contactPersistMs ?? CONTACT_PERSIST_MS)) {
      this.pendingContacts.set(controllerId, now);
      this.scheduleContactFlush();
      return;
    }
    this.pendingContacts.set(controllerId, now);
    void this.flushContacts();
  }

  /** Attached command nodes' portals may call this node directly. */
  isPortalOriginAllowed(origin: string): boolean {
    const normalized = origin.toLowerCase();
    return this.attachments.controllers.some((controller) =>
      controller.portalOrigins.some((entry) => entry.toLowerCase() === normalized),
    );
  }

  mostRecentControllerId(): BackendId | undefined {
    let best: { id: BackendId; at: string } | undefined;
    for (const controller of this.attachments.controllers) {
      if (!best || controller.lastContactAt > best.at) {
        best = { id: controller.controllerId, at: controller.lastContactAt };
      }
    }
    return best?.id;
  }

  private controllerViews(): ControllerView[] {
    return this.attachments.controllers.map((controller) => ({
      controllerId: controller.controllerId,
      displayName: controller.displayName,
      attachedAt: controller.attachedAt,
      lastContactAt: controller.lastContactAt,
    }));
  }

  private scheduleContactFlush(): void {
    if (this.contactTimer) return;
    this.contactTimer = setTimeout(() => {
      this.contactTimer = null;
      void this.flushContacts();
    }, this.options.contactPersistMs ?? CONTACT_PERSIST_MS);
    this.contactTimer.unref?.();
  }

  private async flushContacts(): Promise<void> {
    if (this.pendingContacts.size === 0) return;
    const pending = new Map(this.pendingContacts);
    this.pendingContacts.clear();
    try {
      const value = await this.storage.mutateNodeAttachments((current) => {
        let changed = false;
        const controllers = current.controllers.map((controller) => {
          const at = pending.get(controller.controllerId);
          if (at === undefined) return controller;
          const lastContactAt = new Date(at).toISOString();
          if (lastContactAt <= controller.lastContactAt) return controller;
          changed = true;
          return { ...controller, lastContactAt };
        });
        const next: NodeAttachments = { ...current, controllers };
        return { next: changed ? next : null, result: changed ? next : current };
      });
      for (const [id, at] of pending) this.lastPersistedContact.set(id, at);
      // Keep in-memory contact times that are newer than what was just stored.
      this.attachments = {
        ...value,
        controllers: value.controllers.map((controller) => {
          const live = this.attachments.controllers.find(
            (entry) => entry.controllerId === controller.controllerId,
          );
          return live && live.lastContactAt > controller.lastContactAt
            ? { ...controller, lastContactAt: live.lastContactAt }
            : controller;
        }),
      };
    } catch (error) {
      console.warn("[nodes] Could not record the latest controller contact:", errorCode(error));
    }
  }

  /*
   * Command side: settings handed down to leaves
   */

  /** This node's inheritable settings changed: send them to every connected leaf. */
  syncSettingsToLeaves(): void {
    for (const link of this.links.values()) this.syncSettingsTo(link);
  }

  /**
   * Send the settings to one leaf if it has not had them on this connection.
   * Sends to a leaf are serialized so an older copy never lands after a newer one.
   */
  private syncSettingsTo(link: NodeLink): void {
    const source = this.options.inheritableSettings;
    if (!source || !link.connected || this.isLeaf()) return;
    const nodeId = link.nodeId;
    const previous = this.settingsSends.get(link) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!link.connected || this.links.get(nodeId) !== link) return;
      const epoch = link.view.epoch;
      if (this.unsupportedSettings.get(link) === epoch) return;
      const settings = await source();
      if (!link.connected || this.links.get(nodeId) !== link || link.view.epoch !== epoch) return;
      const serialized = JSON.stringify(settings);
      const sent = this.sentSettings.get(link);
      if (sent && sent.epoch === epoch && sent.settings === serialized) return;
      try {
        await link.invoke(SYNC_CONTROLLER_SETTINGS_COMMAND, {
          controllerId: this.selfId,
          settings,
        });
        this.sentSettings.set(link, { epoch, settings: serialized });
      } catch (error) {
        // A definitive capability refusal is distinct from delivery. Other
        // failures remain unsent, so the next sync can retry unchanged settings.
        if (
          error instanceof Error &&
          error.message === `Unknown command: ${SYNC_CONTROLLER_SETTINGS_COMMAND}`
        ) {
          this.unsupportedSettings.set(link, epoch);
        }
        console.warn("[nodes] Could not send settings to a node:", errorCode(error));
      }
    });
    const settled = next.catch(() => undefined);
    this.settingsSends.set(link, settled);
    void settled.then(() => {
      if (this.settingsSends.get(link) === settled) this.settingsSends.delete(link);
    });
  }

  /*
   * Command side: registry
   */

  async listNodes(): Promise<NodeListResult> {
    const registry = await this.currentRegistry();
    return {
      revision: registry.revision,
      mode: this.mode(),
      suspended: this.isLeaf(),
      nodes: registry.nodes.map((node) => this.view(node)),
      pendingDetaches: registry.tombstones.map((entry) => ({
        nodeId: entry.nodeId,
        displayName: entry.nodeId,
        forgottenAt: entry.forgottenAt,
      })),
    };
  }

  async getNode(nodeId: unknown): Promise<NodeView> {
    const registry = await this.currentRegistry();
    const node = registry.nodes.find((entry) => entry.nodeId === nodeId);
    if (!node)
      throw new NodeRefusalError(NODE_REFUSAL_CODES.unknownNode, "That node is not registered.");
    return this.view(node);
  }

  /** The link to a registered node, for routing (portal, coordinators, files). */
  link(nodeId: BackendId): NodeLink | null {
    return this.links.get(nodeId) ?? null;
  }

  /**
   * Register a node: verify a route with the hello, check the two-level
   * rule, store the record, then attach. Interactive: SSH may prompt.
   */
  async addNode(args: Record<string, unknown>): Promise<NodeView> {
    const registry = await this.assertCanRegister();
    const routes = parseNodeRoutes(args.routes);
    const routeOrder = normalizeRouteOrder(routes, args.routeOrder);
    const token = parseGatewayCredential(args.token);
    const fallbackName =
      args.displayName === undefined
        ? describeFirstRoute(routes)
        : normalizeNodeDisplayName(args.displayName);
    if (registry.nodes.length + (registry.pendingHandover ? 1 : 0) >= MAX_REGISTERED_NODES) {
      throw new NodeRefusalError(NODE_REFUSAL_CODES.tooManyNodes, "Too many nodes are registered.");
    }
    const hello = await this.identify(routes, routeOrder, token);
    await this.assertRegistrable(hello.installationId);
    const record: NodeRecord = {
      nodeId: hello.installationId,
      enabled: true,
      routes,
      routeOrder,
      credential: { token },
      fallbackName,
      profileCache: {
        displayName: hello.profile.displayName,
        colorToken: hello.profile.colorToken,
        revision: hello.profile.revision,
      },
      attachment: { status: "pending" },
      addedAt: new Date(this.now()).toISOString(),
      source: "portal",
    };
    this.interactiveStarts.set(record.nodeId, null);
    try {
      await this.mutateRegistry((current) => {
        // Reserve the pending target's slot in case acceptance is rejected.
        if (current.nodes.length + (current.pendingHandover ? 1 : 0) >= MAX_REGISTERED_NODES)
          throw new NodeRefusalError(
            NODE_REFUSAL_CODES.tooManyNodes,
            "Too many nodes are registered.",
          );
        if (current.nodes.some((node) => node.nodeId === record.nodeId)) {
          throw new NodeRefusalError(
            NODE_REFUSAL_CODES.duplicateNode,
            "That node is already registered.",
          );
        }
        return {
          next: {
            ...current,
            nodes: [...current.nodes, record],
            tombstones: current.tombstones.filter((entry) => entry.nodeId !== record.nodeId),
          },
          result: undefined,
        };
      });
      await this.interactiveStarts.get(record.nodeId);
    } finally {
      this.interactiveStarts.delete(record.nodeId);
    }
    return this.getNode(record.nodeId);
  }

  async updateNode(args: Record<string, unknown>): Promise<NodeView> {
    const nodeId = args.nodeId;
    const routes = args.routes === undefined ? undefined : parseNodeRoutes(args.routes);
    const token = args.token === undefined ? undefined : parseGatewayCredential(args.token);
    if (args.enabled !== undefined && typeof args.enabled !== "boolean") {
      throw new Error("Expected enabled to be a boolean.");
    }
    await this.mutateRegistry((registry) => {
      this.assertHandoverEditable(registry);
      const node = registry.nodes.find((entry) => entry.nodeId === nodeId);
      if (!node) {
        throw new NodeRefusalError(NODE_REFUSAL_CODES.unknownNode, "That node is not registered.");
      }
      const nextRoutes = routes ?? node.routes;
      const updated: NodeRecord = {
        ...node,
        routes: nextRoutes,
        routeOrder: normalizeRouteOrder(nextRoutes, args.routeOrder ?? node.routeOrder),
        credential: token ? { token } : node.credential,
        enabled: typeof args.enabled === "boolean" ? args.enabled : node.enabled,
      };
      return {
        next: {
          ...registry,
          nodes: registry.nodes.map((entry) => (entry.nodeId === node.nodeId ? updated : entry)),
        },
        result: undefined,
      };
    });
    return this.getNode(nodeId);
  }

  /**
   * Forget a node on this command node. Nothing on the node is stopped or
   * deleted. Unless `withoutDetach`, a tombstone keeps the credential until
   * the node confirms the detach, so an offline node does not stay in leaf
   * mode forever.
   */
  async forgetNode(
    args: Record<string, unknown>,
  ): Promise<{ forgotten: boolean; detached: boolean }> {
    const nodeId = args.nodeId;
    const withoutDetach = args.withoutDetach === true;
    const removed = await this.mutateRegistry((registry) => {
      this.assertHandoverEditable(registry);
      const node = registry.nodes.find((entry) => entry.nodeId === nodeId);
      if (!node) return { next: null, result: null };
      const tombstones =
        withoutDetach || node.attachment.status !== "attached"
          ? registry.tombstones
          : [
              ...registry.tombstones.filter((entry) => entry.nodeId !== node.nodeId),
              {
                nodeId: node.nodeId,
                routes: node.routes,
                routeOrder: node.routeOrder,
                credential: node.credential,
                forgottenAt: new Date(this.now()).toISOString(),
              },
            ];
      return {
        next: {
          ...registry,
          nodes: registry.nodes.filter((entry) => entry.nodeId !== node.nodeId),
          tombstones,
        },
        result: node,
      };
    });
    if (!removed) return { forgotten: false, detached: false };
    const detached = await this.detachTombstone(removed.nodeId);
    return { forgotten: true, detached };
  }

  /** Drop a pending detach: the node keeps this command node attached until detached there. */
  async discardPendingDetach(nodeId: unknown): Promise<{ discarded: boolean }> {
    const discarded = await this.mutateRegistry((registry) => {
      const tombstones = registry.tombstones.filter((entry) => entry.nodeId !== nodeId);
      if (tombstones.length === registry.tombstones.length) return { next: null, result: false };
      return { next: { ...registry, tombstones }, result: true };
    });
    return { discarded };
  }

  async reconnectNode(nodeId: unknown): Promise<NodeView> {
    const view = await this.getNode(nodeId);
    if (this.isLeaf()) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.nodeIsSubordinate,
        "This node is in leaf mode; its command activity is suspended.",
      );
    }
    const link = this.links.get(view.nodeId);
    if (link) {
      link.stop("connecting");
      await link.start({ interactive: true });
    }
    return this.getNode(link?.nodeId ?? view.nodeId);
  }

  /**
   * One-time import of the desktop's saved machines as leaves of this
   * (local) command node. Each catalogue entry is imported once: a node the
   * user later forgets is not re-imported.
   */
  async importDesktopConnections(
    entries: DesktopConnectionImport[],
  ): Promise<{ imported: number; skipped: number; needsCredential: number }> {
    if (this.isLeaf()) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.nodeIsSubordinate,
        "This node is in leaf mode and cannot register nodes.",
      );
    }
    return this.adoptEntries(entries, "desktop-migration");
  }

  /**
   * Store machines handed to this node. A migration imports each catalogue
   * entry once; a handover is the user's explicit choice, so it skips only
   * machines already registered, and gives a registered machine without a
   * token the one it brings.
   */
  private async adoptEntries(
    entries: NodeImportEntry[],
    source: "desktop-migration" | "handover",
    receipt?: Omit<CommandHandoverReceipt, "imported" | "skipped" | "needsCredential">,
  ): Promise<{ imported: number; skipped: number; needsCredential: number }> {
    const selfId = await this.self();
    const once = source === "desktop-migration";
    return this.mutateRegistry((registry) => {
      if (source === "handover") {
        const incoming = new Set(
          entries.map((entry) => entry.verifiedNodeId ?? `provisional:${entry.importedFrom}`),
        );
        incoming.delete(selfId);
        for (const node of registry.nodes) incoming.delete(node.nodeId);
        if (registry.nodes.length + incoming.size > MAX_REGISTERED_NODES) {
          throw new NodeRefusalError(
            NODE_REFUSAL_CODES.tooManyNodes,
            "The target has no room for all of these machines.",
          );
        }
      }
      let imported = 0;
      let skipped = 0;
      let needsCredential = 0;
      let changed = false;
      const nodes = [...registry.nodes];
      const importedSources = [...registry.importedSources];
      for (const entry of entries) {
        const nodeId = entry.verifiedNodeId ?? (`provisional:${entry.importedFrom}` as BackendId);
        const existing = nodes.findIndex((node) => node.nodeId === nodeId);
        if (!once && existing >= 0 && !nodes[existing]!.credential && entry.token) {
          nodes[existing] = { ...nodes[existing]!, credential: { token: entry.token } };
          changed = true;
        }
        if (
          (once && importedSources.includes(entry.importedFrom)) ||
          nodeId === selfId ||
          existing >= 0 ||
          nodes.length >= MAX_REGISTERED_NODES
        ) {
          skipped += 1;
          if (once && !importedSources.includes(entry.importedFrom))
            importedSources.push(entry.importedFrom);
          continue;
        }
        const record: NodeRecord = {
          nodeId,
          enabled: entry.enabled,
          routes: entry.routes,
          routeOrder: normalizeRouteOrder(entry.routes, entry.routeOrder),
          credential: entry.token ? { token: entry.token } : null,
          fallbackName: entry.fallbackName,
          attachment: { status: "pending" },
          addedAt: new Date(this.now()).toISOString(),
          source,
          importedFrom: entry.importedFrom,
        };
        if (entry.profileCache) record.profileCache = entry.profileCache;
        if (!entry.token) needsCredential += 1;
        nodes.push(record);
        if (once) importedSources.push(entry.importedFrom);
        imported += 1;
      }
      // A node handed command may command others from now on.
      const registrationEnabled =
        registry.registrationEnabled || imported > 0 || source === "handover";
      changed ||=
        receipt !== undefined ||
        imported > 0 ||
        importedSources.length !== registry.importedSources.length ||
        registrationEnabled !== registry.registrationEnabled;
      return {
        next: changed
          ? {
              ...registry,
              registrationEnabled,
              ...(receipt
                ? {
                    handoverReceipts: [
                      ...(registry.handoverReceipts ?? []).slice(-63),
                      { ...receipt, imported, skipped, needsCredential },
                    ],
                  }
                : {}),
              nodes,
              importedSources,
              tombstones: registry.tombstones.filter(
                (tombstone) => !nodes.some((node) => node.nodeId === tombstone.nodeId),
              ),
            }
          : null,
        result: { imported, skipped, needsCredential },
      };
    });
  }

  /*
   * Handing command to another node
   */

  /**
   * What making `nodeId` the command node would hand over. A target this
   * node does not control yet (a client registers it first) is previewed
   * without asking it what it controls. While its link is refused, a client
   * that reads the target directly (to clear what refuses it) passes
   * `knownTargetNodeIds` instead.
   */
  async previewHandover(
    nodeId: unknown,
    knownTargetNodeIds?: unknown,
  ): Promise<CommandHandoverPreview> {
    if (!isBackendId(nodeId)) throw new Error("Expected nodeId to be a node identity.");
    if (
      knownTargetNodeIds !== undefined &&
      !(Array.isArray(knownTargetNodeIds) && knownTargetNodeIds.every(isBackendId))
    ) {
      throw new Error("Expected targetNodeIds to be node identities.");
    }
    const registry = await this.currentRegistry();
    const target = registry.nodes.find((node) => node.nodeId === nodeId) ?? null;
    const targetNodeIds = !target
      ? []
      : knownTargetNodeIds && !this.links.get(target.nodeId)?.connected
        ? [...new Set(knownTargetNodeIds as BackendId[])]
        : (
            await (await this.handoverTarget(nodeId)).link.invoke<NodeListResult>("list_nodes")
          ).nodes.map((node) => node.nodeId);
    const candidates: HandoverCandidate[] = registry.nodes
      .filter((node) => node.nodeId !== nodeId && !targetNodeIds.includes(node.nodeId))
      .filter((node) => remoteRoutes(node.routes).length > 0)
      .map((node) => {
        const view = this.view(node);
        return {
          nodeId: node.nodeId,
          displayName: view.displayName,
          ...(view.colorToken ? { colorToken: view.colorToken } : {}),
          hasCredential: node.credential !== null,
        };
      });
    const profile = await this.storage.getBackendProfile();
    const selfId = await this.self();
    return {
      targetNodeId: nodeId,
      targetName: target ? this.view(target).displayName : nodeId,
      targetRegistered: target !== null,
      targetNodeIds,
      candidates,
      self: {
        nodeId: selfId,
        displayName: profile.displayName,
        colorToken: profile.colorToken,
        reachable: targetNodeIds.includes(selfId) || (await this.selfEntry()) !== null,
      },
    };
  }

  /**
   * Make a registered node the command node: send it this node's machines
   * (all, or `nodeIds`) with their tokens, and this node itself, over the
   * existing link. The new command node detaches whatever controlled it and
   * takes them on; this node then forgets them and becomes its leaf.
   *
   * Only the user starts this, never an agent: the command is excluded from
   * routing and grants (`node-routing.ts`).
   */
  async handOverCommand(input: {
    nodeId: unknown;
    nodeIds?: unknown;
    includeSelf: boolean;
    entries: NodeImportEntry[];
  }): Promise<CommandHandoverResult> {
    if (this.handoverRunning)
      throw new Error("A command handover is already in progress. Retry when it finishes.");
    this.handoverRunning = true;
    try {
      const recovery = (await this.currentRegistry()).pendingHandover;
      if (recovery) {
        if (recovery.target.nodeId !== input.nodeId)
          throw new Error("Finish the pending command handover first.");
        return await this.completeHandover(recovery);
      }
      if (this.isLeaf()) {
        throw new NodeRefusalError(
          NODE_REFUSAL_CODES.nodeIsSubordinate,
          "This node is controlled by another command node. Hand over from there.",
        );
      }
      const { target, link } = await this.handoverTarget(input.nodeId);
      const targetNodes = await link.invoke<NodeListResult>("list_nodes");
      const targetIds = new Set(targetNodes.nodes.map((node) => node.nodeId));
      const selfId = await this.self();
      const registry = await this.currentRegistry();
      const chosen =
        input.nodeIds === undefined
          ? null
          : Array.isArray(input.nodeIds) && input.nodeIds.every(isBackendId)
            ? new Set<BackendId>(input.nodeIds)
            : (() => {
                throw new Error("Expected nodeIds to be node identities.");
              })();
      const moving = registry.nodes.filter(
        (node) =>
          node.nodeId !== target.nodeId &&
          (((chosen === null || chosen.has(node.nodeId)) && remoteRoutes(node.routes).length > 0) ||
            targetIds.has(node.nodeId)),
      );
      const entries: NodeImportEntry[] = moving
        .filter((node) => remoteRoutes(node.routes).length > 0)
        .map((node) => handoverEntry(node));
      const self = input.includeSelf ? await this.selfEntry() : null;
      if (self) entries.push(self);
      for (const entry of input.entries) {
        const id = entry.verifiedNodeId;
        if (id === target.nodeId || id === selfId) continue;
        if (id && entries.some((existing) => existing.verifiedNodeId === id)) continue;
        entries.push(entry);
      }
      const incomingIds = new Set(
        entries.map((entry) => entry.verifiedNodeId ?? `provisional:${entry.importedFrom}`),
      );
      incomingIds.delete(target.nodeId);
      for (const id of targetIds) incomingIds.delete(id);
      if (
        entries.length > MAX_REGISTERED_NODES ||
        targetNodes.nodes.length + incomingIds.size > MAX_REGISTERED_NODES
      ) {
        throw new NodeRefusalError(
          NODE_REFUSAL_CODES.tooManyNodes,
          "The target has no room for all of these machines.",
        );
      }
      const pending: PendingCommandHandover = {
        id: crypto.randomUUID(),
        target,
        entries,
        movingIds: moving.map((node) => node.nodeId),
        selfIncluded: self !== null || targetIds.has(selfId),
      };
      // Retain the actual authenticated transport, including an interactive SSH lease.
      const transport = link.retainTransport();
      try {
        await this.allowController(target.nodeId);
        await this.mutateRegistry((current) => ({
          next: {
            ...current,
            pendingHandover: pending,
            nodes: current.nodes.filter((node) => node.nodeId !== target.nodeId),
          },
          result: undefined,
        }));
        return await this.completeHandover(pending, transport);
      } finally {
        transport.release();
      }
    } finally {
      this.handoverRunning = false;
    }
  }

  private async completeHandover(
    pending: PendingCommandHandover,
    transport?: ReturnType<NodeLink["retainTransport"]>,
  ): Promise<CommandHandoverResult> {
    const { target, entries } = pending;
    const selfId = await this.self();
    const handoverLink = this.oneShotLink(target);
    const invoke = () =>
      transport
        ? transport.invoke<CommandHandoverReceipt>(
            "accept_command_handover",
            { controllerId: selfId, handoverId: pending.id, entries },
            { timeoutMs: HANDOVER_TIMEOUT_MS },
          )
        : handoverLink.invokeWithoutAttaching<CommandHandoverReceipt>(
            "accept_command_handover",
            { controllerId: selfId, handoverId: pending.id, entries },
            { timeoutMs: HANDOVER_TIMEOUT_MS },
          );
    let accepted: CommandHandoverReceipt;
    try {
      try {
        accepted = await invoke();
      } catch (error) {
        // Only these refusals prove adoption never committed. Other failures can
        // occur after persistence or during controller detach; keep the journal.
        if (error instanceof NodeRefusalError && error.code === NODE_REFUSAL_CODES.tooManyNodes) {
          await this.mutateRegistry((current) => ({
            next: {
              ...current,
              pendingHandover: undefined,
              nodes: current.nodes.some((node) => node.nodeId === target.nodeId)
                ? current.nodes
                : [...current.nodes, target],
            },
            result: undefined,
          }));
          throw error;
        }
        if (error instanceof NodeRefusalError && error.code === NODE_REFUSAL_CODES.notController) {
          await this.mutateRegistry((current) => ({
            next: { ...current, pendingHandover: undefined },
            result: undefined,
          }));
          throw error;
        }
        // Same durable ID resumes partial acceptance and lost responses safely.
        try {
          accepted = await invoke();
        } catch (cause) {
          throw new NodeOutcomeUnknownError(
            "The command handover is pending and will retry automatically. Retrying this handover is safe.",
            { cause },
          );
        }
      }
    } finally {
      handoverLink.stop();
    }
    // The machines the target took over are forgotten here and told to
    // detach, so each has one command node.
    const movingIds = new Set(pending.movingIds);
    const detaching = await this.mutateRegistry((current) => {
      const forgotten = current.nodes.filter((node) => movingIds.has(node.nodeId));
      const attached = forgotten.filter((node) => node.attachment.status === "attached");
      const forgottenAt = new Date(this.now()).toISOString();
      return {
        next: {
          ...current,
          pendingHandover: undefined,
          nodes: current.nodes.filter((node) => !movingIds.has(node.nodeId)),
          tombstones: [
            ...current.tombstones.filter((entry) => !movingIds.has(entry.nodeId)),
            ...attached.map((node) => ({
              nodeId: node.nodeId,
              routes: node.routes,
              routeOrder: node.routeOrder,
              credential: node.credential,
              forgottenAt,
            })),
          ],
        },
        result: attached.map((node) => node.nodeId),
      };
    });
    for (const nodeId of detaching) void this.detachTombstone(nodeId);
    return {
      targetNodeId: target.nodeId,
      transferred: accepted.imported,
      skipped: accepted.skipped,
      needsCredential: accepted.needsCredential,
      selfIncluded: pending.selfIncluded,
      detachedControllers: accepted.detachedControllers,
    };
  }

  /**
   * Receiving side of a handover: an attached command node makes this node
   * the command node. The machines it sends are registered first, then every
   * command node controlling this one is detached, as if by the user here, so
   * none re-attaches by itself. The caller, if it sent itself, becomes a leaf.
   */
  async acceptHandover(
    controllerId: unknown,
    entries: NodeImportEntry[],
    handoverId?: unknown,
  ): Promise<{
    imported: number;
    skipped: number;
    needsCredential: number;
    detachedControllers: number;
  }> {
    if (this.acceptingHandover)
      throw new Error("A command handover is already being accepted. Retry shortly.");
    if (
      handoverId !== undefined &&
      (typeof handoverId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(handoverId))
    )
      throw new Error("Invalid handover ID.");
    this.acceptingHandover = true;
    try {
      const receipt = (await this.currentRegistry()).handoverReceipts?.find(
        (entry) => entry.id === handoverId && entry.controllerId === controllerId,
      );
      if (
        !isBackendId(controllerId) ||
        (!receipt &&
          !this.attachments.controllers.some((entry) => entry.controllerId === controllerId))
      ) {
        throw new NodeRefusalError(
          NODE_REFUSAL_CODES.notController,
          "Only a command node attached to this node can make it the command node.",
        );
      }
      if (receipt?.completed) return receipt;
      const controllers =
        receipt?.controllers ?? this.attachments.controllers.map((entry) => entry.controllerId);
      const counts =
        receipt ??
        (await this.adoptEntries(
          entries,
          "handover",
          typeof handoverId === "string"
            ? {
                id: handoverId,
                controllerId,
                controllers,
                detachedControllers: controllers.length,
              }
            : undefined,
        ));
      for (const id of controllers) {
        if (this.attachments.controllers.some((entry) => entry.controllerId === id))
          await this.detachController(id, { byUser: true });
      }
      const registry = await this.currentRegistry();
      for (const id of controllers) {
        if (registry.nodes.some((node) => node.nodeId === id)) await this.allowController(id);
      }
      if (handoverId !== undefined)
        await this.mutateRegistry((current) => ({
          next: {
            ...current,
            handoverReceipts: current.handoverReceipts?.map((entry) =>
              entry.id === handoverId && entry.controllerId === controllerId
                ? { ...entry, completed: true }
                : entry,
            ),
          },
          result: undefined,
        }));
      return { ...counts, detachedControllers: controllers.length };
    } finally {
      this.acceptingHandover = false;
    }
  }

  private async handoverTarget(nodeId: unknown): Promise<{ target: NodeRecord; link: NodeLink }> {
    const registry = await this.currentRegistry();
    const target = registry.nodes.find((node) => node.nodeId === nodeId);
    if (!target) {
      throw new NodeRefusalError(NODE_REFUSAL_CODES.unknownNode, "That node is not registered.");
    }
    const link = this.links.get(target.nodeId);
    if (!link?.connected) {
      const name = this.view(target).displayName;
      // A refusal names what to fix; "connect first" would only send the user in circles.
      const refusal = link?.view.lastError;
      throw new Error(
        refusal
          ? `${name} is not connected to this command node: ${refusal.message}`
          : `${name} is not connected. Connect to it first.`,
      );
    }
    return { target, link };
  }

  /** This node as a machine another node can control, when it has an address and token. */
  private async selfEntry(): Promise<NodeImportEntry | null> {
    const access = await this.options.selfAccess?.().catch(() => null);
    if (!access?.token) return null;
    const origins = [...new Set(access.origins.map(originOf).filter(isRemoteHttps))];
    if (origins.length === 0) return null;
    const routes: NodeRoute[] = origins.map((origin, index) => ({
      id: `self-${index + 1}` as RouteId,
      kind: "https",
      enabled: true,
      origin,
    }));
    const profile = await this.storage.getBackendProfile();
    const selfId = await this.self();
    return {
      importedFrom: `handover:${selfId}`,
      fallbackName: profile.displayName,
      verifiedNodeId: selfId,
      routes,
      routeOrder: routes.map((route) => route.id),
      token: access.token,
      enabled: true,
      profileCache: {
        displayName: profile.displayName,
        colorToken: profile.colorToken,
        revision: profile.revision,
      },
    };
  }

  /** First-use host-key review for an SSH route, before any credential is offered. */
  async probeHostKey(args: Record<string, unknown>) {
    const ssh = this.probeProvider();
    if (!ssh?.probeHostKey) throw new Error("SSH routes are not available on this node.");
    const routes = parseNodeRoutes([
      {
        id: "host-key-probe",
        kind: "ssh",
        destination: args.destination,
        ...(args.sshPort === undefined ? {} : { sshPort: args.sshPort }),
        remoteGatewayPort: 1,
      },
    ]);
    const route = routes[0];
    if (!route || route.kind !== "ssh") throw new Error("Expected an SSH route.");
    const result = await ssh.probeHostKey({
      routeId: "host-key-probe",
      destination: route.destination,
      ...(route.sshPort ? { sshPort: route.sshPort } : {}),
      remoteGatewayPort: 1,
    });
    return {
      probeId: result.probeId,
      destination: result.destination,
      fingerprints: result.fingerprints.map((entry) => ({
        type: entry.keyType,
        fingerprint: entry.fingerprint,
      })),
    };
  }

  async trustHostKey(probeId: unknown): Promise<{ added: number }> {
    if (typeof probeId !== "string" || !probeId) throw new Error("Expected probeId.");
    const ssh = this.probeProvider();
    if (!ssh?.trustHostKey) throw new Error("SSH routes are not available on this node.");
    return ssh.trustHostKey({ probeId });
  }

  answerSshPrompt(args: Record<string, unknown>): { answered: boolean } {
    if (typeof args.promptId !== "string") throw new Error("Expected promptId.");
    const answer =
      args.cancel === true ? null : typeof args.answer === "string" ? args.answer : null;
    if (answer !== null && answer.length > 4096) throw new Error("The answer is too long.");
    return { answered: this.prompts.answer(args.promptId, answer) };
  }

  /*
   * Internals
   */

  private async self(): Promise<BackendId> {
    if (this.selfId) return this.selfId;
    const identity = await this.storage.getPreviewBackendIdentity();
    if (!isBackendId(identity.instanceId)) throw new Error("This backend has no valid identity.");
    this.selfId = identity.instanceId;
    return this.selfId;
  }

  private async currentRegistry(): Promise<NodeRegistry> {
    this.registry ??= await this.storage.getNodeRegistry();
    return this.registry;
  }

  private async mutateRegistry<T>(
    mutate: (current: NodeRegistry) => NodeStoreMutation<NodeRegistry, T>,
    beforeApply?: () => void,
  ): Promise<T> {
    let written: NodeRegistry | null = null;
    const result = await this.storage.mutateNodeRegistry((current) => {
      const outcome = mutate(current);
      written = outcome.next ? { ...outcome.next, revision: current.revision + 1 } : null;
      return outcome;
    });
    if (written) {
      this.registry = written;
      beforeApply?.();
      this.applyMode();
      this.publishNodes();
    }
    return result;
  }

  private async assertCanRegister(): Promise<NodeRegistry> {
    const registry = await this.currentRegistry();
    if (this.isLeaf()) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.nodeIsSubordinate,
        "This node is attached to a command node, so it is in leaf mode and cannot register nodes. Only two levels are allowed.",
      );
    }
    if (!this.registrationEnabled(registry)) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.registrationDisabled,
        "Allow this machine to command others in Settings → Machines first.",
      );
    }
    return registry;
  }

  private async assertRegistrable(nodeId: BackendId): Promise<void> {
    if (nodeId === (await this.self())) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.selfAttach,
        "That route reaches this node itself.",
      );
    }
    if (this.attachments.controllers.some((controller) => controller.controllerId === nodeId)) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.controllerIsSubordinate,
        "That node commands this node. Only two levels are allowed.",
      );
    }
    const registry = await this.currentRegistry();
    if (registry.nodes.some((node) => node.nodeId === nodeId)) {
      throw new NodeRefusalError(
        NODE_REFUSAL_CODES.duplicateNode,
        "That node is already registered.",
      );
    }
  }

  /** Learn and verify a new node's identity over the first route that answers. */
  private async identify(
    routes: NodeRoute[],
    routeOrder: RouteId[],
    token: string,
  ): Promise<BackendHello> {
    const ordered = normalizeRouteOrder(routes, routeOrder)
      .map((id) => routes.find((route) => route.id === id))
      .filter((route): route is NodeRoute => route !== undefined && route.enabled);
    let lastError: unknown = new Error("No route is enabled.");
    for (const route of ordered) {
      const ssh = this.probeProvider();
      let opened: Awaited<ReturnType<typeof openRoute>> | null = null;
      try {
        opened = await openRoute(route, { interactive: true, ssh });
        const outcome = await checkBackendRoute(opened.baseUrl, token, {
          timeoutMs: NODE_HELLO_TIMEOUT_MS,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
        if (outcome.kind !== "hello") {
          throw new NodeRefusalError(
            NODE_REFUSAL_CODES.needsUpdate,
            "This node runs an Orkestrator version without command nodes. Update it first.",
          );
        }
        if (outcome.hello.endpointRole !== "client") {
          throw new Error("The route reaches the node's control listener. Use a client endpoint.");
        }
        if (!outcome.hello.capabilities["node-attachment"]) {
          throw new NodeRefusalError(
            NODE_REFUSAL_CODES.needsUpdate,
            "This node runs an Orkestrator version without command nodes. Update it first.",
          );
        }
        return outcome.hello;
      } catch (error) {
        if (error instanceof NodeRefusalError) throw error;
        const classified = classifyRouteFailure(error);
        // Trust failures and rejected tokens are never bypassed via another route.
        if (classified.quarantine || classified.state === "authentication-required") {
          throw new Error(classified.message, { cause: error });
        }
        lastError = error;
      } finally {
        opened?.release();
      }
    }
    throw lastError instanceof Error
      ? new Error(classifyRouteFailure(lastError).message, { cause: lastError })
      : new Error("No route reached the node.");
  }

  private createLink(record: NodeRecord): NodeLink {
    const nodeId = record.nodeId;
    const link = new NodeLink(record, {
      selfId: this.selfId!,
      attachInfo: async () => ({
        displayName: (await this.storage.getBackendProfile()).displayName,
        portalOrigins: this.options.portalOrigins?.() ?? [],
      }),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ssh: this.sshFor(nodeId),
      ...(this.options.timers ? { timers: this.options.timers } : {}),
      ...(this.options.heartbeatMs ? { heartbeatMs: this.options.heartbeatMs } : {}),
      onChange: () => {
        this.publishNodes();
        this.syncSettingsTo(link);
      },
      onVerified: (update) => void this.recordVerified(link.nodeId, update),
      onIdentity: (installationId) => this.adoptIdentity(link.nodeId, installationId),
    });
    return link;
  }

  private async recordVerified(
    nodeId: BackendId,
    update: { hello: BackendHello; attachment: NodeRecord["attachment"]; connectedAt: string },
  ): Promise<void> {
    try {
      await this.mutateRegistry((registry) => {
        const node = registry.nodes.find((entry) => entry.nodeId === nodeId);
        if (!node) return { next: null, result: undefined };
        const profile = update.hello.profile;
        const updated: NodeRecord = {
          ...node,
          attachment: update.attachment,
          profileCache: {
            displayName: profile.displayName,
            colorToken: profile.colorToken,
            revision: profile.revision,
          },
          ...(update.attachment.status === "attached"
            ? { lastConnectedAt: update.connectedAt }
            : {}),
        };
        if (JSON.stringify(updated) === JSON.stringify(node))
          return { next: null, result: undefined };
        return {
          next: {
            ...registry,
            nodes: registry.nodes.map((entry) => (entry.nodeId === nodeId ? updated : entry)),
          },
          result: undefined,
        };
      });
    } catch (error) {
      console.warn("[nodes] Could not record a node verification:", errorCode(error));
    }
  }

  /**
   * A node's profile changed while connected: cache it now rather than on
   * the next hello, so every view shows the new name and colour. An older
   * revision than the cached one changes nothing.
   */
  async recordProfile(nodeId: BackendId, profile: BackendProfile): Promise<void> {
    try {
      await this.mutateRegistry((registry) => {
        const node = registry.nodes.find((entry) => entry.nodeId === nodeId);
        const cached = node?.profileCache;
        if (!node || (cached && cached.revision > profile.revision)) {
          return { next: null, result: undefined };
        }
        if (
          cached &&
          cached.revision === profile.revision &&
          cached.displayName === profile.displayName &&
          cached.colorToken === profile.colorToken
        ) {
          return { next: null, result: undefined };
        }
        const updated: NodeRecord = {
          ...node,
          profileCache: {
            displayName: profile.displayName,
            colorToken: profile.colorToken,
            revision: profile.revision,
          },
        };
        return {
          next: {
            ...registry,
            nodes: registry.nodes.map((entry) => (entry.nodeId === nodeId ? updated : entry)),
          },
          result: undefined,
        };
      });
    } catch (error) {
      console.warn("[nodes] Could not record a node profile:", errorCode(error));
    }
  }

  /** A migrated record without a verified identity takes the one its hello proved. */
  private async adoptIdentity(
    provisionalId: BackendId,
    installationId: BackendId,
  ): Promise<"adopted" | "refused"> {
    const selfId = await this.self();
    if (installationId === selfId) return "refused";
    if (this.attachments.controllers.some((entry) => entry.controllerId === installationId)) {
      return "refused";
    }
    const adopted = await this.mutateRegistry(
      (registry) => {
        if (registry.nodes.some((node) => node.nodeId === installationId)) {
          return { next: null, result: false };
        }
        const node = registry.nodes.find((entry) => entry.nodeId === provisionalId);
        if (!node) return { next: null, result: false };
        return {
          next: {
            ...registry,
            nodes: registry.nodes.map((entry) =>
              entry.nodeId === provisionalId ? { ...entry, nodeId: installationId } : entry,
            ),
          },
          result: true,
        };
      },
      () => {
        const link = this.links.get(provisionalId);
        if (link) {
          this.links.delete(provisionalId);
          this.links.set(installationId, link);
          link.adoptIdentity(installationId);
        }
      },
    );
    return adopted ? "adopted" : "refused";
  }

  private sshFor(nodeId: BackendId): SshTunnelProvider | null {
    if (!this.sshProviders.has(nodeId)) {
      this.sshProviders.set(
        nodeId,
        this.options.createSsh?.((prompt) => this.prompts.ask(nodeId, prompt)) ?? null,
      );
    }
    return this.sshProviders.get(nodeId) ?? null;
  }

  private probeProvider(): SshTunnelProvider | null {
    if (this.probeSsh === undefined) {
      this.probeSsh =
        this.options.createSsh?.((prompt) =>
          this.prompts.ask("host-key-probe" as BackendId, prompt),
        ) ?? null;
    }
    return this.probeSsh;
  }

  private view(node: NodeRecord): NodeView {
    const link = this.links.get(node.nodeId);
    const connection = link?.view ?? {
      state: this.isLeaf() ? ("suspended" as const) : ("connecting" as const),
      epoch: 0,
    };
    const view: NodeView = {
      nodeId: node.nodeId,
      enabled: node.enabled,
      displayName: node.profileCache?.displayName ?? node.fallbackName,
      fallbackName: node.fallbackName,
      routes: node.routes.map((route) => ({ ...route })),
      routeOrder: [...node.routeOrder],
      hasCredential: node.credential !== null,
      attachment: { ...node.attachment },
      connection,
      addedAt: node.addedAt,
      source: node.source,
    };
    if (node.profileCache?.colorToken) view.colorToken = node.profileCache.colorToken;
    if (node.lastConnectedAt) view.lastConnectedAt = node.lastConnectedAt;
    return view;
  }

  private publishNodes(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.emit(NODES_CHANGED_EVENT, { revision: this.registry?.revision ?? 0 });
      for (const listener of this.changeListeners) {
        try {
          listener();
        } catch {
          // A listener's failure never affects the registry.
        }
      }
    });
  }

  private emitStatus(): void {
    void this.status().then((status) => this.emit(NODE_STATUS_CHANGED_EVENT, status));
  }

  /** Confirm the detach of a forgotten node; keep its tombstone until it answers. */
  private async detachTombstone(nodeId: BackendId): Promise<boolean> {
    const registry = await this.currentRegistry();
    const entry = registry.tombstones.find((tombstone) => tombstone.nodeId === nodeId);
    if (!entry) return false;
    if (!entry.credential) {
      await this.discardPendingDetach(nodeId);
      return false;
    }
    const selfId = await this.self();
    const detachLink = this.oneShotLink({
      nodeId,
      routes: entry.routes,
      routeOrder: entry.routeOrder,
      credential: entry.credential,
      addedAt: entry.forgottenAt,
    });
    try {
      await detachLink.invokeWithoutAttaching("detach_controller", { controllerId: selfId });
      await this.discardPendingDetach(nodeId);
      return true;
    } catch (error) {
      console.warn("[nodes] A forgotten node has not confirmed the detach yet:", errorCode(error));
      return false;
    } finally {
      detachLink.stop();
    }
  }

  /** A link for one request to a node outside the registry's links; it never attaches. */
  private oneShotLink(
    node: Pick<NodeRecord, "nodeId" | "routes" | "routeOrder" | "credential" | "addedAt">,
  ): NodeLink {
    return new NodeLink(
      {
        nodeId: node.nodeId,
        enabled: true,
        routes: node.routes,
        routeOrder: node.routeOrder,
        credential: node.credential,
        fallbackName: node.nodeId,
        attachment: { status: "attached" },
        addedAt: node.addedAt,
        source: "portal",
      },
      {
        selfId: this.selfId!,
        attachInfo: async () => ({ displayName: "", portalOrigins: [] }),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ssh: this.sshFor(node.nodeId),
        onChange: () => undefined,
        onVerified: () => undefined,
      },
    );
  }

  private async retryDetaches(): Promise<void> {
    if (!this.started) return;
    const registry = await this.currentRegistry();
    // Detach cleanup remains valid while leaf; it cannot attach new controllers.
    for (const entry of registry.tombstones) await this.detachTombstone(entry.nodeId);
    if (registry.pendingHandover && !this.handoverRunning) {
      this.handoverRunning = true;
      try {
        await this.completeHandover(registry.pendingHandover);
      } catch (error) {
        console.warn("[nodes] Command handover recovery pending:", errorCode(error));
      } finally {
        this.handoverRunning = false;
      }
    }
    if (!this.started) return;
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => void this.retryDetaches(), DETACH_RETRY_MS);
    this.detachTimer.unref?.();
  }
}

/** A registry entry as the new command node receives it. */
function handoverEntry(node: NodeRecord): NodeImportEntry {
  const routes = remoteRoutes(node.routes);
  const entry: NodeImportEntry = {
    importedFrom: `handover:${node.nodeId}`,
    fallbackName: node.fallbackName,
    routes,
    routeOrder: normalizeRouteOrder(routes, node.routeOrder),
    token: node.credential?.token ?? null,
    enabled: node.enabled,
  };
  if (!isProvisionalBackendId(node.nodeId)) entry.verifiedNodeId = node.nodeId;
  if (node.profileCache) entry.profileCache = node.profileCache;
  return entry;
}

/** Routes that mean the same machine from anywhere: not loopback addresses of this one. */
function remoteRoutes(routes: NodeRoute[]): NodeRoute[] {
  return routes
    .filter((route) => route.kind !== "https" || isRemoteHttps(route.origin))
    .map((route) => {
      if (route.kind !== "ssh") return route;
      const { identityFile: _identityFile, ...portable } = route;
      return portable;
    });
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isRemoteHttps(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function describeFirstRoute(routes: NodeRoute[]): string {
  const route = routes[0];
  if (!route) return "Node";
  if (route.kind === "https") return new URL(route.origin).hostname.slice(0, 64);
  return route.destination.replace(/^.*@/, "").slice(0, 64);
}

/** A code-only description of an error for logs: never a message that could echo input. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code.slice(0, 64);
  return error instanceof Error ? error.name : "unknown";
}
