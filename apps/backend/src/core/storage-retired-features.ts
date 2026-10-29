import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { StorageDatabase, StorageMigration } from "./storage-database.js";
import { isRecord } from "./storage-shared-core.js";

/**
 * Data of features that no longer exist.
 *
 * Looped Review was removed in favour of Review and Multi Review. Its workflow
 * store is deleted after its provider identities are durably queued for abort.
 * The records it left in shared stores are dropped:
 * nothing reads them any more, and a looped-review claim in the interaction
 * resolution journal would make the whole journal fail validation, which the
 * Build pipeline's interaction handling reads on every claim.
 *
 * The `looped-review` session origin was also used by Multi Review and the
 * Build pipeline's review fan-out. Those sessions are kept and relabelled with
 * the `automated-review` origin that replaced it; only sessions Looped Review
 * itself started (`looped-review:` logical keys) are dropped.
 */

/** Stores no build writes any more; their JSON copies are purged at startup. */
export const RETIRED_LEGACY_STORES: readonly string[] = ["looped-reviews"];

const LOOPED_REVIEW = "looped-review";

function isLoopedReviewSession(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.logicalSessionKey === "string" &&
    value.logicalSessionKey.startsWith(`${LOOPED_REVIEW}:`)
  );
}

/**
 * Native sessions without the ones Looped Review started, and with the Multi
 * Review and review fan-out sessions that shared its origin relabelled.
 */
export function withoutLoopedReviewSessions(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (isLoopedReviewSession(value)) {
      changed = true;
      continue;
    }
    if (isRecord(value) && value.origin === LOOPED_REVIEW) {
      changed = true;
      kept[key] = { ...value, origin: "automated-review" };
      continue;
    }
    kept[key] = value;
  }
  return changed ? kept : stored;
}

/** The interaction resolution journal without Looped Review claims. */
export function withoutLoopedReviewJournalEntries(stored: unknown): unknown {
  if (!isRecord(stored) || !Array.isArray(stored.entries)) return stored;
  const entries = stored.entries.filter(
    (entry) =>
      !isRecord(entry) || !isRecord(entry.claim) || entry.claim.workflowType !== LOOPED_REVIEW,
  );
  return entries.length === stored.entries.length ? stored : { ...stored, entries };
}

const RETIRED_RECORD_FILTERS: ReadonlyArray<readonly [string, (stored: unknown) => unknown]> = [
  ["native-agent-sessions", withoutLoopedReviewSessions],
  ["agent-interaction-resolution-journal", withoutLoopedReviewJournalEntries],
];

export const RETIRE_LOOPED_REVIEWS_VERSION = 5;

export const retireLoopedReviewsMigration: StorageMigration = {
  version: RETIRE_LOOPED_REVIEWS_VERSION,
  name: "retire-looped-reviews",
  up({ database }) {
    queueLoopedReviewSessions(
      database,
      database.readStoreValueInTransaction("looped-reviews")?.value,
      database.readStoreValueInTransaction("native-agent-sessions")?.value,
    );
    for (const store of RETIRED_LEGACY_STORES) database.deleteStoreInTransaction(store);
    for (const [store, filter] of RETIRED_RECORD_FILTERS) {
      const current = database.readStoreValueInTransaction(store);
      // Absent or unreadable: nothing to drop, and an unreadable store stays as it is.
      if (!current) continue;
      const next = filter(current.value);
      if (next !== current.value) database.writeStoreInTransaction(store, next);
    }
  },
};

/** Only provider identities survive retirement; no prompts, diffs or reports. */
export interface RetiredLoopedReviewSession {
  environmentId: string;
  agent: BuildPipelineAgent;
  providerSessionId: string;
}

export const LOOPED_REVIEW_CLEANUP_STORE = "retired-looped-review-sessions";

/** Called inside the migration/archive transaction, before discarding any source. */
export function queueLoopedReviewSessions(
  database: StorageDatabase,
  workflows: unknown,
  nativeSessions?: unknown,
): void {
  const targets = new Map<string, RetiredLoopedReviewSession>();
  const add = (value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.environmentId !== "string" ||
      typeof value.providerSessionId !== "string" ||
      !["claude", "codex", "opencode", "cursor", "grok", "pi"].includes(String(value.agent))
    )
      return;
    const target = value as unknown as RetiredLoopedReviewSession;
    const identity = JSON.stringify([target.environmentId, target.agent, target.providerSessionId]);
    targets.set(identity, {
      environmentId: target.environmentId,
      agent: target.agent,
      providerSessionId: target.providerSessionId,
    });
  };
  const pending = database.readStoreValueInTransaction(LOOPED_REVIEW_CLEANUP_STORE, {
    unreadable: "throw",
  })?.value;
  if (pending !== undefined && !Array.isArray(pending))
    throw new Error("Invalid retired review cleanup queue");
  if (Array.isArray(pending)) pending.forEach(add);
  if (isRecord(workflows)) {
    for (const workflow of Object.values(workflows)) {
      if (!isRecord(workflow)) continue;
      // Persisted workflows wrap the runtime state in snapshot. Accept raw
      // snapshots too, for older JSON recovery copies.
      const snapshot = isRecord(workflow.snapshot) ? workflow.snapshot : workflow;
      if (!Array.isArray(snapshot.sessions)) continue;
      for (const session of snapshot.sessions) {
        if (isRecord(session))
          add({
            ...session,
            environmentId: workflow.environmentId ?? snapshot.environmentId,
            agent: snapshot.agent,
          });
      }
    }
  }
  if (isRecord(nativeSessions)) {
    for (const session of Object.values(nativeSessions)) {
      if (isLoopedReviewSession(session)) add(session);
    }
  }
  const next = [...targets.values()];
  if (next.length > 10_000 || Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024) {
    throw new Error("Retired review cleanup capacity exceeded");
  }
  if (next.length > 0) database.writeStoreInTransaction(LOOPED_REVIEW_CLEANUP_STORE, next);
}

export interface RetirementProvider {
  abort(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<string>;
  dispose?(): Promise<void> | void;
}

/**
 * Abort is only a request. Keep the durable identity until an authoritative
 * observation confirms idle/missing; transport failures and busy turns retry.
 * Acknowledgements merge with the latest queue so concurrent archive recovery
 * cannot lose a newly discovered identity.
 */
export async function reconcileRetiredLoopedReviewSessions(
  database: StorageDatabase,
  providerFor: (target: RetiredLoopedReviewSession) => Promise<RetirementProvider>,
): Promise<void> {
  const pending = database.readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value as
    RetiredLoopedReviewSession[] | undefined;
  for (const target of pending ?? []) {
    let provider: RetirementProvider | undefined;
    try {
      provider = await providerFor(target);
      await provider.abort(target.providerSessionId).catch(() => {
        // A vanished session can reject abort. Only the observation below
        // may confirm that it is gone; an abort error alone proves nothing.
      });
      const status = await provider.status(target.providerSessionId);
      if (status !== "idle" && status !== "missing") continue;
      database.transaction(() => {
        const latest = database.readStoreValueInTransaction(LOOPED_REVIEW_CLEANUP_STORE, {
          unreadable: "throw",
        })?.value as RetiredLoopedReviewSession[] | undefined;
        const remaining = (latest ?? []).filter(
          (entry) =>
            entry.environmentId !== target.environmentId ||
            entry.agent !== target.agent ||
            entry.providerSessionId !== target.providerSessionId,
        );
        if (remaining.length > 0)
          database.writeStoreInTransaction(LOOPED_REVIEW_CLEANUP_STORE, remaining);
        else database.deleteStoreInTransaction(LOOPED_REVIEW_CLEANUP_STORE);
      });
      database.scrubDeletedContent();
    } catch {
      // No provider error text: it can include sensitive transcript content.
      console.warn("[backend] Retired Looped Review turn cleanup remains pending");
    } finally {
      await Promise.resolve()
        .then(() => provider?.dispose?.())
        .catch(() => undefined);
    }
  }
}
