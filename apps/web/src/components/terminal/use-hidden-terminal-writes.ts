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
 * use `afterParsed` to order resets and history capture after earlier writes.
 */
export function useHiddenTerminalWrites(terminal: Terminal, visible: boolean) {
  const gateRef = useRef<TerminalWriteGate | null>(null);
  const pending = useRef(0);
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
    (
      data: Uint8Array,
      parsed: () => void,
      options: { immediate?: boolean; failed?: (error: unknown) => void } = {},
    ) => {
      const gate = gateRef.current;
      pending.current += 1;
      const complete = () => {
        pending.current -= 1;
        parsed();
      };
      const fail = (error: unknown) => {
        pending.current -= 1;
        options.failed?.(error);
      };
      if (!gate || options.immediate) {
        gate?.flush();
        try {
          terminal.write(data, complete);
        } catch (error) {
          fail(error);
        }
        return;
      }
      gate.write(data, complete, fail);
    },
    [terminal],
  );

  const afterParsed = useCallback(
    (callback: () => void) => {
      gateRef.current?.flush();
      if (pending.current === 0) callback();
      else terminal.write("", callback);
    },
    [terminal],
  );

  // Stable, so effects may list it without re-running on every render.
  return useMemo(() => ({ write, afterParsed }), [write, afterParsed]);
}
