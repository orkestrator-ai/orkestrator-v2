import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  backgroundWritesEnabled,
  backgroundWriteScheduler,
  createTerminalWriteGate,
  type TerminalWriteGate,
} from "@/lib/terminal-background-writes";

/**
 * Writes into a terminal tab's xterm, holding a hidden tab's output for idle
 * time (`terminal-background-writes.ts`, to-do 8312 task 2). The tab stays
 * subscribed and receives every byte; only the parse waits.
 *
 * `write` keeps per-terminal order with everything else that touches xterm:
 * a replay, and anything that calls `flush` first (a buffer capture before a
 * pane move), sees every byte received before it.
 */
export function useHiddenTerminalWrites(terminal: Terminal, visible: boolean) {
  const gateRef = useRef<TerminalWriteGate | null>(null);
  const visibleRef = useRef(visible);

  useEffect(() => {
    if (!backgroundWritesEnabled()) return;
    const gate = createTerminalWriteGate(
      (data, parsed) => terminal.write(data, parsed),
      backgroundWriteScheduler(),
      { hidden: !visibleRef.current },
    );
    gateRef.current = gate;
    return () => {
      if (gateRef.current === gate) gateRef.current = null;
      // Unmount is not cancel: whatever is queued still reaches xterm.
      gate.dispose();
    };
  }, [terminal]);

  useEffect(() => {
    visibleRef.current = visible;
    gateRef.current?.setHidden(!visible);
  }, [visible]);

  const write = useCallback(
    (data: Uint8Array, parsed: () => void, options: { immediate?: boolean } = {}) => {
      const gate = gateRef.current;
      if (!gate || options.immediate) {
        gate?.flush();
        terminal.write(data, parsed);
        return;
      }
      gate.write(data, parsed);
    },
    [terminal],
  );

  const flush = useCallback(() => gateRef.current?.flush(), []);

  // Stable, so effects may list it without re-running on every render.
  return useMemo(() => ({ write, flush }), [write, flush]);
}
