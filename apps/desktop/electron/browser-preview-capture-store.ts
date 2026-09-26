/**
 * Bounded pending-capture spool owned by Electron main.
 *
 * A capture lives here from the moment main validates it until the backend
 * acknowledges it (or the user discards it, or it expires). The renderer may
 * unmount at any point in between; the spool survives renderer teardown and
 * app restarts. Layout under the spool directory (0700):
 *
 *   <captureId>.json        metadata record (0600), the commit point
 *   <captureId>-<n>.png     current image revision (0600), optional
 *   expired-notices.json    bounded, content-free notices of expired captures
 *   masks.json              bounded mask geometry of acknowledged captures, so a
 *                           later result capture can reapply the same redactions
 *
 * Writes are atomic (temp file, fsync, rename). Replaced or discarded images
 * are overwritten with zeros before unlinking. Capacity is enforced per preview
 * tab, per process, and by aggregate decoded image bytes; at capacity a new
 * capture is rejected, never an older one evicted. Nothing here logs content.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BrowserPreviewCaptureAck,
  BrowserPreviewCaptureMask,
  BrowserPreviewCaptureMode,
  BrowserPreviewCapturePurpose,
  BrowserPreviewExpiredCaptureNotice,
  BrowserPreviewPendingCapture,
  BrowserPreviewPendingCaptureDescriptor,
  BrowserPreviewReplaceImageInput,
  BrowserPreviewResponsiveMember,
  BrowserPreviewResultCaptureMetadata,
} from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationId,
  isWebAnnotationRect,
  validateWebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations-validation";

export const BROWSER_PREVIEW_CAPTURE_DIRECTORY = "browser-preview-captures";
const CAPTURE_ID_PATTERN = /^capture-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_FILE = /^(capture-[0-9a-f-]{36})\.json$/;
const IMAGE_FILE = /^(capture-[0-9a-f-]{36})-(\d{1,6})\.png$/;
const PNG_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_RECORD_BYTES = 256 * 1024;
const NOTICES_FILE = "expired-notices.json";
const MASKS_FILE = "masks.json";
const MAX_SIDE_FILE_BYTES = 512 * 1024;
/** Expired-capture notices kept until dismissed; the oldest beyond this are dropped. */
export const MAX_EXPIRED_CAPTURE_NOTICES = 32;
/** Masks remembered per acknowledged capture (a cache: the oldest are dropped). */
export const MAX_REMEMBERED_MASK_SETS = 256;
/** Masks per capture: detectable sensitive fields plus manual redactions. */
export const MAX_CAPTURE_MASKS = 32 + WEB_ANNOTATION_LIMITS.redactionRegions;
const CAPTURE_MODES: readonly BrowserPreviewCaptureMode[] = ["element", "text", "region", "page"];

export function createBrowserPreviewCaptureId(): string {
  return `capture-${randomUUID()}`;
}

export function isBrowserPreviewCaptureId(value: unknown): value is string {
  return typeof value === "string" && CAPTURE_ID_PATTERN.test(value);
}

export class BrowserPreviewCaptureSpoolError extends Error {
  constructor(
    readonly code: "spool-full" | "too-large" | "invalid" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "BrowserPreviewCaptureSpoolError";
  }
}

export interface DecodedPng {
  bytes: Buffer;
  width: number;
  height: number;
}

/** Read PNG dimensions from the IHDR chunk; null for anything that is not a PNG. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Validate and decode a bounded PNG data URL (≤ 8 MiB, ≤ 2000 px per side). */
export function decodePngDataUrl(value: unknown): DecodedPng {
  const maxBase64 = Math.ceil(WEB_ANNOTATION_LIMITS.imageBytes / 3) * 4;
  if (
    typeof value !== "string" ||
    !value.startsWith(PNG_PREFIX) ||
    value.length > PNG_PREFIX.length + maxBase64
  ) {
    throw new BrowserPreviewCaptureSpoolError("invalid", "Expected a PNG image within 8 MiB");
  }
  const base64 = value.slice(PNG_PREFIX.length);
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new BrowserPreviewCaptureSpoolError("invalid", "Expected a base64 PNG image");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > WEB_ANNOTATION_LIMITS.imageBytes) {
    throw new BrowserPreviewCaptureSpoolError("too-large", "The image exceeds 8 MiB");
  }
  const size = pngDimensions(bytes);
  const max = WEB_ANNOTATION_LIMITS.imageMaxDimension;
  if (!size || size.width < 1 || size.height < 1 || size.width > max || size.height > max) {
    throw new BrowserPreviewCaptureSpoolError("invalid", "Expected a PNG image up to 2000 px");
  }
  return { bytes, ...size };
}

export interface BrowserPreviewCaptureStoreChange {
  captureId: string;
  tabId: string;
  reason: "created" | "replaced" | "receipt" | "acknowledged" | "discarded" | "expired";
  /** Present when `reason` is `expired`. */
  notice?: BrowserPreviewExpiredCaptureNotice;
}

export interface BrowserPreviewCaptureStoreLimits {
  perPreview: number;
  perProcess: number;
  imageBytes: number;
  ttlMs: number;
}

export interface BrowserPreviewCaptureStoreOptions {
  directory: string;
  now?: () => number;
  limits?: Partial<BrowserPreviewCaptureStoreLimits>;
  onChange?: (change: BrowserPreviewCaptureStoreChange) => void;
}

export interface BrowserPreviewCaptureCreateInput {
  captureId: string;
  tabId: string;
  environmentId: string;
  annotationId: string | null;
  mode: BrowserPreviewCaptureMode;
  capture: WebAnnotationCaptureInput;
  image: { png: Buffer; width: number; height: number; reduced: boolean } | null;
  /** Masks painted into `image`, in document CSS pixels. */
  masks?: BrowserPreviewCaptureMask[];
  purpose?: BrowserPreviewCapturePurpose;
  result?: BrowserPreviewResultCaptureMetadata;
  responsive?: BrowserPreviewResponsiveMember;
  /**
   * Pending capture this one replaces. It is discarded in the same serialized
   * step once the new record is committed, and excluded from the capacity check.
   */
  replaces?: string;
}

interface SpoolRecord {
  version: 1;
  sequence: number;
  descriptor: BrowserPreviewPendingCaptureDescriptor;
  capture: WebAnnotationCaptureInput;
  imageFile: string | null;
  imageRevision: number;
  masks?: BrowserPreviewCaptureMask[];
  result?: BrowserPreviewResultCaptureMetadata;
}

interface RememberedMasks {
  backendCaptureId: string;
  savedAt: string;
  masks: BrowserPreviewCaptureMask[];
}

export function isBrowserPreviewCaptureMask(value: unknown): value is BrowserPreviewCaptureMask {
  return (
    isRecord(value) &&
    (value.source === "sensitive-field" || value.source === "manual") &&
    isWebAnnotationRect(value.rect)
  );
}

function isMaskList(value: unknown): value is BrowserPreviewCaptureMask[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CAPTURE_MASKS &&
    value.every(isBrowserPreviewCaptureMask)
  );
}

function isResultMetadata(value: unknown): value is BrowserPreviewResultCaptureMetadata {
  if (!isRecord(value)) return false;
  const scroll = value.scroll;
  return (
    typeof value.zoomFactor === "number" &&
    Number.isFinite(value.zoomFactor) &&
    typeof value.deviceScaleFactor === "number" &&
    Number.isFinite(value.deviceScaleFactor) &&
    isRecord(scroll) &&
    Number.isFinite(scroll.x) &&
    Number.isFinite(scroll.y) &&
    (value.stability === "stable" || value.stability === "unstable") &&
    isMaskList(value.masks)
  );
}

function isNotice(value: unknown): value is BrowserPreviewExpiredCaptureNotice {
  return (
    isRecord(value) &&
    isBrowserPreviewCaptureId(value.captureId) &&
    boundedString(value.tabId, 256) &&
    boundedString(value.environmentId, 256) &&
    (value.annotationId === null || isWebAnnotationId(value.annotationId)) &&
    CAPTURE_MODES.includes(value.mode as BrowserPreviewCaptureMode) &&
    boundedString(value.displayUrl, 4_000) &&
    isIso(value.createdAt) &&
    isIso(value.expiredAt) &&
    typeof value.whileClosed === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isIso(value: unknown): value is string {
  return boundedString(value, 40) && Number.isFinite(Date.parse(value));
}

function isDescriptor(value: unknown): value is BrowserPreviewPendingCaptureDescriptor {
  if (!isRecord(value)) return false;
  const image = value.image;
  const imageOk =
    image === null ||
    (isRecord(image) &&
      Number.isSafeInteger(image.width) &&
      Number.isSafeInteger(image.height) &&
      Number.isSafeInteger(image.bytes) &&
      (image.bytes as number) >= 0 &&
      (image.bytes as number) <= WEB_ANNOTATION_LIMITS.imageBytes &&
      typeof image.reduced === "boolean");
  return (
    isBrowserPreviewCaptureId(value.captureId) &&
    boundedString(value.tabId, 256) &&
    value.tabId.length > 0 &&
    boundedString(value.environmentId, 256) &&
    value.environmentId.length > 0 &&
    (value.annotationId === null || isWebAnnotationId(value.annotationId)) &&
    CAPTURE_MODES.includes(value.mode as BrowserPreviewCaptureMode) &&
    isIso(value.createdAt) &&
    isIso(value.expiresAt) &&
    boundedString(value.targetLabel, WEB_ANNOTATION_LIMITS.titleChars) &&
    boundedString(value.pageTitle, 500) &&
    boundedString(value.displayUrl, 4_000) &&
    typeof value.stale === "boolean" &&
    (value.staleReason === null || boundedString(value.staleReason, 300)) &&
    imageOk &&
    typeof value.acknowledged === "boolean" &&
    (value.receipt === undefined ||
      value.receipt === null ||
      (isRecord(value.receipt) &&
        isWebAnnotationId(value.receipt.annotationId) &&
        isWebAnnotationId(value.receipt.backendCaptureId))) &&
    (value.recaptureOf === undefined ||
      value.recaptureOf === null ||
      isBrowserPreviewCaptureId(value.recaptureOf)) &&
    (value.purpose === undefined || value.purpose === "note" || value.purpose === "result") &&
    (value.responsive === undefined ||
      value.responsive === null ||
      (isRecord(value.responsive) &&
        boundedString(value.responsive.setId, 100) &&
        Number.isSafeInteger(value.responsive.index) &&
        Number.isSafeInteger(value.responsive.count) &&
        Number.isSafeInteger(value.responsive.viewportWidth)))
  );
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some platforms; rename is still atomic.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(file));
}

/** Overwrite with zeros before unlinking, so the unredacted bytes do not linger in the file. */
async function shredFile(file: string): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, "r+");
    const { size } = await handle.stat();
    const zeros = Buffer.alloc(Math.min(size, 1024 * 1024));
    for (let offset = 0; offset < size; offset += zeros.length) {
      await handle.write(zeros, 0, Math.min(zeros.length, size - offset), offset);
    }
    await handle.sync();
  } catch {
    // Best effort; the unlink below still removes the file.
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fs.rm(file, { force: true });
}

export class BrowserPreviewCaptureStore {
  readonly ready: Promise<void>;
  private readonly records = new Map<string, SpoolRecord>();
  private notices: BrowserPreviewExpiredCaptureNotice[] = [];
  private rememberedMasks: RememberedMasks[] = [];
  private readonly limits: BrowserPreviewCaptureStoreLimits;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: BrowserPreviewCaptureStoreOptions) {
    this.now = options.now ?? Date.now;
    this.limits = {
      perPreview: options.limits?.perPreview ?? WEB_ANNOTATION_LIMITS.pendingCapturesPerPreview,
      perProcess: options.limits?.perProcess ?? WEB_ANNOTATION_LIMITS.pendingCapturesPerProcess,
      imageBytes: options.limits?.imageBytes ?? WEB_ANNOTATION_LIMITS.pendingCaptureBytes,
      ttlMs: options.limits?.ttlMs ?? WEB_ANNOTATION_LIMITS.pendingCaptureTtlMs,
    };
    this.ready = this.exclusive(() => this.load());
    // A failed load leaves an empty spool; operations still work on new captures.
    this.ready.catch(() => undefined);
  }

  get directory(): string {
    return this.options.directory;
  }

  /** Serialize every mutation and read so files and the index never disagree. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async afterReady<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready.catch(() => undefined);
    return this.exclusive(operation);
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
  }

  private recordPath(captureId: string): string {
    return path.join(this.directory, `${captureId}.json`);
  }

  private async readSideFile(name: string): Promise<unknown> {
    try {
      const file = path.join(this.directory, name);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_SIDE_FILE_BYTES) return null;
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  private async writeNotices(): Promise<void> {
    await writeAtomic(
      path.join(this.directory, NOTICES_FILE),
      JSON.stringify({ version: 1, notices: this.notices }),
    );
  }

  private async writeRememberedMasks(): Promise<void> {
    await writeAtomic(
      path.join(this.directory, MASKS_FILE),
      JSON.stringify({ version: 1, entries: this.rememberedMasks }),
    );
  }

  private noticeFor(record: SpoolRecord, whileClosed: boolean): BrowserPreviewExpiredCaptureNotice {
    const descriptor = record.descriptor;
    return {
      captureId: descriptor.captureId,
      tabId: descriptor.tabId,
      environmentId: descriptor.environmentId,
      annotationId: descriptor.annotationId,
      mode: descriptor.mode,
      displayUrl: descriptor.displayUrl,
      createdAt: descriptor.createdAt,
      expiredAt: descriptor.expiresAt,
      whileClosed,
    };
  }

  /** Newest first and bounded; a notice for the same capture is replaced. */
  private addNotices(notices: BrowserPreviewExpiredCaptureNotice[]): void {
    if (notices.length === 0) return;
    const ids = new Set(notices.map((notice) => notice.captureId));
    this.notices = [...notices, ...this.notices.filter((notice) => !ids.has(notice.captureId))]
      .sort((left, right) => Date.parse(right.expiredAt) - Date.parse(left.expiredAt))
      .slice(0, MAX_EXPIRED_CAPTURE_NOTICES);
  }

  private async load(): Promise<void> {
    await this.ensureDirectory();
    const savedNotices = await this.readSideFile(NOTICES_FILE);
    if (isRecord(savedNotices) && Array.isArray(savedNotices.notices)) {
      this.notices = savedNotices.notices.filter(isNotice).slice(0, MAX_EXPIRED_CAPTURE_NOTICES);
    }
    const savedMasks = await this.readSideFile(MASKS_FILE);
    if (isRecord(savedMasks) && Array.isArray(savedMasks.entries)) {
      this.rememberedMasks = savedMasks.entries
        .filter(
          (entry): entry is RememberedMasks =>
            isRecord(entry) &&
            isWebAnnotationId(entry.backendCaptureId) &&
            isIso(entry.savedAt) &&
            isMaskList(entry.masks),
        )
        .slice(0, MAX_REMEMBERED_MASK_SETS);
    }
    const entries = await fs.readdir(this.directory);
    const referenced = new Set<string>();
    const expiredWhileClosed: SpoolRecord[] = [];
    for (const entry of entries) {
      const match = RECORD_FILE.exec(entry);
      if (!match) continue;
      const record = await this.readRecord(match[1]!);
      if (!record) {
        await fs.rm(path.join(this.directory, entry), { force: true }).catch(() => undefined);
        continue;
      }
      if (record.descriptor.acknowledged || Date.parse(record.descriptor.expiresAt) <= this.now()) {
        // An acknowledged record was committed by the backend; an expired one is past its promise.
        await this.removeFiles(record);
        if (!record.descriptor.acknowledged) expiredWhileClosed.push(record);
        continue;
      }
      this.records.set(record.descriptor.captureId, record);
      this.sequence = Math.max(this.sequence, record.sequence);
      if (record.imageFile) referenced.add(record.imageFile);
    }
    for (const entry of entries) {
      if (RECORD_FILE.test(entry) || referenced.has(entry)) continue;
      if (IMAGE_FILE.test(entry) || entry.endsWith(".tmp")) {
        const file = path.join(this.directory, entry);
        if (IMAGE_FILE.test(entry)) await shredFile(file).catch(() => undefined);
        else await fs.rm(file, { force: true }).catch(() => undefined);
      }
    }
    if (expiredWhileClosed.length > 0) {
      // The app was closed when these expired: keep notices the renderer can list.
      const notices = expiredWhileClosed.map((record) => this.noticeFor(record, true));
      this.addNotices(notices);
      await this.writeNotices().catch(() => undefined);
      for (const notice of notices) this.notify(notice.captureId, notice.tabId, "expired", notice);
    }
  }

  private async readRecord(captureId: string): Promise<SpoolRecord | null> {
    try {
      const file = this.recordPath(captureId);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !isRecord(parsed) ||
        parsed.version !== 1 ||
        !Number.isSafeInteger(parsed.sequence) ||
        !Number.isSafeInteger(parsed.imageRevision) ||
        !isDescriptor(parsed.descriptor) ||
        parsed.descriptor.captureId !== captureId ||
        !validateWebAnnotationCaptureInput(parsed.capture).ok ||
        (parsed.masks !== undefined && !isMaskList(parsed.masks)) ||
        (parsed.result !== undefined && !isResultMetadata(parsed.result))
      ) {
        return null;
      }
      const imageFile = parsed.imageFile;
      if (imageFile === null) {
        if (parsed.descriptor.image !== null) return null;
      } else {
        if (typeof imageFile !== "string") return null;
        const match = IMAGE_FILE.exec(imageFile);
        if (!match || match[1] !== captureId || !parsed.descriptor.image) return null;
        const bytes = await fs.readFile(path.join(this.directory, imageFile));
        const size = pngDimensions(bytes);
        if (
          bytes.length !== parsed.descriptor.image.bytes ||
          !size ||
          size.width !== parsed.descriptor.image.width ||
          size.height !== parsed.descriptor.image.height
        ) {
          return null;
        }
      }
      return parsed as unknown as SpoolRecord;
    } catch {
      return null;
    }
  }

  private async removeFiles(record: SpoolRecord): Promise<void> {
    if (record.imageFile) {
      await shredFile(path.join(this.directory, record.imageFile)).catch(() => undefined);
    }
    await fs.rm(this.recordPath(record.descriptor.captureId), { force: true });
    await syncDirectory(this.directory);
  }

  private async writeRecord(record: SpoolRecord): Promise<void> {
    await writeAtomic(this.recordPath(record.descriptor.captureId), JSON.stringify(record));
  }

  private imageBytesInUse(excluding?: string): number {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.descriptor.captureId === excluding) continue;
      total += record.descriptor.image?.bytes ?? 0;
    }
    return total;
  }

  private capacityError(
    tabId: string,
    imageBytes: number,
    options: { count?: number; excluding?: string } = {},
  ): BrowserPreviewCaptureSpoolError | null {
    const count = Math.max(1, options.count ?? 1);
    const all = Array.from(this.records.values()).filter(
      (record) => record.descriptor.captureId !== options.excluding,
    );
    if (all.length + count > this.limits.perProcess) {
      return new BrowserPreviewCaptureSpoolError(
        "spool-full",
        "Too many captures are waiting to be saved. Save or discard one first.",
      );
    }
    if (
      all.filter((record) => record.descriptor.tabId === tabId).length + count >
      this.limits.perPreview
    ) {
      return new BrowserPreviewCaptureSpoolError(
        "spool-full",
        "This preview has too many captures waiting to be saved. Save or discard one first.",
      );
    }
    if (this.imageBytesInUse(options.excluding) + imageBytes > this.limits.imageBytes) {
      return new BrowserPreviewCaptureSpoolError(
        "spool-full",
        "Pending capture images are using all available space. Save or discard one first.",
      );
    }
    return null;
  }

  /**
   * Fast pre-check before a selection starts; `create` checks again. `count`
   * reserves room for several records (a responsive set); `excluding` is a
   * pending record that the new capture will replace.
   */
  async hasCapacity(
    tabId: string,
    options: { count?: number; excluding?: string } = {},
  ): Promise<boolean> {
    return this.afterReady(async () => {
      await this.sweepLocked();
      return this.capacityError(tabId, 0, options) === null;
    });
  }

  async create(
    input: BrowserPreviewCaptureCreateInput,
  ): Promise<BrowserPreviewPendingCaptureDescriptor> {
    if (!isBrowserPreviewCaptureId(input.captureId)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture id");
    }
    const validation = validateWebAnnotationCaptureInput(input.capture);
    if (!validation.ok) throw new BrowserPreviewCaptureSpoolError("invalid", validation.error);
    if (input.masks !== undefined && !isMaskList(input.masks)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture masks");
    }
    if (input.result !== undefined && !isResultMetadata(input.result)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid result capture metadata");
    }
    if (input.replaces !== undefined && !isBrowserPreviewCaptureId(input.replaces)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid replaced capture id");
    }
    if (input.image) {
      const size = pngDimensions(input.image.png);
      if (
        !size ||
        size.width !== input.image.width ||
        size.height !== input.image.height ||
        input.image.png.length > WEB_ANNOTATION_LIMITS.imageBytes
      ) {
        throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture image");
      }
    }
    let replaced: { captureId: string; tabId: string } | null = null;
    const descriptor = await this.afterReady(async () => {
      await this.sweepLocked();
      if (this.records.has(input.captureId)) {
        throw new BrowserPreviewCaptureSpoolError("invalid", "Capture already spooled");
      }
      const replacing = input.replaces ? (this.records.get(input.replaces) ?? null) : null;
      const capacity = this.capacityError(
        input.tabId,
        input.image?.png.length ?? 0,
        replacing ? { excluding: replacing.descriptor.captureId } : {},
      );
      if (capacity) throw capacity;
      await this.ensureDirectory();
      const createdAt = this.now();
      const imageFile = input.image ? `${input.captureId}-1.png` : null;
      const record: SpoolRecord = {
        version: 1,
        sequence: ++this.sequence,
        imageFile,
        imageRevision: input.image ? 1 : 0,
        capture: input.capture,
        ...(input.masks && input.masks.length > 0 ? { masks: input.masks } : {}),
        ...(input.result ? { result: input.result } : {}),
        descriptor: {
          captureId: input.captureId,
          tabId: input.tabId,
          environmentId: input.environmentId,
          annotationId: input.annotationId,
          mode: input.mode,
          createdAt: new Date(createdAt).toISOString(),
          expiresAt: new Date(createdAt + this.limits.ttlMs).toISOString(),
          targetLabel: input.capture.target.label,
          pageTitle: input.capture.page.title,
          displayUrl: input.capture.page.displayUrl,
          stale: input.capture.stale !== undefined,
          staleReason: input.capture.stale?.reason ?? null,
          image: input.image
            ? {
                width: input.image.width,
                height: input.image.height,
                bytes: input.image.png.length,
                reduced: input.image.reduced,
              }
            : null,
          acknowledged: false,
          receipt: null,
          recaptureOf: replacing ? replacing.descriptor.captureId : null,
          purpose: input.purpose ?? "note",
          responsive: input.responsive ?? null,
        },
      };
      if (imageFile && input.image) {
        await writeAtomic(path.join(this.directory, imageFile), input.image.png);
      }
      try {
        await this.writeRecord(record);
      } catch (error) {
        if (imageFile) await shredFile(path.join(this.directory, imageFile)).catch(() => undefined);
        throw error;
      }
      this.records.set(input.captureId, record);
      if (replacing) {
        // The new capture is written; the pending one it replaces goes now.
        await this.removeFiles(replacing).catch(() => undefined);
        this.records.delete(replacing.descriptor.captureId);
        replaced = { captureId: replacing.descriptor.captureId, tabId: replacing.descriptor.tabId };
      }
      return { ...record.descriptor };
    });
    this.notify(descriptor.captureId, descriptor.tabId, "created");
    const old = replaced as { captureId: string; tabId: string } | null;
    if (old) this.notify(old.captureId, old.tabId, "discarded");
    return descriptor;
  }

  /** Newest first. Reading never consumes a record. */
  async list(): Promise<BrowserPreviewPendingCaptureDescriptor[]> {
    return this.afterReady(async () => {
      await this.sweepLocked();
      return Array.from(this.records.values())
        .sort((left, right) => right.sequence - left.sequence)
        .map((record) => ({ ...record.descriptor }));
    });
  }

  async read(captureId: string): Promise<BrowserPreviewPendingCapture | null> {
    if (!isBrowserPreviewCaptureId(captureId)) return null;
    return this.afterReady(async () => {
      await this.sweepLocked();
      const record = this.records.get(captureId);
      if (!record) return null;
      let imageDataUrl: string | null = null;
      if (record.imageFile) {
        const bytes = await fs.readFile(path.join(this.directory, record.imageFile));
        imageDataUrl = `${PNG_PREFIX}${bytes.toString("base64")}`;
      }
      return {
        descriptor: { ...record.descriptor },
        capture: structuredClone(record.capture),
        imageDataUrl,
        masks: structuredClone(record.masks ?? []),
        ...(record.result ? { result: structuredClone(record.result) } : {}),
      };
    });
  }

  /**
   * Replace the spooled image with the user's redacted version, or drop it.
   * The previous image file is overwritten and removed; it cannot be restored.
   */
  async replaceImage(
    captureId: string,
    input: BrowserPreviewReplaceImageInput,
  ): Promise<BrowserPreviewPendingCaptureDescriptor> {
    if (!isBrowserPreviewCaptureId(captureId)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture id");
    }
    const regions = input.regions;
    if (
      regions !== undefined &&
      (!Array.isArray(regions) ||
        regions.length > WEB_ANNOTATION_LIMITS.redactionRegions ||
        !regions.every(isWebAnnotationRect))
    ) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid redaction regions");
    }
    // The count is for THIS pass; the spool accumulates it across passes.
    const added = regions ? regions.length : input.manualRegions;
    if (
      !Number.isSafeInteger(added) ||
      added < 0 ||
      added > WEB_ANNOTATION_LIMITS.redactionRegions
    ) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid redaction region count");
    }
    const image = input.imageDataUrl === null ? null : decodePngDataUrl(input.imageDataUrl);
    const descriptor = await this.afterReady(async () => {
      await this.sweepLocked();
      const record = this.records.get(captureId);
      if (!record)
        throw new BrowserPreviewCaptureSpoolError("not-found", "The capture is no longer pending");
      const previousBytes = record.descriptor.image?.bytes ?? 0;
      if (
        image &&
        this.imageBytesInUse() - previousBytes + image.bytes.length > this.limits.imageBytes
      ) {
        throw new BrowserPreviewCaptureSpoolError(
          "spool-full",
          "Pending capture images are using all available space.",
        );
      }
      const capture = structuredClone(record.capture);
      const geometry = capture.geometry;
      // Manual masks in document CSS pixels, from the replaced image's transform.
      const sourceScale = geometry?.image?.scale ?? null;
      const manualMasks: BrowserPreviewCaptureMask[] =
        regions && geometry && sourceScale && sourceScale > 0
          ? regions.map((rect) => ({
              source: "manual" as const,
              rect: {
                x: rect.x / sourceScale + geometry.scroll.x,
                y: rect.y / sourceScale + geometry.scroll.y,
                width: rect.width / sourceScale,
                height: rect.height / sourceScale,
              },
            }))
          : [];
      if (image && geometry && geometry.viewport.width > 0) {
        const scale = image.width / geometry.viewport.width;
        const previousScale = geometry.image?.scale ?? scale;
        geometry.image = {
          width: image.width,
          height: image.height,
          scale,
          reduced: geometry.image?.reduced ?? false,
        };
        if (capture.target.kind === "region" && capture.target.imageRect) {
          const ratio = scale / previousScale;
          const rect = capture.target.imageRect;
          capture.target.imageRect = {
            x: Math.round(rect.x * ratio),
            y: Math.round(rect.y * ratio),
            width: Math.round(rect.width * ratio),
            height: Math.round(rect.height * ratio),
          };
        }
      } else if (!image) {
        if (geometry) geometry.image = null;
        if (capture.target.kind === "region") capture.target.imageRect = null;
      }
      capture.redaction = {
        ...capture.redaction,
        manualRegions: Math.min(
          WEB_ANNOTATION_LIMITS.redactionRegions,
          capture.redaction.manualRegions + added,
        ),
        imageExcluded: image === null,
      };
      const masks = [...(record.masks ?? []), ...manualMasks].slice(0, MAX_CAPTURE_MASKS);
      const validation = validateWebAnnotationCaptureInput(capture);
      if (!validation.ok) throw new BrowserPreviewCaptureSpoolError("invalid", validation.error);
      const imageRevision = image ? record.imageRevision + 1 : record.imageRevision;
      const imageFile = image ? `${captureId}-${imageRevision}.png` : null;
      if (image && imageFile) await writeAtomic(path.join(this.directory, imageFile), image.bytes);
      const next: SpoolRecord = {
        ...record,
        imageRevision,
        imageFile,
        capture,
        ...(masks.length > 0 ? { masks } : {}),
        descriptor: {
          ...record.descriptor,
          image: image
            ? {
                width: image.width,
                height: image.height,
                bytes: image.bytes.length,
                reduced: record.descriptor.image?.reduced ?? false,
              }
            : null,
        },
      };
      try {
        await this.writeRecord(next);
      } catch (error) {
        if (imageFile) await shredFile(path.join(this.directory, imageFile)).catch(() => undefined);
        throw error;
      }
      this.records.set(captureId, next);
      if (record.imageFile && record.imageFile !== imageFile) {
        await shredFile(path.join(this.directory, record.imageFile));
      }
      return { ...next.descriptor };
    });
    this.notify(captureId, descriptor.tabId, "replaced");
    return descriptor;
  }

  private validAck(ack: BrowserPreviewCaptureAck): void {
    if (
      !isBrowserPreviewCaptureId(ack.captureId) ||
      !isWebAnnotationId(ack.annotationId) ||
      !isWebAnnotationId(ack.backendCaptureId)
    ) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture acknowledgement");
    }
  }

  /**
   * Durably note the backend receipt without clearing the record, so a
   * renderer that resumes after a failed acknowledgement re-acks it instead of
   * committing again. Idempotent; null when the capture is no longer pending.
   */
  async recordReceipt(
    ack: BrowserPreviewCaptureAck,
  ): Promise<BrowserPreviewPendingCaptureDescriptor | null> {
    this.validAck(ack);
    const descriptor = await this.afterReady(async () => {
      const record = this.records.get(ack.captureId);
      if (!record) return null;
      const receipt = { annotationId: ack.annotationId, backendCaptureId: ack.backendCaptureId };
      const current = record.descriptor.receipt;
      if (
        current?.annotationId === receipt.annotationId &&
        current.backendCaptureId === receipt.backendCaptureId
      ) {
        return { ...record.descriptor };
      }
      const next: SpoolRecord = { ...record, descriptor: { ...record.descriptor, receipt } };
      await this.writeRecord(next);
      this.records.set(ack.captureId, next);
      return { ...next.descriptor };
    });
    if (descriptor) this.notify(descriptor.captureId, descriptor.tabId, "receipt");
    return descriptor;
  }

  /** Record the backend receipt, then clear. A duplicate or unknown ack is harmless. */
  async acknowledge(ack: BrowserPreviewCaptureAck): Promise<void> {
    this.validAck(ack);
    const tabId = await this.afterReady(async () => {
      const record = this.records.get(ack.captureId);
      if (!record) return null;
      const acknowledged: SpoolRecord = {
        ...record,
        descriptor: {
          ...record.descriptor,
          acknowledged: true,
          receipt: { annotationId: ack.annotationId, backendCaptureId: ack.backendCaptureId },
        },
      };
      this.records.set(ack.captureId, acknowledged);
      await this.writeRecord(acknowledged).catch(() => undefined);
      if (record.masks && record.masks.length > 0) {
        // Geometry only: a later result capture reapplies the same redactions.
        this.rememberedMasks = [
          {
            backendCaptureId: ack.backendCaptureId,
            savedAt: new Date(this.now()).toISOString(),
            masks: record.masks,
          },
          ...this.rememberedMasks.filter(
            (entry) => entry.backendCaptureId !== ack.backendCaptureId,
          ),
        ].slice(0, MAX_REMEMBERED_MASK_SETS);
        await this.writeRememberedMasks().catch(() => undefined);
      }
      await this.removeFiles(acknowledged);
      this.records.delete(ack.captureId);
      return record.descriptor.tabId;
    });
    if (tabId !== null) this.notify(ack.captureId, tabId, "acknowledged");
  }

  /** Masks remembered for an acknowledged backend capture, or null. */
  async masksFor(backendCaptureId: string): Promise<BrowserPreviewCaptureMask[] | null> {
    if (!isWebAnnotationId(backendCaptureId)) return null;
    return this.afterReady(async () => {
      const entry = this.rememberedMasks.find(
        (candidate) => candidate.backendCaptureId === backendCaptureId,
      );
      return entry ? structuredClone(entry.masks) : null;
    });
  }

  /** Expired-capture notices, newest first. */
  async listExpiredNotices(): Promise<BrowserPreviewExpiredCaptureNotice[]> {
    return this.afterReady(async () => {
      await this.sweepLocked();
      return this.notices.map((notice) => ({ ...notice }));
    });
  }

  /** Dismiss the given notices, or all of them. Unknown ids are ignored. */
  async dismissExpiredNotices(captureIds?: readonly string[]): Promise<void> {
    if (captureIds !== undefined && !captureIds.every(isBrowserPreviewCaptureId)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture id");
    }
    await this.afterReady(async () => {
      const dismissed = captureIds ? new Set(captureIds) : null;
      const next = dismissed
        ? this.notices.filter((notice) => !dismissed.has(notice.captureId))
        : [];
      if (next.length === this.notices.length) return;
      this.notices = next;
      await this.writeNotices();
    });
  }

  async discard(captureId: string): Promise<void> {
    if (!isBrowserPreviewCaptureId(captureId)) {
      throw new BrowserPreviewCaptureSpoolError("invalid", "Invalid capture id");
    }
    const tabId = await this.afterReady(async () => {
      const record = this.records.get(captureId);
      if (!record) return null;
      await this.removeFiles(record);
      this.records.delete(captureId);
      return record.descriptor.tabId;
    });
    if (tabId !== null) this.notify(captureId, tabId, "discarded");
  }

  /** Remove expired records; each produces a content-free notice. */
  async sweepExpired(): Promise<number> {
    return this.afterReady(() => this.sweepLocked());
  }

  private async sweepLocked(): Promise<number> {
    const now = this.now();
    const expired = Array.from(this.records.values()).filter(
      (record) => Date.parse(record.descriptor.expiresAt) <= now,
    );
    const notices: BrowserPreviewExpiredCaptureNotice[] = [];
    for (const record of expired) {
      await this.removeFiles(record).catch(() => undefined);
      this.records.delete(record.descriptor.captureId);
      notices.push(this.noticeFor(record, false));
    }
    if (notices.length > 0) {
      this.addNotices(notices);
      await this.writeNotices().catch(() => undefined);
      for (const notice of notices) this.notify(notice.captureId, notice.tabId, "expired", notice);
    }
    return expired.length;
  }

  startExpirySweep(intervalMs = 60_000): () => void {
    this.stopExpirySweep();
    const timer = setInterval(() => {
      void this.sweepExpired().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    this.sweepTimer = timer;
    return () => this.stopExpirySweep();
  }

  stopExpirySweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private notify(
    captureId: string,
    tabId: string,
    reason: BrowserPreviewCaptureStoreChange["reason"],
    notice?: BrowserPreviewExpiredCaptureNotice,
  ): void {
    try {
      this.options.onChange?.({ captureId, tabId, reason, ...(notice ? { notice } : {}) });
    } catch {
      // A listener failure must not undo a durable spool change.
    }
  }
}
