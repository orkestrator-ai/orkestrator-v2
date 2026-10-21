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
