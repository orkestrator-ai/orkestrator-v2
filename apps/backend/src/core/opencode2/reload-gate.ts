/**
 * The fence between dispatches and a configuration reload on one OpenCode
 * server.
 *
 * `POST /api/location/reload` rebuilds every loaded location, which cancels
 * pending permissions and forms. One environment server is shared by every
 * provider instance that talks to it (the tab provider and each pipeline,
 * Multi Review, graph and subork provider), so the fence cannot live on one
 * provider: it is keyed by the server generation, and every provider on that
 * generation enters the same gate.
 *
 * - A dispatch (create, preflight, prompt, session action) holds the gate
 *   shared. One that arrives while a reload runs waits for it to finish, so
 *   it never lands on a location being rebuilt.
 * - A reload holds the gate exclusively. It is refused (`busy`) while any
 *   dispatch is open or another reload runs, and it marks itself running
 *   before its first await, so a dispatch that starts after the check waits.
 *   The reload's own idle check (every session on the server) runs inside the
 *   exclusive hold, after which no new turn can start until it is done.
 *
 * Gates are forgotten once nothing holds them, so the registry is bounded by
 * the servers with work in flight.
 *
 * A reload also drops every runtime MCP server registered on the location
 * (`PUT /api/experimental/mcp/:server`), whichever provider registered it.
 * Each completed reload advances the server's reload count
 * ({@link noteOpenCode2LocationsReloaded}); a registration made before the
 * current count is no longer trusted (`mcp.ts`), so the next turn on any
 * provider re-registers its servers.
 */

export type OpenCode2ReloadGateOutcome<T> = T | "busy";

export class OpenCode2ReloadGate {
  private dispatches = 0;
  /** Dispatches waiting out a reload: they hold the gate but do not block one. */
  private waiting = 0;
  private reloading: Promise<unknown> | null = null;

  constructor(private readonly onIdle: () => void = () => {}) {}

  /** Whether nothing holds the gate. */
  get idle(): boolean {
    return this.dispatches === 0 && this.waiting === 0 && this.reloading === null;
  }

  /** Whether a reload holds the gate exclusively. */
  get reloadRunning(): boolean {
    return this.reloading !== null;
  }

  /** Run `operation` as one dispatch, after any reload already running. */
  async withinDispatch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.reloading) {
      this.waiting += 1;
      try {
        while (this.reloading) await this.reloading.catch(() => undefined);
      } finally {
        this.waiting -= 1;
      }
    }
    // No await between the check above and this increment.
    this.dispatches += 1;
    try {
      return await operation();
    } finally {
      this.dispatches -= 1;
      if (this.idle) this.onIdle();
    }
  }

  /**
   * Run `reload` exclusively, or answer `busy` without running it while a
   * dispatch is open or another reload runs.
   */
  exclusive<T>(reload: () => Promise<T>): Promise<OpenCode2ReloadGateOutcome<T>> {
    if (this.reloading || this.dispatches > 0) return Promise.resolve("busy");
    const running = (async () => reload())().finally(() => {
      if (this.reloading === running) this.reloading = null;
      if (this.idle) this.onIdle();
    });
    // Set synchronously, before `reload` reaches its first await.
    this.reloading = running;
    return running;
  }
}

const gates = new Map<string, OpenCode2ReloadGate>();

function gateFor(key: string): OpenCode2ReloadGate {
  let gate = gates.get(key);
  if (!gate) {
    const created: OpenCode2ReloadGate = new OpenCode2ReloadGate(() => {
      if (gates.get(key) === created && created.idle) gates.delete(key);
    });
    gate = created;
    gates.set(key, gate);
  }
  return gate;
}

/**
 * The gate key of one server generation. The generation alone is not unique
 * across environments (a host generation is `pid:port`), so the base URL is
 * part of it.
 */
export function openCode2ReloadGateKey(connection: {
  baseUrl: string;
  generation: string;
}): string {
  return `${connection.baseUrl}\u0000${connection.generation}`;
}

/** Run `operation` as one dispatch on the server `key` names. */
export function withinOpenCode2Dispatch<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return gateFor(key).withinDispatch(operation);
}

/** Run a reload of the server `key` names exclusively, or answer `busy`. */
export function exclusiveOpenCode2Reload<T>(
  key: string,
  reload: () => Promise<T>,
): Promise<OpenCode2ReloadGateOutcome<T>> {
  return gateFor(key).exclusive(reload);
}

/** Tests: the number of gates something still holds. */
export function openCode2ReloadGateCount(): number {
  return gates.size;
}

// ── location reload counts ───────────────────────────────────────────────────

/** Servers whose reload count is kept; the oldest is forgotten past it. */
const MAX_RELOAD_COUNTS = 1024;
const reloadCounts = new Map<string, number>();

/**
 * How many location reloads the server at `baseUrl` has completed in this
 * backend. A forgotten count reads 0, which only costs a registration a
 * status read.
 */
export function openCode2LocationReloadCount(baseUrl: string): number {
  return reloadCounts.get(baseUrl) ?? 0;
}

/** Record a completed location reload of the server at `baseUrl`. */
export function noteOpenCode2LocationsReloaded(baseUrl: string): void {
  const next = openCode2LocationReloadCount(baseUrl) + 1;
  reloadCounts.delete(baseUrl);
  reloadCounts.set(baseUrl, next);
  while (reloadCounts.size > MAX_RELOAD_COUNTS) {
    const oldest = reloadCounts.keys().next().value;
    if (oldest === undefined) break;
    reloadCounts.delete(oldest);
  }
}
