import { describe, expect, mock, test } from "bun:test";
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
    gatewaySnapshot: mock(() => ({
      baseUrl: "http://127.0.0.1:41234",
      connectionId: "c1",
      backendId: "bk_1",
      legacyOrigin: null,
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
    openWorkspaceView: mock(async () => ({ viewId: "v1" })),
    setWorkspaceViewBounds: mock(() => undefined),
    setWorkspaceViewVisible: mock(() => undefined),
    captureWorkspaceView: mock(async () => null),
    sendToWorkspaceView: mock(() => undefined),
    closeWorkspaceView: mock(() => undefined),
    postFromWorkspaceRealm: mock(() => undefined),
    portalInvoke: mock(async () => ({ ok: true })),
  };
  registerFederationIpc(deps as never);
  const trusted = { senderFrame: { url: `${trustedRendererUrl}/` }, sender: { id: 1 } };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(trusted, ...args);
  return { deps, handlers, syncHandlers, call, trusted };
}

describe("federation IPC", () => {
  test("explicit board intent survives initial realm creation and rejects unknown tabs", async () => {
    const { call, deps } = harness();
    for (const boardTab of ["coordinator", "kanban", "github", "linear", "features", "invalid"]) {
      await call("orkestrator:workspace-views:open", {
        nodeId: "bk_leaf",
        request: { projectId: "p", boardTab },
      });
      expect(deps.openWorkspaceView).toHaveBeenLastCalledWith(expect.anything(), {
        nodeId: "bk_leaf",
        search: { project: "p", ...(boardTab === "invalid" ? {} : { boardTab }) },
      });
    }
  });

  test("rejects untrusted senders on every channel", () => {
    const { handlers, deps } = harness();
    const untrusted = { senderFrame: { url: "https://evil.example/" }, sender: { id: 9 } };
    for (const [channel, listener] of handlers) {
      expect(() => listener(untrusted, "c1", "cmd", {})).toThrow("untrusted renderer");
      expect(channel.startsWith("orkestrator:")).toBe(true);
    }
    expect(deps.openWorkspaceView).not.toHaveBeenCalled();
    expect(deps.portalInvoke).not.toHaveBeenCalled();
  });

  test("CL-02/CR-04: the renderer cannot invoke or observe other machines through main", () => {
    const { handlers } = harness();
    for (const channel of [
      "orkestrator:backends:invoke",
      "orkestrator:backends:observe",
      "orkestrator:backends:unobserve",
    ]) {
      expect(handlers.has(channel)).toBe(false);
    }
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

  test("a workspace realm opens on a node and IDs, nothing else", async () => {
    const { call, deps } = harness();
    await call("orkestrator:workspace-views:open", {
      nodeId: "bk_leaf",
      baseUrl: "https://evil.example",
      request: { projectId: "p", environmentId: "e", url: "https://evil.example" },
    });
    expect(deps.openWorkspaceView).toHaveBeenCalledWith(expect.anything(), {
      nodeId: "bk_leaf",
      search: { project: "p", environment: "e" },
    });
    await call("orkestrator:workspace-views:open", {
      nodeId: "bk_leaf",
      request: { addProject: true, createEnvironmentProjectId: "p" },
    });
    expect(deps.openWorkspaceView).toHaveBeenLastCalledWith(expect.anything(), {
      nodeId: "bk_leaf",
      search: { addProject: "1", createEnvironment: "p" },
    });
    await call("orkestrator:workspace-views:open", {
      nodeId: "bk_leaf",
      request: { projectId: "p", environmentId: "e", dialog: "environment-settings" },
    });
    expect(deps.openWorkspaceView).toHaveBeenLastCalledWith(expect.anything(), {
      nodeId: "bk_leaf",
      search: { project: "p", environment: "e", dialog: "environment-settings" },
    });
    await call("orkestrator:workspace-views:open", {
      nodeId: "bk_leaf",
      request: { projectId: "p", dialog: "environment-settings" },
    });
    expect(deps.openWorkspaceView).toHaveBeenLastCalledWith(expect.anything(), {
      nodeId: "bk_leaf",
      search: { project: "p" },
    });
    expect(() => call("orkestrator:workspace-views:open", { nodeId: 3 })).toThrow("node ID");
  });

  test("a workspace realm is placed with finite bounds and small messages", () => {
    const { call, deps } = harness();
    call("orkestrator:workspace-views:set-bounds", "v1", { x: 1, y: 2, width: 3, height: -4 });
    expect(deps.setWorkspaceViewBounds).toHaveBeenCalledWith(expect.anything(), "v1", {
      x: 1,
      y: 2,
      width: 3,
      height: 0,
    });
    expect(() =>
      call("orkestrator:workspace-views:set-bounds", "v1", { x: "1", y: 0, width: 1, height: 1 }),
    ).toThrow();
    expect(() => call("orkestrator:workspace-views:set-visible", "v1", "yes")).toThrow();
    call("orkestrator:workspace-realm:post", { type: "ready" });
    expect(deps.postFromWorkspaceRealm).toHaveBeenCalledWith(expect.anything(), { type: "ready" });
    expect(() =>
      call("orkestrator:workspace-views:send", "v1", { type: "select", pad: "x".repeat(5000) }),
    ).toThrow("too large");
  });

  test("the portal channel carries a command and its arguments only", async () => {
    const { call, deps } = harness();
    await call("orkestrator:portal:invoke", "get_node_summaries", { includeSelf: true });
    expect(deps.portalInvoke).toHaveBeenCalledWith(expect.anything(), "get_node_summaries", {
      includeSelf: true,
    });
    expect(() => call("orkestrator:portal:invoke", "", {})).toThrow("command");
    expect(() => call("orkestrator:portal:invoke", "x", ["array"])).toThrow();
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
