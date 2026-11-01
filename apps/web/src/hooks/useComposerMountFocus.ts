import { useEffect, useRef, type RefObject } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { isFocusHeldElsewhere } from "@/lib/background-focus";

/**
 * Focus the composer when a chat tab mounts, except on mobile.
 *
 * On a phone, focusing raises the on-screen keyboard over the transcript before
 * the user has asked to type. The breakpoint is sampled once so a later resize
 * across it cannot re-run the effect and steal focus from whatever the user is
 * doing. A tab that mounts while the user is in an open dialog or popover
 * (a coordinator loading late, for one) leaves focus there.
 */
export function useComposerMountFocus(
  inputRef: RefObject<MentionableInputRef | null>,
  enabled = true,
): void {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const shouldFocusRef = useRef(!isMobile);
  useEffect(() => {
    if (!enabled || !shouldFocusRef.current || isFocusHeldElsewhere()) return;
    inputRef.current?.focus();
  }, [enabled, inputRef]);
}
