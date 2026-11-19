import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PROMPT_QUEUE_EDIT_RENEW_MS } from "@orkestrator/protocol/prompt-queue-edit";
import { PromptQueueActionError } from "@/lib/prompt-queue-errors";
import {
  describePromptQueueEditRefusal,
  queuedPromptEditCommit,
  queuedPromptEditEmpty,
  queuedPromptEditSource,
  type PromptQueueEditBeginResult,
  type PromptQueueEditConflict,
  type PromptQueueEditFinish,
  type PromptQueueEditFinishResult,
  type PromptQueueEditRenewResult,
  type QueuedPromptStoredAttachment,
} from "@/lib/prompt-queue-edit";

/** The commands an in-place edit uses, bound to one queue. */
export interface PromptQueueEditApi {
  queueIdentity?: string;
  begin: (
    messageId: string,
    options?: { takeOver?: boolean },
  ) => Promise<PromptQueueEditBeginResult>;
  renew: (messageId: string, leaseId: string) => Promise<PromptQueueEditRenewResult>;
  finish: (
    messageId: string,
    leaseId: string,
    finish: PromptQueueEditFinish,
  ) => Promise<PromptQueueEditFinishResult>;
}

/** One in-place edit as the editor shows it. */
export interface PromptQueueEditSession {
  messageId: string;
  leaseId: string;
  /** Whether the stored text hid a path-reference block the commit writes back. */
  referencesStripped: boolean;
  /** The text and files the edit began from, to tell whether anything changed. */
  initialText: string;
  initialAttachments: readonly QueuedPromptStoredAttachment[];
  text: string;
  attachments: QueuedPromptStoredAttachment[];
  /** Set when a renewal or a save found the edit no longer holds. */
  conflict?: PromptQueueEditConflict;
  /** A save or cancel is on its way. */
  busy: boolean;
}

export interface PromptQueueEditController {
  session: PromptQueueEditSession | null;
  /** Start editing; a refusal throws a `PromptQueueActionError` with its reason. */
  begin: (messageId: string, options?: { takeOver?: boolean }) => Promise<void>;
  setText: (text: string) => void;
  removeAttachment: (path: string) => void;
  addAttachment: (attachment: QueuedPromptStoredAttachment) => void;
  /** Commit text and attachments together. */
  save: () => Promise<void>;
  /** Release the lease; the prompt stays queued as it was. */
  cancel: () => Promise<void>;
  /** After a conflict: take the edit back and commit this text over whatever is there. */
  overwrite: () => Promise<void>;
  /** After a conflict: drop this edit and its text. */
  discard: () => Promise<void>;
  /** Release another client's unfinished edit unchanged so the prompt can be sent. */
  release: (messageId: string, observedLeaseId: string) => Promise<void>;
}

function changed(session: PromptQueueEditSession): boolean {
  return session.text !== session.initialText || session.attachments !== session.initialAttachments;
}

function ownsLease(session: PromptQueueEditSession): boolean {
  return !session.conflict || session.conflict === "changed";
}

function cancelLease(api: PromptQueueEditApi, messageId: string, leaseId: string) {
  return api.finish(messageId, leaseId, { outcome: "cancel" });
}

interface EditorLifetime {
  queueIdentity?: string;
  session: PromptQueueEditSession | null;
  active: boolean;
  pending: boolean;
}

function cleanUpEdit(lifetime: EditorLifetime, api: PromptQueueEditApi): void {
  const current = lifetime.session;
  // An abandoned dirty edit goes to review. A conflict already shown to
  // this client can be dismissed, including when the client leaves the tab.
  if (current && ownsLease(current) && (current.conflict === "changed" || !changed(current))) {
    void cancelLease(api, current.messageId, current.leaseId).catch(() => undefined);
  }
}

/** One editor per queue, with a single operation guard shared by all entry points. */
export function usePromptQueueEdit(api: PromptQueueEditApi): PromptQueueEditController {
  const { queueIdentity, finish, renew } = api;
  const lifetimeRef = useRef<EditorLifetime | null>(null);
  const [view, setView] = useState<{
    queueIdentity?: string;
    session: PromptQueueEditSession | null;
  } | null>(null);
  if (view && view.queueIdentity !== queueIdentity) setView(null);
  const session = view?.queueIdentity === queueIdentity ? (view?.session ?? null) : null;

  // The queue identity, rather than callback identity, owns a session. Keep
  // the latest bindings for this queue for cleanup and renewal.
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  });

  useLayoutEffect(() => {
    const lifetime: EditorLifetime = { queueIdentity, session: null, active: true, pending: false };
    const boundApi = apiRef.current;
    lifetimeRef.current = lifetime;
    return () => {
      lifetime.active = false;
      if (!lifetime.pending) cleanUpEdit(lifetime, boundApi);
    };
  }, [queueIdentity]);

  const replace = useCallback(
    (lifetime: EditorLifetime, value: PromptQueueEditSession | null) => {
      lifetime.session = value;
      if (lifetime.active) setView({ queueIdentity, session: value });
    },
    [queueIdentity],
  );

  const leaseId = session && !session.conflict ? session.leaseId : undefined;
  const messageId = session?.messageId;
  useEffect(() => {
    const lifetime = lifetimeRef.current;
    if (!leaseId || !messageId || !lifetime) return;
    let renewing = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renew(messageId, leaseId)
        .then((result) => {
          const current = lifetime.session;
          if (!stopped && result.status === "conflict" && current?.leaseId === leaseId) {
            replace(lifetime, { ...current, conflict: result.reason });
          }
        })
        // A failed renewal is retried on the next tick.
        .catch(() => undefined)
        .finally(() => {
          renewing = false;
        });
    }, PROMPT_QUEUE_EDIT_RENEW_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [leaseId, messageId, renew, replace]);

  const perform = async (
    action: (lifetime: EditorLifetime, current: PromptQueueEditSession | null) => Promise<void>,
  ) => {
    const lifetime = lifetimeRef.current;
    if (!lifetime?.active || lifetime.queueIdentity !== queueIdentity) return;
    if (lifetime.pending) {
      throw new PromptQueueActionError("A queued prompt edit action is already in progress.");
    }
    const current = lifetime.session;
    lifetime.pending = true;
    if (current) replace(lifetime, { ...current, busy: true });
    try {
      await action(lifetime, current);
    } finally {
      lifetime.pending = false;
      const latest = lifetime.session;
      if (latest?.busy) replace(lifetime, { ...latest, busy: false });
      if (!lifetime.active) cleanUpEdit(lifetime, api);
    }
  };

  const acquire = async (
    lifetime: EditorLifetime,
    id: string,
    options: { takeOver?: boolean },
    kept?: PromptQueueEditSession,
  ) => {
    const result = await api.begin(id, options);
    if (result.status !== "editing") {
      if (kept && result.reason === "missing") {
        replace(lifetime, { ...kept, conflict: "missing" });
        return null;
      }
      throw new PromptQueueActionError(describePromptQueueEditRefusal(result.reason));
    }
    if (!lifetime.active) {
      await cancelLease(api, id, result.lease.leaseId);
      // A takeover replaced the previous lease, too.
      replace(lifetime, null);
      return null;
    }
    const source = queuedPromptEditSource(result.message);
    const next = {
      messageId: id,
      leaseId: result.lease.leaseId,
      referencesStripped: source.referencesStripped || Boolean(kept?.referencesStripped),
      initialText: source.text,
      initialAttachments: source.attachments,
      text: kept?.text ?? source.text,
      attachments: kept?.attachments ?? source.attachments,
      busy: true,
    };
    replace(lifetime, next);
    return next;
  };

  const begin: PromptQueueEditController["begin"] = (id, options = {}) =>
    perform(async (lifetime, current) => {
      if (current?.messageId === id && !current.conflict) return;
      if (current && current.messageId !== id) {
        if (changed(current)) {
          throw new PromptQueueActionError(
            "Save or discard the queued prompt you are editing before editing another.",
          );
        }
        if (ownsLease(current)) await cancelLease(api, current.messageId, current.leaseId);
        replace(lifetime, null);
      }
      if (!lifetime.active) return;
      await acquire(lifetime, id, options, current?.messageId === id ? current : undefined);
    });

  const edit = (update: (current: PromptQueueEditSession) => PromptQueueEditSession) => {
    const lifetime = lifetimeRef.current;
    if (
      lifetime?.active &&
      lifetime.queueIdentity === queueIdentity &&
      !lifetime.pending &&
      lifetime.session
    ) {
      replace(lifetime, update(lifetime.session));
    }
  };

  const commit = async (lifetime: EditorLifetime, current: PromptQueueEditSession) => {
    const payload = queuedPromptEditCommit(current, current.text, current.attachments);
    const result = await finish(current.messageId, current.leaseId, {
      outcome: "commit",
      text: payload.text,
      attachments: payload.attachments,
    });
    replace(
      lifetime,
      result.status === "conflict" ? { ...current, conflict: result.reason } : null,
    );
  };

  const requireContent = (current: PromptQueueEditSession) => {
    if (queuedPromptEditEmpty(current.text, current.attachments)) {
      throw new PromptQueueActionError(
        "A queued prompt needs text or an attachment. Remove it from the queue instead.",
      );
    }
  };

  const cancel = () =>
    perform(async (lifetime, current) => {
      if (current && ownsLease(current)) await cancelLease(api, current.messageId, current.leaseId);
      replace(lifetime, null);
    });

  return {
    session,
    begin,
    setText: (text) => edit((current) => ({ ...current, text })),
    removeAttachment: (path) =>
      edit((current) => ({
        ...current,
        attachments: current.attachments.filter((attachment) => attachment.path !== path),
      })),
    addAttachment: (attachment) =>
      edit((current) =>
        current.attachments.some((existing) => existing.path === attachment.path)
          ? current
          : {
              ...current,
              referencesStripped: true,
              attachments: [...current.attachments, attachment],
            },
      ),
    save: () =>
      perform(async (lifetime, current) => {
        if (!current || current.conflict) return;
        requireContent(current);
        if (changed(current)) {
          await commit(lifetime, current);
        } else {
          await cancelLease(api, current.messageId, current.leaseId);
          replace(lifetime, null);
        }
      }),
    cancel,
    overwrite: () =>
      perform(async (lifetime, current) => {
        if (!current?.conflict || current.conflict === "missing") return;
        requireContent(current);
        const next = await acquire(lifetime, current.messageId, { takeOver: true }, current);
        if (next) await commit(lifetime, next);
      }),
    discard: cancel,
    release: (id, observedLeaseId) =>
      perform(async () => {
        const result = await finish(id, observedLeaseId, { outcome: "release-expired" });
        if (result.status === "conflict") {
          throw new PromptQueueActionError(
            "This unfinished edit is no longer available to release. Check the current queue.",
          );
        }
      }),
  };
}
