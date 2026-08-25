import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Prompt attachments for Pi.
 *
 * Pi takes images as `ImageContent` blocks carrying inline base64, so an
 * attached image reaches the model natively rather than depending on the agent
 * choosing to open a path named in the prompt text. There is no local-path
 * image block, which is why this reads the bytes itself.
 *
 * File attachments are handled the other way round, and deliberately: Pi has a
 * `read` tool and a repository it is already pointed at, so a file is attached
 * by naming its path in the prompt and letting the model read what it needs.
 * Inlining a whole file would spend the context window on bytes the model may
 * not want, and would bypass the truncation `read` applies for exactly that
 * reason. The path is still validated here, so a prompt can only ever name a
 * file inside the workspace.
 *
 * The image read is a trust boundary: the path arrives over HTTP, so it is
 * confined to the workspace, refused if any component is a symlink, bounded in
 * size, and re-checked after the read so a file swapped mid-read is rejected
 * rather than silently sent. This mirrors the Claude and ACP bridges' readers.
 */
export interface PiPromptAttachment {
  type: "image" | "file";
  path: string;
  filename?: string;
}

export interface PiPromptImage {
  /** Base64 of the file's bytes, ready for a Pi `image` content block. */
  data: string;
  mimeType: string;
  /** The path as requested, which callers may have given relative to the cwd. */
  path: string;
  /** Absolute path, so a transcript `file://` URL is always well formed. */
  absolutePath: string;
  filename?: string;
}

/** A file attachment, resolved to a path the prompt can safely name. */
export interface PiPromptFile {
  /** The path as requested. */
  path: string;
  /** Absolute path, both for the prompt text and for the transcript URL. */
  absolutePath: string;
  filename?: string;
}

export type PromptAttachmentErrorCode =
  | "attachment_changed"
  | "attachment_empty"
  | "attachment_invalid"
  | "attachment_not_regular_file"
  | "attachment_outside_workspace"
  | "attachment_read_failed"
  | "attachment_symlink_not_allowed"
  | "attachment_too_large"
  | "attachment_unsupported_format";

/** Terminal, caller-actionable rejection: the route answers it as a 400. */
export class PromptAttachmentError extends Error {
  override readonly name = "PromptAttachmentError";

  constructor(
    readonly code: PromptAttachmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Matches the per-image ceiling the renderer and both other bridges enforce. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Matches `MAX_PROMPT_ATTACHMENTS` in the backend's attachment staging. */
export const MAX_PROMPT_ATTACHMENTS = 20;
/** Matches `MAX_TOTAL_ATTACHMENT_BYTES` in the backend's attachment staging. */
export const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_PATH_BYTES = 4 * 1024;
const MAX_ATTACHMENT_FILENAME_BYTES = 1 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Validate the untrusted `attachments` array from a prompt request.
 *
 * Throws rather than filtering. A dropped attachment produces a turn whose
 * prompt text references an image the agent was never shown, which reads to the
 * user as the model ignoring the picture they attached.
 */
export function parsePromptAttachments(value: unknown): PiPromptAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PromptAttachmentError("attachment_invalid", "attachments must be an array");
  }
  if (value.length > MAX_PROMPT_ATTACHMENTS) {
    throw new PromptAttachmentError(
      "attachment_invalid",
      `A prompt can carry at most ${MAX_PROMPT_ATTACHMENTS} attachments`,
    );
  }
  return value.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new PromptAttachmentError("attachment_invalid", "Each attachment must be an object");
    }
    const record = candidate as Record<string, unknown>;
    if (record.type !== "image" && record.type !== "file") {
      throw new PromptAttachmentError(
        "attachment_invalid",
        "An attachment must be an image or a file",
      );
    }
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path || Buffer.byteLength(path) > MAX_ATTACHMENT_PATH_BYTES) {
      throw new PromptAttachmentError(
        "attachment_invalid",
        "Each attachment needs a workspace path",
      );
    }
    if (path.includes("\0")) {
      throw new PromptAttachmentError(
        "attachment_invalid",
        "An attachment path must not contain null bytes",
      );
    }
    const filename =
      typeof record.filename === "string" &&
      record.filename.trim() &&
      Buffer.byteLength(record.filename) <= MAX_ATTACHMENT_FILENAME_BYTES
        ? record.filename
        : undefined;
    return { type: record.type, path, ...(filename ? { filename } : {}) };
  });
}

/**
 * Read every attachment's bytes from the workspace.
 *
 * `dataUrl` is deliberately ignored even when a caller supplies it: every
 * attachment that reaches a bridge is already staged on disk (both bridge
 * validators require `path`), so reading the file keeps one code path and keeps
 * the request body small enough for the bridge's body limit.
 */
export async function readPromptImages(
  attachments: readonly PiPromptAttachment[],
  workspaceRoot: string,
): Promise<PiPromptImage[]> {
  const images: PiPromptImage[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (attachment.type !== "image") continue;
    const { bytes, absolutePath } = await readWorkspaceImage(attachment.path, workspaceRoot);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES) {
      throw new PromptAttachmentError(
        "attachment_too_large",
        "Image attachments exceed the 32MB total limit",
      );
    }
    images.push({
      data: bytes.toString("base64"),
      mimeType: imageMimeType(bytes),
      path: attachment.path,
      absolutePath,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }
  return images;
}

/**
 * Identify the format from the file's own bytes.
 *
 * The extension is a caller-supplied label; the model is shown the bytes. A
 * mismatch between the two is what turns an attachment into an unreadable block
 * the model silently ignores, so the signature decides — and an unrecognised
 * signature is refused rather than guessed at.
 */
export function imageMimeType(bytes: Buffer): string {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString("latin1") === "GIF87a" ||
      bytes.subarray(0, 6).toString("latin1") === "GIF89a")
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  throw new PromptAttachmentError(
    "attachment_unsupported_format",
    "Image attachments must be PNG, JPEG, GIF, or WebP",
  );
}

function attachmentErrorForFsFailure(error: unknown): PromptAttachmentError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ELOOP") {
    return new PromptAttachmentError(
      "attachment_symlink_not_allowed",
      "Image attachments must be regular workspace files, not symbolic links",
    );
  }
  return new PromptAttachmentError(
    "attachment_read_failed",
    "Image attachment could not be read from the workspace",
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const childPath = relative(root, candidate);
  return (
    Boolean(childPath) &&
    childPath !== ".." &&
    !childPath.startsWith(`..${sep}`) &&
    !isAbsolute(childPath)
  );
}

async function assertNoSymlinkComponents(root: string, targetPath: string): Promise<void> {
  let currentPath = root;
  for (const segment of relative(root, targetPath).split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    const stats = await lstat(currentPath).catch((error: unknown) => {
      throw attachmentErrorForFsFailure(error);
    });
    if (stats.isSymbolicLink()) {
      throw new PromptAttachmentError(
        "attachment_symlink_not_allowed",
        "Image attachments must be regular workspace files, not symbolic links",
      );
    }
  }
}

/**
 * Confirm the handle we read from is the same regular file the path still names
 * and that it is still inside the workspace. Called before and after the read so
 * a file replaced mid-read is rejected instead of half-sent.
 */
async function assertOpenedWorkspaceFile(
  targetPath: string,
  canonicalRoot: string,
  openedStats: Stats,
): Promise<void> {
  const [pathStats, canonicalTarget] = await Promise.all([
    lstat(targetPath),
    realpath(targetPath),
  ]).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  if (pathStats.isSymbolicLink()) {
    throw new PromptAttachmentError(
      "attachment_symlink_not_allowed",
      "Image attachments must be regular workspace files, not symbolic links",
    );
  }
  if (
    !pathStats.isFile() ||
    !openedStats.isFile() ||
    pathStats.dev !== openedStats.dev ||
    pathStats.ino !== openedStats.ino
  ) {
    throw new PromptAttachmentError(
      "attachment_not_regular_file",
      "Image attachment is not a stable regular workspace file",
    );
  }
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new PromptAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace",
    );
  }
}

/**
 * The identity a read must still hold when it finishes.
 *
 * Extracted from the read so the comparison itself is testable: reproducing a
 * genuine mid-read swap from a test would mean racing the read loop, and a hook
 * in this module to make that deterministic would put a test-only injection
 * point inside the very window these checks exist to protect.
 */
export interface ReadIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * Reject a file that moved under the read.
 *
 * A short read counts too: `bytesRead` disagreeing with the size the file
 * reports is the same corruption as a changed inode, and sending a truncated
 * image is worse than refusing it, because a half-decoded picture reads to the
 * user as the model misunderstanding what they attached.
 */
export function assertStableRead(
  initial: ReadIdentity,
  final: ReadIdentity,
  bytesRead: number,
): void {
  if (
    final.dev !== initial.dev ||
    final.ino !== initial.ino ||
    final.size !== initial.size ||
    final.size !== bytesRead ||
    final.mtimeMs !== initial.mtimeMs ||
    final.ctimeMs !== initial.ctimeMs
  ) {
    throw new PromptAttachmentError(
      "attachment_changed",
      "Image attachment changed while it was being read; attach it again",
    );
  }
}

async function readWorkspaceImage(
  filePath: string,
  workspaceRoot: string,
): Promise<{ bytes: Buffer; absolutePath: string }> {
  const lexicalRoot = resolve(workspaceRoot);
  const targetPath = isAbsolute(filePath) ? resolve(filePath) : resolve(lexicalRoot, filePath);
  if (!isPathWithin(lexicalRoot, targetPath)) {
    throw new PromptAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace",
    );
  }

  const canonicalRoot = await realpath(lexicalRoot).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  await assertNoSymlinkComponents(lexicalRoot, targetPath);
  const canonicalTarget = await realpath(targetPath).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new PromptAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace",
    );
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(targetPath, constants.O_RDONLY | noFollow).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  try {
    const initialStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, initialStats);
    if (initialStats.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new PromptAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit",
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_IMAGE_ATTACHMENT_BYTES) {
      const remaining = MAX_IMAGE_ATTACHMENT_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new PromptAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit",
      );
    }
    if (totalBytes === 0) {
      throw new PromptAttachmentError("attachment_empty", "Image attachment file is empty");
    }

    const finalStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, finalStats);
    assertStableRead(initialStats, finalStats, totalBytes);
    return { bytes: Buffer.concat(chunks, totalBytes), absolutePath: targetPath };
  } catch (error) {
    if (error instanceof PromptAttachmentError) throw error;
    throw attachmentErrorForFsFailure(error);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve every file attachment to a workspace-contained absolute path.
 *
 * Applies the same containment and symlink rules as the image reader without
 * reading a byte: the model is told the path and opens it with `read`, so the
 * only thing that has to be guaranteed here is that the path it is told about
 * is inside the workspace and is a real file.
 */
export async function resolvePromptFiles(
  attachments: readonly PiPromptAttachment[],
  workspaceRoot: string,
): Promise<PiPromptFile[]> {
  const files: PiPromptFile[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "file") continue;
    const absolutePath = await resolveWorkspaceFile(attachment.path, workspaceRoot);
    files.push({
      path: attachment.path,
      absolutePath,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }
  return files;
}

async function resolveWorkspaceFile(filePath: string, workspaceRoot: string): Promise<string> {
  const lexicalRoot = resolve(workspaceRoot);
  const targetPath = isAbsolute(filePath) ? resolve(filePath) : resolve(lexicalRoot, filePath);
  if (!isPathWithin(lexicalRoot, targetPath)) {
    throw new PromptAttachmentError(
      "attachment_outside_workspace",
      "A file attachment must be contained in the current workspace",
    );
  }
  const canonicalRoot = await realpath(lexicalRoot).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  await assertNoSymlinkComponents(lexicalRoot, targetPath);
  const canonicalTarget = await realpath(targetPath).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new PromptAttachmentError(
      "attachment_outside_workspace",
      "A file attachment must be contained in the current workspace",
    );
  }
  const stats = await lstat(targetPath).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  if (!stats.isFile()) {
    throw new PromptAttachmentError(
      "attachment_not_regular_file",
      "A file attachment must name a regular workspace file",
    );
  }
  return targetPath;
}

/**
 * The line appended to a prompt that carried file attachments.
 *
 * Absolute paths, because the model resolves them with `read` and the tool's
 * own cwd is not something the prompt can rely on. Named rather than inlined so
 * the model reads only what it decides it needs.
 */
export function promptFileReferences(files: readonly PiPromptFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map((file) =>
    file.filename && file.filename !== file.path
      ? `- ${file.absolutePath} (${file.filename})`
      : `- ${file.absolutePath}`,
  );
  return `\n\nAttached files:\n${lines.join("\n")}`;
}
