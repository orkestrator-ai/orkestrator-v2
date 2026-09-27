import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { spawnCommand } from "./commands-dependencies.js";

/**
 * Backend-owned container log followers.
 *
 * One `docker logs -f` per container (the source), shared by every
 * subscription to it and stopped a short grace after the last one closes or
 * its lease lapses. Output is decoded incrementally (a multibyte character
 * split across chunks is not corrupted), cut into bounded records and kept in
 * a bounded replay ring. A client that falls behind the ring, or asks for a
 * cursor from another source generation, receives an explicit gap and reads a
 * bounded tail instead. Diagnostic gaps never license dropping authoritative
 * lifecycle, approval or transcript events, which do not travel here.
 *
 * Log content is never broadcast. Gateway events reach every connected client
 * and fill the shared replay ring that lifecycle and approval events depend
 * on; a busy container would push those out. Readers poll `read` with their
 * cursor instead, which only the subscriber sees.
 */

export const LOG_LIMITS = {
  /** Largest single record; longer lines are split. */
  recordBytes: 16 * 1024,
  /** Replay ring per source. */
  ringBytes: 1024 * 1024,
  ringRecords: 2_000,
  /** Records returned by one read. */
  readRecords: 256,
  readBytes: 256 * 1024,
  /** Concurrent followers per backend. */
  maxFollowers: 16,
  /** Subscriptions per source. */
  maxSubscriptionsPerSource: 32,
  /** A follower outlives its last subscriber by this much. */
  idleGraceMs: 5_000,
  /** A subscription that is neither read nor renewed for this long expires. */
  leaseMs: 60_000,
} as const;

export interface LogRecord {
  seq: number;
  text: string;
}

export type LogReadResult =
  | {
      kind: "records";
      sourceId: string;
      records: LogRecord[];
      cursor: number;
      /** The follower exited (container stopped or removed). */
      ended: boolean;
    }
  /**
   * The cursor is older than the ring or belongs to another source. `records`
   * is the newest retained tail (bounded like a read); output before it was
   * not kept.
   */
  | { kind: "gap"; sourceId: string; records: LogRecord[]; cursor: number; ended: boolean };

interface LogSource {
  sourceId: string;
  containerId: string;
  child: ReturnType<typeof spawnCommand> | null;
  ring: LogRecord[];
  ringBytes: number;
  nextSeq: number;
  ended: boolean;
  subscriptions: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Subscription {
  id: string;
  source: LogSource;
  leaseUntil: number;
}

type Spawn = (command: string, args: string[]) => ReturnType<typeof spawnCommand>;

export class ContainerLogService {
  private readonly sources = new Map<string, LogSource>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly leaseSweep: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly spawn: Spawn = spawnCommand,
    private readonly now: () => number = Date.now,
  ) {
    this.leaseSweep = setInterval(() => this.expireLeases(), 5_000);
    this.leaseSweep.unref?.();
  }

  followerCount(): number {
    let count = 0;
    for (const source of this.sources.values()) if (source.child) count += 1;
    return count;
  }

  /**
   * Opens a subscription. The caller must have verified ownership of the
   * container. Returns the source id (a new one for every follower, so a
   * replaced container never appends to an old cursor) and the cursor to read
   * from: the start of the ring, so a new subscriber sees retained output.
   */
  open(containerId: string): { subscriptionId: string; sourceId: string; cursor: number } {
    if (this.closed) throw this.exhausted("Log following is shutting down.");
    let source = this.sources.get(containerId);
    // A follower that ended (the container stopped) is not reused: a restart
    // is a new source with its own id, so no cursor spans two boots.
    if (source?.ended) {
      this.forget(source);
      source = undefined;
    }
    if (!source) {
      if (this.followerCount() >= LOG_LIMITS.maxFollowers) {
        throw this.exhausted("Too many container logs are being followed. Close one and retry.");
      }
      source = this.startSource(containerId);
    }
    if (source.subscriptions.size >= LOG_LIMITS.maxSubscriptionsPerSource) {
      throw this.exhausted("Too many subscriptions to this container's log.");
    }
    if (source.idleTimer) {
      clearTimeout(source.idleTimer);
      source.idleTimer = null;
    }
    const id = randomUUID();
    source.subscriptions.add(id);
    this.subscriptions.set(id, { id, source, leaseUntil: this.now() + LOG_LIMITS.leaseMs });
    const first = source.ring[0]?.seq ?? source.nextSeq;
    return { subscriptionId: id, sourceId: source.sourceId, cursor: first - 1 };
  }

  /** Reads records after `cursor` and renews the lease. */
  read(subscriptionId: string, sourceId: string, cursor: number): LogReadResult {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(
        formatContainerLifecycleError("operation-unknown", "The log subscription has expired."),
      );
    }
    subscription.leaseUntil = this.now() + LOG_LIMITS.leaseMs;
    const { source } = subscription;
    const oldest = source.ring[0]?.seq ?? source.nextSeq;
    if (sourceId !== source.sourceId || cursor < oldest - 1 || cursor >= source.nextSeq) {
      const tail = boundedTail(source.ring);
      return {
        kind: "gap",
        sourceId: source.sourceId,
        records: tail,
        cursor: tail.at(-1)?.seq ?? source.nextSeq - 1,
        ended: source.ended,
      };
    }
    const records: LogRecord[] = [];
    let bytes = 0;
    for (const record of source.ring) {
      if (record.seq <= cursor) continue;
      if (records.length >= LOG_LIMITS.readRecords) break;
      bytes += Buffer.byteLength(record.text);
      if (bytes > LOG_LIMITS.readBytes && records.length > 0) break;
      records.push(record);
    }
    return {
      kind: "records",
      sourceId: source.sourceId,
      records,
      cursor: records.at(-1)?.seq ?? cursor,
      ended: source.ended,
    };
  }

  /** Releases the observer only; the container and its processes are untouched. */
  close(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    this.subscriptions.delete(subscriptionId);
    const { source } = subscription;
    source.subscriptions.delete(subscriptionId);
    if (source.subscriptions.size === 0) this.scheduleIdleStop(source);
  }

  /** Backend shutdown: stop every follower whatever its subscribers did. */
  shutdown(): void {
    this.closed = true;
    clearInterval(this.leaseSweep);
    for (const source of Array.from(this.sources.values())) this.stopSource(source);
    this.subscriptions.clear();
  }

  private exhausted(message: string): Error {
    return new Error(formatContainerLifecycleError("resource-exhausted", message));
  }

  private startSource(containerId: string): LogSource {
    const source: LogSource = {
      sourceId: randomUUID(),
      containerId,
      child: null,
      ring: [],
      ringBytes: 0,
      nextSeq: 1,
      ended: false,
      subscriptions: new Set(),
      idleTimer: null,
    };
    this.sources.set(containerId, source);
    const child = this.spawn("docker", ["logs", "-f", "--tail", "200", containerId]);
    source.child = child;
    // One decoder per stream so a character split across chunks survives.
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      stream.on("data", (chunk: Buffer) => {
        pending += decoder.write(chunk);
        pending = this.consume(source, pending, false);
      });
      stream.on("end", () => {
        pending += decoder.end();
        this.consume(source, pending, true);
        pending = "";
      });
    }
    // The follower is owned: its failure ends the source, never the backend.
    child.on("error", () => this.endSource(source));
    child.on("close", () => this.endSource(source));
    return source;
  }

  /** Cuts complete (or oversized) lines into records; returns the remainder. */
  private consume(source: LogSource, text: string, flush: boolean): string {
    let rest = text;
    while (true) {
      const newline = rest.indexOf("\n");
      if (
        newline >= 0 &&
        newline < LOG_LIMITS.recordBytes &&
        Buffer.byteLength(rest.slice(0, newline + 1)) <= LOG_LIMITS.recordBytes
      ) {
        this.append(source, rest.slice(0, newline + 1));
        rest = rest.slice(newline + 1);
        continue;
      }
      if (Buffer.byteLength(rest) >= LOG_LIMITS.recordBytes) {
        // One enormous line: keep it in bounded pieces rather than buffering it.
        const cut = recordCut(rest, LOG_LIMITS.recordBytes);
        this.append(source, rest.slice(0, cut));
        rest = rest.slice(cut);
        continue;
      }
      break;
    }
    if (flush && rest) {
      this.append(source, rest);
      return "";
    }
    return rest;
  }

  private append(source: LogSource, text: string): void {
    const record = { seq: source.nextSeq, text };
    source.nextSeq += 1;
    source.ring.push(record);
    source.ringBytes += Buffer.byteLength(text);
    while (source.ring.length > LOG_LIMITS.ringRecords || source.ringBytes > LOG_LIMITS.ringBytes) {
      const dropped = source.ring.shift();
      if (!dropped) break;
      source.ringBytes -= Buffer.byteLength(dropped.text);
    }
  }

  private endSource(source: LogSource): void {
    source.ended = true;
    source.child = null;
    if (source.subscriptions.size === 0) this.forget(source);
  }

  private scheduleIdleStop(source: LogSource): void {
    if (source.idleTimer) clearTimeout(source.idleTimer);
    source.idleTimer = setTimeout(() => {
      source.idleTimer = null;
      if (source.subscriptions.size === 0) this.stopSource(source);
    }, LOG_LIMITS.idleGraceMs);
    source.idleTimer.unref?.();
  }

  private stopSource(source: LogSource): void {
    if (source.idleTimer) clearTimeout(source.idleTimer);
    source.idleTimer = null;
    const child = source.child;
    source.child = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    this.forget(source);
  }

  private forget(source: LogSource): void {
    if (this.sources.get(source.containerId) === source) this.sources.delete(source.containerId);
  }

  private expireLeases(): void {
    const now = this.now();
    for (const subscription of Array.from(this.subscriptions.values())) {
      if (subscription.leaseUntil <= now) this.close(subscription.id);
    }
  }

  /** Test seam. */
  sweepLeases(): void {
    this.expireLeases();
  }
}

/**
 * The longest prefix of `text` within `limit` UTF-8 bytes that does not end
 * inside a surrogate pair (never empty, so progress is guaranteed).
 */
export function recordCut(text: string, limit: number): number {
  let low = 1;
  let high = Math.min(text.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  const code = text.charCodeAt(low - 1);
  return code >= 0xd800 && code <= 0xdbff && low > 1 ? low - 1 : low;
}

/** The newest records of a ring within one read's bounds, oldest first. */
function boundedTail(ring: readonly LogRecord[]): LogRecord[] {
  const tail: LogRecord[] = [];
  let bytes = 0;
  for (let index = ring.length - 1; index >= 0; index -= 1) {
    const record = ring[index]!;
    if (tail.length >= LOG_LIMITS.readRecords) break;
    bytes += Buffer.byteLength(record.text);
    if (bytes > LOG_LIMITS.readBytes && tail.length > 0) break;
    tail.push(record);
  }
  return tail.reverse();
}

// ---------------------------------------------------------------------------
// Backend-lifetime instance
// ---------------------------------------------------------------------------

let instance: ContainerLogService | null = null;

/** The backend's one log service; created on first use. */
export function containerLogService(): ContainerLogService {
  instance ??= new ContainerLogService();
  return instance;
}

/** Backend shutdown: stop every follower whatever its clients did. */
export function shutdownContainerLogService(): void {
  instance?.shutdown();
  instance = null;
}
