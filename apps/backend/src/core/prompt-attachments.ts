import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import type { Environment } from "./models.js";

/**
 * A prompt attachment in the shape both bridges accept.
 *
 * Every bridge validator requires `path`: the Claude bridge rejects the whole
 * request without one and the Codex bridge silently drops the entry. A
 * base64-only image therefore has to be staged into the workspace before it can
 * be attached to a prompt, which is what {@link stagePromptImages} does.
 */
export type PromptAttachment = {
  type: "image" | "file";
  path: string;
  dataUrl?: string;
  filename?: string;
};

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Matches the per-payload cap the write-file commands already enforce. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;
export const MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const DEFAULT_STAGING_DIRECTORY = ".orkestrator/prompt-attachments";
export const INITIAL_PROMPT_STAGING_DIRECTORY = ".orkestrator/initial-prompt";

export function mimeTypeForFilename(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

/**
 * Resolve an inline image's media type from its bytes, using its name only
 * when the payload has no recognizable raster signature.
 *
 * Kanban images are normalized to WebP while retaining their user-facing
 * filename. Trusting that filename would label those WebP bytes as (usually)
 * PNG when they are handed to an image-aware agent.
 */
function detectedMimeTypeForImageData(data: string): string | undefined {
  // Eighteen decoded bytes cover the longest signature below (12 bytes)
  // without materializing a potentially multi-megabyte image payload.
  const bytes = Buffer.from(data.slice(0, 24), "base64");
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString("latin1") === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header = bytes.subarray(0, 6).toString("latin1");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function mimeTypeForImageData(filename: string, data: string): string {
  return detectedMimeTypeForImageData(data) ?? mimeTypeForFilename(filename);
}

function filenameForDetectedMimeType(filename: string, mediaType: string | undefined): string {
  if (!mediaType) return filename;
  const extension =
    mediaType === "image/jpeg"
      ? ".jpg"
      : mediaType === "image/gif"
        ? ".gif"
        : mediaType === "image/webp"
          ? ".webp"
          : ".png";
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem.slice(0, 128 - extension.length)}${extension}`;
}

/**
 * Resolve the URL an OpenCode file part should carry.
 *
 * Mirrors the renderer's client: inline data when it is available, otherwise a
 * `file://` URL. Traversal segments are refused rather than encoded so a
 * malformed path cannot address a file outside the workspace.
 */
export function promptAttachmentUrl(attachment: PromptAttachment): string {
  if (attachment.dataUrl) return attachment.dataUrl;
  if (attachment.path.includes("\0")) {
    throw new Error("Attachment path must not contain null bytes");
  }
  const segments = attachment.path.split(/[\\/]/);
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error("Attachment path must not contain traversal segments");
  }
  const encoded = segments.map(encodeURIComponent).join("/");
  return attachment.path.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/** Approximate decoded size without allocating the buffer. */
function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function sanitizeFilename(filename: string, index: number): string {
  // Only the basename is kept, and only characters that cannot escape the
  // staging directory survive. A caller-supplied name reaches the filesystem,
  // so "../" and separators must never be treated as path structure.
  const base = filename.split(/[\\/]/).at(-1)?.trim() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (safe.length === 0) return `attachment-${index + 1}.png`;
  return safe.slice(0, 128);
}

function allocateUniqueFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("Cannot allocate a unique attachment filename");
}

/**
 * Validate an untrusted image list at a trust boundary.
 *
 * Throws rather than filtering: a silently dropped attachment is a prompt that
 * references an image the agent cannot see.
 */
export function assertValidPromptImages(images: readonly unknown[]): TaskSnapshotImage[] {
  if (images.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`At most ${MAX_ATTACHMENT_COUNT} prompt images are allowed`);
  }
  let total = 0;
  const validated: TaskSnapshotImage[] = [];
  for (const candidate of images) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Prompt image must be an object");
    }
    const record = candidate as Record<string, unknown>;
    const filename = record.filename;
    const data = record.data;
    if (typeof filename !== "string" || filename.trim().length === 0) {
      throw new Error("Prompt image filename must be a non-empty string");
    }
    if (typeof data !== "string" || data.trim().length === 0) {
      throw new Error("Prompt image data must be a non-empty base64 string");
    }
    if (!BASE64_PATTERN.test(data)) {
      throw new Error("Prompt image data must be valid base64");
    }
    const bytes = base64ByteLength(data);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error("Prompt image exceeds the 8MB limit");
    }
    total += bytes;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Prompt images exceed the 32MB total limit");
    }
    validated.push({ filename, data });
  }
  return validated;
}

/**
 * Validate an untrusted attachment list that already carries workspace paths.
 *
 * Queued prompts arrive with attachments the renderer already staged, so these
 * need no writing — only bounds and shape checks before they reach a bridge.
 */
export function assertValidPromptAttachments(attachments: readonly unknown[]): PromptAttachment[] {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`At most ${MAX_ATTACHMENT_COUNT} prompt attachments are allowed`);
  }
  const validated: PromptAttachment[] = [];
  for (const candidate of attachments) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Prompt attachment must be an object");
    }
    const record = candidate as Record<string, unknown>;
    const path = record.path;
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new Error("Prompt attachment path must be a non-empty string");
    }
    const type = record.type === "file" ? "file" : "image";
    const filename =
      typeof record.filename === "string" && record.filename.trim().length > 0
        ? record.filename
        : undefined;
    const dataUrl =
      typeof record.dataUrl === "string" && record.dataUrl.trim().length > 0
        ? record.dataUrl
        : undefined;
    // A file attachment carries no inline data at either bridge, and an
    // oversized data URL would be rejected there anyway.
    if (type === "file" || (dataUrl && dataUrl.length > MAX_ATTACHMENT_BYTES * 2)) {
      validated.push({ type, path, filename });
      continue;
    }
    validated.push({ type, path, dataUrl, filename });
  }
  return validated;
}

/**
 * Write base64 images into the environment workspace and describe them in the
 * shape both bridges accept.
 *
 * Mirrors the renderer's staging so a launch recovered by either side resolves
 * the same paths.
 */
export async function stagePromptImages(
  invoke: CommandInvoker,
  environment: Environment,
  images: readonly TaskSnapshotImage[],
  stagingDirectory: string = DEFAULT_STAGING_DIRECTORY,
): Promise<PromptAttachment[]> {
  if (images.length === 0) return [];
  const validated = assertValidPromptImages(images);
  const isLocal = environment.environmentType === "local";
  if (isLocal && !environment.worktreePath) {
    throw new Error("Cannot stage prompt attachments without a worktree path");
  }
  if (!isLocal && !environment.containerId) {
    throw new Error("Cannot stage prompt attachments without a container");
  }

  const used = new Set<string>();
  const staged: PromptAttachment[] = [];
  for (const [index, image] of validated.entries()) {
    const detectedMediaType = detectedMimeTypeForImageData(image.data);
    const filename = allocateUniqueFilename(
      filenameForDetectedMimeType(sanitizeFilename(image.filename, index), detectedMediaType),
      used,
    );
    const relativePath = `${stagingDirectory}/${filename}`;
    const path = isLocal
      ? await invoke<string>("write_local_file", {
          worktreePath: environment.worktreePath,
          filePath: relativePath,
          base64Data: image.data,
        })
      : await (async () => {
          await invoke("write_container_file", {
            containerId: environment.containerId,
            filePath: relativePath,
            base64Data: image.data,
          });
          return `/workspace/${relativePath}`;
        })();
    staged.push({
      type: "image",
      path,
      filename,
      dataUrl: `data:${detectedMediaType ?? mimeTypeForFilename(filename)};base64,${image.data}`,
    });
  }
  return staged;
}
