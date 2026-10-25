import { createHash } from "node:crypto";

import type { PreviewListenerAttribution } from "@orkestrator/protocol/preview-services";

import { CommandFailedError, runCommand } from "./shell.js";

/**
 * A process this backend started for an environment: a local terminal's shell
 * or a local agent bridge. Anything they start (a dev server run in the
 * terminal, or by an agent's shell tool) descends from one of them.
 */
export interface ManagedProcessRoot {
  environmentId: string;
  pid: number;
}

export type ListenerOwnership =
  | {
      attribution: "this-environment";
      /** Digest of the listener pid and its start time: changes whenever the server restarts. */
      processKey: string;
    }
  | {
      attribution: Exclude<PreviewListenerAttribution, "this-environment">;
      /** An unchecked command failed transiently; retry without changing the association. */
      retryable?: boolean;
    };

export interface ListenerOwnershipOptions {
  /** Live roots, read at call time. */
  roots: () => readonly ManagedProcessRoot[];
  platform?: NodeJS.Platform;
  runCommand?: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string }>;
  now?: () => number;
  /** A process listing is shared by checks this close together. */
  processCacheMs?: number;
  timeoutMs?: number;
}

interface ListedProcess {
  ppid: number;
  started: string;
}

const MAX_ANCESTRY_DEPTH = 64;

/** `lsof -Fp` lines: `p<pid>` per process, other field lines ignored. */
export function parseLsofPids(stdout: string): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    const match = /^p(\d+)$/.exec(line.trim());
    if (match) pids.add(Number(match[1]));
  }
  return Array.from(pids);
}

/** Only sockets capable of serving the selected loopback address participate.
 * IPv6 wildcard sockets may be dual-stack, so include them for IPv4 too.
 */
function servesLoopback(address: string, family: "ipv4" | "ipv6", type?: string): boolean {
  const host = address.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (host === "*" || host === "::") return type !== "IPv4" || family === "ipv4";
  if (family === "ipv6") return host === "::1";
  return host === "127.0.0.1" || host === "0.0.0.0" || host === "::ffff:127.0.0.1";
}

/** `lsof -F pftn`: keep each file's address, rather than attributing every PID on a port. */
export function parseLsofListeners(stdout: string, family: "ipv4" | "ipv6") {
  const pids = new Set<number>();
  let pid: number | undefined;
  let type: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("f")) type = undefined;
    else if (line.startsWith("t")) type = line.slice(1);
    else if (line.startsWith("n") && pid && servesLoopback(line.slice(1), family, type))
      pids.add(pid);
  }
  return { pids: Array.from(pids), anonymous: false };
}

/** `ss -H -ltnp` rows, including listeners whose process is hidden. */
export function parseSsListeners(stdout: string, family: "ipv4" | "ipv6" = "ipv4") {
  const pids = new Set<number>();
  let anonymous = false;
  for (const line of stdout.split("\n")) {
    const address = line.trim().split(/\s+/)[3];
    if (
      !address ||
      !servesLoopback(address, family, address.startsWith("0.0.0.0:") ? "IPv4" : undefined)
    )
      continue;
    const found = Array.from(line.matchAll(/pid=(\d+)/g), (match) => Number(match[1]));
    if (found.length === 0) anonymous = true;
    for (const pid of found) pids.add(pid);
  }
  return { pids: Array.from(pids), anonymous };
}

/** `ps -A -o pid=,ppid=,lstart=` rows. */
export function parsePsAncestry(stdout: string): Map<number, ListedProcess> {
  const processes = new Map<number, ListedProcess>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    processes.set(Number(match[1]), { ppid: Number(match[2]), started: match[3]! });
  }
  return processes;
}

/**
 * Answers "who is listening on this one registered loopback port?" for
 * backend-loopback preview targets.
 *
 * It looks up only the port a service definition already names (never a
 * range), then walks the listener's parent chain to a process this backend
 * started for an environment. A TCP handshake proves nothing about identity;
 * this proves only "started under this backend's terminal or agent for that
 * environment", which is what `managed-process` means. When the host has
 * neither `lsof` nor (on Linux) `ss`, or the listener belongs to another user,
 * the answer is `unchecked` or `unattributed`, never a guess.
 */
export class LoopbackListenerOwnership {
  private readonly platform: NodeJS.Platform;
  private readonly run: NonNullable<ListenerOwnershipOptions["runCommand"]>;
  private readonly now: () => number;
  private readonly processCacheMs: number;
  private readonly timeoutMs: number;
  private processList: { at: number; promise: Promise<Map<number, ListedProcess>> } | null = null;
  private readonly inflight = new Map<string, Promise<ListenerOwnership>>();
  private checks = 0;
  private unchecked = 0;

  constructor(private readonly options: ListenerOwnershipOptions) {
    this.platform = options.platform ?? process.platform;
    this.run = options.runCommand ?? runCommand;
    this.now = options.now ?? Date.now;
    this.processCacheMs = options.processCacheMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  stats() {
    return { listenerChecks: this.checks, listenerUnchecked: this.unchecked };
  }

  /** Coalesced per port and family. */
  attribute(
    environmentId: string,
    port: number,
    family: "ipv4" | "ipv6",
  ): Promise<ListenerOwnership> {
    const key = `${environmentId}\0${family}\0${port}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.check(environmentId, port, family).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async check(
    environmentId: string,
    port: number,
    family: "ipv4" | "ipv6",
  ): Promise<ListenerOwnership> {
    this.checks += 1;
    if (this.platform !== "darwin" && this.platform !== "linux") return this.markUnchecked();
    const found = await this.findListeners(port, family);
    if ("retryable" in found) return this.markUnchecked(found.retryable);
    const listeners = found.pids;
    if (listeners.length === 0) return { attribution: found.anonymous ? "unattributed" : "none" };

    let processes: Map<number, ListedProcess>;
    try {
      processes = await this.listProcesses();
      // A listener newer than the shared listing is not in it yet.
      if (listeners.some((pid) => !processes.has(pid))) processes = await this.listProcesses(true);
    } catch (error) {
      return this.markUnchecked(!(error instanceof CommandFailedError && error.executableMissing));
    }
    const roots = new Map<number, string>();
    for (const root of this.options.roots()) {
      if (Number.isSafeInteger(root.pid) && root.pid > 1) roots.set(root.pid, root.environmentId);
    }
    const owners = new Set<string>();
    let unattributed = false;
    for (const pid of listeners) {
      const owner = this.ownerOf(pid, processes, roots);
      if (owner) owners.add(owner);
      else unattributed = true;
    }
    if (Array.from(owners).some((owner) => owner !== environmentId)) {
      return { attribution: "other-environment" };
    }
    // This environment's server sharing the port with a stranger (SO_REUSEPORT)
    // has no single owner to report.
    if (owners.size === 0 || unattributed || found.anonymous)
      return { attribution: "unattributed" };
    const leader = Math.min(...listeners);
    const processKey = createHash("sha256")
      .update(`${leader}\0${processes.get(leader)?.started ?? ""}`)
      .digest("hex")
      .slice(0, 16);
    return { attribution: "this-environment", processKey };
  }

  /**
   * Listener pids for one port: `lsof`, or on Linux hosts without it (minimal
   * Debian and Arch installs) `ss` from iproute2. Distinguishes unavailable tools from transient failures.
   */
  private async findListeners(
    port: number,
    family: "ipv4" | "ipv6",
  ): Promise<{ pids: number[]; anonymous: boolean } | { retryable: boolean }> {
    try {
      const { stdout } = await this.run(
        "lsof",
        ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpftn"],
        { timeoutMs: this.timeoutMs },
      );
      return parseLsofListeners(stdout, family);
    } catch (error) {
      // lsof exits 1 when nothing matches. A missing binary or a timeout means
      // the backend cannot tell, which is not the same as "nobody".
      if (!(error instanceof CommandFailedError) || error.timedOut) return { retryable: true };
      if (!error.executableMissing) {
        if (error.stdout) return parseLsofListeners(error.stdout, family);
        if (error.exitCode === 1) return { pids: [], anonymous: false };
        return { retryable: true };
      }
    }
    if (this.platform !== "linux") return { retryable: false };
    try {
      const { stdout } = await this.run("ss", ["-H", "-ltnp", `sport = :${port}`], {
        timeoutMs: this.timeoutMs,
      });
      return parseSsListeners(stdout, family);
    } catch (error) {
      return { retryable: !(error instanceof CommandFailedError && error.executableMissing) };
    }
  }

  private markUnchecked(retryable = false): ListenerOwnership {
    this.unchecked += 1;
    return { attribution: "unchecked", retryable };
  }

  private ownerOf(
    pid: number,
    processes: Map<number, ListedProcess>,
    roots: Map<number, string>,
  ): string | null {
    let current = pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1; depth += 1) {
      const owner = roots.get(current);
      if (owner) return owner;
      const listed = processes.get(current);
      if (!listed || listed.ppid === current) return null;
      current = listed.ppid;
    }
    return null;
  }

  private listProcesses(fresh = false): Promise<Map<number, ListedProcess>> {
    const cached = this.processList;
    if (!fresh && cached && this.now() - cached.at < this.processCacheMs) return cached.promise;
    const promise = this.run("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
      timeoutMs: this.timeoutMs,
    }).then(({ stdout }) => parsePsAncestry(stdout));
    this.processList = { at: this.now(), promise };
    promise.catch(() => {
      if (this.processList?.promise === promise) this.processList = null;
    });
    return promise;
  }
}
