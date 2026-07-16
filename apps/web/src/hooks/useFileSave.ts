import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as backend from "@/lib/backend";
import { useFileDirtyStore } from "@/stores";

interface UseFileSaveOptions {
  tabId: string;
  filePath: string;
  containerId?: string;
  worktreePath?: string;
  isLocalEnvironment: boolean;
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

export function useFileSave({
  tabId,
  filePath,
  containerId,
  worktreePath,
  isLocalEnvironment,
}: UseFileSaveOptions): { saveFile: SaveFile; isSaving: boolean } {
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const getContent = useFileDirtyStore((state) => state.getContent);
  const setContent = useFileDirtyStore((state) => state.setContent);
  const setOriginalContent = useFileDirtyStore((state) => state.setOriginalContent);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const saveFile = useCallback<SaveFile>(async (contentOverride) => {
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

    savingRef.current = true;
    if (mountedRef.current) setIsSaving(true);

    try {
      const base64Data = encodeUtf8AsBase64(contentToSave);

      if (isLocalEnvironment && worktreePath) {
        await backend.writeLocalFile(worktreePath, filePath, base64Data);
      } else if (containerId) {
        await backend.writeContainerFile(containerId, filePath, base64Data);
      }

      // Advance the saved baseline without replacing edits made while the
      // backend write was in flight. If the tab was closed, do not recreate
      // its dirty-store entry after unmount cleanup removed it.
      if (getContent(tabId) !== null) {
        setOriginalContent(tabId, contentToSave);
      }
      return true;
    } catch (error) {
      console.error("Failed to save file:", error);
      toast.error("Failed to save file", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  }, [
    containerId,
    filePath,
    getContent,
    isLocalEnvironment,
    setContent,
    setOriginalContent,
    tabId,
    worktreePath,
  ]);

  return { saveFile, isSaving };
}
