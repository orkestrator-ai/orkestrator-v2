import { useCallback, useRef, type RefObject } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceAttachment } from "@/components/chat/NativeAttachmentMenu";
import {
  useNativeComposeBarPaste,
  type PastedImageAttachment,
} from "@/hooks/useNativeComposeBarPaste";
import { MAX_PROMPT_ATTACHMENTS } from "@/lib/chat/workspace-attachments";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";

/**
 * Images pasted into a design prompt (the New design brief or the Ask agent
 * note). They are written into the environment like a composer paste, so the
 * agent receives them as ordinary prompt attachments by path.
 */
export type DesignPromptImage = WorkspaceAttachment & { type: "image" };

export const DESIGN_PROMPT_IMAGE_LIMIT = MAX_PROMPT_ATTACHMENTS;

/**
 * Adds images to a conversation's unsent draft. Returns false, changing
 * nothing, when the draft would exceed the per-prompt attachment limit.
 */
export function addDesignImagesToDraft(
  sessionKey: string,
  images: readonly DesignPromptImage[],
): boolean {
  if (images.length === 0) return true;
  const store = useNativeComposeStore.getState();
  const current = nativeComposeDraft(store, sessionKey).attachments;
  const known = new Set(current.map((attachment) => attachment.path));
  const added = images.filter((image) => !known.has(image.path));
  if (current.length + added.length > MAX_PROMPT_ATTACHMENTS) return false;
  if (added.length > 0) store.updateDraft(sessionKey, { attachments: [...current, ...added] });
  return true;
}

type PasteRejection = "unavailable" | "limit";

/**
 * Attaches clipboard images pasted while focus is inside `containerRef`.
 * Text pastes are left to the field. `enabled` is false while the environment
 * cannot receive files (for example, a stopped container).
 */
export function useDesignPromptImagePaste({
  containerRef,
  environmentId,
  enabled,
  images,
  onImagesChange,
}: {
  containerRef: RefObject<HTMLElement | null>;
  environmentId: string;
  enabled: boolean;
  images: readonly DesignPromptImage[];
  onImagesChange: (images: DesignPromptImage[]) => void;
}): void {
  const environment = useEnvironmentStore((state) =>
    state.environments.find((candidate) => candidate.id === environmentId),
  );
  const containerId =
    environment?.containerId && environment.status === "running" ? environment.containerId : null;
  const worktreePath = containerId ? undefined : environment?.worktreePath;
  const writable = enabled && Boolean(containerId || worktreePath);

  // Several pastes can resolve before React re-renders; count against the
  // latest list rather than the rendered one.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const rejection = useRef<PasteRejection>("unavailable");

  const canAttachImage = useCallback(() => {
    if (!writable) {
      rejection.current = "unavailable";
      return false;
    }
    if (imagesRef.current.length >= DESIGN_PROMPT_IMAGE_LIMIT) {
      rejection.current = "limit";
      return false;
    }
    return true;
  }, [writable]);
  const onImageRejected = useCallback(() => {
    if (rejection.current === "limit")
      toast.error("Too many images", {
        description: `Up to ${DESIGN_PROMPT_IMAGE_LIMIT} images can be attached.`,
      });
    else toast.error("Start this environment to attach images");
  }, []);
  const onAttach = useCallback(
    (attachment: PastedImageAttachment) => {
      const next = [...imagesRef.current, attachment];
      imagesRef.current = next;
      onImagesChange(next);
    },
    [onImagesChange],
  );

  useNativeComposeBarPaste({
    inputContainerRef: containerRef,
    containerId,
    worktreePath,
    onAttach,
    canAttachImage,
    onImageRejected,
    logLabel: "DesignPromptImages",
  });
}

/** Thumbnails of the images attached to a design prompt. */
export function DesignPromptImages({
  images,
  disabled,
  onRemove,
}: {
  images: readonly DesignPromptImage[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}) {
  if (images.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Attached images">
      {images.map((image) => (
        <li
          key={image.id}
          className="group relative h-14 w-14 overflow-hidden rounded-md border border-border bg-muted"
        >
          {image.previewUrl ? (
            <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(image.id)}
            disabled={disabled}
            className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Remove ${image.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export const DESIGN_PROMPT_IMAGE_HINT = "Paste an image to attach it.";
