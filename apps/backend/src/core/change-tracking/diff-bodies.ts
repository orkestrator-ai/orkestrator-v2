import { validCapturePath } from "./confined-read.js";
/**
 * Immutable diff bodies and live-detail resolution.
 *
 * `getDiff` answers for a DiffIdentity: a comparison or file pair resolves
 * only through the snapshot store, a payload only through retained evidence.
 * A missing body is answered `body-expired` with the retained measurement —
 * never with today's file. Whitespace-insensitive rendering is a separate view
 * identity; it never changes the measurement's counts.
 *
 * `resolveLiveDetail` turns a row of a live environment projection into a new
 * immutable file identity: it reads the current file and the baseline blob,
 * stores both, and measures them. If the projection moved on meanwhile the
 * request is `stale-revision`, so a body can never be attached to a summary it
 * did not produce.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ProviderEvidence } from "@orkestrator/protocol/change-evidence";
import {
  exactCount,
  notApplicableCount,
  unknownCount,
} from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  parseChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangesGetDiffRequest,
  type ChangesGetDiffResult,
  type ChangesResolveLiveDetailResult,
  type DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import {
  HUNK_RENDERER_POLICY_ID,
  RAW_LINES_ALGORITHM_ID,
} from "@orkestrator/protocol/node/change-tracking/count-policy";
import { measureEvidence } from "@orkestrator/protocol/node/change-tracking/evidence-measure";
import {
  countRawLineChanges,
  diffRawLines,
  isProbablyBinary,
} from "@orkestrator/protocol/node/change-tracking/raw-line-diff";
import { CommandFailedError, runCommandBuffer } from "../shell.js";
import {
  decodePath,
  displayPath,
  encodePath,
  readManifest,
  SAFE_GIT_CONFIG,
  type ManifestEntry,
} from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";
import type { EvidenceBodyStore } from "./evidence-body-store.js";
import type { ChangeMeasurementService } from "./measurement-service.js";
import type { ObjectStore } from "./object-store.js";
import { provenanceKey, type ChangeProjectionService } from "./projection-service.js";
import type { SnapshotFileChange } from "./snapshot-diff.js";
import { renderSnapshotBodies } from "./snapshot-diff.js";
import type { WorktreeRegistry, WorktreeTarget } from "./worktree-owner.js";
import { committedHead } from "./git-scopes.js";

const FILES_PER_BODY_PAGE = 20;
export const LIVE_FILE_REPRESENTATION_ID = "git-baseline-vs-worktree-bytes-v1";
/** committed-net: the baseline blob against HEAD's blob, both read with `git cat-file`. */
export const COMMITTED_FILE_REPRESENTATION_ID = "git-baseline-vs-head-bytes-v1";

/**
 * Live rows a file body can be resolved for: the environment's own
 * measurement, and the two Git scopes that split it at HEAD. Their
 * `baselineVersion` ends in the before side's commit (`…@<oid>`).
 */
const LIVE_DETAIL_SCOPES: ReadonlySet<string> = new Set([
  "environment-net",
  "uncommitted-net",
  "committed-net",
]);
type LiveDetailScope = "environment-net" | "uncommitted-net" | "committed-net";

function err(
  code: "not-found" | "body-expired" | "invalid-request" | "stale-revision",
  identityId: string,
): ChangesGetDiffResult {
  return { kind: "error", error: { code, reasonKey: `changes.error.${code}` }, identityId };
}

export class DiffBodyService {
  /** Snapshot ids being read; retention never sweeps them mid-read. */
  readonly readerPins = new Map<string, number>();

  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      store: ObjectStore;
      bodies: EvidenceBodyStore;
      measurements: ChangeMeasurementService;
      projections: ChangeProjectionService;
      registry: WorktreeRegistry;
      environmentTarget: (environmentId: string) => Promise<WorktreeTarget | null>;
      batchBytes: number;
    },
  ) {}

  private pin(ids: readonly (string | null)[]): () => void {
    for (const id of ids) if (id) this.readerPins.set(id, (this.readerPins.get(id) ?? 0) + 1);
    return () => {
      for (const id of ids) {
        if (!id) continue;
        const count = (this.readerPins.get(id) ?? 1) - 1;
        if (count <= 0) this.readerPins.delete(id);
        else this.readerPins.set(id, count);
      }
    };
  }

  async getDiff(request: ChangesGetDiffRequest): Promise<ChangesGetDiffResult> {
    const identity = this.deps.ledger.diffIdentity(request.diffIdentityId);
    if (!identity) return err("not-found", request.diffIdentityId);
    const release = this.deps.ledger.pinMeasurement(identity.measurementId);
    try {
      return await this.readPinnedDiff(request, identity);
    } finally {
      release();
    }
  }

  private async readPinnedDiff(
    request: ChangesGetDiffRequest,
    identity: DiffIdentity,
  ): Promise<ChangesGetDiffResult> {
    const measurement = this.deps.ledger.measurement(identity.measurementId);
    const ignoreWhitespace = request.display?.whitespace === "ignore-for-view";
    const viewIdentityId = ignoreWhitespace ? `${identity.id}:ws-ignore` : identity.id;
    const offset = request.cursor ? Number.parseInt(request.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) return err("invalid-request", identity.id);
    const budget = {
      maxBatchBytes: this.deps.batchBytes,
      ...(request.display?.contextLines !== undefined
        ? { contextLines: Math.max(0, Math.min(20, request.display.contextLines)) }
        : {}),
    };

    if (identity.kind === "comparison") {
      const before = this.deps.ledger.snapshot(identity.beforeSnapshotId);
      const after = this.deps.ledger.snapshot(identity.afterSnapshotId);
      const release = this.pin([identity.beforeSnapshotId, identity.afterSnapshotId]);
      try {
        const beforeManifest = before ? await readManifest(this.deps.store, before.tree_oid) : null;
        const afterManifest = after ? await readManifest(this.deps.store, after.tree_oid) : null;
        if (!beforeManifest || !afterManifest) {
          return {
            kind: "error",
            error: { code: "body-expired", reasonKey: "changes.error.body-expired" },
            identityId: identity.id,
          };
        }
        const rows = this.deps.ledger.measurementFiles(
          identity.measurementId,
          offset,
          FILES_PER_BODY_PAGE,
        );
        const total = this.deps.ledger.measurementFileCount(identity.measurementId);
        const entry = (
          manifest: typeof beforeManifest,
          pathId: string | null,
          blob: string | null,
        ): ManifestEntry | null =>
          pathId
            ? (manifest.entries.find(
                (candidate) => candidate.p === pathId && (!blob || candidate.o === blob),
              ) ?? null)
            : null;
        const files: SnapshotFileChange[] = rows.map((row) => ({
          pathId: row.path_id,
          oldPathId: row.old_path,
          newPathId: row.new_path,
          status: row.status as SnapshotFileChange["status"],
          fileKind: row.file_kind as SnapshotFileChange["fileKind"],
          oldEntry: entry(beforeManifest, row.old_path, row.old_blob),
          newEntry: entry(afterManifest, row.new_path, row.new_blob),
          additions: unknownCount(),
          deletions: unknownCount(),
          reason: row.reason,
        }));
        const bodies = await this.renderView(files, budget, ignoreWhitespace);
        return {
          kind: "body",
          identity,
          measurement,
          files: bodies,
          nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
          viewIdentityId,
          provenanceLabelKey: measurement ? provenanceKey(measurement) : null,
        };
      } finally {
        release();
      }
    }

    if (identity.kind === "file") {
      const read = async (side: typeof identity.before) =>
        side.state === "present"
          ? await this.deps.store.get(side.blobId)
          : side.state === "absent"
            ? new Uint8Array()
            : null;
      const oldBytes = await read(identity.before);
      const newBytes = await read(identity.after);
      const base = {
        pathId:
          identity.after.state === "present"
            ? identity.after.pathId
            : identity.before.state === "present"
              ? identity.before.pathId
              : "",
        oldPathDisplay: identity.basePathDisplay,
        newPathDisplay: identity.targetPathDisplay,
        status: (identity.before.state === "absent"
          ? "added"
          : identity.after.state === "absent"
            ? "deleted"
            : "modified") as ChangeDiffFileBody["status"],
      };
      if (!oldBytes || !newBytes) {
        return {
          kind: "error",
          error: { code: "body-expired", reasonKey: "changes.error.body-expired" },
          identityId: identity.id,
        };
      }
      if (isProbablyBinary(oldBytes) || isProbablyBinary(newBytes)) {
        return {
          kind: "body",
          identity,
          measurement,
          files: [
            {
              ...base,
              fileKind: "binary",
              bodyAvailability: "available",
              reasonKey: "changes.body.binary",
              hunks: [],
              truncated: false,
            },
          ],
          nextCursor: null,
          viewIdentityId,
          provenanceLabelKey: measurement ? provenanceKey(measurement) : null,
        };
      }
      const diff = diffRawLines(oldBytes, newBytes, budget, undefined, { ignoreWhitespace });
      return {
        kind: "body",
        identity,
        measurement,
        files: [
          {
            ...base,
            fileKind: "text",
            bodyAvailability: "available",
            reasonKey: diff.kind === "diff" ? null : `changes.body.${diff.reason}`,
            hunks: diff.kind === "diff" ? diff.hunks : [],
            truncated: diff.kind !== "diff" || diff.truncated,
          },
        ],
        nextCursor: null,
        viewIdentityId,
        provenanceLabelKey: measurement ? provenanceKey(measurement) : null,
      };
    }

    // Payload: re-render the measurement's own retained evidence revisions.
    const refs = measurement?.evidenceRefs ?? [
      { evidenceId: identity.evidenceId, evidenceRevision: identity.evidenceRevision },
    ];
    const files: ChangeDiffFileBody[] = [];
    for (const ref of refs) {
      const row = this.deps.ledger.evidenceRevision(ref.evidenceId, ref.evidenceRevision);
      if (!row) continue;
      const evidence = (JSON.parse(row.evidence_json) as { evidence: ProviderEvidence }).evidence;
      const bytes = new Map<string, Uint8Array>();
      for (const id of bodyIds(evidence)) {
        const body = await this.deps.bodies.get(id);
        if (body) bytes.set(id, body);
      }
      const measured = measureEvidence(evidence, (id) => bytes.get(id) ?? null, {
        withHunks: true,
        selectedPaths: "selectedPaths" in ref ? ref.selectedPaths : undefined,
      });
      for (const file of measured.files) {
        const available = bodyIds(evidence).every((id) => bytes.has(id));
        files.push({
          pathId: file.path ?? "",
          oldPathDisplay: file.previousPath ?? (file.status === "added" ? null : file.path),
          newPathDisplay: file.status === "deleted" ? null : file.path,
          status: file.status,
          fileKind: file.fileKind,
          bodyAvailability: available ? "available" : "expired",
          reasonKey: available
            ? file.reasons[0]
              ? `changes.reason.${file.reasons[0]}`
              : null
            : "changes.body.expired",
          hunks: file.hunks ?? [],
          truncated: file.bodyTruncated,
        });
      }
    }
    return {
      kind: "body",
      identity,
      measurement,
      files: files.slice(offset, offset + FILES_PER_BODY_PAGE),
      nextCursor:
        offset + FILES_PER_BODY_PAGE < files.length ? String(offset + FILES_PER_BODY_PAGE) : null,
      viewIdentityId,
      provenanceLabelKey: measurement ? provenanceKey(measurement) : null,
    };
  }

  private async renderView(
    files: SnapshotFileChange[],
    budget: { maxBatchBytes: number; contextLines?: number },
    ignoreWhitespace: boolean,
  ): Promise<ChangeDiffFileBody[]> {
    if (!ignoreWhitespace) return renderSnapshotBodies(this.deps.store, files, budget);
    const bodies: ChangeDiffFileBody[] = [];
    for (const file of files) {
      const [rendered] = await renderSnapshotBodies(this.deps.store, [file], budget);
      if (!rendered || rendered.fileKind !== "text" || !file.oldEntry || !file.newEntry) {
        if (rendered) bodies.push(rendered);
        continue;
      }
      const oldBytes = await this.deps.store.get(file.oldEntry.o);
      const newBytes = await this.deps.store.get(file.newEntry.o);
      if (!oldBytes || !newBytes) {
        bodies.push(rendered);
        continue;
      }
      const diff = diffRawLines(oldBytes, newBytes, budget, undefined, { ignoreWhitespace: true });
      bodies.push({
        ...rendered,
        hunks: diff.kind === "diff" ? diff.hunks : [],
        truncated: diff.kind !== "diff" || diff.truncated,
      });
    }
    return bodies;
  }

  /**
   * Resolve a live environment row (or, for an explicit current-file action,
   * a path) to a new immutable file identity.
   */
  async resolveLiveDetail(input: {
    resourceKey: string;
    revision?: number;
    rowId?: string;
    pathId?: string;
    /** Plain path, worktree-relative or absolute inside the worktree. */
    path?: string;
  }): Promise<ChangesResolveLiveDetailResult> {
    const parts = parseChangeResourceKey(input.resourceKey);
    if (
      !parts ||
      !LIVE_DETAIL_SCOPES.has(parts.scope) ||
      parts.ownerKind !== "environment" ||
      (parts.scope !== "environment-net" && parts.selector !== "live")
    ) {
      return {
        kind: "error",
        error: { code: "invalid-request", reasonKey: "changes.error.invalid-request" },
      };
    }
    const scope = parts.scope as LiveDetailScope;
    const environmentId = parts.ownerId;
    if (!input.pathId && input.path) {
      const relative = await this.relativePath(environmentId, input.path);
      if (!relative)
        return {
          kind: "error",
          error: { code: "invalid-request", reasonKey: "changes.error.path-outside-worktree" },
        };
      input = { ...input, pathId: encodePath(new TextEncoder().encode(relative)) };
    }
    if (
      input.revision !== undefined &&
      input.revision !== this.deps.projections.revision(input.resourceKey)
    ) {
      return {
        kind: "error",
        error: { code: "stale-revision", reasonKey: "changes.error.stale-revision" },
      };
    }
    const measurement = this.deps.projections.selectedMeasurement(input.resourceKey);
    let row: ReturnType<ChangeLedger["measurementFiles"]>[number] | undefined;
    if (measurement && input.rowId) {
      const [measurementId, ordinal] = input.rowId.split(":");
      if (measurementId !== measurement.measurementId) {
        return {
          kind: "error",
          error: { code: "stale-revision", reasonKey: "changes.error.stale-revision" },
        };
      }
      row = this.deps.ledger.measurementFiles(measurement.measurementId, Number(ordinal), 1)[0];
    } else if (measurement && input.pathId) {
      const total = this.deps.ledger.measurementFileCount(measurement.measurementId);
      for (let offset = 0; offset < total && !row; offset += 500) {
        row = this.deps.ledger
          .measurementFiles(measurement.measurementId, offset, 500)
          .find(
            (candidate) =>
              candidate.path_id === input.pathId || candidate.new_path === input.pathId,
          );
      }
    }
    const pathId = row?.new_path ?? row?.path_id ?? input.pathId;
    if (!pathId)
      return { kind: "error", error: { code: "not-found", reasonKey: "changes.error.not-found" } };
    // A Git scope's rows are Git's view; a path Git measures through a filter
    // program has no raw-byte body that would match it.
    if (scope !== "environment-net" && (!row || row.reason === "git-filter-unsupported"))
      return {
        kind: "error",
        error: {
          code: row ? "unsupported-capability" : "invalid-request",
          reasonKey: row
            ? "changes.reason.git-filter-unsupported"
            : "changes.error.invalid-request",
        },
      };
    if (!validCapturePath(decodePath(pathId)))
      return {
        kind: "error",
        error: { code: "invalid-request", reasonKey: "changes.error.invalid-request" },
      };
    const oldPathId = row ? row.old_path : pathId;
    const target = await this.deps.environmentTarget(environmentId);
    const identity = target ? await this.deps.registry.resolve(target) : null;
    if (!target || !identity) {
      return {
        kind: "error",
        error: { code: "unsupported-capability", reasonKey: "changes.error.runtime-unavailable" },
      };
    }
    const owner = this.deps.registry.owner(identity);
    // Claim the fence before reading, so a takeover during the read is seen.
    owner.ownerFence();
    const baseline = measurement?.baselineVersion?.split("@")[1] ?? null;
    // committed-net's after side is HEAD's blob, never the working tree.
    const afterCommit =
      scope === "committed-net" ? committedHead(measurement?.baselineVersion) : null;
    if (scope === "committed-net" && !afterCommit)
      return {
        kind: "error",
        error: { code: "stale-revision", reasonKey: "changes.error.stale-revision" },
      };
    // Current side: read through the owner's executor (host or container).
    const deleted = row?.status === "deleted";
    const signal = new AbortController().signal;
    const [current] =
      deleted || afterCommit
        ? [null]
        : await owner.executor.fetch(
            [pathId],
            {
              maxCandidates: 1,
              maxFileBytes: 16 * 1024 * 1024,
              maxCaptureBytes: 16 * 1024 * 1024,
              readers: 1,
              stableReadAttempts: 2,
            },
            signal,
          );
    let afterBlob: string | null = null;
    if (afterCommit && !deleted) {
      const bytes = await this.readBaseline(target, afterCommit, pathId);
      if (bytes) afterBlob = (await this.deps.store.put("blob", bytes)).id;
    } else if (
      current &&
      (current.kind === "file" || current.kind === "symlink") &&
      current.bytes
    ) {
      afterBlob = (await this.deps.store.put("blob", current.bytes)).id;
    }
    // Baseline side: the immutable commit the projection compared against.
    let beforeBlob: string | null = null;
    const added = row?.status === "added";
    if (!added && baseline && oldPathId) {
      const bytes = await this.readBaseline(target, baseline, oldPathId);
      if (bytes) beforeBlob = (await this.deps.store.put("blob", bytes)).id;
    }
    // A projection that moved while we read cannot own these bytes, nor can a
    // row whose measurement (and baseline) was replaced meanwhile.
    if (
      (input.revision !== undefined &&
        input.revision !== this.deps.projections.revision(input.resourceKey)) ||
      (input.rowId &&
        this.deps.projections.selectedMeasurement(input.resourceKey)?.measurementId !==
          measurement?.measurementId)
    ) {
      return {
        kind: "error",
        error: { code: "stale-revision", reasonKey: "changes.error.stale-revision" },
      };
    }
    // Live reads convert to an immutable identity only under the owner that
    // made them: a replaced owner or worktree cannot publish its reads.
    let ownerCurrent = !this.deps.ledger.worktree(identity.worktreeId)?.tombstoned_at;
    try {
      owner.assertCurrent();
    } catch {
      ownerCurrent = false;
    }
    if (!ownerCurrent) {
      return {
        kind: "error",
        error: { code: "owner-replaced", reasonKey: "changes.error.owner-replaced" },
      };
    }
    const beforeBytes = beforeBlob
      ? await this.deps.store.get(beforeBlob)
      : added
        ? new Uint8Array()
        : null;
    const afterBytes = afterBlob
      ? await this.deps.store.get(afterBlob)
      : deleted
        ? new Uint8Array()
        : null;
    const binary =
      (beforeBytes && isProbablyBinary(beforeBytes)) ||
      (afterBytes && isProbablyBinary(afterBytes));
    const counted =
      beforeBytes && afterBytes && !binary ? countRawLineChanges(beforeBytes, afterBytes) : null;
    const captureId = `live:${randomUUID()}`;
    const measurementDraft = {
      ...this.deps.measurements.base({
        scope,
        owner: { environmentId },
        worktreeId: identity.worktreeId,
        worktreeIncarnation: identity.incarnation,
      }),
      baselineVersion: measurement?.baselineVersion ?? null,
      origin: "captured-endpoints" as const,
      algorithmPolicyId: RAW_LINES_ALGORITHM_ID,
      representationPolicyId: afterCommit
        ? COMMITTED_FILE_REPRESENTATION_ID
        : LIVE_FILE_REPRESENTATION_ID,
      effectClaim: "workspace-observed" as const,
      finality: "provisional" as const,
      boundary: { before: "not-applicable" as const, after: "running-observation" as const },
      attribution: {
        basis: "workspace-observation" as const,
        writerIsolation: "shared" as const,
        overlap: "unknown" as const,
      },
      completeness: {
        files: beforeBytes && afterBytes ? ("complete" as const) : ("partial" as const),
        reasons: [
          "live-file-detail",
          ...(baseline ? [] : ["baseline-mutable-ref", "baseline-unavailable"]),
          ...(beforeBytes ? [] : ["baseline-unreadable"]),
          ...(afterBytes ? [] : ["current-unreadable"]),
        ],
        omittedFileCount: 0,
      },
      totals: {
        additions: binary
          ? notApplicableCount()
          : counted?.kind === "counted"
            ? exactCount(counted.additions)
            : unknownCount(),
        deletions: binary
          ? notApplicableCount()
          : counted?.kind === "counted"
            ? exactCount(counted.deletions)
            : unknownCount(),
        changedFiles: beforeBlob === afterBlob && beforeBlob !== null ? 0 : 1,
      },
    };
    const pathHash = createHash("sha256").update(pathId).digest("hex").slice(0, 24);
    const owned = {
      kind: "environment-file",
      id:
        scope === "environment-net"
          ? `${environmentId}:${pathHash}`
          : `${environmentId}:${scope}:${pathHash}`,
    };
    const { measurement: sealed } = this.deps.measurements.seal(measurementDraft, owned, null);
    const diffIdentity: DiffIdentity = {
      // Equal counts can hide different bytes: the identity binds the endpoints.
      id: `diff_${createHash("sha256")
        .update(`${sealed.measurementId}:file:${beforeBlob ?? "-"}:${afterBlob ?? "-"}`)
        .digest("hex")
        .slice(0, 40)}`,
      worktreeId: identity.worktreeId,
      worktreeIncarnation: identity.incarnation,
      scope,
      measurementId: sealed.measurementId,
      algorithmPolicyId: RAW_LINES_ALGORITHM_ID,
      representationPolicyId: afterCommit
        ? COMMITTED_FILE_REPRESENTATION_ID
        : LIVE_FILE_REPRESENTATION_ID,
      rendererPolicyId: HUNK_RENDERER_POLICY_ID,
      whitespacePolicy: "preserve",
      kind: "file",
      before: added
        ? { state: "absent" }
        : beforeBlob
          ? {
              state: "present",
              snapshotId: `gitref:${baseline}`,
              pathId: oldPathId ?? pathId,
              blobId: beforeBlob,
            }
          : { state: "unknown", reason: baseline ? "baseline-unreadable" : "baseline-mutable-ref" },
      after: deleted
        ? { state: "absent" }
        : afterBlob
          ? {
              state: "present",
              snapshotId: afterCommit ? `gitref:${afterCommit}` : captureId,
              pathId,
              blobId: afterBlob,
            }
          : { state: "unknown", reason: "current-unreadable" },
      basePathDisplay: oldPathId ? displayPath(oldPathId) : null,
      targetPathDisplay: deleted ? null : displayPath(pathId),
    };
    const finalMeasurement = { ...sealed, diffIdentityId: diffIdentity.id };
    this.deps.measurements.publishDetached(finalMeasurement, owned, diffIdentity);
    return { kind: "identity", identity: diffIdentity };
  }

  /** Relativize a client path against the environment's worktree; null if outside. */
  private async relativePath(environmentId: string, raw: string): Promise<string | null> {
    const target = await this.deps.environmentTarget(environmentId);
    if (!target) return null;
    const root = target.kind === "local" ? target.worktreePath : (target.root ?? "/workspace");
    const normalized = raw.replaceAll("\\", "/");
    let relative = normalized;
    if (normalized.startsWith("/")) {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      if (!normalized.startsWith(prefix)) return null;
      relative = normalized.slice(prefix.length);
    }
    relative = relative.replace(/^\.\//, "");
    if (!relative || relative.split("/").some((part) => part === ".." || part === "")) return null;
    return relative;
  }

  private async readBaseline(
    target: WorktreeTarget,
    oid: string,
    pathId: string,
  ): Promise<Uint8Array | null> {
    const path = Buffer.from(decodePath(pathId)).toString();
    try {
      if (target.kind === "local") {
        const result = await runCommandBuffer(
          "git",
          [...SAFE_GIT_CONFIG, "-C", target.worktreePath, "cat-file", "blob", `${oid}:${path}`],
          {
            timeoutMs: 20_000,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          },
        );
        return new Uint8Array(result.stdout);
      }
      const result = await runCommandBuffer(
        "docker",
        [
          "exec",
          target.containerId,
          "git",
          "-C",
          target.root ?? "/workspace",
          ...SAFE_GIT_CONFIG,
          "cat-file",
          "blob",
          `${oid}:${path}`,
        ],
        { timeoutMs: 20_000 },
      );
      return new Uint8Array(result.stdout);
    } catch (error) {
      if (error instanceof CommandFailedError) return null;
      return null;
    }
  }
}

function bodyIds(evidence: ProviderEvidence): string[] {
  if (evidence.kind === "patch")
    return evidence.body.state === "available" ? [evidence.body.id] : [];
  if (evidence.kind === "replacement") {
    return [evidence.before, evidence.after].flatMap((side) =>
      side.state === "present" && side.body.state === "available" ? [side.body.id] : [],
    );
  }
  return [];
}

export { environmentChangeResourceKey };
