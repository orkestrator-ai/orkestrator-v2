import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  AGENT_MAIL_DEFAULT_RETENTION_DAYS,
  AGENT_MAIL_MAX_ATTACHMENT_BYTES,
  AGENT_MAIL_MAX_ATTACHMENTS,
  AGENT_MAIL_MAX_TOTAL_ATTACHMENT_BYTES,
  isAgentMailAttachmentName,
} from "@orkestrator/protocol/agent-mail";

import { detectedMimeTypeForImageData } from "./prompt-attachments.js";

/**
 * The files behind a coordinator's mailed images
 * (docs/architecture/coordinator.md, "Attachments"): which of a conversation's
 * own attachments may leave it, and the private spool a batch waits in on each
 * machine between being read and being placed for its recipient.
 *
 * A coordinator only ever names an attachment. Everything here runs in the
 * backend, so its read-only boundary is untouched, and a name is never trusted
 * further than this conversation's own directory.
 */

const MEBIBYTE = 1024 * 1024;
const ATTACHMENT_LIMIT_MIB = AGENT_MAIL_MAX_ATTACHMENT_BYTES / MEBIBYTE;
const TOTAL_LIMIT_MIB = AGENT_MAIL_MAX_TOTAL_ATTACHMENT_BYTES / MEBIBYTE;
const SUPPORTED_IMAGES = "PNG, JPEG, GIF and WebP";
const SPOOL_DIRECTORY = "mail-attachment-spool";
const BATCH = /^(?:outbox-)?[0-9a-f]{32}$/;
/** A batch still in the outbox is kept until the command node acknowledges its mail. */
const OUTBOX_PREFIX = "outbox-";
const STALE_SPOOL_MS = 24 * 60 * 60 * 1_000;
/** Images for a project home: kept outside the user's checkout, in the data directory. */
const PROJECT_HOME_DIRECTORY = "project-home-mail-attachments";
const ENVIRONMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Bytes read to recognise an image: enough for the longest signature, in whole base64 groups. */
const SIGNATURE_BYTES = 18;

/** What every machine a batch passes through knows about one image. */
export interface MailAttachmentFile {
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export type OwnAttachment = MailAttachmentFile & { data: Buffer };

export interface MailAttachmentBatch {
  batch: string;
  files: MailAttachmentFile[];
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The media type a file's bytes prove, or undefined for anything but a supported image. */
function imageMediaType(data: Buffer): string | undefined {
  return detectedMimeTypeForImageData(data.subarray(0, SIGNATURE_BYTES).toString("base64"));
}

function notOwnAttachment(reference: string, available: readonly string[] = []): Error {
  const known = available.slice(0, AGENT_MAIL_MAX_ATTACHMENTS * 2);
  return new Error(
    `${reference} is not one of this conversation's attachments. Name the path you were given with the image${
      known.length ? `; this conversation has: ${known.join(", ")}` : ""
    }. Nothing was sent.`,
  );
}

/**
 * The file name a reference means inside `directory`, or an error: a bare name
 * or an absolute path directly in that directory, and nothing else.
 */
async function ownAttachmentName(directory: string, reference: string): Promise<string> {
  const value = reference.trim();
  if (!/[\\/]/.test(value)) {
    if (!isAgentMailAttachmentName(value)) throw notOwnAttachment(reference);
    return value;
  }
  // Checked on the text too: `own/../own/x.png` resolves back inside, but no
  // path this conversation was given is written that way.
  if (!path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw notOwnAttachment(reference);
  }
  const parent = path.dirname(path.resolve(value));
  const canonical = await fs.realpath(directory).catch(() => directory);
  if (parent !== path.resolve(directory) && parent !== canonical) throw notOwnAttachment(reference);
  const name = path.basename(value);
  if (!isAgentMailAttachmentName(name)) throw notOwnAttachment(reference);
  return name;
}

/**
 * Read a conversation's own attachments, for sending.
 *
 * Refuses, with a reason the coordinator can act on, anything outside that one
 * directory, anything but a regular file (a symlink is not followed), anything
 * whose bytes are not a supported image, and anything over the caps. It reads
 * through one descriptor, so what was checked is what is sent.
 */
export async function readOwnAttachments(
  directory: string,
  references: readonly string[],
): Promise<OwnAttachment[]> {
  if (references.length > AGENT_MAIL_MAX_ATTACHMENTS) {
    throw new Error(
      `A message can carry at most ${AGENT_MAIL_MAX_ATTACHMENTS} images; ${references.length} were named. Nothing was sent.`,
    );
  }
  const root = await fs.lstat(directory).catch(() => null);
  if (root && (root.isSymbolicLink() || !root.isDirectory())) {
    throw new Error("This conversation's attachment directory is not usable. Nothing was sent.");
  }
  const available = root
    ? (await fs.readdir(directory).catch(() => [] as string[])).filter(isAgentMailAttachmentName)
    : [];
  const files = new Map<string, OwnAttachment>();
  let total = 0;
  for (const reference of references) {
    const name = await ownAttachmentName(directory, reference);
    if (files.has(name)) continue;
    const file = path.join(directory, name);
    const stats = await fs.lstat(file).catch(() => null);
    if (!stats) throw notOwnAttachment(reference, available);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${name} is not a regular file, so it cannot be sent. Nothing was sent.`);
    }
    if (stats.size > AGENT_MAIL_MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `${name} is larger than the ${ATTACHMENT_LIMIT_MIB} MiB limit for an image. Nothing was sent.`,
      );
    }
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > AGENT_MAIL_MAX_ATTACHMENT_BYTES) {
        throw new Error(`${name} changed while it was being read. Nothing was sent.`);
      }
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (data.byteLength > AGENT_MAIL_MAX_ATTACHMENT_BYTES) {
      throw new Error(`${name} changed while it was being read. Nothing was sent.`);
    }
    const mediaType = imageMediaType(data);
    if (!mediaType) {
      throw new Error(
        `${name} is not an image. Only ${SUPPORTED_IMAGES} images can be sent. Nothing was sent.`,
      );
    }
    total += data.byteLength;
    if (total > AGENT_MAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `Those images are larger than the ${TOTAL_LIMIT_MIB} MiB limit for one message. Nothing was sent.`,
      );
    }
    files.set(name, { name, mediaType, bytes: data.byteLength, sha256: sha256(data), data });
  }
  return [...files.values()];
}

/** A batch's files without their bytes: what crosses to another node as arguments. */
export function mailAttachmentFiles(files: readonly MailAttachmentFile[]): MailAttachmentFile[] {
  return files.map(({ name, mediaType, bytes, sha256: hash }) => ({
    name,
    mediaType,
    bytes,
    sha256: hash,
  }));
}

/** A batch description from another node, checked as untrusted input. */
export function parseMailAttachmentBatch(value: unknown): MailAttachmentBatch {
  const record = value as { batch?: unknown; files?: unknown } | null;
  if (typeof record?.batch !== "string" || !BATCH.test(record.batch)) {
    throw new Error("Expected a mail attachment batch.");
  }
  if (
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > AGENT_MAIL_MAX_ATTACHMENTS
  ) {
    throw new Error(`A message can carry at most ${AGENT_MAIL_MAX_ATTACHMENTS} images.`);
  }
  let total = 0;
  const files = record.files.map((entry): MailAttachmentFile => {
    const file = entry as Partial<MailAttachmentFile> | null;
    if (
      !isAgentMailAttachmentName(file?.name) ||
      typeof file.mediaType !== "string" ||
      !file.mediaType.startsWith("image/") ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > AGENT_MAIL_MAX_ATTACHMENT_BYTES ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error("Expected a mail attachment batch.");
    }
    total += file.bytes;
    return {
      name: file.name,
      mediaType: file.mediaType,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  });
  if (total > AGENT_MAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Those images are larger than the ${TOTAL_LIMIT_MIB} MiB limit.`);
  }
  return { batch: record.batch, files };
}

/** One message's batch: the same for a retry of it, whichever attempt got furthest. */
export function mailAttachmentBatchId(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 32);
}

/** Where an outgoing batch waits in a leaf's spool until the command node has its mail. */
export function outboxMailAttachmentBatch(batch: string): string {
  return `${OUTBOX_PREFIX}${batch}`;
}

function spoolRoot(dataDir: string): string {
  return path.join(dataDir, SPOOL_DIRECTORY);
}

export function mailAttachmentSpoolDir(dataDir: string, batch: string): string {
  if (!BATCH.test(batch)) throw new Error("Invalid mail attachment batch.");
  return path.join(spoolRoot(dataDir), batch);
}

/** Write a batch's files into the spool, replacing what an earlier attempt left. */
export async function stageMailAttachments(
  dataDir: string,
  batch: string,
  files: readonly OwnAttachment[],
): Promise<void> {
  const directory = mailAttachmentSpoolDir(dataDir, batch);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const temp = path.join(directory, `.${randomUUID()}.tmp`);
    await fs.writeFile(temp, file.data, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, path.join(directory, file.name));
  }
}

/** One spooled file, verified against what its sender declared. */
export async function readSpooledAttachment(
  dataDir: string,
  batch: string,
  file: MailAttachmentFile,
): Promise<Buffer> {
  const target = path.join(mailAttachmentSpoolDir(dataDir, batch), file.name);
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const data = await handle.readFile().finally(() => handle.close());
  if (data.byteLength !== file.bytes || sha256(data) !== file.sha256) {
    throw new Error(`${file.name} did not match its size or hash when it arrived.`);
  }
  // The receiving side checks for itself: images only, whoever sent the batch.
  if (!imageMediaType(data)) {
    throw new Error(`${file.name} is not an image. Only ${SUPPORTED_IMAGES} images can be sent.`);
  }
  return data;
}

export async function removeMailAttachmentBatch(dataDir: string, batch: string): Promise<void> {
  await fs.rm(mailAttachmentSpoolDir(dataDir, batch), { recursive: true, force: true });
}

/**
 * Batches left by a process that stopped between staging and placing. A batch
 * in the outbox is not one of them: it is the only copy until it is collected.
 */
export async function sweepStaleMailAttachmentBatches(
  dataDir: string,
  now = Date.now(),
  isActive: (batch: string) => boolean = () => false,
): Promise<void> {
  const entries = await fs.readdir(spoolRoot(dataDir)).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => BATCH.test(entry) && !entry.startsWith(OUTBOX_PREFIX))
      .map(async (entry) => {
        const directory = path.join(spoolRoot(dataDir), entry);
        const stats = await fs.lstat(directory).catch(() => null);
        if (stats && now - stats.mtimeMs > STALE_SPOOL_MS && !isActive(entry)) {
          await fs.rm(directory, { recursive: true, force: true });
        }
      }),
  );
}

function projectHomeRoot(dataDir: string): string {
  return path.join(dataDir, PROJECT_HOME_DIRECTORY);
}

/**
 * Where a project home reads the images mailed to it. The project home is the
 * user's own checkout, which Orkestrator never cleans, so its images live here
 * instead: outside every repository, and removed with the project home.
 */
export function projectHomeMailAttachmentDir(
  dataDir: string,
  environmentId: string,
  batch?: string,
): string {
  if (!ENVIRONMENT_ID.test(environmentId)) throw new Error("Invalid environment id.");
  const directory = path.join(projectHomeRoot(dataDir), environmentId);
  if (batch === undefined) return directory;
  if (!BATCH.test(batch) || batch.startsWith(OUTBOX_PREFIX)) {
    throw new Error("Invalid mail attachment batch.");
  }
  return path.join(directory, batch);
}

/** Everything mailed to one project home, when that environment is deleted. */
export async function removeProjectHomeMailAttachments(
  dataDir: string,
  environmentId: string,
): Promise<void> {
  if (!ENVIRONMENT_ID.test(environmentId)) return;
  await fs.rm(projectHomeMailAttachmentDir(dataDir, environmentId), {
    recursive: true,
    force: true,
  });
}

/**
 * A project home's images whose environment is gone (a deletion that stopped
 * part-way, a removed project), and batches older than mail retention.
 */
export async function sweepProjectHomeMailAttachments(
  dataDir: string,
  isLiveProjectHome: (environmentId: string) => Promise<boolean>,
  now = Date.now(),
  retentionDays = AGENT_MAIL_DEFAULT_RETENTION_DAYS,
): Promise<void> {
  const retentionMs = retentionDays * 24 * 60 * 60 * 1_000;
  const root = projectHomeRoot(dataDir);
  const homes = await fs.readdir(root).catch(() => [] as string[]);
  for (const home of homes) {
    const directory = path.join(root, home);
    if (!ENVIRONMENT_ID.test(home) || !(await isLiveProjectHome(home))) {
      await fs.rm(directory, { recursive: true, force: true });
      continue;
    }
    const batches = await fs.readdir(directory).catch(() => [] as string[]);
    await Promise.all(
      batches.map(async (batch) => {
        const target = path.join(directory, batch);
        const stats = await fs.lstat(target).catch(() => null);
        if (stats && now - stats.mtimeMs > retentionMs) {
          await fs.rm(target, { recursive: true, force: true });
        }
      }),
    );
  }
}
