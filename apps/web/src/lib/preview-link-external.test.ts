import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { toast } from "sonner";
import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { PreviewCapabilities } from "@orkestrator/protocol/preview-services";

import { invoke } from "@/lib/native/backend";
import { openLinkExternally } from "@/lib/preview-link-external";
import {
  listenForTerminalBrowserTabRequests,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import { environmentStore } from "@/stores/environmentStore";
import { previewServiceStore } from "@/stores/previewServiceStore";
import type { Environment } from "@/types";
import { appCommandStore } from "@/test/app-command-store";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";

const LEAF = "bk_leaf-mbp" as BackendId;

/** A leaf node client with the loopback resolver a real leaf lease has. */
function leafClient(): FakeNodeClient {
  return Object.assign(new FakeNodeClient({ nodeId: LEAF }), {
    resolveLoopbackUrl: (url: string) =>
      `https://workstation.tailnet.ts.net/__orkestrator/nodes/${LEAF}/__orkestrator/proxy/loopback/${new URL(url).port}`,
  });
}

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const BACKEND = "backend-instance-1";
const SERVICE = "service-0000001";

function capabilities(access = true, tunnel = true, publication = false): PreviewCapabilities {
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
      browserTopLevel: surface(publication),
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
  const info = spyOn(toast, "info");

  beforeEach(() => {
    info.mockClear();
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
    appCommandStore(environmentStore).setState({
      environments: [
        { id: "env-local", environmentType: "local" },
        { id: "env-box", environmentType: "containerized" },
      ] as unknown as Environment[],
    });
    appCommandStore(previewServiceStore).setState({
      status: "ready",
      capabilities: capabilities(),
    });
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

  let windowScope: WindowScope | null = null;

  afterEach(() => {
    windowScope?.dispose();
    windowScope = null;
    window.orkestratorDesktopIdentity = undefined;
    stopListening();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    appCommandStore(previewServiceStore).setState({ status: "idle", capabilities: null });
    appCommandStore(environmentStore).setState({ environments: [] });
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

  test("publication is available to terminal and agent links without a desktop tunnel", async () => {
    appCommandStore(previewServiceStore).setState({
      capabilities: capabilities(true, false, true),
    });
    for (const origin of ["terminal", "agent"] as const) {
      await openLinkExternally({
        environmentId: "env-local",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        origin,
      });
    }
    expect(openService).toHaveBeenCalledTimes(2);
    expect(openExternal).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  for (const failure of ["unsupported", "null", "rejected", "resolution"] as const) {
    test(`${failure} fallback explains gateway proxy routing`, async () => {
      appCommandStore(previewServiceStore).setState({ status: "idle", capabilities: null });
      invokeMock.mockImplementation(async (command: string) => {
        if (command === "get_preview_capabilities") {
          if (failure === "rejected") throw new Error("backend disconnected");
          if (failure === "unsupported")
            throw { category: "unsupported", message: "Unknown command" };
          return failure === "resolution" ? capabilities() : null;
        }
        if (command === "resolve_preview_target") throw new Error("resolution failed");
        return undefined;
      });
      await openLinkExternally({
        environmentId: "env-local",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
      });
      expect(openExternal).toHaveBeenCalledWith(
        "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/3000",
      );
      expect(openService).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith("Opened through the gateway proxy", {
        description: expect.any(String),
      });
    });
  }

  test("with preview access off, the link keeps the gateway proxy", async () => {
    appCommandStore(previewServiceStore).setState({
      status: "ready",
      capabilities: capabilities(false),
    });
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

  test("a link from an environment on this computer opens as written", async () => {
    window.orkestratorDesktopIdentity = {
      connectionId: "connection-1",
      backendId: "bk_command-mini",
      legacyOrigin: null,
      localInstallationId: LEAF,
    };
    windowScope = new WindowScope();
    const leaf = windowScope.open({ role: "leaf", client: leafClient() });
    leaf.store(environmentStore).setState({
      environments: [{ id: "env-here", environmentType: "local" }] as unknown as Environment[],
    });

    await openLinkExternally({
      environmentId: "env-here",
      sourceTabId: "tab-1",
      url: "http://127.0.0.1:3917/browser-tests/app-shell?surface=a",
      origin: "agent",
      scope: leaf,
    });

    expect(openExternal).toHaveBeenCalledWith(
      "http://127.0.0.1:3917/browser-tests/app-shell?surface=a",
    );
    expect(openService).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("resolve_preview_target", expect.anything());
    expect(info).not.toHaveBeenCalled();
  });

  test("a fallback for a leaf on another computer uses that leaf's proxy", async () => {
    window.orkestratorDesktopIdentity = {
      connectionId: "connection-1",
      backendId: "bk_command-mini",
      legacyOrigin: null,
      localInstallationId: "bk_some-other-machine",
    };
    windowScope = new WindowScope();
    const leaf = windowScope.open({ role: "leaf", client: leafClient() });

    await openLinkExternally({
      environmentId: "env-unknown-here",
      sourceTabId: "tab-1",
      url: "http://localhost:3000/",
      scope: leaf,
    });

    expect(openExternal).toHaveBeenCalledWith(
      `https://workstation.tailnet.ts.net/__orkestrator/nodes/${LEAF}/__orkestrator/proxy/loopback/3000`,
    );
  });
});
