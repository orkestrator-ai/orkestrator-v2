import { describe, expect, spyOn, test } from "bun:test";
import type { ProviderActivityState } from "./native-agent-provider.js";
import {
  nativeAgentSessionStorageKey,
  type NativeAgentServiceOptions,
} from "./native-agent-service.js";
import {
  addEnvironment,
  createProviderStub,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { deferred } from "./recurring-test-support.js";
import type { StorageService } from "./storage.js";

type Transition = Parameters<NonNullable<NativeAgentServiceOptions["onActivityTransition"]>>[0];

const tab = "env-env-1:tab-1";
const container = {
  environmentType: "containerized",
  containerId: "container-1",
  worktreePath: undefined,
};

async function adopt(storage: StorageService, environmentId = "env-1"): Promise<void> {
  await storage.adoptNativeAgentSession({
    key: nativeAgentSessionStorageKey(environmentId, "codex", `env-${environmentId}:tab-1`),
    environmentId,
    agent: "codex",
    logicalSessionKey: `env-${environmentId}:tab-1`,
    providerSessionId: `provider-${environmentId}`,
  });
}

describe("a stopped runtime settles its sessions' turn activity", () => {
  test("a session seen waiting is idle once stopped, and the next start fires no finished edge", async () => {
    let state: ProviderActivityState = "waiting";
    const { provider } = createProviderStub("codex", { activity: async () => state });
    const transitions: Transition[] = [];
    await withService(
      {
        prefix: "ork-stopped-runtime-settle-",
        environment: container,
        provider: async () => provider,
        onActivityTransition: (event) => {
          transitions.push(event);
        },
      },
      async ({ storage, service }) => {
        await adopt(storage);
        await service.reconcileAgentActivity();
        expect(service.sessionTurnActivitySnapshot("env-1", "codex", tab)).toBe("waiting");
        expect(await service.hasObservedLiveWork("env-1", "codex")).toBe(true);
        expect(transitions.map((event) => event.state)).toEqual(["waiting"]);
        const completions = spyOn(storage, "recordEnvironmentSessionCompletion");

        await storage.updateEnvironment("env-1", { status: "stopped" });
        await service.environmentRuntimeStopped("env-1");

        // `session send` and a move no longer read it as busy.
        expect(service.sessionTurnActivitySnapshot("env-1", "codex", tab)).toBe("idle");
        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("idle");
        expect(service.sessionStoppedMidTurn("env-1", "codex", tab)).toBe(true);
        expect(await service.hasObservedLiveWork("env-1", "codex")).toBe(false);
        // A cut-off turn did not finish: no transition, no completion.
        expect(transitions).toHaveLength(1);
        expect(completions).not.toHaveBeenCalled();

        // The next start reads the reattached session's own idle.
        state = "idle";
        await storage.updateEnvironment("env-1", { status: "running" });
        await service.reconcileAgentActivity();
        expect(transitions).toHaveLength(1);
        expect(completions).not.toHaveBeenCalled();
        expect(service.sessionStoppedMidTurn("env-1", "codex", tab)).toBe(false);
        expect(service.sessionTurnActivitySnapshot("env-1", "codex", tab)).toBe("idle");
      },
    );
  });

  test("a turn that had already handed over to background work is not reported cut off", async () => {
    const { provider } = createProviderStub("codex");
    Object.assign(provider, {
      observeActivity: async () => ({ state: "working", readyForInput: true }),
    });
    await withService(
      {
        prefix: "ork-stopped-runtime-background-",
        environment: container,
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        await adopt(storage);
        await service.reconcileAgentActivity();
        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("working");

        await storage.updateEnvironment("env-1", { status: "stopped" });
        await service.environmentRuntimeStopped("env-1");

        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("idle");
        expect(service.sessionStoppedMidTurn("env-1", "codex", tab)).toBe(false);
      },
    );
  });

  test("a read that started before the stop cannot land after it", async () => {
    const read = deferred<ProviderActivityState>();
    let reads = 0;
    const { provider } = createProviderStub("codex", {
      activity: async () => {
        reads += 1;
        return reads === 1 ? "working" : read.promise;
      },
    });
    await withService(
      {
        prefix: "ork-stopped-runtime-fence-",
        environment: container,
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        await adopt(storage);
        await service.reconcileAgentActivity();
        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("working");

        const sweep = service.reconcileAgentActivity();
        while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
        await storage.updateEnvironment("env-1", { status: "stopped" });
        await service.environmentRuntimeStopped("env-1");
        read.resolve("working");
        await sweep;

        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("idle");
        expect(service.sessionStoppedMidTurn("env-1", "codex", tab)).toBe(true);
      },
    );
  });

  test("the sweep settles a container runtime that stopped on its own, once per stop", async () => {
    let state: ProviderActivityState = "working";
    const { provider } = createProviderStub("codex", { activity: async () => state });
    await withService(
      {
        prefix: "ork-stopped-runtime-sweep-",
        environment: container,
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        await addEnvironment(storage, { id: "env-2", worktreePath: "/tmp/env-2" });
        await adopt(storage);
        await adopt(storage, "env-2");
        await service.reconcileAgentActivity();
        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("working");
        expect(service.sessionActivitySnapshot("env-2", "codex", "env-env-2:tab-1")).toBe(
          "working",
        );
        const withdraw = spyOn(service, "withdrawEnvironmentInteractions");

        // Found exited by lifecycle reconciliation, not stopped by a command.
        await storage.updateEnvironment("env-1", { status: "stopped" });
        // A local stop that could not end its bridge keeps that bridge's state.
        await storage.updateEnvironment("env-2", { status: "stopped" });
        await service.reconcileAgentActivity();
        await service.reconcileAgentActivity();

        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("idle");
        expect(service.sessionStoppedMidTurn("env-1", "codex", tab)).toBe(true);
        expect(service.sessionActivitySnapshot("env-2", "codex", "env-env-2:tab-1")).toBe(
          "working",
        );
        expect(withdraw.mock.calls).toEqual([["env-1"]]);

        // A start re-arms it for the next stop.
        await storage.updateEnvironment("env-1", { status: "running" });
        await service.reconcileAgentActivity();
        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("working");
        await storage.updateEnvironment("env-1", { status: "stopped" });
        state = "idle";
        await service.reconcileAgentActivity();
        expect(withdraw.mock.calls).toEqual([["env-1"], ["env-1"]]);
        expect(service.sessionActivitySnapshot("env-1", "codex", tab)).toBe("idle");
      },
    );
  });
});
