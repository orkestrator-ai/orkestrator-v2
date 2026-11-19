import {
  BRIDGE_KNOWN_COMPOSER_REVISION_PARAM,
  BRIDGE_KNOWN_STATE_REVISION_PARAM,
  isBridgeStateRevision,
  isBridgeStateUnchanged,
} from "@orkestrator/protocol/bridge-state-revision";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { MAX_TRACKED_INTERACTION_SESSIONS, setBoundedMapEntry } from "../agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./catalog.js";
import {
  httpBridgeSessionStatePath,
  readHttpBridgeStateBody,
  readHttpBridgeStateConfig,
  readHttpBridgeStateQueue,
  type HttpBridgeSessionStateSource,
} from "./progressive.js";
import { bridgeFetch } from "./transport.js";

interface CachedState extends HttpBridgeSessionStateSource {
  stateRevision: string;
}

export interface HttpBridgeStateReadsMetrics {
  /** State reads sent to the bridge. */
  reads: number;
  /** Answered `unchanged`: the side routes were not read. */
  unchanged: number;
  /** Pi composers reused from the cache. */
  composerReused: number;
  /** Side-route reads skipped because the state revision had not moved. */
  sideRoutesSkipped: number;
}

/**
 * The backend's conditional state read of one HTTP bridge connection (to-do
 * 8102 task 2, design D7; the contract is
 * `@orkestrator/protocol/bridge-state-revision`).
 *
 * - The state route is read with the last `stateRevision` this connection got
 *   for the session. A bridge that answers `{ unchanged: true }` costs one
 *   small request: the last body, Codex's `/config` and Pi's `/queue` are
 *   reused, and the interaction adapter reuses its side routes too
 *   (`sideRoutes`).
 * - Pi's composer has its own revision: a body that omits it reuses the last
 *   composer of the same revision. Bounded per session.
 * - A bridge that predates this ignores the query and answers a full body
 *   without `stateRevision`; nothing is cached for it and every read stays as
 *   it was. Codex's `/config` and Pi's `/queue` are then read beside the state,
 *   as before; with a revision they are read only after a moved state.
 * - Concurrent reads of one session join, so the state read and the
 *   interaction read of one round share one request.
 *
 * The cache holds bridge bodies in memory only, per session, bounded by
 * `MAX_TRACKED_INTERACTION_SESSIONS`. A restarted bridge has a new process
 * generation, so its revisions never match the old ones.
 */
export class HttpBridgeStateReads {
  private readonly states = new Map<string, CachedState>();
  private readonly composers = new Map<string, { revision: string; composer: unknown }>();
  private readonly inflight = new Map<string, Promise<HttpBridgeSessionStateSource | "missing">>();
  /** The revision each in-flight or last read answered with, for the side-route gate. */
  private readonly lastRevision = new Map<string, string>();
  /** Side-route payloads per session, and the state revision they were read at. */
  private readonly sides = new Map<string, { stateRevision: string; payloads: unknown[] }>();
  private readonly counters: HttpBridgeStateReadsMetrics = {
    reads: 0,
    unchanged: 0,
    composerReused: 0,
    sideRoutesSkipped: 0,
  };

  constructor(
    private readonly agent: HttpBridgeAgent,
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** One state read of `sessionId`; joins a read already in flight. */
  read(sessionId: string): Promise<HttpBridgeSessionStateSource | "missing"> {
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;
    const read = this.readOnce(sessionId, true).finally(() => {
      if (this.inflight.get(sessionId) === read) this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, read);
    return read;
  }

  /**
   * The state revision the side routes may be keyed on: the answer of the read
   * in flight, or of a fresh conditional read when this bridge reports
   * revisions for the session. `undefined` (an older bridge, a session not yet
   * read, a failed read) means "read the side routes".
   */
  private async revisionGate(sessionId: string): Promise<string | undefined> {
    if (!this.inflight.has(sessionId) && !this.states.has(sessionId)) return undefined;
    try {
      const source = await this.read(sessionId);
      if (source === "missing") return undefined;
      return this.lastRevision.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * The interaction adapter's side routes (questions, plan approvals,
   * interactions, approvals): the payloads `read` last returned while the
   * state revision they were read at still stands, else a fresh `read`.
   */
  async sideRoutes<T>(
    sessionId: string,
    read: () => Promise<T[] | "missing">,
  ): Promise<T[] | "missing"> {
    const stateRevision = await this.revisionGate(sessionId);
    const kept = stateRevision ? this.sides.get(sessionId) : undefined;
    if (kept && kept.stateRevision === stateRevision) {
      this.counters.sideRoutesSkipped += 1;
      return kept.payloads as T[];
    }
    const payloads = await read();
    if (stateRevision && payloads !== "missing") {
      setBoundedMapEntry(
        this.sides,
        sessionId,
        { stateRevision, payloads },
        MAX_TRACKED_INTERACTION_SESSIONS,
      );
    } else {
      this.sides.delete(sessionId);
    }
    return payloads;
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId);
    this.composers.delete(sessionId);
    this.lastRevision.delete(sessionId);
    this.sides.delete(sessionId);
  }

  metrics(): HttpBridgeStateReadsMetrics {
    return { ...this.counters };
  }

  private async readOnce(
    sessionId: string,
    conditional: boolean,
  ): Promise<HttpBridgeSessionStateSource | "missing"> {
    const cached = conditional ? this.states.get(sessionId) : undefined;
    const composer = conditional ? this.composers.get(sessionId) : undefined;
    const query = new URLSearchParams();
    if (cached) query.set(BRIDGE_KNOWN_STATE_REVISION_PARAM, cached.stateRevision);
    if (this.agent === "pi" && composer) {
      query.set(BRIDGE_KNOWN_COMPOSER_REVISION_PARAM, composer.revision);
    }
    const path = httpBridgeSessionStatePath(this.agent, sessionId);
    const encoded = encodeURIComponent(sessionId);
    // Without a cached revision (first read, older bridge) the side reads go
    // beside the state, as before; with one they wait for a moved state.
    const parallel = !cached;
    this.counters.reads += 1;
    const [response, parallelConfig, parallelQueue] = await Promise.all([
      bridgeFetch(
        this.connection,
        query.size > 0 ? `${path}?${query.toString()}` : path,
        {},
        this.fetchImpl,
      ),
      parallel ? this.fetchConfig(encoded) : Promise.resolve(undefined),
      parallel ? this.fetchQueue(encoded) : Promise.resolve(undefined),
    ]);
    if (response.status === 404) {
      await Promise.all([parallelConfig?.body?.cancel(), parallelQueue?.body?.cancel()]).catch(
        () => undefined,
      );
      this.forget(sessionId);
      return "missing";
    }
    const body = await readHttpBridgeStateBody(
      { agent: this.agent, connection: this.connection, fetchImpl: this.fetchImpl },
      response,
    );
    if (isBridgeStateUnchanged(body)) {
      if (cached && body.stateRevision === cached.stateRevision) {
        this.counters.unchanged += 1;
        this.lastRevision.set(sessionId, cached.stateRevision);
        return cached;
      }
      // Nothing to reuse (never sent a revision we do not hold): read in full.
      this.forget(sessionId);
      return this.readOnce(sessionId, false);
    }
    let payload = body;
    if (this.agent === "pi") {
      const composerRevision = isBridgeStateRevision(body.composerRevision)
        ? body.composerRevision
        : undefined;
      if (body.composer === undefined && composerRevision !== undefined) {
        if (composer?.revision !== composerRevision) {
          // The bridge left out a composer this cache does not hold.
          this.forget(sessionId);
          return this.readOnce(sessionId, false);
        }
        this.counters.composerReused += 1;
        payload = { ...body, composer: composer.composer };
      } else if (composerRevision !== undefined && body.composer !== undefined) {
        setBoundedMapEntry(
          this.composers,
          sessionId,
          { revision: composerRevision, composer: body.composer },
          MAX_TRACKED_INTERACTION_SESSIONS,
        );
      } else {
        this.composers.delete(sessionId);
      }
    }
    const [configResponse, queueResponse] = parallel
      ? [parallelConfig, parallelQueue]
      : await Promise.all([this.fetchConfig(encoded), this.fetchQueue(encoded)]);
    const config = configResponse ? await readHttpBridgeStateConfig(configResponse) : undefined;
    const queue = this.agent === "pi" ? await readHttpBridgeStateQueue(queueResponse) : undefined;
    const source: HttpBridgeSessionStateSource = {
      payload,
      ...(config === undefined ? {} : { config }),
      ...(queue === undefined ? {} : { queue }),
    };
    const stateRevision = isBridgeStateRevision(body.stateRevision)
      ? body.stateRevision
      : undefined;
    if (stateRevision) {
      setBoundedMapEntry(
        this.states,
        sessionId,
        { ...source, stateRevision },
        MAX_TRACKED_INTERACTION_SESSIONS,
      );
      setBoundedMapEntry(
        this.lastRevision,
        sessionId,
        stateRevision,
        MAX_TRACKED_INTERACTION_SESSIONS,
      );
    } else {
      this.states.delete(sessionId);
      this.lastRevision.delete(sessionId);
    }
    return source;
  }

  private fetchConfig(encodedSessionId: string): Promise<Response | undefined> {
    if (this.agent !== "codex") return Promise.resolve(undefined);
    return bridgeFetch(this.connection, `/session/${encodedSessionId}/config`, {}, this.fetchImpl);
  }

  private fetchQueue(encodedSessionId: string): Promise<Response | undefined> {
    if (this.agent !== "pi") return Promise.resolve(undefined);
    return bridgeFetch(
      this.connection,
      `/session/${encodedSessionId}/queue`,
      {},
      this.fetchImpl,
    ).catch(() => undefined);
  }
}
