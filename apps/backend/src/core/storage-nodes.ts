import type { NodeAttachments, NodeRegistry } from "@orkestrator/protocol/command-nodes";

import { readStoredNodeAttachments, readStoredNodeRegistry } from "./nodes/node-store-format.js";
import { StoragePreviewServices } from "./storage-preview-services.js";

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
export class StorageNodes extends StoragePreviewServices {
  private reportedDroppedNodes = false;

  protected nodeRegistryFile(): string {
    return this.file("node-registry.json");
  }

  protected nodeAttachmentsFile(): string {
    return this.file("node-attachments.json");
  }

  protected nodeSummariesFile(): string {
    return this.file("node-summaries.json");
  }

  protected nodeOutcomesFile(): string {
    return this.file("node-outcomes.json");
  }

  /** Last-known portal summaries of other nodes (names and states only). */
  async loadNodeSummariesCache(): Promise<unknown> {
    return this.loadJson<unknown>(this.nodeSummariesFile(), () => null);
  }

  async saveNodeSummariesCache(value: unknown): Promise<void> {
    await this.serializeMutation(this.nodeSummariesFile(), "node summaries", () =>
      this.saveJson(this.nodeSummariesFile(), value, { backup: false }),
    );
  }

  /** Outcome-unknown records of routed writes, kept until the user dismisses them. */
  async loadNodeOutcomes(): Promise<unknown> {
    const value = await this.loadJson<unknown>(this.nodeOutcomesFile(), () => null);
    return (value as { records?: unknown } | null)?.records ?? null;
  }

  async saveNodeOutcomes(records: unknown): Promise<void> {
    await this.serializeMutation(this.nodeOutcomesFile(), "node outcomes", () =>
      this.saveJson(this.nodeOutcomesFile(), { version: 1, records }),
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
    return this.serializeMutation(this.nodeRegistryFile(), "node registry", async () => {
      const current = await this.readNodeRegistry();
      const { next, result } = mutate(structuredClone(current));
      if (next) {
        await this.saveSensitiveJson(this.nodeRegistryFile(), {
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
      await this.loadJson<unknown>(this.nodeAttachmentsFile(), () => null),
    );
  }

  async mutateNodeAttachments<T>(
    mutate: (current: NodeAttachments) => NodeStoreMutation<NodeAttachments, T>,
  ): Promise<T> {
    return this.serializeMutation(this.nodeAttachmentsFile(), "node attachments", async () => {
      const current = readStoredNodeAttachments(
        await this.loadJson<unknown>(this.nodeAttachmentsFile(), () => null),
      );
      const { next, result } = mutate(structuredClone(current));
      if (next) await this.saveJson(this.nodeAttachmentsFile(), { ...next, version: 1 });
      return result;
    });
  }

  private async readNodeRegistry(): Promise<NodeRegistry> {
    const { registry, dropped } = readStoredNodeRegistry(
      await this.loadJson<unknown>(this.nodeRegistryFile(), () => null),
    );
    if (dropped > 0 && !this.reportedDroppedNodes) {
      this.reportedDroppedNodes = true;
      console.warn(`[backend] Ignored ${dropped} unreadable node registry entries`);
    }
    return registry;
  }
}
