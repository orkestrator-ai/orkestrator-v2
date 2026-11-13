import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEV_PROFILE_SENTINEL,
  resolveRuntimeProfile,
  statusManifestPath,
} from "../../electron/runtime-profile.js";
import { parseAgentTestArguments, parseDevArguments } from "./arguments.js";
import * as bridgeBuilds from "./bridge-builds.js";
import { startDevelopment } from "./lifecycle.js";
import * as profileIo from "./profile-io.js";
import { resolveSeedRecordCount } from "../../../backend/scripts/seed-coordinator-workflows.js";
import { MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS } from "../../../backend/src/core/coordinator-workflow-retention.js";
import {
  formatSeededWorkflowRecords,
  MAX_SEEDED_WORKFLOW_RECORDS,
  parseWorkflowRecordSeed,
  seededWorkflowCheckout,
  seedProfileWorkflowRecords,
  type WorkflowSeedRunner,
} from "./workflow-records.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const resultLine = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "orkestrator-seeded-workflow-records", ...fields });

describe("--seed-workflow-records", () => {
  test("accepts a positive count, near-limit or full, on dev:test only", () => {
    expect(parseAgentTestArguments([]).seedWorkflowRecords).toBeUndefined();
    expect(
      parseAgentTestArguments(["--seed-workflow-records", "near-limit"]).seedWorkflowRecords,
    ).toBe("near-limit");
    expect(parseAgentTestArguments(["--seed-workflow-records", "full"]).seedWorkflowRecords).toBe(
      "full",
    );
    expect(parseAgentTestArguments(["--seed-workflow-records", "1850"]).seedWorkflowRecords).toBe(
      1850,
    );
    expect(parseAgentTestArguments(["--seed-workflow-records", "2000"]).seedWorkflowRecords).toBe(
      2000,
    );
    for (const value of ["0", "-3", "1.5", "nearly", "1e3", "0012", "+5", "2001", "5000"]) {
      expect(() => parseWorkflowRecordSeed(value)).toThrow(
        "--seed-workflow-records accepts a count from 1 to 2000, near-limit or full",
      );
    }
    // A count above the store's limit fails at parsing, before any build.
    expect(() => parseAgentTestArguments(["--seed-workflow-records", "2001"])).toThrow(
      "accepts a count from 1 to 2000",
    );
    expect(() => parseAgentTestArguments(["--seed-workflow-records"])).toThrow(
      "Missing value for --seed-workflow-records",
    );
    // A `dev` profile is the durable development install; it is never seeded.
    expect(() => parseDevArguments(["--seed-workflow-records", "near-limit"])).toThrow(
      "only supported by mise run dev:test",
    );
  });

  test("caps a count at the store's own limit and parses counts as the backend script does", () => {
    expect(MAX_SEEDED_WORKFLOW_RECORDS).toBe(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS);
    for (const value of ["1", "12", "0012", "0", "+5", "1.5", "1e3", "2000", "2001", "lots"]) {
      const launcher = (() => {
        try {
          return parseWorkflowRecordSeed(value);
        } catch {
          return undefined;
        }
      })();
      const backend = resolveSeedRecordCount(value);
      const backendAccepts =
        Number.isInteger(backend) &&
        backend >= 1 &&
        backend <= MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS;
      expect({ value, accepted: launcher !== undefined }).toEqual({
        value,
        accepted: backendAccepts,
      });
      if (launcher !== undefined) expect(launcher).toBe(backend);
    }
  });

  test("runs the backend script against the profile's data directory and reads its result", async () => {
    const calls: string[][] = [];
    const logged: string[] = [];
    const profile = { dataDir: "/profile/data", fixtureDir: "/profile/fixtures" };
    const seeded = await seedProfileWorkflowRecords(profile, "near-limit", {
      run: async (args) => {
        calls.push(args);
        return {
          code: 0,
          output: `storage noise\n${resultLine({
            projectId: "p",
            coordinatorId: "c",
            added: 1800,
            inUse: 1800,
            stale: 0,
            storeRecords: 1800,
          })}\n`,
        };
      },
      writeLog: async (text) => {
        logged.push(text);
      },
    });
    expect(calls).toEqual([
      [
        "--data-dir",
        "/profile/data",
        "--checkout",
        "/profile/fixtures/seeded-workflows",
        "--records",
        "near-limit",
      ],
    ]);
    expect(seeded).toEqual({
      projectId: "p",
      coordinatorId: "c",
      added: 1800,
      inUse: 1800,
      stale: 0,
      // The result line above carries no `refused`; a missing count reads as none.
      refused: 0,
      storeRecords: 1800,
    });
    expect(logged.join("")).toContain("storage noise");
    expect(formatSeededWorkflowRecords(seeded, seededWorkflowCheckout(profile))).toBe(
      "Seeded coordinator workflow records: 1800 in use (1800 new), 1800 in the store; " +
        "open the coordinator of /profile/fixtures/seeded-workflows",
    );
    expect(
      formatSeededWorkflowRecords(
        { ...seeded, added: 1970, inUse: 1970, refused: 30, storeRecords: 2000 },
        seededWorkflowCheckout(profile),
      ),
    ).toBe(
      "Seeded coordinator workflow records: 1970 in use (1970 new) " +
        "(30 refused: the store is full of records in use), 2000 in the store; " +
        "open the coordinator of /profile/fixtures/seeded-workflows",
    );
  });

  test("a failed or silent script fails the seeding with its last line", async () => {
    const profile = { dataDir: "/profile/data", fixtureDir: "/profile/fixtures" };
    await expect(
      seedProfileWorkflowRecords(profile, 5, {
        run: async () => ({ code: 1, output: "Coordinator workflow store is full\n" }),
      }),
    ).rejects.toThrow(
      "Seeding coordinator workflow records failed: Coordinator workflow store is full",
    );
    await expect(
      seedProfileWorkflowRecords(profile, 5, { run: async () => ({ code: 0, output: "" }) }),
    ).rejects.toThrow("Seeding coordinator workflow records failed (exit 0)");
  });

  test("the real script seeds a development profile's store and refuses anything else", async () => {
    const root = await temporaryDirectory("ork-dev-workflow-seed-");
    const profile = { dataDir: path.join(root, "data"), fixtureDir: path.join(root, "fixtures") };
    await expect(seedProfileWorkflowRecords(profile, 3)).rejects.toThrow(
      "not the data folder of a development profile",
    );
    expect(existsSync(profile.dataDir)).toBe(false);

    await writeFile(path.join(root, DEV_PROFILE_SENTINEL), "{}");
    const first = await seedProfileWorkflowRecords(profile, 3);
    expect(first).toMatchObject({ added: 3, inUse: 3, stale: 0, refused: 0, storeRecords: 3 });
    expect(existsSync(path.join(seededWorkflowCheckout(profile), ".git"))).toBe(true);
    // A restart refreshes the same records rather than adding more.
    const again = await seedProfileWorkflowRecords(profile, 2);
    expect(again).toMatchObject({
      projectId: first.projectId,
      added: 0,
      inUse: 2,
      stale: 1,
      storeRecords: 3,
    });
  }, 30_000);

  /**
   * Starts a `dev:test` profile with `--seed-workflow-records near-limit` up to
   * the Vite spawn, which the injected `spawn` refuses: nothing reaches a real
   * Vite, Electron or backend. `seed` answers for the backend script.
   */
  async function startSeeded(seed: WorkflowSeedRunner) {
    const root = await temporaryDirectory("ork-dev-workflow-seed-start-");
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const args = parseAgentTestArguments([
      "--profile",
      "workflow-seed",
      "--no-agent-credentials",
      "--no-host-seed",
      "--seed-workflow-records",
      "near-limit",
    ]);
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
      requestedId: args.profile,
      flavor: "agent-test",
      roots,
    });
    const order: string[] = [];
    const seedCalls: string[][] = [];
    const signals = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    const bridges = spyOn(bridgeBuilds, "prepareProfileBridgeBuilds").mockImplementation(
      async () => {
        order.push("bridges");
        return undefined as never;
      },
    );
    const prefetch = spyOn(profileIo, "prefetchAgentToolchains").mockResolvedValue({
      downloaded: [],
    });
    const credentials = spyOn(profileIo, "seedAgentTestProviderCredentials").mockResolvedValue([]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const request = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("Outbound fetch forbidden in lifecycle test");
    }) as unknown as typeof fetch);
    let error: unknown;
    let printed: string[] = [];
    try {
      await mkdir(roots.developmentRoot, { recursive: true });
      await startDevelopment(args, "agent-test", {
        roots,
        prune: async () => [],
        typecheck: () => {
          order.push("typecheck");
          return { status: 0 };
        },
        bundle: async () => {
          order.push("bundle");
          return { success: true, outputs: [], logs: [] } as unknown as Bun.BuildOutput;
        },
        seedWorkflowRecords: async (seedArgs) => {
          order.push("seed");
          seedCalls.push(seedArgs);
          return seed(seedArgs);
        },
        spawn: ((command: string) => {
          order.push(command === "bun" ? "vite" : "electron");
          throw new Error("Spawn refused in lifecycle test");
        }) as unknown as typeof import("node:child_process").spawn,
      });
    } catch (caught) {
      error = caught;
    } finally {
      printed = log.mock.calls.map((call) => String(call[0]));
      request.mockRestore();
      log.mockRestore();
      credentials.mockRestore();
      prefetch.mockRestore();
      bridges.mockRestore();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!signals[signal].includes(listener)) process.removeListener(signal, listener);
        }
      }
    }
    return { profile, order, seedCalls, printed, error };
  }

  test("a dev:test start seeds after the bridge build, before Electron, and stops on a failure", async () => {
    const { profile, order, seedCalls, error } = await startSeeded(async () => ({
      code: 1,
      output: "Coordinator workflow store is full\n",
    }));
    expect(String(error)).toContain("Seeding coordinator workflow records failed");
    // Nothing after the seeding ran: no Vite, no Electron, so no backend.
    expect(order).toEqual(["typecheck", "bundle", "bridges", "seed"]);
    expect(seedCalls[0]).toEqual([
      "--data-dir",
      profile.dataDir,
      "--checkout",
      seededWorkflowCheckout(profile),
      "--records",
      "near-limit",
    ]);
    expect(
      await readFile(path.join(profile.logDir, "workflow-records-seed.log"), "utf8"),
    ).toContain("store is full");
    const status = JSON.parse(await readFile(statusManifestPath(profile), "utf8")) as {
      status: string;
      error: string;
    };
    expect(status.status).toBe("failed");
    expect(status.error).toContain("Seeding coordinator workflow records failed");
  });

  test("a successful seeding prints its summary and the start goes on to Vite", async () => {
    const seeded = {
      projectId: "p",
      coordinatorId: "c",
      added: 1800,
      inUse: 1800,
      stale: 0,
      refused: 0,
      storeRecords: 1800,
    };
    const { profile, order, printed, error } = await startSeeded(async () => ({
      code: 0,
      output: `${resultLine(seeded)}\n`,
    }));
    // The launch carried on past the seeding to the Vite spawn, which this
    // test refuses; that refusal, not the seeding, is what stopped it.
    expect(order).toEqual(["typecheck", "bundle", "bridges", "seed", "vite"]);
    expect(String(error)).toContain("Spawn refused in lifecycle test");
    expect(printed).toContain(formatSeededWorkflowRecords(seeded, seededWorkflowCheckout(profile)));
    expect(
      await readFile(path.join(profile.logDir, "workflow-records-seed.log"), "utf8"),
    ).toContain("orkestrator-seeded-workflow-records");
    const status = JSON.parse(await readFile(statusManifestPath(profile), "utf8")) as {
      error?: string;
    };
    expect(status.error ?? "").not.toContain("Seeding coordinator workflow records failed");
  });
});
