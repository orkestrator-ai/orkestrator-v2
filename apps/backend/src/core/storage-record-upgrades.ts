import { createHash } from "node:crypto";
import type { StorageMigration } from "./storage-database.js";
import {
  isPersistedNativeAgentSession,
  isNonBlankString,
  isRecord,
  migratePersistedNativeAgentSession,
} from "./storage-shared.js";

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
 * The exception is a shape an older backend sharing the same schema version
 * can still write: its upgrade lives here too but runs on every load
 * ({@link restoreLegacyPromptQueueClaims}).
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
 * Older backends sharing this schema can still write exclusive claims. Preserve
 * a live lease verbatim so its holder can settle it, including after unrelated
 * queue writes. On expiry (or malformed lease metadata), restore the message
 * to the head, replacing a queued copy of its id. Reads never persist changes.
 * A corrupt message id gets a deterministic recovery id so it remains both
 * deliverable and stable across reads before the next write.
 */
export function restoreLegacyPromptQueueClaims(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  const now = Date.now();
  let upgraded: Record<string, unknown> | null = null;
  for (const [key, queue] of Object.entries(stored)) {
    if (!isRecord(queue) || !Object.hasOwn(queue, "outstandingClaim")) continue;
    const { outstandingClaim: claim, ...rest } = queue;
    const message = isRecord(claim) ? claim.message : undefined;
    if (
      isRecord(claim) &&
      isRecord(message) &&
      isNonBlankString(claim.token) &&
      typeof claim.claimedAt === "string" &&
      Number.isFinite(Date.parse(claim.claimedAt)) &&
      typeof claim.expiresAt === "string" &&
      Date.parse(claim.expiresAt) > now
    ) {
      continue;
    }
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
