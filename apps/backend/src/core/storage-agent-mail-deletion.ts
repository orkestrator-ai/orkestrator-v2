import { metadataMessage, type PersistedAgentMailStore } from "./storage-agent-mail-store.js";

/**
 * What deleting an environment does to the agent mail store, as the rows it
 * changes rather than a new whole store, so the change commits without
 * cloning or reserializing anyone else's mail (todo 6120 task 6):
 *
 * - the environment's own mailboxes are removed, and each of their messages
 *   leaves a body-free counterpart marked undeliverable, so its sender still
 *   sees what became of it;
 * - messages the environment's tabs sent elsewhere lose their body and
 *   subject and are marked expired;
 * - the environment's tabs' idempotency records and queued injects go.
 */
export type EnvironmentMailDeletion = {
  rows: Array<{
    collection: "mailboxes" | "idempotency" | "counterparts";
    key: string;
    /** `undefined` deletes the row. */
    value: unknown;
  }>;
  revision: number;
  pendingInject: PersistedAgentMailStore["pendingInject"];
  /** Mailbox id to project id, for the change announcements. */
  changedMailboxes: Map<string, string | undefined>;
};

/**
 * Plans the deletion of `environmentId`'s mail from `store` without changing
 * it: `store` may be the frozen shared snapshot. Only the mailboxes and
 * messages that change are copied. `null` when the environment has no mail to delete.
 */
export function planEnvironmentMailDeletion(
  store: PersistedAgentMailStore,
  environmentId: string,
): EnvironmentMailDeletion | null {
  const rows: EnvironmentMailDeletion["rows"] = [];
  const changedMailboxes = new Map<string, string | undefined>();
  const sentByEnvironment = (
    message: PersistedAgentMailStore["mailboxes"][string]["messages"][number],
  ) => message.from.kind === "tab" && message.from.environmentId === environmentId;
  for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
    if (mailbox.environmentId === environmentId) {
      for (const message of mailbox.messages) {
        rows.push({
          collection: "counterparts",
          key: message.id,
          value: {
            ...metadataMessage(message),
            placement: "undeliverable",
            placementReason: "recipient-deleted",
            revision: message.revision + 1,
          },
        });
      }
      rows.push({ collection: "mailboxes", key: mailboxId, value: undefined });
      changedMailboxes.set(mailboxId, mailbox.projectId);
      continue;
    }
    if (!mailbox.messages.some(sentByEnvironment)) continue;
    // Shallow copies: only the expired messages are new objects, and the rest
    // are shared with `store` (frozen in the snapshot), never changed.
    let revision = mailbox.revision;
    const messages = mailbox.messages.map((message) => {
      if (!sentByEnvironment(message)) return message;
      revision += 1;
      const { subject: _subject, ...kept } = message;
      return {
        ...kept,
        body: "",
        bodyBytes: 0,
        placement: "expired" as const,
        placementReason: "sender-deleted",
        revision: message.revision + 1,
      };
    });
    const next = { ...mailbox, messages, revision };
    rows.push({ collection: "mailboxes", key: mailboxId, value: next });
    changedMailboxes.set(mailboxId, mailbox.projectId);
  }
  for (const [key, row] of Object.entries(store.idempotency)) {
    if (row.senderScope.startsWith(`tab:${environmentId}\0`)) {
      rows.push({ collection: "idempotency", key, value: undefined });
    }
  }
  const pendingInject = store.pendingInject.filter(
    ({ mailboxId }) => !mailboxId.startsWith(`${environmentId}\0`),
  );
  if (rows.length === 0 && pendingInject.length === store.pendingInject.length) return null;
  return { rows, revision: store.revision + 1, pendingInject, changedMailboxes };
}

/** Applies a planned deletion to a mutable whole store, for the whole-value save. */
export function applyEnvironmentMailDeletion(
  store: PersistedAgentMailStore,
  deletion: EnvironmentMailDeletion,
): void {
  for (const { collection, key, value } of deletion.rows) {
    const records = store[collection] as Record<string, unknown>;
    if (value === undefined) delete records[key];
    else records[key] = value;
  }
  store.revision = deletion.revision;
  store.pendingInject = deletion.pendingInject;
}
