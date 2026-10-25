import { promises as fs } from "node:fs";

import type { CommandContext } from "./commands-context.js";
import {
  PUSHED_LOGIN_PROVIDERS,
  pushedLoginHostFile,
  syncContainerLogin,
  type PushedLoginProvider,
} from "./agent-accounts-containers.js";
import { providerCredentialsAllowed } from "./portable-input-status.js";

/**
 * Hands running containers the host's renewed Grok, OpenCode and Pi logins.
 *
 * Those containers hold the logins access-only, so a bridge session that
 * outlives an access token (about six hours for xAI, eight for Anthropic)
 * would sign out mid-session even though the host's own agent has since
 * refreshed it. Container and bridge starts already push the host's file; this
 * also pushes it whenever the file changes, to every running container that
 * may receive that provider's login, through `syncContainerLogin` (the same
 * bridge-operation queue and revocation fences as a bridge start).
 *
 * It polls each file's identity (inode, size, mtime) instead of watching it:
 * the CLIs replace the file by rename, which a watch on the file loses, and a
 * watch on the parent directory sees every unrelated write. Nothing is read
 * unless the identity changed. A file that disappears is a change too: a host
 * signed out of Grok has the container's imported copy removed.
 *
 * Pi reloads its auth file and OpenCode's OAuth plugins re-read theirs on
 * every request, so a running bridge uses the pushed login without a restart.
 * Whether Grok's agent re-reads `~/.grok/auth.json` during a session is not
 * known; the push keeps the file current, so the bridge's sign-in check
 * (`acpReadiness`, a file read per status poll) and the next Grok process
 * see the renewal without a container restart.
 *
 * Claude is kept current by `ContainerClaudeLoginKeeper`, which cannot poll a
 * file because the macOS login lives in the Keychain. Like the keeper, a
 * backend that does not hold the registry writer lease leaves containers to
 * the one that does.
 */

export const CONTAINER_LOGIN_FILE_POLL_MS = 60_000;

export interface ContainerLoginFileWatcherOptions {
  intervalMs?: number;
  /** A file's identity, or `absent`; any change triggers a push. */
  fingerprint?: (file: string) => Promise<string>;
  syncContainer?: (provider: PushedLoginProvider, containerId: string) => Promise<unknown>;
  timers?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

const systemTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = setTimeout(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

async function fileFingerprint(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

export class ContainerLoginFileWatcher {
  private readonly intervalMs: number;
  private readonly timers: NonNullable<ContainerLoginFileWatcherOptions["timers"]>;
  private readonly seen = new Map<PushedLoginProvider, string>();
  private handle: unknown = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  /** Set by `stop()` only, so a pass run directly (tests) is not cut short. */
  private halted = false;

  constructor(
    private readonly context: CommandContext,
    private readonly options: ContainerLoginFileWatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? CONTAINER_LOGIN_FILE_POLL_MS;
    this.timers = options.timers ?? systemTimers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.schedule();
  }

  /** No further pass is scheduled; one in flight stops before its next container. */
  stop(): void {
    this.stopped = true;
    this.halted = true;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  /** One pass; never throws. Returns the providers whose file changed. */
  async tick(): Promise<PushedLoginProvider[]> {
    try {
      return await this.pass();
    } catch (error) {
      console.warn(
        "[container-login-watcher] Pass failed:",
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.running ??= this.tick().then(() => {
        this.running = null;
        this.schedule();
      });
    }, this.intervalMs);
  }

  private async pass(): Promise<PushedLoginProvider[]> {
    const changed: PushedLoginProvider[] = [];
    for (const provider of PUSHED_LOGIN_PROVIDERS) {
      const file = pushedLoginHostFile(this.context, provider);
      if (!file) continue;
      const fingerprint = await (this.options.fingerprint ?? fileFingerprint)(file);
      const previous = this.seen.get(provider);
      this.seen.set(provider, fingerprint);
      // An unreadable file says nothing about the login, and a first look at
      // a missing one has nothing to take back.
      if (fingerprint === previous || fingerprint === "unreadable") continue;
      if (previous === undefined && fingerprint === "absent") continue;
      changed.push(provider);
    }
    if (changed.length === 0) return changed;
    // A second backend on this data directory leaves containers to the writer.
    if (this.context.registryWriterLease?.isHeld() === false) return changed;
    const { global } = await this.context.storage.loadConfig();
    const environments = (await this.context.storage.loadEnvironments()).filter(
      (environment) => environment.containerId && environment.status === "running",
    );
    const sync =
      this.options.syncContainer ??
      ((provider: PushedLoginProvider, containerId: string) =>
        syncContainerLogin(this.context, provider, containerId));
    for (const provider of changed) {
      for (const environment of environments) {
        if (this.halted) return changed;
        if (
          !providerCredentialsAllowed(
            this.context,
            global.enabledAgentPlatforms,
            environment,
            provider,
          )
        ) {
          continue;
        }
        // `syncContainerLogin` logs its own failures without the payload.
        await sync(provider, environment.containerId!).catch(() => undefined);
      }
    }
    return changed;
  }
}
