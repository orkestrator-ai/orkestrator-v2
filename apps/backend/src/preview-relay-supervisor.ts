import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";

import { previewFailure, type PreviewErrorCategory } from "@orkestrator/protocol/preview-services";

import {
  PREVIEW_RELAY_SCRIPT,
  RELAY_FRAME,
  RELAY_PROTOCOL_VERSION,
} from "./preview-relay-script.js";

const HEADER = 9;
const MAX_PAYLOAD = 32 * 1024;

export interface RelayProcess {
  stdin: NodeJS.WritableStream & { write(chunk: Buffer): boolean; end(): void };
  stdout: NodeJS.ReadableStream;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface PreviewRelaySupervisorOptions {
  /** Start the relay inside the container (docker exec -i); injectable for tests. */
  spawn?: (containerId: string) => RelayProcess;
  /** Ports the backend authorizes for an environment (its registered services). */
  allowedPorts: (environmentId: string) => number[];
  maxChannelsPerEnvironment?: number;
  maxRelays?: number;
  window?: number;
  helloTimeoutMs?: number;
  openTimeoutMs?: number;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

function creditFrame(channel: number, bytes: number): Buffer {
  const credit = Buffer.alloc(4);
  credit.writeUInt32BE(bytes, 0);
  return frame(RELAY_FRAME.credit, channel, credit);
}

export function frame(type: number, channel: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(HEADER);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(channel >>> 0, 1);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/** docker exec -i as the unprivileged container user, preferring node over bun. */
export function dockerRelaySpawn(containerId: string): RelayProcess {
  const child: ChildProcessWithoutNullStreams = spawnProcess(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "node",
      containerId,
      "sh",
      "-c",
      'if command -v node >/dev/null 2>&1; then exec node -e "$0"; else exec bun -e "$0"; fi',
      PREVIEW_RELAY_SCRIPT,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  // Relay diagnostics never include payloads; discard stderr to keep it bounded.
  child.stderr.resume();
  return child;
}

class RelayChannel extends Duplex {
  sendCredit: number;
  opened = false;
  private heldCredit = 0;
  private finished = false;

  constructor(
    readonly id: number,
    private readonly relay: EnvironmentRelay,
    window: number,
  ) {
    super({ allowHalfOpen: true });
    this.sendCredit = window;
    // Like upstream sockets: a relay failure closes the channel, and consumers
    // observe it through close/end rather than an unhandled error event.
    this.on("error", () => undefined);
  }

  override _read(): void {
    // The consumer wants more: return the credit held back while it was full.
    if (this.heldCredit > 0) {
      this.relay.write(creditFrame(this.id, this.heldCredit));
      this.heldCredit = 0;
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const send = (offset: number) => {
      if (this.destroyed) return callback(previewFailure("backend-unavailable"));
      let position = offset;
      while (position < chunk.length) {
        if (this.sendCredit <= 0) {
          // Resume when the relay returns credit for this channel only.
          this.once("credit", () => send(position));
          return;
        }
        const size = Math.min(MAX_PAYLOAD, this.sendCredit, chunk.length - position);
        this.sendCredit -= size;
        this.relay.write(
          frame(RELAY_FRAME.data, this.id, chunk.subarray(position, position + size)),
        );
        position += size;
      }
      callback();
    };
    send(0);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.relay.write(frame(RELAY_FRAME.eof, this.id));
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.finished) this.relay.closeChannel(this.id, true);
    this.finished = true;
    callback(error);
  }

  /** The relay closed this channel; end reads without discarding buffered bytes. */
  remoteClosed(): void {
    this.finished = true;
    this.push(null);
    if (!this.writableEnded) this.end();
  }

  grant(bytes: number): void {
    this.sendCredit += bytes;
    this.emit("credit");
  }

  /**
   * Data from the relay. Credit is returned only while the consumer keeps up,
   * so a slow consumer stops its own channel (bounded by the window) without
   * pausing the shared stdio stream for every other channel.
   */
  deliver(payload: Buffer): void {
    if (this.push(payload)) this.relay.write(creditFrame(this.id, payload.length));
    else this.heldCredit += payload.length;
  }
}

class EnvironmentRelay {
  readonly channels = new Map<number, RelayChannel>();
  private readonly pendingOpens = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private buffer: Buffer = Buffer.alloc(0);
  private nextChannel = 1;
  private readyPromise: Promise<void>;
  private alive = true;
  private allowed = "";

  constructor(
    readonly environmentId: string,
    readonly containerId: string,
    private readonly process: RelayProcess,
    private readonly options: Required<
      Pick<
        PreviewRelaySupervisorOptions,
        "window" | "maxChannelsPerEnvironment" | "helloTimeoutMs" | "openTimeoutMs"
      >
    > &
      Pick<PreviewRelaySupervisorOptions, "logger">,
    allowed: number[],
    private readonly onExit: (relay: EnvironmentRelay, deliberate: boolean) => void,
  ) {
    const nonce = randomBytes(16).toString("hex");
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            previewFailure("backend-unavailable", {
              message: "The container relay did not start.",
            }),
          ),
        options.helloTimeoutMs,
      );
      this.onReady = (value) => {
        clearTimeout(timer);
        if (value === nonce) resolve();
        else
          reject(
            previewFailure("backend-unavailable", {
              message: "The container relay answered unexpectedly.",
            }),
          );
      };
      this.onFail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    this.readyPromise.catch(() => undefined);
    process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    process.on("exit", () =>
      this.shutdown(
        previewFailure("backend-unavailable", {
          message: "The container relay stopped.",
        }),
      ),
    );
    process.on("error", () =>
      this.shutdown(
        previewFailure("backend-unavailable", {
          message: "The container relay could not start.",
        }),
      ),
    );
    this.allowed = JSON.stringify([...allowed].sort((a, b) => a - b));
    this.write(
      frame(
        RELAY_FRAME.hello,
        0,
        Buffer.from(
          JSON.stringify({
            version: RELAY_PROTOCOL_VERSION,
            nonce,
            allow: allowed,
            window: options.window,
            maxChannels: options.maxChannelsPerEnvironment,
          }),
        ),
      ),
    );
  }

  private onReady: (nonce: string) => void = () => undefined;
  private onFail: (error: Error) => void = () => undefined;

  get isAlive(): boolean {
    return this.alive;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  write(buffer: Buffer): void {
    if (!this.alive) return;
    this.process.stdin.write(buffer);
  }

  updateAllowed(ports: number[]): void {
    const next = JSON.stringify([...ports].sort((a, b) => a - b));
    if (next === this.allowed) return;
    this.allowed = next;
    this.write(frame(RELAY_FRAME.allow, 0, Buffer.from(next)));
  }

  async open(port: number, signal: AbortSignal): Promise<RelayChannel> {
    await this.ready();
    if (this.channels.size >= this.options.maxChannelsPerEnvironment)
      throw previewFailure("capacity-exceeded");
    const id = this.nextChannel++;
    if (this.nextChannel > 0x7fff_ffff) this.nextChannel = 1;
    const channel = new RelayChannel(id, this, this.options.window);
    this.channels.set(id, channel);
    const port16 = Buffer.alloc(2);
    port16.writeUInt16BE(port, 0);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingOpens.delete(id);
          reject(previewFailure("connect-timeout"));
        }, this.options.openTimeoutMs);
        const abort = () => {
          clearTimeout(timer);
          this.pendingOpens.delete(id);
          reject(
            previewFailure("access-expired", {
              message: "The preview request was cancelled.",
            }),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        this.pendingOpens.set(id, {
          resolve: () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
        this.write(frame(RELAY_FRAME.open, id, port16));
      });
    } catch (error) {
      this.closeChannel(id, true);
      channel.destroy();
      throw error;
    }
    channel.opened = true;
    return channel;
  }

  closeChannel(id: number, notify: boolean): void {
    if (!this.channels.delete(id)) return;
    if (notify) this.write(frame(RELAY_FRAME.close, id));
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER) {
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_PAYLOAD + 1024) {
        this.shutdown(
          previewFailure("internal", {
            message: "The container relay sent a malformed frame.",
          }),
        );
        return;
      }
      if (this.buffer.length < HEADER + length) return;
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const payload = Buffer.from(this.buffer.subarray(HEADER, HEADER + length));
      this.buffer = this.buffer.subarray(HEADER + length);
      this.onFrame(type, id, payload);
    }
  }

  private onFrame(type: number, id: number, payload: Buffer): void {
    const channel = this.channels.get(id);
    switch (type) {
      case RELAY_FRAME.ready:
        this.onReady(payload.toString("utf8"));
        return;
      case RELAY_FRAME.opened:
        if (this.pendingOpens.has(id)) {
          this.pendingOpens.get(id)!.resolve();
          this.pendingOpens.delete(id);
        } else if (!channel) {
          // A channel cancelled while opening: close it on the relay too.
          this.write(frame(RELAY_FRAME.close, id));
        }
        return;
      case RELAY_FRAME.openFailed: {
        const code = payload.toString("utf8");
        const category: PreviewErrorCategory =
          code === "EACCES"
            ? "forbidden"
            : code === "ECAPACITY"
              ? "capacity-exceeded"
              : "connection-refused";
        this.pendingOpens.get(id)?.reject(previewFailure(category));
        this.pendingOpens.delete(id);
        return;
      }
      case RELAY_FRAME.data:
        channel?.deliver(payload);
        return;
      case RELAY_FRAME.credit:
        channel?.grant(payload.readUInt32BE(0));
        return;
      case RELAY_FRAME.eof:
        channel?.push(null);
        return;
      case RELAY_FRAME.close:
        if (channel) {
          this.channels.delete(id);
          channel.remoteClosed();
        }
        return;
      default:
        this.shutdown(
          previewFailure("internal", {
            message: "The container relay sent an unknown frame.",
          }),
        );
    }
  }

  shutdown(error: Error, deliberate = false): void {
    if (!this.alive) return;
    this.alive = false;
    this.onFail(error);
    for (const pending of this.pendingOpens.values()) pending.reject(error);
    this.pendingOpens.clear();
    for (const channel of Array.from(this.channels.values())) channel.destroy(error);
    this.channels.clear();
    try {
      this.process.stdin.end();
    } catch {
      // already closed
    }
    this.process.kill("SIGTERM");
    this.onExit(this, deliberate);
  }
}

/**
 * One relay process per owned container, started lazily for relay-backed
 * services and bound to the container identity it was started for. A relay
 * crash marks relay traffic unavailable (with a bounded restart backoff) and
 * never stops the backend or claims the application stopped. Nothing is
 * replayed after a crash: open channels fail and clients reconnect.
 */
export class PreviewRelaySupervisor {
  private readonly relays = new Map<string, EnvironmentRelay>();
  private readonly crashes = new Map<string, { at: number; count: number }>();
  private readonly spawn: (containerId: string) => RelayProcess;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: PreviewRelaySupervisorOptions) {
    this.spawn = options.spawn ?? dockerRelaySpawn;
    this.now = options.now ?? Date.now;
  }

  stats() {
    let channels = 0;
    for (const relay of this.relays.values()) channels += relay.channels.size;
    return {
      relays: this.relays.size,
      channels,
      crashes: Array.from(this.crashes.values()).reduce((sum, crash) => sum + crash.count, 0),
    };
  }

  /** Whether relay traffic for an environment is currently expected to work. */
  healthy(environmentId: string): boolean {
    const crash = this.crashes.get(environmentId);
    return !crash || this.now() >= crash.at + this.backoff(crash.count);
  }

  private backoff(count: number): number {
    return Math.min(30_000, 1_000 * 2 ** Math.max(0, count - 1));
  }

  async connect(
    target: { environmentId: string; containerId: string; port: number },
    signal: AbortSignal,
  ): Promise<Duplex> {
    if (this.disposed) throw previewFailure("backend-unavailable");
    if (!this.healthy(target.environmentId)) {
      throw previewFailure("backend-unavailable", {
        message: "The container relay is restarting. Retry shortly.",
      });
    }
    let relay = this.relays.get(target.environmentId);
    // A relay belongs to one container: recreation replaces it.
    if (relay && relay.containerId !== target.containerId) {
      relay.shutdown(previewFailure("generation-changed"), true);
      relay = undefined;
    }
    if (!relay || !relay.isAlive) {
      if (this.relays.size >= (this.options.maxRelays ?? 64))
        throw previewFailure("capacity-exceeded");
      relay = new EnvironmentRelay(
        target.environmentId,
        target.containerId,
        this.spawn(target.containerId),
        {
          window: this.options.window ?? 256 * 1024,
          maxChannelsPerEnvironment: this.options.maxChannelsPerEnvironment ?? 64,
          helloTimeoutMs: this.options.helloTimeoutMs ?? 10_000,
          openTimeoutMs: this.options.openTimeoutMs ?? 10_000,
          logger: this.options.logger,
        },
        this.options.allowedPorts(target.environmentId),
        (stopped, deliberate) => {
          if (this.relays.get(stopped.environmentId) === stopped)
            this.relays.delete(stopped.environmentId);
          if (!deliberate && !this.disposed) {
            const previous = this.crashes.get(stopped.environmentId);
            this.crashes.set(stopped.environmentId, {
              at: this.now(),
              count: (previous?.count ?? 0) + 1,
            });
          }
        },
      );
      this.relays.set(target.environmentId, relay);
    }
    relay.updateAllowed(this.options.allowedPorts(target.environmentId));
    const channel = await relay.open(target.port, signal);
    this.crashes.delete(target.environmentId);
    return channel;
  }

  /** Environment stop/delete: owned relays end with the environment. */
  stopEnvironment(environmentId: string): void {
    const relay = this.relays.get(environmentId);
    this.relays.delete(environmentId);
    this.crashes.delete(environmentId);
    relay?.shutdown(previewFailure("environment-stopped"), true);
  }

  /** Operator disabled the relay: end every relay without counting crashes. */
  stopAll(): void {
    for (const environmentId of Array.from(this.relays.keys())) this.stopEnvironment(environmentId);
  }

  dispose(): void {
    this.disposed = true;
    for (const relay of Array.from(this.relays.values())) {
      relay.shutdown(previewFailure("backend-unavailable"), true);
    }
    this.relays.clear();
  }
}
