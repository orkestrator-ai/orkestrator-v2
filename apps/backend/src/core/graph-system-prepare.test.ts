import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { Environment } from "./models.js";
import {
  GraphRunEnvironmentProvisioner,
  GRAPH_RUN_START_RETRY_MS,
} from "./graph-system-prepare.js";
import { prepareTemplate, systemWorld, type SystemWorld } from "./graph-system-test-support.js";

const worlds: SystemWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function world(environment: Partial<Environment> = {}): Promise<SystemWorld> {
  const created = await systemWorld({ template: prepareTemplate(), environment });
  worlds.push(created);
  return created;
}

describe("prepare-environment", () => {
  test("starts the environment, runs setup once and reports the commit work starts from", async () => {
    const w = await world({ status: "stopped", setupScriptsComplete: false });
    const report = await w.executor().start(w.context(w.activation("setup")));
    if (report.state !== "complete") throw new Error(JSON.stringify(report));
    const artifact = await w.artifacts.requireVerified(w.run.id, report.outputs.code!);
    expect("value" in artifact.body && artifact.body.value).toEqual({
      branch: "feature/csv",
      headRef: w.head,
      baseRef: w.head,
    });
    expect(w.commands.calls.map((call) => call.command)).toEqual([
      "start_environment",
      "run_environment_setup",
    ]);
    // A retry and a restart replay the recorded commit: no second start or setup.
    w.shell.head = "f".repeat(40);
    for (const executor of [w.executor(), w.executor({ owner: "process-2" })]) {
      const again = await executor.recover(w.context(w.activation("setup", { attempt: 2 })));
      if (again.state !== "complete") throw new Error(JSON.stringify(again));
      const value = await w.artifacts.requireVerified(w.run.id, again.outputs.code!);
      expect("value" in value.body && (value.body.value as { headRef: string }).headRef).toBe(
        w.head,
      );
    }
    expect(w.commands.calls).toHaveLength(2);
  });

  test("a running environment whose setup completed is neither started nor set up", async () => {
    const w = await world({ status: "running", setupScriptsComplete: true });
    expect((await w.executor().start(w.context(w.activation("setup")))).state).toBe("complete");
    expect(w.commands.calls).toEqual([]);
  });

  test("a failed setup fails the node", async () => {
    const w = await world({ status: "running", setupScriptsComplete: false });
    w.commands.onCommand = (command, args) =>
      command === "run_environment_setup"
        ? w.storage
            .updateEnvironment(args.environmentId as string, { setupPhase: "failed" })
            .then(() => null)
        : undefined;
    const report = await w.executor().start(w.context(w.activation("setup")));
    expect(report).toMatchObject({
      state: "failed",
      error: "The environment's setup script failed",
    });
  });
});

describe("the run's own environment (GraphRunProvisioner)", () => {
  function provisionerWorld(w: SystemWorld) {
    let clock = 0;
    const created: Record<string, unknown>[] = [];
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (command === "create_environment") {
        created.push(args);
        const environment = {
          ...(await w.storage.getEnvironment("e1"))!,
          id: "e-new",
          order: 2,
          status: "stopped" as const,
          controlRequestId: args.controlRequestId as string,
        };
        await w.storage.addEnvironment(environment);
        return environment as T;
      }
      return w.commands.invoke<T>(command, args);
    };
    const make = () =>
      new GraphRunEnvironmentProvisioner({ storage: w.storage, invoke, monotonic: () => clock });
    return { make, created, advance: (ms: number) => (clock += ms) };
  }

  test("creates a worktree once, starts it in the background, and is ready when it runs", async () => {
    const w = await world();
    const { make, created, advance } = provisionerWorld(w);
    const run: GraphRun = { ...w.run, environmentId: undefined, status: "provisioning" };
    const provisioner = make();
    const signal = new AbortController().signal;
    expect(await provisioner.provision(run, signal)).toEqual({ state: "pending" });
    expect(created).toEqual([
      {
        projectId: "p1",
        environmentType: "local",
        networkAccessMode: "full",
        controlRequestId: "graph-run:run-1",
        // The ticket input's title names the environment.
        namingPrompt: "Add CSV export to the reports page",
      },
    ]);
    expect(w.commands.count("start_environment_background")).toBe(1);
    // A pass a second later, and a restarted backend, neither create nor ask again too soon.
    expect(await provisioner.provision(run, signal)).toEqual({ state: "pending" });
    expect(w.commands.count("start_environment_background")).toBe(1);
    advance(GRAPH_RUN_START_RETRY_MS);
    expect(await provisioner.provision(run, signal)).toEqual({ state: "pending" });
    expect(w.commands.count("start_environment_background")).toBe(2);
    await w.storage.updateEnvironment("e-new", { status: "running" });
    expect(await make().provision(run, signal)).toEqual({ state: "ready", environmentId: "e-new" });
    expect(created).toHaveLength(1);
  });

  test("an environment that failed to start fails provisioning", async () => {
    const w = await world();
    const { make } = provisionerWorld(w);
    const run: GraphRun = { ...w.run, environmentId: undefined, status: "provisioning" };
    await make().provision(run, new AbortController().signal);
    await w.storage.updateEnvironment("e-new", { status: "error" });
    expect(await make().provision(run, new AbortController().signal)).toEqual({
      state: "failed",
      error: "The run's environment could not be started",
    });
  });

  test("a template without `workspace.create` cannot be provisioned", async () => {
    const w = await systemWorld();
    worlds.push(w);
    const provisioner = new GraphRunEnvironmentProvisioner({
      storage: w.storage,
      invoke: w.commands.invoke,
    });
    expect(
      await provisioner.provision(
        { ...w.run, environmentId: undefined },
        new AbortController().signal,
      ),
    ).toMatchObject({ state: "failed" });
  });
});
