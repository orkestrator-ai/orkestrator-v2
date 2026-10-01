import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useTerminalPortalStore } from "../../apps/web/src/stores/terminalPortalStore";
import {
  listenForTerminalBrowserTabRequests,
  type TerminalBrowserTabRequest,
} from "../../apps/web/src/lib/terminal-links";

export function TerminalLinksFixture() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [external, setExternal] = useState<string[]>([]);
  const [internal, setInternal] = useState<TerminalBrowserTabRequest[]>([]);

  useEffect(() => {
    const originalBackend = window.orkestrator;
    window.orkestrator = {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "open_in_browser") throw new Error(`Unexpected command: ${command}`);
        setExternal((current) => [...current, String(args?.url)]);
        return undefined as T;
      },
    } as Window["orkestrator"];
    const stopListening = listenForTerminalBrowserTabRequests((request) => {
      setInternal((current) => [...current, request]);
    });
    const store = useTerminalPortalStore.getState();
    const data = store.createTerminal({
      environmentId: "osc-environment",
      tabId: "osc-source-tab",
      containerId: null,
    });
    const terminal = data.terminal;
    terminal.open(hostRef.current!);
    terminal.resize(30, 5);
    // The label is deliberately not a URL: only OSC 8 can make it clickable.
    terminal.write("\x1b]8;;https://example.com/osc-target\x07OSC link\x1b]8;;\x07", () => {
      setReady(true);
    });
    return () => {
      stopListening();
      store.disposeTerminal("osc-environment", "osc-source-tab");
      window.orkestrator = originalBackend;
    };
  }, []);

  return (
    <main>
      <div ref={hostRef} data-testid="osc-terminal" style={{ width: 360, height: 150 }} />
      <output data-testid="osc-ready">{String(ready)}</output>
      <output data-testid="external-opens">{JSON.stringify(external)}</output>
      <output data-testid="internal-opens">{JSON.stringify(internal)}</output>
    </main>
  );
}
