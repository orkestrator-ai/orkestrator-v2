import { backfillLegacyTestResults } from "@orkestrator/protocol/structured-review";
import {
  isTicketKind,
  isTicketSections,
  normalizeTicketContent,
} from "@orkestrator/protocol/ticket-sections";
import { createHash } from "node:crypto";
import type { StorageMigration } from "./database.js";
import {
  isPersistedNativeAgentSession,
  isNonBlankString,
  isRecord,
  migratePersistedNativeAgentSession,
} from "./shared.js";

/**
 * One-shot upgrades of record shapes that only older builds wrote.
 *
 * The database only ever holds data written by this build or a newer one (a
 * newer database refuses to open, and older builds never open it), so a shape
 * upgraded here once never reappears and its readers need no legacy branch.
 * The data such shapes can come from is the legacy JSON import (version 2),
 * which always runs first.
 *
 * Only upgrades whose old shape no current writer can produce belong here.
 * Readers that default or normalize values current writers may still omit
 * (environment setup phase, agent settings, mail defaults) stay where they are.
 *
 * The exception is the legacy prompt-queue claim: no current writer produces
 * one, but its restore runs on every queue load rather than once
 * ({@link restoreLegacyPromptQueueClaims}), so it needs no schema bump.
 */

/** Same fingerprint the prompt queue records for a failed dispatch. */
export function promptQueueMessageFingerprint(message: unknown): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

/**
 * Native sessions written before `version`, `origin` and `interactionPolicy`
 * existed. Records this build cannot read either way stay verbatim.
 */
export function upgradeNativeAgentSessionRecords(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  const upgraded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    upgraded[key] = isPersistedNativeAgentSession(value, key)
      ? value
      : (migratePersistedNativeAgentSession(value, key) ?? value);
  }
  return upgraded;
}

/**
 * Coordinator bridges were Codex-only, so their persisted identity was named
 * for it. Carrying a live bridge's port and pid over keeps it attached: without
 * them the reaper would not see the running child and the next launch would
 * allocate a second one against the same rollout.
 */
export function upgradeCoordinatorStore(stored: unknown): unknown {
  if (!isRecord(stored) || !isRecord(stored.workspaces)) return stored;
  const rename = (item: Record<string, unknown>): Record<string, unknown> => {
    const { codexBridgePort, codexBridgePid, ...rest } = item;
    if (codexBridgePort === undefined && codexBridgePid === undefined) return item;
    return {
      ...rest,
      ...(rest.bridgePort === undefined && typeof codexBridgePort === "number"
        ? { bridgePort: codexBridgePort }
        : {}),
      ...(rest.bridgePid === undefined && typeof codexBridgePid === "number"
        ? { bridgePid: codexBridgePid }
        : {}),
    };
  };
  const workspaces: Record<string, unknown> = {};
  for (const [projectId, workspace] of Object.entries(stored.workspaces)) {
    if (!isRecord(workspace)) {
      workspaces[projectId] = workspace;
      continue;
    }
    workspaces[projectId] = {
      ...rename(workspace),
      ...(Array.isArray(workspace.conversations)
        ? {
            conversations: workspace.conversations.map((conversation) =>
              isRecord(conversation) ? rename(conversation) : conversation,
            ),
          }
        : {}),
    };
  }
  return { ...stored, workspaces };
}

/**
 * The first dispatch-error implementation did not identify the rejected queue
 * item. Recover it from the restored message so later edits and removals get
 * the same semantics as a newly written error; without that message the error
 * cannot be attributed and is dropped.
 */
export function upgradePromptQueueRecords(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  const upgraded: Record<string, unknown> = {};
  for (const [key, queue] of Object.entries(stored)) {
    const error = isRecord(queue) ? queue.dispatchError : undefined;
    if (
      !isRecord(queue) ||
      !isRecord(error) ||
      (typeof error.messageId === "string" &&
        error.messageId.trim() &&
        typeof error.messageFingerprint === "string" &&
        error.messageFingerprint.trim())
    ) {
      upgraded[key] = queue;
      continue;
    }
    const messages = Array.isArray(queue.messages) ? queue.messages : [];
    const failed = messages.find(
      (candidate) => isRecord(candidate) && candidate.id === error.requestId,
    );
    if (!isRecord(failed) || typeof failed.id !== "string" || !failed.id.trim()) {
      const { dispatchError: _dispatchError, ...withoutError } = queue;
      upgraded[key] = withoutError;
      continue;
    }
    upgraded[key] = {
      ...queue,
      dispatchError: {
        ...error,
        messageId: failed.id,
        messageFingerprint: promptQueueMessageFingerprint(failed),
      },
    };
  }
  return upgraded;
}

/**
 * Backends before v2.30.0-beta could move a queue's head into an exclusive
 * `outstandingClaim` lease. No current writer produces one and nothing reads a
 * claim as a lease any more (to-do 0078 (retired), 2026-11-16), but a claim may
 * still be on disk, and record upgrades are permanent. Every stored claim's
 * message returns to the head, replacing a queued copy of its id, and the
 * claim field is dropped, whatever its lease metadata says. Reads never
 * persist changes; the next queue mutation writes the normalized shape. A
 * corrupt message id gets a deterministic recovery id so it stays deliverable
 * and stable across reads before that write. A claim without a message record
 * is dropped without losing the queue tail.
 */
export function restoreLegacyPromptQueueClaims(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let upgraded: Record<string, unknown> | null = null;
  for (const [key, queue] of Object.entries(stored)) {
    if (!isRecord(queue) || !Object.hasOwn(queue, "outstandingClaim")) continue;
    const { outstandingClaim: claim, ...rest } = queue;
    const message = isRecord(claim) ? claim.message : undefined;
    const messages = rest.messages;
    upgraded ??= { ...stored };
    const restored = isRecord(message)
      ? {
          ...message,
          id: isNonBlankString(message.id)
            ? message.id
            : `legacy-claim-${promptQueueMessageFingerprint(message)}`,
        }
      : undefined;
    upgraded[key] =
      restored && Array.isArray(messages)
        ? {
            ...rest,
            messages: [
              restored,
              ...messages.filter(
                (candidate) => !isRecord(candidate) || candidate.id !== restored.id,
              ),
            ],
          }
        : rest;
  }
  return upgraded ?? stored;
}

/**
 * Every structured review report a pipeline snapshot carries, with
 * `testResults.notRun` backfilled on reports written before it existed.
 *
 * The current writer always stores a parsed report, and `isBuildPipeline`
 * requires the field, so a report without it would make every reader drop the
 * whole pipeline. Used by the one-shot migration and by the legacy localStorage
 * import, the only ways an old report can still arrive.
 */
export function backfillBuildPipelineReviewReports(snapshot: unknown): unknown {
  if (!isRecord(snapshot)) return snapshot;
  let upgraded: Record<string, unknown> = snapshot;
  const set = (key: string, value: unknown) => {
    if (value !== upgraded[key]) upgraded = { ...upgraded, [key]: value };
  };
  /** The same array when no entry changed, so an untouched record stays identical. */
  const mapped = (entries: unknown[], map: (entry: unknown) => unknown): unknown[] => {
    const next = entries.map(map);
    return next.some((entry, index) => entry !== entries[index]) ? next : entries;
  };
  const withReport = (entry: unknown, key: string): unknown => {
    if (!isRecord(entry) || entry[key] === undefined) return entry;
    const report = backfillLegacyTestResults(entry[key]);
    return report === entry[key] ? entry : { ...entry, [key]: report };
  };
  if (snapshot.structuredReview !== undefined) {
    set("structuredReview", backfillLegacyTestResults(snapshot.structuredReview));
  }
  if (Array.isArray(snapshot.sessions)) {
    set(
      "sessions",
      mapped(snapshot.sessions, (session) => withReport(session, "reviewReport")),
    );
  }
  if (Array.isArray(snapshot.roundReviewReports)) {
    set(
      "roundReviewReports",
      mapped(snapshot.roundReviewReports, (round) => withReport(round, "report")),
    );
  }
  return upgraded;
}

/** The `build-pipelines` store with every record's reports backfilled. */
export function upgradeBuildPipelineRecords(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const upgraded: Record<string, unknown> = {};
  for (const [key, record] of Object.entries(stored)) {
    upgraded[key] = record;
    if (!isRecord(record)) continue;
    const snapshot = backfillBuildPipelineReviewReports(record.snapshot);
    if (snapshot === record.snapshot) continue;
    upgraded[key] = { ...record, snapshot };
    changed = true;
  }
  return changed ? upgraded : stored;
}

export const BUILD_PIPELINE_REVIEW_REPORT_UPGRADE_VERSION = 6;

export const buildPipelineReviewReportUpgradeMigration: StorageMigration = {
  version: BUILD_PIPELINE_REVIEW_REPORT_UPGRADE_VERSION,
  name: "backfill-build-pipeline-review-reports",
  up({ database }) {
    const current = database.readStoreValueInTransaction("build-pipelines");
    // Absent or unreadable: nothing an older build wrote is left to upgrade.
    if (!current) return;
    const next = upgradeBuildPipelineRecords(current.value);
    if (next !== current.value) database.writeStoreInTransaction("build-pipelines", next);
  },
};

/**
 * Kanban rows written before ticket sections (v2.21.0 to v2.34.1, #1388), with
 * their kind and sections derived from the text exactly as a read derived
 * them: the text is kept as written, and a legacy `- [x]` becomes a manual
 * pass dated at the ticket's creation. Rows that already have sections are
 * left alone, and so is a row whose text fields are not strings, which no
 * writer produced and which would otherwise lose its text.
 */
export function upgradeKanbanTaskRecords(stored: unknown): unknown {
  if (!Array.isArray(stored)) return stored;
  let changed = false;
  const upgraded = stored.map((row: unknown) => {
    if (!isRecord(row) || isTicketSections(row.sections)) return row;
    const { description, acceptanceCriteria, createdAt } = row;
    if (description !== undefined && typeof description !== "string") return row;
    if (acceptanceCriteria !== undefined && typeof acceptanceCriteria !== "string") return row;
    changed = true;
    const content = normalizeTicketContent(
      {
        ...(isTicketKind(row.kind) ? { kind: row.kind } : {}),
        description: description ?? "",
        acceptanceCriteria: acceptanceCriteria ?? "",
      },
      typeof createdAt === "string" ? { now: createdAt } : {},
    );
    return { ...row, ...content };
  });
  return changed ? upgraded : stored;
}

export const KANBAN_TICKET_SECTIONS_UPGRADE_VERSION = 10;

export const kanbanTicketSectionsUpgradeMigration: StorageMigration = {
  version: KANBAN_TICKET_SECTIONS_UPGRADE_VERSION,
  name: "derive-kanban-ticket-sections",
  up({ database }) {
    const current = database.readStoreValueInTransaction("kanban");
    // Absent or unreadable: nothing an older build wrote is left to upgrade.
    if (!current) return;
    const next = upgradeKanbanTaskRecords(current.value);
    if (next !== current.value) database.writeStoreInTransaction("kanban", next);
  },
};

const RECORD_UPGRADES: ReadonlyArray<readonly [string, (stored: unknown) => unknown]> = [
  ["native-agent-sessions", upgradeNativeAgentSessionRecords],
  ["coordinators", upgradeCoordinatorStore],
  ["prompt-queues", upgradePromptQueueRecords],
];

export const RECORD_SHAPE_UPGRADE_VERSION = 3;

export const recordShapeUpgradeMigration: StorageMigration = {
  version: RECORD_SHAPE_UPGRADE_VERSION,
  name: "upgrade-legacy-record-shapes",
  up({ database }) {
    for (const [store, upgrade] of RECORD_UPGRADES) {
      const current = database.readStoreValueInTransaction(store);
      // Absent or unreadable: nothing an older build wrote is left to upgrade.
      if (!current) continue;
      database.writeStoreInTransaction(store, upgrade(current.value));
    }
  },
};
