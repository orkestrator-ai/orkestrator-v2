import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useNodeScope, useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fileContentSha256,
  isFileWriteConflict,
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
  keepMine: () => Promise<boolean>;
  isSaving: boolean;
}

type SaveMode = "checked" | "keep-mine";

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

export function useFileSave({
  tabId,
  filePath,
  containerId,
  worktreePath,
  isLocalEnvironment,
  onReloadFromDisk,
  onCompare,
}: UseFileSaveOptions): FileSaveControls {
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const getContent = useFileDirtyStore((state) => state.getContent);
  const setContent = useFileDirtyStore((state) => state.setContent);
  const setOriginalContent = useFileDirtyStore((state) => state.setOriginalContent);
  const dirtyFiles = useNodeScope().store(fileDirtyStore);
  const onReloadRef = useRef(onReloadFromDisk);
  const onCompareRef = useRef(onCompare);
  // The conflict toast's buttons outlive the render that showed them.
  const saveRef = useRef<(content: string | undefined, mode: SaveMode) => Promise<boolean>>(
    async () => false,
  );

  useEffect(() => {
    onReloadRef.current = onReloadFromDisk;
    onCompareRef.current = onCompare;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = useCallback(
    async (contentOverride: string | undefined, mode: SaveMode): Promise<boolean> => {
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
      // "Keep mine" instead names the newer version the user was shown; only a
      // file that could not be read back at all is written unconditionally.
      const dirtyEntry = dirtyFiles.getState().dirtyFiles.get(tabId);
      const conflict = fileSaveConflict(dirtyEntry);
      let expectedContent: string | undefined;
      if (mode === "keep-mine" && conflict) {
        expectedContent = conflict.kind === "changed" ? conflict.disk : undefined;
      } else {
        expectedContent = dirtyEntry ? fileSaveBaseline(dirtyEntry) : undefined;
      }
      const expected: FileWritePrecondition | undefined =
        expectedContent === undefined ? undefined : { sha256: fileContentSha256(expectedContent) };
      const replaced = mode === "keep-mine" && conflict?.kind === "changed" ? conflict.disk : null;

      savingRef.current = true;
      if (mountedRef.current) setIsSaving(true);

      const nodeBackend = backendForScope(backendScope);
      const readCurrent = async (): Promise<string> =>
        isLocalEnvironment && worktreePath
          ? (await nodeBackend.readLocalFile(worktreePath, filePath)).content
          : (await nodeBackend.readContainerFile(containerId!, filePath)).content;

      const write = async (precondition: FileWritePrecondition | undefined) => {
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
            try {
              current = await readCurrent();
            } catch (readError) {
              log.warn("file.conflict-read-failed", { tabId, error: formatLogError(readError) });
            }
            const store = dirtyFiles.getState();
            if (store.dirtyFiles.has(tabId)) {
              if (current === null) {
                store.markDiskUnreadable(tabId);
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
            if (entry && !fileSaveConflict(entry) && attempt === 0) {
              // Disk moved and came back before the read: the buffer's own
              // baseline holds again, so the checked save can be retried once.
              precondition = { sha256: fileContentSha256(fileSaveBaseline(entry)) };
              continue;
            }
            showConflict(current === null);
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
        if (replaced !== null) {
          // The newer version is gone from disk; keep it one click away.
          toast.success("Saved your version", {
            id: fileConflictResolvedToastId(tabId),
            description: `The newer version of ${filePath} was replaced. Restore it into the editor to review it or save it again.`,
            duration: 30_000,
            action: {
              label: "Restore theirs",
              onClick: () => {
                if (dirtyFiles.getState().dirtyFiles.has(tabId)) setContent(tabId, replaced);
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

      function showConflict(unreadable: boolean): void {
        const reload = onReloadRef.current;
        const compare = onCompareRef.current;
        toast.error("File changed on disk", {
          id: fileWriteConflictToastId(tabId),
          description: unreadable
            ? `${filePath} was deleted or can no longer be opened. Your edits are kept: save them to recreate it, or close the tab.`
            : `${filePath} was changed since you opened it. Your edits are kept: compare them with the newer version, then keep yours or use theirs.`,
          duration: Infinity,
          action:
            compare && !unreadable
              ? { label: "Compare", onClick: () => compare() }
              : {
                  label: unreadable ? "Save mine" : "Keep mine",
                  onClick: () => void saveRef.current(undefined, "keep-mine"),
                },
          ...(reload && !unreadable
            ? { cancel: { label: "Use theirs", onClick: () => reload() } }
            : {}),
        });
      }
    },
    [
      backendScope,
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
  const keepMine = useCallback(() => save(undefined, "keep-mine"), [save]);

  return { saveFile, keepMine, isSaving };
}
