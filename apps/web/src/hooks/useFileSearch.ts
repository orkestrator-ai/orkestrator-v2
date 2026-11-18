import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { FileNode } from "@/lib/backend";
import type { FileCandidate } from "@/types";
import { flattenFileTree, readComposerFileIndex } from "./composer-file-index";

const log = createLogger("web.files");
const EMPTY_FILES: FileCandidate[] = [];

interface FileRead {
  scope: object;
  flatFiles: FileCandidate[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Loads and searches files in a container or local worktree.
 * Native composers share an index. Other callers own their own reads.
 */
export function useFileSearch(
  containerId: string | undefined,
  worktreePath: string | undefined,
  enabled = true,
  mode: "independent" | "composer" = "independent",
) {
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const isAvailable = !!(containerId || worktreePath);
  const loadScope = useMemo(
    () => ({ backendScope, containerId, worktreePath, enabled, mode }),
    [backendScope, containerId, worktreePath, enabled, mode],
  );
  const initialRead: FileRead = {
    scope: loadScope,
    flatFiles: EMPTY_FILES,
    isLoading: enabled && isAvailable,
    error: null,
  };
  const [fileRead, setFileRead] = useState(initialRead);
  // A render for another target cannot select or report the old target's
  // paths, even before effects run. Reopening waits for a freshness check.
  if (fileRead.scope !== loadScope) setFileRead(initialRead);
  const { flatFiles, isLoading, error } = fileRead.scope === loadScope ? fileRead : initialRead;

  const activeRequestRef = useRef<{ scope: object; promise: Promise<void> } | null>(null);

  const readFiles = useCallback(async () => {
    const backend = backendForScope(backendScope);
    if (mode === "composer") {
      if (worktreePath) {
        return readComposerFileIndex(backendScope, `worktree:${worktreePath}`, (digest) =>
          backend.getLocalFileTreeSnapshot(worktreePath, digest, { refresh: true }),
        );
      }
      if (containerId) {
        return readComposerFileIndex(backendScope, `container:${containerId}`, (digest) =>
          backend.getFileTreeSnapshot(containerId, digest, { refresh: true }),
        );
      }
    }
    let tree: FileNode[] = [];
    if (worktreePath) tree = await backend.getLocalFileTree(worktreePath);
    else if (containerId) tree = await backend.getFileTree(containerId);
    return flattenFileTree(tree);
  }, [backendScope, containerId, worktreePath, mode]);

  // Starts (or joins) a read of the current environment's tree. Callers own
  // the synchronous loading state; only the settled read writes state here.
  const requestFileTree = useCallback((): Promise<void> => {
    const activeRequest = activeRequestRef.current;
    if (activeRequest?.scope === loadScope) {
      return activeRequest.promise;
    }

    const request = {
      scope: loadScope,
      promise: Promise.resolve().then(async () => {
        let files = EMPTY_FILES;
        let failure: string | null = null;
        try {
          files = await readFiles();
        } catch (err) {
          if (activeRequestRef.current === request) {
            log.error("file-tree.load-failed", { error: formatLogError(err) });
          }
          failure = err instanceof Error ? err.message : "Failed to load files";
        }
        if (activeRequestRef.current !== request) return;
        activeRequestRef.current = null;
        setFileRead((current) =>
          current.scope === loadScope
            ? { scope: loadScope, flatFiles: files, isLoading: false, error: failure }
            : current,
        );
      }),
    };
    activeRequestRef.current = request;
    return request.promise;
  }, [loadScope, readFiles]);

  const loadFileTree = useCallback((): Promise<void> => {
    if (!isAvailable) return Promise.resolve();
    if (activeRequestRef.current?.scope !== loadScope) {
      setFileRead((current) =>
        current.scope === loadScope ? { ...current, isLoading: true, error: null } : current,
      );
    }
    return requestFileTree();
  }, [isAvailable, loadScope, requestFileTree]);

  useEffect(() => {
    if (enabled && isAvailable) void requestFileTree();

    return () => {
      if (activeRequestRef.current?.scope === loadScope) activeRequestRef.current = null;
    };
  }, [enabled, isAvailable, loadScope, requestFileTree]);

  /**
   * Search files by query (case-insensitive).
   * Matches against both filename and path.
   * Prioritizes: filename prefix > filename contains > path segment prefix > path contains.
   * Within same priority, shorter paths come first.
   * Returns up to `limit` results (default 30).
   */
  const searchFiles = useCallback(
    (query: string, limit = 30, options?: { filesOnly?: boolean }): FileCandidate[] => {
      const candidates = options?.filesOnly
        ? flatFiles.filter((file) => !file.isDirectory)
        : flatFiles;

      if (!query) {
        // Return first N files when no query, sorted by path length (shorter first)
        return [...candidates]
          .sort((a, b) => a.relativePath.length - b.relativePath.length)
          .slice(0, limit);
      }

      const lowerQuery = query.toLowerCase();

      // Score files:
      // - Filename prefix match = 4 (highest priority)
      // - Filename contains = 3
      // - Path segment prefix = 2 (e.g., "hook" matches src/hooks/)
      // - Path contains = 1 (substring match anywhere in path)
      const scored = candidates
        .map((file) => {
          const lowerFilename = file.filename.toLowerCase();
          const lowerPath = file.relativePath.toLowerCase();
          const pathSegments = lowerPath.split("/").slice(0, -1); // Exclude filename
          let score = 0;

          if (lowerFilename.startsWith(lowerQuery)) {
            score = 4; // Filename prefix match is highest priority
          } else if (lowerFilename.includes(lowerQuery)) {
            score = 3; // Filename contains match
          } else if (pathSegments.some((segment) => segment.startsWith(lowerQuery))) {
            score = 2; // Path segment starts with query (e.g., "hook" matches src/hooks/)
          } else if (lowerPath.includes(lowerQuery)) {
            score = 1; // Path contains query as substring
          }

          return { file, score };
        })
        .filter(({ score }) => score > 0);

      // Sort by score descending, then by path length (shorter = better)
      scored.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.file.relativePath.length - b.file.relativePath.length;
      });

      return scored.slice(0, limit).map(({ file }) => file);
    },
    [flatFiles],
  );

  return {
    flatFiles,
    searchFiles,
    isLoading,
    error,
    refresh: loadFileTree,
    isAvailable,
  };
}
