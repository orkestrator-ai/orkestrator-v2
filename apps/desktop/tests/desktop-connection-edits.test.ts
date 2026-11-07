import { expect, mock, setSystemTime, test } from "bun:test";
import { NodeWorkspaceScopes, WORKSPACE_DIRECT_RETRY_MS } from "../electron/node-workspaces";
import {
  editDesktopConnection,
  type ConnectionEditContext,
} from "../electron/desktop-connection-edits";
import { openWorkspaceScope, type WorkspaceTarget } from "../electron/node-scopes";

/**
 * A window on its command node ("window" bound to "command"), with a node
 * scope opened through `openWorkspaceScope` as `DesktopNodeScopes` opens one.
 */
function harness() {
  const routes = new Map([
    ["window", "command"],
    ["window:node:A:command", "command"],
  ]);
  const revoked: string[] = [];
  let destroyed = false;
  let open: (() => Promise<void>) | null = null;
  let directOrigin: string | null = null;
  const grantIds = new Map<string, number>();
  const context: ConnectionEditContext = {
    scope: "window",
    window: { isDestroyed: () => destroyed },
  };
  const invoke = mock((command: string, args: Record<string, unknown>, scope = "window") => {
    if (!routes.has(scope)) throw new Error("Scope is released");
    return (async () => {
      if (command === "close_node_workspace") {
        revoked.push(String(args.workspaceId));
        return {};
      }
      if (command === "open_node_workspace") {
        await open?.();
        const grantId = grantIds.get(String(args.nodeId)) ?? 0;
        grantIds.set(String(args.nodeId), grantId + 1);
        return {
          workspaceId: `grant-${args.nodeId}${grantId ? `-${grantId + 1}` : ""}`,
          nodeId: args.nodeId,
          nodeName: args.nodeId,
          grant: { token: "grant", expiresAt: Date.now() + 900000 },
          directOrigins: directOrigin ? [directOrigin] : [],
          relayBase: "/relay",
        };
      }
      return { displayName: "Command" };
    })();
  });
  const scopes = new NodeWorkspaceScopes(invoke);
  const manager = {
    bind: mock(async (scope: string, id: string) => {
      if (routes.has(scope)) throw new Error("already bound");
      routes.set(scope, id);
    }),
    getConnectionId: (scope: string) => routes.get(scope)!,
    invoke,
    getGatewayBaseUrl: () => "https://command.test",
    getRendererRequestAuthorization: () => "Bearer command",
    retargetScopeToWorkspace: (scope: string, input: { workspaceId: string }) => {
      routes.set(scope, input.workspaceId);
    },
    release: (scope: string) => {
      routes.delete(scope);
    },
    epochOf: () => 1,
    rebindWorkspace: mock((_scope: string, _binding: unknown) => undefined),
  };
  let target: WorkspaceTarget | null = null;
  const openNode = async (nodeId: string) => {
    target = await openWorkspaceScope({
      scope: `window:node:${nodeId}`,
      commandScope: `window:node:${nodeId}:command`,
      nodeId,
      manager: manager as never,
      scopes,
      closed: () => destroyed,
      closedMessage: "Window closed",
      rebound: (replacement) => {
        target = replacement;
      },
    });
    return target;
  };
  return {
    context,
    routes,
    revoked,
    scopes,
    manager,
    openNode,
    target: () => target,
    direct: (origin: string) => {
      directOrigin = origin;
    },
    hold: (value: () => Promise<void>) => {
      open = value;
    },
    close: () => {
      destroyed = true;
      scopes.release("window:node:A");
      manager.release("window:node:A");
      manager.release("window:node:A:command");
      manager.release("window");
    },
  };
}

test("nonselecting additions and inactive removals keep the window's node scopes", async () => {
  const h = harness();
  const connect = mock(async (_input: unknown, _scope: string) => ({}));
  const forget = mock(async (_id: string, _scope: string) => ({}));
  const manager = { ...h.manager, connect, forget, getList: () => ({}) };
  const release = mock(async () => undefined);
  await editDesktopConnection(
    h.context,
    { kind: "connect", input: { address: "https://other.test", token: "unused", select: false } },
    manager as never,
    release,
  );
  await editDesktopConnection(
    h.context,
    { kind: "forget", connectionId: "inactive" },
    manager as never,
    release,
  );
  expect(connect.mock.calls[0]?.[1]).toBe("window");
  expect(forget.mock.calls[0]?.[1]).toBe("window");
  expect(release).not.toHaveBeenCalled();
});

test("a selecting edit releases the window's node scopes once it has succeeded", async () => {
  const h = harness();
  const order: string[] = [];
  const manager = {
    ...h.manager,
    use: async (connectionId: string, scope: string) => {
      order.push(`use ${connectionId} on ${scope}`);
      h.routes.set(scope, connectionId);
    },
    forget: async (connectionId: string, scope: string) => {
      order.push(`forget ${connectionId} on ${scope}`);
      h.routes.set(scope, "local");
    },
    getList: (scope: string) => ({ activeConnectionId: h.routes.get(scope) }),
  };
  const release = mock(async () => {
    order.push("release");
  });
  expect(
    await editDesktopConnection(
      h.context,
      { kind: "use", connectionId: "B" },
      manager as never,
      release,
    ),
  ).toEqual({ activeConnectionId: "B" } as never);
  // Forgetting the window's own connection moves it too.
  await editDesktopConnection(
    h.context,
    { kind: "forget", connectionId: "B" },
    manager as never,
    release,
  );
  expect(order).toEqual(["use B on window", "release", "forget B on window", "release"]);
});

test("a failed selecting edit keeps the command binding and the node scopes", async () => {
  const h = harness();
  try {
    await h.openNode("A");
    const release = mock(async () => undefined);
    const manager = {
      ...h.manager,
      use: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(
      editDesktopConnection(
        h.context,
        { kind: "use", connectionId: "B" },
        manager as never,
        release,
      ),
    ).rejects.toThrow("unreachable");
    expect(release).not.toHaveBeenCalled();
    expect(h.routes.get("window")).toBe("command");
    expect(h.routes.get("window:node:A")).toBe("grant-A");
    expect(h.revoked).toEqual([]);
  } finally {
    h.scopes.releaseAll();
  }
});

test("competing edits on one window are refused until the first settles", async () => {
  const h = harness();
  let resolve: (() => void) | undefined;
  const manager = {
    ...h.manager,
    // Only the first edit waits.
    use: () =>
      resolve
        ? Promise.resolve()
        : new Promise<void>((done) => {
            resolve = done;
          }),
    getList: () => ({}),
  };
  const first = editDesktopConnection(
    h.context,
    { kind: "use", connectionId: "B" },
    manager as never,
    async () => undefined,
  );
  while (!resolve) await Promise.resolve();
  await expect(
    editDesktopConnection(
      h.context,
      { kind: "use", connectionId: "C" },
      manager as never,
      async () => undefined,
    ),
  ).rejects.toThrow("already in progress");
  resolve?.();
  await first;
  await editDesktopConnection(
    h.context,
    { kind: "use", connectionId: "C" },
    manager as never,
    async () => undefined,
  );
});

async function settled() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test("closing a window during a node scope's retry keeps command access until both grants are revoked", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00Z"));
  const h = harness();
  try {
    await h.openNode("A");
    let resume!: () => void;
    h.hold(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    h.scopes.noteUse("window:node:A");
    await settled();
    expect(resume).toBeDefined();
    expect(
      Array.from(h.routes.keys()).some((scope) =>
        scope.startsWith("window:node:A:workspace-retry:"),
      ),
    ).toBe(true);
    h.close();
    resume();
    await settled();
    expect(h.revoked.sort()).toEqual(["grant-A", "grant-A-2"]);
    expect(h.routes.size).toBe(0);
    expect(h.manager.rebindWorkspace).not.toHaveBeenCalled();
  } finally {
    h.scopes.releaseAll();
    setSystemTime();
  }
});

for (const direct of [false, true]) {
  test(`opening a ${direct ? "direct" : "relayed"} node scope ${direct ? "does not arm" : "arms"} use retries`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({
        schemaVersion: 1,
        installationId: "bk_a",
        generation: "generation-A",
        appVersion: "2.30.0",
        clientApi: { minVersion: 1, maxVersion: 1 },
        capabilities: {},
        endpointRole: "client",
        profile: {
          revision: 1,
          displayName: "A",
          colorToken: "blue",
          updatedAt: "2026-10-25T00:00:00Z",
        },
      }),
    ) as unknown as typeof fetch;
    setSystemTime(new Date("2026-10-25T00:00:00Z"));
    const h = harness();
    h.routes.set("window:node:bk_a:command", "command");
    try {
      if (direct) h.direct("https://direct.test");
      await h.openNode("bk_a");
      expect(h.target()?.path).toBe(direct ? "direct" : "relay");
      setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
      h.scopes.noteUse("window:node:bk_a");
      await settled();
      expect(h.manager.bind).toHaveBeenCalledTimes(direct ? 1 : 2);
      if (!direct) {
        expect(h.revoked).toContain("grant-bk_a-2");
        expect(h.target()?.path).toBe("relay");
      }
      expect(Array.from(h.routes.keys()).some((scope) => scope.includes(":workspace-retry:"))).toBe(
        false,
      );
    } finally {
      h.scopes.releaseAll();
      globalThis.fetch = originalFetch;
      setSystemTime();
    }
  });
}
