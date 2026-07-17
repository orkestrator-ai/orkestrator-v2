import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { X, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readImage } from "@/lib/native/clipboard";
import { writeContainerFile, writeLocalFile } from "@/lib/backend";
import { resizeCanvasIfNeeded } from "@/lib/canvas-utils";
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
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when bar opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  // Handle paste events when compose bar is open
  const handlePaste = useCallback(async (event: ClipboardEvent) => {
    if (!isOpen) return;

    // Only handle paste if THIS compose bar's textarea has focus
    if (document.activeElement !== textareaRef.current) return;

    const pastedBlob = getPastedImageBlob(event);
    if (pastedBlob) {
      event.preventDefault();
      event.stopPropagation();
    }

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
      if (!ctx) return;

      const imageDataObj = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imageDataObj, 0, 0);

      // Resize if needed to fit within RGBA size limit
      canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

      const dataUrl = canvas.toDataURL("image/png");
      const base64Data = dataUrl.split(",")[1] || "";

      // Check final PNG size
      const estimatedSize = (base64Data.length * 3) / 4;
      if (estimatedSize > MAX_IMAGE_SIZE) {
        console.error("[ComposeBar] Image too large after encoding");
        toast.error("Image too large", {
          description: `Image is ${(estimatedSize / 1024 / 1024).toFixed(1)}MB. Maximum is 8MB.`,
        });
        return;
      }

      // Store final dimensions before cleanup
      const finalWidth = canvas.width;
      const finalHeight = canvas.height;

      // Release canvas memory
      canvas.width = 0;
      canvas.height = 0;

      // Prevent default behavior when we have an image
      if (!pastedBlob) {
        event.preventDefault();
        event.stopPropagation();
      }

      // Add to images - use final canvas dimensions after potential resize
      const newImage: ImageAttachment = {
        id: Math.random().toString(36).substring(2, 9),
        dataUrl,
        base64Data,
        width: finalWidth,
        height: finalHeight,
      };
      appendComposeDraftImage(sessionKey, newImage);
    } catch {
      // No image in clipboard - this is expected when pasting text.
      // Let the paste event propagate to native text handling.
    }
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

  // Handle keyboard events in textarea
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isMeta = event.metaKey;
    const isCtrl = event.ctrlKey;

    // Cmd+I / Ctrl+I - close compose bar
    if ((isMeta || isCtrl) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      // Enter without shift - send
      event.preventDefault();
      handleSend();
    } else if (event.key === "Escape") {
      // Escape - close
      event.preventDefault();
      onClose();
    }
    // Shift+Enter falls through and creates a new line normally
  };

  const removeImage = (id: string) => {
    removeComposeDraftImage(sessionKey, id);
  };

  const handleSend = async () => {
    if (isSending) return;
    if (images.length === 0 && !text.trim()) return;

    setIsSending(true);
    try {
      // Save images to container or local worktree and get file paths.
      // Note: We reuse the ImageAttachment type but repurpose the `id` field to store
      // the file path. This path is then written to the terminal by the caller.
      const savedImages: ImageAttachment[] = [];
      if (containerId || worktreePath) {
        for (const img of images) {
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

      // Only send if we have saved images or text
      if (savedImages.length > 0 || text.trim()) {
        onSend(savedImages, text.trim());
      }
      clearComposeDraft(sessionKey);
    } catch (error) {
      console.error("[ComposeBar] Failed to send:", error);
    } finally {
      setIsSending(false);
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
          disabled={isSending || (images.length === 0 && !text.trim())}
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
