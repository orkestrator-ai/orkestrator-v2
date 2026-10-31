import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnCommand } from "./shell.js";
import { terminateProcessTree } from "./process-tree.js";
import {
  OpenCodeAgentToolsReconciler,
  type OpenCodeAgentToolsTuning,
} from "./opencode-agent-tools.js";
import { OpenCodeHostStartGate } from "./opencode-host-start.js";
import { CursorSdkLoginSlot } from "./cursor-sdk-login.js";
import { GitHubCliLoginSlot } from "./github-cli-login.js";
import { PiCatalogProbes, type PiCatalogProbesOptions } from "./pi-catalog-probes.js";

export type LocalServerKind = "opencode" | "claude" | "codex" | "cursor" | "grok" | "pi";
/** The ACP-speaking subset of `LocalServerKind`, launched through the ACP bridge. */
export type AcpLocalServerKind = Extract<LocalServerKind, "grok">;

export const LOCAL_SERVER_KINDS: readonly LocalServerKind[] = [
  "opencode",
  "claude",
  "codex",
  "cursor",
  "grok",
  "pi",
];

/**
 * The registered command that retires one platform's local bridge.
 *
 * Coordinator teardown used to name the Codex command literally, which meant a
 * conversation on any other platform left its bridge, its transcript and its
 * scoped MCP credential running after the tab closed.
 */
export function localServerStopCommandName(kind: LocalServerKind): string {
  return `stop_local_${kind}_server_cmd`;
}

export function retryableBridgeStartupError(
  message: string,
  retryAfterMs = 500,
): Error & { retryable: true; retryAfterMs: number } {
  return Object.assign(new Error(message), { retryable: true as const, retryAfterMs });
}

/** Shape of a base64url-encoded 32-byte bridge token persisted in the container. */
export const BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Codex bridge shutdown can spend five seconds draining app-server before its
// one-second hard-kill fallback. Give that path time to reap the MCP process
// group before escalating the bridge itself.
export const LOCAL_SERVER_SHUTDOWN_GRACE_MS = 8_000;
export const LOCAL_SERVER_KILL_WAIT_MS = 1_000;

/** When an owned bridge process was first seen failing its reuse health check. */
export type LocalServerUnresponsiveMarker = {
  child: ChildProcessWithoutNullStreams;
  since: number;
  lastFailureAt: number;
};

/** What a bridge was launched with, recorded when the backend adopts its process. */
export type LocalServerLaunch = {
  /** Canonical workspace path captured by this bridge generation. */
  workingDirectory: string;
  /** Account bound to a Claude or Codex bridge. */
  accountId?: string;
  /** Expiry of a short-lived token handed to a coordinator Claude or Codex bridge. */
  tokenExpiresAt?: number;
  /**
   * A coordinator Claude or Codex bridge launched with no login to hand over. A sign-in
   * outside Orkestrator's own flow is never announced, so each use checks for one.
   */
  loginless?: boolean;
};

export type LocalServerRuntimeOptions = {
  /** Launches bridge and probe processes; tests substitute a fake child. */
  spawn?: typeof spawnCommand;
  /** Stops a bridge's whole process tree; tests substitute a recorder. */
  terminateProcessTree?: typeof terminateProcessTree;
  openCodeAgentTools?: OpenCodeAgentToolsTuning;
  /** Waits before each retry of a host OpenCode start that lost the database. */
  openCodeLockedStartRetryDelaysMs?: readonly number[];
  piCatalog?: PiCatalogProbesOptions;
};

/**
 * The local agent bridges one backend instance owns: their processes, the
 * renderer credentials and launch facts recorded for each, the per-environment
 * operation queues, and the shutdown gate. Owned by `BackendRuntime` and
 * reached through `context.runtime.localServers` at call time.
 *
 * Keys are `<kind>:<environmentId>`; credential maps are keyed by environment.
 */
export class LocalServerRuntime {
  /** Launches bridge and probe processes. */
  readonly spawn: typeof spawnCommand;
  readonly openCodeAgentTools: OpenCodeAgentToolsReconciler;
  /** Host OpenCode starts, one at a time (`opencode-host-start.ts`). */
  readonly openCodeHostStart: OpenCodeHostStartGate;
  /** Pi's host catalogue probes (`pi-model-catalog-seeding.ts`). */
  readonly piCatalog: PiCatalogProbes;
  /** The single in-flight Cursor SDK sign-in (`cursor-sdk-bridge.ts`). */
  readonly cursorSdkLogin = new CursorSdkLoginSlot();
  /** The single in-flight GitHub CLI sign-in (`github-cli-setup.ts`). */
  readonly gitHubCliLogin = new GitHubCliLoginSlot();

  private readonly terminateTree: typeof terminateProcessTree;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly workingDirectories = new Map<string, string>();
  /** Per-process renderer credentials (bearer tokens; OpenCode's Basic password). */
  private readonly bridgeTokens = new Map<LocalServerKind, Map<string, string>>(
    LOCAL_SERVER_KINDS.map((kind) => [kind, new Map()]),
  );
  /** Credential generation used by each live local Cursor bridge. */
  private readonly cursorCredentialFingerprints = new Map<string, string>();
  private readonly unresponsiveMarkers = new Map<string, LocalServerUnresponsiveMarker>();
  private readonly accountIds = new Map<string, string>();
  private readonly tokenExpiry = new Map<string, number>();
  private readonly loginlessBridges = new Set<string>();
  /**
   * Local bridges that were running when their account was signed in again. They
   * may be holding the old (or missing) login, so each is replaced once idle.
   * Cleared when the bridge is launched.
   */
  private readonly staleLoginBridges = new Set<string>();
  /**
   * Container environments whose Claude login was renewed on the host. An
   * in-process hint; durable login generations and container markers recover
   * missed hints after restart.
   */
  private readonly staleLoginContainerEnvironments = new Set<string>();
  private readonly environmentOperations = new Map<string, Promise<void>>();
  private readonly containerBridgeOperations = new Map<string, Promise<void>>();
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: LocalServerRuntimeOptions = {}) {
    this.spawn = options.spawn ?? spawnCommand;
    this.terminateTree = options.terminateProcessTree ?? terminateProcessTree;
    this.openCodeAgentTools = new OpenCodeAgentToolsReconciler(options.openCodeAgentTools);
    this.openCodeHostStart = new OpenCodeHostStartGate(options.openCodeLockedStartRetryDelaysMs);
    this.piCatalog = new PiCatalogProbes(options.piCatalog);
  }

  // Owned processes

  process(key: string): ChildProcessWithoutNullStreams | undefined {
    return this.processes.get(key);
  }

  processKeys(): string[] {
    return Array.from(this.processes.keys());
  }

  processCount(): number {
    return this.processes.size;
  }

  /** Live local agent bridges and the environment each serves (`<kind>:<environmentId>` keys). */
  localProcessRoots(): Array<{ environmentId: string; pid: number }> {
    const roots: Array<{ environmentId: string; pid: number }> = [];
    for (const [key, child] of this.processes) {
      const separator = key.indexOf(":");
      const pid = child.pid;
      if (separator <= 0 || !pid || pid <= 1 || child.exitCode !== null) continue;
      if (!LOCAL_SERVER_KINDS.includes(key.slice(0, separator) as LocalServerKind)) continue;
      roots.push({ environmentId: key.slice(separator + 1), pid });
    }
    return roots;
  }

  /**
   * Records a spawned bridge as owned by this backend. Short-lived probe
   * processes pass no launch facts.
   */
  adoptProcess(
    key: string,
    child: ChildProcessWithoutNullStreams,
    launch?: LocalServerLaunch,
  ): void {
    this.processes.set(key, child);
    if (!launch) return;
    this.workingDirectories.set(key, launch.workingDirectory);
    if (launch.accountId) this.accountIds.set(key, launch.accountId);
    else this.accountIds.delete(key);
    this.staleLoginBridges.delete(key);
    if (launch.tokenExpiresAt) this.tokenExpiry.set(key, launch.tokenExpiresAt);
    else this.tokenExpiry.delete(key);
    if (launch.loginless) this.loginlessBridges.add(key);
    else this.loginlessBridges.delete(key);
  }

  workingDirectory(key: string): string | undefined {
    return this.workingDirectories.get(key);
  }

  /** Forgets `child` and everything recorded for it, unless a replacement owns the key. */
  releaseOwnership(key: string, child: ChildProcessWithoutNullStreams): boolean {
    if (this.processes.get(key) !== child) return false;
    this.processes.delete(key);
    this.workingDirectories.delete(key);
    this.unresponsiveMarkers.delete(key);
    this.accountIds.delete(key);
    this.tokenExpiry.delete(key);
    this.loginlessBridges.delete(key);
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as LocalServerKind;
    const environmentId = key.slice(separator + 1);
    if (separator > 0 && this.bridgeTokens.has(kind)) {
      this.bridgeTokens.get(kind)!.delete(environmentId);
      if (kind === "opencode") this.openCodeAgentTools.cancel(`local:${environmentId}`);
      if (kind === "cursor") this.cursorCredentialFingerprints.delete(environmentId);
    }
    return true;
  }

  /**
   * Stops one owned server's whole process tree, agent CLIs included.
   *
   * `reason` is logged so an agent that vanished mid-turn can be traced back to
   * the decision that killed it. Short-lived probe bridges omit it.
   */
  async terminate(
    key: string,
    child: ChildProcessWithoutNullStreams,
    reason?: string,
  ): Promise<void> {
    if (reason) {
      console.warn(`[local-server] Stopping ${key} (pid ${child.pid ?? "unknown"}): ${reason}`);
    }
    const exited = await this.terminateTree(child, {
      graceMs: LOCAL_SERVER_SHUTDOWN_GRACE_MS,
      killWaitMs: LOCAL_SERVER_KILL_WAIT_MS,
    });
    if (!exited) {
      // Keep the ownership entry so shutdown or a retry can target it again.
      // Forgetting a process that is still alive recreates the orphan leak.
      throw new Error(`Local server process tree did not exit: ${key}`);
    }
    this.releaseOwnership(key, child);
  }

  // Renderer credentials

  bridgeToken(kind: LocalServerKind, environmentId: string): string | undefined {
    return this.bridgeTokens.get(kind)?.get(environmentId);
  }

  recordBridgeToken(kind: LocalServerKind, environmentId: string, token: string): void {
    this.bridgeTokens.get(kind)?.set(environmentId, token);
  }

  forgetBridgeToken(kind: LocalServerKind, environmentId: string): void {
    this.bridgeTokens.get(kind)?.delete(environmentId);
  }

  cursorCredentialFingerprint(environmentId: string): string | undefined {
    return this.cursorCredentialFingerprints.get(environmentId);
  }

  recordCursorCredentialFingerprint(environmentId: string, fingerprint: string | undefined): void {
    if (fingerprint) this.cursorCredentialFingerprints.set(environmentId, fingerprint);
    else this.cursorCredentialFingerprints.delete(environmentId);
  }

  // Reuse health

  unresponsiveMarker(key: string): LocalServerUnresponsiveMarker | undefined {
    return this.unresponsiveMarkers.get(key);
  }

  markUnresponsive(key: string, marker: LocalServerUnresponsiveMarker): void {
    this.unresponsiveMarkers.set(key, marker);
  }

  /** Clears the marker; with `child`, only when that process is the one it describes. */
  clearUnresponsive(key: string, child?: ChildProcessWithoutNullStreams): void {
    if (child && this.unresponsiveMarkers.get(key)?.child !== child) return;
    this.unresponsiveMarkers.delete(key);
  }

  // Agent accounts and logins

  launchedAccountId(key: string): string | undefined {
    return this.accountIds.get(key);
  }

  launchedTokenExpiry(key: string): number | undefined {
    return this.tokenExpiry.get(key);
  }

  isLoginless(key: string): boolean {
    return this.loginlessBridges.has(key);
  }

  hasStaleLogin(key: string): boolean {
    return this.staleLoginBridges.has(key);
  }

  /**
   * The platform's login was renewed (for OpenCode, any provider login changed).
   * Every live local bridge may hold the old one, so each is replaced the next
   * time it is used while idle.
   */
  markLoginStale(platform: string): void {
    for (const key of this.processes.keys()) {
      if (key.startsWith(`${platform}:`)) this.staleLoginBridges.add(key);
    }
  }

  /** Whether any live local bridge was launched on this account. */
  isAccountInUse(platform: string, accountId: string): boolean {
    for (const [key, launchedWith] of this.accountIds) {
      if (launchedWith !== accountId || !key.startsWith(`${platform}:`)) continue;
      const child = this.processes.get(key);
      if (child && child.exitCode === null && child.signalCode === null) return true;
    }
    return false;
  }

  hasStaleContainerLogin(environmentId: string): boolean {
    return this.staleLoginContainerEnvironments.has(environmentId);
  }

  markContainerLoginStale(environmentId: string): void {
    this.staleLoginContainerEnvironments.add(environmentId);
  }

  clearStaleContainerLogin(environmentId: string): void {
    this.staleLoginContainerEnvironments.delete(environmentId);
  }

  // Operation queues

  /** Serializes start/stop/delete work on one environment's local servers. */
  enqueueEnvironmentOperation<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    return enqueue(this.environmentOperations, environmentId, operation);
  }

  /** Serializes bridge work in one container; keyed by the persisted container ID. */
  enqueueContainerBridgeOperation<T>(
    agent: LocalServerKind,
    containerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return enqueue(this.containerBridgeOperations, `${agent}:${containerId}`, operation);
  }

  hasEnvironmentOperations(): boolean {
    return this.environmentOperations.size > 0;
  }

  /** Resolves true once every queued operation has drained, false at the deadline. */
  async waitForEnvironmentOperations(timeoutMs?: number): Promise<boolean> {
    const drain = async () => {
      while (this.environmentOperations.size > 0) {
        await Promise.allSettled(new Set(this.environmentOperations.values()));
      }
    };

    if (timeoutMs === undefined) {
      await drain();
      return true;
    }
    if (timeoutMs <= 0) {
      return this.environmentOperations.size === 0;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([drain().then(() => true as const), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Shutdown

  isShuttingDown(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Closes admission for everything that would start new owned processes, without
   * waiting for any of it to drain.
   *
   * Shutdown drains lifecycle work first, and that drain can run for minutes on
   * queued Docker operations. Leaving local-server and delete admission open for
   * that whole window would let work start that the subsequent drain then has to
   * clean up — or that a SIGKILL leaves orphaned.
   */
  closeAdmission(): void {
    this.shutdownRequested = true;
    this.openCodeAgentTools.cancelAll();
  }

  /**
   * Drains every local agent server still owned by this backend instance.
   *
   * `operationDrainTimeoutMs` bounds only the queue drain. Once it expires,
   * shutdown still snapshots and terminates every child already owned by this
   * instance. Admission was closed before the wait, and queued starts re-check
   * that gate when they run, so skipping a stuck tail cannot admit a new child
   * later.
   */
  async shutdown(options: { operationDrainTimeoutMs?: number } = {}): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;

    const attempt = (async () => {
      await this.waitForEnvironmentOperations(options.operationDrainTimeoutMs);
      const owned = Array.from(this.processes.entries());
      const results = await Promise.allSettled(
        owned.map(([key, child]) => this.terminate(key, child, "backend shutting down")),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to shut down all local servers");
      }
    })();
    this.shutdownPromise = attempt;

    try {
      await attempt;
    } catch (error) {
      // A retained process can be targeted by an explicit retry.
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
      throw error;
    }
  }
}

function enqueue<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}
