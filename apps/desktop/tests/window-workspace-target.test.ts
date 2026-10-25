import { expect, mock, setSystemTime, test } from "bun:test";
import { NodeWorkspaceScopes, WORKSPACE_DIRECT_RETRY_MS } from "../electron/node-workspaces";
import {
  editDesktopConnection,
  setDesktopWorkspaceTarget,
  type WorkspaceContext,
} from "../electron/window-workspace-target";

function harness() {
  const routes = new Map([["window", "command"]]);
  const revoked: string[] = [];
  let destroyed = false;
  let fail = false;
  let open: (() => Promise<void>) | null = null;
  let directOrigin: string | null = null;
  const grantIds = new Map<string, number>();
  const context: WorkspaceContext = {
    scope: "window",
    portalScope: null,
    target: null,
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
        if (fail) throw new Error("unreachable");
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
  const committed = mock(() => undefined);
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
    restoreScopeFrom: (scope: string, source: string) => {
      routes.set(scope, routes.get(source)!);
    },
    release: (scope: string) => {
      routes.delete(scope);
    },
    epochOf: () => 1,
    rebindWorkspace: mock((_scope: string, _binding: unknown) => undefined),
  };
  const set = (nodeId: string | null) =>
    setDesktopWorkspaceTarget(
      context,
      { nodeId },
      { manager: manager as never, scopes, committed },
    );
  return {
    context,
    routes,
    revoked,
    scopes,
    committed,
    manager,
    set,
    direct: (origin: string) => {
      directOrigin = origin;
    },
    fail: () => {
      fail = true;
    },
    hold: (value: () => Promise<void>) => {
      open = value;
    },
    close: () => {
      destroyed = true;
      scopes.release("window");
      if (context.portalScope) manager.release(context.portalScope);
      manager.release("window");
    },
  };
}

test("failed A to B open preserves A invoke route, grant, target, previews and renderer", async () => {
  const h = harness();
  try {
    await h.set("A");
    const target = h.context.target;
    h.fail();
    await expect(h.set("B")).rejects.toThrow("unreachable");
    expect(h.routes.get("window")).toBe("grant-A");
    expect(h.context.target).toBe(target);
    expect(h.context.portalScope).toBe("window:portal");
    expect(h.revoked).not.toContain("grant-A");
    // The commit callback owns preview replacement, title, lists and reload identity.
    expect(h.committed).toHaveBeenCalledTimes(1);
  } finally {
    h.scopes.releaseAll();
  }
});

test("competing opens are refused and a pending open cannot resurrect a closed window", async () => {
  const h = harness();
  let resolve!: () => void;
  h.hold(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const first = h.set("A");
  while (!resolve) await Promise.resolve();
  await expect(h.set("B")).rejects.toThrow("in progress");
  h.close();
  resolve();
  await expect(first).rejects.toThrow("Window closed");
  expect(h.routes.size).toBe(0);
  expect(h.revoked).toContain("grant-A");
  expect(h.committed).not.toHaveBeenCalled();
});

test("nonselecting additions and inactive removals use control scope without revoking a leaf", async () => {
  const h = harness();
  try {
    await h.set("A");
    const connect = mock(async (_input: unknown, _scope: string) => ({}));
    const forget = mock(async (_id: string, _scope: string) => ({}));
    const manager = { ...h.manager, connect, forget, getList: () => ({}) };
    const reset = mock(() => h.set(null));
    await editDesktopConnection(
      h.context,
      { kind: "connect", input: { address: "https://other.test", token: "unused", select: false } },
      manager as never,
      reset,
    );
    await editDesktopConnection(
      h.context,
      { kind: "forget", connectionId: "inactive" },
      manager as never,
      reset,
    );
    expect(connect.mock.calls[0]?.[1]).toBe("window:portal");
    expect(forget.mock.calls[0]?.[1]).toBe("window:portal");
    expect(reset).not.toHaveBeenCalled();
    expect(h.routes.get("window")).toBe("grant-A");
    expect(h.context.target?.nodeId).toBe("A");
    expect(h.revoked).toEqual([]);
  } finally {
    h.scopes.releaseAll();
  }
});

test("closing an existing leaf while a replacement opens revokes both grants without rebinding", async () => {
  const h = harness();
  await h.set("A");
  let resolve!: () => void;
  h.hold(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const pending = h.set("B");
  while (!resolve) await Promise.resolve();
  h.close();
  resolve();
  await expect(pending).rejects.toThrow("Window closed");
  expect(h.revoked.sort()).toEqual(["grant-A", "grant-B"]);
  expect(h.routes.size).toBe(0);
  expect(h.committed).toHaveBeenCalledTimes(1);
});

test("successful leaf replacement revokes A after binding B and return restores command", async () => {
  const h = harness();
  try {
    await h.set("A");
    await h.set("B");
    expect(h.routes.get("window")).toBe("grant-B");
    expect(h.context.target?.nodeId).toBe("B");
    expect(h.revoked).toContain("grant-A");
    await h.set(null);
    expect(h.routes.get("window")).toBe("command");
    expect(h.context.target).toBeNull();
    expect(h.context.portalScope).toBeNull();
    expect(h.revoked).toContain("grant-B");
  } finally {
    h.scopes.releaseAll();
  }
});

test("a failed selecting connection edit preserves the leaf and command binding", async () => {
  const h = harness();
  try {
    await h.set("A");
    const reset = mock(() => h.set(null));
    const manager = {
      ...h.manager,
      use: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(
      editDesktopConnection(h.context, { kind: "use", connectionId: "B" }, manager as never, reset),
    ).rejects.toThrow("unreachable");
    expect(reset).not.toHaveBeenCalled();
    expect(h.routes.get("window")).toBe("grant-A");
    expect(h.routes.get("window:portal")).toBe("command");
    expect(h.revoked).toEqual([]);
  } finally {
    h.scopes.releaseAll();
  }
});

async function settled() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test("closing a realm during a retry keeps command access until both grants are revoked", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00Z"));
  const h = harness();
  try {
    await h.set("A");
    let resume!: () => void;
    h.hold(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    h.scopes.noteUse("window");
    await settled();
    expect(resume).toBeDefined();
    expect(
      Array.from(h.routes.keys()).some((scope) => scope.startsWith("window:workspace-retry:")),
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
  test(`opening a ${direct ? "direct" : "relayed"} binding ${direct ? "does not arm" : "arms"} use retries`, async () => {
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
    try {
      if (direct) h.direct("https://direct.test");
      await h.set("bk_a");
      expect(h.context.target?.path).toBe(direct ? "direct" : "relay");
      setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
      h.scopes.noteUse("window");
      await settled();
      expect(h.manager.bind).toHaveBeenCalledTimes(direct ? 2 : 3);
      if (!direct) {
        expect(h.revoked).toContain("grant-bk_a-2");
        expect(h.context.target?.path).toBe("relay");
      }
      expect(
        Array.from(h.routes.keys()).some((scope) => scope.startsWith("window:workspace-retry:")),
      ).toBe(false);
    } finally {
      h.scopes.releaseAll();
      globalThis.fetch = originalFetch;
      setSystemTime();
    }
  });
}
