import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  DESIGN_MAX_CANVASES,
  DESIGN_MAX_DOCUMENT_BYTES,
} from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  type DesignActor,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
  type DesignPrepareResult,
} from "@orkestrator/protocol/design-operations";
import { DesignError, reusedCorrelation, toDesignFailure } from "./errors.js";
import {
  addReceipt,
  cloneRecord,
  descriptorDigest,
  freshFrameMeta,
  intentDigest,
  newRecord,
  readBounded,
  receiptDigest,
  settledMatches,
  type DesignPendingOperation,
  type DesignPrivateRecord,
} from "./records.js";
import { canvasSchema, designName } from "./schemas.js";
import type { DesignService } from "./service.js";
import * as validation from "./validation.js";

const LIFECYCLE = new Set(["create_canvas", "delete_canvas", "restore_canvas", "duplicate_canvas"]);

export function isLifecycle(kind: string) {
  return LIFECYCLE.has(kind);
}

function parseImport(document: string) {
  if (Buffer.byteLength(document) > DESIGN_MAX_DOCUMENT_BYTES)
    throw new DesignError("invalid-content", "Design file exceeds 4 MiB", { retry: "never" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new DesignError("invalid-input", "This is not a valid .orkdes design file", {
      retry: "never",
    });
  }
  const header = parsed as { format?: unknown; version?: unknown };
  if (header?.format !== "orkdes")
    throw new DesignError("invalid-input", "This is not an .orkdes design file", {
      retry: "never",
    });
  if (header.version !== 1)
    throw new DesignError("unsupported", "This design file version is not supported", {
      retry: "never",
    });
  const result = canvasSchema.safeParse(parsed);
  if (!result.success)
    throw new DesignError("invalid-input", "The design file is malformed or exceeds a limit", {
      retry: "never",
    });
  return result.data;
}

/** Reserves a canvas identity and quota before any document exists. */
export async function prepareCreate(
  service: DesignService,
  environmentId: string,
  actor: DesignActor,
  descriptor: DesignOperationDescriptor,
  bytes: number,
): Promise<DesignPrepareResult> {
  if (descriptor.input.kind !== "create_canvas")
    throw new DesignError("invalid-input", "Not a create");
  if (descriptor.input.document !== undefined) parseImport(descriptor.input.document);
  if (service.environmentDeleted(environmentId))
    throw new DesignError("not-found", "Environment not found");
  await sweepProvisional(service);
  return service.global(async () => {
    if (service.environmentDeleted(environmentId))
      throw new DesignError("not-found", "Environment not found");
    // Quota and correlation lookups must see every process's canvases; the
    // global lease keeps another process from reserving meanwhile.
    await service.refreshLibrary();
    // A retried create with the same correlation id reconciles to its reservation.
    if (descriptor.correlationId) {
      const existing = await findCreate(service, environmentId, descriptor.correlationId);
      if (existing?.pending) {
        const { pending } = existing;
        if (intentDigest(pending.descriptor) !== intentDigest(descriptor))
          throw reusedCorrelation(pending.token);
        return {
          token: pending.token,
          canvasId: pending.canvasId,
          state: "prepared",
          expiresAt: pending.expiresAt,
        };
      }
      if (existing?.receipt) {
        if (!settledMatches(existing.receipt, existing.digest, descriptor))
          throw reusedCorrelation(existing.receipt.token);
        throw new DesignError(
          "invalid-input",
          "This correlation id already has a settled operation",
          {
            details: { token: existing.receipt.token },
          },
        );
      }
    }
    const counts = service.library.counts();
    if (counts.live + counts.provisional >= DESIGN_MAX_CANVASES)
      throw new DesignError("capacity", `Canvas limit reached (${DESIGN_MAX_CANVASES})`, {
        retry: "never",
      });
    if (counts.provisional >= DESIGN_LIMITS.provisionalCanvases)
      throw new DesignError("capacity", "Too many designs are being created; retry shortly", {
        retryAfterMs: 1000,
      });
    const now = service.now();
    const canvasId = randomUUID();
    const token = `op_${randomUUID()}`;
    const record = newRecord(canvasId, environmentId, now.toISOString(), "provisional");
    const expiresAt = new Date(now.getTime() + DESIGN_LIMITS.provisionalTtlMs).toISOString();
    record.provisional = { expiresAt, token, owner: service.generation };
    const entry: DesignPendingOperation = {
      token,
      digest: descriptorDigest({ environmentId, canvasId, descriptor }),
      descriptor,
      actor,
      environmentId,
      canvasId,
      incarnation: record.incarnation,
      preparedAt: now.toISOString(),
      expiresAt,
      bytes,
      state: "prepared",
      owner: service.generation,
    };
    // Pending entry and reservation appear together under the canvas lease,
    // so another process's recovery never sees one without the other.
    await service.lane(canvasId, async () => {
      await service.store.writePending(canvasId, [entry]);
      await service.commit(record, false);
    });
    return { token, canvasId, state: "prepared", expiresAt };
  });
}

/** Finds a create in this environment already prepared or settled under `correlationId`. */
export async function findCreate(
  service: DesignService,
  environmentId: string,
  correlationId: string,
): Promise<
  { pending?: DesignPendingOperation; receipt?: DesignOperationStatus; digest?: string } | undefined
> {
  await service.initialize();
  for (const entry of Array.from(service.library.entries.values())) {
    if (entry.environmentId !== environmentId) continue;
    if (entry.state === "provisional") {
      const pending = (await service.store.readPending(entry.id)).find(
        (candidate) =>
          candidate.descriptor.input.kind === "create_canvas" &&
          candidate.descriptor.correlationId === correlationId,
      );
      if (pending) return { pending };
      continue;
    }
    if (entry.state !== "live" && entry.state !== "deleted") continue;
    const loaded = await service.load(entry.id);
    if (loaded.kind !== "record") continue;
    const receipt = loaded.record.receipts.find(
      (candidate) =>
        candidate.kind === "create_canvas" && candidate.correlationId === correlationId,
    );
    if (receipt) return { receipt, digest: receiptDigest(loaded.record, receipt.token) };
  }
  return undefined;
}

export async function executeLifecycle(
  service: DesignService,
  entry: DesignPendingOperation,
  snapshot: DesignPrivateRecord,
): Promise<DesignOperationStatus> {
  const input = entry.descriptor.input;
  try {
    switch (input.kind) {
      case "create_canvas":
        return await executeCreate(service, entry);
      case "delete_canvas":
        return await executeDelete(service, entry);
      case "restore_canvas":
        return await executeRestore(service, entry);
      case "duplicate_canvas":
        return await executeDuplicate(service, entry, snapshot);
      default:
        throw new DesignError("unsupported", "Unsupported lifecycle operation");
    }
  } catch (error) {
    const failure = toDesignFailure(error);
    if (failure.code === "not-found" && service.environmentDeleted(entry.environmentId))
      throw error;
    return service.lane(entry.canvasId, async () => {
      const loaded = await service.load(entry.canvasId);
      const pending = await service.store.readPending(entry.canvasId);
      // A duplicate that failed after its copy committed did run.
      const receipt =
        (await committedDuplicate(service, entry)) ??
        service.receipt(entry, "rejected", { failure });
      if (loaded.kind === "record" && loaded.record.state !== "provisional") {
        const settled = loaded.record.receipts.find((candidate) => candidate.token === entry.token);
        if (settled) return settled;
        const next = cloneRecord(loaded.record);
        addReceipt(next, receipt, entry.descriptor);
        try {
          await service.commit(next, loaded.legacy);
        } catch (saveError) {
          // The copy is durable even when its source receipt cannot be saved.
          // Retain pending so status, retries and restart recovery can prove it.
          if (receipt.state === "committed") return receipt;
          throw saveError;
        }
      } else if (loaded.kind === "record") {
        await discardProvisional(service, entry.canvasId);
      }
      await service.dropPending(entry.canvasId, pending, entry.token);
      return receipt;
    });
  }
}

async function executeCreate(service: DesignService, entry: DesignPendingOperation) {
  const input = entry.descriptor.input as Extract<
    DesignOperationDescriptor["input"],
    { kind: "create_canvas" }
  >;
  const status = await service.lane(entry.canvasId, async () => {
    const { record } = await service.loadFor(entry.canvasId, entry.environmentId, {
      allowProvisional: true,
    });
    const settled = record.receipts.find((candidate) => candidate.token === entry.token);
    if (settled) return settled;
    if (record.state !== "provisional" || record.provisional?.token !== entry.token)
      throw new DesignError("expired-operation", "This design reservation is no longer valid");
    const imported = input.document !== undefined ? parseImport(input.document) : undefined;
    const now = service.iso();
    const next = cloneRecord(record);
    next.state = "live";
    next.provisional = undefined;
    next.createdAt = now;
    next.modifiedAt = now;
    next.document = {
      format: "orkdes",
      version: 1,
      id: record.canvasId,
      environmentId: record.environmentId,
      name: designName.parse(imported?.name ?? input.name),
      revision: 1,
      frames: (imported?.frames ?? []).map((frame) => ({
        ...frame,
        id: randomUUID(),
        revision: 1,
      })),
    };
    for (const frame of next.document.frames)
      next.frames[frame.id] = freshFrameMeta(next, frame, now);
    next.changes = [
      {
        revision: 1,
        frames: next.document.frames.map((frame) => ({
          id: frame.id,
          fields: ["name", "geometry", "viewport", "content", "structure"],
          created: true as const,
        })),
        canvasFields: ["name", "order"],
      },
    ];
    const receipt = service.receipt(entry, "committed", {
      result: {
        canvasRevision: 1,
        createdCanvasId: record.canvasId,
        frames: next.document.frames.map((frame) => ({
          frameId: frame.id,
          revision: frame.revision,
        })),
      },
    });
    addReceipt(next, receipt, entry.descriptor);
    await service.commit(next, false, {
      revision: 1,
      kind: "document",
      statusVersion: next.statusVersion,
    });
    await service.dropPending(
      entry.canvasId,
      await service.store.readPending(entry.canvasId),
      entry.token,
    );
    return receipt;
  });
  if (input.document !== undefined) {
    const loaded = await service.load(entry.canvasId);
    if (loaded.kind === "record")
      for (const frame of loaded.record.document.frames)
        validation.schedule(service, entry.environmentId, entry.canvasId, frame.id);
  }
  return status;
}

async function executeDelete(service: DesignService, entry: DesignPendingOperation) {
  const status = await service.lane(entry.canvasId, async () => {
    const { record, legacy } = await service.loadFor(entry.canvasId, entry.environmentId, {
      allowDeleted: true,
    });
    const settled = record.receipts.find((candidate) => candidate.token === entry.token);
    if (settled) return settled;
    if (
      !(await service.store.readPending(entry.canvasId)).some(
        (candidate) => candidate.token === entry.token,
      )
    )
      throw new DesignError("expired-operation", "This operation is no longer pending");
    if (record.state === "deleted")
      throw new DesignError("deleted", "This design was already deleted");
    const expected = entry.descriptor.preconditions.canvasRevision;
    if (expected === undefined)
      throw new DesignError("invalid-input", "Missing expected canvas revision");
    if (expected !== record.document.revision)
      throw new DesignError("conflict", "The design changed; review it before deleting", {
        revisions: { expected, current: record.document.revision },
      });
    const next = cloneRecord(record);
    const now = service.iso();
    next.state = "deleted";
    next.deleted = { deletedAt: now, revision: record.document.revision, token: entry.token };
    next.statusVersion++;
    // Fence: any computation prepared against the live incarnation is refused.
    next.incarnation = randomUUID().replaceAll("-", "").slice(0, 16);
    const receipt = service.receipt(entry, "committed", {
      result: { canvasRevision: record.document.revision, frames: [] },
    });
    addReceipt(next, receipt, entry.descriptor);
    await service.commit(next, legacy, {
      revision: record.document.revision,
      kind: "deleted",
      statusVersion: next.statusVersion,
    });
    await service.dropPending(
      entry.canvasId,
      await service.store.readPending(entry.canvasId),
      entry.token,
    );
    return receipt;
  });
  service.track(enforceRecycleBin(service));
  return status;
}

async function executeRestore(service: DesignService, entry: DesignPendingOperation) {
  return service.global(() =>
    service.lane(entry.canvasId, async () => {
      const { record, legacy } = await service.loadFor(entry.canvasId, entry.environmentId, {
        allowDeleted: true,
      });
      const settled = record.receipts.find((candidate) => candidate.token === entry.token);
      if (settled) return settled;
      if (
        !(await service.store.readPending(entry.canvasId)).some(
          (candidate) => candidate.token === entry.token,
        )
      )
        throw new DesignError("expired-operation", "This operation is no longer pending");
      if (record.state !== "deleted")
        throw new DesignError("conflict", "This design is not deleted");
      const expected = entry.descriptor.preconditions.tombstoneRevision;
      if (expected !== undefined && expected !== record.deleted?.revision)
        throw new DesignError("conflict", "The deleted design changed; refresh the recycle bin");
      await service.refreshLibrary();
      const counts = service.library.counts();
      if (counts.live + counts.provisional >= DESIGN_MAX_CANVASES)
        throw new DesignError("capacity", `Canvas limit reached (${DESIGN_MAX_CANVASES})`, {
          retry: "never",
        });
      const next = cloneRecord(record);
      next.state = "live";
      next.deleted = undefined;
      next.incarnation = randomUUID().replaceAll("-", "").slice(0, 16);
      next.document.revision++;
      next.modifiedAt = service.iso();
      // No delta can bridge a tombstone; clients recover through a snapshot.
      next.changes = [];
      next.statusVersion++;
      const receipt = service.receipt(entry, "committed", {
        result: { canvasRevision: next.document.revision, frames: [] },
      });
      addReceipt(next, receipt, entry.descriptor);
      await service.commit(next, legacy, {
        revision: next.document.revision,
        kind: "restored",
        statusVersion: next.statusVersion,
      });
      await service.dropPending(
        entry.canvasId,
        await service.store.readPending(entry.canvasId),
        entry.token,
      );
      return receipt;
    }),
  );
}

function tokenUuid(token: string) {
  const hex = createHash("sha256").update(`duplicate:${token}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The source receipt of a duplicate: the revision it copied and the copy's id. */
function duplicateReceipt(
  service: DesignService,
  entry: DesignPendingOperation,
  canvasRevision: number,
): DesignOperationStatus {
  return service.receipt(entry, "committed", {
    result: { canvasRevision, createdCanvasId: tokenUuid(entry.token), frames: [] },
  });
}

/**
 * The receipt of a duplicate whose copy committed but whose source receipt
 * was never written (the write failed, or its process stopped in between).
 * The copy's id is derived from the token, so only this operation can have
 * made it; a copy deleted since still counts.
 */
export async function committedDuplicate(
  service: DesignService,
  entry: DesignPendingOperation,
): Promise<DesignOperationStatus | undefined> {
  const expected = entry.descriptor.preconditions.canvasRevision;
  if (entry.descriptor.input.kind !== "duplicate_canvas" || expected === undefined)
    return undefined;
  const copy = await service.load(tokenUuid(entry.token));
  if (copy.kind !== "record" || copy.legacy || copy.record.environmentId !== entry.environmentId)
    return undefined;
  return duplicateReceipt(service, entry, expected);
}

async function executeDuplicate(
  service: DesignService,
  entry: DesignPendingOperation,
  source: DesignPrivateRecord,
) {
  const input = entry.descriptor.input as Extract<
    DesignOperationDescriptor["input"],
    { kind: "duplicate_canvas" }
  >;
  if (source.state !== "live") throw new DesignError("deleted", "This design was deleted");
  const expected = entry.descriptor.preconditions.canvasRevision;
  if (expected === undefined)
    throw new DesignError("invalid-input", "Missing expected canvas revision");
  if (expected !== source.document.revision)
    throw new DesignError("conflict", "The design changed; review it before duplicating", {
      revisions: { expected, current: source.document.revision },
    });
  // Deterministic destination: a repeated execution can never create a second copy.
  const destinationId = tokenUuid(entry.token);
  await service.global(async () => {
    const existing = await service.load(destinationId);
    if (existing.kind === "record") return;
    await service.refreshLibrary();
    const counts = service.library.counts();
    if (counts.live + counts.provisional >= DESIGN_MAX_CANVASES)
      throw new DesignError("capacity", `Canvas limit reached (${DESIGN_MAX_CANVASES})`, {
        retry: "never",
      });
    const now = service.iso();
    const copy = newRecord(destinationId, source.environmentId, now, "live");
    copy.document = {
      ...copy.document,
      name: designName.parse((input.name ?? `${source.document.name} copy`).slice(0, 120)),
      revision: 1,
      frames: source.document.frames.map((frame) => ({ ...frame, id: randomUUID(), revision: 1 })),
    };
    source.document.frames.forEach((frame, index) => {
      const duplicated = copy.document.frames[index]!;
      const meta = freshFrameMeta(copy, duplicated, now);
      const previous = source.frames[frame.id]?.validation;
      if (previous)
        meta.validation = { ...previous, frameId: duplicated.id, contentId: meta.contentId };
      copy.frames[duplicated.id] = meta;
    });
    await service.lane(destinationId, () => service.commit(copy, false));
  });
  return service.lane(entry.canvasId, async () => {
    const { record, legacy } = await service.loadFor(entry.canvasId, entry.environmentId, {
      allowDeleted: true,
    });
    const settled = record.receipts.find((candidate) => candidate.token === entry.token);
    if (settled) return settled;
    const next = cloneRecord(record);
    // The revision copied, so a receipt rebuilt from the copy is identical.
    const receipt = duplicateReceipt(service, entry, expected);
    addReceipt(next, receipt, entry.descriptor);
    await service.commit(next, legacy);
    await service.dropPending(
      entry.canvasId,
      await service.store.readPending(entry.canvasId),
      entry.token,
    );
    return receipt;
  });
}

export async function discardProvisional(service: DesignService, canvasId: string) {
  service.coordination.beginLibraryChange(canvasId);
  await service.store.remove(canvasId);
  service.forget(canvasId);
  service.libraryRemoved(canvasId);
}

/** Whether a live backend other than this one reserved the provisional record. */
function reservedElsewhere(service: DesignService, record: DesignPrivateRecord) {
  return service.ownedElsewhere({ owner: record.provisional?.owner });
}

/**
 * Startup: reservations from a process that is gone can never execute. A
 * live backend sharing the data directory keeps its own (it sweeps them).
 */
export async function expireProvisional(service: DesignService) {
  for (const entry of Array.from(service.library.entries.values())) {
    if (entry.state !== "provisional") continue;
    await service.lane(entry.id, async () => {
      const loaded = await service.load(entry.id);
      if (loaded.kind !== "record" || loaded.record.state !== "provisional") return;
      if (reservedElsewhere(service, loaded.record)) return;
      await discardProvisional(service, entry.id);
    });
  }
}

async function sweepProvisional(service: DesignService) {
  await service.refreshLibrary();
  const now = service.now().getTime();
  for (const entry of Array.from(service.library.entries.values())) {
    if (entry.state !== "provisional") continue;
    await service.lane(entry.id, async () => {
      const loaded = await service.load(entry.id);
      if (loaded.kind !== "record" || loaded.record.state !== "provisional") return;
      if (service.isRunning(loaded.record.provisional?.token ?? "")) return;
      // Another live process may be executing its create; it sweeps its own.
      if (reservedElsewhere(service, loaded.record)) return;
      if (Date.parse(loaded.record.provisional?.expiresAt ?? "") > now) return;
      await discardProvisional(service, entry.id);
    });
  }
}

export async function purge(service: DesignService, environmentId: string, canvasId: string) {
  await service.initialize();
  return service.lane(canvasId, async () => {
    const { record } = await service.loadFor(canvasId, environmentId, { allowDeleted: true });
    if (record.state !== "deleted")
      throw new DesignError("conflict", "Only deleted designs can be purged", { retry: "never" });
    await removeCanvasFiles(service, canvasId);
    service.publish({ canvasId, revision: record.document.revision, kind: "deleted" });
  });
}

async function removeCanvasFiles(service: DesignService, canvasId: string) {
  service.coordination.beginLibraryChange(canvasId);
  await rm(service.store.historyDir(canvasId), { recursive: true, force: true });
  await rm(service.store.exportBackupDir(canvasId), { recursive: true, force: true });
  // Kept after a legacy migration for recovery; permanent removal ends that.
  await rm(service.store.legacyBackupFile(canvasId), { force: true });
  // The root record is the sweep's durable cleanup identity. Keep it until
  // every sidecar is gone so a failure or restart can still discover it.
  await service.store.remove(canvasId);
  service.forget(canvasId);
  service.libraryRemoved(canvasId);
}

/**
 * Recycle-bin retention: age, count and bytes across every process's
 * canvases. Never touches live designs: each removal re-reads the record
 * under its lane.
 */
export async function enforceRecycleBin(service: DesignService) {
  await service.refreshLibrary();
  const now = service.now().getTime();
  // A summary the record no longer matches (restored or changed by another
  // process) is skipped, never retried in a loop.
  const kept = new Set<string>();
  const deleted = () =>
    Array.from(service.library.entries.values())
      .filter((entry) => entry.state === "deleted" && !kept.has(entry.id))
      .sort((a, b) => (a.deletedAt ?? "").localeCompare(b.deletedAt ?? ""));
  const removeIfStillDeleted = async (entry: ReturnType<typeof deleted>[number]) => {
    const removed = await service
      .lane(entry.id, async () => {
        const current = service.library.entries.get(entry.id);
        if (current?.state !== "deleted") return false;
        const { record } = await service.loadFor(entry.id, entry.environmentId, {
          allowDeleted: true,
        });
        if (record.state !== "deleted" || record.deleted?.deletedAt !== entry.deletedAt)
          return false;
        await removeCanvasFiles(service, entry.id);
        return true;
      })
      .catch(() => false);
    if (!removed) kept.add(entry.id);
  };
  for (const entry of deleted()) {
    if (now - Date.parse(entry.deletedAt ?? entry.modifiedAt) < DESIGN_LIMITS.recycleRetentionMs)
      break;
    await removeIfStillDeleted(entry);
  }
  for (;;) {
    const remaining = deleted();
    const bytes = remaining.reduce(
      (total, entry) => total + entry.recordBytes + entry.historyBytes,
      0,
    );
    if (remaining.length <= DESIGN_LIMITS.recycleCanvases && bytes <= DESIGN_LIMITS.recycleBytes)
      return;
    const oldest = remaining[0];
    if (!oldest) return;
    await removeIfStillDeleted(oldest);
  }
}

/** Environment deletion fences all work before removing records. */
export async function deleteEnvironment(
  service: DesignService,
  environmentId: string,
): Promise<number> {
  service.fences.add(environmentId);
  return service.global(async () => {
    service.coordination.fenceEnvironment(environmentId);
    // Includes canvases other processes created in this environment.
    await service.refreshLibrary();
    const ids = Array.from(service.library.entries.values())
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.id);
    for (const id of ids) await service.lane(id, () => removeCanvasFiles(service, id));
    return ids.length;
  });
}

/**
 * Removes canvases whose environment is gone. Environment deletion fences and
 * removes its canvases before the environment record goes, so a crash or
 * failure in between leaves a fenced environment's files behind; older builds,
 * or an environment removed another way, leave canvases whose owner is simply
 * absent. `liveEnvironmentIds` must load the complete set, and throw when it
 * cannot: a caller that cannot list every environment must not sweep. It is
 * not called when no canvas has an owner, so a fresh install whose
 * environment store was never written has nothing to refuse.
 *
 * A fenced owner's canvases go at once, since environment ids are never reused.
 * An absent owner's canvas goes only once its file is older than `minAgeMs`, so
 * it cannot race an environment created after the listing. A canvas whose
 * owner cannot be read is kept.
 */
export async function sweepOrphanedCanvases(
  service: DesignService,
  liveEnvironmentIds: () => Promise<ReadonlySet<string>>,
  minAgeMs: number,
): Promise<number> {
  await service.refreshLibrary();
  const owned = Array.from(service.library.entries.values()).some((entry) => entry.environmentId);
  if (!owned) return 0;
  const live = await liveEnvironmentIds();
  const now = service.now().getTime();
  const orphaned = (entry: { environmentId: string; fileMtimeMs: number }) => {
    if (!entry.environmentId) return false;
    if (service.environmentDeleted(entry.environmentId)) return true;
    return !live.has(entry.environmentId) && now - entry.fileMtimeMs >= minAgeMs;
  };
  let removed = 0;
  for (const entry of Array.from(service.library.entries.values())) {
    if (!orphaned(entry)) continue;
    const done = await service
      .lane(entry.id, async () => {
        // Another process may have changed or removed it since the scan.
        await service.refreshLibrary();
        const current = service.library.entries.get(entry.id);
        if (!current || current.environmentId !== entry.environmentId || !orphaned(current))
          return false;
        await removeCanvasFiles(service, entry.id);
        return true;
      })
      .catch(() => false);
    if (done) removed += 1;
  }
  return removed;
}

/** Best-effort owner lookup for a record that cannot be parsed. */
export async function problemEnvironment(
  service: DesignService,
  id: string,
): Promise<string | undefined> {
  for (const file of [
    service.store.recordFile(id),
    service.store.legacyFile(id),
    service.store.legacyBackupFile(id),
  ]) {
    try {
      const raw = (await readBounded(file, DESIGN_LIMITS.privateRecordBytes)).toString("utf8");
      const match = /"environmentId"\s*:\s*"([^"\\]{1,256})"/.exec(raw);
      if (match) return match[1];
    } catch {
      // try the next source
    }
  }
  return undefined;
}
