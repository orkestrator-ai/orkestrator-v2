import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";

/**
 * Directory watches on macOS, held in a helper process.
 *
 * Bun keeps every directory watch of a process in one FSEvents stream. Each
 * `fs.watch` or `close()` makes its FSEvents thread rebuild that stream, holding
 * a lock across the calls into `fseventsd`, and the next `fs.watch` or `close()`
 * on the JavaScript thread waits for the lock. With `fseventsd` busy, as it is on
 * a Mac where agents rewrite thousands of files, one call blocks for seconds, and
 * the rebuild covers every other environment's watches too. Inside the backend
 * that stops every timer, request and child-exit callback, so a delete that
 * closes a few watches stalls everything else and is itself held up by the stall
 * (docs/architecture/environment-deletion.md, "Watches and the event loop").
 *
 * Here those calls block a process that does nothing else. The backend only
 * exchanges messages with it, so a start or close returns at once and events
 * arrive as batches. Linux keeps `fs.watch` in the backend: inotify has no shared
 * stream to rebuild, and the Linux watcher relies on synchronous errors.
 *
 * A watch is a hint source, so a lost helper is not fatal: every open handle
 * reports an error, and its owner falls back to polling and retries as it does
 * for any failed watch. The next start spawns a new helper.
 *
 * Bun rebuilds that one stream from "now" on every `fs.watch` and `close()`
 * (`kFSEventStreamEventIdSinceNow` in its `fs_events.rs`), so whatever happens
 * under any other watch while the stream is rebuilt, about 30 ms, is lost rather
 * than delayed. The helper therefore flags every other live watch after each
 * start or close it performs, and the backend hands the flag to the watch's
 * `onEventsLost` listeners: its owner rescans instead of waiting for the next
 * event or its safety scan (docs/architecture/git-scan-caches.md, "Lost events
 * on macOS").
 */

/** A watch with what `WorktreeWatcher` and its peers use of an `FSWatcher`. */
export interface WatchHandle {
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
  /**
   * Present when the watch is set up after the call returns. Resolves once the
   * helper's `fs.watch` has returned; a failure rejects and also reports through
   * the `error` listener. `fseventsd` can start delivering well after that, and
   * can lose events at any time, so it is not proof that a later change will be
   * reported: that remains the owner's safety scan's job.
   * Closing before readiness rejects with ECANCELED without emitting an error.
   */
  established?: Promise<void>;
  /**
   * Present when events can be lost without an `error`: on macOS another watch
   * starting or closing rebuilds the shared FSEvents stream, and changes made
   * during the rebuild reach no watch. Called at most once per helper flush
   * ({@link WATCH_HOST_FLUSH_MS}); which paths were affected is unknown.
   */
  onEventsLost?(listener: () => void): void;
}

export type WatchListener = (eventType: string, filename: string | null) => void;

/** Events one flush may carry across all watches; the rest collapse to "unknown". */
export const WATCH_HOST_MAX_EVENTS_PER_FLUSH = 2_048;
/** How long the helper gathers events before it sends a batch. */
export const WATCH_HOST_FLUSH_MS = 50;
/** A batch is bounded by the event cap, so a longer line means a broken helper. */
export const WATCH_HOST_MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Runs with `bun -e`, so it needs no file of its own in a build. It writes one
 * batch at a time and keeps collecting while the backend is slow to read: repeats
 * are dropped and anything past the cap becomes the watch's `overflow` flag, so
 * neither side can queue without bound. A start or close that rebuilt the stream
 * sets the `lost` flag of every other live watch; like `overflow` it is one
 * boolean per watch per batch, so a burst of starts costs each watch one flag.
 * It exits when the backend closes stdin, which also covers the backend dying.
 */
export const WATCH_HOST_PROGRAM = String.raw`
const { watch } = require("node:fs");
const MAX_EVENTS = ${WATCH_HOST_MAX_EVENTS_PER_FLUSH};
const FLUSH_MS = ${WATCH_HOST_FLUSH_MS};
const watches = new Map();
const pending = new Map();
let pendingEvents = 0;
let timer = null;
let writing = false;
const write = (message, done) => process.stdout.write(JSON.stringify(message) + "\n", done);
const flush = () => {
  timer = null;
  if (writing || pending.size === 0) return;
  const batches = [];
  for (const [id, batch] of pending) batches.push([id, [...batch.events.values()], batch.overflow, batch.lost]);
  pending.clear();
  pendingEvents = 0;
  writing = true;
  write({ type: "events", batches }, () => {
    writing = false;
    if (pending.size > 0) schedule();
  });
};
const schedule = () => { timer ??= setTimeout(flush, FLUSH_MS); };
const batchOf = (id) => {
  let batch = pending.get(id);
  if (!batch) pending.set(id, (batch = { events: new Map(), overflow: false, lost: false }));
  return batch;
};
// The stream was rebuilt: what happened under every other watch meanwhile is gone.
const rebuilt = (except) => {
  let flagged = false;
  for (const id of watches.keys()) {
    if (id === except) continue;
    batchOf(id).lost = true;
    flagged = true;
  }
  if (flagged) schedule();
};
const record = (id, eventType, filename) => {
  if (!watches.has(id)) return;
  const batch = batchOf(id);
  const name = typeof filename === "string" ? filename : null;
  const key = eventType + ":" + name;
  if (!batch.events.has(key)) {
    if (pendingEvents >= MAX_EVENTS) batch.overflow = true;
    else {
      batch.events.set(key, [eventType, name]);
      pendingEvents += 1;
    }
  }
  schedule();
};
const fail = (id, error) => {
  const handle = watches.get(id);
  if (handle) { watches.delete(id); pending.delete(id); try { handle.close(); } catch {} }
  write({ type: "error", id, code: typeof error?.code === "string" ? error.code : "EWATCH" });
};
const handle = (message) => {
  if (message.op === "close") {
    const open = watches.get(message.id);
    watches.delete(message.id);
    pending.delete(message.id);
    try { open?.close(); } catch {}
    if (open) rebuilt(message.id);
    return;
  }
  try {
    const id = message.id;
    const opened = watch(message.path, { recursive: message.recursive, persistent: true },
      (eventType, filename) => record(id, eventType, filename));
    opened.on("error", (error) => fail(id, error));
    watches.set(id, opened);
    write({ type: "ready", id });
    rebuilt(id);
  } catch (error) {
    fail(message.id, error);
  }
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\n");
  input = lines.pop() ?? "";
  for (const line of lines) if (line) handle(JSON.parse(line));
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
`;

type HostMessage =
  | { type: "ready"; id: number }
  | { type: "error"; id: number; code: string }
  | {
      type: "events";
      /** Watch id, its events, `overflow`, and `lost` (absent from an older helper). */
      batches: Array<[number, Array<[string, string | null]>, boolean, boolean?]>;
    };

type SpawnHost = () => ChildProcess;

/**
 * The helper's working directory is `/` because `bun` reads `bunfig.toml`,
 * `preload` included, and `.env` from it before the program runs. It gets only
 * what starting needs: it holds paths, never a token.
 */
const spawnWatchHostProcess: SpawnHost = () =>
  spawn(process.execPath, ["-e", WATCH_HOST_PROGRAM], {
    cwd: "/",
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });

function hostFailure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`Directory watch failed (${code})`);
  error.code = code;
  return error;
}

class HostedWatch implements WatchHandle {
  readonly established: Promise<void>;
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly lostListeners: Array<() => void> = [];
  private settle!: { resolve: () => void; reject: (error: Error) => void };
  private pendingError: Error | null = null;

  constructor(
    readonly listener: WatchListener,
    private readonly onClose: (watch: HostedWatch) => void,
  ) {
    this.established = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // A failure is also delivered to the `error` listeners, so nothing has to
    // await this; left unhandled it would take the backend down.
    this.established.catch(() => undefined);
  }

  on(_event: "error", listener: (error: Error) => void): this {
    this.errorListeners.push(listener);
    if (this.pendingError) listener(this.pendingError);
    return this;
  }

  onEventsLost(listener: () => void): void {
    this.lostListeners.push(listener);
  }

  close(): void {
    this.settle.reject(hostFailure("ECANCELED"));
    this.onClose(this);
  }

  eventsLost(): void {
    for (const listener of this.lostListeners) listener();
  }

  ready(): void {
    this.settle.resolve();
  }

  fail(error: Error): void {
    this.settle.reject(error);
    if (this.errorListeners.length === 0) this.pendingError = error;
    for (const listener of this.errorListeners) listener(error);
  }
}

/** One helper process and the watches it holds. */
export class WatchHost {
  private child: ChildProcess | null = null;
  private readonly watches = new Map<number, HostedWatch>();
  private nextId = 1;
  private input = "";

  constructor(private readonly spawnHost: SpawnHost = spawnWatchHostProcess) {}

  /** Returns at once; a path that cannot be watched reports through `error`. */
  watch(target: string, listener: WatchListener, options: { recursive: boolean }): WatchHandle {
    const id = this.nextId++;
    const hosted = new HostedWatch(listener, (closing) => {
      if (this.watches.get(id) !== closing) return;
      this.watches.delete(id);
      this.send({ op: "close", id });
    });
    this.watches.set(id, hosted);
    this.send({ op: "watch", id, path: target, recursive: options.recursive });
    return hosted;
  }

  get openWatches(): number {
    return this.watches.size;
  }

  /** Ends the helper. Open watches fail like any lost helper's. */
  stop(): void {
    const child = this.child;
    if (child) this.lost(child, "EWATCHHOST");
  }

  private send(message: object): void {
    try {
      const child = this.child ?? this.start();
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      if (this.child) this.lost(this.child, "EWATCHHOST");
      else this.failAll("EWATCHHOST");
    }
  }

  private start(): ChildProcess {
    const child = this.spawnHost();
    this.child = child;
    this.input = "";
    child.on("error", () => this.lost(child, "EWATCHHOST"));
    child.on("exit", () => this.lost(child, "EWATCHHOST"));
    // Writing to a helper that just died surfaces here, then as its `exit`.
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(child, chunk));
    // The helper must never be the reason the backend stays alive.
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    return child;
  }

  private receive(child: ChildProcess, chunk: string): void {
    if (this.child !== child) return;
    this.input += chunk;
    if (this.input.length > WATCH_HOST_MAX_LINE_CHARS) {
      this.lost(child, "EWATCHHOST");
      return;
    }
    if (!chunk.includes("\n")) return;
    const lines = this.input.split("\n");
    this.input = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let message: HostMessage;
      try {
        message = JSON.parse(line) as HostMessage;
      } catch {
        this.lost(child, "EWATCHHOST");
        return;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: HostMessage): void {
    if (message.type === "ready") {
      this.watches.get(message.id)?.ready();
      return;
    }
    if (message.type === "error") {
      const hosted = this.watches.get(message.id);
      if (!hosted) return;
      this.watches.delete(message.id);
      hosted.fail(hostFailure(message.code));
      return;
    }
    for (const [id, events, overflow, lost] of message.batches) {
      const hosted = this.watches.get(id);
      if (!hosted) continue;
      for (const [eventType, filename] of events) hosted.listener(eventType, filename);
      // Too many to list: the same "unknown path" an unnamed event means.
      if (overflow) hosted.listener("change", null);
      // A listener may close the watch; a closed one hears nothing more.
      if (lost === true && this.watches.get(id) === hosted) hosted.eventsLost();
    }
  }

  private lost(child: ChildProcess, code: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.input = "";
    // This handle is the one we spawned: closing stdin ends it, the kill covers
    // a helper stuck inside a watch call.
    child.stdin?.destroy?.();
    child.kill();
    this.failAll(code);
  }

  private failAll(code: string): void {
    const open = [...this.watches.values()];
    this.watches.clear();
    for (const hosted of open) hosted.fail(hostFailure(code));
  }
}

const sharedHost = new WatchHost();

/**
 * Watches a directory without ever blocking this thread on `fseventsd`. On
 * platforms other than macOS it is plain `fs.watch`.
 */
export function watchDirectory(
  target: string,
  listener: WatchListener,
  options: { recursive: boolean },
  platform: NodeJS.Platform = process.platform,
): WatchHandle {
  if (platform === "darwin") return sharedHost.watch(target, listener, options);
  return watch(target, { recursive: options.recursive, persistent: false }, (eventType, filename) =>
    listener(eventType, filename ?? null),
  );
}
