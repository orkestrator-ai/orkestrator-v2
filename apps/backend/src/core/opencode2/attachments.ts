/**
 * Prompt images and attachments as OpenCode 2.x prompt `files`
 * (`PromptInput.FileAttachment { uri, name }`; build plan phase 5).
 *
 * Observed on 2.2.6 with a scripted model:
 *
 * - The server reads a `file://` URI itself, at admission, and stores the
 *   bytes on the user row; a `data:` URI is taken inline. Either way the
 *   model receives a text file as text ("Attached file: <name>" and its
 *   contents) and an image as an image part.
 * - The server derives the media type from the bytes, not from the label:
 *   text sent as `data:image/png` reached the model as text. So the 1.x
 *   failure (a mislabelled file accepted with 204 that never became a message,
 *   agent-engines.md) cannot recur here, and no label is sent for a path.
 * - A file the server cannot read is refused with a 4xx (`files`), which the
 *   provider reports as a rejected prompt; nothing was admitted.
 *
 * Images arrive inline (the composer's base64) and attachments as staged
 * workspace paths, which the host server reads directly. The same order as
 * 1.x is kept: images first, then attachments.
 */
import path from "node:path";
import { PromptRejectedError, type ProviderSendOptions } from "../agent-provider-contract.js";
import {
  MAX_TOTAL_ATTACHMENT_BYTES,
  mimeTypeForImageData,
  promptAttachmentUrl,
} from "../prompt-attachments.js";
import type { OpenCode2FileInput } from "./types.js";

/** As many files as the composer may stage for one prompt. */
export const OPENCODE2_MAX_PROMPT_FILES = 40;
const MAX_NAME_LENGTH = 256;
/**
 * The staging limit is on decoded bytes, and base64 is 4/3 of them. A staged
 * image can arrive both as an image and as its attachment's data URL (both
 * are sent, as on 1.x), so the inline bound allows the limit twice.
 */
const INLINE_BASE64_LIMIT = 2 * Math.ceil((MAX_TOTAL_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024;

function displayName(value: string | undefined, fallback: string): string {
  const base = (value ?? "").split(/[\\/]/).at(-1)?.trim() ?? "";
  return (base || fallback).slice(0, MAX_NAME_LENGTH);
}

/**
 * The `files` of one 2.x prompt, or undefined when there are none. A relative
 * attachment path is resolved against the session's directory: the server
 * reads it, and a `file:///relative` URI would name the filesystem root.
 */
export function openCode2PromptFiles(
  options: Pick<ProviderSendOptions, "images" | "attachments">,
  directory: string,
): OpenCode2FileInput[] | undefined {
  const files: OpenCode2FileInput[] = [];
  let inlineBytes = 0;
  for (const [index, image] of (options.images ?? []).entries()) {
    const mime = mimeTypeForImageData(image.filename, image.data);
    inlineBytes += image.data.length;
    files.push({
      uri: `data:${mime};base64,${image.data}`,
      name: displayName(image.filename, `image-${index + 1}`),
    });
  }
  for (const [index, attachment] of (options.attachments ?? []).entries()) {
    const absolute =
      attachment.dataUrl || path.isAbsolute(attachment.path)
        ? attachment
        : { ...attachment, path: path.join(directory, attachment.path) };
    let uri: string;
    try {
      uri = promptAttachmentUrl(absolute);
    } catch (error) {
      throw new PromptRejectedError(
        error instanceof Error ? error.message : "The attachment path is invalid",
      );
    }
    if (uri.startsWith("data:")) inlineBytes += uri.length;
    files.push({
      uri,
      name: displayName(attachment.filename ?? attachment.path, `attachment-${index + 1}`),
    });
  }
  if (files.length === 0) return undefined;
  if (files.length > OPENCODE2_MAX_PROMPT_FILES) {
    throw new PromptRejectedError(
      `OpenCode 2 takes at most ${OPENCODE2_MAX_PROMPT_FILES} attachments per prompt`,
    );
  }
  if (inlineBytes > INLINE_BASE64_LIMIT) {
    throw new PromptRejectedError("The attachments exceed the 32 MB total limit");
  }
  return files;
}
