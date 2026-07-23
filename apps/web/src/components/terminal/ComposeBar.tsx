import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { X, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readImage } from "@/lib/native/clipboard";
import { writeContainerFile, writeLocalFile } from "@/lib/backend";
import {
  encodeCanvasAsPngWithinSize,
  MAX_IMAGE_DIMENSION,
  resizeCanvasIfNeeded,
  resizeCanvasToMaxDimension,
} from "@/lib/canvas-utils";
import { toast } from "sonner";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { getPastedImageBlob } from "@/lib/clipboard-event";

interface ImageAttachment {
  id: string;
  dataUrl: string;
  base64Data: string;
  width: number;
  height: number;
}

interface ComposeBarProps {
  sessionKey: string;
  isOpen: boolean;
  onClose: () => void;
  onSend: (images: ImageAttachment[], text: string) => void;
  containerId: string | null;
  /** Worktree path for local environments (alternative to containerId) */
  worktreePath?: string | null;
  showAddressAll?: boolean;
  onAddressAll?: () => void;
}

const MAX_LINES = 10;
const LINE_HEIGHT = 20; // approximate line height in pixels
const EMPTY_IMAGES: ImageAttachment[] = [];

/** Maximum image size in bytes (8MB) */
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

/** Maximum raw RGBA buffer size (32MB) */
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

function generateImageFilename(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const random = Math.random().toString(36).substring(2, 8);
  return `clipboard-${timestamp}-${random}.png`;
}

export function ComposeBar({
  sessionKey,
  isOpen,
  onClose,
  onSend,
  containerId,
  worktreePath,
  showAddressAll = false,
  onAddressAll,
}: ComposeBarProps) {
  const text = useTerminalSessionStore((state) => state.composeDraftText.get(sessionKey) ?? "");
  const images = useTerminalSessionStore((state) => state.composeDraftImages.get(sessionKey) ?? EMPTY_IMAGES);
  const setComposeDraftText = useTerminalSessionStore((state) => state.setComposeDraftText);
  const appendComposeDraftImage = useTerminalSessionStore((state) => state.appendComposeDraftImage);
  const removeComposeDraftImage = useTerminalSessionStore((state) => state.removeComposeDraftImage);
  const clearComposeDraft = useTerminalSessionStore((state) => state.clearComposeDraft);

  const [isSending, setIsSending] = useState(false);
  const [pendingPasteCount, setPendingPasteCount] = useState(0);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMountedRef = useRef(true);
  const isSendingRef = useRef(false);
  const pasteLifecycleRef = useRef(0);
  const pendingPasteCountRef = useRef(0);
  const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const resetPasteLifecycle = useCallback(() => {
    pasteLifecycleRef.current += 1;
    pendingPasteCountRef.current = 0;
    pasteQueueRef.current = Promise.resolve();
    if (isMountedRef.current) {
      setPendingPasteCount(0);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      pasteLifecycleRef.current += 1;
    };
  }, []);

  // A paste belongs only to the open compose session that received it.
  useEffect(() => {
    resetPasteLifecycle();
    return resetPasteLifecycle;
  }, [isOpen, sessionKey, resetPasteLifecycle]);

  // Focus textarea when bar opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  // Handle paste events when compose bar is open
  const handlePaste = useCallback(async (event: ClipboardEvent) => {
    if (!isOpen || isSendingRef.current) return;

    // Only handle paste if THIS compose bar's textarea has focus
    if (document.activeElement !== textareaRef.current) return;

    const pastedBlob = getPastedImageBlob(event);
    if (pastedBlob) {
      event.preventDefault();
      event.stopPropagation();
    }

    const pasteLifecycle = pasteLifecycleRef.current;
    pendingPasteCountRef.current += 1;
    setPendingPasteCount((count) => count + 1);

    // Start decoding immediately so multiple pastes can process concurrently.
    const processing = (async (): Promise<ImageAttachment | "too-large" | null> => {
      // Browser/iOS provide a blob on the event; Electron remains the fallback.
      try {
        const image = await readImage(pastedBlob);
        const rgba = await image.rgba();
        const { width, height } = await image.size();

        // Convert RGBA to PNG via canvas
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const imageDataObj = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageDataObj, 0, 0);

        canvas = resizeCanvasToMaxDimension(canvas, MAX_IMAGE_DIMENSION);
        canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

        const encodedImage = encodeCanvasAsPngWithinSize(canvas, MAX_IMAGE_SIZE);
        if (!encodedImage) {
          console.error("[ComposeBar] Image could not be resized below the attachment limit");
          return "too-large";
        }
        canvas = encodedImage.canvas;
        const { dataUrl, base64Data } = encodedImage;

        // Store final dimensions before cleanup
        const finalWidth = canvas.width;
        const finalHeight = canvas.height;

        // Release canvas memory
        canvas.width = 0;
        canvas.height = 0;

        return {
          id: Math.random().toString(36).substring(2, 9),
          dataUrl,
          base64Data,
          width: finalWidth,
          height: finalHeight,
        };
      } catch {
        // No image in clipboard - this is expected when pasting text.
        // Let the paste event propagate to native text handling.
        return null;
      }
    })();

    const queuedPaste = pasteQueueRef.current.then(async () => {
      const result = await processing;
      const isCurrentPaste =
        isMountedRef.current &&
        isOpen &&
        pasteLifecycleRef.current === pasteLifecycle;
      if (!isCurrentPaste || !result) return;

      if (result === "too-large") {
        toast.error("Image too large", {
          description: "The image could not be resized below the 8MB attachment limit.",
        });
        return;
      }

      // Prevent default behavior when the Electron fallback found an image.
      if (!pastedBlob) {
        event.preventDefault();
        event.stopPropagation();
      }
      appendComposeDraftImage(sessionKey, result);
    });

    pasteQueueRef.current = queuedPaste
      .catch((error) => {
        console.error("[ComposeBar] Failed to add pasted image:", error);
      })
      .finally(() => {
        if (pasteLifecycleRef.current !== pasteLifecycle) return;
        pendingPasteCountRef.current -= 1;
        if (isMountedRef.current) {
          setPendingPasteCount((count) => Math.max(0, count - 1));
        }
      });

    await pasteQueueRef.current;
  }, [isOpen, sessionKey, appendComposeDraftImage]);

  // Listen for paste events
  useEffect(() => {
    if (!isOpen) return;

    // Use capture phase to intercept before other handlers
    document.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      document.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [isOpen, handlePaste]);

  const handleClose = useCallback(() => {
    resetPasteLifecycle();
    onClose();
  }, [onClose, resetPasteLifecycle]);

  // Handle keyboard events in textarea
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isMeta = event.metaKey;
    const isCtrl = event.ctrlKey;

    // Cmd+I / Ctrl+I - close compose bar
    if ((isMeta || isCtrl) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      handleClose();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      // Enter without shift - send
      event.preventDefault();
      handleSend();
    } else if (event.key === "Escape") {
      // Escape - close
      event.preventDefault();
      handleClose();
    }
    // Shift+Enter falls through and creates a new line normally
  };

  const removeImage = (id: string) => {
    removeComposeDraftImage(sessionKey, id);
  };

  const handleSend = async () => {
    if (isSendingRef.current) return;

    const initialDraft = useTerminalSessionStore.getState();
    if (
      initialDraft.getComposeDraftImages(sessionKey).length === 0 &&
      !initialDraft.getComposeDraftText(sessionKey).trim() &&
      pendingPasteCountRef.current === 0
    ) {
      return;
    }

    const sendLifecycle = pasteLifecycleRef.current;
    isSendingRef.current = true;
    setIsSending(true);
    try {
      // Include every paste queued before send began. New paste events are
      // ignored while sending, so clearing cannot race a late attachment.
      await pasteQueueRef.current;
      if (
        !isMountedRef.current ||
        pasteLifecycleRef.current !== sendLifecycle
      ) {
        return;
      }

      const currentDraft = useTerminalSessionStore.getState();
      const draftImages = currentDraft.getComposeDraftImages(sessionKey);
      const draftText = currentDraft.getComposeDraftText(sessionKey).trim();
      if (draftImages.length === 0 && !draftText) return;

      // Save images to container or local worktree and get file paths.
      // Note: We reuse the ImageAttachment type but repurpose the `id` field to store
      // the file path. This path is then written to the terminal by the caller.
      const savedImages: ImageAttachment[] = [];
      if (containerId || worktreePath) {
        for (const img of draftImages) {
          try {
            const filename = generateImageFilename();
            const filePath = `.orkestrator/clipboard/${filename}`;
            let fullPath: string;
            if (containerId) {
              await writeContainerFile(containerId, filePath, img.base64Data);
              fullPath = `/workspace/${filePath}`;
            } else {
              fullPath = await writeLocalFile(worktreePath!, filePath, img.base64Data);
            }
            savedImages.push({ ...img, id: fullPath });
          } catch (imgError) {
            console.error("[ComposeBar] Failed to save image:", imgError);
            // Continue with remaining images rather than failing entirely
          }
        }
      }

      if (
        !isMountedRef.current ||
        pasteLifecycleRef.current !== sendLifecycle
      ) {
        return;
      }

      // Only send if we have saved images or text
      if (savedImages.length > 0 || draftText) {
        onSend(savedImages, draftText);
      }
      pasteLifecycleRef.current += 1;
      clearComposeDraft(sessionKey);
    } catch (error) {
      console.error("[ComposeBar] Failed to send:", error);
    } finally {
      isSendingRef.current = false;
      if (isMountedRef.current) {
        setIsSending(false);
      }
    }
  };

  // Calculate textarea height based on content
  const textareaRows = Math.min(
    MAX_LINES,
    Math.max(1, text.split("\n").length)
  );

  if (!isOpen) return null;

  return (
    <div className="absolute bottom-2 left-2 right-2 z-50" data-compose-bar>
      {/* Image previews - floating above the input */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 pl-1">
          {images.map((img) => (
            <div
              key={img.id}
              className="relative group w-14 h-14 rounded-md overflow-hidden bg-card border border-[#52525b] shadow-lg cursor-pointer"
              onClick={() => setPreviewImage(img)}
            >
              <img
                src={img.dataUrl}
                alt="Attachment preview"
                className="w-full h-full object-cover"
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeImage(img.id);
                }}
                className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/80 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-2.5 h-2.5 text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Text input bar - matches sidebar color with lighter border, 60% opacity + blur */}
      <div
        className="flex items-end gap-2 rounded-lg px-3 py-2 border border-[#52525b] backdrop-blur-md"
        style={{ backgroundColor: "rgba(39, 39, 42, 0.6)" }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setComposeDraftText(sessionKey, e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message (newlines become spaces)..."
          rows={textareaRows}
          className={cn(
            "flex-1 bg-transparent border-none rounded px-2 py-1",
            "text-sm text-foreground placeholder:text-muted-foreground",
            "resize-none outline-none",
            "transition-colors"
          )}
          style={{
            minHeight: LINE_HEIGHT,
            maxHeight: MAX_LINES * LINE_HEIGHT,
          }}
          disabled={isSending}
        />
        {showAddressAll && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onAddressAll}
            disabled={isSending}
            className="shrink-0 h-7 rounded-full px-3 text-xs"
          >
            Address all
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="default"
          onClick={handleSend}
          disabled={
            isSending ||
            (pendingPasteCount === 0 && images.length === 0 && !text.trim())
          }
          className="shrink-0 h-7 w-7"
        >
          <Send className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img
              src={previewImage.dataUrl}
              alt="Full preview"
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-card border border-[#52525b] rounded-full flex items-center justify-center hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4 text-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export type { ImageAttachment };
