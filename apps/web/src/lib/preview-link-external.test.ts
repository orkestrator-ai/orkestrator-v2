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
import { createDesktopNodeClient } from "@/lib/node-scope/desktop-node-client";
import type { NodeClient } from "@orkestrator/protocol/node-client";

const LEAF = "bk_leaf-mbp" as BackendId;
const COMMAND_NODE = "bk_command-mini" as BackendId;
const LEAF_PROXY = `https://workstation.tailnet.ts.net/__orkestrator/nodes/${LEAF}/__orkestrator/proxy/loopback`;
const COMMAND_PROXY = "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback";

/**
 * A leaf node client with the external loopback resolver a real leaf lease
 * has, answering the preview commands from `responses` (read at call time).
 */
function leafClient(responses: Record<string, (args: unknown) => unknown> = {}): FakeNodeClient {
  const client = new FakeNodeClient({ nodeId: LEAF, invoke: responses });
  return Object.assign(client, {
    resolveExternalLoopbackUrl: async (url: string) => `${LEAF_PROXY}/${new URL(url).port}`,
  });
}

/** The preload API a desktop leaf client reads: one node's transport and `nodes.gateway`. */
function desktopHost(baseUrl: string | null, invoke: (command: string) => unknown) {
  const gateway = mock(async (nodeId: string) =>
    baseUrl === null ? null : { nodeId, commandNode: false, baseUrl },
  );
  const nodeApi = {
    nodeId: LEAF,
    invoke: mock(async (command: string) => invoke(command)),
    listen: () => () => undefined,
    eventStreamReady: async () => undefined,
    eventStreamConnection: { state: () => "connected", subscribe: () => () => undefined },
  };
  const api = {
    node: () => nodeApi,
    nodes: { release: async () => undefined, gateway },
  } as unknown as NonNullable<Window["orkestrator"]>;
  return { api, gateway, nodeApi };
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
  const error = spyOn(toast, "error");

  beforeEach(() => {
    info.mockClear();
    error.mockClear();
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

  /** The window's identity: the command node, and whether `LEAF` is this computer. */
  function identify(
    leafIsHere: boolean,
    local: string = leafIsHere ? LEAF : "bk_some-other-machine",
  ) {
    window.orkestratorDesktopIdentity = {
      connectionId: "connection-1",
      backendId: COMMAND_NODE,
      legacyOrigin: null,
      localInstallationId: local,
    };
  }

  /** A leaf scope holding `environments`, with ready preview capabilities. */
  function openLeaf(
    client: NodeClient,
    environments: Array<Pick<Environment, "id" | "environmentType">> = [],
    caps: PreviewCapabilities | null = capabilities(),
  ) {
    windowScope = new WindowScope();
    const leaf = windowScope.open({ role: "leaf", client });
    leaf.store(environmentStore).setState({
      environments: environments as unknown as Environment[],
    });
    leaf
      .store(previewServiceStore)
      .setState(
        caps ? { status: "ready", capabilities: caps } : { status: "idle", capabilities: null },
      );
    return leaf;
  }

  const resolveCalls = (client: FakeNodeClient) =>
    client.invocations.filter(({ command }) => command === "resolve_preview_target");

  describe("an environment on this computer", () => {
    test("a worktree link from a leaf on this computer opens as written", async () => {
      identify(true);
      const client = leafClient();
      const leaf = openLeaf(client, [{ id: "env-here", environmentType: "local" }]);

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
      expect(resolveCalls(client)).toEqual([]);
      expect(info).not.toHaveBeenCalled();
    });

    test("a locally connected window opens a this-computer leaf's link as written", async () => {
      window.orkestratorGateway = undefined;
      identify(true);
      const client = leafClient();
      const leaf = openLeaf(client, [{ id: "env-here", environmentType: "local" }]);

      await openLinkExternally({
        environmentId: "env-here",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(openExternal.mock.calls).toEqual([["http://localhost:3000/"]]);
      expect(resolveCalls(client)).toEqual([]);
    });

    for (const proof of ["identity", "gateway"] as const) {
      test(`the command node on this computer (${proof}) opens a worktree link as written`, async () => {
        if (proof === "identity") identify(false, COMMAND_NODE);
        else
          window.orkestratorGateway = { ...window.orkestratorGateway!, backendOnThisDevice: true };

        await openLinkExternally({
          environmentId: "env-local",
          sourceTabId: "tab-1",
          url: "http://localhost:3000/start?x=1",
        });

        expect(openExternal.mock.calls).toEqual([["http://localhost:3000/start?x=1"]]);
        expect(invokeMock).not.toHaveBeenCalledWith("resolve_preview_target", expect.anything());
        expect(openService).not.toHaveBeenCalled();
      });
    }

    test("a container's links on a this-computer leaf still resolve to their service", async () => {
      identify(true);
      // The container's port 3000 is published on another host port: only the
      // service knows which, so opening localhost:3000 here would be wrong.
      const client = leafClient({ resolve_preview_target: () => resolution });
      const leaf = openLeaf(client, [{ id: "env-box-here", environmentType: "containerized" }]);

      for (const origin of ["terminal", "agent"] as const) {
        await openLinkExternally({
          environmentId: "env-box-here",
          sourceTabId: "tab-1",
          url: "http://localhost:3000/start?x=1",
          origin,
          scope: leaf,
        });
      }

      expect(
        resolveCalls(client).map(
          ({ args }) => (args as { intent: { source: string } }).intent.source,
        ),
      ).toEqual(["container-terminal", "agent-link"]);
      expect(openService.mock.calls).toEqual([
        [
          {
            backendInstanceId: BACKEND,
            environmentId: "env-box-here",
            serviceId: SERVICE,
            path: "/start?x=1",
          },
        ],
        [
          {
            backendInstanceId: BACKEND,
            environmentId: "env-box-here",
            serviceId: SERVICE,
            path: "/start?x=1",
          },
        ],
      ]);
      expect(openExternal).not.toHaveBeenCalled();
    });

    test("a container's links on a this-computer command node still resolve to their service", async () => {
      identify(false, COMMAND_NODE);
      for (const origin of ["terminal", "agent"] as const) {
        await openLinkExternally({
          environmentId: "env-box",
          sourceTabId: "tab-1",
          url: "http://localhost:3000/start?x=1",
          origin,
        });
      }

      const sources = invokeMock.mock.calls
        .filter(([command]) => command === "resolve_preview_target")
        .map(([, args]) => (args as { intent: { source: string } }).intent.source);
      expect(sources).toEqual(["container-terminal", "agent-link"]);
      expect(openService).toHaveBeenCalledTimes(2);
      expect(openExternal).not.toHaveBeenCalled();
    });
  });

  describe("a leaf on another computer", () => {
    test("an unknown environment's link uses that leaf's proxy", async () => {
      identify(false);
      const leaf = openLeaf(leafClient());

      await openLinkExternally({
        environmentId: "env-unknown-here",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(openExternal.mock.calls).toEqual([[`${LEAF_PROXY}/3000`]]);
    });

    for (const failure of ["capabilities", "access", "resolution", "forward"] as const) {
      test(`a ${failure} failure falls back to the leaf's proxy, never the command node's`, async () => {
        identify(false);
        const client = leafClient({
          get_preview_capabilities: () => null,
          resolve_preview_target: () => {
            if (failure === "resolution") throw new Error("resolution failed");
            return resolution;
          },
        });
        if (failure === "forward") {
          openService.mockImplementation(async () => {
            throw new Error("tunnel down");
          });
        }
        const caps = failure === "capabilities" ? null : capabilities(failure !== "access");
        const leaf = openLeaf(client, [{ id: "env-there", environmentType: "local" }], caps);

        await openLinkExternally({
          environmentId: "env-there",
          sourceTabId: "tab-1",
          url: "http://localhost:3000/",
          scope: leaf,
        });

        expect(openExternal.mock.calls).toEqual([[`${LEAF_PROXY}/3000`]]);
        expect(openExternal).not.toHaveBeenCalledWith(`${COMMAND_PROXY}/3000`);
        expect(invokeMock).not.toHaveBeenCalledWith("open_in_browser", expect.anything());
        expect(openService).toHaveBeenCalledTimes(failure === "forward" ? 1 : 0);
      });
    }

    test("without a shell opener the fallback still addresses the leaf", async () => {
      identify(false);
      window.orkestrator = { ...window.orkestrator, shell: undefined } as typeof window.orkestrator;
      const leaf = openLeaf(leafClient());

      await openLinkExternally({
        environmentId: "env-unknown-here",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(invokeMock).toHaveBeenCalledWith("open_in_browser", { url: `${LEAF_PROXY}/3000` });
    });

    test("a client that cannot address the leaf's ports opens nothing and says so", async () => {
      identify(false);
      const leaf = openLeaf(new FakeNodeClient({ nodeId: LEAF }));

      await openLinkExternally({
        environmentId: "env-unknown-here",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(openExternal).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("open_in_browser", expect.anything());
      expect(error).toHaveBeenCalledWith("Could not open the link", {
        description: expect.any(String),
      });
    });
  });

  describe("a desktop leaf client", () => {
    function desktopLeaf(
      baseUrl: string | null,
      invoke: (command: string) => unknown = () => null,
    ) {
      const host = desktopHost(baseUrl, invoke);
      const client = createDesktopNodeClient({
        nodeId: LEAF,
        host: () => host.api,
        commandNodeId: COMMAND_NODE,
      });
      return { host, client };
    }

    test("an unknown environment's link goes through the leaf's own route", async () => {
      identify(false);
      const { host, client } = desktopLeaf("http://127.0.0.1:45001");
      const leaf = openLeaf(client);

      await openLinkExternally({
        environmentId: "env-unknown-here",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/app",
        scope: leaf,
      });

      expect(openExternal.mock.calls).toEqual([
        ["http://127.0.0.1:45001/__orkestrator/proxy/loopback/3000/app"],
      ]);
      expect(host.gateway).toHaveBeenCalledWith(LEAF);
    });

    test("with preview access off, the leaf's route still carries the link", async () => {
      identify(false);
      const { client } = desktopLeaf(
        `https://workstation.tailnet.ts.net/__orkestrator/nodes/${LEAF}`,
      );
      const leaf = openLeaf(
        client,
        [{ id: "env-there", environmentType: "local" }],
        capabilities(false),
      );

      await openLinkExternally({
        environmentId: "env-there",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(openExternal.mock.calls).toEqual([[`${LEAF_PROXY}/3000`]]);
      expect(openService).not.toHaveBeenCalled();
    });

    test("a failed forward falls back to the leaf's route", async () => {
      identify(false);
      openService.mockImplementation(async () => {
        throw new Error("tunnel down");
      });
      const { client } = desktopLeaf("http://127.0.0.1:45001", (command) =>
        command === "resolve_preview_target" ? resolution : null,
      );
      const leaf = openLeaf(client, [{ id: "env-there", environmentType: "local" }]);

      await openLinkExternally({
        environmentId: "env-there",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(openService).toHaveBeenCalledTimes(1);
      expect(openExternal.mock.calls).toEqual([
        ["http://127.0.0.1:45001/__orkestrator/proxy/loopback/3000"],
      ]);
    });

    test("a leaf with no route opens nothing rather than the command node's port", async () => {
      identify(false);
      const { client } = desktopLeaf(null);
      const leaf = openLeaf(client);

      await openLinkExternally({
        environmentId: "env-unknown-here",
        sourceTabId: "tab-1",
        url: "http://localhost:3000/",
        scope: leaf,
      });

      expect(openExternal).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("open_in_browser", expect.anything());
      expect(error).toHaveBeenCalledWith("Could not open the link", {
        description: expect.stringContaining("reconnecting"),
      });
    });
  });
});
