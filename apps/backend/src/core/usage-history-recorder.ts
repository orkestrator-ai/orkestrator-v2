import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";

/**
 * The in-process gate in front of the usage store.
 *
 * Providers republish their last twenty turns on every usage read, and the
 * backend reads usage on every projection, so the same turn is offered to the
 * recorder many times a minute. This keeps the turn ids it has already written
 * per session so a repeated read costs a set lookup rather than a SQLite
 * transaction; the row's own `turnIds` is the durable half, which is what a
 * backend restart falls back on.
 *
 * Recording never blocks a projection: `observe` returns synchronously and the
 * write it schedules is serialized per session and swallows its own failures.
 * Usage history is a report, not state anything depends on.
 */

/** Turn ids remembered per session; the durable row keeps the same number. */
export const RECORDER_TURN_MEMORY = 64;
/** Sessions remembered before the least recently used are forgotten. */
export const RECORDER_SESSION_MEMORY = 512;

export interface UsageHistoryRecorderOptions {
  /** Writes the turns; resolves to how many were new. Rejections are logged. */
  write: (input: {
    sessionKey: string;
    environmentId: string;
    platform: AgentPlatform;
    turns: NativeAgentContextUsage["turns"];
  }) => Promise<number> | number;
}

export interface ObserveUsageInput {
  sessionKey: string;
  environmentId: string;
  platform: AgentPlatform;
  usage: NativeAgentContextUsage | undefined;
}

export class UsageHistoryRecorder {
  /** Session key to the turn ids already written, newest last. */
  private readonly seen = new Map<string, string[]>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: UsageHistoryRecorderOptions) {}

  observe(input: ObserveUsageInput): void {
    const turns = input.usage?.turns;
    if (!turns?.length || !input.sessionKey || !input.environmentId) return;
    const seen = this.seen.get(input.sessionKey) ?? [];
    const fresh = turns.filter((turn) => turn.turnId && !seen.includes(turn.turnId));
    if (fresh.length === 0) return;
    // Remembered before the write so a second observation of the same read
    // cannot queue the same turns twice; the row de-duplicates either way.
    const next = [...seen, ...fresh.map((turn) => turn.turnId)];
    this.seen.delete(input.sessionKey);
    this.seen.set(
      input.sessionKey,
      next.length > RECORDER_TURN_MEMORY ? next.slice(next.length - RECORDER_TURN_MEMORY) : next,
    );
    while (this.seen.size > RECORDER_SESSION_MEMORY) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.writes = this.writes
      .then(() =>
        this.options.write({
          sessionKey: input.sessionKey,
          environmentId: input.environmentId,
          platform: input.platform,
          turns: fresh,
        }),
      )
      .catch((error: unknown) => {
        console.warn("[usage-history] Could not record agent usage:", error);
      });
  }

  /** Resolves once every scheduled write has settled. Tests and shutdown. */
  async drain(): Promise<void> {
    await this.writes;
  }

  /** Forgets a session's turn memory; the durable row is untouched. */
  forget(sessionKey: string): void {
    this.seen.delete(sessionKey);
  }
}
