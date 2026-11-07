import type { NodeListResult } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  compareReleaseVersions,
  DEFAULT_FLEET_UPDATE_POLICY,
  fleetUpdateDecision,
  fleetUpdatePolicyEnabled,
  parseFleetUpdatePolicy,
  type FleetUpdateDecision,
  type FleetUpdatePolicy,
} from "@orkestrator/protocol/fleet-currency";
import {
  HOST_UPDATE_IDLE_WAIT,
  isHostMaintenanceSnapshot,
  type HostUpdateChannel,
} from "@orkestrator/protocol/host-maintenance";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("nodes");

/**
 * The command node's opt-in update policy (plan item 5006, report §11.6):
 * for the update channels the user turned it on for, a leaf older than the
 * command node is asked to install the command node's version.
 *
 * It uses the node link's ordinary host-maintenance commands, the same ones
 * Settings → Machines sends through `invoke_on_node`: the leaf's own
 * `get_host_maintenance` says its channel, updater and running job, and
 * `request_host_update { version, drain: "when-idle" }` asks its host to
 * install the release once nothing runs there. Nothing is downgraded, and a
 * release outside the leaf's channel is never pushed. Off by default.
 *
 * A pass runs when a node connects or changes, when the policy changes, and
 * every {@link FLEET_UPDATE_RECONCILE_MS} while any channel is on. A target
 * version is asked for at most once per node every
 * {@link FLEET_UPDATE_RETRY_MS}, so a failing update never loops.
 */

export interface FleetUpdateLink {
  readonly connected: boolean;
  readonly hello?: { appVersion?: string } | null;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface FleetUpdateNodes {
  listNodes(): Promise<NodeListResult>;
  link(nodeId: BackendId): FleetUpdateLink | null;
  subscribe(listener: () => void): () => void;
  isLeaf(): boolean;
}

export interface FleetUpdatePolicyStore {
  load(): Promise<unknown>;
  save(policy: FleetUpdatePolicy): Promise<void>;
}

export const FLEET_UPDATE_RECONCILE_MS = 10 * 60_000;
export const FLEET_UPDATE_RETRY_MS = 6 * 60 * 60_000;
const PASS_DEBOUNCE_MS = 1_000;

export interface FleetUpdatePassEntry {
  nodeId: BackendId;
  decision: FleetUpdateDecision | { action: "error" };
}

export class FleetUpdatePolicyRunner {
  private current: FleetUpdatePolicy = DEFAULT_FLEET_UPDATE_POLICY;
  private loaded: Promise<void> | null = null;
  private policyUpdates: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private passTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<FleetUpdatePassEntry[]> | null = null;
  private again = false;
  private started = false;
  /** Node → the version last asked for and when (command-node clock). */
  private readonly attempts = new Map<BackendId, { version: string; at: number }>();

  constructor(
    private readonly options: {
      nodes: FleetUpdateNodes;
      store?: FleetUpdatePolicyStore;
      selfVersion: () => Promise<string>;
      now?: () => number;
      /** Test seams. */
      reconcileMs?: number;
      retryMs?: number;
      debounceMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.load();
    if (!this.started) return;
    this.unsubscribe = this.options.nodes.subscribe(() => this.schedule());
    this.arm();
    this.schedule();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.passTimer) clearTimeout(this.passTimer);
    this.passTimer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  async policy(): Promise<FleetUpdatePolicy> {
    await this.load();
    return this.current;
  }

  setChannel(channel: HostUpdateChannel, enabled: boolean): Promise<FleetUpdatePolicy> {
    // Queue the read as well as the write so concurrent clients merge against
    // the last persisted policy. A failed save leaves that policy unchanged.
    const update = this.policyUpdates.then(() => this.saveChannel(channel, enabled));
    // Keep later updates usable after a failure; the caller still sees it.
    this.policyUpdates = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  private async saveChannel(
    channel: HostUpdateChannel,
    enabled: boolean,
  ): Promise<FleetUpdatePolicy> {
    await this.load();
    const next: FleetUpdatePolicy = {
      version: 1,
      channels: { ...this.current.channels, [channel]: enabled },
    };
    await this.options.store?.save(next);
    this.current = next;
    // Turning a channel on again retries its leaves now.
    if (enabled) this.attempts.clear();
    this.arm();
    this.schedule();
    return next;
  }

  /** One pass over the connected nodes; a pass already running absorbs the request. */
  pass(): Promise<FleetUpdatePassEntry[]> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = this.runPass().finally(() => {
      this.running = null;
      if (this.again && this.started) {
        this.again = false;
        this.schedule();
      }
    });
    this.running = run;
    return run;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.current = parseFleetUpdatePolicy(await this.options.store?.load());
      } catch (error) {
        log.warn("fleet-update.policy-load-failed", {
          error: formatLogError(error, { message: false }),
        });
      }
    })();
    return this.loaded;
  }

  private schedule(): void {
    if (!this.started || this.passTimer || !fleetUpdatePolicyEnabled(this.current)) return;
    this.passTimer = setTimeout(() => {
      this.passTimer = null;
      void this.pass();
    }, this.options.debounceMs ?? PASS_DEBOUNCE_MS);
    (this.passTimer as { unref?: () => void }).unref?.();
  }

  /** The safety pass runs only while some channel is on. */
  private arm(): void {
    const enabled = this.started && fleetUpdatePolicyEnabled(this.current);
    if (enabled && !this.reconcileTimer) {
      this.reconcileTimer = setInterval(
        () => this.schedule(),
        this.options.reconcileMs ?? FLEET_UPDATE_RECONCILE_MS,
      );
      (this.reconcileTimer as { unref?: () => void }).unref?.();
    } else if (!enabled && this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private async runPass(): Promise<FleetUpdatePassEntry[]> {
    await this.load();
    const policy = this.current;
    if (!fleetUpdatePolicyEnabled(policy) || this.options.nodes.isLeaf()) return [];
    const selfVersion = await this.options.selfVersion();
    const now = this.options.now ?? Date.now;
    const retryMs = this.options.retryMs ?? FLEET_UPDATE_RETRY_MS;
    const list = await this.options.nodes.listNodes();
    const entries: FleetUpdatePassEntry[] = [];
    for (const view of list.nodes) {
      if (view.connection.state !== "connected") continue;
      const nodeId = view.nodeId;
      const link = this.options.nodes.link(nodeId);
      if (!link?.connected) continue;
      // The hello says enough to leave a current or newer node alone without a read.
      const announced = link.hello?.appVersion;
      const order = announced ? compareReleaseVersions(announced, selfVersion) : null;
      if (order !== null && order >= 0) continue;
      const attempt = this.attempts.get(nodeId);
      if (attempt && attempt.version === selfVersion && now() - attempt.at < retryMs) continue;
      try {
        const snapshot = await link.invoke<unknown>("get_host_maintenance", {});
        if (!isHostMaintenanceSnapshot(snapshot)) throw new Error("Unexpected maintenance answer");
        const decision = fleetUpdateDecision(policy, selfVersion, snapshot);
        if (decision.action !== "update") {
          entries.push({ nodeId, decision });
          continue;
        }
        this.attempts.set(nodeId, { version: decision.version, at: now() });
        await link.invoke("request_host_update", {
          version: decision.version,
          drain: "when-idle",
          maxWaitSeconds: HOST_UPDATE_IDLE_WAIT.maxSeconds,
        });
        entries.push({ nodeId, decision });
        log.info("fleet-update.requested", { version: decision.version });
      } catch (error) {
        entries.push({ nodeId, decision: { action: "error" } });
        log.warn("fleet-update.failed", {
          error: formatLogError(error, { message: false }),
        });
      }
    }
    return entries;
  }
}
