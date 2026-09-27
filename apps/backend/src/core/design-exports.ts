import { createHash, randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DESIGN_LIMITS,
  type DesignExportPreview,
  type DesignExportReceipt,
  type DesignExportTarget,
  type DesignPendingExport,
} from "@orkestrator/protocol/design-operations";
import { DesignError, designConflict, toDesignFailure } from "./design-errors.js";
import {
  designExportDigest,
  inspectDesignExportTarget,
  planDefaultDesignExportPath,
  validateDesignExportPath,
  writeDesignExport,
  type DesignExportDestination,
  type DesignExportExpectation,
  type DesignExportTargetState,
  type DesignExportWriteOptions,
} from "./design-export-writer.js";
import { cloneRecord, portableBytes, writeAtomically } from "./design-records.js";
import type { DesignService } from "./design-service.js";

/** Resolves an authorized environment's repository; never trusts client paths. */
export async function resolveDesignDestination(
  storage: { getEnvironment(id: string): Promise<unknown> },
  environmentId: string,
): Promise<DesignExportDestination> {
  const environment = (await storage.getEnvironment(environmentId)) as
    | { environmentType?: string; worktreePath?: string | null; containerId?: string | null }
    | null
    | undefined;
  if (!environment) throw new DesignError("not-found", "Environment not found");
  if (environment.environmentType === "local") {
    if (!environment.worktreePath)
      throw new DesignError("unsupported", "This environment has no repository worktree");
    return { kind: "local", worktreePath: environment.worktreePath };
  }
  if (!environment.containerId)
    throw new DesignError("unsupported", "This environment's container is not available", {
      retry: "after-delay",
    });
  return { kind: "container", containerId: environment.containerId };
}

export interface DesignExportContext {
  destination: DesignExportDestination;
  writerOptions?: DesignExportWriteOptions;
}

const running = new WeakMap<DesignService, Set<string>>();
/** Export tokens this process is writing right now (never durable). */
function activeExports(service: DesignService): Set<string> {
  let tokens = running.get(service);
  if (!tokens) {
    tokens = new Set();
    running.set(service, tokens);
  }
  return tokens;
}

/** Opaque repository identity: never an absolute host path in client responses. */
export function repositoryIdentity(environmentId: string, destination: DesignExportDestination) {
  const raw =
    destination.kind === "local"
      ? `local:${environmentId}:${destination.worktreePath}`
      : `container:${environmentId}:${destination.containerId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function targetFrom(
  relativePath: string,
  canvasId: string,
  state: DesignExportTargetState,
  association: { relativePath: string; digest: string; repository: string } | undefined,
  repository: string,
): DesignExportTarget {
  if (!state.exists)
    return {
      relativePath,
      exists: false,
      sameCanvas: false,
      readable: true,
      needsReplaceConfirmation: false,
    };
  if (!state.readable || !state.bytes)
    return {
      relativePath,
      exists: true,
      sameCanvas: false,
      readable: false,
      needsReplaceConfirmation: true,
      reason: "unreadable",
      ...(state.digest ? { fingerprint: state.digest } : {}),
    };
  let parsedId: string | undefined;
  try {
    const parsed = JSON.parse(state.bytes.toString("utf8")) as { format?: unknown; id?: unknown };
    if (parsed?.format === "orkdes" && typeof parsed.id === "string" && parsed.id.length <= 64)
      parsedId = parsed.id;
  } catch {
    // Not JSON: a non-design file is a collision, never an empty target.
  }
  const sameCanvas = parsedId === canvasId;
  const ours =
    sameCanvas &&
    association?.relativePath === relativePath &&
    association.repository === repository &&
    association.digest === state.digest;
  return {
    relativePath,
    exists: true,
    ...(parsedId ? { canvasId: parsedId } : {}),
    sameCanvas,
    readable: true,
    fingerprint: state.digest!,
    needsReplaceConfirmation: !ours,
    reason: ours
      ? "same-canvas"
      : !parsedId
        ? "not-design"
        : sameCanvas
          ? "changed-since-export"
          : "other-canvas",
  };
}

export async function exportPreview(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  context: DesignExportContext,
  requestedPath?: string,
): Promise<DesignExportPreview> {
  await service.initialize();
  const { record } = await service.loadFor(canvasId, environmentId);
  const repository = repositoryIdentity(environmentId, context.destination);
  const association = record.export?.repository === repository ? record.export : undefined;
  const suggestedPath =
    association?.relativePath ?? planDefaultDesignExportPath(record.document.name, canvasId);
  const relativePath = validateDesignExportPath(requestedPath ?? suggestedPath);
  const state = await inspectDesignExportTarget(
    context.destination,
    relativePath,
    context.writerOptions,
  );
  return {
    suggestedPath,
    ...(association ? { association } : {}),
    target: targetFrom(relativePath, canvasId, state, association, repository),
    revision: record.document.revision,
  };
}

/**
 * Exports one exact committed revision. The destination write is outside the
 * record transaction, so intent (path, revision, digest) is recorded first and
 * a lost outcome is reconciled by inspecting the destination, never by
 * writing again.
 */
export async function exportSave(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  context: DesignExportContext,
  request: { relativePath: string; revision: number; expected: DesignExportExpectation },
): Promise<DesignExportReceipt> {
  await service.initialize();
  const relativePath = validateDesignExportPath(request.relativePath);
  const repository = repositoryIdentity(environmentId, context.destination);
  const token = `ex_${randomUUID()}`;
  const intent = await service.lane(canvasId, async () => {
    const { record, legacy } = await service.loadFor(canvasId, environmentId);
    // Legacy save clients match the conflict message prefix; new clients use the code.
    if (record.document.revision !== request.revision)
      throw designConflict(request.revision, record.document.revision, { canvasId });
    // Only an export this process is actually running blocks; a "writing"
    // intent left by a failed settlement is stale and reconcilable.
    if (
      record.pendingExport?.state === "writing" &&
      activeExports(service).has(record.pendingExport.token)
    )
      throw new DesignError("capacity", "Another export of this design is still running", {
        retryAfterMs: 1000,
      });
    const bytes = portableBytes(record.document);
    const pending: DesignPendingExport = {
      token,
      relativePath,
      repository,
      revision: record.document.revision,
      digest: designExportDigest(bytes),
      startedAt: service.iso(),
      state: "writing",
    };
    const next = cloneRecord(record);
    next.pendingExport = pending;
    next.statusVersion++;
    await service.commit(next, legacy, {
      revision: next.document.revision,
      kind: "status",
      statusVersion: next.statusVersion,
    });
    activeExports(service).add(token);
    return { bytes, pending };
  });
  try {
    return await writeAndSettle(service, environmentId, canvasId, context, request, token, intent);
  } finally {
    activeExports(service).delete(token);
  }
}

async function writeAndSettle(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  context: DesignExportContext,
  request: { relativePath: string; expected: DesignExportExpectation },
  token: string,
  intent: { bytes: Buffer; pending: DesignPendingExport },
): Promise<DesignExportReceipt> {
  const relativePath = intent.pending.relativePath;
  let written: Awaited<ReturnType<typeof writeDesignExport>>;
  try {
    written = await writeDesignExport(
      context.destination,
      relativePath,
      intent.bytes,
      request.expected,
      context.writerOptions,
    );
  } catch (error) {
    const failure = toDesignFailure(error);
    await service.lane(canvasId, async () => {
      const loaded = await service
        .loadFor(canvasId, environmentId, { allowDeleted: true })
        .catch(() => undefined);
      if (!loaded || loaded.record.pendingExport?.token !== token) return;
      const next = cloneRecord(loaded.record);
      next.pendingExport =
        failure.code === "unknown-outcome"
          ? { ...intent.pending, state: "unknown", failure }
          : undefined;
      next.statusVersion++;
      await service.commit(next, loaded.legacy, {
        revision: next.document.revision,
        kind: "status",
        statusVersion: next.statusVersion,
      });
    });
    throw error;
  }
  if (written.previous) service.track(keepBackup(service, canvasId, token, written.previous));
  // If settling fails the file may already be published: keep the durable
  // intent so `reconcileExport` can prove the outcome from the exact digest.
  return settleExport(service, environmentId, canvasId, intent.pending, written.replaced);
}

async function settleExport(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  pending: DesignPendingExport,
  replaced: boolean,
): Promise<DesignExportReceipt> {
  return service.lane(canvasId, async () => {
    // A deleted design keeps its tombstone; settling an export never restores it.
    const { record, legacy } = await service.loadFor(canvasId, environmentId, {
      allowDeleted: true,
    });
    const next = cloneRecord(record);
    const exportedAt = service.iso();
    const previous = next.export;
    // Out-of-order completions never regress the remembered latest export.
    if (
      !previous ||
      previous.repository !== pending.repository ||
      previous.lastExportedRevision <= pending.revision
    ) {
      next.export = {
        relativePath: pending.relativePath,
        repository: pending.repository,
        lastExportedRevision: pending.revision,
        digest: pending.digest,
        exportedAt,
        token: pending.token,
      };
    }
    if (next.pendingExport?.token === pending.token) next.pendingExport = undefined;
    next.statusVersion++;
    await service.commit(next, legacy, {
      revision: next.document.revision,
      kind: "status",
      statusVersion: next.statusVersion,
    });
    return {
      token: pending.token,
      relativePath: pending.relativePath,
      revision: pending.revision,
      digest: pending.digest,
      replaced,
      exportedAt,
      currentRevision: next.document.revision,
    };
  });
}

/** Resolves an uncertain export by exact output identity; never rewrites to check. */
export async function reconcileExport(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  context: DesignExportContext,
): Promise<{
  state: "exported" | "not-exported" | "unavailable" | "none";
  receipt?: DesignExportReceipt;
}> {
  await service.initialize();
  const { record } = await service.loadFor(canvasId, environmentId, { allowDeleted: true });
  const pending = record.pendingExport;
  if (!pending) return { state: "none" };
  // Never reconcile (and so clear) an export this process is still writing.
  if (pending.state === "writing" && activeExports(service).has(pending.token))
    return { state: "unavailable" };
  if (pending.repository !== repositoryIdentity(environmentId, context.destination))
    return { state: "unavailable" };
  let state: DesignExportTargetState;
  try {
    state = await inspectDesignExportTarget(
      context.destination,
      pending.relativePath,
      context.writerOptions,
    );
  } catch {
    return { state: "unavailable" };
  }
  if (state.exists && state.digest === pending.digest)
    return {
      state: "exported",
      receipt: await settleExport(service, environmentId, canvasId, pending, true),
    };
  await service.lane(canvasId, async () => {
    const latest = await service.loadFor(canvasId, environmentId, { allowDeleted: true });
    if (latest.record.pendingExport?.token !== pending.token) return;
    const next = cloneRecord(latest.record);
    next.pendingExport = undefined;
    next.statusVersion++;
    await service.commit(next, latest.legacy, {
      revision: next.document.revision,
      kind: "status",
      statusVersion: next.statusVersion,
    });
  });
  return { state: "not-exported" };
}

/** Keeps a bounded private copy of a file an export replaced. */
async function keepBackup(service: DesignService, canvasId: string, token: string, bytes: Buffer) {
  const dir = service.store.exportBackupDir(canvasId);
  await writeAtomically(join(dir, `${Date.now()}-${token}.orkdes`), bytes);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".orkdes")).sort();
  for (const file of files.slice(0, Math.max(0, files.length - DESIGN_LIMITS.exportBackups))) {
    await unlink(join(dir, file)).catch(() => undefined);
  }
}
