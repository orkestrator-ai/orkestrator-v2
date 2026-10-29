import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import type { PreviewCapabilities } from "@orkestrator/protocol/preview-services";
import type { Environment } from "../../apps/web/src/types";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { usePreviewServiceStore } from "../../apps/web/src/stores/previewServiceStore";
import { useTerminalPortalStore } from "../../apps/web/src/stores/terminalPortalStore";
import {
  listenForTerminalBrowserTabRequests,
  type TerminalBrowserTabRequest,
} from "../../apps/web/src/lib/terminal-links";

export function TerminalLinksFixture() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [external, setExternal] = useState<string[]>([]);
  const [services, setServices] = useState<BrowserPreviewServiceTarget[]>([]);
  const [resolutions, setResolutions] = useState<unknown[]>([]);
  const [internal, setInternal] = useState<TerminalBrowserTabRequest[]>([]);

  useEffect(() => {
    const originalBackend = window.orkestrator;
    const originalGateway = window.orkestratorGateway;
    const originalEnvironments = useEnvironmentStore.getState().environments;
    const { capabilities: originalCapabilities, status: originalStatus } =
      usePreviewServiceStore.getState();
    const resolution = new URLSearchParams(location.search).get("remote");
    if (resolution) {
      window.orkestratorGateway = {
        enabled: true,
        desktop: true,
        baseUrl: "https://remote.tailnet.ts.net",
      };
      useEnvironmentStore.setState({
        environments: [
          { id: "osc-environment", environmentType: "local" },
        ] as unknown as Environment[],
      });
      usePreviewServiceStore.setState({
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
    const data = store.createTerminal({
      environmentId: "osc-environment",
      tabId: "osc-source-tab",
      containerId: null,
    });
    const terminal = data.terminal;
    terminal.open(hostRef.current!);
    terminal.resize(30, 5);
    // The label is deliberately not a URL: only OSC 8 can make it clickable.
    const url = resolution ? "http://localhost:3000/start?x=1" : "https://example.com/osc-target";
    terminal.write(`\x1b]8;;${url}\x07OSC link\x1b]8;;\x07`, () => {
      setReady(true);
    });
    return () => {
      stopListening();
      store.disposeTerminal("osc-environment", "osc-source-tab");
      window.orkestrator = originalBackend;
      window.orkestratorGateway = originalGateway;
      useEnvironmentStore.setState({ environments: originalEnvironments });
      usePreviewServiceStore.setState({
        capabilities: originalCapabilities,
        status: originalStatus,
      });
    };
  }, []);

  return (
    <main>
      <div ref={hostRef} data-testid="osc-terminal" style={{ width: 360, height: 150 }} />
      <output data-testid="osc-ready">{String(ready)}</output>
      <output data-testid="external-opens">{JSON.stringify(external)}</output>
      <output data-testid="service-opens">{JSON.stringify(services)}</output>
      <output data-testid="resolutions">{JSON.stringify(resolutions)}</output>
      <output data-testid="internal-opens">{JSON.stringify(internal)}</output>
    </main>
  );
}
