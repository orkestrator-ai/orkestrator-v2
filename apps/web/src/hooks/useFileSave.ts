import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fileContentSha256,
  isFileWriteConflict,
  type FileWritePrecondition,
} from "@orkestrator/protocol/file-write-precondition";
import * as backend from "@/lib/backend";
import { useFileDirtyStore } from "@/stores";

interface UseFileSaveOptions {
  tabId: string;
  filePath: string;
  containerId?: string;
  worktreePath?: string;
  isLocalEnvironment: boolean;
  /**
   * Discard the buffer and re-read the file. Offered when a save is refused
   * because the file changed on disk since it was loaded.
   */
  onReloadFromDisk?: () => void;
}

export type SaveFile = (contentOverride?: string) => Promise<boolean>;

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

export function useFileSave({
  tabId,
  filePath,
  containerId,
  worktreePath,
  isLocalEnvironment,
  onReloadFromDisk,
}: UseFileSaveOptions): { saveFile: SaveFile; isSaving: boolean } {
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const getContent = useFileDirtyStore((state) => state.getContent);
  const setContent = useFileDirtyStore((state) => state.setContent);
  const setOriginalContent = useFileDirtyStore((state) => state.setOriginalContent);
  const onReloadRef = useRef(onReloadFromDisk);
  // The conflict toast's Overwrite button outlives the render that showed it.
  const saveRef = useRef<(content: string | undefined, overwrite: boolean) => Promise<boolean>>(
    async () => false,
  );

  useEffect(() => {
    onReloadRef.current = onReloadFromDisk;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = useCallback(
    async (contentOverride: string | undefined, overwrite: boolean): Promise<boolean> => {
      if (savingRef.current) return false;

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

      const contentToSave = contentOverride ?? getContent(tabId);
      if (contentToSave === null) return false;

      // Keep the dirty store authoritative even if a caller flushes editor state
      // immediately before a save that later fails.
      if (contentOverride !== undefined) {
        setContent(tabId, contentOverride);
      }

      // The content this editor last loaded or saved. The backend writes only
      // while the file still holds it, so a change made on disk meanwhile (an
      // agent, a terminal, another window) is reported instead of overwritten.
      const baseline = useFileDirtyStore.getState().dirtyFiles.get(tabId)?.originalContent;
      const expected: FileWritePrecondition | undefined =
        overwrite || baseline === undefined ? undefined : { sha256: fileContentSha256(baseline) };

      savingRef.current = true;
      if (mountedRef.current) setIsSaving(true);

      try {
        const base64Data = encodeUtf8AsBase64(contentToSave);

        if (isLocalEnvironment && worktreePath) {
          await backend.writeLocalFile(worktreePath, filePath, base64Data, expected);
        } else if (containerId) {
          await backend.writeContainerFile(containerId, filePath, base64Data, expected);
        }

        toast.dismiss(fileWriteConflictToastId(tabId));
        // Advance the saved baseline without replacing edits made while the
        // backend write was in flight. If the tab was closed, do not recreate
        // its dirty-store entry after unmount cleanup removed it.
        if (getContent(tabId) !== null) {
          setOriginalContent(tabId, contentToSave);
        }
        return true;
      } catch (error) {
        if (isFileWriteConflict(error)) {
          // The buffer stays dirty and untouched; the user chooses.
          const reload = onReloadRef.current;
          toast.error("File changed on disk", {
            id: fileWriteConflictToastId(tabId),
            description: `${filePath} was changed since it was opened. Overwrite it with your version, or reload it and lose your unsaved edits.`,
            duration: Infinity,
            action: {
              label: "Overwrite",
              onClick: () => void saveRef.current(undefined, true),
            },
            ...(reload ? { cancel: { label: "Reload", onClick: () => reload() } } : {}),
          });
          return false;
        }
        console.error("Failed to save file:", error);
        toast.error("Failed to save file", {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setIsSaving(false);
      }
    },
    [
      containerId,
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

  const saveFile = useCallback<SaveFile>((contentOverride) => save(contentOverride, false), [save]);

  return { saveFile, isSaving };
}
