import { isDeepStrictEqual } from "node:util";

import {
  parseInheritedGlobalSettings,
  type ControllerSettingsStore,
  type InheritedGlobalSettings,
  type InheritedSettingsSource,
} from "@orkestrator/protocol/controller-settings";
import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";

import type { NodesStorage } from "../storage-nodes.js";

/**
 * Leaf side of inherited settings: the copy each attached command node sent,
 * and which one this node follows. The most recently changed copy among the
 * attached command nodes wins, so a change made on any command node reaches
 * the work on this leaf. See `@orkestrator/protocol/controller-settings`.
 */

export interface ControllerSettingsStorage {
  nodes: Pick<NodesStorage, "getControllerSettings" | "mutateControllerSettings">;
}

export interface LeafControllerSettingsOptions {
  storage: ControllerSettingsStorage;
  /** The display name of an attached command node, or `null` when it is not attached. */
  attachedName: (controllerId: BackendId) => string | null;
  /** The settings this node follows changed. */
  onChange: () => void;
  now: () => number;
}

export class LeafControllerSettings {
  private store: ControllerSettingsStore = { version: 1, entries: [] };

  private mutations: Promise<unknown> = Promise.resolve();

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(run);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  constructor(private readonly options: LeafControllerSettingsOptions) {}

  async start(): Promise<void> {
    this.store = await this.options.storage.nodes.getControllerSettings();
  }

  /** `sync_controller_settings` from an attached command node. */
  async receive(args: Record<string, unknown>): Promise<{ applied: boolean }> {
    return this.serialize(() => this.receiveSettings(args));
  }

  private async receiveSettings(args: Record<string, unknown>): Promise<{ applied: boolean }> {
    const controllerId = args.controllerId;
    if (!isBackendId(controllerId)) throw new Error("Expected controllerId to be a node identity.");
    if (this.options.attachedName(controllerId) === null) {
      throw new Error("That command node is not attached to this node.");
    }
    const settings = parseInheritedGlobalSettings(args.settings);
    const before = this.source();
    const changedAt = new Date(this.options.now()).toISOString();
    const changed = await this.options.storage.nodes.mutateControllerSettings((current) => {
      const existing = current.entries.find((entry) => entry.controllerId === controllerId);
      if (existing && isDeepStrictEqual(existing.settings, settings)) {
        return { next: null, result: { value: current, changed: false } };
      }
      const value: ControllerSettingsStore = {
        version: 1,
        entries: [
          ...current.entries.filter((entry) => entry.controllerId !== controllerId),
          { controllerId, settings, changedAt },
        ],
      };
      return { next: value, result: { value, changed: true } };
    });
    this.store = changed.value;
    if (changed.changed || !isDeepStrictEqual(before, this.source())) this.options.onChange();
    return { applied: this.source()?.controllerId === controllerId };
  }

  /**
   * A command node detached: its settings no longer apply here. The
   * attachment is already gone, so whatever this node follows now has
   * changed whenever that command node had sent settings.
   */
  async forget(controllerId: BackendId): Promise<void> {
    return this.serialize(() => this.forgetSettings(controllerId));
  }

  private async forgetSettings(controllerId: BackendId): Promise<void> {
    // The attachment is already gone. Publish the effective change even if
    // cleanup fails, and do not let a subsequent reattachment revive this copy.
    const hadEntry = this.store.entries.some((entry) => entry.controllerId === controllerId);
    this.store = {
      ...this.store,
      entries: this.store.entries.filter((entry) => entry.controllerId !== controllerId),
    };
    if (hadEntry) this.options.onChange();
    const removed = await this.options.storage.nodes.mutateControllerSettings((current) => {
      const entries = current.entries.filter((entry) => entry.controllerId !== controllerId);
      if (entries.length === current.entries.length) {
        return { next: null, result: { value: current, removed: false } };
      }
      const value: ControllerSettingsStore = { version: 1, entries };
      return { next: value, result: { value, removed: true } };
    });
    this.store = removed.value;
  }

  /** The settings this node follows, or `null` for its own. */
  current(): InheritedGlobalSettings | null {
    return this.followed()?.settings ?? null;
  }

  source(): InheritedSettingsSource | undefined {
    const entry = this.followed();
    if (!entry) return undefined;
    return {
      controllerId: entry.controllerId,
      displayName: this.options.attachedName(entry.controllerId) ?? "",
      changedAt: entry.changedAt,
    };
  }

  private followed(): ControllerSettingsStore["entries"][number] | null {
    let best: ControllerSettingsStore["entries"][number] | null = null;
    for (const entry of this.store.entries) {
      if (this.options.attachedName(entry.controllerId) === null) continue;
      if (!best || entry.changedAt >= best.changedAt) best = entry;
    }
    return best;
  }
}
