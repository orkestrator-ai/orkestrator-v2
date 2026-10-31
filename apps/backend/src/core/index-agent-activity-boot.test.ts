import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipelineActivity } from "./build-pipeline-activity.js";
import { OrkestratorBackend } from "./index.js";
import type { ClientEnvironment, Environment } from "./models.js";
import { readStoredValue, seedStore, storageDatabase } from "./storage-test-support.js";
import type { StorageService } from "./storage.js";

/**
 * A `frontend` activity snapshot is only meaningful while the renderer that
 * wrote it is alive to retract it. The aggregate is a max, so nothing can lower
 * a stale `working` afterwards — not a later `idle` from the terminal poller,
 * not a restart. Backend startup is the one moment where every renderer is
 * provably gone, which is why the reset lives there.
 */

const baseEnvironment = {
  projectId: "p1",
  name: "Environment",
  branch: "main",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: new Date(0).toISOString(),
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
  // Setup already finished, so boot does not adopt (and, with no worktree,
  // fail) a pending setup that would rewrite the activity under test.
  setupScriptsComplete: true,
};

async function withBackend<T>(
  environments: unknown[],
  run: (backend: OrkestratorBackend, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-activity-boot-"));
  seedStore(dataDir, "environments.json", environments);
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
  });
  try {
    return await run(backend, dataDir);
  } finally {
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("OrkestratorBackend agent activity boot reset", () => {
  test("starts pipeline activity recovery at boot and stops the observer at shutdown", async () => {
    const stuckAt = new Date(10_000).toISOString();
    await withBackend(
      [
        {
          ...baseEnvironment,
          id: "e1",
          agentActivityState: "working",
          agentActivitySources: { "build-pipeline": { state: "working", updatedAt: stuckAt } },
        },
      ],
      async (backend, dataDir) => {
        const observer = (backend as unknown as { buildPipelineActivity: BuildPipelineActivity })
          .buildPipelineActivity;
        const started = spyOn(observer, "start");
        const stopped = spyOn(observer, "stop");
        try {
          await backend.init();
          await observer.settled();
          expect(started).toHaveBeenCalledTimes(1);
          expect(readStoredValue<Environment[]>(dataDir, "environments.json")![0]).toMatchObject({
            agentActivityState: "idle",
            agentActivitySources: { "build-pipeline": { state: "idle" } },
          });
          await backend.shutdown();
          expect(stopped).toHaveBeenCalledTimes(1);
        } finally {
          started.mockRestore();
          stopped.mockRestore();
        }
      },
    );
  });

  test("drops renderer activity left behind by a process that is gone", async () => {
    const stuckAt = new Date(10_000).toISOString();
    await withBackend(
      [
        {
          ...baseEnvironment,
          id: "e1",
          agentActivityState: "working",
          agentActivityUpdatedAt: stuckAt,
          agentActivitySources: {
            frontend: { state: "working", updatedAt: stuckAt },
          },
          frontendAgentActivityObservers: {
            "hashed-observer": {
              state: "working",
              updatedAt: stuckAt,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        },
      ],
      async (backend, dataDir) => {
        await backend.init();

        const [environment] = await backend.invoke<ClientEnvironment[]>(
          "get_environment_snapshots",
          { projectId: "p1" },
        );
        expect(environment).toMatchObject({
          id: "e1",
          agentActivityState: "idle",
        });
        expect(environment).not.toHaveProperty("agentActivitySources");
        expect(environment).not.toHaveProperty("frontendAgentActivityObservers");
        const [persisted] = readStoredValue<Environment[]>(dataDir, "environments.json")!;
        expect(persisted).toMatchObject({
          agentActivitySources: {},
          frontendAgentActivityObservers: {},
        });
        // The token moves forward so a client hydrating from this snapshot
        // prefers it over any observation it held before the restart.
        expect(Date.parse(environment!.agentActivityUpdatedAt!)).toBeGreaterThan(
          Date.parse(stuckAt),
        );
      },
    );
  });

  test("keeps the backend poller's own observation across a restart", async () => {
    // Only renderer-reported state is unverifiable at boot. The terminal
    // poller re-reads its container within a second either way, and dropping
    // its snapshot would flash the sidebar green for a working agent.
    const terminalAt = new Date(20_000).toISOString();
    await withBackend(
      [
        {
          ...baseEnvironment,
          id: "e1",
          agentActivityState: "working",
          agentActivityUpdatedAt: terminalAt,
          agentActivitySources: {
            frontend: { state: "working", updatedAt: new Date(10_000).toISOString() },
            "claude-terminal": { state: "waiting", updatedAt: terminalAt },
          },
        },
      ],
      async (backend, dataDir) => {
        await backend.init();

        const [environment] = await backend.invoke<ClientEnvironment[]>(
          "get_environment_snapshots",
          { projectId: "p1" },
        );
        expect(environment).toMatchObject({
          agentActivityState: "waiting",
        });
        expect(environment).not.toHaveProperty("agentActivitySources");
        const [persisted] = readStoredValue<Environment[]>(dataDir, "environments.json")!;
        expect(persisted).toMatchObject({
          agentActivitySources: {
            "claude-terminal": { state: "waiting", updatedAt: terminalAt },
          },
        });
        expect(persisted!.agentActivitySources).not.toHaveProperty("frontend");
      },
    );
  });

  test("leaves environments with no renderer activity untouched", async () => {
    await withBackend(
      [
        { ...baseEnvironment, id: "e1" },
        {
          ...baseEnvironment,
          id: "e2",
          agentActivityState: "idle",
          agentActivityUpdatedAt: new Date(5_000).toISOString(),
        },
      ],
      async (backend) => {
        await backend.init();

        const environments = await backend.invoke<Environment[]>("get_environment_snapshots", {
          projectId: "p1",
        });
        expect(environments.map((environment) => environment.id)).toEqual(["e1", "e2"]);
        expect(environments[1]!.agentActivityUpdatedAt).toBe(new Date(5_000).toISOString());
      },
    );
  });

  test("starts the backend even when the reset cannot be persisted", async () => {
    // A backend that refuses to boot because it could not tidy a UI hint would
    // be a far worse failure than the stale hint itself.
    const stuckAt = new Date(10_000).toISOString();
    await withBackend(
      [
        {
          ...baseEnvironment,
          id: "e1",
          agentActivityState: "working",
          agentActivityUpdatedAt: stuckAt,
          agentActivitySources: {
            frontend: { state: "working", updatedAt: stuckAt },
          },
        },
      ],
      async (backend, dataDir) => {
        const storage = (backend as unknown as { context: { storage: StorageService } }).context
          .storage;
        const database = storageDatabase(storage);
        const writeStore = database.writeStoreInTransaction.bind(database);
        // Every write to the environments store fails; other stores still work.
        const failing = spyOn(database, "writeStoreInTransaction").mockImplementation(
          (store, value) => {
            if (store === "environments") throw new Error("disk full");
            return writeStore(store, value);
          },
        );
        try {
          await expect(backend.init()).resolves.toBeUndefined();
          expect(failing.mock.calls.some(([store]) => store === "environments")).toBe(true);
        } finally {
          failing.mockRestore();
        }
        // The reset was attempted and lost; the stale hint is all that remains.
        expect(readStoredValue<Environment[]>(dataDir, "environments.json")![0]).toMatchObject({
          agentActivitySources: { frontend: { state: "working", updatedAt: stuckAt } },
        });
      },
    );
  });
});
