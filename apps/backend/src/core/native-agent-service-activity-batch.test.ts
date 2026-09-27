/**
 * The activity sweep against a real HTTP bridge provider and a fake bridge
 * server: batching, per-id answers, older bridges and bridge restarts.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Answer = Record<string, unknown> | "unavailable";

/**
 * A bridge that records every request and answers the two no-touch activity
 * routes from `states`. Any other route is a liveness side effect and fails.
 */
function fakeBridge(options: {
  states: Map<string, Answer>;
  batch: "supported" | "absent" | "error";
}) {
  const requests: Array<{ method: string; path: string; ids?: string[] }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/sessions/activity") {
        const { sessionIds } = (await request.json()) as { sessionIds: string[] };
        requests.push({ method: "POST", path: url.pathname, ids: sessionIds });
        if (options.batch === "absent") return new Response("Not Found", { status: 404 });
        if (options.batch === "error") return new Response("busy", { status: 503 });
        return Response.json({
          version: 1,
          observations: Object.fromEntries(
            sessionIds.map((id) => {
              const answer = options.states.get(id) ?? { activity: "missing" };
              return [id, answer === "unavailable" ? { activity: "unavailable" } : answer];
            }),
          ),
        });
      }
      requests.push({ method: request.method, path: url.pathname });
      const single = /^\/session\/([^/]+)\/activity$/.exec(url.pathname);
      if (request.method === "GET" && single) {
        const answer = options.states.get(decodeURIComponent(single[1]!)) ?? {
          activity: "missing",
        };
        if (answer === "unavailable") return new Response("probe failed", { status: 500 });
        return Response.json(answer);
      }
      return new Response("unexpected route", { status: 500 });
    },
  });
  return { server, requests };
}

async function withSweep(
  run: (context: {
    storage: StorageService;
    service: NativeAgentService;
    connectTo: (port: number, authToken?: string) => void;
    advance: (ms: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-activity-batch-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/env-1",
    setupScriptsComplete: true,
  });
  let bridge: { port: number; authToken: string } | null = null;
  const invoke = (async <T>(command: string): Promise<T> => {
    // Only the read-only peek; a start command would spawn a bridge.
    if (command === "peek_local_agent_bridge") return bridge as T;
    throw new Error(`Unexpected backend command: ${command}`);
  }) as Invoke;
  let clock = 1_000_000;
  const service = new NativeAgentService(storage, invoke, { now: () => clock });
  try {
    await run({
      storage,
      service,
      connectTo: (port, authToken = "token") => {
        bridge = { port, authToken };
      },
      advance: (ms) => {
        clock += ms;
      },
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function adoptSessions(storage: StorageService, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const providerSessionId = `provider-${index}`;
    await storage.adoptNativeAgentSession({
      key: nativeAgentSessionStorageKey("env-1", "codex", `tab-${index}`),
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: `tab-${index}`,
      providerSessionId,
    });
    ids.push(providerSessionId);
  }
  return ids;
}

function observed(service: NativeAgentService) {
  return (
    service as unknown as {
      observedSessionActivity: Map<string, { providerSessionId: string; state: string }>;
    }
  ).observedSessionActivity;
}

async function environmentActivity(storage: StorageService): Promise<string | undefined> {
  const [environment] = await storage.loadEnvironments();
  return environment?.agentActivitySources?.["native-agent"]?.state;
}

describe("activity sweep over the batch route", () => {
  for (const count of [1, 10, 100]) {
    test(`${count} sessions cost ${Math.ceil(count / 64)} request(s) and touch nothing`, async () => {
      await withSweep(async ({ storage, service, connectTo }) => {
        const ids = await adoptSessions(storage, count);
        const states = new Map<string, Answer>(ids.map((id) => [id, { activity: "idle" }]));
        states.set(ids.at(-1)!, { activity: "working", readyForInput: true });
        const { server, requests } = fakeBridge({ states, batch: "supported" });
        connectTo(server.port!);
        try {
          await service.reconcileAgentActivity();

          expect(requests.every((request) => request.method === "POST")).toBe(true);
          expect(requests.map((request) => request.ids!.length)).toEqual(
            count === 100 ? [64, 36] : [count],
          );
          expect(observed(service).size).toBe(count);
          expect(await environmentActivity(storage)).toBe("working");
        } finally {
          server.stop(true);
        }
      });
    });
  }

  test("missing unmaps only that session; unavailable leaves every mapping uncertain", async () => {
    await withSweep(async ({ storage, service, connectTo }) => {
      const ids = await adoptSessions(storage, 3);
      const states = new Map<string, Answer>([
        [ids[0]!, { activity: "idle" }],
        [ids[1]!, { activity: "missing" }],
        [ids[2]!, { activity: "working" }],
      ]);
      const { server, requests } = fakeBridge({ states, batch: "supported" });
      connectTo(server.port!);
      try {
        await service.reconcileAgentActivity();
        expect((await storage.listNativeAgentSessions()).map((s) => s.providerSessionId)).toEqual([
          ids[0]!,
          ids[2]!,
        ]);

        // A probe error is not evidence of anything: nothing is unmapped, the
        // environment is withheld rather than reported idle, and the group
        // backs off instead of retrying every session individually.
        states.set(ids[2]!, "unavailable");
        const before = requests.length;
        await service.reconcileAgentActivity();
        expect((await storage.listNativeAgentSessions()).map((s) => s.providerSessionId)).toEqual([
          ids[0]!,
          ids[2]!,
        ]);
        expect(requests.slice(before).map((request) => request.method)).toEqual(["POST"]);
        expect(await environmentActivity(storage)).toBe("working");
      } finally {
        server.stop(true);
      }
    });
  });

  test("an older bridge is read individually and not re-probed every sweep", async () => {
    await withSweep(async ({ storage, service, connectTo }) => {
      const ids = await adoptSessions(storage, 3);
      const states = new Map<string, Answer>(ids.map((id) => [id, { activity: "idle" }]));
      const { server, requests } = fakeBridge({ states, batch: "absent" });
      connectTo(server.port!);
      try {
        await service.reconcileAgentActivity();
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(requests.filter((request) => request.method === "GET")).toHaveLength(3);
        // A 404 on the batch route is not a deleted session.
        expect(await storage.listNativeAgentSessions()).toHaveLength(3);
        expect(observed(service).size).toBe(3);

        await service.reconcileAgentActivity();
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(requests.filter((request) => request.method === "GET")).toHaveLength(6);
        expect(
          requests.every((request) =>
            request.method === "POST"
              ? request.path === "/sessions/activity"
              : /^\/session\/provider-\d+\/activity$/.test(request.path),
          ),
        ).toBe(true);
      } finally {
        server.stop(true);
      }
    });
  });

  test("a failing batch route is bypassed for one sweep only", async () => {
    await withSweep(async ({ storage, service, connectTo }) => {
      const ids = await adoptSessions(storage, 2);
      const states = new Map<string, Answer>(ids.map((id) => [id, { activity: "idle" }]));
      const bridge = { states, batch: "error" as "supported" | "absent" | "error" };
      const { server, requests } = fakeBridge(bridge);
      connectTo(server.port!);
      try {
        await service.reconcileAgentActivity();
        expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
        expect(observed(service).size).toBe(2);

        bridge.batch = "supported";
        await service.reconcileAgentActivity();
        expect(requests.slice(3).map((request) => request.method)).toEqual(["POST"]);
      } finally {
        server.stop(true);
      }
    });
  });

  test("a restarted bridge re-detects the batch route", async () => {
    await withSweep(async ({ storage, service, connectTo, advance }) => {
      const ids = await adoptSessions(storage, 2);
      const states = new Map<string, Answer>(ids.map((id) => [id, { activity: "idle" }]));
      const old = fakeBridge({ states, batch: "absent" });
      connectTo(old.server.port!, "old-token");
      await service.reconcileAgentActivity();
      expect(old.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);

      // The old process goes away; its provider fails and is evicted.
      old.server.stop(true);
      await service.reconcileAgentActivity();

      const upgraded = fakeBridge({ states, batch: "supported" });
      connectTo(upgraded.server.port!, "new-token");
      try {
        advance(10 * 60_000);
        await service.reconcileAgentActivity();
        expect(upgraded.requests.map((request) => request.method)).toEqual(["POST"]);
        expect(observed(service).size).toBe(2);
      } finally {
        upgraded.server.stop(true);
      }
    });
  });
});
