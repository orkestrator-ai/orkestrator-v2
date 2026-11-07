/**
 * Shared terminal paste utilities for handling clipboard paste in terminal components.
 */

import { readText } from "@/lib/native/clipboard";
import {
  processClipboardPaste,
  processLocalClipboardPaste,
  type ClipboardImageWriter,
} from "@/hooks/useClipboardImagePaste";
import { escapePathForTerminalInput } from "@orkestrator/protocol/tmux-prompt";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("terminal");

export interface TerminalPasteOptions {
  /** The terminal's node, where a pasted image is written (`useScopeBackend()`). */
  writer: ClipboardImageWriter;
  /** Container ID for container environments, null/undefined for local */
  containerId: string | null | undefined;
  /** Worktree path for local environments */
  worktreePath?: string | null;
  /** Function to write text to the terminal */
  writeToTerminal: (text: string) => Promise<void>;
  /** Function to focus the terminal after paste */
  focusTerminal: () => void;
  /** Component name for error logging */
  componentName: string;
}

/**
 * Escape a filesystem path before typing it into a shell-like terminal input.
 *
 * Re-exported from the protocol package: the backend tmux queue drainer types
 * the same paths into the same panes, and two copies of this rule would drift.
 */
export { escapePathForTerminalInput };

/**
 * Handle paste operations for terminal components.
 * For container environments, uses processClipboardPaste to handle both images and text.
 * For local environments with worktreePath, uses processLocalClipboardPaste for images and text.
 * Falls back to text-only paste if neither container nor worktree is available.
 */
export async function handleTerminalPaste({
  writer,
  containerId,
  worktreePath,
  writeToTerminal,
  focusTerminal,
  componentName,
}: TerminalPasteOptions): Promise<void> {
  if (containerId) {
    // Container environment - supports both image and text paste
    await processClipboardPaste(
      writer,
      containerId,
      async (filePath) => {
        await writeToTerminal(filePath + " ");
        focusTerminal();
      },
      async (text) => {
        await writeToTerminal(text);
        focusTerminal();
      },
      (error) => {
        log.error("clipboard.paste-failed", {
          source: componentName,
          target: "container",
          error: formatLogError(error),
        });
      },
    );
  } else if (worktreePath) {
    // Local environment - supports both image and text paste via worktree
    await processLocalClipboardPaste(
      writer,
      worktreePath,
      async (filePath) => {
        await writeToTerminal(escapePathForTerminalInput(filePath) + " ");
        focusTerminal();
      },
      async (text) => {
        await writeToTerminal(text);
        focusTerminal();
      },
      (error) => {
        log.error("clipboard.paste-failed", {
          source: componentName,
          target: "local",
          error: formatLogError(error),
        });
      },
    );
  } else {
    // No target available - text-only paste using Electron clipboard API
    try {
      const text = await readText();
      if (text) {
        await writeToTerminal(text);
        focusTerminal();
      }
    } catch (err) {
      log.error("clipboard.paste-failed", {
        source: componentName,
        target: "text-only",
        error: formatLogError(err),
      });
    }
  }
}
