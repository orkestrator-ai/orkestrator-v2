/**
 * Shared terminal paste utilities for handling clipboard paste in terminal components.
 */

import { readText } from "@/lib/native/clipboard";
import { processClipboardPaste, processLocalClipboardPaste } from "@/hooks/useClipboardImagePaste";

const TERMINAL_PATH_ESCAPE_PATTERN = /([\s\\"'`$&|;<>()[\]{}*?!#~])/g;

export interface TerminalPasteOptions {
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
 */
export function escapePathForTerminalInput(filePath: string): string {
  return filePath.replace(TERMINAL_PATH_ESCAPE_PATTERN, "\\$1");
}

/**
 * Handle paste operations for terminal components.
 * For container environments, uses processClipboardPaste to handle both images and text.
 * For local environments with worktreePath, uses processLocalClipboardPaste for images and text.
 * Falls back to text-only paste if neither container nor worktree is available.
 */
export async function handleTerminalPaste({
  containerId,
  worktreePath,
  writeToTerminal,
  focusTerminal,
  componentName,
}: TerminalPasteOptions): Promise<void> {
  if (containerId) {
    // Container environment - supports both image and text paste
    await processClipboardPaste(
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
        console.error(`[${componentName}] Clipboard paste error:`, error);
      }
    );
  } else if (worktreePath) {
    // Local environment - supports both image and text paste via worktree
    await processLocalClipboardPaste(
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
        console.error(`[${componentName}] Clipboard paste error:`, error);
      }
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
      console.error(`[${componentName}] Clipboard text paste error:`, err);
    }
  }
}
