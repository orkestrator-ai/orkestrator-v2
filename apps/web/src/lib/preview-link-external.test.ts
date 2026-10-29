import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import type { PreviewCapabilities } from "@orkestrator/protocol/preview-services";

import { invoke } from "@/lib/native/backend";
import { openLinkExternally } from "@/lib/preview-link-external";
import {
  listenForTerminalBrowserTabRequests,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePreviewServiceStore } from "@/stores/previewServiceStore";
import type { Environment } from "@/types";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const BACKEND = "backend-instance-1";
const SERVICE = "service-0000001";

function capabilities(access = true, tunnel = true): PreviewCapabilities {
  const surface = (available: boolean) => ({ available, upstreamSchemes: ["http" as const] });
  return {
    protocolVersion: 1,
    backendInstanceId: BACKEND,
    backendEpoch: "epoch-1",
    registry: { available: true },
    targets: ["worktree", "container", "backend-host"],
    access: access ? { available: true } : { available: false, reason: "Access is off." },
    surfaces: {
      desktopTunnel: surface(tunnel),
      browserTopLevel: surface(false),
      browserEmbedded: { available: false, platforms: [] },
      legacyPath: { available: true },
    },
    relay: { available: false },
    limits: {} as PreviewCapabilities["limits"],
  };
}

describe("openLinkExternally", () => {
  const originalOrkestrator = window.orkestrator;
  const originalGateway = window.orkestratorGateway;
  let openExternal: ReturnType<typeof mock>;
  let openService: ReturnType<typeof mock>;
  let resolution: unknown;
  let tabRequests: TerminalBrowserTabRequest[];
  let stopListening: () => void;

  beforeEach(() => {
    openExternal = mock(async () => undefined);
    openService = mock(async (_target: BrowserPreviewServiceTarget) => undefined);
    window.orkestrator = {
      ...window.orkestrator,
      shell: { openExternal },
      browserPreview: { ...window.orkestrator?.browserPreview, openServiceExternally: openService },
    } as typeof window.orkestrator;
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net",
    };
    useEnvironmentStore.setState({
      environments: [
        { id: "env-local", environmentType: "local" },
        { id: "env-box", environmentType: "containerized" },
      ] as unknown as Environment[],
    });
    usePreviewServiceStore.setState({ status: "ready", capabilities: capabilities() });
    resolution = {
      kind: "service",
      service: { definition: { serviceId: SERVICE } },
      path: "/start?x=1",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "resolve_preview_target") return resolution;
      return undefined;
    });
    tabRequests = [];
    stopListening = listenForTerminalBrowserTabRequests((request) => tabRequests.push(request));
  });

  afterEach(() => {
    stopListening();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    usePreviewServiceStore.setState({ status: "idle", capabilities: null });
    useEnvironmentStore.setState({ environments: [] });
    window.orkestrator = originalOrkestrator;
    window.orkestratorGateway = originalGateway;
  });

  test("forwards a remote terminal link to its service in the link's environment", async () => {
    await openLinkExternally({
      environmentId: "env-local",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/start?x=1",
    });

    expect(invokeMock).toHaveBeenCalledWith("resolve_preview_target", {
      intent: {
        url: "http://localhost:3000/start?x=1",
        source: "worktree-terminal",
        environmentId: "env-local",
      },
    });
    expect(openService).toHaveBeenCalledWith({
      backendInstanceId: BACKEND,
      environmentId: "env-local",
      serviceId: SERVICE,
      path: "/start?x=1",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("container terminals and agent links resolve with their own semantics", async () => {
    await openLinkExternally({
      environmentId: "env-box",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/",
    });
    await openLinkExternally({
      environmentId: "env-box",
      sourceTabId: "tab-2",
      url: "http://localhost:3000/",
      origin: "agent",
    });
    const sources = invokeMock.mock.calls
      .filter(([command]) => command === "resolve_preview_target")
      .map(([, args]) => (args as { intent: { source: string } }).intent.source);
    expect(sources).toEqual(["container-terminal", "agent-link"]);
  });

  test("an unregistered port opens a preview tab where it can be registered", async () => {
    resolution = {
      kind: "unregistered",
      path: "/",
      suggestion: { targetKind: "worktree", applicationPort: 3000, scheme: "http" },
      bindHint: false,
    };
    await openLinkExternally({
      environmentId: "env-local",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/",
    });

    expect(tabRequests).toEqual([
      {
        environmentId: "env-local",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        origin: "terminal",
      },
    ]);
    expect(openService).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("with preview access off, the link keeps the gateway proxy", async () => {
    usePreviewServiceStore.setState({ status: "ready", capabilities: capabilities(false) });
    await openLinkExternally({
      environmentId: "env-local",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/",
    });

    expect(invokeMock).not.toHaveBeenCalledWith("resolve_preview_target", expect.anything());
    expect(openExternal).toHaveBeenCalledWith(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/3000",
    );
  });

  test("a failed forward falls back to the gateway proxy", async () => {
    openService.mockImplementation(async () => {
      throw new Error("tunnel down");
    });
    await openLinkExternally({
      environmentId: "env-local",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/",
    });
    expect(openExternal).toHaveBeenCalledWith(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/3000",
    );
  });

  test("local connections and non-loopback links use the plain opener", async () => {
    await openLinkExternally({
      environmentId: "env-local",
      sourceTabId: "tab-1",
      url: "https://example.com/docs",
    });
    expect(openExternal).toHaveBeenLastCalledWith("https://example.com/docs");

    window.orkestratorGateway = undefined;
    await openLinkExternally({
      environmentId: "env-local",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/",
    });
    expect(openExternal).toHaveBeenLastCalledWith("http://localhost:3000/");
    expect(openService).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("resolve_preview_target", expect.anything());
  });
});
