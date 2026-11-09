import { AGENT_USAGE_READINGS_CHANGED_EVENT } from "@orkestrator/protocol/agent-account-shared-usage";
import {
  isNewerSharedUsageReading,
  newestSharedUsageReadings,
  parseSharedUsageReadings,
  parseUsageIdentities,
  SHARED_USAGE_LIMITS,
  usageIdentityKey,
  type SharedUsageReading,
  type UsageIdentity,
} from "@orkestrator/protocol/agent-account-shared-usage";
import {
  accountsClient,
  collectSharedUsageReadingsCommand,
} from "@orkestrator/protocol/contract/domains/accounts";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { linkDomainApi, type EnvelopeLink } from "./node-domain-clients.js";

const log = createLogger("nodes");

/**
 * The command node's side of shared usage readings
 * (docs/architecture/agent-accounts.md, "Shared readings").
 *
 * One pass, for this node and every connected node:
 *
 * 1. Collect each node's matchable logins and its newest reading of each
 *    (`collect_shared_usage_readings`), and this node's own central copy.
 * 2. Keep the newest reading per login identity (provider, email,
 *    organisation) in the central copy, which holds every identity, so a node
 *    that reconnects while the machine that took a reading is offline still
 *    gets it.
 * 3. Send each node the newest reading of every login it has, only where that
 *    is newer than what the node reported (`apply_shared_usage_readings`).
 *
 * A pass runs when a node (re)connects or resyncs, when a node announces a
 * reading it took itself (`agent-usage-readings-changed` with origin `local`),
 * when this node takes one (`noteLocalChange`), and once a minute. Passes are
 * debounced and never overlap; a trigger during a pass runs one more after
 * it. A node that predates the commands answers `unknown-command` and takes no
 * part; nothing it sends is kept unless it parses as a reading.
 */

export interface UsageSyncLink extends EnvelopeLink {
  readonly connected: boolean;
}

export interface NodeUsageSyncDeps {
  selfId(): Promise<string>;
  /** Whether this node is a command node now (a leaf or a standalone node has no one to share with). */
  isCommandNode(): boolean;
  link(nodeId: string): UsageSyncLink | null;
  /** The nodes this one controls that are connected. */
  connectedNodeIds(): Promise<string[]>;
  /** This node's own matchable logins. */
  ownIdentities(): Promise<UsageIdentity[]>;
  /** Every reading held centrally on this node. */
  central(): Promise<SharedUsageReading[]>;
  /** Keep each reading newer than the central copy's; answers how many were kept. */
  storeCentral(readings: SharedUsageReading[], ownIdentities: UsageIdentity[]): Promise<number>;
  now?(): number;
  debounceMs?: number;
}

export interface NodeUsageSyncPass {
  /** Readings newly kept centrally. */
  stored: number;
  /** Per node: readings sent, or why it took no part. */
  nodes: Array<{ nodeId: string; sent: number; state: "synced" | "unsupported" | "failed" }>;
}

/** A node's answer to a collect, once parsed. */
interface NodeHoldings {
  nodeId: string;
  identities: UsageIdentity[];
  readings: Map<string, SharedUsageReading>;
}

export class NodeUsageSync {
  private running: Promise<NodeUsageSyncPass> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: NodeUsageSyncDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** This node took a reading: share it once a burst of reads has settled. */
  noteLocalChange(): void {
    this.schedule();
  }

  /** Events from a node's stream, as the read model relays them. */
  handleNodeEvent(event: string, payload: unknown): void {
    if (event === "native-event-stream-connected" || event === "resync") {
      this.schedule();
      return;
    }
    if (event !== AGENT_USAGE_READINGS_CHANGED_EVENT) return;
    // A reading this node shared with it is already here; only its own counts.
    if ((payload as { origin?: unknown } | null)?.origin === "shared") return;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.timer || !this.deps.isCommandNode()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncAll();
    }, this.deps.debounceMs ?? 1_000);
    this.timer.unref?.();
  }

  /**
   * One pass now. Concurrent calls share a pass, and a call during a pass runs
   * one more after it, so nothing read meanwhile is missed.
   */
  syncAll(): Promise<NodeUsageSyncPass> {
    if (this.disposed || !this.deps.isCommandNode()) {
      return Promise.resolve({ stored: 0, nodes: [] });
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      let pass: NodeUsageSyncPass = { stored: 0, nodes: [] };
      for (let round = 0; round < 3; round += 1) {
        this.again = false;
        pass = await this.syncOnce().catch((error: unknown) => {
          log.warn("usage-sync.failed", { error: formatLogError(error, { message: false }) });
          return { stored: 0, nodes: [] };
        });
        if (!this.again || this.disposed) break;
      }
      return pass;
    })().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async collect(controllerId: string, nodeId: string): Promise<NodeHoldings | "unsupported" | "failed"> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return "failed";
    let answer: { identities?: readonly unknown[]; readings?: readonly unknown[] };
    try {
      answer = await linkDomainApi(link, accountsClient).collect_shared_usage_readings({
        controllerId,
      });
    } catch (error) {
      // An older node lacks the command: it simply takes no part.
      if (incompatibility(error, collectSharedUsageReadingsCommand.name)) return "unsupported";
      log.warn("usage-sync.failed", { error: formatLogError(error, { message: false }) });
      return "failed";
    }
    const now = this.now();
    const identities = parseUsageIdentities(answer?.identities);
    const keys = new Set(identities.map(usageIdentityKey));
    // A node speaks for the logins it has; anything else it sends is ignored.
    const readings = newestSharedUsageReadings(
      parseSharedUsageReadings(answer?.readings, now).filter((reading) =>
        keys.has(usageIdentityKey(reading.identity)),
      ),
    );
    return { nodeId, identities, readings };
  }

  private async syncOnce(): Promise<NodeUsageSyncPass> {
    const controllerId = await this.deps.selfId();
    const nodeIds = await this.deps.connectedNodeIds();
    const collected = await Promise.all(
      nodeIds.map(async (nodeId) => ({ nodeId, holdings: await this.collect(controllerId, nodeId) })),
    );
    const answered = collected
      .map(({ holdings }) => holdings)
      .filter((holdings): holdings is NodeHoldings => typeof holdings === "object");
    const [central, ownIdentities] = await Promise.all([
      this.deps.central(),
      this.deps.ownIdentities(),
    ]);
    const newest = newestSharedUsageReadings(
      central,
      ...answered.map((holdings) => Array.from(holdings.readings.values())),
    );
    const centralByKey = newestSharedUsageReadings(central);
    const toStore = Array.from(newest.entries())
      .filter(([key, reading]) => isNewerSharedUsageReading(reading, centralByKey.get(key)))
      .map(([, reading]) => reading);
    const stored = toStore.length > 0 ? await this.deps.storeCentral(toStore, ownIdentities) : 0;

    const results: NodeUsageSyncPass["nodes"] = [];
    for (const { nodeId, holdings } of collected) {
      if (typeof holdings !== "object") {
        results.push({ nodeId, sent: 0, state: holdings });
        continue;
      }
      const send = holdings.identities
        .map((identity) => newest.get(usageIdentityKey(identity)))
        .filter(
          (reading): reading is SharedUsageReading =>
            reading !== undefined &&
            isNewerSharedUsageReading(
              reading,
              holdings.readings.get(usageIdentityKey(reading.identity)),
            ),
        )
        .slice(0, SHARED_USAGE_LIMITS.maxReadings);
      if (send.length === 0) {
        results.push({ nodeId, sent: 0, state: "synced" });
        continue;
      }
      const link = this.deps.link(nodeId);
      try {
        if (!link?.connected) throw new Error("The node disconnected.");
        await linkDomainApi(link, accountsClient).apply_shared_usage_readings({
          controllerId,
          readings: send,
        });
        results.push({ nodeId, sent: send.length, state: "synced" });
      } catch (error) {
        log.warn("usage-sync.failed", { error: formatLogError(error, { message: false }) });
        results.push({ nodeId, sent: 0, state: "failed" });
      }
    }
    return { stored, nodes: results };
  }
}
