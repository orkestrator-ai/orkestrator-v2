import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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

/**
 * Attaches clipboard images pasted while focus is inside `containerRef`.
 * Text pastes are left to the field. `enabled` is false while the environment
 * cannot receive files (for example, a stopped container).
 */
export function useDesignPromptImagePaste({
  containerRef,
  environmentId,
  scopeKey = environmentId,
  enabled,
  images,
  onImagesChange,
}: {
  containerRef: RefObject<HTMLElement | null>;
  environmentId: string;
  scopeKey?: string;
  enabled: boolean;
  images: readonly DesignPromptImage[];
  onImagesChange: (images: DesignPromptImage[]) => void;
}) {
  const environment = useEnvironmentStore((state) =>
    state.environments.find((candidate) => candidate.id === environmentId),
  );
  const containerId =
    environment?.containerId && environment.status === "running" ? environment.containerId : null;
  const worktreePath = containerId ? undefined : environment?.worktreePath;
  const writable = enabled && Boolean(containerId || worktreePath);

  // Each destination owns its reservations. Old writes may finish, but cannot
  // append to a replacement scope or alter its pending count.
  const operationScope = useMemo(
    () => ({
      scopeKey,
      environmentId,
      containerId,
      worktreePath,
      pending: 0,
      submitting: false,
      active: true,
    }),
    [scopeKey, environmentId, containerId, worktreePath],
  );
  const currentScope = useRef(operationScope);
  currentScope.current = operationScope;
  const [, refresh] = useState(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const enabledRef = useRef(writable);
  enabledRef.current = writable;
  const onChangeRef = useRef(onImagesChange);
  onChangeRef.current = onImagesChange;
  const previousScope = useRef(operationScope);
  useEffect(() => {
    operationScope.active = true;
    if (previousScope.current !== operationScope) {
      previousScope.current = operationScope;
      imagesRef.current = [];
      onChangeRef.current([]);
    }
    return () => {
      operationScope.active = false;
    };
  }, [operationScope]);

  const beginPaste = useCallback(
    (knownImage: boolean) => {
      if (operationScope.submitting) return false;
      const writableAtStart = enabledRef.current;
      const hasSlot = imagesRef.current.length + operationScope.pending < DESIGN_PROMPT_IMAGE_LIMIT;
      const canAttachImage = () => {
        if (!writableAtStart) {
          toast.error("Start this environment to attach images");
          return false;
        }
        if (!hasSlot) {
          toast.error("Too many images", {
            description: `Up to ${DESIGN_PROMPT_IMAGE_LIMIT} images can be attached.`,
          });
          return false;
        }
        return true;
      };
      // Native clipboard probes can represent text. Delay their rejection until
      // decoding proves they are images, so ordinary text has no error toast.
      if (knownImage && !canAttachImage()) return false;
      operationScope.pending += 1;
      refresh((revision) => revision + 1);
      const isCurrent = () => operationScope.active && currentScope.current === operationScope;
      return {
        isCurrent,
        canAttachImage,
        finish: () => {
          operationScope.pending -= 1;
          if (isCurrent()) refresh((revision) => revision + 1);
        },
      };
    },
    [operationScope],
  );
  const onAttach = useCallback((attachment: PastedImageAttachment) => {
    const next = [...imagesRef.current, attachment];
    imagesRef.current = next;
    onChangeRef.current(next);
  }, []);

  useNativeComposeBarPaste({
    inputContainerRef: containerRef,
    containerId,
    worktreePath,
    beginPaste,
    onAttach,
    logLabel: "DesignPromptImages",
  });

  return {
    isPasting: operationScope.pending > 0,
    // The synchronous guard also covers paste and click in the same event turn.
    tryBeginSubmission: () => {
      if (operationScope.pending > 0 || operationScope.submitting) return false;
      operationScope.submitting = true;
      return true;
    },
    endSubmission: () => {
      operationScope.submitting = false;
    },
  };
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
            className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 shadow-sm"
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
