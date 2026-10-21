import { describe, expect, mock, test } from "bun:test";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import { environmentKey, environmentRef, type BackendId } from "@orkestrator/protocol/federation";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import type { BackendClient, BackendEventListener } from "./backend-client";
import { BackendRuntime, repositoryHint } from "./backend-runtime";
import { deleteFederatedEnvironment } from "./federated-actions";
import { OutcomeUnknownError, isAmbiguousFailure } from "./operation-recovery";
import { BackendClientRegistry } from "./registry";

type Dataset = {
  projects: Array<Record<string, unknown>>;
  environments: Record<string, Array<Record<string, unknown>>>;
};

/** A fake machine. Both fixtures deliberately use the same local IDs. */
function fakeClient(connectionId: string, data: Dataset) {
  const listeners = new Set<BackendEventListener>();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let gate: Promise<void> | null = null;
  let failNext: Error | null = null;
  const client: BackendClient & {
    emit(event: string, payload: unknown, epoch?: number): void;
    calls: typeof calls;
    hold(): () => void;
    failNextWith(error: Error): void;
  } = {
    connectionId,
    calls,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ command, args });
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      if (gate) await gate;
      if (command === "get_projects") return structuredClone(data.projects) as T;
      if (command === "get_environment_snapshots") {
        return structuredClone(data.environments[String(args.projectId)] ?? []) as T;
      }
      return { ok: true, command, connectionId } as T;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    observe: mock(async () => null),
    release: mock(() => undefined),
    emit(event, payload, epoch = 0) {
      for (const listener of listeners) listener(event, payload, epoch);
    },
    hold() {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
    failNextWith(error) {
      failNext = error;
    },
  };
  return client;
}

function summary(id: string, backendId: string, extra: Partial<ConnectionSummary> = {}) {
  return {
    id,
    name: id,
    address: `https://${id}.example`,
    kind: "remote" as const,
    active: false,
    requiresToken: false,
    backendId: backendId as BackendId,
    identity: "verified" as const,
    transport: "connected" as const,
    profile: { displayName: id, colorToken: "teal", revision: 1, cached: false },
    ...extra,
  } satisfies ConnectionSummary;
}

const sharedIds = (label: string): Dataset => ({
  projects: [
    { id: "project-1", name: `${label} project`, order: 0, gitUrl: "git@github.com:acme/app.git" },
  ],
  environments: {
    "project-1": [
      {
        id: "env-1",
        projectId: "project-1",
        name: `${label} env`,
        status: "running",
        agentActivityState: label === "A" ? "working" : "waiting",
      },
    ],
  },
});

async function settle(runtime: BackendRuntime): Promise<void> {
  await runtime.whenIdle();
  if (runtime.getSnapshot().loadedAt === null) await runtime.requestHydrate();
  await runtime.whenIdle();
}

describe("backend runtimes", () => {
  test("ID-01/RT-04: identical local IDs on two machines stay separate everywhere", async () => {
    const clientA = fakeClient("a", sharedIds("A"));
    const clientB = fakeClient("b", sharedIds("B"));
    const runtimeA = new BackendRuntime({ client: clientA, connection: summary("a", "bk_a") });
    const runtimeB = new BackendRuntime({ client: clientB, connection: summary("b", "bk_b") });
    runtimeA.acquireSummaryDemand();
    runtimeB.acquireSummaryDemand();
    await Promise.all([settle(runtimeA), settle(runtimeB)]);
    const envA = runtimeA.getSnapshot().environmentsByProject.get("project-1")![0]!;
    const envB = runtimeB.getSnapshot().environmentsByProject.get("project-1")![0]!;
    expect(envA.ref.environmentId).toBe(envB.ref.environmentId);
    expect(envA.key).not.toBe(envB.key);
    expect(envA.name).toBe("A env");
    expect(envB.name).toBe("B env");
    // Primed caches are per runtime: the same read on A never answers B.
    runtimeA.prefetch.prime([
      { command: "get_pane_layout", args: { environmentId: "env-1" }, snapshot: "A" },
    ]);
    expect(runtimeB.prefetch.read("get_pane_layout", { environmentId: "env-1" }).found).toBe(false);
    await expect(runtimeA.read("get_pane_layout", { environmentId: "env-1" })).resolves.toBe("A");
  });

  test("RT-03/RT-06: an event or revision gap on A reconciles A only", async () => {
    const clientA = fakeClient("a", sharedIds("A"));
    const clientB = fakeClient("b", sharedIds("B"));
    const runtimeA = new BackendRuntime({ client: clientA, connection: summary("a", "bk_a") });
    const runtimeB = new BackendRuntime({ client: clientB, connection: summary("b", "bk_b") });
    runtimeA.acquireSummaryDemand();
    runtimeB.acquireSummaryDemand();
    await Promise.all([settle(runtimeA), settle(runtimeB)]);
    const bCalls = clientB.calls.length;
    const bState = runtimeB.getSnapshot();
    clientA.emit(RESOURCE_CHANGED_EVENT, { resource: "project", id: "project-1", revision: 4 });
    clientA.emit(RESOURCE_CHANGED_EVENT, { resource: "project", id: "project-1", revision: 9 });
    await runtimeA.whenIdle();
    expect(clientB.calls.length).toBe(bCalls);
    expect(runtimeB.getSnapshot()).toBe(bState);
  });

  test("RT-05: a read started on an old connection epoch never applies", async () => {
    const data = sharedIds("A");
    const client = fakeClient("a", data);
    const runtime = new BackendRuntime({ client, connection: summary("a", "bk_a") });
    runtime.acquireSummaryDemand();
    await settle(runtime);
    const open = client.hold();
    const stale = runtime.requestHydrate();
    data.environments["project-1"]![0]!.name = "renamed on new epoch";
    // A reconnect advances the epoch while the old read is still in flight.
    client.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined, 7);
    open();
    await stale;
    await runtime.requestHydrate();
    expect(runtime.getSnapshot().epoch).toBe(7);
    expect(runtime.getSnapshot().environmentsByProject.get("project-1")![0]!.name).toBe(
      "renamed on new epoch",
    );
  });

  test("PF-02: summary hydration reads summaries only, bounded per project", async () => {
    const environments = Array.from({ length: 600 }, (_, index) => ({
      id: `env-${index}`,
      projectId: "p",
      name: `env ${index}`,
      status: "running",
    }));
    const client = fakeClient("a", {
      projects: [{ id: "p", name: "Big", order: 0 }],
      environments: { p: environments },
    });
    const runtime = new BackendRuntime({ client, connection: summary("a", "bk_a") });
    runtime.acquireSummaryDemand();
    await settle(runtime);
    expect(runtime.getSnapshot().environmentsByProject.get("p")).toHaveLength(500);
    expect(runtime.getSnapshot().truncated).toBe(true);
    expect(new Set(client.calls.map((call) => call.command))).toEqual(
      new Set(["get_projects", "get_environment_snapshots"]),
    );
  });

  test("OP-02: an ambiguous write failure becomes outcome-unknown and is never resent", async () => {
    const client = fakeClient("a", sharedIds("A"));
    const runtime = new BackendRuntime({ client, connection: summary("a", "bk_a") });
    client.failNextWith(new TypeError("Failed to fetch"));
    const attempt = runtime.mutate(
      "delete_environment",
      { environmentId: "env-1" },
      {
        label: "Delete environment",
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(OutcomeUnknownError);
    const outcomes = runtime.recovery.store.getState().outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ backendId: "bk_a", command: "delete_environment" });
    expect(JSON.stringify(outcomes[0])).not.toContain("env-1");
    expect(client.calls.filter((call) => call.command === "delete_environment")).toHaveLength(1);
    // A definite server answer is an ordinary error, not an unknown outcome.
    client.failNextWith(new Error("Environment is busy"));
    await expect(
      runtime.mutate("stop_environment", { environmentId: "env-1" }, { label: "Stop" }),
    ).rejects.toThrow("Environment is busy");
    expect(runtime.recovery.store.getState().outcomes).toHaveLength(1);
    expect(isAmbiguousFailure(new Error("socket hang up"))).toBe(true);
  });

  test("AU-03: a rejected credential purges protected summaries; a disconnect keeps them", async () => {
    const client = fakeClient("a", sharedIds("A"));
    const runtime = new BackendRuntime({ client, connection: summary("a", "bk_a") });
    runtime.acquireSummaryDemand();
    await settle(runtime);
    runtime.updateConnection(summary("a", "bk_a", { transport: "unreachable" }));
    expect(runtime.getSnapshot().freshness).toBe("stale");
    expect(runtime.getSnapshot().projects).toHaveLength(1);
    runtime.updateConnection(summary("a", "bk_a", { transport: "authentication-required" }));
    expect(runtime.getSnapshot().projects).toHaveLength(0);
  });

  test("repository hints carry no credentials or paths", () => {
    expect(repositoryHint("https://user:secret@github.com/Acme/App.git")).toBe(
      "github.com/acme/app",
    );
    expect(repositoryHint("git@github.com:acme/app.git")).toBe("github.com/acme/app");
    expect(repositoryHint("/Users/me/src/app")).toBeUndefined();
    expect(repositoryHint("file:///srv/app")).toBeUndefined();
  });
});

describe("backend client registry", () => {
  function list(connections: ConnectionSummary[], active = "local"): ConnectionList {
    return { activeConnectionId: active, connections };
  }

  test("creates one runtime per other machine and never one for the bound machine", () => {
    const clients = new Map<string, ReturnType<typeof fakeClient>>();
    const registry = new BackendClientRegistry((connection) => {
      const client = fakeClient(connection.id, sharedIds(connection.id));
      clients.set(connection.id, client);
      return client;
    });
    registry.sync(
      list([summary("local", "bk_l"), summary("a", "bk_a"), summary("b", "bk_b")], "local"),
      {
        enabled: true,
      },
    );
    expect(
      registry
        .list()
        .map((runtime) => runtime.connectionId)
        .sort(),
    ).toEqual(["a", "b"]);
    registry.sync(list([summary("local", "bk_l"), summary("a", "bk_a")], "local"), {
      enabled: true,
    });
    expect(registry.list().map((runtime) => runtime.connectionId)).toEqual(["a"]);
    expect(clients.get("b")!.release).toHaveBeenCalled();
    registry.sync(list([summary("local", "bk_l"), summary("a", "bk_a")], "local"), {
      enabled: false,
    });
    expect(registry.list()).toEqual([]);
  });

  test("UI-04/missing owner: an unknown backend fails loudly instead of defaulting", () => {
    const registry = new BackendClientRegistry((connection) =>
      fakeClient(connection.id, sharedIds(connection.id)),
    );
    registry.sync(list([summary("a", "bk_a")]), { enabled: true });
    expect(() => registry.require("bk_missing" as BackendId)).toThrow("not connected");
  });

  test("OP-05/RT-02: an action captured for A reaches A even after B gains focus", async () => {
    const clients = new Map<string, ReturnType<typeof fakeClient>>();
    const registry = new BackendClientRegistry((connection) => {
      const client = fakeClient(connection.id, sharedIds(connection.id));
      clients.set(connection.id, client);
      return client;
    });
    registry.sync(list([summary("a", "bk_a"), summary("b", "bk_b")]), { enabled: true });
    const captured = environmentRef("bk_a" as BackendId, "env-1");
    // Focus moves to B's identical environment ID before the action runs.
    const focused = environmentRef("bk_b" as BackendId, "env-1");
    expect(environmentKey(focused)).not.toBe(environmentKey(captured));
    await deleteFederatedEnvironment(registry, captured);
    expect(clients.get("a")!.calls.some((call) => call.command === "delete_environment")).toBe(
      true,
    );
    expect(clients.get("b")!.calls.some((call) => call.command === "delete_environment")).toBe(
      false,
    );
  });
});
