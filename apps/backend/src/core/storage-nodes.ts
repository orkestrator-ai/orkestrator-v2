import type { NodeAttachments, NodeRegistry } from "@orkestrator/protocol/command-nodes";
import {
  parseControllerSettingsStore,
  type ControllerSettingsStore,
} from "@orkestrator/protocol/controller-settings";
import {
  parsePortalLayout,
  type PortalLayout,
  type PortalLayoutUpdate,
} from "@orkestrator/protocol/portal-layout";

import { readStoredNodeAttachments, readStoredNodeRegistry } from "./nodes/node-store-format.js";
import type { StorageContext } from "./storage-context.js";

/** Result of a registry or attachment mutation: `next: null` writes nothing. */
export interface NodeStoreMutation<TStore, TResult> {
  next: TStore | null;
  result: TResult;
}

/**
 * Command-node stores.
 *
 * - `node-registry` (command node): the nodes this backend controls, with
 *   their routes and gateway credentials. Written only through the
 *   sensitive writer; credentials never leave the backend (see
 *   `nodes/node-views.ts` for the client projection).
 * - `node-attachments` (leaf): the command nodes attached to this backend
 *   and when each last contacted it. No credentials.
 */
/**
 * Where a leaf agent's mail goes when a command node's coordinator should get
 * it (see `nodes/node-mail.ts`). Set by the backend; absent in fixtures.
 */
export interface NodeMailRouter {
  route(input: {
    fromEnvironmentId: string;
    fromTabId?: string;
    toEnvironmentId: string;
    replyToMessageId?: string;
  }): Promise<{ controllerId: string; controllerName?: string } | null>;
  enqueue(
    destination: { controllerId: string },
    item: {
      requestId: string;
      fromEnvironmentId: string;
      fromTabId: string;
      subject?: string;
      body: string;
    },
  ): Promise<{ seq: number }>;
}

export class NodesRepository {
  constructor(private readonly context: StorageContext) {}

  private reportedDroppedNodes = false;
  /** Leaf → command node mail routing; consulted by the agent mail tools. */
  nodeMailRouter: NodeMailRouter | null = null;

  private nodeRegistryFile(): string {
    return this.context.file("node-registry.json");
  }

  private nodeAttachmentsFile(): string {
    return this.context.file("node-attachments.json");
  }

  private nodeSummariesFile(): string {
    return this.context.file("node-summaries.json");
  }

  private nodeOutcomesFile(): string {
    return this.context.file("node-outcomes.json");
  }

  private portalLayoutFile(): string {
    return this.context.file("portal-layout.json");
  }

  private controllerSettingsFile(): string {
    return this.context.file("controller-settings.json");
  }

  /** Leaf: the settings each attached command node handed down (no credentials). */
  async getControllerSettings(): Promise<ControllerSettingsStore> {
    return parseControllerSettingsStore(
      await this.context.loadJson<unknown>(this.controllerSettingsFile(), () => null),
    );
  }

  async mutateControllerSettings<T>(
    mutate: (current: ControllerSettingsStore) => NodeStoreMutation<ControllerSettingsStore, T>,
  ): Promise<T> {
    return this.context.serialize(
      this.controllerSettingsFile(),
      "controller settings",
      async () => {
        const current = parseControllerSettingsStore(
          await this.context.loadJson<unknown>(this.controllerSettingsFile(), () => null),
        );
        const { next, result } = mutate(structuredClone(current));
        if (next)
          await this.context.saveJson(this.controllerSettingsFile(), { ...next, version: 1 });
        return result;
      },
    );
  }

  /** The portal sidebar's cross-machine order (see `@orkestrator/protocol/portal-layout`). */
  async getPortalLayout(): Promise<PortalLayout> {
    return parsePortalLayout(
      await this.context.loadJson<unknown>(this.portalLayoutFile(), () => null),
    );
  }

  /** Replaces the given fields; the revision advances on every write. */
  async updatePortalLayout(update: PortalLayoutUpdate): Promise<PortalLayout> {
    return this.context.serialize(this.portalLayoutFile(), "portal layout", async () => {
      const current = parsePortalLayout(
        await this.context.loadJson<unknown>(this.portalLayoutFile(), () => null),
      );
      const next: PortalLayout = { ...current, ...update, revision: current.revision + 1 };
      await this.context.saveJson(this.portalLayoutFile(), { version: 1, ...next });
      return next;
    });
  }

  /** Last-known portal summaries of other nodes (names and states only). */
  async loadNodeSummariesCache(): Promise<unknown> {
    return this.context.loadJson<unknown>(this.nodeSummariesFile(), () => null);
  }

  async saveNodeSummariesCache(value: unknown): Promise<void> {
    await this.context.serialize(this.nodeSummariesFile(), "node summaries", () =>
      this.context.saveJson(this.nodeSummariesFile(), value, { backup: false }),
    );
  }

  private nodeMailFile(): string {
    return this.context.file("node-mail.json");
  }

  private nodeActionRequestsFile(): string {
    return this.context.file("node-action-requests.json");
  }

  /** Leaf mail state: environment origins, coordinator threads and the outbox. Sensitive (mail bodies). */
  async loadNodeMail(): Promise<unknown> {
    return this.context.loadJson<unknown>(this.nodeMailFile(), () => null);
  }

  async mutateNodeMail<T>(mutate: (current: unknown) => { next: unknown; result: T }): Promise<T> {
    return this.context.serialize(this.nodeMailFile(), "node mail", async () => {
      const current = await this.context.loadJson<unknown>(this.nodeMailFile(), () => null);
      const { next, result } = mutate(current);
      if (next !== null && next !== undefined)
        await this.context.saveSensitiveJson(this.nodeMailFile(), next);
      return result;
    });
  }

  async loadNodeActionRequests(): Promise<unknown> {
    const value = await this.context.loadJson<unknown>(this.nodeActionRequestsFile(), () => null);
    return (value as { requests?: unknown } | null)?.requests ?? null;
  }

  async saveNodeActionRequests(requests: unknown): Promise<void> {
    await this.context.serialize(this.nodeActionRequestsFile(), "node action requests", () =>
      this.context.saveJson(this.nodeActionRequestsFile(), { version: 1, requests }),
    );
  }

  /** Outcome-unknown records of routed writes, kept until the user dismisses them. */
  async loadNodeOutcomes(): Promise<unknown> {
    const value = await this.context.loadJson<unknown>(this.nodeOutcomesFile(), () => null);
    return (value as { records?: unknown } | null)?.records ?? null;
  }

  async saveNodeOutcomes(records: unknown): Promise<void> {
    await this.context.serialize(this.nodeOutcomesFile(), "node outcomes", () =>
      this.context.saveJson(this.nodeOutcomesFile(), { version: 1, records }),
    );
  }

  async getNodeRegistry(): Promise<NodeRegistry> {
    return this.readNodeRegistry();
  }

  /**
   * Serialized read-modify-write of the registry. The revision advances on
   * every write.
   */
  async mutateNodeRegistry<T>(
    mutate: (current: NodeRegistry) => NodeStoreMutation<NodeRegistry, T>,
  ): Promise<T> {
    return this.context.serialize(this.nodeRegistryFile(), "node registry", async () => {
      const current = await this.readNodeRegistry();
      const { next, result } = mutate(structuredClone(current));
      if (next) {
        await this.context.saveSensitiveJson(this.nodeRegistryFile(), {
          ...next,
          version: 1,
          revision: current.revision + 1,
        });
      }
      return result;
    });
  }

  async getNodeAttachments(): Promise<NodeAttachments> {
    return readStoredNodeAttachments(
      await this.context.loadJson<unknown>(this.nodeAttachmentsFile(), () => null),
    );
  }

  async mutateNodeAttachments<T>(
    mutate: (current: NodeAttachments) => NodeStoreMutation<NodeAttachments, T>,
  ): Promise<T> {
    return this.context.serialize(this.nodeAttachmentsFile(), "node attachments", async () => {
      const current = readStoredNodeAttachments(
        await this.context.loadJson<unknown>(this.nodeAttachmentsFile(), () => null),
      );
      const { next, result } = mutate(structuredClone(current));
      if (next) await this.context.saveJson(this.nodeAttachmentsFile(), { ...next, version: 1 });
      return result;
    });
  }

  private async readNodeRegistry(): Promise<NodeRegistry> {
    const { registry, dropped } = readStoredNodeRegistry(
      await this.context.loadJson<unknown>(this.nodeRegistryFile(), () => null),
    );
    if (dropped > 0 && !this.reportedDroppedNodes) {
      this.reportedDroppedNodes = true;
      console.warn(`[backend] Ignored ${dropped} unreadable node registry entries`);
    }
    return registry;
  }
}

/**
 * Command-node state: controller settings, portal layout, the node registry and attachments, and the node mail, action and outcome stores: what callers reach as `storage.nodes`.
 *
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to, like a public method of `StorageService`. Add a
 * method here only when code outside the storage files calls it.
 */
export type NodesStorage = Pick<
  NodesRepository,
  | "getControllerSettings"
  | "mutateControllerSettings"
  | "getPortalLayout"
  | "updatePortalLayout"
  | "loadNodeSummariesCache"
  | "saveNodeSummariesCache"
  | "loadNodeMail"
  | "mutateNodeMail"
  | "loadNodeActionRequests"
  | "saveNodeActionRequests"
  | "loadNodeOutcomes"
  | "saveNodeOutcomes"
  | "getNodeRegistry"
  | "mutateNodeRegistry"
  | "getNodeAttachments"
  | "mutateNodeAttachments"
>;
