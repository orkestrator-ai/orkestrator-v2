import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { TerminalInputClaimThrottle } from "@/lib/terminal-size-client";
import { hasLayoutBox } from "./persistent-terminal-redraw";

/** Two claims closer than this are one interaction (a click that also focuses). */
export const TERMINAL_SIZE_CLAIM_DEDUPE_MS = 500;

type ClaimableTerminal = {
  cols: number;
  rows: number;
  textarea?: HTMLTextAreaElement | undefined;
};

export type UseTerminalSizeClaimOptions = {
  terminal: ClaimableTerminal | null;
  fitAddon: { fit: () => void } | null;
  wrapperRef: RefObject<HTMLElement | null>;
  /** Whether this view is the one on screen; a hidden view never claims. */
  canClaim: boolean;
  /** Whether xterm has been opened into the DOM, which creates its textarea. */
  opened: boolean;
  claimSize: (cols: number, rows: number) => Promise<void>;
  now?: () => number;
};

/**
 * Deliberate interaction with a terminal claims its shared size for this
 * window (`@orkestrator/protocol/terminal-size-ownership`): focusing it,
 * clicking or tapping it, and typing in it. Passive layout changes go through
 * the ordinary resize, which the backend applies only while this window owns
 * the size. A claim is its own command, not queued behind the terminal's
 * input, so claiming while typing does not delay keystrokes.
 *
 * Focus is listened for on xterm's own textarea, so every path that focuses
 * the terminal counts, including the browser refocusing it when its window
 * comes back to the front. Typing claims at most once per
 * `TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS`: enough to take the terminal back
 * after another client used it, without a resize per keystroke.
 */
export function useTerminalSizeClaim({
  terminal,
  fitAddon,
  wrapperRef,
  canClaim,
  opened,
  claimSize,
  now = Date.now,
}: UseTerminalSizeClaimOptions): { claim: () => void; claimOnInput: () => void } {
  const [throttle] = useState(() => new TerminalInputClaimThrottle(undefined, now));
  const lastClaimAtRef = useRef(Number.NEGATIVE_INFINITY);

  const send = useCallback(() => {
    if (!canClaim || !terminal || !fitAddon) return;
    // Claim the size this view really has. A pane with no layout box would
    // fit to xterm's default 80x24, which is nobody's geometry.
    if (!hasLayoutBox(wrapperRef.current)) return;
    fitAddon.fit();
    lastClaimAtRef.current = now();
    throttle.noteClaim();
    void claimSize(terminal.cols, terminal.rows);
  }, [canClaim, claimSize, fitAddon, now, terminal, throttle, wrapperRef]);

  const claim = useCallback(() => {
    if (now() - lastClaimAtRef.current < TERMINAL_SIZE_CLAIM_DEDUPE_MS) return;
    send();
  }, [now, send]);

  const claimOnInput = useCallback(() => {
    if (!canClaim || !throttle.shouldClaim()) return;
    send();
  }, [canClaim, send, throttle]);

  useEffect(() => {
    const textarea = opened ? terminal?.textarea : undefined;
    if (!textarea) return;
    textarea.addEventListener("focus", claim);
    return () => textarea.removeEventListener("focus", claim);
  }, [terminal, opened, claim]);

  return { claim, claimOnInput };
}
