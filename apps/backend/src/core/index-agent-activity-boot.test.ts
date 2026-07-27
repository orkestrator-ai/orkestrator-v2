import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import type { Environment } from "./models.js";

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
};

async function withBackend<T>(
  environments: unknown[],
  run: (backend: OrkestratorBackend, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "orkestrator-activity-boot-"),
  );
  await fs.writeFile(
    path.join(dataDir, "environments.json"),
    JSON.stringify(environments, null, 2),
  );
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
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("OrkestratorBackend agent activity boot reset", () => {
  test("drops renderer activity left behind by a process that is gone", async () => {
    const stuckAt = new Date(10_000).toISOString();
    await withBackend([
      {
        ...baseEnvironment,
        id: "e1",
        agentActivityState: "working",
        agentActivityUpdatedAt: stuckAt,
        agentActivitySources: {
          frontend: { state: "working", updatedAt: stuckAt },
        },
      },
    ], async (backend) => {
      await backend.init();

      const [environment] = await backend.invoke<Environment[]>(
        "get_environment_snapshots",
        { projectId: "p1" },
      );
      expect(environment).toMatchObject({
        id: "e1",
        agentActivityState: "idle",
        agentActivitySources: {},
      });
      // The token moves forward so a client hydrating from this snapshot
      // prefers it over any observation it held before the restart.
      expect(Date.parse(environment!.agentActivityUpdatedAt!))
        .toBeGreaterThan(Date.parse(stuckAt));
    });
  });

  test("keeps the backend poller's own observation across a restart", async () => {
    // Only renderer-reported state is unverifiable at boot. The terminal
    // poller re-reads its container within a second either way, and dropping
    // its snapshot would flash the sidebar green for a working agent.
    const terminalAt = new Date(20_000).toISOString();
    await withBackend([
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
    ], async (backend) => {
      await backend.init();

      const [environment] = await backend.invoke<Environment[]>(
        "get_environment_snapshots",
        { projectId: "p1" },
      );
      expect(environment).toMatchObject({
        agentActivityState: "waiting",
        agentActivitySources: {
          "claude-terminal": { state: "waiting", updatedAt: terminalAt },
        },
      });
      expect(environment!.agentActivitySources)
        .not.toHaveProperty("frontend");
    });
  });

  test("leaves environments with no renderer activity untouched", async () => {
    await withBackend([
      { ...baseEnvironment, id: "e1" },
      {
        ...baseEnvironment,
        id: "e2",
        agentActivityState: "idle",
        agentActivityUpdatedAt: new Date(5_000).toISOString(),
      },
    ], async (backend) => {
      await backend.init();

      const environments = await backend.invoke<Environment[]>(
        "get_environment_snapshots",
        { projectId: "p1" },
      );
      expect(environments.map((environment) => environment.id))
        .toEqual(["e1", "e2"]);
      expect(environments[1]!.agentActivityUpdatedAt)
        .toBe(new Date(5_000).toISOString());
    });
  });

  test("starts the backend even when the reset cannot be persisted", async () => {
    // A backend that refuses to boot because it could not tidy a UI hint would
    // be a far worse failure than the stale hint itself.
    const stuckAt = new Date(10_000).toISOString();
    await withBackend([
      {
        ...baseEnvironment,
        id: "e1",
        agentActivityState: "working",
        agentActivityUpdatedAt: stuckAt,
        agentActivitySources: {
          frontend: { state: "working", updatedAt: stuckAt },
        },
      },
    ], async (backend, dataDir) => {
      const environmentsFile = path.join(dataDir, "environments.json");
      await fs.rm(environmentsFile);
      // A directory where the file belongs makes every write to it fail.
      await fs.mkdir(environmentsFile);

      await expect(backend.init()).resolves.toBeUndefined();
      await fs.rm(environmentsFile, { recursive: true, force: true });
    });
  });
});
