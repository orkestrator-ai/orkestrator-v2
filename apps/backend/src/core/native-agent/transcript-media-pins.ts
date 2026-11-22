/**
 * Saved copies of the local images transcript messages showed
 * (`@orkestrator/protocol/transcript-media-pins`).
 *
 * A pin is one message's reference to one file: (environment, conversation,
 * message, reference). The first read of a pin saves the bytes; every later
 * read returns them and never touches the file, so an agent overwriting
 * `1-top.png` cannot change what an earlier message shows. Two messages that
 * name the same file have separate pins and keep their own versions.
 *
 * Layout under `<dataDir>/transcript-media-pins/<environment digest>/`:
 * - `blobs/<sha256>`: the bytes, content-addressed, so identical images are
 *   stored once per environment;
 * - `pins/<pin digest>.json`: `{ sha256, capturedAt, fileModifiedAt?, stored }`.
 *
 * Bounded per environment by bytes and by pin count. Over the byte bound a
 * pin is recorded without bytes and reads return the file as it is now
 * (`status: "live"`, `reason: "quota"`). Directory names are digests, so no
 * caller-supplied identifier becomes a path segment. Deleting the
 * environment deletes its directory; nothing else removes pins (closing a tab
 * never deletes a conversation).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TranscriptMediaLiveReason,
  TranscriptMediaSnapshot,
} from "@orkestrator/protocol/transcript-media-pins";

export const TRANSCRIPT_MEDIA_PINS_DIRECTORY = "transcript-media-pins";
/** Saved bytes per environment. */
export const TRANSCRIPT_MEDIA_PIN_ENVIRONMENT_MAX_BYTES = 512 * 1024 * 1024;
/** Pins (with or without bytes) per environment. */
export const TRANSCRIPT_MEDIA_PIN_ENVIRONMENT_MAX_PINS = 20_000;
/** Deleted environments remembered so a late pin cannot recreate their directory. */
const DELETED_ENVIRONMENTS_MAX = 4_096;

const SHA256 = /^[a-f0-9]{64}$/;

/** One message's reference to one file. `reference` is caller-normalized. */
export interface TranscriptMediaPinIdentity {
  environmentId: string;
  logicalSessionKey: string;
  messageId: string;
  reference: string;
}

/** Bytes read from the file now, by one of the backend's confined readers. */
export interface TranscriptMediaFileRead {
  bytes: Uint8Array;
  modifiedAt?: string;
}

export interface TranscriptMediaPinResult extends TranscriptMediaSnapshot {
  bytes: Uint8Array;
  sha256: string;
}

interface PinRecord {
  schemaVersion: 1;
  sha256: string;
  capturedAt: string;
  fileModifiedAt?: string;
  /** False when the bytes were not kept (`reason`). */
  stored: boolean;
  reason?: TranscriptMediaLiveReason;
}

interface EnvironmentUsage {
  bytes: number;
  pins: number;
  blobs: Set<string>;
}

export interface TranscriptMediaPinsOptions {
  maxEnvironmentBytes?: number;
  maxEnvironmentPins?: number;
  now?: () => number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseRecord(raw: string): PinRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<PinRecord>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.sha256 !== "string" ||
      !SHA256.test(value.sha256) ||
      typeof value.capturedAt !== "string" ||
      typeof value.stored !== "boolean"
    )
      return null;
    return {
      schemaVersion: 1,
      sha256: value.sha256,
      capturedAt: value.capturedAt,
      stored: value.stored,
      ...(typeof value.fileModifiedAt === "string" ? { fileModifiedAt: value.fileModifiedAt } : {}),
      ...(value.reason === "quota" ? { reason: value.reason } : {}),
    };
  } catch {
    return null;
  }
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write through a temporary sibling and rename, so a crash never leaves a partial file. */
async function writeAtomically(file: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class TranscriptMediaPins {
  private readonly usage = new Map<string, Promise<EnvironmentUsage>>();
  /** One pin is read or created at a time; concurrent requests share it. */
  private readonly inflight = new Map<string, Promise<TranscriptMediaPinResult>>();
  private readonly deleted = new Set<string>();
  /** Quota admission, blob writes and deletion share one queue per environment. */
  private readonly environmentOperations = new Map<string, Promise<void>>();
  private readonly maxEnvironmentBytes: number;
  private readonly maxEnvironmentPins: number;
  private readonly now: () => number;

  constructor(
    private readonly root: string,
    options: TranscriptMediaPinsOptions = {},
  ) {
    this.maxEnvironmentBytes =
      options.maxEnvironmentBytes ?? TRANSCRIPT_MEDIA_PIN_ENVIRONMENT_MAX_BYTES;
    this.maxEnvironmentPins =
      options.maxEnvironmentPins ?? TRANSCRIPT_MEDIA_PIN_ENVIRONMENT_MAX_PINS;
    this.now = options.now ?? Date.now;
  }

  /**
   * The pin's bytes, saving them from `read` on first use. `read` runs only
   * when the pin has no saved bytes; its errors propagate unchanged.
   */
  pin(
    identity: TranscriptMediaPinIdentity,
    read: () => Promise<TranscriptMediaFileRead>,
  ): Promise<TranscriptMediaPinResult> {
    const environment = this.environmentDirectory(identity.environmentId);
    const file = path.join(
      environment,
      "pins",
      `${digest(JSON.stringify([identity.logicalSessionKey, identity.messageId, identity.reference]))}.json`,
    );
    const existing = this.inflight.get(file);
    if (existing) return existing;
    const request = this.withEnvironment(environment, () =>
      this.resolvePin(environment, file, read),
    );
    this.inflight.set(file, request);
    const cleanup = () => {
      if (this.inflight.get(file) === request) this.inflight.delete(file);
    };
    void request.then(cleanup, cleanup);
    return request;
  }

  /** Remove every pin of an environment. Idempotent. */
  async deleteEnvironment(environmentId: string): Promise<void> {
    const environment = this.environmentDirectory(environmentId);
    this.deleted.add(environment);
    while (this.deleted.size > DELETED_ENVIRONMENTS_MAX) {
      const oldest = this.deleted.values().next();
      if (oldest.done) break;
      this.deleted.delete(oldest.value);
    }
    await this.withEnvironment(environment, async () => {
      this.usage.delete(environment);
      await rm(environment, { recursive: true, force: true });
    });
  }

  private withEnvironment<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.environmentOperations.get(environment) ?? Promise.resolve();
    const request = previous.then(operation);
    // A failed write must release the queue so deletion and later reads still run.
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    this.environmentOperations.set(environment, settled);
    void settled.then(() => {
      if (this.environmentOperations.get(environment) === settled) {
        this.environmentOperations.delete(environment);
      }
    });
    return request;
  }

  private environmentDirectory(environmentId: string): string {
    return path.join(this.root, digest(environmentId).slice(0, 32));
  }

  private async resolvePin(
    environment: string,
    file: string,
    read: () => Promise<TranscriptMediaFileRead>,
  ): Promise<TranscriptMediaPinResult> {
    if (this.deleted.has(environment)) return this.live(await read(), "missing");
    const raw = await readIfPresent(file);
    const record = raw ? parseRecord(raw.toString("utf8")) : null;
    if (record?.stored) {
      const bytes = await readIfPresent(path.join(environment, "blobs", record.sha256));
      if (bytes && sha256(bytes) === record.sha256) {
        return {
          status: "pinned",
          bytes: new Uint8Array(bytes),
          sha256: record.sha256,
          capturedAt: record.capturedAt,
          ...(record.fileModifiedAt ? { fileModifiedAt: record.fileModifiedAt } : {}),
        };
      }
      // The saved copy is gone or damaged. Never re-pin to whatever the file
      // holds now: that would silently rewrite history.
      return this.live(await read(), "missing");
    }
    if (record) return this.live(await read(), record.reason ?? "quota");
    // Existing but unreadable metadata is damaged history, not a new pin.
    if (raw !== null) return this.live(await read(), "missing");

    const current = await read();
    const hash = sha256(current.bytes);
    const capturedAt = new Date(this.now()).toISOString();
    if (this.deleted.has(environment)) return this.live(current, "missing", hash, capturedAt);
    const usage = await this.environmentUsage(environment);
    if (usage.pins >= this.maxEnvironmentPins) {
      // Not even a bytes-free record fits: answer live and keep nothing.
      return this.live(current, "quota", hash, capturedAt);
    }
    const isNewBlob = !usage.blobs.has(hash);
    const stored = !isNewBlob || usage.bytes + current.bytes.byteLength <= this.maxEnvironmentBytes;
    await mkdir(path.join(environment, "pins"), { recursive: true, mode: 0o700 });
    if (stored && isNewBlob) {
      await mkdir(path.join(environment, "blobs"), { recursive: true, mode: 0o700 });
      await writeAtomically(path.join(environment, "blobs", hash), current.bytes);
      usage.blobs.add(hash);
      usage.bytes += current.bytes.byteLength;
    }
    const next: PinRecord = {
      schemaVersion: 1,
      sha256: hash,
      capturedAt,
      stored,
      ...(current.modifiedAt ? { fileModifiedAt: current.modifiedAt } : {}),
      ...(stored ? {} : { reason: "quota" as const }),
    };
    await writeAtomically(file, JSON.stringify(next));
    usage.pins += 1;
    if (this.deleted.has(environment)) {
      // Deletion is queued behind this operation and removes all its writes.
      return this.live(current, "missing", hash, capturedAt);
    }
    return stored
      ? {
          status: "pinned",
          bytes: current.bytes,
          sha256: hash,
          capturedAt,
          ...(current.modifiedAt ? { fileModifiedAt: current.modifiedAt } : {}),
        }
      : this.live(current, "quota", hash, capturedAt);
  }

  private live(
    current: TranscriptMediaFileRead,
    reason: TranscriptMediaLiveReason,
    hash = sha256(current.bytes),
    capturedAt = new Date(this.now()).toISOString(),
  ): TranscriptMediaPinResult {
    return {
      status: "live",
      reason,
      bytes: current.bytes,
      sha256: hash,
      capturedAt,
      ...(current.modifiedAt ? { fileModifiedAt: current.modifiedAt } : {}),
    };
  }

  /** Saved bytes and pin count of one environment, scanned once per process. */
  private environmentUsage(environment: string): Promise<EnvironmentUsage> {
    let usage = this.usage.get(environment);
    if (!usage) {
      usage = this.scanUsage(environment);
      this.usage.set(environment, usage);
      usage.catch(() => {
        if (this.usage.get(environment) === usage) this.usage.delete(environment);
      });
    }
    return usage;
  }

  private async scanUsage(environment: string): Promise<EnvironmentUsage> {
    const list = (directory: string) =>
      readdir(path.join(environment, directory)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      });
    const [blobNames, pinNames] = await Promise.all([list("blobs"), list("pins")]);
    const blobs = new Set<string>();
    let bytes = 0;
    for (const name of blobNames) {
      if (!SHA256.test(name)) continue;
      const info = await stat(path.join(environment, "blobs", name)).catch(() => null);
      if (!info?.isFile()) continue;
      blobs.add(name);
      bytes += info.size;
    }
    return { bytes, pins: pinNames.filter((name) => name.endsWith(".json")).length, blobs };
  }
}

const shared = new Map<string, TranscriptMediaPins>();

/** The one pin store of a data directory, shared by every caller in the process. */
export function transcriptMediaPins(dataDir: string): TranscriptMediaPins {
  const root = path.join(dataDir, TRANSCRIPT_MEDIA_PINS_DIRECTORY);
  let pins = shared.get(root);
  if (!pins) {
    pins = new TranscriptMediaPins(root);
    shared.set(root, pins);
  }
  return pins;
}
