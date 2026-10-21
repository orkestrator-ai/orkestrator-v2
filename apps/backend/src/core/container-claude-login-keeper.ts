import type { CommandContext } from "./commands-context.js";
import { activeClaudeCredentials, syncContainerClaudeLogin } from "./agent-accounts-containers.js";
import { resolveActiveAgentAccount, type ResolvedAgentAccount } from "./agent-accounts-active.js";
import { providerCredentialsAllowed } from "./portable-input-status.js";

/**
 * Keeps running containers signed in to Claude without ever giving them a
 * refresh token.
 *
 * A container's Claude login is access-only (see
 * `restrictClaudeCredentialsSnapshot`): its CLI cannot refresh, so it works
 * until that access token, about eight hours at issue, expires. Only the host
 * refreshes the login. This keeper re-reads the active account's login every
 * few minutes and pushes it into each running container whose copy differs,
 * so a host refresh reaches them while they run. A running container CLI picks
 * the new file up by its mtime.
 *
 * Nothing on the host refreshes the login while the host's own CLI is idle, so
 * just before the access token expires the keeper has the host's CLI refresh
 * it (`refreshHostLogin`). That is the host's own login code, with its own lock
 * and compare-and-swap save, so it cannot race the user's `claude` into
 * spending one refresh token twice. An agent-test profile never does this: it
 * must not rotate the login of the host it borrows.
 */

/** How often the host login is re-read while any container could use it. */
export const CLAUDE_LOGIN_KEEPER_INTERVAL_MS = 5 * 60_000;
/**
 * How long before expiry the host CLI is asked to refresh. Claude Code only
 * refreshes inside the last five minutes, so earlier would be a no-op.
 */
export const CLAUDE_HOST_REFRESH_LEAD_MS = 4 * 60_000;
/**
 * After a failed or ineffective host refresh, wait this long before trying
 * again, doubling each time up to the normal interval.
 */
export const CLAUDE_HOST_REFRESH_RETRY_MS = 60_000;

export interface ClaudeLoginKeeperOptions {
  /** Have the host's own CLI refresh this account's login if it is about to expire. */
  refreshHostLogin?: (account: ResolvedAgentAccount) => Promise<void>;
  syncContainer?: (containerId: string) => Promise<unknown>;
  readCredentials?: () => Promise<string | undefined>;
  now?: () => number;
  intervalMs?: number;
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

interface ClaudeOAuthSummary {
  expiresAt?: number;
  refreshable: boolean;
}

function summarize(credentials: string | undefined): ClaudeOAuthSummary | undefined {
  try {
    const oauth = (JSON.parse(credentials ?? "") as { claudeAiOauth?: unknown }).claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
    const { expiresAt, refreshToken } = oauth as { expiresAt?: unknown; refreshToken?: unknown };
    return {
      ...(typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { expiresAt } : {}),
      refreshable: typeof refreshToken === "string" && refreshToken.trim() !== "",
    };
  } catch {
    return undefined;
  }
}

export class ContainerClaudeLoginKeeper {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly timers: NonNullable<ClaudeLoginKeeperOptions["timers"]>;
  private handle: unknown = null;
  private running: Promise<void> | null = null;
  private refreshing: Promise<ClaudeOAuthSummary | undefined> | null = null;
  private stopped = true;
  /** Expiry the host refresh was last attempted for, when, and how often. */
  private refreshAttempt: { expiresAt: number; at: number; count: number } | null = null;

  constructor(
    private readonly context: CommandContext,
    private readonly options: ClaudeLoginKeeperOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? CLAUDE_LOGIN_KEEPER_INTERVAL_MS;
    this.timers = options.timers ?? systemTimers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  /** One pass; never throws. Returns when the next pass should run, in ms. */
  async tick(): Promise<number> {
    try {
      return await this.pass();
    } catch (error) {
      console.warn(
        "[claude-login-keeper] Pass failed:",
        error instanceof Error ? error.message : String(error),
      );
      return this.intervalMs;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.handle = this.timers.setTimeout(
      () => {
        this.handle = null;
        this.running ??= this.runScheduled();
      },
      Math.max(1_000, delayMs),
    );
  }

  private async runScheduled(): Promise<void> {
    const next = await this.tick();
    this.running = null;
    this.schedule(next);
  }

  private async pass(): Promise<number> {
    // A second backend on this data directory leaves containers to the writer.
    if (this.context.registryWriterLease?.isHeld() === false) return this.intervalMs;
    const { global } = await this.context.storage.loadConfig();
    if (global.useHostClaudeCredentials === false) return this.intervalMs;
    const containers = (await this.context.storage.loadEnvironments()).filter(
      (environment) =>
        environment.containerId &&
        environment.status === "running" &&
        providerCredentialsAllowed(
          this.context,
          global.enabledAgentPlatforms,
          environment,
          "claude",
        ),
    );
    if (containers.length === 0) return this.intervalMs;

    const login = await this.refreshHostIfDue();
    const sync =
      this.options.syncContainer ??
      ((containerId: string) => syncContainerClaudeLogin(this.context, containerId));
    for (const environment of containers) {
      await sync(environment.containerId!);
    }
    return this.nextDelay(login);
  }

  /**
   * Have the host's CLI refresh the active Claude login if it is about to
   * expire or has expired, at most once at a time and with backoff. Also
   * called by a container (bridge) start that found nothing usable to hand
   * over, so it need not wait for the next pass. Returns the login as it is
   * afterwards; never throws.
   */
  refreshHostIfDue(): Promise<ClaudeOAuthSummary | undefined> {
    this.refreshing ??= this.refreshHostOnce().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshHostOnce(): Promise<ClaudeOAuthSummary | undefined> {
    try {
      const { global } = await this.context.storage.loadConfig();
      if (global.useHostClaudeCredentials === false) return undefined;
      const read =
        this.options.readCredentials ?? (() => activeClaudeCredentials(this.context, global));
      const login = summarize(await read());
      if (
        login?.expiresAt === undefined ||
        !login.refreshable ||
        !this.mayRefreshHost(login.expiresAt)
      ) {
        return login;
      }
      const previous = this.refreshAttempt;
      this.refreshAttempt = {
        expiresAt: login.expiresAt,
        at: this.now(),
        count: previous?.expiresAt === login.expiresAt ? previous.count + 1 : 1,
      };
      const refresh = this.options.refreshHostLogin;
      if (!refresh) return login;
      try {
        await refresh(await resolveActiveAgentAccount(this.context, "claude"));
      } catch {
        // CLI output may contain credentials; only fixed diagnostics escape.
        console.warn("[claude-login-keeper] Host Claude refresh failed");
        return summarize(await read());
      }
      const renewed = summarize(await read());
      if (renewed?.expiresAt === undefined || renewed.expiresAt <= login.expiresAt) {
        console.warn("[claude-login-keeper] Host Claude refresh did not extend login expiry");
      }
      return renewed;
    } catch (error) {
      console.warn(
        "[claude-login-keeper] Host Claude refresh check failed:",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }

  /** Inside the refresh window, and not already tried for this token just now. */
  private mayRefreshHost(expiresAt: number): boolean {
    if (this.context.runtimeFlavor === "agent-test") return false;
    if (expiresAt - this.now() > CLAUDE_HOST_REFRESH_LEAD_MS) return false;
    const attempt = this.refreshAttempt;
    return !(
      attempt &&
      attempt.expiresAt === expiresAt &&
      this.now() - attempt.at < this.retryDelay(attempt.count)
    );
  }

  private retryDelay(attempts: number): number {
    return Math.min(this.intervalMs, CLAUDE_HOST_REFRESH_RETRY_MS * 2 ** Math.max(0, attempts - 1));
  }

  private nextDelay(login: ClaudeOAuthSummary | undefined): number {
    if (login?.expiresAt === undefined || !login.refreshable) return this.intervalMs;
    if (this.context.runtimeFlavor === "agent-test") return this.intervalMs;
    const untilWindow = login.expiresAt - CLAUDE_HOST_REFRESH_LEAD_MS - this.now();
    if (untilWindow <= 0) {
      const attempt = this.refreshAttempt;
      return attempt?.expiresAt === login.expiresAt
        ? this.retryDelay(attempt.count)
        : CLAUDE_HOST_REFRESH_RETRY_MS;
    }
    return Math.min(this.intervalMs, untilWindow);
  }
}
