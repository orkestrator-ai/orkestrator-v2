import { type RefObject, useEffect } from "react";
import { isAgentShortcutInScope } from "./agent-shortcut-scope";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";

interface UseFocusComposerShortcutOptions {
  /** Only the focused chat pane claims the shortcut. */
  isActive: boolean;
  inputRef: RefObject<MentionableInputRef | null>;
  /** The tab's composer; its pane or agent scope bounds where the key counts. */
  scopeRef: RefObject<HTMLElement | null>;
}

/** ⌘I on macOS, Ctrl+I elsewhere; either modifier is accepted. */
export function isFocusComposerShortcut(event: KeyboardEvent): boolean {
  // Preserve logical Latin shortcuts (e.g. Dvorak copy at physical KeyI).
  // Fall back to the physical key only for layouts without a Latin letter.
  return (
    (event.key.toLowerCase() === "i" || (!/^[a-z]$/i.test(event.key) && event.code === "KeyI")) &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/**
 * Bind ⌘I / Ctrl+I to "focus the composer" for the active chat tab, so the
 * keyboard can get back to the input from the transcript, find bar or a card.
 *
 * The key only counts inside the tab's pane, or when nothing has focus and no
 * dialog is open: a terminal in a neighbouring pane uses the same chord for
 * its compose bar and lets the event bubble. Inside the composer it is still
 * claimed, which keeps the contenteditable from applying italics.
 */
export function useFocusComposerShortcut({
  isActive,
  inputRef,
  scopeRef,
}: UseFocusComposerShortcutOptions): void {
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isFocusComposerShortcut(event)) {
        return;
      }

      if (!isAgentShortcutInScope(event.target, scopeRef.current)) return;

      event.preventDefault();
      if (!event.repeat) inputRef.current?.focus();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inputRef, isActive, scopeRef]);
}
