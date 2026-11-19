import { randomUUID } from "node:crypto";
import type { spawn } from "node:child_process";
import type {
  CredentialRuntime,
  CredentialVaultStatus,
} from "@orkestrator/protocol/agent-credentials";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { CredentialRecordStore } from "./records.js";
import type { CredentialLaunch } from "./runner.js";
import { MemoryCredentialVault, type CredentialVault } from "./vault.js";

/** The conversation a tab runs, as the backend's session record says. */
export interface CredentialSessionInfo {
  agent: string | null;
  logicalSessionKey: string;
  /** The provider conversation; a new one in the same tab ends earlier grants. */
  providerSessionId: string | null;
  /** The session's resolved execution policy, when recorded. */
  policy: NativeAgentExecutionPolicy | null;
}

/** Where an environment's agent runs right now. */
export interface CredentialRuntimeInfo {
  runtime: CredentialRuntime;
  /** Container id, worktree path or coordinator checkout. A change ends grants. */
  identity: string;
}

/**
 * What the credential service needs from the rest of the backend. Every
 * answer is read from the backend's own records, never from the agent.
 */
export interface CredentialHost {
  session(environmentId: string, tabId: string): Promise<CredentialSessionInfo | null>;
  runtime(environmentId: string): Promise<CredentialRuntimeInfo | null>;
  /** Where a tab's credential commands run; throws a user-facing error when they cannot. */
  launch(environmentId: string, tabId: string): Promise<CredentialLaunch>;
}

export interface CredentialServiceOptions {
  records: CredentialRecordStore;
  /** Where saved connections' values live. */
  vault: CredentialVault;
  vaultStatus: CredentialVaultStatus;
  host: CredentialHost;
  /** Parent of worktree runs' private directories (inside the data directory). */
  runRoot: string;
  now?: () => number;
  monotonic?: () => number;
  bootId?: string;
  fetch?: typeof fetch;
  spawnProcess?: typeof spawn;
  /** How often expiry is swept (ms); 0 disables the timer (tests drive `sweep`). */
  sweepIntervalMs?: number;
}

type Waiter = () => void;

/** The state the collaborators share. */
export class CredentialContext {
  readonly records: CredentialRecordStore;
  readonly vault: CredentialVault;
  readonly vaultStatus: CredentialVaultStatus;
  /** Temporary values: this process only, gone on restart. */
  readonly temporary = new MemoryCredentialVault();
  readonly host: CredentialHost;
  readonly runRoot: string;
  readonly now: () => number;
  readonly monotonic: () => number;
  readonly bootId: string;
  readonly fetch: typeof fetch | undefined;
  readonly spawnProcess: typeof spawn | undefined;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private stopped = false;

  constructor(options: CredentialServiceOptions) {
    this.records = options.records;
    this.vault = options.vault;
    this.vaultStatus = options.vaultStatus;
    this.host = options.host;
    this.runRoot = options.runRoot;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.bootId = options.bootId ?? randomUUID();
    this.fetch = options.fetch;
    this.spawnProcess = options.spawnProcess;
  }

  /** Wakes everyone waiting on `key` (a request or operation id). */
  notify(key: string): void {
    const waiting = this.waiters.get(key);
    if (!waiting) return;
    this.waiters.delete(key);
    for (const wake of waiting) wake();
  }

  /**
   * Waits until `ready()` holds or `ms` passes, re-checking on each
   * notification for `key`. Always returns; the caller re-reads the record.
   */
  async waitFor(key: string, ms: number, ready: () => boolean): Promise<void> {
    const deadline = this.monotonic() + ms;
    while (!this.stopped && !ready()) {
      const remaining = deadline - this.monotonic();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const waiting = this.waiters.get(key) ?? new Set<Waiter>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = () => {
          clearTimeout(timer);
          waiting.delete(wake);
          resolve();
        };
        timer = setTimeout(wake, Math.min(remaining, 5_000));
        timer.unref?.();
        waiting.add(wake);
        this.waiters.set(key, waiting);
      });
    }
  }

  /** Shutdown: every waiter returns now and no new wait blocks. */
  wakeAll(): void {
    this.stopped = true;
    for (const key of Array.from(this.waiters.keys())) this.notify(key);
  }

  announce(id: string): void {
    this.records.announce(id);
  }
}
