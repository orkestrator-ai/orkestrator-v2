import { createInterface } from "node:readline";
import { spawnCommand } from "./commands-dependencies.js";

/**
 * Out-of-memory kills of this installation's containers, from Docker's event
 * stream. `State.OOMKilled` only records the container's main process; when
 * the kernel kills a child (a build, a browser) PID 1 survives and nothing in
 * `docker inspect` says so. Docker still emits an `oom` event for the
 * container's cgroup, which this counts.
 *
 * One `docker events` follower per backend, started on first use, restarted
 * with backoff when it exits (replaying from the moment it stopped, so a
 * restart does not lose events) and stopped at shutdown. Counts are since the
 * first start, per container, bounded in number.
 */

const MAX_TRACKED = 256;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;

type Spawn = (command: string, args: string[]) => ReturnType<typeof spawnCommand>;

export interface OomCount {
  count: number;
  lastAt: string;
}

export class OomEventWatcher {
  private readonly counts = new Map<string, OomCount>();
  private child: ReturnType<typeof spawnCommand> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDelay = RESTART_MIN_MS;
  private stopped = false;
  private running = false;
  /** Unix seconds a restart replays from. */
  private resumeFrom: number | null = null;
  /** The newest event counted (nanoseconds), so a replay counts nothing twice. */
  private lastSeenNano = 0n;

  constructor(
    private readonly owner: string,
    private readonly spawn: Spawn = spawnCommand,
  ) {}

  start(): void {
    if (this.stopped || this.child) return;
    const child = this.spawn("docker", [
      "events",
      "--filter",
      "type=container",
      "--filter",
      "event=oom",
      "--filter",
      `label=orkestrator-owner=${this.owner}`,
      ...(this.resumeFrom !== null ? ["--since", String(this.resumeFrom)] : []),
      "--format",
      "{{.Actor.ID}}\t{{.TimeNano}}",
    ]);
    this.child = child;
    this.running = true;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.record(line));
    // The follower is owned: its failure ends it, never the backend.
    child.on("error", () => this.exited(child));
    child.on("close", () => this.exited(child));
    child.stderr.resume();
  }

  /** Counts since the watcher started, or null when it is not following. */
  count(containerId: string): number | null {
    if (!this.running) return null;
    for (const [id, entry] of this.counts) {
      if (id.startsWith(containerId) || containerId.startsWith(id)) return entry.count;
    }
    return 0;
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  private record(line: string): void {
    const [id = "", nanos = ""] = line.trim().split("\t");
    if (!/^[0-9a-f]{12,64}$/.test(id) || !/^\d{1,20}$/.test(nanos)) return;
    this.restartDelay = RESTART_MIN_MS;
    const at = BigInt(nanos);
    if (at <= this.lastSeenNano) return;
    this.lastSeenNano = at;
    const lastAt = new Date(Number(at / 1_000_000n)).toISOString();
    const current = this.counts.get(id);
    this.counts.delete(id);
    this.counts.set(id, { count: (current?.count ?? 0) + 1, lastAt });
    while (this.counts.size > MAX_TRACKED) {
      const oldest = this.counts.keys().next().value;
      if (oldest === undefined) break;
      this.counts.delete(oldest);
    }
  }

  private exited(child: ReturnType<typeof spawnCommand>): void {
    if (this.child !== child) return;
    this.child = null;
    // Unknown until the follower is back; it then replays the gap.
    this.running = false;
    // From the last event counted when there is one (duplicates are skipped
    // by time), else from shortly before the exit.
    this.resumeFrom =
      this.lastSeenNano > 0n
        ? Number(this.lastSeenNano / 1_000_000_000n)
        : Math.floor(Date.now() / 1000) - 1;
    if (this.stopped) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}

let watcher: OomEventWatcher | null = null;

/** Starts the backend's watcher (idempotent). */
export function startOomEventWatcher(owner: string): void {
  if (watcher) return;
  watcher = new OomEventWatcher(owner);
  watcher.start();
}

/** Kills counted for a container, or null when the backend is not following. */
export function containerOomEvents(containerId: string): number | null {
  return watcher?.count(containerId) ?? null;
}

export function shutdownOomEventWatcher(): void {
  watcher?.stop();
  watcher = null;
}
