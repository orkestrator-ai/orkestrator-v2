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
import {
  FILE_ROWS_CAPPED_REASON,
  type ChangeMeasurement,
} from "@orkestrator/protocol/change-measurements";
import type {
  ChangesApplyRestoreResult,
  ChangesPrepareRestoreResult,
  RestorePreviewFile,
} from "@orkestrator/protocol/change-resources";
import { CommandFailedError, runCommandBuffer } from "../shell.js";
import {
  decodePath,
  displayPath,
  findManifestEntry,
  readManifest,
  type Manifest,
  type ReadRecord,
} from "./capture.js";
import { validCapturePath } from "./confined-read.js";
import type { ChangeLedger } from "./change-ledger.js";
import type { ObjectStore } from "./object-store.js";
import type { ChangeTrackingPolicy } from "./policy-registry.js";
import { compareManifests } from "./snapshot-diff.js";
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

/** What a restore plan needs of one changed file. */
interface RestoreFile {
  path_id: string;
  old_path: string | null;
  new_path: string | null;
  status: string;
  file_kind: string;
}

export type ConditionalWriteOutcome = "applied" | "precondition-failed" | "failed";

/** Reject anything that could leave the worktree root. */
export function safeRelativePath(pathId: string): string | null {
  if (!validCapturePath(decodePath(pathId))) return null;
  return Buffer.from(decodePath(pathId)).toString();
}

/** One conditional write sent to the helper, with the bytes it writes. */
export interface ConditionalWriteItem {
  action: RestoreAction;
  /** Bytes to write; null deletes the destination. */
  bytes: Uint8Array | null;
  /**
   * Writes sharing a group run in order, and once one of them is not applied
   * the helper fails the rest of the group without touching them (both ends
   * of a rename are one unit).
   */
  group?: string;
}

/**
 * How many groups (a file, or both ends of a rename) one helper process
 * writes. Each write is still checked on its own immediately before it
 * happens; batching only removes the per-file process start, which cost 11
 * to 14 ms per file on a quiet host and 30 to 40 ms under load (todo 7555).
 * It also bounds how far an owner replacement can run on: the owner fence is
 * asserted before each batch.
 */
export const RESTORE_WRITE_BATCH_GROUPS = 500;

/**
 * Decoded content one helper invocation may carry. The helper reads its whole
 * stdin, so this bounds its memory (base64 adds a third). A single file is at
 * most 16 MiB, so every group fits a batch of its own.
 */
export const RESTORE_WRITE_BATCH_BYTES = 32 * 1024 * 1024;

/** Same root-pinned helper on the host and beside the container filesystem. */
export async function hostConditionalWrites(
  root: string,
  items: readonly ConditionalWriteItem[],
): Promise<ConditionalWriteOutcome[]> {
  return executeConditionalWrites(process.execPath, ["-e", CONTAINER_RESTORE_HELPER], root, items);
}

export async function containerConditionalWrites(
  containerId: string,
  root: string,
  items: readonly ConditionalWriteItem[],
): Promise<ConditionalWriteOutcome[]> {
  return executeConditionalWrites(
    "docker",
    ["exec", "-i", containerId, "node", "-e", CONTAINER_RESTORE_HELPER],
    root,
    items,
  );
}

/** One write through the batched helper. */
export async function hostConditionalWrite(
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  return (await hostConditionalWrites(root, [{ action, bytes }]))[0] ?? "failed";
}

export async function containerConditionalWrite(
  containerId: string,
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  return (await containerConditionalWrites(containerId, root, [{ action, bytes }]))[0] ?? "failed";
}

/**
 * Reads `{ root, actions: [...] }` from stdin and answers one line
 * `{"i":<index>,"result":...}` per action, in order, written synchronously
 * as each action finishes. A helper that dies part-way has therefore already
 * reported every action it completed; the caller treats any action without a
 * line as failed. Every action repeats the full check: the root and each
 * ancestor directory are pinned, and the destination's content and mode are
 * compared immediately before the temporary sibling is renamed over it.
 */
export const CONTAINER_RESTORE_HELPER = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const out = (i, result) => {
  const line = Buffer.from(JSON.stringify({ i, result }) + "\n");
  for (let off = 0; off < line.length;) {
    try { off += fs.writeSync(1, line, off); } catch (e) { if (e.code !== "EAGAIN") throw e; }
  }
};
let input, root, expectedRoot;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
  root = fs.realpathSync(input.root); expectedRoot = fs.lstatSync(root);
} catch { process.exit(0); }
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
const one = action => {
  let temp;
  try {
    if (action.guard) {
      const guarded = pin(action.guard.path, false);
      if (!matches(guarded, action.guard.expectedOid, action.guard.expectedMode)) return "precondition-failed";
    }
    const file = pin(action.path, true);
    if (!matches(file, action.expected, action.expectedMode)) return "precondition-failed";
    if (action.content === null) { fs.unlinkSync(file); return "applied"; }
    temp = "." + file + ".orkestrator-restore-" + crypto.randomUUID();
    fs.writeFileSync(temp, Buffer.from(action.content, "base64"), { mode: action.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    if (!matches(file, action.expected, action.expectedMode)) return "precondition-failed";
    if (action.expected === null) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
    return "applied";
  } catch { return "failed"; }
  finally { if (temp) try { fs.rmSync(temp, { force: true }); } catch {} }
};
const blocked = new Set();
for (let i = 0; i < input.actions.length; i++) {
  const action = input.actions[i];
  const group = action.group;
  let result;
  if (group != null && blocked.has(group)) result = "failed";
  else {
    result = one(action);
    if (result !== "applied" && group != null) blocked.add(group);
  }
  out(i, result);
}
`;

function helperAction(item: ConditionalWriteItem) {
  const { action, bytes } = item;
  return {
    path: Buffer.from(decodePath(action.pathId)).toString("base64"),
    expected: action.expectedOid,
    expectedMode: action.expectedMode,
    content: bytes ? Buffer.from(bytes).toString("base64") : null,
    mode: action.mode,
    ...(item.group !== undefined ? { group: item.group } : {}),
    ...(action.guard
      ? {
          guard: {
            ...action.guard,
            path: Buffer.from(decodePath(action.guard.pathId)).toString("base64"),
          },
        }
      : {}),
  };
}

/** Result lines the helper wrote, by action index; anything unanswered failed. */
export function parseConditionalWriteResults(
  stdout: Buffer | string,
  count: number,
): ConditionalWriteOutcome[] {
  const results = Array.from<ConditionalWriteOutcome>({ length: count }).fill("failed");
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { i?: unknown; result?: unknown };
      if (
        typeof parsed.i === "number" &&
        Number.isInteger(parsed.i) &&
        parsed.i >= 0 &&
        parsed.i < count &&
        (parsed.result === "applied" ||
          parsed.result === "precondition-failed" ||
          parsed.result === "failed")
      )
        results[parsed.i] = parsed.result;
    } catch {
      // A torn last line (the helper died mid-write) answers nothing.
    }
  }
  return results;
}

async function executeConditionalWrites(
  command: string,
  args: string[],
  root: string,
  items: readonly ConditionalWriteItem[],
): Promise<ConditionalWriteOutcome[]> {
  if (items.length === 0) return [];
  let stdout: Buffer;
  try {
    const result = await runCommandBuffer(command, args, {
      stdin: JSON.stringify({ root, actions: items.map(helperAction) }),
      // The old per-file helper had 60 s each; a batch keeps that floor and
      // grows with its size, far beyond what its in-process writes need.
      timeoutMs: 60_000 + items.length * 100,
    });
    stdout = result.stdout;
  } catch (error) {
    // A helper that was killed or exited badly may still have reported (and
    // so completed) some of its writes; those lines stay authoritative.
    stdout = error instanceof CommandFailedError ? error.stdoutBytes : Buffer.alloc(0);
  }
  return parseConditionalWriteResults(stdout, items.length);
}

/**
 * How long a restore preview may spend checking its destinations. The
 * preflight reads and hashes each planned path one at a time, so a fixed
 * deadline refused exactly the bulk restores a user most wants: on a busy
 * host 10,000 files took up to 15 s and 20,000 up to 35 s (todo 4960). The
 * deadline grows with the plan and stays at least the floor, up to the
 * ceiling.
 */
export function restorePreflightDeadlineMs(
  paths: number,
  policy: Pick<
    ChangeTrackingPolicy,
    "restorePreflightDeadlineMs" | "restorePreflightPerPathMs" | "restorePreflightMaxDeadlineMs"
  >,
): number {
  return Math.min(
    policy.restorePreflightMaxDeadlineMs,
    Math.max(policy.restorePreflightDeadlineMs, paths * policy.restorePreflightPerPathMs),
  );
}

/**
 * How long the apply's recovery checkpoint and result captures may take. The
 * checkpoint captures the whole worktree just after a bulk turn, which is cold
 * for every file the turn wrote when the turn's own end capture was the only
 * earlier publish; a fixed 10 s refused bulk restores on a busy host before
 * writing anything (todo 7310). The user is already waiting on an explicit
 * action, and the checkpoint is what makes the apply recoverable, so it gets
 * at least the turn finalization deadline, more for a large plan as the
 * preview does, up to the same ceiling.
 */
export function restoreCaptureDeadlineMs(
  paths: number,
  policy: Pick<
    ChangeTrackingPolicy,
    | "finalizationDeadlineMs"
    | "restorePreflightDeadlineMs"
    | "restorePreflightPerPathMs"
    | "restorePreflightMaxDeadlineMs"
  >,
): number {
  return Math.max(policy.finalizationDeadlineMs, restorePreflightDeadlineMs(paths, policy));
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
      /** Destination preflight deadline for a plan of this many paths. */
      preflightDeadlineMs: (paths: number) => number;
      /** Checkpoint and result capture deadline for an apply of this many paths. */
      captureDeadlineMs: (paths: number) => number;
      beforeCheckpoint?: (worktreeId: string) => void;
      onApplied?: (worktreeId: string, environmentId: string | null) => void;
    },
  ) {}

  private manifestEntry(manifest: Manifest, pathId: string | null) {
    return pathId ? findManifestEntry(manifest.entries, pathId) : null;
  }

  /**
   * Every file the measurement changed. A capped measurement's rows are only
   * some of them, so the plan comes from the same two manifests they were
   * measured from.
   */
  private async changedFiles(
    measurement: ChangeMeasurement,
    beforeManifest: Manifest,
    afterManifest: Manifest,
  ): Promise<RestoreFile[]> {
    if (measurement.completeness.reasons.includes(FILE_ROWS_CAPPED_REASON)) {
      const comparison = await compareManifests(this.deps.store, beforeManifest, afterManifest, {
        pathsOnly: true,
      });
      return comparison.files.map((file) => ({
        path_id: file.pathId,
        old_path: file.oldPathId,
        new_path: file.newPathId,
        status: file.status,
        file_kind: file.fileKind,
      }));
    }
    const { ledger } = this.deps;
    const files: RestoreFile[] = [];
    const total = ledger.measurementFileCount(measurement.measurementId);
    for (let offset = 0; offset < total; offset += 500) {
      files.push(...ledger.measurementFiles(measurement.measurementId, offset, 500));
    }
    return files;
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
    for (const row of await this.changedFiles(measurement, beforeManifest, afterManifest)) {
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
    // Preflight the destination against the measured after-state.
    const described = new Map<string, ReadRecord>();
    const signal = AbortSignal.timeout(this.deps.preflightDeadlineMs(actions.length));
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
    const planned = new Set(runnable);
    const previewByPath = new Map(preview.map((file) => [file.pathId, file]));
    for (const action of actions) {
      if (planned.has(action)) continue;
      const entry = previewByPath.get(action.previewPathId ?? action.pathId);
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
    const { ledger } = this.deps;
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
    const captureDeadlineMs = this.deps.captureDeadlineMs(payload.actions.length);
    try {
      this.deps.beforeCheckpoint?.(payload.worktreeId);
      const checkpoint = await owner.capture({
        purpose: "restore-checkpoint",
        deadlineMs: captureDeadlineMs,
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
      }
      const ordered = [...groups.values()];
      for (let index = 0; index < ordered.length; index += RESTORE_WRITE_BATCH_GROUPS) {
        const outcomes = await this.applyBatch(
          owner,
          ordered.slice(index, index + RESTORE_WRITE_BATCH_GROUPS),
        );
        for (const [action, result] of outcomes) {
          if (result === "applied") completed.push(action.pathId);
          else failed.push(action.pathId);
        }
      }
      owner.invalidate(completed);
      await owner.capture({
        purpose: "restore-result",
        deadlineMs: captureDeadlineMs,
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

  /**
   * Writes one batch of groups and answers every action's outcome in plan
   * order. Both ends of each group are described before any write in the
   * batch, a group whose destination moved since the preview is skipped
   * whole, and the helper re-checks each file immediately before writing it.
   */
  private async applyBatch(
    owner: WorktreeChangeOwner,
    groups: readonly RestoreAction[][],
  ): Promise<Array<[RestoreAction, ConditionalWriteOutcome]>> {
    const { store } = this.deps;
    const outcomes = new Map<RestoreAction, ConditionalWriteOutcome>();
    const paths = groups.flatMap((group) => group.map((action) => action.pathId));
    // Check every endpoint at apply time before any mutation in this batch.
    const current = await owner.executor
      .describe(
        paths,
        {
          maxCandidates: paths.length,
          maxFileBytes: 16 * 1024 * 1024,
          maxCaptureBytes: 256 * 1024 * 1024,
          readers: 1,
          stableReadAttempts: 2,
        },
        new AbortController().signal,
      )
      .catch(() => [] as ReadRecord[]);
    const described = new Map(current.map((record) => [record.pathId, record]));
    let pending: ConditionalWriteItem[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      const items = pending;
      pending = [];
      pendingBytes = 0;
      if (items.length === 0) return;
      let results: ConditionalWriteOutcome[];
      try {
        owner.assertCurrent();
        results = await this.writeBatch(owner, items);
      } catch {
        results = items.map(() => "failed");
      }
      items.forEach((item, position) => outcomes.set(item.action, results[position] ?? "failed"));
    };
    for (const [groupIndex, group] of groups.entries()) {
      if (group.some((action) => !matchesAction(action, described.get(action.pathId)))) {
        for (const action of group) outcomes.set(action, "failed");
        continue;
      }
      // A write whose blob is gone fails, and so does the rest of its group.
      const items: ConditionalWriteItem[] = [];
      let bytes = 0;
      for (const action of group) {
        let content: Uint8Array | null = null;
        if (action.targetBlob) {
          content = await store.get(action.targetBlob).catch(() => null);
          if (!content) break;
        }
        items.push({ action, bytes: content, group: String(groupIndex) });
        bytes += content?.byteLength ?? 0;
      }
      for (const action of group.slice(items.length)) outcomes.set(action, "failed");
      if (items.length === 0) continue;
      if (pending.length > 0 && pendingBytes + bytes > RESTORE_WRITE_BATCH_BYTES) await flush();
      pending.push(...items);
      pendingBytes += bytes;
    }
    await flush();
    return groups.flat().map((action) => [action, outcomes.get(action) ?? "failed"]);
  }

  private writeBatch(
    owner: WorktreeChangeOwner,
    items: readonly ConditionalWriteItem[],
  ): Promise<ConditionalWriteOutcome[]> {
    const identity = owner.identity;
    return identity.runtimeKind === "container"
      ? containerConditionalWrites(identity.runtimeId, identity.canonicalRoot, items)
      : hostConditionalWrites(identity.canonicalRoot, items);
  }
}
