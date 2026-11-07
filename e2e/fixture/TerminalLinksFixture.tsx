import { createXtermTerminal } from "../../apps/web/src/lib/terminal-xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import type { PreviewCapabilities } from "@orkestrator/protocol/preview-services";
import type { Environment } from "../../apps/web/src/types";
import { useConfigStore } from "../../apps/web/src/stores/configStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { usePreviewServiceStore } from "../../apps/web/src/stores/previewServiceStore";
import { useTerminalPortalStore } from "../../apps/web/src/stores/terminalPortalStore";
import { getWindowScope } from "../../apps/web/src/lib/node-scope/app-window-scope";
import {
  listenForTerminalBrowserTabRequests,
  type TerminalBrowserTabRequest,
} from "../../apps/web/src/lib/terminal-links";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

export function TerminalLinksFixture() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState<string[]>([]);
  const [selection, setSelection] = useState("");
  const [external, setExternal] = useState<string[]>([]);
  const [services, setServices] = useState<BrowserPreviewServiceTarget[]>([]);
  const [resolutions, setResolutions] = useState<unknown[]>([]);
  const [internal, setInternal] = useState<TerminalBrowserTabRequest[]>([]);

  useEffect(() => {
    const originalBackend = window.orkestrator;
    const originalGateway = window.orkestratorGateway;
    const originalEnvironments = appCommandStore(useEnvironmentStore.def).getState().environments;
    const { capabilities: originalCapabilities, status: originalStatus } = appCommandStore(
      usePreviewServiceStore.def,
    ).getState();
    const originalConfig = appCommandStore(useConfigStore.def).getState().config;
    const search = new URLSearchParams(location.search);
    if (search.get("defaultTarget") === "browser-tab") {
      appCommandStore(useConfigStore.def).setState({
        config: {
          ...originalConfig,
          global: { ...originalConfig.global, terminalLinkDefaultTarget: "browser-tab" },
        },
      });
    }
    const resolution = search.get("remote");
    if (resolution) {
      window.orkestratorGateway = {
        enabled: true,
        desktop: true,
        baseUrl: "https://remote.tailnet.ts.net",
      };
      appCommandStore(useEnvironmentStore.def).setState({
        environments: [
          { id: "osc-environment", environmentType: "local" },
        ] as unknown as Environment[],
      });
      appCommandStore(usePreviewServiceStore.def).setState({
        status: "ready",
        capabilities: {
          backendInstanceId: "backend-instance-1",
          access: { available: true },
          surfaces: { desktopTunnel: { available: true }, browserTopLevel: { available: false } },
        } as PreviewCapabilities,
      });
    }
    window.orkestrator = {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command === "resolve_preview_target") {
          setResolutions((current) => [...current, args?.intent]);
          return {
            kind: resolution,
            service: { definition: { serviceId: "service-0000001" } },
            path: "/start?x=1",
          } as T;
        }
        if (command !== "open_in_browser") throw new Error(`Unexpected command: ${command}`);
        setExternal((current) => [...current, String(args?.url)]);
        return undefined as T;
      },
      browserPreview: {
        openServiceExternally: async (target: BrowserPreviewServiceTarget) => {
          setServices((current) => [...current, target]);
        },
      },
    } as Window["orkestrator"];
    const stopListening = listenForTerminalBrowserTabRequests((request) => {
      setInternal((current) => [...current, request]);
    });
    const store = useTerminalPortalStore.getState();
    // The fixture renders no node scope: its terminal is the command node's.
    const nodeId = getWindowScope().commandScope().nodeId;
    const data = store.createTerminal(
      {
        nodeId,
        environmentId: "osc-environment",
        tabId: "osc-source-tab",
        containerId: null,
      },
      createXtermTerminal,
    );
    const terminal = data.terminal;
    terminal.open(hostRef.current!);
    terminal.resize(30, 5);
    const stopData = terminal.onData((data) => setInput((current) => [...current, data]));
    const stopSelection = terminal.onSelectionChange(() => setSelection(terminal.getSelection()));
    // The label is deliberately not a URL: only OSC 8 can make it clickable.
    const url =
      resolution || search.get("local") === "true"
        ? "http://localhost:3000/start?x=1"
        : "https://example.com/osc-target";
    const content = search.has("selection")
      ? `abcdefghij\r\nklmnopqrst\r\nuvwxyz\x1b[1;1H${search.get("selection") === "mouse" ? "\x1b[?1000h\x1b[?1006h" : ""}`
      : `\x1b]8;;${url}\x07OSC link\x1b]8;;\x07`;
    terminal.write(content, () => {
      setReady(true);
    });
    return () => {
      stopData.dispose();
      stopSelection.dispose();
      stopListening();
      store.disposeTerminal(nodeId, "osc-environment", "osc-source-tab");
      window.orkestrator = originalBackend;
      window.orkestratorGateway = originalGateway;
      appCommandStore(useConfigStore.def).setState({ config: originalConfig });
      appCommandStore(useEnvironmentStore.def).setState({ environments: originalEnvironments });
      appCommandStore(usePreviewServiceStore.def).setState({
        capabilities: originalCapabilities,
        status: originalStatus,
      });
    };
  }, []);

  return (
    <main>
      <div ref={hostRef} data-testid="osc-terminal" style={{ width: 360, height: 150 }} />
      <output data-testid="terminal-input">{JSON.stringify(input)}</output>
      <output data-testid="terminal-selection">{selection}</output>
      <output data-testid="osc-ready">{String(ready)}</output>
      <output data-testid="external-opens">{JSON.stringify(external)}</output>
      <output data-testid="service-opens">{JSON.stringify(services)}</output>
      <output data-testid="resolutions">{JSON.stringify(resolutions)}</output>
      <output data-testid="internal-opens">{JSON.stringify(internal)}</output>
    </main>
  );
}
