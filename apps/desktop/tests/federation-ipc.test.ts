import { describe, expect, mock, test } from "bun:test";
import { BackendPanelViews, PANEL_EVENT_CHANNEL } from "../electron/backend-panel-views";
import { registerFederationIpc, withErrorCode } from "../electron/federation-ipc";
import { SSH_PROMPT_EVENT, SshPromptBroker } from "../electron/ssh-prompt-broker";

const trustedRendererUrl = "http://127.0.0.1:1420";

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const syncHandlers = new Map<
    string,
    (event: { returnValue: unknown }, ...args: unknown[]) => void
  >();
  const deps = {
    ipc: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
      on: (channel: string, listener: (event: never, ...args: unknown[]) => void) => {
        syncHandlers.set(channel, listener as never);
      },
    },
    trustedRendererUrl,
    invokeOn: mock(async () => "ok"),
    observe: mock(() => ({}) as never),
    unobserve: mock(() => undefined),
    gatewaySnapshot: mock(() => ({
      baseUrl: "http://127.0.0.1:41234",
      connectionId: "c1",
      backendId: "bk_1",
      legacyOrigin: null,
      panel: false,
    })),
    connectSsh: mock(async () => ({}) as never),
    probeSshHostKey: mock(async () => ({ probeId: "p", destination: "d", fingerprints: [] })),
    trustSshHostKey: mock(async () => ({ added: 1 })),
    removeRoute: mock(async () => ({}) as never),
    setRouteOrder: mock(async () => ({}) as never),
    setRouteEnabled: mock(async () => ({}) as never),
    useRoute: mock(async () => ({}) as never),
    setAutoConnect: mock(async () => ({}) as never),
    setFeatures: mock(async () => ({}) as never),
    openPanel: mock(async () => ({ panelId: "panel-1" })),
    setPanelBounds: mock(() => undefined),
    setPanelVisible: mock(() => undefined),
    closePanel: mock(() => undefined),
  };
  registerFederationIpc(deps as never);
  const trusted = { senderFrame: { url: `${trustedRendererUrl}/` }, sender: { id: 1 } };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(trusted, ...args);
  return { deps, handlers, syncHandlers, call, trusted };
}

describe("federation IPC", () => {
  test("rejects untrusted senders on every channel", () => {
    const { handlers, deps } = harness();
    const untrusted = { senderFrame: { url: "https://evil.example/" }, sender: { id: 9 } };
    for (const [channel, listener] of handlers) {
      expect(() => listener(untrusted, "c1", "cmd", {})).toThrow("untrusted renderer");
      expect(channel.startsWith("orkestrator:")).toBe(true);
    }
    expect(deps.invokeOn).not.toHaveBeenCalled();
  });

  test("routes commands to an explicit machine and validates the command", async () => {
    const { call, deps } = harness();
    await expect(call("orkestrator:backends:invoke", "c1", "get_projects", { x: 1 })).resolves.toBe(
      "ok",
    );
    expect(deps.invokeOn).toHaveBeenCalledWith(expect.anything(), "c1", "get_projects", { x: 1 });
    expect(() => call("orkestrator:backends:invoke", "", "get_projects")).toThrow();
    expect(() => call("orkestrator:backends:invoke", "c1", 42)).toThrow();
    // A missing args object becomes empty; never undefined into the backend.
    await call("orkestrator:backends:invoke", "c1", "get_projects", ["not", "an", "object"]);
    expect(deps.invokeOn).toHaveBeenLastCalledWith(expect.anything(), "c1", "get_projects", {});
  });

  test("never accepts a URL, port or command line for SSH beyond the validated fields", async () => {
    const { call, deps } = harness();
    await call("orkestrator:connections:connect-ssh", {
      destination: "build",
      remoteGatewayPort: "34121",
      token: "t".repeat(20),
      identityFile: "",
      extra: "-oProxyCommand=evil",
    });
    expect(deps.connectSsh).toHaveBeenCalledWith(expect.anything(), {
      destination: "build",
      remoteGatewayPort: 34121,
      token: "t".repeat(20),
    });
    expect(() => call("orkestrator:connections:connect-ssh", { destination: 3 })).toThrow();
  });

  test("bounds are finite and clamped", () => {
    const { call, deps } = harness();
    call("orkestrator:panels:set-bounds", "panel-1", { x: -4.4, y: 2.6, width: 10, height: 5 });
    expect(deps.setPanelBounds).toHaveBeenCalledWith(expect.anything(), "panel-1", {
      x: 0,
      y: 3,
      width: 10,
      height: 5,
    });
    expect(() =>
      call("orkestrator:panels:set-bounds", "panel-1", { x: Infinity, y: 0, width: 1, height: 1 }),
    ).toThrow("finite");
  });

  test("feature flags accept only booleans", () => {
    const { call, deps } = harness();
    call("orkestrator:connections:set-features", { sshRoutes: false });
    expect(deps.setFeatures).toHaveBeenCalledWith(expect.anything(), { sshRoutes: false });
    expect(() => call("orkestrator:connections:set-features", { sshRoutes: "no" })).toThrow();
  });

  test("the synchronous gateway snapshot answers only trusted senders", () => {
    const { syncHandlers } = harness();
    const trustedEvent = { senderFrame: { url: `${trustedRendererUrl}/` }, returnValue: undefined };
    syncHandlers.get("orkestrator:connections:gateway-sync")!(trustedEvent as never);
    expect(trustedEvent.returnValue).toMatchObject({ baseUrl: "http://127.0.0.1:41234" });
    const untrusted = { senderFrame: { url: "https://evil.example/" }, returnValue: undefined };
    syncHandlers.get("orkestrator:connections:gateway-sync")!(untrusted as never);
    expect(untrusted.returnValue).toBeNull();
  });

  test("typed failures keep their code across IPC", async () => {
    const failure = Object.assign(new Error("Review the fingerprint."), {
      code: "host-key-unknown",
    });
    await expect(withErrorCode(() => Promise.reject(failure))).rejects.toThrow(
      "[host-key-unknown] Review the fingerprint.",
    );
    await expect(withErrorCode(() => Promise.reject(new Error("plain")))).rejects.toThrow(
      /^plain$/,
    );
  });
});

describe("SSH prompt broker", () => {
  test("SH-03: prompts go to one window, are answered once and cancel cleanly", async () => {
    const sent: Array<{ event: string; payload: { promptId: string } }> = [];
    const broker = new SshPromptBroker(() => ({
      id: 7,
      send: (event, payload) => sent.push({ event, payload: payload as { promptId: string } }),
    }));
    const controller = new AbortController();
    const answer = broker.prompt({
      kind: "passphrase",
      message: "Enter passphrase",
      signal: controller.signal,
    });
    const promptId = sent[0]!.payload.promptId;
    expect(sent[0]!.event).toBe(SSH_PROMPT_EVENT);
    broker.answer(8, promptId, "wrong window");
    broker.answer(7, promptId, "secret");
    await expect(answer).resolves.toBe("secret");

    const cancelled = broker.prompt({ kind: "password", message: "pw", signal: controller.signal });
    controller.abort();
    await expect(cancelled).resolves.toBeNull();

    const closing = broker.prompt({
      kind: "password",
      message: "pw",
      signal: new AbortController().signal,
    });
    broker.cancelFor(7);
    await expect(closing).resolves.toBeNull();
  });

  test("without a window to ask, the prompt is declined", async () => {
    const broker = new SshPromptBroker(() => null);
    await expect(
      broker.prompt({ kind: "other", message: "?", signal: new AbortController().signal }),
    ).resolves.toBeNull();
  });
});

describe("backend panel views", () => {
  function fakes() {
    const views: Array<{
      webContents: {
        id: number;
        loaded?: string;
        closed: boolean;
        handlers: Map<string, () => void>;
      };
      bounds?: unknown;
      visible?: boolean;
    }> = [];
    let nextId = 100;
    class FakeView {
      webContents;
      bounds: unknown;
      visible = false;
      constructor(public readonly options: { webPreferences: Record<string, unknown> }) {
        const handlers = new Map<string, () => void>();
        this.webContents = {
          id: nextId++,
          loaded: undefined as string | undefined,
          closed: false,
          handlers,
          session: { webRequest: {} },
          isDestroyed: () => this.webContents.closed,
          close: () => {
            this.webContents.closed = true;
          },
          loadURL: async (url: string) => {
            this.webContents.loaded = url;
          },
          on: (event: string, listener: () => void) => handlers.set(event, listener),
          setWindowOpenHandler: () => undefined,
        };
        views.push(this as never);
      }
      setBounds(bounds: unknown) {
        this.bounds = bounds;
      }
      setVisible(visible: boolean) {
        this.visible = visible;
      }
    }
    const sent: unknown[] = [];
    const parent = {
      id: 1,
      isDestroyed: () => false,
      contentView: { addChildView: mock(() => undefined), removeChildView: mock(() => undefined) },
      webContents: {
        id: 50,
        isDestroyed: () => false,
        send: (_channel: string, payload: unknown) => sent.push(payload),
      },
    };
    const bindScope = mock(async () => undefined);
    const releaseScope = mock(() => undefined);
    const register = mock(() => undefined);
    const unregister = mock(() => undefined);
    const panels = new BackendPanelViews({
      WebContentsViewCtor: FakeView as never,
      preloadPath: "/app/preload.js",
      rendererUrl: "http://127.0.0.1:1420/",
      partitionFor: (connectionId) => `persist:panel-${connectionId}`,
      bindScope,
      releaseScope,
      installRequestAuth: mock(() => undefined),
      installNavigationGuards: mock(() => undefined),
      register,
      unregister,
      maxPanelsPerWindow: 2,
    });
    return { panels, parent, views, bindScope, releaseScope, register, unregister, sent };
  }

  test("each panel is its own renderer bound to its own machine scope", async () => {
    const { panels, parent, views, bindScope } = fakes();
    const { panelId } = await panels.open(parent as never, {
      connectionId: "machine-b",
      projectId: "p1",
      environmentId: "e1",
    });
    expect(bindScope).toHaveBeenCalledWith(`panel:${panelId}`, "machine-b");
    const view = views[0] as never as {
      options: { webPreferences: Record<string, unknown> };
      webContents: { loaded: string };
    };
    expect(view.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:panel-machine-b",
    });
    const url = new URL(view.webContents.loaded);
    expect(url.searchParams.get("panel")).toBe("workspace");
    expect(url.searchParams.get("environment")).toBe("e1");
    // No token, route or port ever appears in the panel URL.
    expect(url.search).not.toContain("token");
  });

  test("OP-06: closing a panel releases its scope only; a window owns at most N panels", async () => {
    const { panels, parent, releaseScope, unregister, sent, views } = fakes();
    const first = await panels.open(parent as never, { connectionId: "a", projectId: "p" });
    await panels.open(parent as never, { connectionId: "b", projectId: "p" });
    await expect(
      panels.open(parent as never, { connectionId: "c", projectId: "p" }),
    ).rejects.toThrow("at most 2");
    expect(() => panels.close(999, first.panelId)).toThrow("no longer open");
    panels.close(50, first.panelId);
    expect(releaseScope).toHaveBeenCalledWith(`panel:${first.panelId}`);
    expect(unregister).toHaveBeenCalledWith(views[0]!.webContents.id);
    expect(sent).toContainEqual({ panelId: first.panelId, type: "closed" });
    panels.closeAllFor(50);
    expect(releaseScope).toHaveBeenCalledTimes(2);
    expect(PANEL_EVENT_CHANNEL).toBe("orkestrator:panels:event");
  });
});
