/**
 * How often this backend has started each provider's bridges, and how often one
 * stopped without being asked: the health row's answer to "did a bridge keep
 * restarting?" (docs/architecture/logging.md).
 *
 * Counted in memory beside the log lines that already say each event one at a
 * time (`bridge.started` and `bridge.exited` for a host bridge, `bridge.launched`
 * for a container one), so the sample reads numbers and asks no bridge
 * anything. Keys are a fixed provider vocabulary; anything else is not counted,
 * so the table stays bounded and content-free whatever a key holds.
 *
 * Counts are cumulative in this process, like the sample's stall count. A first
 * start counts too: a restart is a start beyond the first, which only the
 * reader of several samples can tell apart, and the unrequested exits say
 * which starts were replacing a lost bridge.
 *
 * Keep this module free of imports: the local-server runtime, the container
 * launch path and the health summary all import it.
 */

/** Every provider a bridge can be started for; `opencode` is the OpenCode server. */
export const BRIDGE_RESTART_PROVIDERS = [
  "opencode",
  "claude",
  "codex",
  "cursor",
  "grok",
  "pi",
] as const;
export type BridgeRestartProvider = (typeof BRIDGE_RESTART_PROVIDERS)[number];

export interface BridgeRestartCounts {
  /** Host bridges this backend spawned. */
  localStarts: number;
  /** Host bridges that exited without this backend asking, whatever their code. */
  localUnrequestedExits: number;
  /** Container bridges this backend launched (a relaunch is seen only here). */
  containerLaunches: number;
}

/** Providers with any count; an idle backend's row stays empty. */
export type BridgeRestartSnapshot = Partial<Record<BridgeRestartProvider, BridgeRestartCounts>>;

function isProvider(value: string): value is BridgeRestartProvider {
  return (BRIDGE_RESTART_PROVIDERS as readonly string[]).includes(value);
}

/** The provider a local-server key (`<kind>:<environmentId>`) names, or `null`. */
export function bridgeProviderOfKey(key: string): BridgeRestartProvider | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  return isProvider(kind) ? kind : null;
}

export class BridgeRestartCounter {
  private readonly counts = new Map<BridgeRestartProvider, BridgeRestartCounts>();

  private series(provider: string): BridgeRestartCounts | null {
    if (!isProvider(provider)) return null;
    let counts = this.counts.get(provider);
    if (!counts) {
      counts = { localStarts: 0, localUnrequestedExits: 0, containerLaunches: 0 };
      this.counts.set(provider, counts);
    }
    return counts;
  }

  /** A host bridge started, under its local-server key. */
  localStarted(key: string): void {
    const provider = bridgeProviderOfKey(key);
    if (provider) this.series(provider)!.localStarts += 1;
  }

  /** A host bridge exited; only an exit nothing asked for is counted. */
  localExited(key: string, requested: boolean): void {
    if (requested) return;
    const provider = bridgeProviderOfKey(key);
    if (provider) this.series(provider)!.localUnrequestedExits += 1;
  }

  /** A container bridge was launched for `provider`. */
  containerLaunched(provider: string): void {
    const counts = this.series(provider);
    if (counts) counts.containerLaunches += 1;
  }

  snapshot(): BridgeRestartSnapshot {
    const snapshot: BridgeRestartSnapshot = {};
    for (const provider of BRIDGE_RESTART_PROVIDERS) {
      const counts = this.counts.get(provider);
      if (counts) snapshot[provider] = { ...counts };
    }
    return snapshot;
  }

  /** Tests only: forget every count. */
  reset(): void {
    this.counts.clear();
  }
}

/** This backend's counter; the health sample reads it. */
export const bridgeRestarts = new BridgeRestartCounter();
