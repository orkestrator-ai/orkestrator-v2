import { expect, setSystemTime, test } from "bun:test";
import {
  NodeWorkspaceScopes,
  openNodeWorkspace,
  WORKSPACE_DIRECT_RETRY_MS,
  type WorkspaceBinding,
} from "../electron/node-workspaces";

const binding = (id: string, port: number): WorkspaceBinding => ({
  workspaceId: id,
  nodeId: "bk_c",
  baseUrl: `http://127.0.0.1:${port}`,
  token: `grant-${id}`,
  params: { node: "C", path: "relay" },
});

test("remote command node relay is used when C is absent from local registry", async () => {
  const calls: string[] = [];
  const opened = await openNodeWorkspace({
    nodeId: "bk_c",
    commandNodeName: "B",
    invoke: async (command) => {
      calls.push(command);
      return {
        workspaceId: "w",
        nodeId: "bk_c",
        nodeName: "C",
        grant: { token: "grant", expiresAt: Date.now() + 60_000 },
        directOrigins: [],
        relayBase: "/__orkestrator/nodes/bk_c",
      };
    },
    relay: () => ({ baseUrl: "http://127.0.0.1:45001", token: "command-b-token" }),
  });
  expect(calls).toEqual(["open_node_workspace"]);
  expect(opened.baseUrl).toBe("http://127.0.0.1:45001/__orkestrator/nodes/bk_c");
  expect(opened.nodeId).toBe("bk_c");
});

test("workspace epoch changes and failed grant renewal replace binding through captured command node", async () => {
  const calls: Array<[string, unknown]> = [];
  let epoch = 1;
  let failed = false;
  let next = 0;
  const retargeted: WorkspaceBinding[] = [];
  const invoke = async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (failed && command === "renew_node_workspace") throw new Error("grant lost after restart");
    return {};
  };
  const scopes = new NodeWorkspaceScopes(async () => {
    throw new Error("Local A must not be used");
  });
  scopes.track("panel", "old", {
    invoke,
    epoch: () => epoch,
    reopen: async () => binding(`new-${++next}`, 45000 + next),
    retarget: (value) => {
      retargeted.push(value);
    },
  });
  epoch++;
  await scopes.reconcile("panel");
  expect(retargeted[0]!.baseUrl).toBe("http://127.0.0.1:45001");
  failed = true;
  await scopes.reconcile("panel");
  expect(retargeted[1]!.workspaceId).toBe("new-2");
  scopes.release("panel");
  await Promise.resolve();
  expect(calls).toContainEqual(["close_node_workspace", { workspaceId: "new-2" }]);
  expect(calls).toContainEqual(["close_node_workspace", { workspaceId: "old" }]);
});

const directBinding = (id: string): WorkspaceBinding => ({
  workspaceId: id,
  nodeId: "bk_c",
  baseUrl: "https://c.example.ts.net",
  token: `grant-${id}`,
  params: { node: "C", path: "direct", route: "https" },
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("a relayed panel in use retries its direct route after the retry interval", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00.000Z"));
  try {
    const calls: Array<[string, unknown]> = [];
    const retargeted: WorkspaceBinding[] = [];
    let reopens = 0;
    const scopes = new NodeWorkspaceScopes(async () => ({}));
    scopes.track("panel", "relayed", {
      invoke: async (command, args) => {
        calls.push([command, args]);
        return {};
      },
      reopen: async () => {
        reopens++;
        return reopens === 1 ? binding("still-relayed", 45001) : directBinding("direct");
      },
      retarget: (value) => retargeted.push(value),
      relayed: true,
    });

    // Used, but within the interval of the probe that chose the relay.
    scopes.noteUse("panel");
    await settle();
    expect(reopens).toBe(0);

    // The direct route still fails: the trial workspace is closed, the relay kept.
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    await settle();
    expect(reopens).toBe(1);
    expect(retargeted).toEqual([]);
    expect(calls).toContainEqual(["close_node_workspace", { workspaceId: "still-relayed" }]);

    // Idle time alone never probes; the next use after the interval does.
    setSystemTime(new Date(Date.now() + 3 * WORKSPACE_DIRECT_RETRY_MS));
    expect(reopens).toBe(1);
    scopes.noteUse("panel");
    await settle();
    expect(reopens).toBe(2);
    expect(retargeted.map((value) => value.workspaceId)).toEqual(["direct"]);
    expect(calls).toContainEqual(["close_node_workspace", { workspaceId: "relayed" }]);

    // Once direct, use never probes again.
    setSystemTime(new Date(Date.now() + 2 * WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    await settle();
    expect(reopens).toBe(2);
    scopes.release("panel");
  } finally {
    setSystemTime();
  }
});

test("a direct panel is never re-probed on use", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00.000Z"));
  try {
    let reopens = 0;
    const scopes = new NodeWorkspaceScopes(async () => ({}));
    scopes.track("panel", "direct", {
      invoke: async () => ({}),
      reopen: async () => {
        reopens++;
        return directBinding("other");
      },
    });
    setSystemTime(new Date(Date.now() + 2 * WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    scopes.noteUse("unknown-scope");
    await settle();
    expect(reopens).toBe(0);
    scopes.release("panel");
  } finally {
    setSystemTime();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const change of ["release", "replace", "invalidate", "epoch", "retarget-throw"] as const) {
  test(`a pending upgrade cleans its candidate after ${change}`, async () => {
    setSystemTime(new Date("2026-10-25T00:00:00Z"));
    const pending = deferred<WorkspaceBinding>();
    const revoked: string[] = [];
    let portalReleased = false;
    let retained = false;
    let releases = 0;
    let epoch = 1;
    const applied: string[] = [];
    const scopes = new NodeWorkspaceScopes(async () => ({}));
    const invoke = (command: string, args: Record<string, unknown>) => {
      if (portalReleased) throw new Error("Scope is released");
      if (command === "close_node_workspace") revoked.push(String(args.workspaceId));
      return Promise.resolve({});
    };
    scopes.track("panel", "old", {
      invoke,
      relayed: true,
      epoch: () => epoch,
      reopen: () => pending.promise,
      retain: async () => {
        retained = true;
        return {
          invoke: async (command, args) => {
            expect(retained).toBe(true);
            if (command === "close_node_workspace") revoked.push(String(args.workspaceId));
            return {};
          },
          reopen: () => pending.promise,
          release: () => {
            retained = false;
            releases++;
          },
        };
      },
      retarget: (value) => {
        if (change === "retarget-throw") throw new Error("callback failed synchronously");
        applied.push(value.workspaceId);
      },
    });
    try {
      setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
      scopes.noteUse("panel");
      await settle();
      expect(retained).toBe(true);
      if (change === "release") scopes.release("panel");
      if (change === "replace") scopes.track("panel", "replacement", { invoke });
      if (change === "invalidate") scopes.invalidate("panel");
      if (change === "epoch") epoch++;
      portalReleased = true;
      pending.resolve(directBinding("trial"));
      await settle();
      await settle();
      expect(applied).toEqual([]);
      expect(revoked).toContain("trial");
      if (change === "release" || change === "replace") expect(revoked).toContain("old");
      expect(releases).toBe(1);
      expect(retained).toBe(false);
      // Even release callbacks that throw synchronously are contained.
      expect(() => scopes.releaseAll()).not.toThrow();
    } finally {
      scopes.releaseAll();
      setSystemTime();
    }
  });
}

test("a rejected retry releases retained access and the next use can recover", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00Z"));
  const pending = deferred<WorkspaceBinding>();
  let reopens = 0;
  let releases = 0;
  const applied: string[] = [];
  const scopes = new NodeWorkspaceScopes(async () => ({}));
  const reopen = () =>
    ++reopens === 1 ? pending.promise : Promise.resolve(directBinding("recovered"));
  scopes.track("panel", "old", {
    relayed: true,
    reopen,
    retain: async () => ({
      invoke: async () => ({}),
      reopen,
      release: () => {
        releases++;
      },
    }),
    retarget: (value) => {
      applied.push(value.workspaceId);
    },
  });
  try {
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    await settle();
    pending.reject(new Error("probe failed"));
    await settle();
    await settle();
    expect(releases).toBe(1);
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    await settle();
    await settle();
    expect(applied).toEqual(["recovered"]);
    expect(releases).toBe(2);
  } finally {
    scopes.releaseAll();
    setSystemTime();
  }
});

test("invalidation during a retry rejects the candidate and reconcile re-arms relay retries", async () => {
  setSystemTime(new Date("2026-10-25T00:00:00Z"));
  const pending = deferred<WorkspaceBinding>();
  const applied: string[] = [];
  const revoked: string[] = [];
  let reopens = 0;
  const scopes = new NodeWorkspaceScopes(async (command, args) => {
    if (command === "close_node_workspace") revoked.push(String(args.workspaceId));
    return {};
  });
  scopes.track("panel", "old", {
    relayed: true,
    reopen: () => {
      reopens++;
      if (reopens === 1) return pending.promise;
      return Promise.resolve(reopens === 2 ? binding("new-relay", 45002) : directBinding("direct"));
    },
    retarget: (value) => {
      applied.push(value.workspaceId);
    },
  });
  try {
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    await settle();
    scopes.invalidate("panel");
    pending.resolve(directBinding("stale"));
    await settle();
    await settle();
    expect(revoked).toContain("stale");
    expect(applied).toEqual([]);
    await scopes.reconcile("panel");
    expect(applied).toEqual(["new-relay"]);
    scopes.noteUse("panel");
    await settle();
    expect(reopens).toBe(2);
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    scopes.noteUse("panel");
    await settle();
    await settle();
    expect(applied).toEqual(["new-relay", "direct"]);
  } finally {
    scopes.releaseAll();
    setSystemTime();
  }
});
