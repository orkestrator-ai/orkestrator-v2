import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { TerminalInputClaimThrottle } from "@/lib/terminal-size-client";
import { hasLayoutBox } from "./persistent-terminal-redraw";

/** Deduplicate repeat clicks close together. */
export const TERMINAL_SIZE_CLAIM_DEDUPE_MS = 500;

type ClaimableTerminal = {
  cols: number;
  rows: number;
};

export type UseTerminalSizeClaimOptions = {
  terminal: ClaimableTerminal | null;
  fitAddon: { fit: () => void } | null;
  wrapperRef: RefObject<HTMLElement | null>;
  /** Whether this view is the one on screen; a hidden view never claims. */
  canClaim: boolean;
  sessionId: string | null;
  claimSize: (cols: number, rows: number) => Promise<void>;
  now?: () => number;
};

/**
 * Deliberate interaction with a terminal claims its shared size for this
 * window when the user clicks, taps, or enters input. Layout changes go
 * through the ordinary resize. Claims travel independently of terminal input.
 */
export function useTerminalSizeClaim({
  terminal,
  fitAddon,
  wrapperRef,
  canClaim,
  sessionId,
  claimSize,
  now = Date.now,
}: UseTerminalSizeClaimOptions): { claim: () => void; claimOnInput: () => void } {
  const throttleRef = useRef<TerminalInputClaimThrottle | null>(null);
  const lastClaimAtRef = useRef(Number.NEGATIVE_INFINITY);

  useLayoutEffect(() => {
    throttleRef.current = new TerminalInputClaimThrottle(undefined, now);
    lastClaimAtRef.current = Number.NEGATIVE_INFINITY;
  }, [canClaim, now, sessionId]);

  const send = useCallback(() => {
    if (!canClaim || !terminal || !fitAddon) return;
    // Claim the size this view really has. A pane with no layout box would
    // fit to xterm's default 80x24, which is nobody's geometry.
    if (!hasLayoutBox(wrapperRef.current)) return;
    fitAddon.fit();
    lastClaimAtRef.current = now();
    throttleRef.current?.noteClaim();
    void claimSize(terminal.cols, terminal.rows);
  }, [canClaim, claimSize, fitAddon, now, terminal, wrapperRef]);

  const claim = useCallback(() => {
    if (now() - lastClaimAtRef.current < TERMINAL_SIZE_CLAIM_DEDUPE_MS) return;
    send();
  }, [now, send]);

  const claimOnInput = useCallback(() => {
    if (!canClaim || !throttleRef.current?.shouldClaim()) return;
    send();
  }, [canClaim, send]);

  return { claim, claimOnInput };
}
