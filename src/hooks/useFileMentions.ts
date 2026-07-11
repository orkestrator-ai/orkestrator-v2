import { useState, useCallback, useMemo, useRef } from "react";
import type { FileMention, FileCandidate } from "@/types";
import { createUuid } from "@/lib/uuid";

interface UseFileMentionsOptions {
  /** Callback to search files */
  searchFiles: (query: string, limit?: number) => FileCandidate[];
  /** Max files to show in menu (default: 30) */
  maxResults?: number;
}

interface UseFileMentionsReturn {
  /** Whether the file mention menu is open */
  isMenuOpen: boolean;
  /** Current search query (text after @) */
  searchQuery: string;
  /** Selected index in menu for keyboard navigation */
  selectedIndex: number;
  /** Filtered file candidates */
  filteredFiles: FileCandidate[];
  /** Update cursor position and detect @ trigger */
  handleCursorChange: (position: number, text: string) => void;
  /** Handle keyboard navigation */
  handleKeyDown: (
    event: React.KeyboardEvent,
    onSelect: (file: FileCandidate) => void
  ) => boolean;
  /** Close the menu */
  closeMenu: (options?: CloseMenuOptions) => void;
  /** Set selected index */
  setSelectedIndex: (index: number) => void;
  /** Serialize text for LLM (replace @filename with full path) */
  serializeForLLM: (text: string, mentions: FileMention[]) => string;
  /** Create a mention from a file candidate */
  createMention: (file: FileCandidate) => FileMention;
}

interface CloseMenuOptions {
  /**
   * Mention insertion can briefly restore the old cursor position inside the
   * newly rendered @filename before moving it after the trailing space.
   * Suppress reopening for that accepted file during this transient update.
   */
  suppressReopenFor?: string;
}

/**
 * Hook for managing file @mentions in the compose bar.
 * Handles detection, menu state, keyboard navigation, and LLM serialization.
 */
export function useFileMentions({
  searchFiles,
  maxResults = 30,
}: UseFileMentionsOptions): UseFileMentionsReturn {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const suppressedAcceptedFilenameRef = useRef<string | null>(null);

  const closeMenu = useCallback((options?: CloseMenuOptions) => {
    suppressedAcceptedFilenameRef.current = options?.suppressReopenFor ?? null;
    setIsMenuOpen(false);
    setSearchQuery("");
    setSelectedIndex(0);
  }, []);

  const handleMenuKey = useCallback((event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // Filter files based on current search query
  const filteredFiles = useMemo(() => {
    if (!isMenuOpen) return [];
    return searchFiles(searchQuery, maxResults);
  }, [isMenuOpen, searchQuery, searchFiles, maxResults]);

  // Reset selected index when filtered files change
  const safeSelectedIndex = useMemo(() => {
    if (filteredFiles.length === 0) return 0;
    return Math.min(selectedIndex, filteredFiles.length - 1);
  }, [selectedIndex, filteredFiles.length]);

  /**
   * Detect @ trigger at cursor position.
   * Opens menu if @ is found with optional query text.
   */
  const handleCursorChange = useCallback(
    (position: number, text: string) => {
      const textBefore = text.slice(0, position);
      const atMatch = textBefore.match(/@([^\s@]*)$/);

      if (atMatch) {
        // Found @ trigger
        const query = atMatch[1] ?? "";
        const suppressedFilename = suppressedAcceptedFilenameRef.current;
        const textAfterCursor = text.slice(position).toLowerCase();
        const normalizedSuppressedFilename = suppressedFilename?.toLowerCase() ?? "";
        if (
          suppressedFilename
          && (
            (query.length > 0 && normalizedSuppressedFilename.startsWith(query.toLowerCase()))
            || (query.length === 0 && textAfterCursor.startsWith(normalizedSuppressedFilename))
          )
        ) {
          setIsMenuOpen(false);
          setSearchQuery("");
          setSelectedIndex(0);
          return;
        }

        suppressedAcceptedFilenameRef.current = null;
        setSearchQuery(query);
        setIsMenuOpen(true);
        // Reset selection when query changes
        if (query !== searchQuery) {
          setSelectedIndex(0);
        }
      } else {
        // No @ trigger - close menu
        suppressedAcceptedFilenameRef.current = null;
        setIsMenuOpen(false);
        setSearchQuery("");
      }
    },
    [searchQuery]
  );

  /**
   * Handle keyboard navigation for the menu.
   * Returns true if the event was handled (should prevent default).
   */
  const handleKeyDown = useCallback(
    (
      event: React.KeyboardEvent,
      onSelect: (file: FileCandidate) => void
    ): boolean => {
      if (!isMenuOpen) {
        return false;
      }

      switch (event.key) {
        case "ArrowDown":
          handleMenuKey(event);
          if (filteredFiles.length === 0) return true;
          setSelectedIndex((prev) => (prev + 1) % filteredFiles.length);
          return true;

        case "ArrowUp":
          handleMenuKey(event);
          if (filteredFiles.length === 0) return true;
          setSelectedIndex((prev) =>
            prev === 0 ? filteredFiles.length - 1 : prev - 1
          );
          return true;

        case "Tab":
        case "Enter":
          handleMenuKey(event);
          if (filteredFiles.length === 0) {
            return true;
          }
          if (filteredFiles[safeSelectedIndex]) {
            const selectedFile = filteredFiles[safeSelectedIndex];
            closeMenu({ suppressReopenFor: selectedFile.filename });
            onSelect(selectedFile);
            return true;
          }
          break;

        case " ":
        case "Spacebar":
          if (filteredFiles.length === 0) {
            closeMenu();
            return false;
          }
          handleMenuKey(event);
          if (filteredFiles[safeSelectedIndex]) {
            const selectedFile = filteredFiles[safeSelectedIndex];
            closeMenu({ suppressReopenFor: selectedFile.filename });
            onSelect(selectedFile);
            return true;
          }
          break;

        case "Escape":
          handleMenuKey(event);
          closeMenu();
          return true;
      }

      return false;
    },
    [closeMenu, filteredFiles, handleMenuKey, isMenuOpen, safeSelectedIndex]
  );

  /**
   * Serialize text for LLM by replacing @filename with markdown link.
   * Format: [@filename](path/to/file.txt)
   * This allows the mention to be rendered as a clickable link in messages.
   */
  const serializeForLLM = useCallback(
    (text: string, mentions: FileMention[]): string => {
      if (mentions.length === 0) {
        return text;
      }

      let result = text;

      // Sort by filename length descending to avoid partial replacements
      const sorted = [...mentions].sort(
        (a, b) => b.filename.length - a.filename.length
      );

      for (const mention of sorted) {
        // Replace @filename with markdown link: [@filename](relativePath)
        result = result.replace(
          new RegExp(`@${escapeRegExp(mention.filename)}`, "g"),
          `[@${mention.filename}](${mention.relativePath})`
        );
      }

      return result;
    },
    []
  );

  /**
   * Create a FileMention from a FileCandidate.
   */
  const createMention = useCallback((file: FileCandidate): FileMention => {
    return {
      id: createUuid(),
      filename: file.filename,
      relativePath: file.relativePath,
    };
  }, []);

  return {
    isMenuOpen,
    searchQuery,
    selectedIndex: safeSelectedIndex,
    filteredFiles,
    handleCursorChange,
    handleKeyDown,
    closeMenu,
    setSelectedIndex,
    serializeForLLM,
    createMention,
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
