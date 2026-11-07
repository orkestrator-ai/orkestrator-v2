import { eventSink } from "../src/core/backend-emit.js";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../src/core/commands-context.js";
import type { Environment } from "../src/core/models.js";
import { EnvironmentLifecycleTaskTracker } from "../src/core/environment-lifecycle-tasks.js";
import { BackendRuntime } from "../src/core/backend-runtime.js";

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
    // Container creation resolves each platform's active account; none is
    // configured, so every platform stays on its default account.
    agentAccounts: {
      loadAgentAccounts: async () => ({ version: 1, accounts: [], active: {} }),
    },
  };
  const context = {
    // No provider's credentials are authorized, so a create that stages inputs
    // reads nothing from the developer's real home. A test wanting them says so.
    runtimeFlavor: "agent-test",
    credentialSources: new Set<string>(),
    storage,
    emit: eventSink((event: string, payload: unknown) => events.push({ event, payload })),
    appRoot: dataDir,
    resourceRoot: dataDir,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit: (event, payload) => context.emit(event, payload) }),
  } as unknown as CommandContext;
  return { context, events, writes, environments: store };
}

/** An immutable image id for fake Docker scripts to answer with. */
export const FIXTURE_IMAGE_ID = `sha256:${"c".repeat(64)}`;

/**
 * Writes the archive `docker cp` streams for an image's manifest, for a fake
 * Docker script's `cp` to `cat`. New containers need `staged-inputs`, so that
 * is what a current image declares unless the test says otherwise.
 */
export async function imageManifestArchive(
  dir: string,
  capabilities: Record<string, number> = { "staged-inputs": 5 },
  schemaVersion = 1,
): Promise<string> {
  const source = await fs.mkdtemp(path.join(dir, "manifest-"));
  await fs.writeFile(
    path.join(source, "image-manifest.json"),
    JSON.stringify({
      schemaVersion,
      appVersion: "1.0.0",
      sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
      architecture: "amd64",
      runtimes: { bun: "1.4.4", node: "24.21.0" },
      agents: {},
      bridges: [],
      capabilities,
      stateFormats: {},
    }),
  );
  const archive = path.join(source, "manifest.tar");
  // Docker emits a plain archive; macOS tar must not add AppleDouble metadata.
  const tar = spawnSync(
    "tar",
    ["--format=ustar", "-cf", archive, "-C", source, "image-manifest.json"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  if (tar.status !== 0) throw new Error("could not write the manifest archive");
  return archive;
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
