/**
 * Durable attachment references for Codex prompts.
 *
 * A live turn can describe its attachments structurally, because the bridge
 * still holds the request that carried them. A transcript rebuilt from disk
 * cannot: Codex persists an attached image as a base64 `input_image` data URL
 * and keeps no record of the path it came from, so the only recoverable copy is
 * one that would cost megabytes per image to replay through SSE.
 *
 * Writing a small XML marker into the prompt text instead means the reference
 * lands in the rollout as ordinary `input_text` and survives every rehydration
 * for a few dozen bytes. {@link extractAttachmentTags} turns it back into the
 * same `file` part the live turn published, so a reloaded tab renders the same
 * thumbnail rather than degrading to a filename.
 *
 * The format is the Claude bridge's `<attached-files>` block, qualified with
 * `source="orkestrator"`, and only that qualified form is parsed back.
 * Rehydration reads the *user's own* persisted text, so an unqualified marker
 * would make a prompt that merely talks about this markup — plausible for
 * anyone working on Orkestrator itself — come back from a reload with that text
 * deleted and attachment rows for files nobody attached. The attribute is what
 * separates "the bridge wrote this" from "the user typed this".
 */
import type { NormalizedPart } from "./types.js";

export interface AttachmentTagInput {
  path: string;
  filename?: string;
}

/**
 * Bounds the block a single prompt can carry.
 *
 * The prompt route already caps attachment count, but this text is appended to
 * a model prompt and parsed back out of untrusted rollout files, so it carries
 * its own limit rather than trusting either side.
 */
const MAX_TAGGED_ATTACHMENTS = 20;
const MAX_TAG_VALUE_LENGTH = 1024;

/**
 * Marks a block as one this bridge wrote.
 *
 * Only blocks carrying it are stripped and converted back into attachments; a
 * plain `<attached-files>` block in a user's prompt is left as the text they
 * wrote.
 */
const ATTACHMENT_BLOCK_SOURCE = "orkestrator";

const ATTACHED_FILES_PATTERN = new RegExp(
  `<attached-files\\s+source="${ATTACHMENT_BLOCK_SOURCE}"\\s*>\\s*([\\s\\S]*?)\\s*</attached-files>`,
  "g",
);
const ATTACHMENT_PATTERN = /<attachment\s+([^>]*?)\s*\/>/g;

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlAttribute(value: string): string {
  return value.replace(
    /&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&quot;": return '"';
        case "&apos;": return "'";
        case "&amp;": return "&";
        case "&lt;": return "<";
        case "&gt;": return ">";
        default: {
          const isHex = entity.toLowerCase().startsWith("&#x");
          const digits = entity.slice(isHex ? 3 : 2, -1);
          const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
          return Number.isSafeInteger(codePoint)
            && codePoint >= 0
            && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
        }
      }
    },
  );
}

function readAttribute(tagBody: string, name: string): string | undefined {
  const match = tagBody.match(new RegExp(`${name}="([^"]*)"`));
  if (!match?.[1]) return undefined;
  const decoded = decodeXmlAttribute(match[1]);
  return decoded.length > MAX_TAG_VALUE_LENGTH ? undefined : decoded;
}

/**
 * Render the block for a prompt's attachments, or `undefined` when there is
 * nothing to reference.
 */
export function buildAttachmentTagBlock(
  attachments: readonly AttachmentTagInput[],
): string | undefined {
  const tagged = attachments
    .filter((attachment) => attachment.path.length > 0
      && attachment.path.length <= MAX_TAG_VALUE_LENGTH)
    .slice(0, MAX_TAGGED_ATTACHMENTS);
  if (tagged.length === 0) return undefined;

  const tags = tagged
    .map((attachment) =>
      `<attachment type="image" path="${escapeXmlAttribute(attachment.path)}"`
      + ` filename="${escapeXmlAttribute(attachment.filename ?? "")}" />`)
    .join("\n");
  return `<attached-files source="${ATTACHMENT_BLOCK_SOURCE}">\n${tags}\n</attached-files>`;
}

/** Append the attachment block to the text Codex will persist for this turn. */
export function appendAttachmentTags(
  prompt: string,
  attachments: readonly AttachmentTagInput[],
): string {
  const block = buildAttachmentTagBlock(attachments);
  if (!block) return prompt;
  return prompt.length > 0 ? `${prompt}\n\n${block}` : block;
}

/**
 * Split persisted text back into the prompt the user wrote and the `file` parts
 * its attachments should render as.
 *
 * `fileUrl` is the workspace path rather than inline data: the renderer reads
 * the bytes itself (host or container), which is what keeps a rehydrated
 * transcript bounded no matter how large the original image was.
 *
 * Only a block this bridge marked as its own is touched. Text the user wrote
 * comes back exactly as they wrote it, even when it contains the same markup.
 */
export function extractAttachmentTags(
  text: string,
): { text: string; parts: NormalizedPart[] } {
  if (!text.includes(`<attached-files source="${ATTACHMENT_BLOCK_SOURCE}"`)) {
    return { text, parts: [] };
  }

  const parts: NormalizedPart[] = [];
  let cleaned = text;

  for (const block of text.matchAll(ATTACHED_FILES_PATTERN)) {
    const body = block[1] ?? "";
    for (const tag of body.matchAll(ATTACHMENT_PATTERN)) {
      if (parts.length >= MAX_TAGGED_ATTACHMENTS) break;
      const path = readAttribute(tag[1] ?? "", "path");
      if (!path) continue;
      const filename = readAttribute(tag[1] ?? "", "filename");
      parts.push({
        type: "file",
        content: path,
        fileUrl: path,
        ...(filename ? { filename } : {}),
      });
    }
    cleaned = cleaned.replace(block[0], "");
  }

  return { text: cleaned.trim(), parts };
}
