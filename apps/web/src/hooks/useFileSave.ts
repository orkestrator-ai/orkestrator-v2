import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { writeText } from "@/lib/native/clipboard";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useNodeScope, useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fileContentSha256,
  isFileWriteConflict,
  isEditorFileMissing,
  type FileWritePrecondition,
} from "@orkestrator/protocol/file-write-precondition";
import { useFileDirtyStore } from "@/stores";
import { fileDirtyStore, fileSaveBaseline, fileSaveConflict } from "@/stores/fileDirtyStore";

const log = createLogger("web.files");

interface UseFileSaveOptions {
  tabId: string;
  filePath: string;
  containerId?: string;
  worktreePath?: string;
  isLocalEnvironment: boolean;
  /**
   * Replace the buffer with the file as it is on disk ("use theirs"). Offered
   * when a save is refused because the file changed since it was loaded.
   */
  onReloadFromDisk?: () => void;
  /** Show the conflict's side-by-side comparison. */
  onCompare?: () => void;
  flushEditor?: () => void;
  canSave?: () => boolean;
}

export type SaveFile = (contentOverride?: string) => Promise<boolean>;

export interface FileSaveControls {
  /** Save, refused (and turned into a conflict) if disk moved meanwhile. */
  saveFile: SaveFile;
  /**
   * Resolve a conflict by writing the buffer over the newer version the user
   * was shown. Still conditional on that version: a further change on disk is
   * a fresh conflict, never overwritten unseen. The replaced version stays
   * restorable into the buffer from the confirmation toast.
   */
  keepMine: (shownDisk?: string) => Promise<boolean>;
  recreate: () => Promise<boolean>;
  isSaving: boolean;
  isSavingNow: () => boolean;
}

type SaveMode = "checked" | "keep-mine" | "recreate";

function encodeUtf8AsBase64(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  const chunkSize = 8192;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  return btoa(binary);
}

export function fileWriteConflictToastId(tabId: string): string {
  return `file-write-conflict:${tabId}`;
}

export function fileConflictResolvedToastId(tabId: string): string {
  return `file-write-conflict-resolved:${tabId}`;
}

/** Keep the recovery snapshot available when its original buffer has moved on. */
export function offerRecoveryCopy(tabId: string, content: string): void {
  toast.info("The editor has changed", {
    id: fileConflictResolvedToastId(tabId),
    description: "Your current edits are still in the editor. You can copy the earlier version.",
    duration: 30_000,
    action: {
      label: "Copy earlier version",
      onClick: () => {
        void (async () => {
          try {
            await writeText(content);
          } catch {
            toast.error("Could not copy the earlier version");
            offerRecoveryCopy(tabId, content);
          }
        })();
      },
    },
  });
}

export function useFileSave({
  tabId,
  filePath,
  containerId,
  worktreePath,
  isLocalEnvironment,
  onReloadFromDisk,
  onCompare,
  flushEditor,
  canSave,
}: UseFileSaveOptions): FileSaveControls {
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const isSavingNow = useCallback(() => savingRef.current, []);
  const mountedRef = useRef(true);
  const getContent = useFileDirtyStore((state) => state.getContent);
  const setContent = useFileDirtyStore((state) => state.setContent);
  const setOriginalContent = useFileDirtyStore((state) => state.setOriginalContent);
  const dirtyFiles = useNodeScope().store(fileDirtyStore);
  const onReloadRef = useRef(onReloadFromDisk);
  const onCompareRef = useRef(onCompare);
  const flushEditorRef = useRef(flushEditor);
  // The conflict toast's buttons outlive the render that showed them.
  const saveRef = useRef<(content: string | undefined, mode: SaveMode) => Promise<boolean>>(
    async () => false,
  );

  useEffect(() => {
    onReloadRef.current = onReloadFromDisk;
    onCompareRef.current = onCompare;
    flushEditorRef.current = flushEditor;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = useCallback(
    async (
      contentOverride: string | undefined,
      mode: SaveMode,
      shownDisk?: string,
    ): Promise<boolean> => {
      if (savingRef.current || canSave?.() === false) return false;

      if (isLocalEnvironment && !worktreePath) {
        toast.error("Cannot save file", {
          description: "No worktree path available",
        });
        return false;
      }

      if (!isLocalEnvironment && !containerId) {
        toast.error("Cannot save file", {
          description: "No container ID available",
        });
        return false;
      }

      if (contentOverride === undefined) flushEditorRef.current?.();
      const contentToSave = contentOverride ?? getContent(tabId);
      if (contentToSave === null) return false;

      // Keep the dirty store authoritative even if a caller flushes editor state
      // immediately before a save that later fails.
      if (contentOverride !== undefined) {
        setContent(tabId, contentOverride);
      }

      const dirtyEntry = dirtyFiles.getState().dirtyFiles.get(tabId);
      if (!dirtyEntry) return false;
      const conflict = fileSaveConflict(dirtyEntry);
      if (
        mode === "keep-mine" &&
        (conflict?.kind !== "changed" || (shownDisk !== undefined && conflict.disk !== shownDisk))
      ) {
        return false;
      }
      let replaced = mode === "keep-mine" && conflict?.kind === "changed" ? conflict.disk : null;
      const expected: FileWritePrecondition =
        mode === "recreate"
          ? { absent: true }
          : { sha256: fileContentSha256(replaced ?? fileSaveBaseline(dirtyEntry)) };

      savingRef.current = true;
      if (mountedRef.current) setIsSaving(true);

      const nodeBackend = backendForScope(backendScope);
      const readCurrent = async (): Promise<string> =>
        isLocalEnvironment && worktreePath
          ? (await nodeBackend.readLocalFile(worktreePath, filePath)).content
          : (await nodeBackend.readContainerFile(containerId!, filePath)).content;

      const write = async (precondition: FileWritePrecondition) => {
        const base64Data = encodeUtf8AsBase64(contentToSave);
        if (isLocalEnvironment && worktreePath) {
          await nodeBackend.writeLocalFile(worktreePath, filePath, base64Data, precondition);
        } else if (containerId) {
          await nodeBackend.writeContainerFile(containerId, filePath, base64Data, precondition);
        }
      };

      try {
        let precondition = expected;
        for (let attempt = 0; ; attempt += 1) {
          try {
            await write(precondition);
            break;
          } catch (error) {
            if (!isFileWriteConflict(error)) throw error;
            // Read the newer version back so the editor can show both. The
            // buffer itself is never touched: it stays dirty until the user
            // chooses.
            let current: string | null = null;
            let missing = false;
            try {
              current = await readCurrent();
            } catch (readError) {
              missing = isEditorFileMissing(readError);
              log.warn("file.conflict-read-failed", { tabId, error: formatLogError(readError) });
            }
            const store = dirtyFiles.getState();
            if (store.dirtyFiles.has(tabId)) {
              if (current === null) {
                store.markDiskUnreadable(tabId, missing);
              } else if (current === contentToSave) {
                // Disk already holds exactly this buffer: nothing to resolve.
                store.setOriginalContent(tabId, current);
                toast.dismiss(fileWriteConflictToastId(tabId));
                return true;
              } else {
                store.observeDiskContent(tabId, current);
              }
            }
            const entry = dirtyFiles.getState().dirtyFiles.get(tabId);
            if (
              entry &&
              current !== null &&
              current === fileSaveBaseline(dirtyEntry) &&
              !("absent" in precondition) &&
              attempt === 0
            ) {
              // Disk moved and came back before the read: the buffer's own
              // baseline holds again, so the checked save can be retried once.
              if (mode === "keep-mine") replaced = current;
              precondition = { sha256: fileContentSha256(current) };
              continue;
            }
            if (entry)
              showConflict(current === null ? (missing ? "missing" : "unreadable") : "changed");
            return false;
          }
        }

        toast.dismiss(fileWriteConflictToastId(tabId));
        // Advance the saved baseline without replacing edits made while the
        // backend write was in flight. If the tab was closed, do not recreate
        // its dirty-store entry after unmount cleanup removed it.
        if (getContent(tabId) !== null) {
          setOriginalContent(tabId, contentToSave);
        }
        const resolved = dirtyFiles.getState().dirtyFiles.get(tabId);
        const restore = replaced;
        if (restore !== null && resolved) {
          // The newer version is gone from disk; keep it one click away.
          toast.success("Saved your version", {
            id: fileConflictResolvedToastId(tabId),
            description: `The newer version of ${filePath} was replaced. Restore it into the editor to review it or save it again.`,
            duration: 30_000,
            action: {
              label: "Restore theirs",
              onClick: () => {
                flushEditorRef.current?.();
                if (
                  savingRef.current ||
                  !mountedRef.current ||
                  resolved.content !== contentToSave ||
                  !dirtyFiles.getState().replaceDocument(tabId, resolved, restore)
                ) {
                  offerRecoveryCopy(tabId, restore);
                }
              },
            },
          });
        }
        return true;
      } catch (error) {
        log.error("file.save-failed", { tabId, error: formatLogError(error) });
        toast.error("Failed to save file", {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setIsSaving(false);
      }

      function showConflict(kind: "changed" | "missing" | "unreadable"): void {
        const reload = onReloadRef.current;
        const compare = onCompareRef.current;
        toast.error("File changed on disk", {
          id: fileWriteConflictToastId(tabId),
          description:
            kind === "changed"
              ? `${filePath} was changed since you opened it. Your edits are kept: compare them with the newer version, then keep yours or use theirs.`
              : kind === "missing"
                ? `${filePath} is missing. Recreate it from your draft if the path is still available.`
                : `${filePath} could not be read. Your edits are still in the editor.`,
          duration: Infinity,
          action:
            kind === "changed" && compare
              ? { label: "Compare", onClick: compare }
              : kind === "missing"
                ? {
                    label: "Recreate file",
                    onClick: () => void saveRef.current(undefined, "recreate"),
                  }
                : {
                    label: "Retry save",
                    onClick: () => void saveRef.current(undefined, "checked"),
                  },
          ...(reload && kind === "changed"
            ? { cancel: { label: "Use theirs", onClick: reload } }
            : {}),
        });
      }
    },
    [
      backendScope,
      canSave,
      containerId,
      dirtyFiles,
      filePath,
      getContent,
      isLocalEnvironment,
      setContent,
      setOriginalContent,
      tabId,
      worktreePath,
    ],
  );
  useEffect(() => {
    saveRef.current = save;
  });

  const saveFile = useCallback<SaveFile>(
    (contentOverride) => save(contentOverride, "checked"),
    [save],
  );
  const keepMine = useCallback(
    (shownDisk?: string) => save(undefined, "keep-mine", shownDisk),
    [save],
  );
  const recreate = useCallback(() => save(undefined, "recreate"), [save]);

  return { saveFile, keepMine, recreate, isSaving, isSavingNow };
}
