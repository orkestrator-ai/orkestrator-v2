import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DESIGN_MAX_DOCUMENT_BYTES,
  DESIGN_RUNTIME_VERSION,
  type DesignCanvas,
  type DesignFrame,
} from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  type DesignActor,
  type DesignChangeDescriptor,
  type DesignExportAssociation,
  type DesignFrameMeta,
  type DesignFrameValidation,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
  type DesignPendingExport,
  type DesignSessionLink,
} from "@orkestrator/protocol/design-operations";
import { DesignError } from "./design-errors.js";
import { canvasSchema, designId } from "./design-schemas.js";

export const RECORD_KIND = "orkestrator-design-record";
export const RECORD_VERSION = 1;
export const RECORD_EXTENSION = ".orkrec";
export const LEGACY_EXTENSION = ".orkdes";

/**
 * Admitted-but-uncommitted work lives in a small per-canvas pending file so
 * preparing an edit never rewrites the whole record. The record's receipts
 * stay authoritative: a token with a receipt is settled whatever this file says.
 */
export interface DesignPendingOperation {
  token: string;
  digest: string;
  descriptor: DesignOperationDescriptor;
  actor: DesignActor;
  environmentId: string;
  canvasId: string;
  incarnation: string;
  preparedAt: string;
  expiresAt: string;
  bytes: number;
  state: "prepared" | "executing";
}

export interface DesignHistoryEntryRecord {
  id: string;
  kind: string;
  label: string;
  actor: DesignActor;
  createdAt: string;
  canvasRevisionBefore: number;
  canvasRevisionAfter: number;
  frames: Array<{ frameId: string; name: string; before?: number; after?: number }>;
  /** Canvas name before/after for canvas-level entries. */
  canvasName?: { before: string; after: string };
  checkpoint: string;
  bytes: number;
  undone: boolean;
  /** Set on entries created by undo/redo: the entry they reverse or replay. */
  undoOf?: string;
  redoOf?: string;
  gestureId?: string;
  protected: boolean;
  scope: "frame" | "canvas";
}

export interface DesignHistoryManifest {
  entries: DesignHistoryEntryRecord[];
  bytes: number;
}

export interface DesignPrivateRecord {
  kind: typeof RECORD_KIND;
  recordVersion: typeof RECORD_VERSION;
  canvasId: string;
  environmentId: string;
  state: "live" | "deleted" | "provisional";
  sequence: number;
  statusVersion: number;
  incarnation: string;
  identityCounter: number;
  createdAt: string;
  modifiedAt: string;
  document: DesignCanvas;
  frames: Record<string, DesignFrameMeta>;
  changes: DesignChangeDescriptor[];
  receipts: DesignOperationStatus[];
  history: DesignHistoryManifest;
  export?: DesignExportAssociation;
  pendingExport?: DesignPendingExport;
  sessions: DesignSessionLink[];
  deleted?: { deletedAt: string; revision: number; token?: string };
  provisional?: { expiresAt: string; token: string };
  migratedFromLegacy?: boolean;
}

const isoDate = z.string().min(10).max(40);
const recordHeaderSchema = z.object({
  kind: z.literal(RECORD_KIND),
  recordVersion: z.number().int().positive(),
});
const recordSchema = z
  .object({
    kind: z.literal(RECORD_KIND),
    recordVersion: z.literal(RECORD_VERSION),
    canvasId: designId,
    environmentId: z.string().min(1).max(256),
    state: z.enum(["live", "deleted", "provisional"]),
    sequence: z.number().int().nonnegative(),
    statusVersion: z.number().int().nonnegative(),
    incarnation: z.string().min(1).max(64),
    identityCounter: z.number().int().nonnegative(),
    createdAt: isoDate,
    modifiedAt: isoDate,
    document: z.unknown(),
    frames: z.record(z.string(), z.unknown()),
    changes: z.array(z.unknown()).max(DESIGN_LIMITS.changeDescriptors),
    receipts: z.array(z.unknown()).max(DESIGN_LIMITS.receiptsPerCanvas),
    history: z.object({ entries: z.array(z.unknown()).max(512), bytes: z.number().nonnegative() }),
    export: z.unknown().optional(),
    pendingExport: z.unknown().optional(),
    sessions: z.array(z.unknown()).max(DESIGN_LIMITS.sessionLinksPerCanvas),
    deleted: z.unknown().optional(),
    provisional: z.unknown().optional(),
    migratedFromLegacy: z.boolean().optional(),
  })
  .passthrough();

export type DesignRecordRead =
  | { kind: "record"; record: DesignPrivateRecord; bytes: number }
  | { kind: "legacy"; canvas: DesignCanvas; bytes: number; mtime: Date }
  | { kind: "missing" }
  | {
      kind: "problem";
      problem: "corrupt" | "unsupported-version";
      message: string;
      backupAvailable: boolean;
    };

export interface DesignStorageFaults {
  beforeSync?: (file: string) => Promise<void> | void;
  beforeRename?: (file: string) => Promise<void> | void;
  afterRename?: (file: string) => Promise<void> | void;
}

/** Bounded, owner-only atomic replacement: temp, sync, rename, sync parent. */
export async function writeAtomically(
  target: string,
  bytes: Uint8Array,
  faults?: DesignStorageFaults,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await faults?.beforeSync?.(target);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await faults?.beforeRename?.(target);
    await rename(temp, target);
    published = true;
    await syncDirectory(dirname(target));
    await faults?.afterRename?.(target);
  } finally {
    if (!published) await unlink(temp).catch(() => undefined);
  }
}

/** Directory sync makes the rename durable where the platform supports it. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Unsupported on some platforms/filesystems (e.g. Windows, some network
    // mounts). Rename atomicity still holds; crash durability is best effort.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (info.size > limit) throw new DesignError("storage", "Design record exceeds its size limit");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size)
      throw new DesignError("storage", "Design record changed during read");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function frameIdentity(record: Pick<DesignPrivateRecord, "incarnation">, counter: number) {
  return `${record.incarnation.slice(0, 8)}.${counter.toString(36)}`;
}

export function unvalidated(frameId: string, contentId: string): DesignFrameValidation {
  return {
    frameId,
    contentId,
    runtimeVersion: DESIGN_RUNTIME_VERSION,
    state: "unvalidated",
    reasons: [],
    truncated: false,
  };
}

/** Allocates a fresh opaque identity from the record's monotonic counter. */
export function nextIdentity(record: DesignPrivateRecord): string {
  record.identityCounter++;
  return frameIdentity(record, record.identityCounter);
}

export function freshFrameMeta(record: DesignPrivateRecord, frame: DesignFrame, now: string) {
  const contentId = nextIdentity(record);
  const meta: DesignFrameMeta = {
    contentId,
    structureId: nextIdentity(record),
    viewportId: nextIdentity(record),
    validation: unvalidated(frame.id, contentId),
    modifiedAt: now,
  };
  return meta;
}

/** Deterministic metadata for a legacy snapshot; repeating it yields the same record. */
export function migrateLegacy(canvas: DesignCanvas, mtime: Date): DesignPrivateRecord {
  const incarnation = `m${createHash("sha256").update(canvas.id).digest("hex").slice(0, 15)}`;
  const at = mtime.toISOString();
  const record: DesignPrivateRecord = {
    kind: RECORD_KIND,
    recordVersion: RECORD_VERSION,
    canvasId: canvas.id,
    environmentId: canvas.environmentId,
    state: "live",
    sequence: 0,
    statusVersion: 0,
    incarnation,
    identityCounter: 0,
    createdAt: at,
    modifiedAt: at,
    document: canvas,
    frames: {},
    changes: [],
    receipts: [],
    history: { entries: [], bytes: 0 },
    sessions: [],
    migratedFromLegacy: true,
  };
  for (const frame of canvas.frames) record.frames[frame.id] = freshFrameMeta(record, frame, at);
  return record;
}

export function newRecord(
  canvasId: string,
  environmentId: string,
  now: string,
  state: DesignPrivateRecord["state"],
): DesignPrivateRecord {
  return {
    kind: RECORD_KIND,
    recordVersion: RECORD_VERSION,
    canvasId,
    environmentId,
    state,
    sequence: 0,
    statusVersion: 0,
    incarnation: randomUUID().replaceAll("-", "").slice(0, 16),
    identityCounter: 0,
    createdAt: now,
    modifiedAt: now,
    document: {
      format: "orkdes",
      version: 1,
      id: canvasId,
      environmentId,
      name: "Untitled design",
      revision: 0,
      frames: [],
    },
    frames: {},
    changes: [],
    receipts: [],
    history: { entries: [], bytes: 0 },
    sessions: [],
  };
}

export function serializeRecord(record: DesignPrivateRecord): Buffer {
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.byteLength > DESIGN_LIMITS.privateRecordBytes)
    throw new DesignError(
      "capacity",
      "Design workspace record would exceed its 6 MiB limit; the previous state was kept",
      { retry: "never" },
    );
  return bytes;
}

/** Strict version-1 export bytes: no private metadata, pretty printed as before. */
export function portableBytes(canvas: DesignCanvas): Buffer {
  const portable = canvasSchema.parse({
    format: canvas.format,
    version: canvas.version,
    id: canvas.id,
    environmentId: canvas.environmentId,
    name: canvas.name,
    revision: canvas.revision,
    frames: canvas.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      html: frame.html,
      revision: frame.revision,
    })),
  });
  return Buffer.from(JSON.stringify(portable, null, 2));
}

export class DesignRecordStore {
  readonly root: string;
  constructor(
    dataDir: string,
    readonly faults?: DesignStorageFaults,
  ) {
    this.root = join(dataDir, "design-canvases");
  }
  recordFile(id: string) {
    return join(this.root, `${designId.parse(id)}${RECORD_EXTENSION}`);
  }
  legacyFile(id: string) {
    return join(this.root, `${designId.parse(id)}${LEGACY_EXTENSION}`);
  }
  legacyBackupFile(id: string) {
    return join(this.root, "legacy-backups", `${designId.parse(id)}${LEGACY_EXTENSION}`);
  }
  historyDir(id: string) {
    return join(this.root, "history", designId.parse(id));
  }
  exportBackupDir(id: string) {
    return join(this.root, "export-backups", designId.parse(id));
  }
  pendingFile(id: string) {
    return join(this.root, "pending", `${designId.parse(id)}.json`);
  }
  async ensure() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async ids(): Promise<string[]> {
    const ids = new Set<string>();
    for (const file of await readdir(this.root)) {
      const match = /^([0-9a-f-]{36})\.(orkrec|orkdes)$/.exec(file);
      if (match && designId.safeParse(match[1]).success) ids.add(match[1]!);
    }
    return Array.from(ids);
  }
  /** Canvases whose record exists while a legacy `.orkdes` also remains (interrupted migration). */
  async legacyAlongsideRecords(): Promise<string[]> {
    const files = new Set(await readdir(this.root));
    return Array.from(files)
      .map((file) => /^([0-9a-f-]{36})\.orkdes$/.exec(file)?.[1])
      .filter((id): id is string => Boolean(id) && files.has(`${id}${RECORD_EXTENSION}`));
  }
  async fileStat(id: string) {
    try {
      const info = await stat(this.recordFile(id));
      return { kind: "record" as const, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      try {
        const info = await stat(this.legacyFile(id));
        return { kind: "legacy" as const, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return undefined;
      }
    }
  }
  /** New private record first; a legacy document only when no record exists. */
  async read(id: string): Promise<DesignRecordRead> {
    let raw: Buffer | undefined;
    try {
      raw = await readBounded(this.recordFile(id), DESIGN_LIMITS.privateRecordBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          kind: "problem",
          problem: "corrupt",
          message: "The design workspace record could not be read",
          backupAvailable: await this.hasBackup(id),
        };
      }
    }
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return {
          kind: "problem",
          problem: "corrupt",
          message: "The design workspace record is corrupt",
          backupAvailable: await this.hasBackup(id),
        };
      }
      const header = recordHeaderSchema.safeParse(parsed);
      if (header.success && header.data.recordVersion > RECORD_VERSION)
        return {
          kind: "problem",
          problem: "unsupported-version",
          message: "This design was saved by a newer Orkestrator and is read-only here",
          backupAvailable: await this.hasBackup(id),
        };
      const record = recordSchema.safeParse(parsed);
      const document = record.success ? canvasSchema.safeParse(record.data.document) : undefined;
      if (!record.success || !document?.success || record.data.canvasId !== id)
        return {
          kind: "problem",
          problem: "corrupt",
          message: "The design workspace record is corrupt",
          backupAvailable: await this.hasBackup(id),
        };
      return {
        kind: "record",
        record: { ...(record.data as unknown as DesignPrivateRecord), document: document.data },
        bytes: raw.byteLength,
      };
    }
    try {
      const file = this.legacyFile(id);
      const bytes = await readBounded(file, DESIGN_MAX_DOCUMENT_BYTES);
      const canvas = canvasSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (canvas.id !== id) throw new Error("Canvas id does not match its filename");
      return { kind: "legacy", canvas, bytes: bytes.byteLength, mtime: (await stat(file)).mtime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return {
        kind: "problem",
        problem: "corrupt",
        message: "The legacy design document is corrupt",
        backupAvailable: false,
      };
    }
  }
  private async hasBackup(id: string) {
    for (const file of [this.legacyFile(id), this.legacyBackupFile(id)]) {
      try {
        await stat(file);
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }
  async write(record: DesignPrivateRecord): Promise<number> {
    const bytes = serializeRecord(record);
    await writeAtomically(this.recordFile(record.canvasId), bytes, this.faults);
    return bytes.byteLength;
  }
  /** Retire the legacy source only after the new record is committed and verified. */
  async retireLegacy(id: string): Promise<void> {
    const verified = await this.read(id);
    if (verified.kind !== "record") return;
    const backup = this.legacyBackupFile(id);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await rename(this.legacyFile(id), backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(this.root);
  }
  async remove(id: string): Promise<void> {
    for (const file of [this.recordFile(id), this.legacyFile(id), this.pendingFile(id)]) {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await syncDirectory(this.root);
  }
  async readPending(id: string): Promise<DesignPendingOperation[]> {
    try {
      const bytes = await readBounded(
        this.pendingFile(id),
        DESIGN_LIMITS.admittedPayloadBytes + 64 * 1024,
      );
      return z
        .array(
          z.object({ token: z.string(), state: z.enum(["prepared", "executing"]) }).passthrough(),
        )
        .max(DESIGN_LIMITS.preparedPerCanvas)
        .parse(JSON.parse(bytes.toString("utf8"))) as unknown as DesignPendingOperation[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      // Never read an unreadable file as empty: the next prepare would
      // overwrite it and silently lose admitted tokens.
      throw new DesignError("storage", "Pending design edits could not be read", {
        retry: "after-delay",
      });
    }
  }
  async writePending(id: string, entries: DesignPendingOperation[]): Promise<void> {
    if (!entries.length) {
      await unlink(this.pendingFile(id)).catch(() => undefined);
      return;
    }
    await writeAtomically(this.pendingFile(id), Buffer.from(JSON.stringify(entries)), this.faults);
  }
  async pendingIds(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, "pending")))
        .map((file) => /^([0-9a-f-]{36})\.json$/.exec(file)?.[1])
        .filter((value): value is string => Boolean(value));
    } catch {
      return [];
    }
  }
}

/** Keeps terminal receipts within the count and byte budget, oldest first. */
export function pruneReceipts(record: DesignPrivateRecord): void {
  const limitCount = DESIGN_LIMITS.receiptsPerCanvas;
  const limitBytes = DESIGN_LIMITS.receiptBytesPerCanvas;
  while (record.receipts.length > limitCount) record.receipts.shift();
  let bytes = Buffer.byteLength(JSON.stringify(record.receipts));
  while (bytes > limitBytes && record.receipts.length > 1) {
    const removed = record.receipts.shift()!;
    bytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
  }
}

export function pushChange(record: DesignPrivateRecord, change: DesignChangeDescriptor): void {
  record.changes.push(change);
  while (record.changes.length > DESIGN_LIMITS.changeDescriptors) record.changes.shift();
}

export function descriptorDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function cloneRecord(record: DesignPrivateRecord): DesignPrivateRecord {
  return structuredClone(record);
}
