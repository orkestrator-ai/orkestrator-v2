/**
 * Independent single-session activity reads, coalesced onto the provider's
 * batched no-touch read (efficiency plan step 17, finding E11).
 *
 * Multi Review observes each interactive Fix session under its own workflow's
 * controller fence — one session per workflow — and a supervisor tick advances
 * every such workflow concurrently. Each observation used to be its own
 * `GET /session/:id/activity` request. Here a read waits a short collection
 * window opened by the first read for its provider instance (one bridge
 * connection), then everything collected goes through `readActivityGroup`:
 * one `POST /sessions/activity` per `SESSION_ACTIVITY_BATCH_LIMITS.maxSessions`
 * ids (OpenCode: its group-wide `activityBatch`), with that helper's fallbacks
 * — an older bridge (`unsupported`, remembered per connection by the
 * provider), a rejected chunk and `deferred` ids are read through the single
 * no-touch route.
 *
 * Each caller receives exactly its own session's answer, as a direct read
 * would have given it:
 * - `missing` only where the bridge proved nonexistence;
 * - an id answered `unavailable`, or a failed single read, rejects that caller
 *   alone — never idle, never missing — and withholds no other caller's
 *   answer;
 * - callers are independent: one failure never stops another session's read.
 *
 * A provider without a batch surface, or without a single-session activity
 * read to fall back to, is not coalesced: callers read it directly.
 */
import { SESSION_ACTIVITY_BATCH_LIMITS } from "@orkestrator/protocol/session-activity-batch";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import {
  type ActivityGroupProvider,
  type ActivityGroupRead,
  readActivityGroup,
} from "./native-agent-activity-reads.js";

/**
 * How long the first read for a provider waits for others. Concurrent
 * workflow advances reach their read after independent storage round trips,
 * so they are spread over a few milliseconds rather than one event-loop turn.
 * Background supervision polls every few seconds; this is far below that.
 */
export const ACTIVITY_READ_COALESCE_WINDOW_MS = 25;

interface PendingRead {
  providerSessionId: string;
  resolve: (read: ActivityGroupRead) => void;
  reject: (error: unknown) => void;
}

interface PendingGroup {
  reads: PendingRead[];
  timer: ReturnType<typeof setTimeout>;
}

export class ActivityReadCoalescer {
  private readonly pending = new Map<ActivityGroupProvider, PendingGroup>();

  constructor(private readonly windowMs = ACTIVITY_READ_COALESCE_WINDOW_MS) {}

  /**
   * Whether reads of this provider are coalesced. It needs a batch surface and
   * the single activity read its fallbacks use; anything else keeps the
   * caller's own read path (and its richer status observation).
   */
  static batches(provider: ActivityGroupProvider): boolean {
    return (
      (typeof provider.observeActivityBatch === "function" ||
        typeof provider.activityBatch === "function") &&
      (typeof provider.observeActivity === "function" || typeof provider.activity === "function")
    );
  }

  /** One session's activity, read together with the other reads collected for `provider`. */
  read(provider: ActivityGroupProvider, providerSessionId: string): Promise<ActivityGroupRead> {
    return new Promise<ActivityGroupRead>((resolve, reject) => {
      let group = this.pending.get(provider);
      if (!group) {
        group = {
          reads: [],
          timer: setTimeout(() => void this.flush(provider), this.windowMs),
        };
        this.pending.set(provider, group);
      }
      group.reads.push({ providerSessionId, resolve, reject });
      // A full chunk has nothing left to wait for.
      if (group.reads.length >= SESSION_ACTIVITY_BATCH_LIMITS.maxSessions) {
        void this.flush(provider);
      }
    });
  }

  private async flush(provider: ActivityGroupProvider): Promise<void> {
    const group = this.pending.get(provider);
    if (!group) return;
    clearTimeout(group.timer);
    this.pending.delete(provider);
    const settled = new Set<PendingRead>();
    let failure: unknown;
    try {
      await readActivityGroup({
        provider,
        sessions: group.reads,
        apply: async (read, answer) => {
          settled.add(read);
          read.resolve(answer);
        },
        onReadFailure: (read, error) => {
          settled.add(read);
          read.reject(error);
        },
      });
    } catch (error) {
      failure = error;
    }
    // Every session is answered or reported above; this only keeps a caller
    // from waiting forever on a broken provider contract.
    for (const read of group.reads) {
      if (settled.has(read)) continue;
      read.reject(
        failure ??
          new ProviderUnavailableError(`Provider activity unread for ${read.providerSessionId}`),
      );
    }
  }
}
