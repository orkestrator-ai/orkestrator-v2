import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  TerminalCornerToolbar,
  useTerminalCornerHover,
} from "../../apps/web/src/components/terminal/TerminalCornerToolbar";
import { TerminalWarningBanner } from "../../apps/web/src/components/terminal/TerminalWarningBanner";
import { TerminalDisconnectedBanner } from "../../apps/web/src/components/terminal/TerminalDisconnectedBanner";
import { TerminalHistoryPanel } from "../../apps/web/src/components/terminal/TerminalHistoryPanel";

export function TerminalCornerToolbarFixture() {
  const hostRef = useRef<HTMLDivElement>(null);
  const hover = useTerminalCornerHover();
  const [ready, setReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [reconnections, setReconnections] = useState(0);
  const [selection, setSelection] = useState("");
  const [viewportRow, setViewportRow] = useState(0);
  const [banner, setBanner] = useState<"warning" | "disconnected" | null>(null);

  useEffect(() => {
    const originalBackend = window.orkestrator;
    window.orkestrator = {
      invoke: async <T,>(command: string) => {
        if (command !== "get_terminal_history_page")
          throw new Error(`Unexpected command: ${command}`);
        return {
          formatVersion: 1,
          historyId: "fixture-history",
          rows: [{ id: "1:0", text: "Retained earlier output" }],
          previousCursor: null,
          earliestAvailable: true,
          historyTruncated: false,
          historyGap: false,
        } as T;
      },
    } as Window["orkestrator"];
    const terminal = new Terminal({ fontSize: 14, scrollback: 500 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current!);
    fit.fit();
    const selected = terminal.onSelectionChange(() => setSelection(terminal.getSelection()));
    const scrolled = terminal.onScroll(setViewportRow);
    terminal.write(
      Array.from({ length: 100 }, (_, index) => `Selectable terminal row ${index}\r\n`).join(""),
      () => {
        setViewportRow(terminal.buffer.active.viewportY);
        setReady(true);
      },
    );
    return () => {
      selected.dispose();
      scrolled.dispose();
      terminal.dispose();
      window.orkestrator = originalBackend;
    };
  }, []);

  return (
    <main className="p-4">
      <div className="mb-4 flex gap-4">
        <button onClick={() => setBanner("warning")}>Show warning</button>
        <button onClick={() => setBanner("disconnected")}>Show disconnected</button>
      </div>
      <div data-testid="terminal-pane" className="relative h-64 w-[400px] max-w-full">
        {banner === "warning" && (
          <TerminalWarningBanner
            message="Terminal history could not be synchronized. Earlier output may be unavailable."
            onDismiss={() => setBanner(null)}
          />
        )}
        {banner === "disconnected" && (
          <TerminalDisconnectedBanner
            message="This terminal is disconnected and is not accepting input."
            onDismiss={() => setBanner(null)}
            onReconnect={() => {
              setReconnections((value) => value + 1);
              setBanner(null);
            }}
          />
        )}
        {historyOpen && (
          <TerminalHistoryPanel sessionId="fixture-session" onClose={() => setHistoryOpen(false)} />
        )}
        <TerminalCornerToolbar
          showHistoryButton={!historyOpen}
          showMarkSetupComplete={!setupComplete}
          onOpenHistory={() => setHistoryOpen(true)}
          onMarkSetupComplete={() => setSetupComplete(true)}
          hover={hover}
        />
        <div
          ref={hostRef}
          {...hover.terminalHoverProps}
          data-testid="terminal-host"
          className="absolute inset-0"
        />
      </div>
      <output data-testid="terminal-ready">{String(ready)}</output>
      <output data-testid="setup-complete">{String(setupComplete)}</output>
      <output data-testid="reconnections">{reconnections}</output>
      <output data-testid="terminal-selection">{selection}</output>
      <output data-testid="terminal-viewport-row">{viewportRow}</output>
    </main>
  );
}
