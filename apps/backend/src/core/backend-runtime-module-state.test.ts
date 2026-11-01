import { afterEach, describe, expect, test } from "bun:test";
import { BackendRuntime } from "./backend-runtime.js";
import {
  assertContainerNotDraining,
  assertEnvironmentNotDraining,
  withEnvironmentDraining,
} from "./container-readiness.js";
import type { Environment, Project } from "./models.js";
import {
  ensureProjectHomeEnvironment,
  type EnsureProjectHomeResult,
  type ProjectHomeDependencies,
} from "./project-home-environment.js";
import { createEnvironment } from "./storage-shared-core.js";

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
});
