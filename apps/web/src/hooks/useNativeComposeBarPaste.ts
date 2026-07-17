import { useCallback, useEffect, type RefObject } from "react";
import { readImage } from "@/lib/native/clipboard";
import { toast } from "sonner";
import {
  MAX_IMAGE_DIMENSION,
  resizeCanvasIfNeeded,
  resizeCanvasToMaxDimension,
} from "@/lib/canvas-utils";
import { writeContainerFile, writeLocalFile } from "@/lib/backend";
import { getPastedImageBlob } from "@/lib/clipboard-event";

/** Maximum final PNG size in bytes (8MB) */
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

/** Maximum raw RGBA buffer size (32MB — allows ~2800x2800 images before PNG compression) */
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

/**
 * Shape of the attachment produced after a successful image paste. The three
 * native compose bars each have their own attachment types but they are all
 * structurally compatible with this shape (image-only subset).
 */
export interface PastedImageAttachment {
  id: string;
  type: "image";
  path: string;
  previewUrl: string;
  name: string;
}

interface UseNativeComposeBarPasteOptions {
  /** Ref to the input container — paste is only processed when focus is inside */
  inputContainerRef: RefObject<HTMLElement | null>;
  /** Container ID for containerized environments */
  containerId: string | null;
  /** Worktree path for local environments */
  worktreePath?: string | null;
  /** Called once the image has been saved and an attachment is ready to add */
  onAttach: (attachment: PastedImageAttachment) => void;
  /** Log prefix for unexpected errors, e.g. "ClaudeComposeBar" */
  logLabel: string;
}

function generateImageFilename(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const random = Math.random().toString(36).substring(2, 8);
  return `clipboard-${timestamp}-${random}.png`;
}

function isExpectedClipboardError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const name = error.name?.toLowerCase() ?? "";
  return (
    msg.includes("clipboard") ||
    msg.includes("no image") ||
    msg.includes("not found") ||
    msg.includes("empty") ||
    msg.includes("unavailable") ||
    name.includes("clipboard") ||
    name.includes("notfounderror")
  );
}

/**
 * Document-level paste handler shared by the native compose bars (Claude,
 * Codex, OpenCode). Reads an image from a browser/iOS paste event or the
 * Electron clipboard, resizes it to safe bounds, writes it into the
 * environment, and hands a ready-to-use attachment descriptor back via
 * `onAttach`. Non-image pastes fall through to the browser's default text
 * paste behavior.
 */
export function useNativeComposeBarPaste({
  inputContainerRef,
  containerId,
  worktreePath,
  onAttach,
  logLabel,
}: UseNativeComposeBarPasteOptions): void {
  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const activeEl = document.activeElement;
      if (!activeEl || !inputContainerRef.current?.contains(activeEl)) return;

      // Browser and iOS paste data is only guaranteed to be readable during
      // the event itself. Claim an image paste synchronously so the editable
      // input cannot also insert a filename, URL, or empty text payload.
      const pastedBlob = getPastedImageBlob(event);
      if (pastedBlob) {
        event.preventDefault();
        event.stopPropagation();
      }

      try {
        const image = await readImage(pastedBlob);
        const rgba = await image.rgba();
        const { width, height } = await image.size();

        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageData, 0, 0);

        canvas = resizeCanvasToMaxDimension(canvas, MAX_IMAGE_DIMENSION);
        canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

        const dataUrl = canvas.toDataURL("image/png");
        const base64Data = dataUrl.split(",")[1] || "";
        const estimatedSize = (base64Data.length * 3) / 4;
        if (estimatedSize > MAX_IMAGE_SIZE) {
          toast.error("Image too large", {
            description: `Image is ${(estimatedSize / 1024 / 1024).toFixed(1)}MB. Maximum is 8MB.`,
          });
          return;
        }

        canvas.width = 0;
        canvas.height = 0;

        if (!pastedBlob) {
          event.preventDefault();
          event.stopPropagation();
        }

        const filename = generateImageFilename();
        const filePath = `.orkestrator/clipboard/${filename}`;

        let savedPath: string | null = null;
        if (containerId) {
          await writeContainerFile(containerId, filePath, base64Data);
          savedPath = `/workspace/${filePath}`;
        } else if (worktreePath) {
          savedPath = await writeLocalFile(worktreePath, filePath, base64Data);
        }

        if (!savedPath) {
          toast.error("Cannot save image", {
            description: "Environment not properly configured for attachments",
          });
          return;
        }

        onAttach({
          id: Math.random().toString(36).substring(2, 9),
          type: "image",
          path: savedPath,
          previewUrl: dataUrl,
          name: filename,
        });
      } catch (error) {
        if (!isExpectedClipboardError(error)) {
          console.error(`[${logLabel}] Unexpected paste error:`, error);
        }
      }
    },
    [inputContainerRef, containerId, worktreePath, onAttach, logLabel],
  );

  useEffect(() => {
    document.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      document.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [handlePaste]);
}
