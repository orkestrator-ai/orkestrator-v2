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
import {
  formatSeededWorkflowRecords,
  parseWorkflowRecordSeed,
  seededWorkflowCheckout,
  seedProfileWorkflowRecords,
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
    for (const value of ["0", "-3", "1.5", "nearly", "1e3"]) {
      expect(() => parseWorkflowRecordSeed(value)).toThrow(
        "--seed-workflow-records accepts a positive count, near-limit or full",
      );
    }
    expect(() => parseAgentTestArguments(["--seed-workflow-records"])).toThrow(
      "Missing value for --seed-workflow-records",
    );
    // A `dev` profile is the durable development install; it is never seeded.
    expect(() => parseDevArguments(["--seed-workflow-records", "near-limit"])).toThrow(
      "only supported by mise run dev:test",
    );
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
      storeRecords: 1800,
    });
    expect(logged.join("")).toContain("storage noise");
    expect(formatSeededWorkflowRecords(seeded, seededWorkflowCheckout(profile))).toBe(
      "Seeded coordinator workflow records: 1800 in use (1800 new), 1800 in the store; " +
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
    expect(first).toMatchObject({ added: 3, inUse: 3, stale: 0, storeRecords: 3 });
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

  test("a dev:test start seeds after the bridge build, before Electron, and stops on a failure", async () => {
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
    try {
      await mkdir(roots.developmentRoot, { recursive: true });
      await expect(
        startDevelopment(args, "agent-test", {
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
            return { code: 1, output: "Coordinator workflow store is full\n" };
          },
        }),
      ).rejects.toThrow("Seeding coordinator workflow records failed");
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
    } finally {
      request.mockRestore();
      log.mockRestore();
      credentials.mockRestore();
      prefetch.mockRestore();
      bridges.mockRestore();
    }
  });
});
