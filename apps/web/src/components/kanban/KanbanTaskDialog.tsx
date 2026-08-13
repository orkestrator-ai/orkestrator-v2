import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Trash2, Send, CheckCircle2, Hammer, ExternalLink, Loader2, Paperclip, ImageIcon, X } from "lucide-react";
import { toast } from "sonner";
import type { KanbanTask, KanbanStatus } from "@/stores/kanbanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useLocalEnvironmentAvailable } from "@/hooks/useLocalEnvironmentAvailable";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { useBuildLaunchOptions } from "@/hooks/useBuildLaunchOptions";
import {
  BuildLaunchDialog,
  type BuildLaunchSelection,
} from "@/components/build/BuildLaunchDialog";
import { readImage } from "@/lib/native/clipboard";
import { getKanbanImageData, openInBrowser } from "@/lib/backend";
import {
  composeDraftKey,
  discardComposeDraft,
  loadComposeDraft,
  persistComposeDraft,
} from "@/lib/compose-draft-persistence";
import { resizeCanvasIfNeeded } from "@/lib/canvas-utils";
import { createUuid } from "@/lib/uuid";
import { getPastedImageBlob } from "@/lib/clipboard-event";

const STATUS_LABELS: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

/** Max image file size in bytes (5 MB) */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Maximum raw RGBA buffer size (32MB - matches useClipboardImagePaste) */
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

/** Convert a File to base64 data string (without data URL prefix) */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (data:image/png;base64,...)
      const base64 = result.split(",")[1];
      if (base64) resolve(base64);
      else reject(new Error("Failed to convert file to base64"));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Pending image for create mode (before task exists) */
interface PendingImage {
  id: string;
  filename: string;
  data: string; // base64
  previewUrl: string; // data URL for display
}

interface KanbanCreateDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
  images: PendingImage[];
}

function isKanbanCreateDraft(value: unknown): value is KanbanCreateDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<KanbanCreateDraft>;
  return typeof candidate.title === "string"
    && typeof candidate.description === "string"
    && typeof candidate.acceptanceCriteria === "string"
    && Array.isArray(candidate.images)
    && candidate.images.every((image) =>
      image
      && typeof image.id === "string"
      && typeof image.filename === "string"
      && typeof image.data === "string"
      && typeof image.previewUrl === "string"
    );
}

/** Renders comment text with clickable URLs */
function CommentText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <button
            key={i}
            className="text-blue-400 hover:underline cursor-pointer inline"
            onClick={(e) => { e.preventDefault(); void openInBrowser(part); }}
          >
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

interface KanbanTaskDialogProps {
  task: KanbanTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, dialog opens in create mode for this project */
  createForProjectId?: string;
}

const TASK_DIALOG_CONTENT_CLASS = "sm:max-w-[560px] max-h-[85vh] overflow-hidden flex flex-col gap-0 p-0";
const TASK_DIALOG_BODY_CLASS = "min-h-0 flex-1";
const TASK_DIALOG_BODY_INNER_CLASS = "space-y-4 p-6";
const TASK_DIALOG_FOOTER_CLASS = "border-t border-border p-4 sm:p-6";

export function KanbanTaskDialog({ task, open, onOpenChange, createForProjectId }: KanbanTaskDialogProps) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);
  const addTaskStore = useKanbanStore((s) => s.addTask);
  const addComment = useKanbanStore((s) => s.addComment);
  const deleteComment = useKanbanStore((s) => s.deleteComment);
  const addImage = useKanbanStore((s) => s.addImage);
  const deleteImage = useKanbanStore((s) => s.deleteImage);

  const { startBuild, navigateToBuild } = useBuildPipeline();
  const getPipelineByTaskId = useBuildPipelineStore((s) => s.getPipelineByTaskId);
  const [isBuildStarting, setIsBuildStarting] = useState(false);
  const [buildDialogOpen, setBuildDialogOpen] = useState(false);
  const [createdTaskForBuild, setCreatedTaskForBuild] = useState<KanbanTask | null>(null);
  // Held rather than started immediately: a task that already owns an
  // environment asks for confirmation first, and the answer must not lose the
  // configuration the user just made.
  const [confirmBuildSelection, setConfirmBuildSelection] =
    useState<BuildLaunchSelection | null>(null);

  const isCreateMode = !!createForProjectId;
  const buildProjectId = createForProjectId ?? task?.projectId ?? "";
  const localEnvironmentAvailable = useLocalEnvironmentAvailable(buildProjectId);
  const {
    catalog: launchCatalog,
    defaults: launchDefaults,
  } = useBuildLaunchOptions(buildProjectId, open);

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAC, setEditAC] = useState("");
  const [commentText, setCommentText] = useState("");
  const [isEditingAC, setIsEditingAC] = useState(false);

  // Image state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const createDraftHydratedRef = useRef<string | null>(null);
  const createDraftEditRevisionRef = useRef(0);
  const createDraftClosingRef = useRef(false);
  const createDraftValuesRef = useRef<KanbanCreateDraft>({
    title: editTitle,
    description: editDescription,
    acceptanceCriteria: editAC,
    images: pendingImages,
  });
  createDraftValuesRef.current = {
    title: editTitle,
    description: editDescription,
    acceptanceCriteria: editAC,
    images: pendingImages,
  };
  const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
  const dialogContentRef = useRef<HTMLDivElement>(null);

  // Cache of loaded image data URLs keyed by image ID (for on-demand loading from disk)
  const [imageUrlCache, setImageUrlCache] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!createForProjectId || !open) return;
    let disposed = false;
    const draftKey = composeDraftKey("kanban-create", createForProjectId, "task");
    const revisionAtRequest = createDraftEditRevisionRef.current;
    createDraftClosingRef.current = false;
    createDraftHydratedRef.current = null;
    void loadComposeDraft<KanbanCreateDraft>(draftKey)
      .then((persisted) => {
        if (
          disposed
          || !persisted
          || !isKanbanCreateDraft(persisted.value)
          || createDraftEditRevisionRef.current !== revisionAtRequest
        ) {
          return;
        }
        setEditTitle(persisted.value.title);
        setEditDescription(persisted.value.description);
        setEditAC(persisted.value.acceptanceCriteria);
        setPendingImages(persisted.value.images);
      })
      .catch((error) => {
        console.warn("[KanbanTaskDialog] Failed to restore create draft:", error);
      })
      .finally(() => {
        if (!disposed) createDraftHydratedRef.current = draftKey;
      });
    return () => {
      disposed = true;
      if (createDraftHydratedRef.current === draftKey) {
        createDraftHydratedRef.current = null;
      }
      if (
        !createDraftClosingRef.current
        && createDraftEditRevisionRef.current !== revisionAtRequest
      ) {
        const latest = createDraftValuesRef.current;
        const empty = !latest.title && !latest.description
          && !latest.acceptanceCriteria && latest.images.length === 0;
        const operation = empty
          ? discardComposeDraft(draftKey)
          : persistComposeDraft(draftKey, "project", createForProjectId, latest);
        void operation.catch((error) => {
          console.warn("[KanbanTaskDialog] Failed to persist create draft during cleanup:", error);
        });
      }
    };
    // The local fields are intentionally sampled once. User input entered
    // during hydration wins over the backend snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createForProjectId, open]);

  useEffect(() => {
    if (!createForProjectId || !open) return;
    const draftKey = composeDraftKey("kanban-create", createForProjectId, "task");
    if (createDraftHydratedRef.current !== draftKey) return;
    const timer = setTimeout(() => {
      const draft: KanbanCreateDraft = {
        title: editTitle,
        description: editDescription,
        acceptanceCriteria: editAC,
        images: pendingImages,
      };
      const empty = !draft.title && !draft.description
        && !draft.acceptanceCriteria && draft.images.length === 0;
      const operation = empty
        ? discardComposeDraft(draftKey)
        : persistComposeDraft(
            draftKey,
            "project",
            createForProjectId,
            draft,
          );
      void operation.catch((error) => {
        console.warn("[KanbanTaskDialog] Failed to persist create draft:", error);
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [createForProjectId, editAC, editDescription, editTitle, open, pendingImages]);

  // Load image data on demand when dialog opens with a task that has images
  useEffect(() => {
    if (!open || !task || task.images.length === 0) return;

    const imageIds = task.images.map((img) => img.id);
    const missingIds = imageIds.filter((id) => !imageUrlCache[id]);
    if (missingIds.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missingIds.map(async (id) => {
        try {
          const base64 = await getKanbanImageData(id);
          if (!cancelled) {
            setImageUrlCache((prev) => ({ ...prev, [id]: `data:image/webp;base64,${base64}` }));
          }
        } catch {
          // Image file may have been deleted; ignore
        }
      })
    );
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- imageUrlCache intentionally excluded to avoid re-fetch loop
  }, [open, task]);

  // Reset create mode fields when dialog opens in create mode
  const handleOpenChange = (newOpen: boolean, discardDraft = true) => {
    if (!newOpen) {
      createDraftClosingRef.current = true;
      if (createForProjectId && discardDraft) {
        const draftKey = composeDraftKey("kanban-create", createForProjectId, "task");
        void discardComposeDraft(draftKey).catch((error) => {
          console.warn("[KanbanTaskDialog] Failed to discard create draft:", error);
        });
      }
      setEditTitle("");
      setEditDescription("");
      setEditAC("");
      setIsEditing(false);
      setIsEditingAC(false);
      setPendingImages([]);
      setCreatedTaskForBuild(null);
      setPreviewImage(null);
      setImageUrlCache({});
    }
    onOpenChange(newOpen);
  };

  // Process an image file (File object) into base64
  const processImageFile = useCallback(async (file: File): Promise<{ filename: string; data: string; previewUrl: string } | null> => {
    if (!file.type.startsWith("image/")) {
      toast.error("Only image files are supported");
      return null;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error("Image is too large (max 5 MB)");
      return null;
    }
    try {
      const data = await fileToBase64(file);
      const previewUrl = `data:${file.type};base64,${data}`;
      return { filename: file.name, data, previewUrl };
    } catch {
      toast.error("Failed to read image file");
      return null;
    }
  }, []);

  // Handle paste events for image attachment
  // Browser/iOS images come from the paste event; Electron's clipboard bridge
  // remains the fallback for native screenshots without an image MIME item.
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    // Only handle if focus is within this dialog
    const activeEl = document.activeElement;
    if (!activeEl || !dialogContentRef.current?.contains(activeEl)) return;

    // No early-return for text/plain clipboard — Electron screenshots may not
    // expose an image item, so the native bridge still needs to be attempted.
    try {
      const pastedBlob = getPastedImageBlob(e);
      if (pastedBlob) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      const image = await readImage(pastedBlob);
      const rgba = await image.rgba();
      const { width, height } = await image.size();

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
      const base64Data = dataUrl.split(",")[1];
      canvas.width = 0;
      canvas.height = 0;

      if (!base64Data) return;

      // Validate size
      const estimatedSize = (base64Data.length * 3) / 4;
      if (estimatedSize > MAX_IMAGE_SIZE) {
        toast.error("Image is too large (max 5 MB)");
        return;
      }

      if (!pastedBlob) {
        e.preventDefault();
        // stopImmediatePropagation prevents other document-level capture handlers
        // (compose bars) from also calling readImage() for the same event.
        e.stopImmediatePropagation();
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `clipboard-${timestamp}.png`;

      if (isCreateMode || !task) {
        createDraftEditRevisionRef.current += 1;
        setPendingImages((prev) => [...prev, { id: createUuid(), filename, data: base64Data, previewUrl: dataUrl }]);
      } else {
        void addImage(task.id, filename, base64Data);
      }
      toast.success("Image pasted");
    } catch {
      // No image on clipboard — let the event propagate for text paste
    }
  }, [isCreateMode, task, addImage]);

  // Register paste listener at document level with capture phase
  // (matches the pattern used by compose bars for reliable native clipboard access)
  useEffect(() => {
    if (!open) return;

    const listener = (e: Event) => { void handlePaste(e as ClipboardEvent); };
    document.addEventListener("paste", listener, { capture: true });
    return () => document.removeEventListener("paste", listener, { capture: true });
  }, [open, handlePaste]);

  // Hidden file input ref for attaching images
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle file picker for attaching images
  const handleAttachImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Process files selected from the file input
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    let attached = 0;
    for (const file of files) {
      const result = await processImageFile(file);
      if (!result) continue;

      if (isCreateMode || !task) {
        createDraftEditRevisionRef.current += 1;
        setPendingImages((prev) => [...prev, { id: createUuid(), ...result }]);
      } else {
        void addImage(task.id, result.filename, result.data);
      }
      attached++;
    }

    if (attached > 0) {
      toast.success(`Image${attached > 1 ? "s" : ""} attached`);
    }

    // Reset file input so the same file can be re-selected
    e.target.value = "";
  }, [isCreateMode, task, addImage, processImageFile]);

  // Hidden file input for image attachment (shared across create and edit modes)
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml"
      multiple
      className="hidden"
      onChange={handleFileInputChange}
    />
  );

  if (!task && !isCreateMode) return null;

  const handleStartEdit = () => {
    if (task) {
      setEditTitle(task.title);
      setEditDescription(task.description);
    }
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editTitle.trim() && task) {
      void updateTask(task.id, { title: editTitle.trim(), description: editDescription.trim() });
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleCreate = () => {
    if (editTitle.trim() && createForProjectId) {
      const title = editTitle.trim();
      const description = editDescription.trim();
      const ac = editAC.trim();
      const imagesToSave = [...pendingImages];
      const draftKey = composeDraftKey("kanban-create", createForProjectId, "task");
      void persistComposeDraft(
        draftKey,
        "project",
        createForProjectId,
        {
          title: editTitle,
          description: editDescription,
          acceptanceCriteria: editAC,
          images: imagesToSave,
        } satisfies KanbanCreateDraft,
      ).catch((error) => {
        console.warn("[KanbanTaskDialog] Failed to preserve create draft:", error);
      });
      handleOpenChange(false, false);
      void addTaskStore(createForProjectId, title, description).then(async (newTaskId) => {
        if (!newTaskId) return;
        void discardComposeDraft(draftKey).catch((error) => {
          console.warn("[KanbanTaskDialog] Failed to discard created task draft:", error);
        });
        if (ac) {
          void updateTask(newTaskId, { acceptanceCriteria: ac });
        }
        // Save pending images to the newly created task
        const results = await Promise.allSettled(imagesToSave.map((img) => addImage(newTaskId, img.filename, img.data)));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          toast.error(`Failed to save ${failed} image${failed > 1 ? "s" : ""}`);
        }
      });
    }
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreate();
    }
  };

  const handleStartEditAC = () => {
    if (task) {
      setEditAC(task.acceptanceCriteria);
    }
    setIsEditingAC(true);
  };

  const handleSaveAC = () => {
    if (task) {
      void updateTask(task.id, { acceptanceCriteria: editAC.trim() });
    }
    setIsEditingAC(false);
  };

  const handleCancelAC = () => {
    setIsEditingAC(false);
  };

  const handleDelete = () => {
    if (task) {
      void deleteTask(task.id);
    }
    handleOpenChange(false);
  };

  const handleAddComment = () => {
    if (commentText.trim() && task) {
      void addComment(task.id, commentText.trim());
      setCommentText("");
    }
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  };

  const handleStartBuild = async (selection: BuildLaunchSelection) => {
    if (!task) return;
    setIsBuildStarting(true);
    try {
      const pipelineId = await startBuild(task, selection.environmentType, selection.steps.build.agent, {
        steps: selection.steps,
      });
      if (!pipelineId) return;
      handleOpenChange(false);
    } catch (error) {
      // Both call sites are `void`-ed click handlers, so an escaping rejection
      // would surface as an unhandled one with nothing to attach it to. The
      // hook reports its own failures; this only covers a throw it did not.
      console.error("[KanbanTaskDialog] Failed to start build:", error);
      toast.error("Failed to start build");
    } finally {
      setIsBuildStarting(false);
    }
  };

  /** Confirms first when the task already owns an environment. */
  const handleBuildConfirmed = (selection: BuildLaunchSelection) => {
    setBuildDialogOpen(false);
    if (task?.environmentId) {
      setConfirmBuildSelection(selection);
      return;
    }
    void handleStartBuild(selection);
  };

  const handleCreateAndBuild = async (selection: BuildLaunchSelection) => {
    if (!editTitle.trim() || !createForProjectId) return;
    setBuildDialogOpen(false);

    const title = editTitle.trim();
    const description = editDescription.trim();
    const ac = editAC.trim();
    const imagesToSave = [...pendingImages];

    setIsBuildStarting(true);
    try {
      let newTask = createdTaskForBuild;
      if (!newTask) {
        const newTaskId = await addTaskStore(createForProjectId, title, description);
        if (!newTaskId) {
          toast.error("Failed to create task");
          return;
        }

        if (ac) {
          try {
            await updateTask(newTaskId, { acceptanceCriteria: ac });
          } catch {
            toast.error("Task created but acceptance criteria could not be saved");
          }
        }

        // Save pending images in parallel. A failed attachment should be visible
        // to the user but does not make the already-created task unusable.
        const imageResults = await Promise.allSettled(
          imagesToSave.map((img) => addImage(newTaskId, img.filename, img.data)),
        );
        const failedImages = imageResults.filter((result) => result.status === "rejected").length;
        if (failedImages > 0) {
          toast.error(
            `Failed to save ${failedImages} image${failedImages > 1 ? "s" : ""}`,
          );
        }

        newTask = useKanbanStore.getState().tasks.find((candidate) => candidate.id === newTaskId) ?? null;
        if (!newTask) {
          toast.error("Task created but could not start build");
          handleOpenChange(false);
          return;
        }
        setCreatedTaskForBuild(newTask);
      }

      const pipelineId = await startBuild(
        newTask,
        selection.environmentType,
        selection.steps.build.agent,
        { steps: selection.steps },
      );
      if (!pipelineId) return;
      handleOpenChange(false);
    } catch (error) {
      // `addTaskStore`, `addImage` and `startBuild` are all awaited from a
      // `void`-ed click handler; without this an escaping rejection would go
      // unhandled and the user would see the dialog stall with no explanation.
      console.error("[KanbanTaskDialog] Failed to create task and build:", error);
      toast.error("Failed to create task and start build");
    } finally {
      setIsBuildStarting(false);
    }
  };

  // Images to display (from task or pending)
  const displayImages = task ? task.images : [];
  const allImages = isCreateMode ? pendingImages : displayImages;

  // Image thumbnails component — show in create mode always, in edit mode only when images exist
  const renderImageSection = () => {
    if (!isCreateMode && allImages.length === 0) return null;

    return (
      <>
        <Separator />
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Images ({allImages.length})</h4>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 ml-auto"
              onClick={() => void handleAttachImage()}
              title="Attach image"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          </div>
          {allImages.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No images attached. Paste or click the attach button.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {allImages.map((img) => {
                const previewUrl = "previewUrl" in img
                  ? (img as PendingImage).previewUrl
                  : imageUrlCache[img.id];
                if (!previewUrl) {
                  // Still loading from disk
                  return (
                    <div
                      key={img.id}
                      className="rounded-md border border-border overflow-hidden flex items-center justify-center bg-muted/30"
                      style={{ width: 80, height: 80 }}
                    >
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  );
                }
                return (
                  <div
                    key={img.id}
                    className="group/img relative rounded-md border border-border overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                    style={{ width: 80, height: 80 }}
                    onClick={() => setPreviewImage({ url: previewUrl, filename: img.filename })}
                  >
                    <img
                      src={previewUrl}
                      alt={img.filename}
                      className="w-full h-full object-cover"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-0 right-0 h-5 w-5 bg-background/80 opacity-0 group-hover/img:opacity-100 transition-opacity rounded-none rounded-bl-md"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isCreateMode) {
                          createDraftEditRevisionRef.current += 1;
                          setPendingImages((prev) => prev.filter((i) => i.id !== img.id));
                        } else if (task) {
                          void deleteImage(task.id, img.id);
                        }
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                    <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 py-0.5 text-[9px] text-muted-foreground truncate opacity-0 group-hover/img:opacity-100 transition-opacity">
                      {img.filename}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>
    );
  };

  // Fullscreen image preview dialog
  const renderPreviewDialog = () => {
    if (!previewImage) return null;
    return (
      <Dialog open={!!previewImage} onOpenChange={(open) => { if (!open) setPreviewImage(null); }}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 flex flex-col items-center justify-center">
          <DialogTitle className="sr-only">{previewImage.filename}</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size preview of the attached task image.
          </DialogDescription>
          <div className="text-xs text-muted-foreground mb-1">{previewImage.filename}</div>
          <img
            src={previewImage.url}
            alt={previewImage.filename}
            className="max-w-full max-h-[80vh] object-contain rounded"
          />
        </DialogContent>
      </Dialog>
    );
  };

  if (isCreateMode) {
    return (
      <>
        {fileInput}
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent
            ref={dialogContentRef}
            className={TASK_DIALOG_CONTENT_CLASS}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <ScrollArea className={TASK_DIALOG_BODY_CLASS}>
              <div className={TASK_DIALOG_BODY_INNER_CLASS}>
                <DialogHeader>
                  <DialogDescription className="sr-only">
                    Create a Kanban task with optional acceptance criteria and images.
                  </DialogDescription>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                      Backlog
                    </span>
                  </div>
                  <div className="space-y-2 pt-1">
                    <DialogTitle className="sr-only">New Task</DialogTitle>
                    <Input
                      value={editTitle}
                      onChange={(e) => {
                        createDraftEditRevisionRef.current += 1;
                        setEditTitle(e.target.value);
                      }}
                      onKeyDown={handleCreateKeyDown}
                      placeholder="Task title..."
                      className="text-lg font-semibold"
                      autoFocus
                    />
                    <Textarea
                      value={editDescription}
                      onChange={(e) => {
                        createDraftEditRevisionRef.current += 1;
                        setEditDescription(e.target.value);
                      }}
                      placeholder="Description..."
                      rows={3}
                      className="max-h-[calc(10lh+1rem)] overflow-y-auto"
                    />
                  </div>
                </DialogHeader>

                <Separator />

                {/* Acceptance Criteria */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    <h4 className="text-sm font-medium">Acceptance Criteria</h4>
                  </div>
                  <Textarea
                    value={editAC}
                    onChange={(e) => {
                      createDraftEditRevisionRef.current += 1;
                      setEditAC(e.target.value);
                    }}
                    placeholder="Define what 'done' looks like..."
                    rows={4}
                    className="max-h-[calc(10lh+1rem)] overflow-y-auto"
                  />
                </div>

                {/* Images */}
                {renderImageSection()}
              </div>
            </ScrollArea>

            {/* Create Actions */}
            <div className={`flex flex-wrap gap-2 ${TASK_DIALOG_FOOTER_CLASS}`}>
              <Button size="sm" onClick={handleCreate} disabled={!editTitle.trim() || isBuildStarting}>
                Create Task
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={!editTitle.trim() || isBuildStarting}
                onClick={() => setBuildDialogOpen(true)}
              >
                {isBuildStarting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Hammer className="h-3.5 w-3.5" />
                )}
                Build…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <BuildLaunchDialog
          open={buildDialogOpen}
          onOpenChange={setBuildDialogOpen}
          catalog={launchCatalog}
          busy={isBuildStarting}
          localEnvironmentAvailable={localEnvironmentAvailable}
          {...launchDefaults}
          onConfirm={(selection) => void handleCreateAndBuild(selection)}
        />
        {renderPreviewDialog()}
      </>
    );
  }

  if (!task) return null;

  return (
    <>
      {fileInput}
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent
            ref={dialogContentRef}
            className={TASK_DIALOG_CONTENT_CLASS}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <ScrollArea className={TASK_DIALOG_BODY_CLASS}>
              <div className={TASK_DIALOG_BODY_INNER_CLASS}>
                <DialogHeader>
                  <DialogDescription className="sr-only">
                    View and edit task details, build actions, images, and comments.
                  </DialogDescription>
                  <div className="flex items-center justify-between pr-6">
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                        {STATUS_LABELS[task.status]}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={handleDelete}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {isEditing ? (
                    <div className="space-y-2 pt-1">
                      <Input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="text-lg font-semibold"
                        autoFocus
                      />
                      <Textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        placeholder="Description..."
                        rows={3}
                        className="max-h-[calc(10lh+1rem)] overflow-y-auto"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={handleCancelEdit}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="cursor-pointer" onClick={handleStartEdit}>
                      <DialogTitle className="text-lg">{task.title}</DialogTitle>
                      {task.description ? (
                        <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
                          {task.description}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-muted-foreground/50 italic">
                          Click to add a description...
                        </p>
                      )}
                    </div>
                  )}
                </DialogHeader>

                <Separator />

                {/* Acceptance Criteria */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    <h4 className="text-sm font-medium">Acceptance Criteria</h4>
                  </div>
                  {isEditingAC ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editAC}
                        onChange={(e) => setEditAC(e.target.value)}
                        placeholder="Define what 'done' looks like..."
                        rows={4}
                        className="max-h-[calc(10lh+1rem)] overflow-y-auto"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSaveAC}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={handleCancelAC}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="cursor-pointer rounded-md border border-border/50 p-2.5 hover:border-border transition-colors min-h-[40px]"
                      onClick={handleStartEditAC}
                    >
                      {task.acceptanceCriteria ? (
                        <p className="text-sm text-foreground whitespace-pre-wrap">
                          {task.acceptanceCriteria}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground/50 italic">
                          Click to add acceptance criteria...
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Images */}
                {renderImageSection()}

                <Separator />

                {/* Build Actions */}
                {(() => {
                  const existingPipeline = getPipelineByTaskId(task.id);
                  const hasActiveBuild = existingPipeline && !["complete", "failed"].includes(existingPipeline.phase);

                  return (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 flex-1"
                          disabled={isBuildStarting || !!hasActiveBuild}
                          onClick={() => setBuildDialogOpen(true)}
                        >
                          {isBuildStarting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Hammer className="h-3.5 w-3.5" />
                          )}
                          Build…
                        </Button>
                        {task.environmentId && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={() => {
                              navigateToBuild(task);
                              handleOpenChange(false);
                            }}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            View Build
                            {existingPipeline && (
                              <span className="text-xs text-muted-foreground ml-1">
                                ({existingPipeline.phase})
                              </span>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })()}

                <Separator />

                {/* Comments */}
                <div className="flex-1 min-h-0">
                  <h4 className="text-sm font-medium mb-2">Comments ({task.comments.length})</h4>
                  <ScrollArea className="max-h-[200px]">
                    <div className="space-y-3 pr-3">
                      {task.comments.length === 0 && (
                        <p className="text-xs text-muted-foreground italic">No comments yet</p>
                      )}
                      {task.comments.map((comment) => (
                        <div
                          key={comment.id}
                          className="group/comment rounded-md bg-muted/50 p-2.5 text-sm"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="whitespace-pre-wrap text-foreground flex-1"><CommentText text={comment.text} /></p>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 shrink-0 opacity-0 group-hover/comment:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                              onClick={() => void deleteComment(task.id, comment.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <span className="text-[10px] text-muted-foreground mt-1 block">
                            {new Date(comment.createdAt).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </ScrollArea>

          {/* Add Comment */}
          <div className={`flex items-center gap-2 ${TASK_DIALOG_FOOTER_CLASS}`}>
            <Input
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              placeholder="Add a comment..."
              className="flex-1"
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={handleAddComment}
              disabled={!commentText.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </DialogContent>

        <AlertDialog
          open={!!confirmBuildSelection}
          onOpenChange={(open) => { if (!open) setConfirmBuildSelection(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Environment Already Exists</AlertDialogTitle>
              <AlertDialogDescription>
                This task already has an environment linked to it. Starting a new build will create an additional environment.
                <span className="block mt-2">
                  Are you sure you want to start a new{" "}
                  <strong>
                    {confirmBuildSelection?.environmentType === "containerized"
                      ? "container"
                      : "local"}
                  </strong> build?
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmBuildSelection) {
                    void handleStartBuild(confirmBuildSelection);
                  }
                  setConfirmBuildSelection(null);
                }}
              >
                Start Build
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Dialog>
      <BuildLaunchDialog
        open={buildDialogOpen}
        onOpenChange={setBuildDialogOpen}
        catalog={launchCatalog}
        busy={isBuildStarting}
        localEnvironmentAvailable={localEnvironmentAvailable}
        {...launchDefaults}
        onConfirm={handleBuildConfirmed}
      />
      {renderPreviewDialog()}
    </>
  );
}
