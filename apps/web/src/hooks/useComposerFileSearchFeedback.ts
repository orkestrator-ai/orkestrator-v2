import { useEffect, useRef } from "react";
import { toast } from "sonner";

interface ComposerFileSearchFeedbackOptions {
  /** Latest file-search failure, or null while the tree is healthy. */
  error: string | null;
  /** Re-reads the workspace file tree. */
  refresh: () => void | Promise<void>;
  /** Whether the `@` mention menu is currently open. */
  mentionMenuOpen: boolean;
}

/**
 * Keep the `@`-mention experience honest for every provider.
 *
 * Two behaviors that each provider composer used to own separately: say so when
 * the file tree could not be read (otherwise the menu is just silently empty),
 * and re-read the tree when the menu opens (otherwise a file created since the
 * tab mounted is unmentionable). Refresh fires on the rising edge only — a
 * close must not spend a read.
 */
export function useComposerFileSearchFeedback({
  error,
  refresh,
  mentionMenuOpen,
}: ComposerFileSearchFeedbackOptions): void {
  const reportedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      reportedErrorRef.current = null;
      return;
    }
    if (reportedErrorRef.current === error) return;
    reportedErrorRef.current = error;
    toast.error("Failed to load files for @mentions", {
      description: error,
      duration: 4000,
    });
  }, [error]);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = mentionMenuOpen;
    if (!wasOpen && mentionMenuOpen) void refresh();
  }, [mentionMenuOpen, refresh]);
}
