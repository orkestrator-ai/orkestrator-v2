/**
 * ChangeRestoreService: conditional undo of a retained comparison.
 *
 * Restoring a measurement writes each file back to its "before" endpoint, but
 * only where the destination still equals the measured "after" endpoint
 * (content and mode). The check is repeated at the owning executor
 * immediately before each write; a destination the user edited since is
 * skipped, never overwritten. A multi-file restore is not atomic: a partial
 * outcome records exactly which writes completed. There is no blind reset.
 */

import { randomUUID } from "node:crypto";
import type {
  ChangesApplyRestoreResult,
  ChangesPrepareRestoreResult,
  RestorePreviewFile,
} from "@orkestrator/protocol/change-resources";
import { runCommandBuffer } from "../shell.js";
import {
  decodePath,
  displayPath,
  readManifest,
  type Manifest,
  type ReadRecord,
} from "./capture.js";
import { validCapturePath } from "./confined-read.js";
import type { ChangeLedger } from "./change-ledger.js";
import type { ObjectStore } from "./object-store.js";
import type { WorktreeRegistry, WorktreeChangeOwner } from "./worktree-owner.js";

interface RestoreAction {
  pathId: string;
  /** Blob the destination must currently hold; null = must be absent. */
  expectedOid: string | null;
  expectedMode?: string | null;
  groupId?: string;
  previewPathId?: string;
  guard?: { pathId: string; expectedOid: string | null; expectedMode?: string | null };
  /** Blob to write; null = delete. */
  targetBlob: string | null;
  mode: string | null;
}

interface RestoreTokenPayload {
  measurementId: string;
  worktreeId: string;
  actions: RestoreAction[];
}

export type ConditionalWriteOutcome = "applied" | "precondition-failed" | "failed";

/** Reject anything that could leave the worktree root. */
export function safeRelativePath(pathId: string): string | null {
  if (!validCapturePath(decodePath(pathId))) return null;
  return Buffer.from(decodePath(pathId)).toString();
}

/** Same root-pinned helper on the host and beside the container filesystem. */
export async function hostConditionalWrite(
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  return executeConditionalWrite(
    process.execPath,
    ["-e", CONTAINER_RESTORE_HELPER],
    root,
    action,
    bytes,
  );
}

export const CONTAINER_RESTORE_HELPER = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const out = result => process.stdout.write(JSON.stringify({ result }));
let temp;
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const root = fs.realpathSync(input.root), expectedRoot = fs.lstatSync(root);
  const valid = rel => rel && !rel.includes("\0") && !rel.includes("\\") && !/^[A-Za-z]:/.test(rel) && rel.split("/").every(p => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
  const pin = (encoded, create) => {
    const rel = Buffer.from(encoded, "base64").toString();
    if (!valid(rel)) throw new Error("path");
    process.chdir(root);
    const opened = fs.statSync(".");
    if (opened.dev !== expectedRoot.dev || opened.ino !== expectedRoot.ino) throw new Error("root");
    const parts = rel.split("/"), name = parts.pop();
    for (const p of parts) {
      if (create) { try { fs.mkdirSync(p); } catch (e) { if (e.code !== "EEXIST") throw e; } }
      const info = fs.lstatSync(p);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ancestor");
      process.chdir(p);
      const pinned = fs.statSync(".");
      if (info.dev !== pinned.dev || info.ino !== pinned.ino) throw new Error("ancestor");
    }
    return name;
  };
  const matches = (file, oid, mode) => {
    let s;
    try { s = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return oid === null && mode == null; throw e; }
    if (!s.isFile() || s.isSymbolicLink() || s.size > 16 * 1024 * 1024) return false;
    if (mode !== undefined && mode !== ((s.mode & 0o111) ? "100755" : "100644")) return false;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.dev !== s.dev || info.ino !== s.ino) return false;
      const b = Buffer.alloc(s.size + 1); let size = 0;
      while (size < b.length) { const n = fs.readSync(fd, b, size, b.length - size, null); if (!n) break; size += n; }
      const after = fs.fstatSync(fd);
      if (size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) return false;
      return crypto.createHash("sha1").update("blob " + size + "\0").update(b.subarray(0, size)).digest("hex") === oid;
    } finally { fs.closeSync(fd); }
  };
  if (input.guard) {
    const guarded = pin(input.guard.path, false);
    if (!matches(guarded, input.guard.expectedOid, input.guard.expectedMode)) { out("precondition-failed"); process.exit(0); }
  }
  const file = pin(input.path, true);
  if (!matches(file, input.expected, input.expectedMode)) { out("precondition-failed"); process.exit(0); }
  if (input.content === null) { fs.unlinkSync(file); out("applied"); }
  else {
    temp = "." + file + ".orkestrator-restore-" + crypto.randomUUID();
    fs.writeFileSync(temp, Buffer.from(input.content, "base64"), { mode: input.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    if (!matches(file, input.expected, input.expectedMode)) { out("precondition-failed"); }
    else {
      if (input.expected === null) fs.linkSync(temp, file);
      else fs.renameSync(temp, file);
      out("applied");
    }
  }
} catch { out("failed"); }
finally { if (temp) try { fs.rmSync(temp, { force: true }); } catch {} }
`;

async function executeConditionalWrite(
  command: string,
  args: string[],
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  try {
    const result = await runCommandBuffer(command, args, {
      stdin: JSON.stringify({
        root,
        path: Buffer.from(decodePath(action.pathId)).toString("base64"),
        expected: action.expectedOid,
        expectedMode: action.expectedMode,
        content: bytes ? Buffer.from(bytes).toString("base64") : null,
        mode: action.mode,
        ...(action.guard
          ? {
              guard: {
                ...action.guard,
                path: Buffer.from(decodePath(action.guard.pathId)).toString("base64"),
              },
            }
          : {}),
      }),
      timeoutMs: 60_000,
    });
    const parsed = JSON.parse(result.stdout.toString("utf8")) as {
      result?: ConditionalWriteOutcome;
    };
    return parsed.result ?? "failed";
  } catch {
    return "failed";
  }
}

export async function containerConditionalWrite(
  containerId: string,
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  return executeConditionalWrite(
    "docker",
    ["exec", "-i", containerId, "node", "-e", CONTAINER_RESTORE_HELPER],
    root,
    action,
    bytes,
  );
}

function matchesAction(action: RestoreAction, record: ReadRecord | undefined): boolean {
  if (!record) return false;
  if (record.kind === "missing") return action.expectedOid === null && action.expectedMode == null;
  return (
    (record.kind === "file" || record.kind === "symlink") &&
    record.stable &&
    record.oid === action.expectedOid &&
    (action.expectedMode === undefined || record.mode === action.expectedMode)
  );
}

export class ChangeRestoreService {
  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      store: ObjectStore;
      registry: WorktreeRegistry;
      enabled: () => boolean;
      tokenTtlMs: () => number;
      onApplied?: (worktreeId: string, environmentId: string | null) => void;
    },
  ) {}

  private manifestEntry(manifest: Manifest, pathId: string | null) {
    return pathId ? (manifest.entries.find((entry) => entry.p === pathId) ?? null) : null;
  }

  async prepare(input: {
    measurementId: string;
    pathIds?: readonly string[];
  }): Promise<ChangesPrepareRestoreResult> {
    if (!this.deps.enabled()) return { kind: "disabled", reasonKey: "changes.restore.disabled" };
    const { ledger, store } = this.deps;
    const measurement = ledger.measurement(input.measurementId);
    if (!measurement)
      return { kind: "error", error: { code: "not-found", reasonKey: "changes.error.not-found" } };
    if (
      measurement.origin !== "captured-endpoints" ||
      !measurement.beforeSnapshotId ||
      !measurement.afterSnapshotId ||
      measurement.finality !== "final"
    ) {
      return { kind: "disabled", reasonKey: "changes.restore.no-retained-endpoints" };
    }
    const before = ledger.snapshot(measurement.beforeSnapshotId);
    const after = ledger.snapshot(measurement.afterSnapshotId);
    const beforeManifest = before ? await readManifest(store, before.tree_oid) : null;
    const afterManifest = after ? await readManifest(store, after.tree_oid) : null;
    if (!beforeManifest || !afterManifest)
      return { kind: "disabled", reasonKey: "changes.restore.body-expired" };
    const owner = this.deps.registry.ownerById(measurement.worktreeId);
    if (!owner) return { kind: "disabled", reasonKey: "changes.restore.worktree-gone" };
    const wanted = input.pathIds ? new Set(input.pathIds) : null;
    const actions: RestoreAction[] = [];
    const preview: RestorePreviewFile[] = [];
    const total = ledger.measurementFileCount(measurement.measurementId);
    for (let offset = 0; offset < total; offset += 500) {
      for (const row of ledger.measurementFiles(measurement.measurementId, offset, 500)) {
        if (wanted && !wanted.has(row.path_id)) continue;
        const display = displayPath(row.new_path ?? row.old_path ?? row.path_id);
        const skip = (reasonKey: string) =>
          preview.push({ pathId: row.path_id, pathDisplay: display, action: "skip", reasonKey });
        if (row.status === "unknown") {
          skip("changes.restore.before-unknown");
          continue;
        }
        if (row.file_kind === "gitlink" || row.file_kind === "symlink") {
          skip(`changes.restore.${row.file_kind}-unsupported`);
          continue;
        }
        const oldEntry = this.manifestEntry(beforeManifest, row.old_path);
        const newEntry = this.manifestEntry(afterManifest, row.new_path);
        if (oldEntry && !(await store.has(oldEntry.o))) {
          skip("changes.restore.before-expired");
          continue;
        }
        if (row.old_path && row.new_path && row.old_path !== row.new_path) {
          if (!safeRelativePath(row.old_path) || !safeRelativePath(row.new_path)) {
            skip("changes.restore.path-outside-worktree");
            continue;
          }
          // Both preconditions belong to one unit. Restore the old name first.
          actions.push({
            pathId: row.old_path,
            expectedOid: null,
            expectedMode: null,
            targetBlob: oldEntry?.o ?? null,
            mode: oldEntry?.m ?? null,
            groupId: row.path_id,
            previewPathId: row.path_id,
          });
          actions.push({
            pathId: row.new_path,
            expectedOid: newEntry?.o ?? null,
            expectedMode: newEntry?.m ?? null,
            targetBlob: null,
            mode: null,
            groupId: row.path_id,
            previewPathId: row.path_id,
          });
          preview.push({
            pathId: row.path_id,
            pathDisplay: display,
            action: "write",
            reasonKey: "changes.restore.rename-back",
          });
          continue;
        }
        const pathId = row.new_path ?? row.old_path ?? row.path_id;
        if (!safeRelativePath(pathId)) {
          skip("changes.restore.path-outside-worktree");
          continue;
        }
        actions.push({
          pathId,
          expectedOid: newEntry?.o ?? null,
          expectedMode: newEntry?.m ?? null,
          previewPathId: row.path_id,
          targetBlob: oldEntry?.o ?? null,
          mode: oldEntry?.m ?? null,
        });
        preview.push({
          pathId: row.path_id,
          pathDisplay: display,
          action: oldEntry ? "write" : "delete",
          reasonKey: null,
        });
      }
    }
    // Preflight the destination against the measured after-state.
    const described = new Map<string, ReadRecord>();
    const signal = AbortSignal.timeout(10_000);
    try {
      const batchSize = owner.executor.kind === "host-worker" ? 1 : 5_000;
      for (let index = 0; index < actions.length; index += batchSize) {
        const batch = await owner.executor.describe(
          actions.slice(index, index + batchSize).map((action) => action.pathId),
          {
            maxCandidates: actions.length,
            maxFileBytes: 16 * 1024 * 1024,
            maxCaptureBytes: 256 * 1024 * 1024,
            readers: 1,
            stableReadAttempts: 2,
          },
          signal,
        );
        for (const record of batch) {
          // Only the precondition metadata belongs in a restore preview.
          if (record.kind === "file" || record.kind === "symlink") record.bytes = undefined;
          described.set(record.pathId, record);
        }
      }
    } catch {
      return { kind: "disabled", reasonKey: "changes.restore.runtime-unavailable" };
    }
    const matches = (action: RestoreAction) => matchesAction(action, described.get(action.pathId));
    const blocked = new Set(
      actions.filter((action) => !matches(action)).map((action) => action.groupId ?? action.pathId),
    );
    const runnable = actions.filter((action) => !blocked.has(action.groupId ?? action.pathId));
    for (const action of actions) {
      if (runnable.includes(action)) continue;
      const entry = preview.find((file) => file.pathId === (action.previewPathId ?? action.pathId));
      if (entry) {
        entry.action = "skip";
        entry.reasonKey = "changes.restore.destination-changed";
      }
    }
    const token = `rst_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + this.deps.tokenTtlMs()).toISOString();
    const payload: RestoreTokenPayload = {
      measurementId: measurement.measurementId,
      worktreeId: measurement.worktreeId,
      actions: runnable,
    };
    ledger.transaction(() =>
      ledger.insertRestoreToken({
        token,
        measurementId: measurement.measurementId,
        payloadJson: JSON.stringify(payload),
        ownerFence: owner.ownerFence(),
        expiresAt,
      }),
    );
    return {
      kind: "preview",
      actionToken: token,
      expiresAt,
      files: preview,
      residualRiskKeys: [
        "changes.restore.risk.external-writers",
        ...(runnable.length > 1 ? ["changes.restore.risk.not-atomic"] : []),
      ],
    };
  }

  async apply(input: {
    actionToken: string;
    idempotencyKey: string;
  }): Promise<ChangesApplyRestoreResult> {
    const { ledger, store } = this.deps;
    const previous = ledger.restoreOperationByKey(input.idempotencyKey);
    if (previous?.outcome_json)
      return JSON.parse(previous.outcome_json) as ChangesApplyRestoreResult;
    if (previous)
      return {
        kind: "error",
        error: { code: "precondition-failed", reasonKey: "changes.restore.in-progress" },
      };
    const token = ledger.restoreToken(input.actionToken);
    if (!token)
      return { kind: "error", error: { code: "not-found", reasonKey: "changes.error.not-found" } };
    if (token.consumed_at || Date.parse(token.expires_at) < Date.now()) {
      return {
        kind: "error",
        error: { code: "token-expired", reasonKey: "changes.restore.token-expired" },
      };
    }
    const payload = JSON.parse(token.payload_json) as RestoreTokenPayload;
    const owner = this.deps.registry.ownerById(payload.worktreeId);
    if (!owner)
      return {
        kind: "error",
        error: { code: "resource-deleted", reasonKey: "changes.restore.worktree-gone" },
      };
    if (owner.ownerFence() !== token.owner_fence) {
      return {
        kind: "error",
        error: { code: "owner-replaced", reasonKey: "changes.error.owner-replaced" },
      };
    }
    const operationId = `rop_${randomUUID()}`;
    const admitted = ledger.transaction(() => {
      owner.assertCurrent();
      if (!ledger.consumeRestoreToken(input.actionToken)) return false;
      ledger.insertRestoreOperation({
        id: operationId,
        idempotencyKey: input.idempotencyKey,
        token: input.actionToken,
        measurementId: payload.measurementId,
      });
      return true;
    });
    if (!admitted)
      return {
        kind: "error",
        error: { code: "token-expired", reasonKey: "changes.restore.token-expired" },
      };
    const completed: string[] = [];
    const failed: string[] = [];
    let outcome: ChangesApplyRestoreResult;
    try {
      const checkpoint = await owner.capture({
        purpose: "restore-checkpoint",
        deadlineMs: 10_000,
        boundaryKey: `restore-checkpoint:${operationId}`,
      });
      if (checkpoint.kind !== "published") throw new Error("checkpoint-unavailable");
      // Keep the recovery checkpoint independently reachable.
      ledger.transaction(() =>
        ledger.addReference({
          ownerKind: "restore",
          ownerId: operationId,
          snapshotId: checkpoint.snapshotId,
          reason: "restore-checkpoint",
        }),
      );
      const groups = new Map<string, RestoreAction[]>();
      for (const action of payload.actions) {
        const key = action.groupId ?? action.pathId;
        const group = groups.get(key) ?? [];
        group.push(action);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if (group.length === 2)
          group[0]!.guard = {
            pathId: group[1]!.pathId,
            expectedOid: group[1]!.expectedOid,
            expectedMode: group[1]!.expectedMode,
          };
        // Check both rename endpoints at apply time before either mutation.
        const current = await owner.executor
          .describe(
            group.map((a) => a.pathId),
            {
              maxCandidates: group.length,
              maxFileBytes: 16 * 1024 * 1024,
              maxCaptureBytes: 256 * 1024 * 1024,
              readers: 1,
              stableReadAttempts: 2,
            },
            new AbortController().signal,
          )
          .catch(() => []);
        if (
          group.some(
            (action) =>
              !matchesAction(
                action,
                current.find((record) => record.pathId === action.pathId),
              ),
          )
        ) {
          failed.push(...group.map((a) => a.pathId));
          continue;
        }
        let blocked = false;
        for (const action of group) {
          try {
            owner.assertCurrent();
            const bytes = action.targetBlob ? await store.get(action.targetBlob) : null;
            const result =
              blocked || (action.targetBlob && !bytes)
                ? "failed"
                : await this.write(owner, action, bytes);
            if (result === "applied") completed.push(action.pathId);
            else {
              failed.push(action.pathId);
              blocked = true;
            }
          } catch {
            failed.push(action.pathId);
            blocked = true;
          }
        }
      }
      owner.invalidate(completed);
      await owner.capture({
        purpose: "restore-result",
        deadlineMs: 10_000,
        boundaryKey: `restore-result:${operationId}`,
      });
      outcome = {
        kind: "applied",
        operationId,
        outcome: failed.length === 0 ? "complete" : "partial",
        completedPathIds: completed,
        failedPathIds: failed,
        resultMeasurementId: null,
      };
    } catch {
      outcome =
        completed.length > 0
          ? {
              kind: "applied",
              operationId,
              outcome: "partial",
              completedPathIds: completed,
              failedPathIds: payload.actions
                .map((a) => a.pathId)
                .filter((id) => !completed.includes(id)),
              resultMeasurementId: null,
            }
          : {
              kind: "error",
              error: {
                code: "precondition-failed",
                reasonKey: "changes.restore.checkpoint-unavailable",
              },
            };
    }
    ledger.transaction(() =>
      ledger.finishRestoreOperation(
        operationId,
        outcome.kind === "applied" ? outcome.outcome : "failed",
        JSON.stringify(outcome),
      ),
    );
    const environmentId =
      ledger.measurement(payload.measurementId)?.logicalOwner.environmentId ?? null;
    this.deps.onApplied?.(payload.worktreeId, environmentId);
    return outcome;
  }

  private write(
    owner: WorktreeChangeOwner,
    action: RestoreAction,
    bytes: Uint8Array | null,
  ): Promise<ConditionalWriteOutcome> {
    const identity = owner.identity;
    return identity.runtimeKind === "container"
      ? containerConditionalWrite(identity.runtimeId, identity.canonicalRoot, action, bytes)
      : hostConditionalWrite(identity.canonicalRoot, action, bytes);
  }
}
