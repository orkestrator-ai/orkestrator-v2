import type { CommandContext } from "./commands-context.js";
import { recurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import {
  InteractiveTmuxTerminalManager,
  type InteractiveTmuxTerminalManagerOptions,
} from "./tmux-interactive.js";
import { ClaudeStatePollManager, type ClaudeStatePollManagerOptions } from "./tmux-poll.js";
import { TmuxSessionManager } from "./tmux-session-manager.js";

/** How often the orphaned-session sweep may run. */
const ORPHAN_SWEEP_INTERVAL_MS = 60_000;

export type TmuxRuntimeOptions = {
  /**
   * The Claude configuration directory a local tmux launch exports. The
   * backend passes the active account's (`tmuxLocalClaudeConfigDirectory` in
   * `commands-servers.ts`): tmux cannot import the account modules, whose
   * imports lead back here. Without one, a launch uses Claude's default.
   */
  localClaudeConfigDirectory?: (context: CommandContext) => Promise<string | undefined>;
  /**
   * Claude state polling. The backend passes the Docker-backed doorbell
   * (`signal`) outside tests; tests inject a reader and timers.
   */
  claudeStatePolls?: ClaudeStatePollManagerOptions;
  interactiveTerminals?: InteractiveTmuxTerminalManagerOptions;
};

/**
 * The claude-tmux state of one backend: its tmux sessions and their install
 * locks (`sessions`), interactive pane terminals, Claude state polls, the
 * serialised activity writes, and the orphaned-session sweep's bookkeeping.
 * Owned by `BackendRuntime` as `tmux` and reached through `context.runtime`
 * at call time; a session's poll loop reaches it through the context it was
 * started with.
 *
 * The tmux server outlives the backend, so `shutdown()` stops this backend's
 * timers (state polls, pane snapshots) but never stops a tmux session.
 */
export class TmuxRuntime {
  readonly sessions = new TmuxSessionManager();
  readonly interactiveTerminals: InteractiveTmuxTerminalManager;
  readonly claudeStatePolls: ClaudeStatePollManager;
  private readonly activityWrites = new Map<string, Promise<void>>();
  /** First time each orphaned tmux session was seen without a managed tab. */
  private readonly orphanMissingSince = new Map<string, number>();
  private lastOrphanSweepAt = 0;
  private readonly configDirectory: (context: CommandContext) => Promise<string | undefined>;
  private readonly removeSignalDiagnostics: () => void;

  constructor(options: TmuxRuntimeOptions = {}) {
    this.configDirectory = options.localClaudeConfigDirectory ?? (async () => undefined);
    this.interactiveTerminals = new InteractiveTmuxTerminalManager(options.interactiveTerminals);
    this.claudeStatePolls = new ClaudeStatePollManager(options.claudeStatePolls);
    this.removeSignalDiagnostics = recurringDiagnosticsRegistry.addSignalSource(
      "claude-state-signal",
      this.claudeStatePolls,
    );
  }

  localClaudeConfigDirectory(context: CommandContext): Promise<string | undefined> {
    return this.configDirectory(context);
  }

  /** Serialize aggregate writes so an older pane observation cannot land last. */
  persistEnvironmentActivity(context: CommandContext, environmentId: string): Promise<void> {
    const storage = context.storage as unknown as {
      getEnvironment?: CommandContext["storage"]["getEnvironment"];
      setEnvironmentAgentActivity?: CommandContext["storage"]["setEnvironmentAgentActivity"];
    };
    // Several command-unit harnesses intentionally provide only the storage
    // methods exercised by that test. Activity persistence is orthogonal there.
    if (!storage.getEnvironment || !storage.setEnvironmentAgentActivity) {
      return Promise.resolve();
    }
    const previous = this.activityWrites.get(environmentId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const state = this.sessions.activityState(environmentId);
        const environment = await storage.getEnvironment!(environmentId);
        const persisted = environment?.agentActivitySources?.["claude-tmux"];
        if (persisted?.state === state) return;
        await storage.setEnvironmentAgentActivity!(
          environmentId,
          state,
          new Date().toISOString(),
          "claude-tmux",
        );
      });
    const settled = operation
      .catch((error) => {
        console.warn(
          `[tmux] failed to persist activity for ${environmentId}:`,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (this.activityWrites.get(environmentId) === settled) {
          this.activityWrites.delete(environmentId);
        }
      });
    this.activityWrites.set(environmentId, settled);
    return settled;
  }

  /** True, and records the sweep, when the previous one is at least a minute old. */
  beginOrphanSweep(now: number): boolean {
    if (now - this.lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return false;
    this.lastOrphanSweepAt = now;
    return true;
  }

  /** When the orphaned session `key` was first seen, recording `now` the first time. */
  orphanFirstSeen(key: string, now: number): number {
    const missingSince = this.orphanMissingSince.get(key);
    if (missingSince !== undefined) return missingSince;
    this.orphanMissingSince.set(key, now);
    return now;
  }

  forgetOrphan(key: string): void {
    this.orphanMissingSince.delete(key);
  }

  shutdown(): void {
    this.claudeStatePolls.shutdownAll();
    this.interactiveTerminals.detachAll();
    this.removeSignalDiagnostics();
  }
}
