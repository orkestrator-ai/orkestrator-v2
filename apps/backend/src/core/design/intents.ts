import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  DESIGN_INTENT_LIMITS,
  DESIGN_NOT_RUN_STATES,
  DESIGN_TERMINAL_STATES,
  rebaseOverOwnCommits,
  type DesignFailure,
  type DesignIntentDiscardResult,
  type DesignIntentList,
  type DesignIntentResumeResult,
  type DesignIntentRunResult,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
  type DesignPreconditions,
  type DesignStoredIntent,
} from "@orkestrator/protocol/design-operations";
import { DesignError, toDesignFailure } from "./errors.js";
import { readBounded, writeAtomically, type DesignPrivateRecord } from "./records.js";
import { descriptorSchema, operationToken, preconditionsSchema } from "./schemas.js";
import type { DesignService } from "./service.js";

/**
 * The backend-owned intent queue of one design document: unsent drafts, edits
 * in flight, and failed edits awaiting review. Any client can list, run,
 * resume or discard them; tokens of unknown outcome are reconciled from the
 * backend's own receipts and pending entries, never by preparing again.
 *
 * Stored as a small file beside the pending operations and written only under
 * the canvas lane, so it shares the cross-process lease of every edit.
 */

const opaqueId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._:-]+$/);

/** Presentation only: bounded, but never a reason to refuse the edit it decorates. */
const previewSchema = z
  .object({
    frameId: z.string().min(1).max(100),
    patch: z.record(z.string().max(20), z.union([z.number(), z.string().max(200)])),
  })
  .strict();

export const intentDraftSchema = z
  .object({
    id: opaqueId,
    lane: z.string().min(1).max(100),
    label: z.string().max(200),
    createdAt: z.number().int().nonnegative(),
    descriptor: descriptorSchema,
    preview: previewSchema.optional(),
    gestureKey: z.string().max(200).optional(),
  })
  .strict();

const storedSchema = z
  .array(
    z
      .object({
        id: z.string(),
        clientId: z.string(),
        phase: z.enum(["draft", "preparing", "admitted", "settled"]),
      })
      .passthrough(),
  )
  .max(DESIGN_INTENT_LIMITS.perCanvas + DESIGN_INTENT_LIMITS.settledSuccesses);

/** A legacy per-browser entry (`orkestrator.design.intents.v1`); read leniently. */
const legacySchema = z.object({
  id: opaqueId,
  lane: z.string().min(1).max(100),
  label: z.string().max(200),
  createdAt: z.number().int().nonnegative(),
  descriptor: descriptorSchema,
  phase: z.string().max(20),
  token: operationToken.optional(),
  outcome: z.string().max(20).optional(),
  failure: z
    .object({ code: z.string().max(40), message: z.string().max(2000), retry: z.string().max(20) })
    .passthrough()
    .optional(),
  preview: previewSchema.optional(),
  gestureKey: z.string().max(200).optional(),
});

const RESUME_WAIT_MS = 30_000;
const MAX_QUEUE_BYTES = DESIGN_INTENT_LIMITS.bytes + 256 * 1024;
// Older writers bounded only active entries. Recover those queues without an
// unbounded read: each retained success could once occupy the active budget.
const MAX_LEGACY_QUEUE_BYTES =
  DESIGN_INTENT_LIMITS.bytes * (DESIGN_INTENT_LIMITS.settledSuccesses + 1) + 256 * 1024;

/** Intent ids this process is running now; reconciliation leaves them alone. */
const runningByService = new WeakMap<DesignService, Set<string>>();
function running(service: DesignService): Set<string> {
  let set = runningByService.get(service);
  if (!set) {
    set = new Set();
    runningByService.set(service, set);
  }
  return set;
}
const runKey = (canvasId: string, id: string) => `${canvasId}|${id}`;

function isSuccess(intent: Pick<DesignStoredIntent, "phase" | "outcome">) {
  return (
    intent.phase === "settled" && (intent.outcome === "committed" || intent.outcome === "no-op")
  );
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function sameIntent(a: DesignStoredIntent, b: DesignStoredIntent) {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

export async function readIntents(
  service: DesignService,
  canvasId: string,
): Promise<DesignStoredIntent[]> {
  try {
    const bytes = await readBounded(service.store.intentsFile(canvasId), MAX_LEGACY_QUEUE_BYTES);
    return storedSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    ) as unknown as DesignStoredIntent[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    // Never read an unreadable queue as empty: the next write would lose it.
    throw new DesignError("storage", "Pending design edits could not be read", {
      retry: "after-delay",
    });
  }
}

async function writeIntents(
  service: DesignService,
  canvasId: string,
  intents: DesignStoredIntent[],
) {
  const file = service.store.intentsFile(canvasId);
  if (!intents.length) {
    await unlink(file).catch(() => undefined);
    return;
  }
  const bytes = Buffer.from(JSON.stringify(intents));
  if (bytes.length > MAX_QUEUE_BYTES)
    throw new DesignError("capacity", "Too much pending edit data for this design", {
      retryAfterMs: 1000,
    });
  await writeAtomically(file, bytes, service.store.faults);
}

/** Successes stay briefly so a client that lost a response can still learn them. */
function pruneSuccesses(intents: DesignStoredIntent[], now: number): DesignStoredIntent[] {
  const successes = intents
    .filter(isSuccess)
    .filter((intent) => now - intent.updatedAt < DESIGN_INTENT_LIMITS.settledRetentionMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DESIGN_INTENT_LIMITS.settledSuccesses);
  const kept = new Set(successes);
  let next = intents.filter((intent) => !isSuccess(intent) || kept.has(intent));
  // Receipts remain authoritative after removing these presentation entries.
  // Prune oldest successes first, including when timestamps tie.
  const oldest = [...successes].sort((a, b) => a.updatedAt - b.updatedAt);
  while (oldest.length && Buffer.byteLength(JSON.stringify(next)) > MAX_QUEUE_BYTES) {
    const removed = oldest.shift()!;
    next = next.filter((intent) => intent !== removed);
  }
  return next;
}

function assertBounds(intents: DesignStoredIntent[], clientId: string) {
  const bounded = pruneSuccesses(intents, Number.NEGATIVE_INFINITY);
  intents.splice(0, intents.length, ...bounded);
  const active = intents.filter((intent) => !isSuccess(intent));
  if (
    active.length > DESIGN_INTENT_LIMITS.perCanvas ||
    active.filter((intent) => intent.clientId === clientId).length > DESIGN_INTENT_LIMITS.perClient
  )
    throw new DesignError(
      "capacity",
      "Too many design edits are waiting; review or discard some first",
      { retryAfterMs: 1000 },
    );
  if (Buffer.byteLength(JSON.stringify(active)) > DESIGN_INTENT_LIMITS.bytes)
    throw new DesignError("capacity", "Too much pending edit data for this design", {
      retryAfterMs: 1000,
    });
}

function currentOf(record: DesignPrivateRecord) {
  return {
    canvasRevision: record.document.revision,
    frames: new Map(
      record.document.frames.map((frame) => [
        frame.id,
        { revision: frame.revision, structureId: record.frames[frame.id]?.structureId },
      ]),
    ),
  };
}

/**
 * Reads and rewrites the queue under the canvas lane. Every change publishes a
 * content-free `status` hint flagged `intents`, so other clients re-list.
 */
async function mutate<T>(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  work: (
    intents: DesignStoredIntent[],
    record: DesignPrivateRecord,
  ) => Promise<{ intents?: DesignStoredIntent[]; value: T }>,
): Promise<T> {
  await service.initialize();
  return service.lane(canvasId, async () => {
    const { record } = await service.loadFor(canvasId, environmentId, { allowDeleted: true });
    const before = await readIntents(service, canvasId);
    const pruned = pruneSuccesses(before, service.now().getTime());
    const { intents, value } = await work(pruned, record);
    const next = pruneSuccesses(intents ?? pruned, service.now().getTime());
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      await writeIntents(service, canvasId, next);
      service.publish({
        canvasId,
        revision: record.document.revision,
        kind: "status",
        statusVersion: record.statusVersion,
        intents: true,
      });
    }
    return value;
  });
}

function settledFailure(status: DesignOperationStatus): DesignFailure {
  return (
    status.failure ?? {
      code: "unknown-outcome",
      message: `This edit was ${status.state}`,
      retry: "review",
    }
  );
}

/** The intent after an authoritative status for its token. */
function withStatus(
  intent: DesignStoredIntent,
  status: DesignOperationStatus,
  now: number,
): DesignStoredIntent {
  let next: DesignStoredIntent;
  if (status.state === "prepared" || status.state === "executing") {
    // No outcome on an admitted intent means prepared and not started.
    next = compact({
      ...intent,
      phase: "admitted",
      token: status.token,
      outcome: status.state === "executing" ? ("executing" as const) : undefined,
      updatedAt: now,
    });
  } else {
    const success = status.state === "committed" || status.state === "no-op";
    next = compact({
      ...intent,
      phase: "settled",
      token: status.token,
      outcome: status.state,
      failure: success ? undefined : settledFailure(status),
      result: status.result,
      updatedAt: now,
    });
  }
  return sameIntent(next, intent) ? intent : next;
}

async function tokenByCorrelation(
  service: DesignService,
  record: DesignPrivateRecord,
  canvasId: string,
  correlationId: string | undefined,
): Promise<string | undefined> {
  if (!correlationId) return undefined;
  const receipt = record.receipts.find((candidate) => candidate.correlationId === correlationId);
  if (receipt) return receipt.token;
  const pending = await service.store.readPending(canvasId);
  return pending.find((entry) => entry.descriptor.correlationId === correlationId)?.token;
}

function needsReconcile(service: DesignService, canvasId: string, intent: DesignStoredIntent) {
  if (running(service).has(runKey(canvasId, intent.id))) return false;
  if (intent.phase === "preparing") return true;
  return (
    Boolean(intent.token) &&
    (intent.phase === "admitted" || (intent.phase === "settled" && intent.outcome === "unknown"))
  );
}

/**
 * Resolves one intent from backend state: a `preparing` intent adopts the
 * token its correlation id was prepared under (or, once no live call owns it,
 * becomes a draft again); a token of unknown outcome takes its status.
 */
async function reconcile(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  record: DesignPrivateRecord,
  intent: DesignStoredIntent,
  now: number,
): Promise<DesignStoredIntent> {
  if (!needsReconcile(service, canvasId, intent)) return intent;
  let next = intent;
  if (next.phase === "preparing") {
    const token = await tokenByCorrelation(
      service,
      record,
      canvasId,
      next.descriptor.correlationId,
    );
    if (!token)
      return now - next.updatedAt >= DESIGN_INTENT_LIMITS.preparingGraceMs
        ? { ...next, phase: "draft", updatedAt: now }
        : next;
    next = { ...next, phase: "admitted", token, updatedAt: now };
  }
  return withStatus(next, await service.status(environmentId, canvasId, next.token!), now);
}

/** Lists a document's intents, reconciling unresolved ones from backend state. */
export async function listIntents(
  service: DesignService,
  environmentId: string,
  canvasId: string,
): Promise<DesignIntentList> {
  await service.initialize();
  // Authorizes the read; a quiet queue is answered without taking the lane.
  await service.loadFor(canvasId, environmentId, { allowDeleted: true });
  const now = service.now().getTime();
  const stored = await readIntents(service, canvasId);
  const listing = (intents: DesignStoredIntent[]): DesignIntentList => ({
    intents,
    sending: intents
      .filter((intent) => running(service).has(runKey(canvasId, intent.id)))
      .map((intent) => intent.id),
    now,
  });
  const quiet =
    !stored.some((intent) => needsReconcile(service, canvasId, intent)) &&
    pruneSuccesses(stored, now).length === stored.length;
  if (quiet) return listing(stored);
  return mutate(service, environmentId, canvasId, async (intents, record) => {
    const next: DesignStoredIntent[] = [];
    for (const intent of intents)
      next.push(await reconcile(service, environmentId, canvasId, record, intent, now));
    const pruned = pruneSuccesses(next, now);
    return { intents: pruned, value: listing(pruned) };
  });
}

/** Saves unsent drafts. Never overwrites an intent that was sent or belongs to another client. */
export async function saveIntentDrafts(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  rawClientId: unknown,
  rawDrafts: unknown,
): Promise<{ saved: string[] }> {
  const clientId = opaqueId.parse(rawClientId);
  const drafts = z.array(intentDraftSchema).max(DESIGN_INTENT_LIMITS.perClient).parse(rawDrafts);
  return mutate(service, environmentId, canvasId, async (intents) => {
    const now = service.now().getTime();
    const next = [...intents];
    const saved: string[] = [];
    for (const draft of drafts) {
      const index = next.findIndex((intent) => intent.id === draft.id);
      const existing = next[index];
      if (existing && (existing.phase !== "draft" || existing.clientId !== clientId)) continue;
      const intent: DesignStoredIntent = compact({
        ...draft,
        descriptor: { ...draft.descriptor, canvasId, clientId } as DesignOperationDescriptor,
        clientId,
        phase: "draft",
        updatedAt: now,
      });
      if (existing) next[index] = intent;
      else next.push(intent);
      saved.push(draft.id);
    }
    assertBounds(next, clientId);
    return { intents: next, value: { saved } };
  });
}

/**
 * Imports a browser's legacy localStorage intents once. Tokens are kept (and
 * reconciled, never prepared again); entries that do not fit are skipped.
 */
export async function importIntents(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  rawClientId: unknown,
  rawEntries: unknown,
): Promise<{ imported: number; skipped: number; retained: number[] }> {
  const fallbackClient = opaqueId.parse(rawClientId);
  const entries = z.array(z.unknown()).max(64).parse(rawEntries);
  return mutate(service, environmentId, canvasId, async (intents) => {
    const now = service.now().getTime();
    const next = [...intents];
    let imported = 0;
    const retained: number[] = [];
    for (const [index, raw] of entries.entries()) {
      const parsed = legacySchema.safeParse(raw);
      if (!parsed.success || next.some((intent) => intent.id === parsed.data.id)) continue;
      const entry = parsed.data;
      const outcome = entry.outcome as DesignStoredIntent["outcome"];
      const settled = entry.phase === "settled";
      if (settled && (outcome === "committed" || outcome === "no-op")) continue;
      const clientId = entry.descriptor.clientId ?? fallbackClient;
      const failure = entry.failure
        ? ({ ...entry.failure, message: entry.failure.message.slice(0, 300) } as DesignFailure)
        : undefined;
      const intent: DesignStoredIntent = compact({
        id: entry.id,
        clientId,
        lane: entry.lane,
        label: entry.label,
        createdAt: entry.createdAt,
        updatedAt: now,
        descriptor: { ...entry.descriptor, canvasId } as DesignOperationDescriptor,
        preview: entry.preview,
        gestureKey: entry.gestureKey,
        ...(entry.token
          ? settled
            ? { phase: "settled" as const, token: entry.token, outcome, failure }
            : {
                phase: "admitted" as const,
                token: entry.token,
                // A token this browser never sent is prepared; anything else is unknown.
                ...(entry.phase === "prepared" ? {} : { outcome: "unknown" as const }),
              }
          : settled && outcome && DESIGN_NOT_RUN_STATES.includes(outcome)
            ? { phase: "settled" as const, outcome, failure }
            : { phase: "draft" as const }),
      });
      try {
        const bounded = [...next, intent];
        assertBounds(bounded, clientId);
        next.splice(0, next.length, ...bounded);
      } catch {
        retained.push(index);
        continue;
      }
      imported++;
    }
    return { intents: next, value: { imported, skipped: entries.length - imported, retained } };
  });
}

function unknownStatus(
  canvasId: string,
  token: string,
  descriptor: DesignOperationDescriptor,
  failure: DesignFailure,
  iso: string,
): DesignOperationStatus {
  return {
    token,
    canvasId,
    kind: descriptor.input.kind,
    state: "unknown",
    actor: "user",
    base: descriptor.preconditions,
    preparedAt: iso,
    updatedAt: iso,
    failure,
  };
}

/** Rewrites one intent if it still exists and still belongs to `clientId`. */
function updateOne(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  id: string,
  clientId: string,
  update: (intent: DesignStoredIntent) => DesignStoredIntent,
) {
  return mutate(service, environmentId, canvasId, async (intents) => {
    const current = intents.find((intent) => intent.id === id);
    if (!current || current.clientId !== clientId) return { value: undefined };
    const changed = update(current);
    const next = pruneSuccesses(
      intents.map((intent) => (intent === current ? changed : intent)),
      service.now().getTime(),
    );
    return { intents: next, value: next.includes(changed) ? changed : undefined };
  });
}

/**
 * Runs an intent: records it (rebased over the client's own committed edits),
 * prepares it, executes it and records the outcome. The intent is durable
 * before anything is prepared, so a lost response or a restart is recovered
 * from backend state by `listIntents`, never by preparing again.
 */
export async function runIntent(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  rawDraft: unknown,
  waitMs: number | undefined,
): Promise<DesignIntentRunResult> {
  const draft = intentDraftSchema.parse(rawDraft);
  const clientId = draft.descriptor.clientId;
  if (!clientId || !draft.descriptor.correlationId)
    throw new DesignError("invalid-input", "An intent needs a client and correlation id");
  const requested = { ...draft.descriptor, canvasId } as DesignOperationDescriptor;
  const key = runKey(canvasId, draft.id);
  const owned = running(service);
  await service.initialize();
  // Authorizes before anything looks at this canvas's queue.
  await service.loadFor(canvasId, environmentId, { allowDeleted: true });
  if (owned.has(key))
    return {
      intent: (await readIntents(service, canvasId)).find((entry) => entry.id === draft.id),
    };
  owned.add(key);
  try {
    type Start = { sent: DesignStoredIntent } | { intent: DesignStoredIntent };
    const start = await mutate<Start>(service, environmentId, canvasId, async (intents, record) => {
      if (record.state === "deleted")
        throw new DesignError("deleted", "This design was deleted", { retry: "never" });
      const existing = intents.find((intent) => intent.id === draft.id);
      if (existing && existing.clientId !== clientId)
        throw new DesignError("conflict", "Another window resumed this edit", { retry: "never" });
      // Sent before: its token is reconciled, never prepared again.
      if (existing && existing.phase !== "draft" && existing.phase !== "preparing")
        return { value: { sent: existing } };
      // A run that ended unobserved may have prepared it under this correlation id.
      if (existing?.phase === "preparing") {
        const token = await tokenByCorrelation(
          service,
          record,
          canvasId,
          existing.descriptor.correlationId,
        );
        if (token) {
          const sent: DesignStoredIntent = {
            ...existing,
            phase: "admitted",
            token,
            updatedAt: service.now().getTime(),
          };
          return {
            intents: intents.map((candidate) => (candidate === existing ? sent : candidate)),
            value: { sent },
          };
        }
      }
      const now = service.now().getTime();
      const intent: DesignStoredIntent = compact({
        ...draft,
        clientId,
        createdAt: existing?.createdAt ?? draft.createdAt,
        updatedAt: now,
        // A `preparing` intent keeps the descriptor it may already be prepared under.
        descriptor:
          existing?.phase === "preparing"
            ? existing.descriptor
            : rebaseOverOwnCommits(requested, record.receipts, currentOf(record)),
        phase: "preparing",
      });
      const next = existing
        ? intents.map((candidate) => (candidate === existing ? intent : candidate))
        : [...intents, intent];
      assertBounds(next, clientId);
      return { intents: next, value: { intent } };
    });
    if ("sent" in start) return { intent: start.sent };
    const descriptor = start.intent.descriptor;
    let token: string;
    try {
      token = (await service.prepare(environmentId, "user", descriptor)).token;
    } catch (error) {
      const failure = toDesignFailure(error);
      const later = failure.retry === "after-delay";
      const intent = await updateOne(
        service,
        environmentId,
        canvasId,
        draft.id,
        clientId,
        (current) =>
          compact({
            ...current,
            updatedAt: service.now().getTime(),
            ...(later
              ? { phase: "draft" as const }
              : { phase: "settled" as const, outcome: "rejected" as const, failure }),
          }),
      );
      return { intent, failure };
    }
    let status: DesignOperationStatus;
    try {
      status = await service.execute(environmentId, canvasId, token, { waitMs });
    } catch (error) {
      status = await service
        .status(environmentId, canvasId, token)
        .catch(() =>
          unknownStatus(canvasId, token, descriptor, toDesignFailure(error), service.iso()),
        );
    }
    const intent = await updateOne(
      service,
      environmentId,
      canvasId,
      draft.id,
      clientId,
      (current) => withStatus({ ...current, token }, status, service.now().getTime()),
    );
    return { intent, status };
  } finally {
    owned.delete(key);
  }
}

/**
 * Explicit Resume from any client, which takes the intent over. A token whose
 * outcome may still be pending keeps being reconciled; an edit that never ran
 * becomes a fresh draft (new correlation id, optionally a reviewed base).
 */
export async function resumeIntent(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  rawId: unknown,
  rawClientId: unknown,
  rawRebaseTo: unknown,
): Promise<DesignIntentResumeResult> {
  const id = opaqueId.parse(rawId);
  const clientId = opaqueId.parse(rawClientId);
  const rebaseTo =
    rawRebaseTo === undefined
      ? undefined
      : (preconditionsSchema.parse(rawRebaseTo) as DesignPreconditions);
  const resumed = await mutate(service, environmentId, canvasId, async (intents) => {
    const now = service.now().getTime();
    const current = intents.find((intent) => intent.id === id);
    if (!current) throw new DesignError("not-found", "This edit is no longer pending");
    if (
      running(service).has(runKey(canvasId, id)) ||
      (current.phase === "preparing" &&
        now - current.updatedAt < DESIGN_INTENT_LIMITS.preparingGraceMs)
    )
      throw new DesignError("conflict", "This edit is being sent", { retry: "after-delay" });
    if (isSuccess(current)) return { value: current };
    const notRun = current.outcome !== undefined && DESIGN_NOT_RUN_STATES.includes(current.outcome);
    const next: DesignStoredIntent =
      current.token && !notRun
        ? compact({
            ...current,
            clientId,
            phase: "admitted",
            outcome: current.outcome === "executing" ? "executing" : "unknown",
            failure: undefined,
            updatedAt: now,
          })
        : compact({
            ...current,
            clientId,
            descriptor: {
              ...current.descriptor,
              clientId,
              correlationId: `i-${randomUUID()}`,
              ...(rebaseTo ? { preconditions: rebaseTo } : {}),
            },
            phase: "draft",
            token: undefined,
            outcome: undefined,
            failure: undefined,
            result: undefined,
            updatedAt: now,
          });
    assertBounds(
      intents.map((intent) => (intent === current ? next : intent)),
      clientId,
    );
    return { intents: intents.map((intent) => (intent === current ? next : intent)), value: next };
  });
  if (resumed.phase !== "admitted") return { intent: resumed };
  // Resume is the consent a prepared token was waiting for; listing never executes.
  if (resumed.token) {
    const token = resumed.token;
    const status = await service.status(environmentId, canvasId, token);
    if (status.state === "prepared") {
      const executed = await service.execute(environmentId, canvasId, token, {
        waitMs: RESUME_WAIT_MS,
      });
      const intent = await updateOne(service, environmentId, canvasId, id, clientId, (current) =>
        withStatus(current, executed, service.now().getTime()),
      );
      return { intent };
    }
  }
  const listed = await listIntents(service, environmentId, canvasId);
  return { intent: listed.intents.find((intent) => intent.id === id) };
}

/**
 * Removes an intent for every client. A token that has not started is
 * canceled first; one that already started may still finish.
 */
export async function discardIntent(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  rawId: unknown,
): Promise<DesignIntentDiscardResult> {
  const id = opaqueId.parse(rawId);
  await service.initialize();
  await service.loadFor(canvasId, environmentId, { allowDeleted: true });
  const current = (await readIntents(service, canvasId)).find((intent) => intent.id === id);
  if (!current) return { discarded: false, mayStillFinish: false };
  let mayStillFinish = running(service).has(runKey(canvasId, id));
  if (current.token && current.phase !== "settled") {
    const status = await service
      .cancel(environmentId, canvasId, current.token)
      .catch(() => undefined);
    if (!status || !DESIGN_TERMINAL_STATES.includes(status.state)) mayStillFinish = true;
  }
  await mutate(service, environmentId, canvasId, async (intents) => ({
    intents: intents.filter((intent) => intent.id !== id),
    value: undefined,
  }));
  return { discarded: true, mayStillFinish };
}
