import { afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import type { NativeAgentService } from "./native-agent-service.js";
import { CoordinatorService, type CoordinatorDelegationOptions } from "./coordinator-service.js";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type { StorageService } from "./storage.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

test("production coordinator and leaf RPC share the raw/turn activity probe and exact session lookup", async () => {
  const world = await MailWorld.create();
  worlds.push(world);
  const backend = new OrkestratorBackend({
    dataDir: path.join(world.root, "backend"),
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
  });
  const internal = backend as unknown as {
    context: CommandContext;
    nativeAgents: NativeAgentService;
    coordinators: {
      workerActivity: (
        environmentId: string,
        tabId: string,
      ) => Promise<AgentActivityState | "unknown">;
      options: CoordinatorDelegationOptions;
    };
  };
  const sessions = spyOn(internal.context.storage, "listNativeAgentSessions").mockResolvedValue([
    { environmentId: "other", logicalSessionKey: "env-e:tab:one", agent: "claude" },
    { environmentId: "e", logicalSessionKey: "env-e:other", agent: "claude" },
    { environmentId: "e", logicalSessionKey: "env-e:tab:one", agent: "codex" },
  ] as Awaited<ReturnType<StorageService["listNativeAgentSessions"]>>);
  const raw = spyOn(internal.nativeAgents, "sessionActivitySnapshot").mockReturnValue("working");
  const turn = spyOn(internal.nativeAgents, "sessionTurnActivitySnapshot").mockReturnValue("idle");
  const pending = spyOn(
    internal.context.storage,
    "hasUndeliveredCoordinatorRequest",
  ).mockResolvedValue(false);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const requestState = createCommandRegistry().get("get_worker_request_state")!;
  try {
    expect(await internal.coordinators.workerActivity("e", "missing")).toBe("unknown");
    expect(await internal.coordinators.options.workerBackgroundWork!("e", "missing")).toBe(false);
    expect(raw).not.toHaveBeenCalled();
    expect(turn).not.toHaveBeenCalled();
    // A dev server and an awaited shell share this activity contract. Both use the bounded hold.
    expect(await internal.coordinators.workerActivity("e", "tab:one")).toBe("idle");
    expect(await internal.coordinators.options.workerBackgroundWork!("e", "tab:one")).toBe(true);
    expect(await requestState({ environmentId: "e", tabId: "tab:one" }, internal.context)).toEqual({
      requestPending: false,
      backgroundWorkPending: true,
    });
    expect(raw).toHaveBeenLastCalledWith("e", "codex", "env-e:tab:one");
    expect(turn).toHaveBeenLastCalledWith("e", "codex", "env-e:tab:one");
    for (const state of ["working", "waiting", "unknown"] as const) {
      turn.mockReturnValue(state);
      expect(await internal.coordinators.options.workerBackgroundWork!("e", "tab:one")).toBe(false);
    }
    turn.mockReturnValue("idle");
    raw.mockReturnValue("idle");
    expect(await internal.coordinators.options.workerBackgroundWork!("e", "tab:one")).toBe(false);

    // Exercise the production probe through settlement: a server left running gets a
    // qualified notice after two minutes, without waiting for the server to exit.
    const worker = await world.addEnvironment("dev-server-worker", { launched: true });
    const main = await world.main();
    sessions.mockResolvedValue([
      {
        environmentId: worker.environmentId,
        logicalSessionKey: worker.logicalSessionKey,
        agent: "codex",
      },
    ] as Awaited<ReturnType<StorageService["listNativeAgentSessions"]>>);
    raw.mockReturnValue("working");
    const coordinator = new CoordinatorService(
      world.storage,
      () => ({ enabled: true, running: true, error: null }),
      undefined,
      internal.coordinators.workerActivity,
      internal.coordinators.options,
    );
    await coordinator.settleWorkerDelegations({
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      state: "completed",
    });
    now += 119_999;
    await coordinator.reconcileWorkerDelegations();
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
    now += 1;
    await coordinator.reconcileWorkerDelegations();
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(0);
    await world.deliver();
    expect(world.received(main)[0]).toContain("none of it reported for 2 minutes");
  } finally {
    clock.mockRestore();
    sessions.mockRestore();
    raw.mockRestore();
    turn.mockRestore();
    pending.mockRestore();
    await backend.shutdown();
  }
});
