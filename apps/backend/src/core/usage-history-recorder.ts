import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentContextUsage,
  NativeAgentTurnUsage,
} from "@orkestrator/protocol/native-agent";
import { usageTurnKey } from "./usage-history-record.js";

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
 * write it schedules is serialized and swallows its own failures. Usage
 * history is a report, not state anything depends on.
 *
 * A write that fails gives its turn ids back, so the next read offers them
 * again. Keeping them would drop those turns for the life of the process: the
 * provider republishes the same ids, and nothing else would ever retry.
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
    providerSessionId?: string;
    turns: NativeAgentContextUsage["turns"];
  }) => Promise<number> | number;
}

export interface ObserveUsageInput {
  sessionKey: string;
  environmentId: string;
  platform: AgentPlatform;
  /** Scopes the turn ids; two bridges mint them from a per-session counter. */
  providerSessionId?: string;
  usage: NativeAgentContextUsage | undefined;
}

export class UsageHistoryRecorder {
  /** Session key to the turn keys already written, newest last. */
  private readonly seen = new Map<string, string[]>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: UsageHistoryRecorderOptions) {}

  observe(input: ObserveUsageInput): void {
    const turns = input.usage?.turns;
    if (!turns?.length || !input.sessionKey || !input.environmentId) return;
    const seen = this.seen.get(input.sessionKey) ?? [];
    const fresh: NativeAgentTurnUsage[] = [];
    const keys: string[] = [];
    for (const turn of turns) {
      if (!turn.turnId) continue;
      const key = usageTurnKey(turn.turnId, input.providerSessionId);
      if (seen.includes(key) || keys.includes(key)) continue;
      fresh.push(turn);
      keys.push(key);
    }
    if (fresh.length === 0) return;
    // Remembered before the write so a second observation of the same read
    // cannot queue the same turns twice; the row de-duplicates either way.
    // A write that fails hands them back below.
    const next = [...seen, ...keys];
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
          ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
          turns: fresh,
        }),
      )
      .catch((error: unknown) => {
        // Nothing reached the row, so these turns are offerable again. The
        // durable `turnIds` makes a re-offer idempotent, so a retry cannot
        // count them twice.
        this.release(input.sessionKey, keys);
        console.warn("[usage-history] Could not record agent usage:", error);
      });
  }

  /** Forgets turn keys a failed write never persisted, keeping LRU order. */
  private release(sessionKey: string, keys: readonly string[]): void {
    const seen = this.seen.get(sessionKey);
    if (!seen) return;
    const dropped = new Set(keys);
    const kept = seen.filter((key) => !dropped.has(key));
    if (kept.length === seen.length) return;
    // `Map.set` on a key that is still present keeps its position, so this
    // does not promote a session that only failed to write.
    if (kept.length === 0) this.seen.delete(sessionKey);
    else this.seen.set(sessionKey, kept);
  }

  /** Resolves once every scheduled write has settled. Tests and shutdown. */
  async drain(): Promise<void> {
    await this.writes;
  }

  /** Forgets a session's whole turn memory; the durable row is untouched. */
  forget(sessionKey: string): void {
    this.seen.delete(sessionKey);
  }
}
