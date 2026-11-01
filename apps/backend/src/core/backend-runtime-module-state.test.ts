import { afterEach, describe, expect, test } from "bun:test";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { AgentsMdPrResult } from "./agents-md-pr.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import {
  assertContainerNotDraining,
  assertEnvironmentNotDraining,
  withEnvironmentDraining,
} from "./container-readiness.js";
import { withCoordinatorReceipt } from "./coordinator-action-scope.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { GraphSystemActionMemory } from "./graph-system-action.js";
import type { Environment, Project } from "./models.js";
import { fixtureMcpServer } from "./opencode-coordinator-research-test-support.js";
import { openCodeEnvironmentDependencies } from "./opencode-provider-environment.js";
import {
  ensureProjectHomeEnvironment,
  type EnsureProjectHomeResult,
  type ProjectHomeDependencies,
} from "./project-home-environment.js";
import { createEnvironment } from "./storage-shared-core.js";
import type { StorageService } from "./storage.js";

/**
 * Two backends in one process do not share the module state todo 1070 moved
 * onto their runtimes (docs/architecture/backend-runtime.md). The cases for
 * the state moved earlier are in `backend-runtime.test.ts`.
 */

/** A promise and its resolver, for work held in flight. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const runtimes: BackendRuntime[] = [];

function createRuntime(): BackendRuntime {
  const runtime = new BackendRuntime({ emit: () => undefined });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});

const project: Project = {
  id: "project-1",
  name: "Project",
  gitUrl: "git@example.com:org/project.git",
  localPath: "/checkout",
  addedAt: "2026-11-01T00:00:00.000Z",
  order: 0,
};

/** One backend's project storage, whose first project read waits for `gate`. */
function projectHomeDependencies(gate?: Promise<void>): ProjectHomeDependencies {
  const environments: Environment[] = [];
  return {
    storage: {
      getProject: async () => {
        await gate;
        return project;
      },
      getEnvironmentsByProject: async () => environments,
      addEnvironment: async (environment: Environment) => {
        environments.push(environment);
        return environment;
      },
      updateEnvironment: async () => {
        throw new Error("not expected");
      },
    } as unknown as ProjectHomeDependencies["storage"],
    resolveRoot: async () => "/checkout",
    readBranch: async () => "main",
    createRecord: (projectId, name) => createEnvironment(projectId, { name }),
  };
}

/** A backend whose coordinator store claims every receipt it is asked for. */
function receiptContext(runtime: BackendRuntime): CommandContext {
  const coordinators = {
    admitCoordinatorActionReceipt: async () => ({
      receipt: { createdAt: "2026-11-01T00:00:00.000Z", state: "pending" },
      claimed: true,
    }),
    releaseCoordinatorActionReceipt: async () => undefined,
    completeCoordinatorActionReceipt: async () => undefined,
  };
  return {
    storage: { coordinators } as unknown as StorageService,
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime,
  };
}

describe("two BackendRuntimes in one process (todo 1070)", () => {
  test("project-home ensures are joined within one backend only", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const gate = held<void>();
    const firstDependencies = projectHomeDependencies(gate.promise);

    const ensuring = ensureProjectHomeEnvironment(
      first.environments,
      project.id,
      firstDependencies,
    );
    expect(ensureProjectHomeEnvironment(first.environments, project.id, firstDependencies)).toBe(
      ensuring,
    );
    // The other backend creates its own home in its own storage rather than
    // joining the first backend's ensure and returning its record.
    const other: EnsureProjectHomeResult = await ensureProjectHomeEnvironment(
      second.environments,
      project.id,
      projectHomeDependencies(),
    );
    expect(other.created).toBe(true);
    gate.resolve();
    const mine = await ensuring;
    expect(mine.created).toBe(true);
    expect(mine.environment.id).not.toBe(other.environment.id);
  });

  test("stop drains fence the environment in one backend and the container in both", async () => {
    const first = createRuntime();
    const second = createRuntime();

    await withEnvironmentDraining(first.environments, "env-1", "container-1", async () => {
      expect(() => assertEnvironmentNotDraining(first.environments, "env-1")).toThrow(
        "The environment is stopping",
      );
      expect(() => assertEnvironmentNotDraining(second.environments, "env-1")).not.toThrow();
      // A container id names one Docker container: it is fenced process-wide.
      expect(() => assertContainerNotDraining("container-1")).toThrow(
        "The environment is stopping",
      );
    });
    expect(() => assertEnvironmentNotDraining(first.environments, "env-1")).not.toThrow();
    expect(() => assertContainerNotDraining("container-1")).not.toThrow();
  });

  test("a replacement cancellation reaches only its own backend", () => {
    const first = createRuntime();
    const second = createRuntime();

    first.environments.requestReplacementCancellation("operation-1");
    expect(first.environments.isReplacementCancellationRequested("operation-1")).toBe(true);
    expect(second.environments.isReplacementCancellationRequested("operation-1")).toBe(false);
    first.environments.forgetReplacementCancellation("operation-1");
    expect(first.environments.isReplacementCancellationRequested("operation-1")).toBe(false);
  });

  test("allowlist applies queue per environment within one backend only", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const apply = held<string>();
    const order: string[] = [];

    const running = first.environments.enqueueAllowedDomainsApply("env-1", () => apply.promise);
    const queued = first.environments.enqueueAllowedDomainsApply("env-1", async () => {
      order.push("first backend, second apply");
      return "queued";
    });
    // The other backend's apply for the same environment id does not wait.
    expect(
      await second.environments.enqueueAllowedDomainsApply("env-1", async () => {
        order.push("second backend");
        return "other";
      }),
    ).toBe("other");
    expect(order).toEqual(["second backend"]);
    apply.resolve("running");
    expect(await running).toBe("running");
    expect(await queued).toBe("queued");
    expect(order).toEqual(["second backend", "first backend, second apply"]);
  });

  test("coordinator receipt attempts are shared within one backend only", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const caller = { projectId: "project-1", coordinatorId: "coordinator-1", conversationId: "c" };
    const input = { requestId: "request-1", action: "close" as never, payload: {} };
    const attempt = held<Record<string, unknown>>();
    const runs: string[] = [];

    const running = withCoordinatorReceipt(receiptContext(first), caller, input, () => {
      runs.push("first");
      return attempt.promise;
    });
    // An identical call in the same backend waits for the attempt in flight.
    const retried = withCoordinatorReceipt(receiptContext(first), caller, input, async () => {
      runs.push("first, retried");
      return { retried: true };
    });
    // The other backend's call with the same ids runs at once against its own store.
    expect(
      await withCoordinatorReceipt(receiptContext(second), caller, input, async () => {
        runs.push("second");
        return { other: true };
      }),
    ).toEqual({ other: true });
    expect(runs).toEqual(["first", "second"]);
    attempt.resolve({ done: true });
    expect(await running).toEqual({ done: true });
    expect(await retried).toEqual({ retried: true });
    expect(runs).toEqual(["first", "second", "first, retried"]);
  });

  test("AGENTS.md pull request runs are joined within one backend only", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const pullRequest = held<AgentsMdPrResult>();
    const mine = { status: "opened" } as AgentsMdPrResult;
    const other = { status: "unchanged" } as AgentsMdPrResult;

    const running = first.coordinatorRequests.joinAgentsMdPullRequest(
      "0123456789abcdef",
      () => pullRequest.promise,
    );
    expect(
      first.coordinatorRequests.joinAgentsMdPullRequest("0123456789abcdef", async () => other),
    ).toBe(running);
    expect(
      await second.coordinatorRequests.joinAgentsMdPullRequest(
        "0123456789abcdef",
        async () => other,
      ),
    ).toBe(other);
    pullRequest.resolve(mine);
    expect(await running).toBe(mine);
  });

  test("graph effect locks and final-read failures belong to one backend's system executor", async () => {
    // The backend builds one GraphNodeSystemExecutor, which holds one memory.
    const first = new GraphSystemActionMemory();
    const second = new GraphSystemActionMemory();
    const effect = held<string>();
    const order: string[] = [];

    const running = first.withEffectLock("run-1\0push", () => effect.promise);
    const queued = first.withEffectLock("run-1\0push", async () => {
      order.push("first backend, queued");
      return "queued";
    });
    expect(
      await second.withEffectLock("run-1\0push", async () => {
        order.push("second backend");
        return "other";
      }),
    ).toBe("other");
    expect(order).toEqual(["second backend"]);
    effect.resolve("done");
    expect(await running).toBe("done");
    expect(await queued).toBe("queued");

    expect(first.recordReadFailure("run-1\0checks")).toBe(1);
    expect(first.recordReadFailure("run-1\0checks")).toBe(2);
    expect(second.recordReadFailure("run-1\0checks")).toBe(1);
    first.forgetReadFailures("run-1\0checks");
    expect(first.recordReadFailure("run-1\0checks")).toBe(1);
  });

  test("OpenCode coordinator research registrations are per backend and forgotten only with it", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const research = fixtureMcpServer(["query-docs"]);
    // Stands in for the coordinator's `opencode serve`: the research server connects.
    const openCode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ context7: { status: "connected" } }),
    });
    const runtimeId = coordinatorRuntimeId("workspace-1", "conversation-1");
    const serverKey = `local:${runtimeId}`;
    try {
      const firstResearch = first.localServers.openCodeAgentTools.research;
      const secondResearch = second.localServers.openCodeAgentTools.research;
      expect(
        await firstResearch.configure({
          serverKey,
          port: openCode.port!,
          password: "fixture",
          directory: "/fixture",
          servers: [{ name: "context7", url: `${research.url.origin}/mcp` }],
        }),
      ).toEqual(["context7_query-docs"]);
      expect(secondResearch.toolIds(serverKey)).toEqual([]);

      // A coordinator provider reads the registrations of the backend that serves it.
      const toolIds = (runtime: BackendRuntime) =>
        openCodeEnvironmentDependencies({
          environmentId: runtimeId,
          openCodeCoordinatorResearch: runtime.localServers.openCodeAgentTools.research,
        }).coordinatorResearchToolIds?.();
      expect(toolIds(first)).toEqual(["context7_query-docs"]);
      expect(toolIds(second)).toEqual([]);

      // The other backend's shutdown forgets only its own launches.
      for (const runtime of [first, second]) {
        runtime.localServers.openCodeAgentTools.recordLaunchConnection(serverKey, {
          url: "http://127.0.0.1:1/mcp",
          token: "fixture",
        });
      }
      second.localServers.openCodeAgentTools.cancelAll();
      expect(firstResearch.toolIds(serverKey)).toEqual(["context7_query-docs"]);
      first.localServers.openCodeAgentTools.cancelAll();
      expect(firstResearch.toolIds(serverKey)).toEqual([]);
    } finally {
      openCode.stop(true);
      research.stop();
    }
  });
});
