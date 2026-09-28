import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../../../apps/backend/src/core/commands-context";
import type { Environment } from "../../../apps/backend/src/core/models";
import { EnvironmentLifecycleTaskTracker } from "../../../apps/backend/src/core/environment-lifecycle-tasks";

/**
 * Small, dependency-free fixtures for container lifecycle suites. They avoid
 * the command-registry fixture module so lifecycle tests stay cheap and do not
 * install its global module mocks.
 */

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function lifecycleEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-lifecycle",
    projectId: "project-1",
    name: "Lifecycle",
    branch: "feature/lifecycle",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

/**
 * In-memory storage with the persistence semantics lifecycle code relies on:
 * `updateEnvironment` merges fields (an explicit `undefined` clears one) and
 * returns a copy, so tests observe exactly what was persisted.
 */
export function memoryLifecycleContext(
  environments: Environment[],
  dataDir: string,
): {
  context: CommandContext;
  events: Array<{ event: string; payload: unknown }>;
  writes: Array<{ environmentId: string; update: Record<string, unknown> }>;
  environments: Map<string, Environment>;
} {
  const store = new Map(environments.map((environment) => [environment.id, environment]));
  const events: Array<{ event: string; payload: unknown }> = [];
  const writes: Array<{ environmentId: string; update: Record<string, unknown> }> = [];
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const storage = {
    getDataDir: () => dataDir,
    getEnvironment: async (id: string) => {
      const environment = store.get(id);
      return environment ? clone(environment) : null;
    },
    loadEnvironments: async () => [...store.values()].map(clone),
    updateEnvironment: async (id: string, update: Record<string, unknown>) => {
      const environment = store.get(id);
      if (!environment) throw new Error(`Environment not found: ${id}`);
      writes.push({ environmentId: id, update: clone(update) });
      for (const [key, value] of Object.entries(update)) {
        if (value === undefined) delete (environment as unknown as Record<string, unknown>)[key];
        else (environment as unknown as Record<string, unknown>)[key] = clone(value);
      }
      return clone(environment);
    },
    addEnvironment: async (environment: Environment) => {
      store.set(environment.id, environment);
      return clone(environment);
    },
    removeEnvironment: async (id: string) => {
      store.delete(id);
    },
  };
  const context = {
    storage,
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
    appRoot: dataDir,
    resourceRoot: dataDir,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  } as unknown as CommandContext;
  return { context, events, writes, environments: store };
}

/**
 * Installs `script` as `docker` on PATH for the duration of `run`. The script
 * receives `FAKE_DOCKER_LOG` (every invocation, one per line).
 */
export async function withDockerScript(
  script: string,
  run: (log: { path: string; read: () => Promise<string> }) => Promise<void>,
): Promise<void> {
  const root = await tempDir("ork-lifecycle-docker-");
  const bin = path.join(root, "bin");
  const logPath = path.join(root, "docker.log");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "docker"), script, { mode: 0o755 });
  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_DOCKER_LOG;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_DOCKER_LOG = logPath;
  try {
    await run({ path: logPath, read: () => fs.readFile(logPath, "utf8").catch(() => "") });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = originalLog;
    await fs.rm(root, { recursive: true, force: true });
  }
}
