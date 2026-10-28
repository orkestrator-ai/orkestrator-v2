import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";

import {
  LoopbackListenerOwnership,
  type ListenerOwnership,
  type ManagedProcessRoot,
} from "./preview-listener-ownership.js";
import { CommandFailedError } from "./shell.js";
import { resolvePreviewTargetIntent } from "./preview-intent.js";
import { spawnPty, type PtyProcess } from "./pty.js";
import { TerminalRuntime } from "./terminal-runtime.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

/**
 * Local-environment discovery: seeded worktree services, managed-process
 * ownership, and the qualification cases from 0045 (two environments on one
 * dev port, a restart on a reused port, an auto-incremented port).
 */
describe("local preview service discovery", () => {
  let harness: PreviewHarness;
  /** Who listens on each backend port: an environment id, a stranger, or nobody. */
  let listeners: Map<number, { owner: string | "stranger"; started: string }>;
  let checks: number;

  const listenerOwnership = {
    attribute: async (environmentId: string, port: number): Promise<ListenerOwnership> => {
      checks += 1;
      const listener = listeners.get(port);
      if (!listener) return { attribution: "none" };
      if (listener.owner === "stranger") return { attribution: "unattributed" };
      if (listener.owner !== environmentId) return { attribution: "other-environment" };
      return { attribution: "this-environment", processKey: listener.started };
    },
    stats: () => ({ listenerChecks: checks, listenerUnchecked: 0 }),
  };

  beforeEach(async () => {
    harness = await createPreviewHarness();
    listeners = new Map();
    checks = 0;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function started() {
    const runtime = harness.newRuntime({ listenerOwnership });
    await runtime.init();
    await runtime.registry.settle();
    return runtime.registry;
  }

  function seeded(registry: Awaited<ReturnType<typeof started>>, environmentId: string) {
    const services = registry.snapshot({ environmentId }).services;
    expect(services).toHaveLength(1);
    return services[0]!;
  }

  test("a local environment's entry port is seeded as its entry worktree service", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    await harness.addLocalEnvironment("no-entry");
    const registry = await started();
    const service = seeded(registry, "a");
    expect(service.definition).toMatchObject({
      label: "app",
      targetKind: "worktree",
      applicationPort: 3000,
      provenance: "entry-port",
      provenanceKey: "entry:3000",
      userOverride: false,
      entry: true,
    });
    expect(registry.snapshot({ environmentId: "no-entry" }).services).toEqual([]);
    // Restarting the backend does not duplicate it.
    const again = await started();
    expect(again.snapshot({ environmentId: "a" }).services).toHaveLength(1);
  });

  test("a seeded service opens only a server this environment started", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    const registry = await started();
    const { serviceId } = seeded(registry, "a").definition;

    // Nothing listening yet: no target, and the diagnostics say why.
    let service = await registry.refresh(serviceId);
    expect(service.endpoint).toMatchObject({
      state: "unavailable",
      listener: "none",
      failure: { category: "target-unverified", retryable: true },
    });
    await expect(
      registry.acquireTarget(serviceId, service.endpoint.endpointGeneration),
    ).rejects.toThrow(/target-unverified/);

    // A process this environment did not start (another terminal app, another user).
    listeners.set(3000, { owner: "stranger", started: "t0" });
    service = await registry.refresh(serviceId);
    expect(service.endpoint).toMatchObject({ state: "unavailable", listener: "unattributed" });

    // The dev server started from this environment's terminal or agent.
    listeners.set(3000, { owner: "a", started: "t1" });
    service = await registry.refresh(serviceId);
    expect(service.endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
      listener: "this-environment",
      transportKind: "backend-loopback",
      hostPort: 3000,
    });
  });

  test("two local environments on one dev port never open each other's server", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    await harness.addLocalEnvironment("b", { entryPort: 3000 });
    const registry = await started();
    const a = seeded(registry, "a").definition.serviceId;
    const b = seeded(registry, "b").definition.serviceId;
    listeners.set(3000, { owner: "a", started: "t1" });

    expect((await registry.refresh(a)).endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
    });
    const other = await registry.refresh(b);
    expect(other.endpoint).toMatchObject({
      state: "unavailable",
      listener: "other-environment",
      failure: { category: "target-unverified" },
    });
    expect(other.endpoint.hostPort).toBeNull();

    // A user registration in b is still refused another environment's server.
    await registry.update(b, seeded(registry, "b").definition.definitionRevision, {});
    const confirmed = await registry.refresh(b);
    expect(confirmed.definition.userOverride).toBe(true);
    expect(confirmed.endpoint.listener).toBe("other-environment");
    expect(confirmed.endpoint.state).toBe("unavailable");

    // An explicit backend-host registration is the user's own association: shown, and labelled.
    const host = await registry.register({
      environmentId: "b",
      label: "shared",
      targetKind: "backend-host",
      applicationPort: 3000,
    });
    if (host.kind !== "definition") throw new Error("expected definition");
    expect((await registry.refresh(host.definition.serviceId)).endpoint).toMatchObject({
      state: "available",
      ownership: "user-registered",
      listener: "other-environment",
    });
  });

  test("a restart on the reused port rebinds to the new process", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    const registry = await started();
    const { serviceId } = seeded(registry, "a").definition;
    listeners.set(3000, { owner: "a", started: "t1" });
    const first = await registry.refresh(serviceId);
    expect(first.endpoint.state).toBe("available");

    // Same environment, new process on the same port: a new generation, so an
    // attachment to the old process cannot reach the new one silently.
    listeners.set(3000, { owner: "a", started: "t2" });
    const restarted = await registry.refresh(serviceId);
    expect(restarted.endpoint.state).toBe("available");
    expect(restarted.endpoint.endpointGeneration).toBeGreaterThan(
      first.endpoint.endpointGeneration,
    );
    await expect(
      registry.acquireTarget(serviceId, first.endpoint.endpointGeneration),
    ).rejects.toThrow(/generation-changed/);

    // Another environment's server taking the port after a restart is refused.
    await harness.addLocalEnvironment("b");
    listeners.set(3000, { owner: "b", started: "t3" });
    const taken = await registry.refresh(serviceId);
    expect(taken.endpoint).toMatchObject({ state: "unavailable", listener: "other-environment" });
  });

  test("confirming a seeded service shows any process on its port, and says so", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    const registry = await started();
    const definition = seeded(registry, "a").definition;
    listeners.set(3000, { owner: "stranger", started: "t0" });
    expect((await registry.refresh(definition.serviceId)).endpoint.state).toBe("unavailable");

    await registry.update(definition.serviceId, definition.definitionRevision, {});
    const confirmed = await registry.refresh(definition.serviceId);
    expect(confirmed.definition.userOverride).toBe(true);
    expect(confirmed.endpoint).toMatchObject({
      state: "available",
      ownership: "user-registered",
      listener: "unattributed",
    });
    // A confirmed service survives regeneration; seeding never duplicates it.
    const again = await started();
    expect(again.snapshot({ environmentId: "a" }).services).toHaveLength(1);
  });

  test("an auto-incremented port is offered for re-registration, never guessed", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    await harness.addLocalEnvironment("b", { entryPort: 3000 });
    const registry = await started();
    listeners.set(3000, { owner: "a", started: "t1" });
    // b's dev server found 3000 taken and moved to 3001.
    listeners.set(3001, { owner: "b", started: "t2" });
    const b = seeded(registry, "b").definition;
    expect((await registry.refresh(b.serviceId)).endpoint.listener).toBe("other-environment");

    // b's terminal prints localhost:3001. The link resolves in b, finds no
    // service on 3001, and proposes registration; nothing moves on its own.
    const link = await resolvePreviewTargetIntent(
      registry,
      {
        intent: { url: "http://localhost:3001/", source: "worktree-terminal", environmentId: "b" },
      },
      (id) => harness.storage.getEnvironment(id),
    );
    expect(link).toMatchObject({
      kind: "unregistered",
      suggestion: { targetKind: "worktree", applicationPort: 3001 },
    });
    expect(registry.getDefinition(b.serviceId)!.applicationPort).toBe(3000);

    // The user confirms moving the service: it now resolves to b's own server.
    await registry.update(b.serviceId, b.definitionRevision, { applicationPort: 3001 });
    expect((await registry.refresh(b.serviceId)).endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
      hostPort: 3001,
    });
    // a still opens its own server on 3000.
    const a = seeded(registry, "a").definition.serviceId;
    expect((await registry.refresh(a)).endpoint).toMatchObject({
      state: "available",
      hostPort: 3000,
      ownership: "managed-process",
    });
  });

  test("a waiting seeded service rechecks on its own and then becomes available", async () => {
    const runtime = harness.newRuntime({
      listenerOwnership,
      registry: { probeBackoffMs: [5, 5, 5] },
    });
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    await runtime.init();
    await runtime.registry.settle();
    const { serviceId } = seeded(runtime.registry, "a").definition;
    await runtime.registry.refresh(serviceId);
    expect(runtime.registry.serviceSnapshot(serviceId)!.endpoint.state).toBe("unavailable");
    listeners.set(3000, { owner: "a", started: "t1" });
    const deadline = Date.now() + 2_000;
    while (
      runtime.registry.serviceSnapshot(serviceId)!.endpoint.state !== "available" &&
      Date.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    expect(runtime.registry.serviceSnapshot(serviceId)!.endpoint.ownership).toBe("managed-process");
  });

  test("a seeded service waiting since startup rechecks without any client", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    const runtime = harness.newRuntime({
      listenerOwnership,
      registry: { probeBackoffMs: [5, 5, 5] },
    });
    // Startup reconciliation resolves and schedules a probe; nothing refreshes it.
    await runtime.init();
    await runtime.registry.settle();
    const { serviceId } = seeded(runtime.registry, "a").definition;
    expect(runtime.registry.serviceSnapshot(serviceId)!.endpoint.listener).toBe("none");
    listeners.set(3000, { owner: "a", started: "t1" });
    const deadline = Date.now() + 2_000;
    while (
      runtime.registry.serviceSnapshot(serviceId)!.endpoint.state !== "available" &&
      Date.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    expect(runtime.registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
    });
  });

  test.each(["lsof", "ps"])(
    "a transient %s failure automatically recovers without confirmation",
    async (command) => {
      await harness.addLocalEnvironment("a", { entryPort: 3000 });
      let failing = true;
      const checker = new LoopbackListenerOwnership({
        roots: () => [{ environmentId: "a", pid: 100 }],
        platform: "darwin",
        processCacheMs: 0,
        runCommand: async (name) => {
          if (name === command && failing)
            throw new CommandFailedError("timeout", { timedOut: true });
          return {
            stdout:
              name === "lsof"
                ? "p300\nf1\ntIPv4\nn127.0.0.1:3000\n"
                : "100 1 started\n300 100 started\n",
          };
        },
      });
      const runtime = harness.newRuntime({
        listenerOwnership: checker,
        registry: { probeBackoffMs: [10, 10, 10] },
      });
      await runtime.init();
      await runtime.registry.settle();
      const { serviceId } = seeded(runtime.registry, "a").definition;
      expect(runtime.registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
        listener: "unchecked",
        failure: { retryable: true },
      });
      failing = false;
      const deadline = Date.now() + 2000;
      while (
        runtime.registry.serviceSnapshot(serviceId)!.endpoint.state !== "available" &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      expect(runtime.registry.serviceSnapshot(serviceId)!).toMatchObject({
        definition: { userOverride: false },
        endpoint: { state: "available", ownership: "managed-process" },
      });
    },
  );

  test.each(["none", "unchecked", "other-environment"] as const)(
    "TTL %s ownership loss starts a new retry window after readiness retries are exhausted",
    async (attribution) => {
      await harness.addLocalEnvironment("a", { entryPort: 3000 });
      listeners.set(3000, { owner: "a", started: "t1" });
      let now = 1000;
      let failed = false;
      let probes = 0;
      const runtime = harness.newRuntime({
        listenerOwnership: {
          ...listenerOwnership,
          attribute: async (environmentId, port) =>
            failed
              ? { attribution, retryable: true }
              : listenerOwnership.attribute(environmentId, port),
        },
        registry: {
          now: () => now,
          verificationTtlMs: 10,
          probeBackoffMs: [5],
          readiness: {
            probe: async () => {
              probes += 1;
              return {
                tcp: { state: "failed", failure: "connection-refused" },
                tls: { state: "skipped" },
                http: { state: "skipped" },
              };
            },
          },
        },
      });
      await runtime.init();
      await runtime.registry.settle();
      const service = seeded(runtime.registry, "a");
      const exhausted = Date.now() + 2000;
      while (probes < 2 && Date.now() < exhausted) await Bun.sleep(5);
      expect(probes).toBe(2);
      failed = true;
      now += 20;
      await expect(
        runtime.registry.acquireTarget(
          service.definition.serviceId,
          service.endpoint.endpointGeneration,
        ),
      ).rejects.toThrow();
      failed = false;
      listeners.set(3000, { owner: "a", started: "t2" });
      const deadline = Date.now() + 2000;
      while (
        runtime.registry.serviceSnapshot(service.definition.serviceId)!.endpoint.state !==
          "available" &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      expect(
        runtime.registry.serviceSnapshot(service.definition.serviceId)!.endpoint.ownership,
      ).toBe("managed-process");
    },
  );

  test("confirmation replaces an in-flight resolution captured before userOverride", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    const registry = await started();
    const definition = seeded(registry, "a").definition;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = listenerOwnership.attribute;
    listenerOwnership.attribute = async () => {
      entered();
      await gate;
      return { attribution: "unattributed" };
    };
    try {
      const pending = registry.refresh(definition.serviceId);
      await entering;
      await registry.update(definition.serviceId, definition.definitionRevision, {});
      const refreshed = registry.refresh(definition.serviceId);
      release();
      await pending;
      expect(await refreshed).toMatchObject({
        definition: { userOverride: true },
        endpoint: { state: "available", ownership: "user-registered" },
      });
    } finally {
      release();
      listenerOwnership.attribute = original;
    }
  });

  test("seeding preserves a different-kind user service on the entry port and its entry flag", async () => {
    await harness.addLocalEnvironment("a");
    const registry = await started();
    const registered = await registry.register({
      environmentId: "a",
      targetKind: "backend-host",
      applicationPort: 3000,
      label: "shared",
      entry: true,
    });
    if (registered.kind !== "definition") throw new Error("expected definition");
    await harness.storage.updateEnvironment("a", { entryPort: 3000 });
    await registry.settle();
    const services = registry.snapshot({ environmentId: "a" }).services;
    expect(services).toHaveLength(2);
    expect(
      services.find((s) => s.definition.targetKind === "backend-host")!.definition,
    ).toMatchObject({
      serviceId: registered.definition.serviceId,
      entry: true,
      provenance: "user",
    });
    expect(services.find((s) => s.definition.targetKind === "worktree")!.definition).toMatchObject({
      entry: false,
      provenance: "entry-port",
      userOverride: false,
    });
    const again = await started();
    expect(again.snapshot({ environmentId: "a" }).services).toHaveLength(2);
  });

  test("without an ownership check a seeded service waits for confirmation", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    const runtime = harness.newRuntime();
    await runtime.init();
    await runtime.registry.settle();
    const { serviceId } = seeded(runtime.registry, "a").definition;
    const service = await runtime.registry.refresh(serviceId);
    expect(service.endpoint).toMatchObject({
      state: "unavailable",
      listener: "unchecked",
      failure: { category: "target-unverified", retryable: false },
    });
  });
});

/**
 * The 0045 qualification on this host's real `lsof`, `ps` and process tree.
 * Each "terminal" is a shell this test started, standing in for the PTY shell
 * `TerminalRuntime.localProcessRoots()` reports; the dev server is its child,
 * as it is when run from an Orkestrator terminal. The servers bind like Vite:
 * the configured port, or the next one when it is taken.
 */
const realHost = process.platform === "darwin";
describe.skipIf(!realHost)("local preview service discovery on this host", () => {
  let harness: PreviewHarness;
  const terminals: ChildProcess[] = [];

  beforeEach(async () => {
    harness = await createPreviewHarness();
  });
  afterEach(async () => {
    for (const terminal of terminals.splice(0)) {
      try {
        process.kill(-terminal.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await harness.cleanup();
  });

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  /** A shell running a dev server; resolves with the port the server took. */
  async function terminalRunningServer(
    port: number,
    host = "127.0.0.1",
  ): Promise<{ shell: ChildProcess; port: number }> {
    // Report the bound address after a beat: Bun calls the listen callback of a
    // bind that then fails with EADDRINUSE.
    const script = `const net=require("node:net");
let port=${port};
const listen=()=>{
  const s=net.createServer();
  s.once("error",error=>{
    if(error.code!=="EADDRINUSE"||port===0||port>=65535)throw error;
    port++;listen();
  });
  s.listen({port,host:"${host}",ipv6Only:false},()=>setTimeout(()=>{
    const address=s.address();
    if(address)console.log("port "+address.port);
  },150));
};listen();`;
    // "; true" keeps the shell as the server's parent instead of exec'ing it.
    const shell = spawn("/bin/sh", ["-c", `"${process.execPath}" -e '${script}'; true`], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    terminals.push(shell);
    const bound = await new Promise<number>((resolve, reject) => {
      shell.stdout!.once("data", (data: Buffer) =>
        resolve(Number(/port (\d+)/.exec(String(data))?.[1])),
      );
      shell.once("exit", (code) => reject(new Error(`terminal exited ${code}`)));
    });
    return { shell, port: bound };
  }

  async function stop(shell: ChildProcess, port: number) {
    const exited = new Promise((resolve) => shell.once("exit", resolve));
    process.kill(-shell.pid!, "SIGKILL");
    await exited;
    const isListening = () =>
      new Promise<boolean>((resolve) => {
        const socket = createConnection({ port, host: "127.0.0.1" });
        const finish = (listening: boolean) => {
          socket.destroy();
          resolve(listening);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });
    const deadline = Date.now() + 2_000;
    while (await isListening()) {
      if (Date.now() >= deadline) throw new Error("Stopped fixture listener did not close");
      await Bun.sleep(20);
    }
  }

  test("a dual-stack wildcard listener resolves the owning worktree over IPv4 and refuses another", async () => {
    const server = await terminalRunningServer(0, "::");
    await harness.addLocalEnvironment("a", { entryPort: server.port });
    await harness.addLocalEnvironment("b", { entryPort: server.port });
    const runtime = harness.newRuntime({
      managedProcessRoots: () => [{ environmentId: "a", pid: server.shell.pid! }],
      // Exercise auto selection through a real successful IPv4 handshake.
      probeFamily: undefined,
    });
    await runtime.init();
    await runtime.registry.settle();
    const a = runtime.registry.snapshot({ environmentId: "a" }).services[0]!;
    const b = runtime.registry.snapshot({ environmentId: "b" }).services[0]!;
    expect(a.endpoint).toMatchObject({
      state: "available",
      addressFamily: "ipv4",
      ownership: "managed-process",
      listener: "this-environment",
    });
    expect(b.endpoint).toMatchObject({
      state: "unavailable",
      listener: "other-environment",
      hostPort: null,
    });
  }, 20_000);

  test("two environments, a restart on the reused port, and an auto-incremented port", async () => {
    // Keep the listener open while the environments are prepared: reserving a
    // port and closing it first lets unrelated host tests steal it.
    const first = await terminalRunningServer(0);
    const port = first.port;
    await harness.addLocalEnvironment("a", { entryPort: port });
    await harness.addLocalEnvironment("b", { entryPort: port });
    const roots: ManagedProcessRoot[] = [];
    const runtime = harness.newRuntime({ managedProcessRoots: () => roots });
    await runtime.init();
    await runtime.registry.settle();
    const registry = runtime.registry;
    const a = registry.snapshot({ environmentId: "a" }).services[0]!.definition;
    const b = registry.snapshot({ environmentId: "b" }).services[0]!.definition;

    // a's terminal starts the dev server on the shared entry port.
    expect(first.port).toBe(port);
    roots.push({ environmentId: "a", pid: first.shell.pid! });
    const opened = await registry.refresh(a.serviceId);
    expect(opened.endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
      listener: "this-environment",
      hostPort: port,
    });

    // b's seeded service on the same port never opens a's server.
    const refused = await registry.refresh(b.serviceId);
    expect(refused.endpoint).toMatchObject({
      state: "unavailable",
      listener: "other-environment",
      hostPort: null,
    });

    // b's terminal starts the same dev server, which moves to the next port.
    const moved = await terminalRunningServer(port);
    expect(moved.port).toBeGreaterThan(port);
    roots.push({ environmentId: "b", pid: moved.shell.pid! });
    const link = await resolvePreviewTargetIntent(
      registry,
      {
        intent: {
          url: `http://localhost:${moved.port}/`,
          source: "worktree-terminal",
          environmentId: "b",
        },
      },
      (id) => harness.storage.getEnvironment(id),
    );
    expect(link.kind).toBe("unregistered");
    await registry.update(b.serviceId, b.definitionRevision, { applicationPort: moved.port });
    expect((await registry.refresh(b.serviceId)).endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
      hostPort: moved.port,
    });

    // a restarts its server on the reused port: same service, new generation.
    await stop(first.shell, port);
    roots.splice(
      roots.findIndex((root) => root.environmentId === "a"),
      1,
    );
    const stopped = await registry.refresh(a.serviceId);
    expect(stopped.endpoint).toMatchObject({ state: "unavailable", listener: "none" });
    const restarted = await terminalRunningServer(port);
    expect(restarted.port).toBe(port);
    roots.push({ environmentId: "a", pid: restarted.shell.pid! });
    const back = await registry.refresh(a.serviceId);
    expect(back.endpoint).toMatchObject({ state: "available", ownership: "managed-process" });
    expect(back.endpoint.endpointGeneration).toBeGreaterThan(opened.endpoint.endpointGeneration);
    await expect(
      registry.acquireTarget(a.serviceId, opened.endpoint.endpointGeneration),
    ).rejects.toThrow(/generation-changed/);
  }, 30_000);

  test("a dev server typed into a real local terminal PTY is that environment's", async () => {
    const port = await freePort();
    await harness.addLocalEnvironment("a", { entryPort: port });
    await harness.addLocalEnvironment("b", { entryPort: port });
    // The same root provider the backend wires in `index.ts`.
    const terminals = new TerminalRuntime();
    const runtime = harness.newRuntime({
      managedProcessRoots: () => terminals.localProcessRoots(),
    });
    await runtime.init();
    await runtime.registry.settle();
    const a = runtime.registry.snapshot({ environmentId: "a" }).services[0]!.definition;
    const b = runtime.registry.snapshot({ environmentId: "b" }).services[0]!.definition;

    let pty: PtyProcess | null = null;
    try {
      pty = spawnPty("/bin/sh", [], { cwd: harness.dir, cols: 120, rows: 24 });
      terminals.rememberSession("a:pty", {
        kind: "local",
        environmentId: "a",
        cols: 120,
        rows: 24,
      });
      terminals.registerProcess("a:pty", pty);
      let output = "";
      pty.onData((data) => {
        output += data;
      });
      // Typed at the prompt, so the server is a foreground job of the shell.
      pty.write(
        `"${process.execPath}" -e 'require("node:net").createServer().listen(${port},"127.0.0.1",()=>console.log("lis"+"tening"))'\n`,
      );
      const deadline = Date.now() + 10_000;
      while (!output.includes("listening") && Date.now() < deadline) await Bun.sleep(25);
      expect(output).toContain("listening");

      expect((await runtime.registry.refresh(a.serviceId)).endpoint).toMatchObject({
        state: "available",
        ownership: "managed-process",
        listener: "this-environment",
      });
      expect((await runtime.registry.refresh(b.serviceId)).endpoint).toMatchObject({
        state: "unavailable",
        listener: "other-environment",
      });
    } finally {
      if (pty) await pty.terminate();
    }
  }, 30_000);
});
