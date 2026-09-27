/**
 * Shared fixtures for preview service tests: a real StorageService in a temp
 * directory and a scriptable Docker runner that answers `docker inspect` the
 * way the resolver asks.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dockerOwnerNamespace } from "./docker-ownership.js";
import type { Environment, PortMapping } from "./models.js";
import { PreviewRuntime } from "./preview-runtime.js";
import type { DockerRunner } from "./preview-target-resolver.js";
import { StorageService } from "./storage.js";

export interface FakeContainer {
  id: string;
  status?: string;
  owner?: string;
  environmentId: string;
  ports: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
}

export class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  calls: string[][] = [];
  /** Hold every inspect until released, to exercise late completions. */
  gate: Promise<void> | null = null;
  failure: Error | null = null;

  runner: DockerRunner = async (args) => {
    this.calls.push(args);
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    const id = args.at(-1)!;
    const container = this.containers.get(id);
    if (!container) throw new Error(`Error: No such container: ${id}`);
    return {
      stdout: `${container.id}\t${container.status ?? "running"}\t${container.owner ?? ""}\t${container.environmentId}\t${JSON.stringify(container.ports)}\n`,
    };
  };

  inspectCount(): number {
    return this.calls.filter((call) => call[0] === "inspect").length;
  }
}

export interface PreviewHarness {
  dir: string;
  storage: StorageService;
  docker: FakeDocker;
  events: Array<{ event: string; payload: unknown }>;
  runtime: PreviewRuntime;
  owner: string;
  addContainerEnvironment(
    id: string,
    options?: {
      containerId?: string | null;
      entryPort?: number;
      portMappings?: PortMapping[];
      status?: Environment["status"];
    },
  ): Promise<void>;
  addLocalEnvironment(id: string, options?: { status?: Environment["status"] }): Promise<void>;
  newRuntime(options?: Partial<ConstructorParameters<typeof PreviewRuntime>[0]>): PreviewRuntime;
  cleanup(): Promise<void>;
}

export async function createPreviewHarness(
  options: Partial<ConstructorParameters<typeof PreviewRuntime>[0]> = {},
): Promise<PreviewHarness> {
  const dir = await mkdtemp(join(tmpdir(), "ork-preview-"));
  const storage = new StorageService(dir);
  await storage.init();
  await storage.addProject({
    id: "project",
    name: "Project",
    gitUrl: "https://example.invalid/project.git",
    localPath: dir,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  const docker = new FakeDocker();
  const events: PreviewHarness["events"] = [];
  const runtimes: PreviewRuntime[] = [];
  const owner = dockerOwnerNamespace(dir);
  const newRuntime = (overrides: Partial<ConstructorParameters<typeof PreviewRuntime>[0]> = {}) => {
    const runtime = new PreviewRuntime({
      storage,
      emit: (event, payload) => events.push({ event, payload }),
      runDocker: docker.runner,
      env: {},
      probeFamily: async () => false,
      ...options,
      ...overrides,
      registry: { eventDelayMs: 1, ...options.registry, ...overrides.registry },
    });
    runtimes.push(runtime);
    return runtime;
  };
  let order = 0;
  const harness: PreviewHarness = {
    dir,
    storage,
    docker,
    events,
    owner,
    runtime: newRuntime(),
    newRuntime,
    async addContainerEnvironment(id, environment = {}) {
      await storage.addEnvironment({
        id,
        projectId: "project",
        name: id,
        branch: id,
        environmentType: "containerized",
        containerId:
          environment.containerId === undefined ? `container-${id}` : environment.containerId,
        status: environment.status ?? "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: order++,
        ...(environment.entryPort ? { entryPort: environment.entryPort } : {}),
        ...(environment.portMappings ? { portMappings: environment.portMappings } : {}),
      } as Environment);
    },
    async addLocalEnvironment(id, environment = {}) {
      await storage.addEnvironment({
        id,
        projectId: "project",
        name: id,
        branch: id,
        environmentType: "local",
        worktreePath: dir,
        containerId: null,
        status: environment.status ?? "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: order++,
      } as Environment);
    },
    async cleanup() {
      for (const runtime of runtimes) runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
