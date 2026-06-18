import { useCallback, useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { writeText } from "@/lib/native/clipboard";
import { processClipboardPaste } from "./useClipboardImagePaste";

export interface UseTerminalClipboardOptions {
  /** The xterm.js Terminal instance */
  terminal: Terminal | null;
  /** Container ID for clipboard image paste support */
  containerId: string;
  /** Ref to the write function for pasting text */
  writeRef: React.MutableRefObject<(data: string) => Promise<void>>;
}

export interface UseTerminalClipboardReturn {
  /** Whether text is currently selected in the terminal */
  hasSelection: boolean;
  /** Copy selected text to clipboard */
  handleCopySelection: () => Promise<void>;
  /** Select all text in the terminal buffer */
  handleSelectAll: () => void;
  /** Paste from clipboard (handles both text and images) */
  handlePaste: () => void;
  /** Attach keyboard event handler to terminal for clipboard shortcuts */
  attachClipboardKeyHandler: () => void;
}

/**
 * Hook that provides clipboard functionality for xterm.js terminals.
 *
 * Handles:
 * - Copy selection (Cmd+C / Ctrl+Shift+C)
 * - Select all (Cmd+A)
 * - Paste (Cmd+V / Ctrl+V) with image support
 * - Right-click context menu actions
 */
export function useTerminalClipboard({
  terminal,
  containerId,
  writeRef,
}: UseTerminalClipboardOptions): UseTerminalClipboardReturn {
  const [hasSelection, setHasSelection] = useState(false);

  // Track selection state
  useEffect(() => {
    if (!terminal) return;
    const updateSelection = () => {
      setHasSelection(terminal.hasSelection());
    };
    updateSelection();
    const disposable = terminal.onSelectionChange(updateSelection);
    return () => disposable.dispose();
  }, [terminal]);

  const handleCopySelection = useCallback(async () => {
    if (!terminal) return;
    const selection = terminal.getSelection();
    if (!selection) return;
    try {
      await writeText(selection);
    } catch (err) {
      console.error("[useTerminalClipboard] Failed to copy selection:", err);
    }
  }, [terminal]);

  const handleSelectAll = useCallback(() => {
    if (!terminal) return;
    terminal.selectAll();
    terminal.focus();
  }, [terminal]);

  const handlePaste = useCallback(() => {
    if (!containerId || !terminal) return;
    processClipboardPaste(
      containerId,
      async (filePath) => {
        await writeRef.current(filePath + " ");
        terminal.focus();
      },
      async (text) => {
        await writeRef.current(text);
        terminal.focus();
      },
      (error) => {
        console.error("[useTerminalClipboard] Clipboard paste error:", error);
      }
    );
  }, [containerId, terminal, writeRef]);

  const attachClipboardKeyHandler = useCallback(() => {
    if (!terminal) return;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      const key = event.key.toLowerCase();
      const isMeta = event.metaKey;
      const isCtrl = event.ctrlKey;
      const isAlt = event.altKey;
      const isShift = event.shiftKey;

      // Copy: Cmd+C (Mac) or Ctrl+Shift+C (Linux/Windows)
      // Only intercept when there's a selection to preserve Ctrl+C for SIGINT
      const isCopyShortcut =
        (isMeta && key === "c") || (isCtrl && isShift && key === "c");
      if (isCopyShortcut && terminal.hasSelection() && !isAlt) {
        void handleCopySelection();
        return false;
      }

      // Select All: Cmd+A (Mac only)
      // Avoid overriding Ctrl+A which is "go to beginning of line" in shells
      if (isMeta && key === "a" && !isAlt) {
        handleSelectAll();
        return false;
      }

      // Paste: Cmd+V / Ctrl+V
      const isPasteShortcut = (isCtrl || isMeta) && key === "v";
      if (isPasteShortcut && !isAlt) {
        // Prevent default to stop browser from firing a paste event
        // (which would cause xterm to paste a second time)
        event.preventDefault();
        handlePaste();
        return false;
      }

      return true;
    });
  }, [terminal, handleCopySelection, handleSelectAll, handlePaste]);

  return {
    hasSelection,
    handleCopySelection,
    handleSelectAll,
    handlePaste,
    attachClipboardKeyHandler,
  };
}
