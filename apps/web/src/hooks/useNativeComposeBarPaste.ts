import { useEffect, type RefObject } from "react";
import { readImage } from "@/lib/native/clipboard";
import { toast } from "sonner";
import {
  encodeCanvasAsPngWithinSize,
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

function isDesktopRenderer(): boolean {
  return (
    window.orkestratorGateway?.desktop === true ||
    (Boolean(window.orkestrator) && window.orkestratorGateway?.enabled !== true)
  );
}

function dispatchRestoredPasteInput(target: HTMLElement, text: string): void {
  const event = typeof InputEvent === "function"
    ? new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertFromPaste",
      })
    : new Event("input", { bubbles: true });
  target.dispatchEvent(event);
}

function captureTextPasteFallback(
  event: ClipboardEvent,
  target: Element,
): (() => void) | null {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return null;

  let text: string;
  try {
    text = clipboardData.getData("text/plain");
  } catch {
    return null;
  }
  if (!text) return null;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const selectionStart = target.selectionStart ?? target.value.length;
    const selectionEnd = target.selectionEnd ?? selectionStart;
    return () => {
      target.setRangeText(text, selectionStart, selectionEnd, "end");
      dispatchRestoredPasteInput(target, text);
    };
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    const selection = window.getSelection();
    const selectedRange = selection?.rangeCount
      ? selection.getRangeAt(0)
      : null;
    const range = selectedRange && target.contains(selectedRange.commonAncestorContainer)
      ? selectedRange.cloneRange()
      : null;

    return () => {
      const textNode = document.createTextNode(text);
      if (range) {
        range.deleteContents();
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        const currentSelection = window.getSelection();
        currentSelection?.removeAllRanges();
        currentSelection?.addRange(range);
      } else {
        target.append(textNode);
      }
      dispatchRestoredPasteInput(target, text);
    };
  }

  return null;
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
  useEffect(() => {
    const handlePaste = async (event: ClipboardEvent) => {
      const activeEl = document.activeElement;
      if (!activeEl || !inputContainerRef.current?.contains(activeEl)) return;

      // Browser and iOS paste data is only guaranteed to be readable during
      // the event itself. Claim an image paste synchronously so the editable
      // input cannot also insert a filename, URL, or empty text payload.
      const pastedBlob = getPastedImageBlob(event);
      const nativePaste = !pastedBlob && isDesktopRenderer();
      const restoreTextPaste = nativePaste
        ? captureTextPasteFallback(event, activeEl)
        : null;
      if (pastedBlob || nativePaste) {
        event.preventDefault();
        event.stopPropagation();
      }

      let image: Awaited<ReturnType<typeof readImage>>;
      try {
        image = await readImage(pastedBlob);
      } catch (error) {
        restoreTextPaste?.();
        if (!isExpectedClipboardError(error)) {
          console.error(`[${logLabel}] Unexpected paste error:`, error);
        }
        return;
      }

      try {
        const rgba = await image.rgba();
        const { width, height } = await image.size();

        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }

        const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageData, 0, 0);

        canvas = resizeCanvasToMaxDimension(canvas, MAX_IMAGE_DIMENSION);
        canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

        const encodedImage = encodeCanvasAsPngWithinSize(canvas, MAX_IMAGE_SIZE);
        if (!encodedImage) {
          toast.error("Image too large", {
            description: "The image could not be resized below the 8MB attachment limit.",
          });
          return;
        }
        canvas = encodedImage.canvas;
        const { dataUrl, base64Data } = encodedImage;

        canvas.width = 0;
        canvas.height = 0;

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
        console.error(`[${logLabel}] Unexpected paste error:`, error);
      }
    };

    document.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      document.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [inputContainerRef, containerId, worktreePath, onAttach, logLabel]);
}
