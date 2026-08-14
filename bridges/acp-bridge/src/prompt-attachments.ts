import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Prompt image attachments for the ACP providers.
 *
 * Both `cursor-agent` and `grok` accept ACP `image` content blocks carrying
 * inline base64, so an attached image reaches the model natively instead of
 * depending on the agent choosing to open the path named in the prompt text.
 * (Grok advertises `promptCapabilities.image: false` but reads the block
 * correctly; the declaration is conservative, not accurate, so capability is
 * decided by what the agents do, not by what they claim.)
 *
 * ACP has no local-path image block, which is why this reads the bytes itself.
 * That read is a trust boundary: the path arrives over HTTP, so it is confined
 * to the workspace, refused if any component is a symlink, bounded in size, and
 * re-checked after the read so a file swapped mid-read is rejected rather than
 * silently sent. This mirrors the Claude bridge's image attachment reader.
 */
export interface AcpPromptAttachment {
  type: "image";
  path: string;
  filename?: string;
}

export interface AcpPromptImage {
  /** Base64 of the file's bytes, ready for an ACP `image` content block. */
  data: string;
  mimeType: string;
  /** The path as requested, which callers may have given relative to the cwd. */
  path: string;
  /** Absolute path, so a transcript `file://` URL is always well formed. */
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

  constructor(readonly code: PromptAttachmentErrorCode, message: string) {
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
export function parsePromptAttachments(value: unknown): AcpPromptAttachment[] {
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
    // Files are a separate capability this provider does not advertise, so a
    // file attachment is a caller bug rather than something to quietly ignore.
    if (record.type !== "image") {
      throw new PromptAttachmentError(
        "attachment_invalid",
        "Cursor and Grok accept image attachments only",
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
    const filename = typeof record.filename === "string" && record.filename.trim()
      && Buffer.byteLength(record.filename) <= MAX_ATTACHMENT_FILENAME_BYTES
      ? record.filename
      : undefined;
    return { type: "image" as const, path, ...(filename ? { filename } : {}) };
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
  attachments: readonly AcpPromptAttachment[],
  workspaceRoot: string,
  options: {
    /** Test seam for deterministically exercising a file swapped during its read. */
    afterInitialValidation?: (absolutePath: string) => void | Promise<void>;
  } = {},
): Promise<AcpPromptImage[]> {
  const images: AcpPromptImage[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    const { bytes, absolutePath } = await readWorkspaceImage(
      attachment.path,
      workspaceRoot,
      options.afterInitialValidation,
    );
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
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && (
    bytes.subarray(0, 6).toString("latin1") === "GIF87a"
    || bytes.subarray(0, 6).toString("latin1") === "GIF89a"
  )) return "image/gif";
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("latin1") === "RIFF"
    && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
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
  return Boolean(childPath)
    && childPath !== ".."
    && !childPath.startsWith(`..${sep}`)
    && !isAbsolute(childPath);
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
    !pathStats.isFile()
    || !openedStats.isFile()
    || pathStats.dev !== openedStats.dev
    || pathStats.ino !== openedStats.ino
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

async function readWorkspaceImage(
  filePath: string,
  workspaceRoot: string,
  afterInitialValidation?: (absolutePath: string) => void | Promise<void>,
): Promise<{ bytes: Buffer; absolutePath: string }> {
  const lexicalRoot = resolve(workspaceRoot);
  const targetPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(lexicalRoot, filePath);
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
  const handle = await open(targetPath, constants.O_RDONLY | noFollow).catch(
    (error: unknown) => {
      throw attachmentErrorForFsFailure(error);
    },
  );
  try {
    const initialStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, initialStats);
    await afterInitialValidation?.(targetPath);
    if (initialStats.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new PromptAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit",
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_IMAGE_ATTACHMENT_BYTES) {
      const remaining = (MAX_IMAGE_ATTACHMENT_BYTES + 1) - totalBytes;
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
    if (
      finalStats.dev !== initialStats.dev
      || finalStats.ino !== initialStats.ino
      || finalStats.size !== initialStats.size
      || finalStats.size !== totalBytes
      || finalStats.mtimeMs !== initialStats.mtimeMs
      || finalStats.ctimeMs !== initialStats.ctimeMs
    ) {
      throw new PromptAttachmentError(
        "attachment_changed",
        "Image attachment changed while it was being read; attach it again",
      );
    }
    return { bytes: Buffer.concat(chunks, totalBytes), absolutePath: targetPath };
  } catch (error) {
    if (error instanceof PromptAttachmentError) throw error;
    throw attachmentErrorForFsFailure(error);
  } finally {
    await handle.close();
  }
}
