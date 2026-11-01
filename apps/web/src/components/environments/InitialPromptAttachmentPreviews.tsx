import { useState } from "react";
import { FileText, X } from "lucide-react";
import { MediaGalleryDialog } from "@/components/chat/rich/MediaGallery";
import type { GalleryItem } from "@/lib/chat/rich-markdown/media-gallery-registry";
import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";
import { cn } from "@/lib/utils";

/**
 * Thumbnails for the attachments staged in the new environment dialog. An
 * image thumbnail opens the shared image viewer, which pages through every
 * staged image; file chips only show their name.
 */
export function InitialPromptAttachmentPreviews({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: InitialPromptImageAttachment[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const [gallery, setGallery] = useState<{
    items: GalleryItem[];
    index: number;
    initialSource: string;
  } | null>(null);

  if (attachments.length === 0) return null;

  const openImagePreview = (attachmentId: string) => {
    const images = attachments.filter(
      (attachment) => attachment.type !== "file" && attachment.previewUrl,
    );
    const index = images.findIndex((image) => image.id === attachmentId);
    const initialSource = images[index]?.previewUrl;
    if (!initialSource) return;
    setGallery({
      items: images.map((image) => ({
        title: image.name,
        element: () => null,
        load: () => Promise.resolve(image.previewUrl ?? null),
      })),
      index,
      initialSource,
    });
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className={cn(
              "group relative h-16 overflow-hidden rounded-md border border-border bg-muted",
              attachment.type === "file" ? "flex w-40 items-center gap-2 px-2" : "w-16",
            )}
          >
            {attachment.type === "file" ? (
              <>
                <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate pr-4 text-xs" title={attachment.name}>
                  {attachment.name}
                </span>
              </>
            ) : attachment.previewUrl ? (
              <button
                type="button"
                onClick={() => openImagePreview(attachment.id)}
                className="block h-full w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                aria-label={`Preview ${attachment.name}`}
                title={attachment.name}
              >
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-full w-full object-cover"
                />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              disabled={disabled}
              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              aria-label={`Remove ${attachment.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      {gallery ? (
        <MediaGalleryDialog
          open
          items={gallery.items}
          initialIndex={gallery.index}
          initialSource={gallery.initialSource}
          onOpenChange={(open) => {
            if (!open) setGallery(null);
          }}
        />
      ) : null}
    </>
  );
}
