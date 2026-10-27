import { createHash } from "node:crypto";
import {
  isNativeAgentSteerRejectedOutcome,
  nativeAsyncQuestionItemId,
  type NativeAgentControlUpdate,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentSessionWithControls } from "./native-agent-session-controls.js";
import type {
  IncompleteTurnNotice,
  PersistedNativeAgentPendingDispatch,
  PersistedNativeAgentPendingSteer,
  PersistedNativeAgentSession,
} from "./models.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
import {
  MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES,
  MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES,
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  isNonBlankString,
  isRecord,
  nowIso,
} from "./storage-shared.js";

/**
 * The per-session delivery journals: a prompt dispatch or steer is recorded
 * on its native agent session before the provider sees it, and settled once
 * the provider acknowledges, refuses or loses it. Each runs under the
 * session's lease (`NativeAgentSessionsRepository`), and a queued steer also
 * moves its item in and out of the prompt queue (`PromptQueueStore`).
 */
export class NativeAgentDeliveries {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  private async scrubPendingNativeAgentSteerBackups(key: string, requestId: string): Promise<void> {
    await this.context.transformSensitiveJsonBackups(
      this.files.nativeAgentSessionsFile(),
      (records) => {
        const record = records[key];
        if (
          isRecord(record) &&
          isRecord(record.pendingSteer) &&
          record.pendingSteer.requestId === requestId
        ) {
          const next = { ...record };
          delete next.pendingSteer;
          return { ...records, [key]: next };
        }
        return records;
      },
    );
  }

  async dispatchNativeAgentPromptOnce(
    key: string,
    requestId: string,
    dispatch: (session: PersistedNativeAgentSession) => Promise<void | {
      dispatched: false;
      mailRefused?: true;
      /** Recorded under the session's persisted notice field; `null` clears it. */
      incompleteTurnNotice?: IncompleteTurnNotice | null;
    }>,
    pendingDispatch?: PersistedNativeAgentPendingDispatch,
    /** Runs after deduplication/conflict checks, under the delivery lease, before journaling. */
    admit?: (session: PersistedNativeAgentSession) => Promise<NativeAgentControlUpdate | undefined>,
  ): Promise<{
    session: PersistedNativeAgentSession;
    dispatched: boolean;
  }> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch key must not be blank");
    }
    if (pendingDispatch) {
      let serialized: string;
      try {
        serialized = JSON.stringify(pendingDispatch);
      } catch {
        throw new Error("Pending native agent dispatch must be JSON serializable");
      }
      if (
        Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES
      ) {
        throw new Error("Pending native agent dispatch exceeds the 32 MB limit");
      }
    }
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      let session = sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingSteer) {
        throw new PendingNativeAgentSteerError(session.pendingSteer.requestId);
      }
      if (session.pendingDispatch && session.pendingDispatch.requestId !== requestId) {
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
      }
      if (session.dispatchedRequestIds?.includes(requestId)) {
        if (session.pendingDispatch?.requestId === requestId) {
          session = { ...session, pendingDispatch: undefined, updatedAt: nowIso() };
          sessions[key] = session;
          await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
          await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(
            key,
            requestId,
          );
        }
        return { session, dispatched: false };
      }

      if (pendingDispatch && pendingDispatch.requestId !== requestId) {
        throw new Error("Pending native agent dispatch request ID mismatch");
      }
      const controlUpdate = await admit?.(session);
      if (controlUpdate) {
        session = nativeAgentSessionWithControls(session, controlUpdate);
        sessions[key] = session;
        await this.repos.nativeAgentSessions.saveNativeAgentSession(key, session);
        this.repos.nativeAgentSessions.announceNativeAgentRecord(session);
      }

      if (pendingDispatch || session.pendingDispatch?.mailRefused) {
        session = {
          ...session,
          // Even a composer retry with the same ID invalidates prior refusal
          // evidence before provider I/O. Its outcome may now be ambiguous.
          pendingDispatch: {
            ...(pendingDispatch ?? session.pendingDispatch!),
            mailRefused: undefined,
          },
          updatedAt: nowIso(),
        };
        sessions[key] = session;
        // Persist before touching the provider. A crash or lost acknowledgement
        // can then replay this exact request through the same idempotency key.
        await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
      }

      // Keep the cross-process lock until the provider has acknowledged this
      // stable request id. If the process dies after provider acceptance but
      // before this write, recovery retries the same id rather than inventing a
      // second turn.
      const outcome = await dispatch(session);
      if (outcome?.dispatched === false) {
        if (outcome.mailRefused && session.pendingDispatch?.requestId === requestId) {
          const updated: PersistedNativeAgentSession = {
            ...session,
            pendingDispatch: { ...session.pendingDispatch, mailRefused: true },
            updatedAt: nowIso(),
          };
          sessions[key] = updated;
          // Persist proof of refusal before cleanup. A restart can release this
          // fence without interpreting a missing provider journal as unsent.
          await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
          this.repos.nativeAgentSessions.announceNativeAgentRecord(updated);
          return { session: updated, dispatched: false };
        }
        if (outcome.incompleteTurnNotice === undefined) {
          // A preparation refusal happens before provider.send. The durable
          // pending row was opened only to protect the provider side effect,
          // so retaining it here would park a request that was never sent and
          // block every later request id for this session.
          if (session.pendingDispatch?.requestId === requestId) {
            const updated: PersistedNativeAgentSession = {
              ...session,
              pendingDispatch: undefined,
              updatedAt: nowIso(),
            };
            sessions[key] = updated;
            await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
            await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(
              key,
              requestId,
            );
            this.repos.nativeAgentSessions.announceNativeAgentRecord(updated);
            return { session: updated, dispatched: false };
          }
          return { session, dispatched: false };
        }
        const updated: PersistedNativeAgentSession = {
          ...session,
          pendingDispatch: undefined,
          ...(outcome.incompleteTurnNotice === null
            ? { openCodeIncompleteTurnNotice: undefined }
            : {
                openCodeIncompleteTurnNotice: outcome.incompleteTurnNotice,
              }),
          updatedAt: nowIso(),
        };
        sessions[key] = updated;
        await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
        await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(key, requestId);
        this.repos.nativeAgentSessions.announceNativeAgentRecord(updated);
        return { session: updated, dispatched: false };
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        // Any successfully accepted prompt supersedes a prior recovery notice.
        openCodeIncompleteTurnNotice: undefined,
        pendingDispatch: undefined,
        retiredDispatch: undefined,
        dispatchedRequestIds: [...(session.dispatchedRequestIds ?? []).slice(-999), requestId],
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
      await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.repos.nativeAgentSessions.announceNativeAgentRecord(updated);
      return { session: updated, dispatched: true };
    });
  }

  /**
   * Record that a parked dispatch is known to have reached the provider.
   *
   * This is the settled end of the ambiguity the pending record exists to
   * describe: the provider has since confirmed it holds this request id, so the
   * record is cleared *and* the id joins `dispatchedRequestIds`. Both halves
   * matter — clearing alone would let a later retry of the same id dispatch the
   * turn a second time, which is the exact outcome the journal exists to
   * prevent.
   *
   * Returns false when this key has no pending record for `requestId`, so a
   * caller racing a real acknowledgement cannot resurrect one.
   */
  async confirmNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch identity must not be blank");
    }
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        retiredDispatch: undefined,
        dispatchedRequestIds: session.dispatchedRequestIds?.includes(requestId)
          ? session.dispatchedRequestIds
          : [...(session.dispatchedRequestIds ?? []).slice(-999), requestId],
        updatedAt: nowIso(),
      };
      await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
      await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.repos.nativeAgentSessions.announceNativeAgentRecord(sessions[key]!);
      return true;
    });
  }

  async clearPendingNativeAgentDispatch(
    key: string,
    requestId: string,
    onlyMailRefused = false,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Pending native agent dispatch identity must not be blank");
    }
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (
        !session ||
        session.pendingDispatch?.requestId !== requestId ||
        (onlyMailRefused && !session.pendingDispatch.mailRefused)
      ) {
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        updatedAt: nowIso(),
      };
      await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
      await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.repos.nativeAgentSessions.announceNativeAgentRecord(sessions[key]!);
      return true;
    });
  }

  /**
   * Resolve a parked dispatch the provider reports lost.
   *
   * The provider recorded this id in an earlier process and will refuse it for
   * good, so the record can never be retried into a turn. It is cleared like a
   * retry refused with `requestIdRetired`, and a content-free
   * `retiredDispatch` marker replaces any earlier one so every renderer can
   * release the draft's id without a click. The id never joins
   * `dispatchedRequestIds`: nothing proves its turn ran.
   *
   * Returns false when this key has no pending record for `requestId`.
   */
  async retireNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch identity must not be blank");
    }
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        retiredDispatch: { requestId, retiredAt: nowIso() },
        updatedAt: nowIso(),
      };
      await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
      await this.repos.nativeAgentSessions.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.repos.nativeAgentSessions.announceNativeAgentRecord(sessions[key]!);
      return true;
    });
  }

  /** Reserve under the session lock before publishing a durable steer record.
   * Lock order is session, then queue. A crash between the two writes leaves
   * an unsent reservation that recoverPromptQueueSteer restores.
   */
  async reservePromptQueueSteer(
    key: string,
    messageId: string,
    expectedRunId: string,
  ): Promise<PersistedNativeAgentPendingSteer | null> {
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = loaded.sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingDispatch)
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
      if (session.pendingSteer)
        throw new PendingNativeAgentSteerError(session.pendingSteer.requestId);
      return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
        const queues = await this.repos.promptQueues.loadPromptQueues();
        const queueKey = `${session.agent}\0${session.logicalSessionKey}`;
        const queue = queues[queueKey];
        if (!queue || queue.environmentId !== session.environmentId) return null;
        if (queue.inFlight || queue.outstandingClaim)
          throw new Error("A queued prompt is already being delivered; refresh before steering");
        const index = queue.messages.findIndex((item) => isRecord(item) && item.id === messageId);
        const message = queue.messages[index];
        if (!isRecord(message)) return null;
        const requestId = isNonBlankString(message.requestId) ? message.requestId : messageId;
        if (
          message.command !== undefined ||
          message.origin !== undefined ||
          nativeAsyncQuestionItemId(messageId) ||
          nativeAsyncQuestionItemId(requestId) ||
          (Array.isArray(message.attachments) && message.attachments.length > 0)
        ) {
          throw new Error("This queued item cannot be steered");
        }
        if (
          !isNonBlankString(message.text) ||
          Buffer.byteLength(message.text, "utf8") > 64 * 1024 ||
          Buffer.byteLength(requestId, "utf8") > 512
        )
          throw new Error("Queued steering text or identity is invalid");
        if (session.dispatchedRequestIds?.includes(requestId)) {
          throw new Error("This queued request was already delivered; refresh before steering");
        }
        const pending: PersistedNativeAgentPendingSteer = {
          requestId,
          text: message.text.trim(),
          inputDigest: createHash("sha256").update(message.text.trim()).digest("hex"),
          expectedRunId,
          state: "prepared",
          sourceQueue: true,
          createdAt: nowIso(),
        };
        queues[queueKey] = {
          ...queue,
          messages: queue.messages.filter((_, i) => i !== index),
          inFlight: { message, requestId, reservedAt: nowIso(), steer: true },
          updatedAt: nowIso(),
          revision: queue.revision + 1,
        };
        await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
        await this.repos.nativeAgentSessions.saveNativeAgentSession(key, {
          ...session,
          pendingSteer: pending,
          updatedAt: nowIso(),
        });
        this.context.changes.announce("prompt-queue", session.environmentId);
        return pending;
      });
    });
  }

  /** Called with the session lock. Persist a terminal intent before touching
   * the source, so restart/retry can finish even an explicit discard exactly once.
   */
  private async finishQueuedSteer(
    session: PersistedNativeAgentSession,
    settlement: "applied" | "restore" | "discard",
  ): Promise<void> {
    const pending = session.pendingSteer;
    if (!pending?.sourceQueue) return;
    await this.repos.nativeAgentSessions.saveNativeAgentSession(session.key, {
      ...session,
      pendingSteer: { ...pending, queueSettlement: settlement },
    });
    await this.settlePromptQueueSteerSource(session, pending.requestId, settlement);
  }

  private async settlePromptQueueSteerSource(
    session: PersistedNativeAgentSession,
    requestId: string,
    settlement: "applied" | "restore" | "discard",
  ): Promise<void> {
    await this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const queueKey = `${session.agent}\0${session.logicalSessionKey}`;
      const queue = queues[queueKey];
      if (
        !queue?.inFlight?.steer ||
        queue.inFlight.requestId !== requestId ||
        queue.environmentId !== session.environmentId
      )
        return;
      const { inFlight, ...rest } = queue;
      queues[queueKey] = {
        ...rest,
        messages:
          settlement === "restore"
            ? [
                inFlight.message,
                ...queue.messages.filter(
                  (item) =>
                    !isRecord(item) ||
                    !isRecord(inFlight.message) ||
                    item.id !== inFlight.message.id,
                ),
              ]
            : queue.messages,
        updatedAt: nowIso(),
        revision: queue.revision + 1,
      };
      await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
      this.context.changes.announce("prompt-queue", session.environmentId);
    });
  }

  private async completePendingSteer(
    session: PersistedNativeAgentSession,
    settlement: "applied" | "restore" | "discard",
  ): Promise<void> {
    const requestId = session.pendingSteer!.requestId;
    await this.finishQueuedSteer(session, settlement);
    const saved = {
      ...session,
      pendingSteer: undefined,
      ...(settlement === "applied"
        ? {
            dispatchedRequestIds: [
              ...(session.dispatchedRequestIds ?? []).filter((id) => id !== requestId).slice(-999),
              requestId,
            ],
          }
        : {}),
      updatedAt: nowIso(),
    };
    await this.repos.nativeAgentSessions.saveNativeAgentSession(session.key, saved);
    await this.scrubPendingNativeAgentSteerBackups(session.key, requestId);
    this.repos.nativeAgentSessions.announceNativeAgentRecord(saved);
  }

  /** The journal read shares dispatch's lock: an absent answer read before a
   * concurrent send must never clear that send's newer ambiguous receipt.
   */
  async reconcileNativeAgentSteer(
    key: string,
    requestId: string,
    readStatus: () => Promise<"dispatched" | "absent" | "unknown">,
  ): Promise<"dispatched" | "absent" | undefined> {
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = loaded.sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) return undefined;
      if (session.pendingSteer.queueSettlement) {
        const settlement = session.pendingSteer.queueSettlement;
        await this.completePendingSteer(session, settlement);
        return settlement === "applied" ? "dispatched" : "absent";
      }
      const status = await readStatus();
      if (status === "unknown") return undefined;
      await this.completePendingSteer(session, status === "dispatched" ? "applied" : "restore");
      return status;
    });
  }

  /** No provider calls: recover an interrupted transfer/settlement under the
   * same lock as dispatch. A live pending receipt always keeps its source reserved.
   */
  async recoverPromptQueueSteer(key: string, requestId: string): Promise<void> {
    await this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = loaded.sessions[key];
      if (!session) return;
      if (session.pendingSteer?.requestId === requestId) {
        const settlement = session.pendingSteer.queueSettlement;
        if (!settlement) return;
        await this.completePendingSteer(session, settlement);
        return;
      }
      await this.settlePromptQueueSteerSource(
        session,
        requestId,
        session.dispatchedRequestIds?.includes(requestId) ? "applied" : "restore",
      );
    });
  }

  /**
   * Persist one backend-owned steering identity across the provider boundary.
   *
   * A provider exception is ambiguous by default: once the request was handed
   * off, this layer cannot prove which side of admission it occurred on. The
   * exact record therefore stays parked as `unknown` and every retry reuses it.
   * Only a returned, verified `rejected` outcome (never a thrown error) proves
   * the provider refused the request before delivery.
   */
  async dispatchNativeAgentSteerOnce(
    key: string,
    pendingSteer: PersistedNativeAgentPendingSteer,
    dispatch: (session: PersistedNativeAgentSession) => Promise<NativeAgentSessionActionOutcome>,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (
      !isNonBlankString(key) ||
      !isNonBlankString(pendingSteer.requestId) ||
      Buffer.byteLength(pendingSteer.requestId, "utf8") > 512 ||
      !isNonBlankString(pendingSteer.text) ||
      Buffer.byteLength(pendingSteer.text, "utf8") > 64 * 1024 ||
      !/^[a-f0-9]{64}$/.test(pendingSteer.inputDigest) ||
      !isNonBlankString(pendingSteer.expectedRunId) ||
      Buffer.byteLength(pendingSteer.expectedRunId, "utf8") > 512
    ) {
      throw new Error("Native agent steer record is invalid");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(pendingSteer);
    } catch {
      throw new Error("Pending native agent steer must be JSON serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES) {
      throw new Error("Pending native agent steer exceeds its persistence limit");
    }

    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      let session = sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingDispatch) {
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
      }
      if (session.dispatchedRequestIds?.includes(pendingSteer.requestId) && !session.pendingSteer) {
        return { outcome: "applied" };
      }
      if (pendingSteer.sourceQueue && session.pendingSteer?.requestId !== pendingSteer.requestId)
        return { outcome: "mismatch" };
      if (session.pendingSteer?.queueSettlement) {
        throw new Error("Queued steering settlement is pending; refresh before retrying");
      }
      if (session.pendingSteer) {
        if (session.pendingSteer.requestId !== pendingSteer.requestId) {
          throw new PendingNativeAgentSteerError(session.pendingSteer.requestId);
        }
        if (
          session.pendingSteer.inputDigest !== pendingSteer.inputDigest ||
          session.pendingSteer.expectedRunId !== pendingSteer.expectedRunId
        ) {
          return { outcome: "unknown", requestId: pendingSteer.requestId };
        }
      } else {
        session = {
          ...session,
          pendingSteer,
          updatedAt: nowIso(),
        };
        sessions[key] = session;
        // The record must be durable before a provider can queue the text.
        await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
      }

      pendingSteer = session.pendingSteer ?? pendingSteer;
      let outcome: NativeAgentSessionActionOutcome;
      try {
        outcome = await dispatch(session);
      } catch {
        outcome = { outcome: "unknown", requestId: pendingSteer.requestId };
      }
      // A refusal is definitive only in its verified shape for this exact
      // request. It then settles like idle/mismatch: the parked record and its
      // backups go, and the id never joins the delivered history.
      if (
        outcome.outcome === "rejected" &&
        !isNativeAgentSteerRejectedOutcome(outcome, pendingSteer.requestId)
      ) {
        outcome = { outcome: "unknown", requestId: pendingSteer.requestId };
      }

      if (outcome.outcome === "unknown") {
        sessions[key] = {
          ...session,
          pendingSteer: { ...pendingSteer, state: "unknown" },
          updatedAt: nowIso(),
        };
        await this.repos.nativeAgentSessions.saveNativeAgentSession(key, sessions[key]);
        this.repos.nativeAgentSessions.announceNativeAgentRecord(sessions[key]!);
        return { ...outcome, requestId: pendingSteer.requestId };
      }

      await this.completePendingSteer(
        session,
        outcome.outcome === "applied" ? "applied" : "restore",
      );
      return outcome;
    });
  }

  async confirmNativeAgentSteer(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent steer identity must not be blank");
    }
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) {
        return false;
      }
      await this.completePendingSteer(session, "applied");
      return true;
    });
  }

  async clearPendingNativeAgentSteer(
    key: string,
    requestId: string,
    discard = false,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent steer identity must not be blank");
    }
    return this.repos.nativeAgentSessions.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.repos.nativeAgentSessions.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.repos.nativeAgentSessions.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) {
        return false;
      }
      await this.completePendingSteer(session, discard ? "discard" : "restore");
      return true;
    });
  }
}
