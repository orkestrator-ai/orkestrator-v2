import { useCallback, useEffect, useRef, useState } from "react";
import { PROMPT_QUEUE_EDIT_RENEW_MS } from "@orkestrator/protocol/prompt-queue-edit";
import { PromptQueueActionError } from "@/lib/prompt-queue-errors";
import {
  describePromptQueueEditRefusal,
  queuedPromptEditCommit,
  queuedPromptEditEmpty,
  queuedPromptEditSource,
  type PromptQueueEditBeginResult,
  type PromptQueueEditConflict,
  type PromptQueueEditFinishResult,
  type PromptQueueEditRenewResult,
  type QueuedPromptStoredAttachment,
} from "@/lib/prompt-queue-edit";

/** The commands an in-place edit uses, bound to one queue. */
export interface PromptQueueEditApi {
  begin: (
    messageId: string,
    options?: { takeOver?: boolean },
  ) => Promise<PromptQueueEditBeginResult>;
  renew: (messageId: string, leaseId: string) => Promise<PromptQueueEditRenewResult>;
  finish: (
    messageId: string,
    leaseId: string,
    finish:
      { outcome: "cancel" } | { outcome: "commit"; text: string; attachments?: readonly unknown[] },
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
  /** Commit text and attachments together. */
  save: () => Promise<void>;
  /** Release the lease; the prompt stays queued as it was. */
  cancel: () => Promise<void>;
  /** After a conflict: take the edit back and commit this text over whatever is there. */
  overwrite: () => Promise<void>;
  /** After a conflict: drop this edit and its text. */
  discard: () => void;
  /** Release another client's unfinished edit unchanged so the prompt can be sent. */
  release: (messageId: string) => Promise<void>;
}

function changed(session: PromptQueueEditSession): boolean {
  return (
    session.text !== session.initialText ||
    session.attachments.length !== session.initialAttachments.length
  );
}

/**
 * Edits one queued prompt in place, holding the backend's edit lease and
 * renewing it while the editor is open (`@orkestrator/protocol/prompt-queue-edit`).
 * The composer and its draft are never touched.
 *
 * Unmounting the editor is not a decision about the prompt: an unchanged edit
 * is released, so the prompt carries on as it was, but a changed one is left
 * to expire into review rather than letting the old text be sent.
 */
export function usePromptQueueEdit(api: PromptQueueEditApi): PromptQueueEditController {
  const [session, setSession] = useState<PromptQueueEditSession | null>(null);
  const sessionRef = useRef<PromptQueueEditSession | null>(null);
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  });

  const update = useCallback(
    (next: (current: PromptQueueEditSession) => PromptQueueEditSession | null) => {
      const current = sessionRef.current;
      if (!current) return;
      const value = next(current);
      sessionRef.current = value;
      setSession(value);
    },
    [],
  );
  const replace = useCallback((value: PromptQueueEditSession | null) => {
    sessionRef.current = value;
    setSession(value);
  }, []);

  const leaseId = session && !session.conflict ? session.leaseId : undefined;
  const messageId = session?.messageId;
  // Renew while the lease is held; the interval is stopped on every exit.
  useEffect(() => {
    if (!leaseId || !messageId) return;
    let stopped = false;
    const timer = setInterval(() => {
      void apiRef.current
        .renew(messageId, leaseId)
        .then((result) => {
          if (stopped || result.status !== "conflict") return;
          update((current) =>
            current.leaseId === leaseId ? { ...current, conflict: result.reason } : current,
          );
        })
        // A failed renewal is retried on the next tick; the lease outlasts two misses.
        .catch(() => undefined);
    }, PROMPT_QUEUE_EDIT_RENEW_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [leaseId, messageId, update]);

  // Leaving with an unchanged edit gives the prompt back to the queue.
  useEffect(
    () => () => {
      const current = sessionRef.current;
      if (!current || current.conflict || changed(current)) return;
      void apiRef.current
        .finish(current.messageId, current.leaseId, { outcome: "cancel" })
        .catch(() => undefined);
    },
    [],
  );

  const begin = useCallback(
    async (id: string, options: { takeOver?: boolean } = {}) => {
      const current = sessionRef.current;
      if (current && current.messageId !== id && !current.conflict && changed(current)) {
        throw new PromptQueueActionError(
          "Save or cancel the queued prompt you are editing before editing another.",
        );
      }
      if (current && current.messageId !== id && !current.conflict) {
        await apiRef.current
          .finish(current.messageId, current.leaseId, { outcome: "cancel" })
          .catch(() => undefined);
        replace(null);
      }
      if (current?.messageId === id && !current.conflict) return;
      const result = await apiRef.current.begin(id, options);
      if (result.status !== "editing") {
        throw new PromptQueueActionError(describePromptQueueEditRefusal(result.reason));
      }
      const source = queuedPromptEditSource(result.message);
      // Restarting an edit that hit a conflict keeps what the person typed.
      const kept = current?.messageId === id && current.conflict ? current : undefined;
      replace({
        messageId: id,
        leaseId: result.lease.leaseId,
        referencesStripped: source.referencesStripped,
        initialText: source.text,
        initialAttachments: source.attachments,
        text: kept?.text ?? source.text,
        attachments: kept?.attachments ?? source.attachments,
        busy: false,
      });
    },
    [replace],
  );

  const setText = useCallback(
    (text: string) => update((current) => ({ ...current, text })),
    [update],
  );
  const removeAttachment = useCallback(
    (path: string) =>
      update((current) => ({
        ...current,
        attachments: current.attachments.filter((attachment) => attachment.path !== path),
      })),
    [update],
  );

  const commit = useCallback(
    async (current: PromptQueueEditSession, leaseId: string) => {
      const payload = queuedPromptEditCommit(current, current.text, current.attachments);
      const result = await apiRef.current.finish(current.messageId, leaseId, {
        outcome: "commit",
        text: payload.text,
        attachments: payload.attachments,
      });
      if (result.status === "conflict") {
        update((latest) => ({ ...latest, leaseId, conflict: result.reason, busy: false }));
        return;
      }
      replace(null);
    },
    [replace, update],
  );

  const cancelCurrent = useCallback(
    async (current: PromptQueueEditSession) => {
      update((latest) => ({ ...latest, busy: true }));
      try {
        await apiRef.current.finish(current.messageId, current.leaseId, { outcome: "cancel" });
        replace(null);
      } catch (error) {
        update((latest) => ({ ...latest, busy: false }));
        throw error;
      }
    },
    [replace, update],
  );

  const save = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.busy || current.conflict) return;
    if (queuedPromptEditEmpty(current.text, current.attachments)) {
      throw new PromptQueueActionError(
        "A queued prompt needs text or an attachment. Remove it from the queue instead.",
      );
    }
    if (!changed(current)) {
      await cancelCurrent(current);
      return;
    }
    update((latest) => ({ ...latest, busy: true }));
    try {
      await commit(current, current.leaseId);
    } catch (error) {
      update((latest) => ({ ...latest, busy: false }));
      throw error;
    }
  }, [cancelCurrent, commit, update]);

  const cancel = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.busy) return;
    if (current.conflict) {
      replace(null);
      return;
    }
    await cancelCurrent(current);
  }, [cancelCurrent, replace]);

  const overwrite = useCallback(async () => {
    const current = sessionRef.current;
    if (!current?.conflict || current.busy) return;
    if (current.conflict === "missing") return;
    update((latest) => ({ ...latest, busy: true }));
    try {
      const result = await apiRef.current.begin(current.messageId, { takeOver: true });
      if (result.status !== "editing") {
        update((latest) => ({
          ...latest,
          busy: false,
          conflict: result.reason === "missing" ? "missing" : latest.conflict,
        }));
        if (result.reason !== "missing") {
          throw new PromptQueueActionError(describePromptQueueEditRefusal(result.reason));
        }
        return;
      }
      update((latest) => ({ ...latest, leaseId: result.lease.leaseId, conflict: undefined }));
      await commit({ ...current, conflict: undefined }, result.lease.leaseId);
    } catch (error) {
      update((latest) => ({ ...latest, busy: false }));
      throw error;
    }
  }, [commit, update]);

  const discard = useCallback(() => replace(null), [replace]);

  const release = useCallback(async (id: string) => {
    const result = await apiRef.current.begin(id, { takeOver: true });
    if (result.status !== "editing") {
      throw new PromptQueueActionError(describePromptQueueEditRefusal(result.reason));
    }
    await apiRef.current.finish(id, result.lease.leaseId, { outcome: "cancel" });
  }, []);

  return {
    session,
    begin,
    setText,
    removeAttachment,
    save,
    cancel,
    overwrite,
    discard,
    release,
  };
}
