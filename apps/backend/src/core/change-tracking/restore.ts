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
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ChangesApplyRestoreResult,
  ChangesPrepareRestoreResult,
  RestorePreviewFile,
} from "@orkestrator/protocol/change-resources";
import { runCommandBuffer } from "../shell.js";
import { decodePath, displayPath, readManifest, type Manifest } from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";
import { objectId, type ObjectStore } from "./object-store.js";
import type { WorktreeRegistry, WorktreeChangeOwner } from "./worktree-owner.js";

interface RestoreAction {
  pathId: string;
  /** Blob the destination must currently hold; null = must be absent. */
  expectedOid: string | null;
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
  const relative = Buffer.from(decodePath(pathId)).toString();
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) return null;
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => part === ".." || part === "")) return null;
  return relative;
}

async function currentOid(file: string): Promise<string | null | "unsupported"> {
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink())
    return objectId("blob", new Uint8Array(await readlink(file, { encoding: "buffer" })));
  if (!info.isFile()) return "unsupported";
  return objectId("blob", new Uint8Array(await readFile(file)));
}

/** Host executor: check-and-write with a temporary sibling and rename. */
export async function hostConditionalWrite(
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  const relative = safeRelativePath(action.pathId);
  if (!relative) return "failed";
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return "failed";
  const file = path.join(realRoot, relative);
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent).catch(() => null);
  if (!realParent || (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)))
    return "failed";
  const current = await currentOid(file);
  if (current === "unsupported" || current !== action.expectedOid) return "precondition-failed";
  try {
    if (!bytes) {
      await rm(file, { force: true });
      return "applied";
    }
    const temp = path.join(parent, `.${path.basename(file)}.orkestrator-restore-${randomUUID()}`);
    await writeFile(temp, bytes, { mode: action.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    // Recheck immediately before the replacing rename.
    const again = await currentOid(file);
    if (again !== action.expectedOid) {
      await rm(temp, { force: true });
      return "precondition-failed";
    }
    await rename(temp, file);
    return "applied";
  } catch {
    return "failed";
  }
}

const CONTAINER_RESTORE_HELPER = String.raw`
const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.realpathSync(input.root);
const rel = Buffer.from(input.path, "base64").toString();
const out = (r) => process.stdout.write(JSON.stringify({ result: r }));
if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p === "")) { out("failed"); process.exit(0); }
const file = path.join(root, rel);
fs.mkdirSync(path.dirname(file), { recursive: true });
const parent = fs.realpathSync(path.dirname(file));
if (parent !== root && !parent.startsWith(root + path.sep)) { out("failed"); process.exit(0); }
const oid = () => { let s; try { s = fs.lstatSync(file); } catch { return null; }
  const b = s.isSymbolicLink() ? fs.readlinkSync(file, { encoding: "buffer" }) : s.isFile() ? fs.readFileSync(file) : null;
  if (!b) return "unsupported";
  return crypto.createHash("sha1").update("blob " + b.length + "\0").update(b).digest("hex"); };
if (oid() !== input.expected) { out("precondition-failed"); process.exit(0); }
try {
  if (input.content === null) { fs.rmSync(file, { force: true }); out("applied"); process.exit(0); }
  const temp = path.join(path.dirname(file), "." + path.basename(file) + ".orkestrator-restore-" + crypto.randomUUID());
  fs.writeFileSync(temp, Buffer.from(input.content, "base64"), { mode: input.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
  if (oid() !== input.expected) { fs.rmSync(temp, { force: true }); out("precondition-failed"); process.exit(0); }
  fs.renameSync(temp, file); out("applied");
} catch { out("failed"); }
`;

export async function containerConditionalWrite(
  containerId: string,
  root: string,
  action: RestoreAction,
  bytes: Uint8Array | null,
): Promise<ConditionalWriteOutcome> {
  try {
    const result = await runCommandBuffer(
      "docker",
      ["exec", "-i", containerId, "node", "-e", CONTAINER_RESTORE_HELPER],
      {
        stdin: JSON.stringify({
          root,
          path: Buffer.from(decodePath(action.pathId)).toString("base64"),
          expected: action.expectedOid,
          content: bytes ? Buffer.from(bytes).toString("base64") : null,
          mode: action.mode,
        }),
        timeoutMs: 60_000,
      },
    );
    const parsed = JSON.parse(result.stdout.toString("utf8")) as {
      result?: ConditionalWriteOutcome;
    };
    return parsed.result ?? "failed";
  } catch {
    return "failed";
  }
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
          actions.push({
            pathId: row.new_path,
            expectedOid: newEntry?.o ?? null,
            targetBlob: null,
            mode: null,
          });
          actions.push({
            pathId: row.old_path,
            expectedOid: null,
            targetBlob: oldEntry?.o ?? null,
            mode: oldEntry?.m ?? null,
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
    const signal = new AbortController().signal;
    const described = await owner.executor
      .describe(
        actions.map((action) => action.pathId),
        {
          maxCandidates: actions.length,
          maxFileBytes: 16 * 1024 * 1024,
          maxCaptureBytes: 256 * 1024 * 1024,
          readers: 4,
          stableReadAttempts: 2,
        },
        signal,
      )
      .catch(() => null);
    if (!described) return { kind: "disabled", reasonKey: "changes.restore.runtime-unavailable" };
    const currentByPath = new Map(
      described.map((record) => [
        record.pathId,
        record.kind === "file" || record.kind === "symlink"
          ? record.oid
          : record.kind === "missing"
            ? null
            : "unsupported",
      ]),
    );
    const runnable = actions.filter(
      (action) => currentByPath.get(action.pathId) === action.expectedOid,
    );
    for (const action of actions) {
      if (runnable.includes(action)) continue;
      const entry = preview.find(
        (file) =>
          file.pathId === action.pathId ||
          (file.action !== "skip" && action.pathId === file.pathId),
      );
      if (entry) {
        entry.action = "skip";
        entry.reasonKey = "changes.restore.destination-changed";
      }
    }
    if (runnable.length === 0)
      return { kind: "disabled", reasonKey: "changes.restore.nothing-applicable" };
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
    // Recovery checkpoint of the destination before any write.
    await owner.capture({
      purpose: "restore-checkpoint",
      deadlineMs: 10_000,
      boundaryKey: `restore-checkpoint:${operationId}`,
    });
    const completed: string[] = [];
    const failed: string[] = [];
    for (const action of payload.actions) {
      const bytes = action.targetBlob ? await store.get(action.targetBlob) : null;
      if (action.targetBlob && !bytes) {
        failed.push(action.pathId);
        continue;
      }
      const outcome = await this.write(owner, action, bytes);
      (outcome === "applied" ? completed : failed).push(action.pathId);
    }
    owner.invalidate(completed);
    const result = await owner.capture({
      purpose: "restore-result",
      deadlineMs: 10_000,
      boundaryKey: `restore-result:${operationId}`,
    });
    const outcome: ChangesApplyRestoreResult = {
      kind: "applied",
      operationId,
      outcome: failed.length === 0 ? "complete" : "partial",
      completedPathIds: completed,
      failedPathIds: failed,
      resultMeasurementId: null,
    };
    ledger.transaction(() =>
      ledger.finishRestoreOperation(operationId, outcome.outcome, JSON.stringify(outcome)),
    );
    void result;
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
