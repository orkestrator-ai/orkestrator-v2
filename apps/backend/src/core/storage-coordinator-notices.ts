import type { UsageLimitStop } from "@orkestrator/protocol/coordinator-notices";
import type { StorageContext } from "./storage-context.js";

/**
 * One account's reset window as one coordinator sees it: every stop in it, and
 * which of them have been sent. A flush is recorded before it is sent and
 * cleared after, so a restart resends the same message under the same request id.
 */
export interface UsageLimitNoticeGroup {
  id: string;
  projectId: string;
  accountKey: string;
  resetsAt?: number;
  /** A stop after this opens a new group, and so a new wake. */
  windowEndsAt: number;
  flushAt: number;
  stops: UsageLimitStop[];
  sentStopIds: string[];
  /** Messages sent so far. The first one wakes; later ones are filed. */
  flushes: number;
  sending?: { index: number; stopIds: string[] };
  /** Why the first message was kept without a wake. */
  keptReason?: string;
}

export interface UsageLimitNoticeLedger {
  version: 1;
  /** Stops this machine has already raised, by stop id, oldest first. */
  raised: Record<string, string>;
  groups: UsageLimitNoticeGroup[];
}

export function emptyUsageLimitNoticeLedger(): UsageLimitNoticeLedger {
  return { version: 1, raised: {}, groups: [] };
}

function parseLedger(value: unknown): UsageLimitNoticeLedger {
  const root = value as Partial<UsageLimitNoticeLedger> | null;
  if (!root || root.version !== 1) return emptyUsageLimitNoticeLedger();
  return {
    version: 1,
    raised: root.raised && typeof root.raised === "object" ? root.raised : {},
    groups: Array.isArray(root.groups) ? root.groups : [],
  };
}

/** The durable record behind usage-limit stop notices (`coordinator-usage-limit-notices.ts`). */
export class CoordinatorNoticesRepository {
  constructor(private readonly context: StorageContext) {}

  private file(): string {
    return this.context.file("coordinator-usage-limit-notices.json");
  }

  /** A synchronous read-modify-write of the whole ledger. */
  updateUsageLimitNoticeLedger<T>(mutate: (ledger: UsageLimitNoticeLedger) => T): T {
    return this.context.updateStore<unknown, T>(
      this.file(),
      () => emptyUsageLimitNoticeLedger(),
      (current) => {
        const ledger = parseLedger(current);
        const result = mutate(ledger);
        Object.assign(current as object, ledger);
        return result;
      },
    );
  }
}

export type CoordinatorNoticesStorage = Pick<
  CoordinatorNoticesRepository,
  "updateUsageLimitNoticeLedger"
>;
